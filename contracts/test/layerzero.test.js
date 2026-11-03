const { expect } = require('chai')
const { ethers } = require('hardhat')
const { deployWorldAsync } = require('../scripts/lib-deploy')

const E = (n) => ethers.parseEther(String(n))

/**
 * The async suite: same protocol, but messages cross a queued LayerZero V2
 * mock endpoint and land in SEPARATE transactions — the property that
 * separates the local demo from testnet/mainnet reality.
 */
describe('SPAWN! over async LayerZero V2 transport', () => {
  let world, user

  beforeEach(async () => {
    ;[, user] = await ethers.getSigners()
    world = await deployWorldAsync()
  })

  async function spawnVia(chain) {
    await (await chain.gateway.connect(user).spawnToken('GLOOP SUPREME', 'GLOOP', '{}', 0, 0)).wait()
    await world.deliverAll()
    return world.pad.allTokens((await world.pad.tokensLength()) - 1n)
  }

  it('a spawn crosses the network asynchronously and lands on every chain', async () => {
    const sol = world.chains[0]
    await (await sol.gateway.connect(user).spawnToken('GLOOP SUPREME', 'GLOOP', '{}', 0, 0)).wait()

    // in flight: the hub knows nothing yet
    expect(await world.endpoint.pending()).to.equal(1n)
    expect(await world.pad.tokensLength()).to.equal(0n)

    // the executor lands OP_SPAWN -> genesis on the hub + 6 SYNC packets fan out
    await (await world.endpoint.deliverNext()).wait()
    expect(await world.pad.tokensLength()).to.equal(1n)
    expect(await world.endpoint.pending()).to.equal(6n)

    const token = await world.pad.allTokens(0)
    expect(await sol.gateway.replicaOf(token)).to.equal(ethers.ZeroAddress)

    await world.deliverAll()
    for (const c of world.chains) {
      expect(await c.gateway.replicaOf(token)).to.not.equal(ethers.ZeroAddress)
    }
  })

  it('a buy settles in two async legs; curve, bag and supply stay exact', async () => {
    const token = await spawnVia(world.chains[0])
    const base = world.chains[2]
    await (await base.usd.faucet(user, E(1_000))).wait()
    await (await base.gateway.connect(user).buyToken(token, E(100))).wait()

    // leg 1 in flight: oUSD burned locally, nothing arrived anywhere yet
    expect(await base.usd.balanceOf(user)).to.equal(E(900))
    const rep = await ethers.getContractAt('SpawnToken', await base.gateway.replicaOf(token))
    expect(await rep.balanceOf(user)).to.equal(0n)

    await world.deliverAll() // OP_BUY lands on the hub, OP_DELIVER comes back
    const bal = await rep.balanceOf(user)
    expect(bal).to.be.gt(E(17_000_000))
    expect(bal).to.be.lt(E(18_000_000))

    // supply conservation across all chains survives async settlement
    let total = await (await ethers.getContractAt('SpawnToken', token)).totalSupply()
    for (const c of world.chains) {
      total += await (
        await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
      ).totalSupply()
    }
    expect(total).to.equal(E(1_000_000_000))
  })

  it('a sell pays out after delivery and no oUSD value leaks', async () => {
    const token = await spawnVia(world.chains[0])
    const arb = world.chains[4]
    await (await arb.usd.faucet(user, E(500))).wait()
    await (await arb.gateway.connect(user).buyToken(token, E(200))).wait()
    await world.deliverAll()

    const rep = await ethers.getContractAt('SpawnToken', await arb.gateway.replicaOf(token))
    const bag = await rep.balanceOf(user)
    const before = await arb.usd.balanceOf(user)
    await (await arb.gateway.connect(user).sellToken(token, bag / 2n)).wait()
    await world.deliverAll()
    expect(await arb.usd.balanceOf(user)).to.be.gt(before)

    let total = await world.hubUsd.totalSupply()
    for (const c of world.chains) total += await c.usd.totalSupply()
    expect(total).to.equal(E(500)) // exactly what the faucet printed
  })

  it('transport auth: only the endpoint, only configured peers, only the protocol', async () => {
    // a direct call cannot impersonate the endpoint
    const origin = { srcEid: 30_001, sender: ethers.zeroPadValue(user.address, 32), nonce: 1 }
    await expect(
      world.hubMessenger.connect(user).lzReceive(origin, ethers.ZeroHash, '0x', ethers.ZeroAddress, '0x'),
    ).to.be.revertedWith('LZM: not endpoint')

    // a rogue adapter registered on the endpoint is still not a configured peer
    const rogue = await ethers.deployContract('LayerZeroOmniMessenger', [world.endpoint.target, 31_999])
    await (await world.endpoint.registerAdapter(rogue.target, 31_999)).wait()
    await (await rogue.setRoute(0, 30_000, ethers.zeroPadValue(world.hubMessenger.target, 32))).wait()
    await (await rogue.register(user.address)).wait()
    await (await user.sendTransaction({ to: rogue.target, value: E(1) })).wait()
    const payload = ethers.AbiCoder.defaultAbiCoder().encode(['uint8', 'bytes'], [2, '0x'])
    await (await rogue.connect(user).send(0, world.pad.target, payload)).wait()
    await expect(world.endpoint.deliverNext()).to.be.revertedWith('LZM: not a peer')

    // and only registered protocol contracts may send at all
    await expect(world.hubMessenger.connect(user).send(1, user.address, '0x')).to.be.revertedWith(
      'LZM: unknown sender',
    )
  })
})
