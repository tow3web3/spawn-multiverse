const { expect } = require('chai')
const { ethers } = require('hardhat')
const { deployWorld } = require('../scripts/lib-deploy')

const E = (n) => ethers.parseEther(String(n))

describe('SPAWN! omnichain protocol', () => {
  let world, user, user2

  beforeEach(async () => {
    ;[, user, user2] = await ethers.getSigners()
    world = await deployWorld()
  })

  async function spawnVia(chain, name = 'GLOOP SUPREME', sym = 'GLOOP', dev = 0n) {
    await (await chain.gateway.connect(user).spawnToken(name, sym, '{"face":"frog"}', dev)).wait()
    const len = await world.pad.tokensLength()
    return world.pad.allTokens(len - 1n)
  }

  it('spawns one token natively on every chain in a single launch', async () => {
    const token = await spawnVia(world.chains[0])
    const hub = await ethers.getContractAt('SpawnToken', token)
    expect(await hub.totalSupply()).to.equal(E(1_000_000_000))
    expect(await hub.balanceOf(world.pad.target)).to.equal(E(1_000_000_000))

    for (const c of world.chains) {
      const repAddr = await c.gateway.replicaOf(token)
      expect(repAddr).to.not.equal(ethers.ZeroAddress)
      const rep = await ethers.getContractAt('SpawnToken', repAddr)
      expect(await rep.totalSupply()).to.equal(0n)
      expect(await rep.name()).to.equal('GLOOP SUPREME')
      expect(await rep.symbol()).to.equal('GLOOP')
    }

    const curve = await world.pad.curves(token)
    expect(curve.vBase).to.equal(E(6_000))
    expect(curve.vTokens).to.equal(E(1_073_000_000))
  })

  it('a buy on one chain moves the single global curve for every chain', async () => {
    const token = await spawnVia(world.chains[0])
    const sol = world.chains[0]
    const base = world.chains[2]

    await (await sol.usd.faucet(user, E(1_000))).wait()
    const p0 = await world.pad.spotPrice(token)
    await (await sol.gateway.connect(user).buyToken(token, E(100))).wait()
    const p1 = await world.pad.spotPrice(token)
    expect(p1).to.be.gt(p0)

    // tokens arrived natively on the buyer's chain, ≈17.59M for $100 at genesis
    const rep = await ethers.getContractAt('SpawnToken', await sol.gateway.replicaOf(token))
    const bal = await rep.balanceOf(user)
    expect(bal).to.be.gt(E(17_000_000))
    expect(bal).to.be.lt(E(18_000_000))
    expect(await sol.usd.balanceOf(user)).to.equal(E(900))

    // the same $100 from ANOTHER chain hits the SAME curve: higher price, fewer tokens
    await (await base.usd.faucet(user2, E(1_000))).wait()
    await (await base.gateway.connect(user2).buyToken(token, E(100))).wait()
    expect(await world.pad.spotPrice(token)).to.be.gt(p1)
    const rep2 = await ethers.getContractAt('SpawnToken', await base.gateway.replicaOf(token))
    expect(await rep2.balanceOf(user2)).to.be.lt(bal)
  })

  it('global token supply is conserved across all chains', async () => {
    const token = await spawnVia(world.chains[0])
    await (await world.chains[1].usd.faucet(user, E(5_000))).wait()
    await (await world.chains[1].gateway.connect(user).buyToken(token, E(2_500))).wait()

    let total = await (await ethers.getContractAt('SpawnToken', token)).totalSupply()
    for (const c of world.chains) {
      const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
      total += await rep.totalSupply()
    }
    expect(total).to.equal(E(1_000_000_000))
  })

  it('sells back on any chain and receives OmniUSD there', async () => {
    const token = await spawnVia(world.chains[0])
    const c = world.chains[4] // arbitrum
    await (await c.usd.faucet(user, E(500))).wait()
    await (await c.gateway.connect(user).buyToken(token, E(200))).wait()

    const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
    const bal = await rep.balanceOf(user)
    const usdBefore = await c.usd.balanceOf(user)

    await (await c.gateway.connect(user).sellToken(token, bal / 2n)).wait()
    expect(await rep.balanceOf(user)).to.equal(bal - bal / 2n)

    // selling the FIRST half of the bag happens on the upper half of the
    // curve, so it returns slightly more than half the spend
    const got = (await c.usd.balanceOf(user)) - usdBefore
    expect(got).to.be.gt(E(100))
    expect(got).to.be.lt(E(105))
  })

  it('ascends when the curve fills: refund, omnipool, trading continues', async () => {
    const token = await spawnVia(world.chains[0])
    const c = world.chains[0]
    await (await c.usd.faucet(user, E(20_000))).wait()

    await expect(c.gateway.connect(user).buyToken(token, E(20_000))).to.emit(
      world.pad,
      'Ascended',
    )

    const curve = await world.pad.curves(token)
    expect(curve.ascended).to.equal(true)
    expect(curve.vTokens).to.equal(E(200_000_000)) // pool seeded with reserved supply
    expect(curve.vBase).to.be.gt(E(17_000)) // ≈ $17.58K raised
    expect(curve.vBase).to.be.lt(E(18_000))

    // the excess above what the curve could absorb came back as a refund
    const refund = await c.usd.balanceOf(user)
    expect(refund).to.be.gt(E(2_300))
    expect(refund).to.be.lt(E(2_500))

    // the buyer holds the entire curve allocation
    const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
    expect(await rep.balanceOf(user)).to.equal(E(800_000_000))

    // trading continues on the omnipool, from any chain
    const d = world.chains[5]
    await (await d.usd.faucet(user2, E(1_000))).wait()
    const pBefore = await world.pad.spotPrice(token)
    await (await d.gateway.connect(user2).buyToken(token, E(500))).wait()
    expect(await world.pad.spotPrice(token)).to.be.gt(pBefore)
  })

  it('dev buy at spawn gives the creator the first bag', async () => {
    const c = world.chains[2]
    await (await c.usd.faucet(user, E(100))).wait()
    await (await c.gateway.connect(user).spawnToken('SUNNY BLOB', 'SUNNY', '{}', E(25))).wait()

    const token = await world.pad.allTokens(0)
    const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
    expect(await rep.balanceOf(user)).to.be.gt(0n)
    expect(await c.usd.balanceOf(user)).to.equal(E(75))
  })

  it('OmniUSD value is conserved end to end (burn-and-mint, nothing leaks)', async () => {
    const token = await spawnVia(world.chains[0])
    const a = world.chains[0]
    const b = world.chains[3]
    await (await a.usd.faucet(user, E(1_000))).wait()
    await (await b.usd.faucet(user2, E(1_000))).wait()

    await (await a.gateway.connect(user).buyToken(token, E(400))).wait()
    await (await b.gateway.connect(user2).buyToken(token, E(300))).wait()
    const rep = await ethers.getContractAt('SpawnToken', await a.gateway.replicaOf(token))
    await (await a.gateway.connect(user).sellToken(token, (await rep.balanceOf(user)) / 2n)).wait()

    let total = await world.hubUsd.totalSupply()
    for (const ch of world.chains) total += await ch.usd.totalSupply()
    expect(total).to.equal(E(2_000)) // exactly what the faucet printed
  })

  it('rejects messages that do not come from the protocol', async () => {
    const token = await spawnVia(world.chains[0])
    const payload = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint8', 'bytes'],
      [2, ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint256'], [token, user.address, E(100)])],
    )
    await expect(world.pad.connect(user).onOmniMessage(1, user.address, payload)).to.be.revertedWith(
      'PAD: not messenger',
    )
    await expect(
      world.chains[0].gateway.connect(user).onOmniMessage(0, user.address, payload),
    ).to.be.revertedWith('GW: not messenger')
    await expect(world.messenger.connect(user).send(0, world.pad.target, payload)).to.be.revertedWith(
      'LOM: unknown sender',
    )
  })
})
