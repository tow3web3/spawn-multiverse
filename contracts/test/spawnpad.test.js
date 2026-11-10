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

  async function spawnVia(chain, name = 'GLOOP SUPREME', sym = 'GLOOP', dev = 0n, feeMode = 0) {
    await (await chain.gateway.connect(user).spawnToken(name, sym, '{"face":"frog"}', dev, feeMode)).wait()
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
    // curve, so it returns about half the spend (minus the 1% fee each way)
    const got = (await c.usd.balanceOf(user)) - usdBefore
    expect(got).to.be.gt(E(96))
    expect(got).to.be.lt(E(103))
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
    expect(refund).to.be.gt(E(2_100))
    expect(refund).to.be.lt(E(2_400))

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
    await (await c.gateway.connect(user).spawnToken('SUNNY BLOB', 'SUNNY', '{}', E(25), 0)).wait()

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

  it('price discovery is a venue module only the pad can drive', async () => {
    const token = await spawnVia(world.chains[0])

    // the pad routes through the venue: both report the same market
    expect(await world.pad.venue()).to.equal(world.venue.target)
    expect(await world.venue.spotPrice(token)).to.equal(await world.pad.spotPrice(token))

    // nobody but the pad can touch price discovery directly
    await expect(world.venue.connect(user).execBuy(token, E(100))).to.be.revertedWith('VENUE: not pad')
    await expect(world.venue.connect(user).execSell(token, E(100))).to.be.revertedWith('VENUE: not pad')
    await expect(world.venue.connect(user).openMarket(user.address)).to.be.revertedWith('VENUE: not pad')
  })

  it('takes 1% on every trade and routes it per the launch fee mode', async () => {
    const c = world.chains[1]
    await (await c.gateway.connect(user).spawnToken('FEE GOBLIN', 'FGOB', '{}', 0, 1)).wait() // 50/50
    const token = await world.pad.allTokens(0)
    await (await c.usd.faucet(user, E(1_000))).wait()
    await (await c.gateway.connect(user).buyToken(token, E(100))).wait()

    let f = await world.pad.feesOf(token)
    expect(f.mode).to.equal(1)
    expect(f.total).to.equal(E(1)) // exactly 1% of $100
    expect(f.holders).to.equal(E(0.5))
    expect(f.dev).to.equal(E(0.5))

    // selling pays the fee too, on the gross proceeds
    const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
    await (await c.gateway.connect(user).sellToken(token, await rep.balanceOf(user))).wait()
    f = await world.pad.feesOf(token)
    expect(f.total).to.be.gt(E(1.9))
    expect(f.total).to.be.lt(E(2.1))
  })

  it('the dev claims their fee share on the chain of their choice', async () => {
    const home = world.chains[0]
    await (await home.gateway.connect(user).spawnToken('FEE KING', 'KING', '{}', 0, 2)).wait() // 100% dev
    const token = await world.pad.allTokens(0)
    const away = world.chains[3]
    await (await away.usd.faucet(user2, E(500))).wait()
    await (await away.gateway.connect(user2).buyToken(token, E(400))).wait()

    // the dev claims from a chain they never touched — payout lands there
    const claimChain = world.chains[5]
    const before = await claimChain.usd.balanceOf(user.address)
    await (await claimChain.gateway.connect(user).claimFees(token)).wait()
    expect((await claimChain.usd.balanceOf(user.address)) - before).to.equal(E(4)) // 1% of $400

    await expect(claimChain.gateway.connect(user).claimFees(token)).to.be.revertedWith(
      'PAD: nothing to claim',
    )
    await expect(claimChain.gateway.connect(user2).claimFees(token)).to.be.revertedWith(
      'PAD: not the dev',
    )
  })

  it('burn mode buys back on the curve and burns — global supply shrinks', async () => {
    const c = world.chains[2]
    await (await c.gateway.connect(user).spawnToken('PYRO', 'PYRO', '{}', 0, 3)).wait()
    const token = await world.pad.allTokens(0)
    await (await c.usd.faucet(user, E(2_000))).wait()
    await (await c.gateway.connect(user).buyToken(token, E(500))).wait() // $5 fee -> trigger

    const f = await world.pad.feesOf(token)
    expect(f.burnedTokens).to.be.gt(0n)
    expect(f.burnedUsd).to.be.gt(E(4.9))

    let total = await (await ethers.getContractAt('SpawnToken', token)).totalSupply()
    for (const ch of world.chains) {
      total += await (
        await ethers.getContractAt('SpawnToken', await ch.gateway.replicaOf(token))
      ).totalSupply()
    }
    expect(total).to.equal(E(1_000_000_000) - f.burnedTokens)
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

  it('rejects wire recipients whose top 12 bytes are not zero', async () => {
    // Wire riders are bytes32 so Solana pubkeys fit; a value consumed as an
    // EVM address must be zero-padded — dirty high bytes must revert.
    const { impersonateAccount, setBalance } = require('@nomicfoundation/hardhat-network-helpers')
    const token = await spawnVia(world.chains[0])
    const coder = ethers.AbiCoder.defaultAbiCoder()
    const dirtyBuyer = '0x01' + '00'.repeat(11) + user.address.slice(2)
    const payload = coder.encode(
      ['uint8', 'bytes'],
      [2, coder.encode(['bytes32', 'bytes32', 'uint256'], [ethers.zeroPadValue(token, 32), dirtyBuyer, E(100)])],
    )
    await impersonateAccount(world.messenger.target)
    await setBalance(world.messenger.target, E(1))
    const msgr = await ethers.getSigner(world.messenger.target)
    const src = world.chains[0]
    await expect(
      world.pad.connect(msgr).onOmniMessage(await src.gateway.chainLabel(), src.gateway.target, payload),
    ).to.be.revertedWith('PAD: bad recipient')
  })
})
