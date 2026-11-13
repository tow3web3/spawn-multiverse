const { expect } = require('chai')
const { ethers } = require('hardhat')
const { time } = require('@nomicfoundation/hardhat-network-helpers')
const { deployWorldAsync, fundUsd, worth, backing } = require('../scripts/lib-deploy')

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
    await time.increase(601) // past the FAIR GENESIS window
    return world.pad.allTokens((await world.pad.tokensLength()) - 1n)
  }

  it('a spawn crosses the network asynchronously and lands on every chain', async () => {
    const sol = world.chains[0]
    await (await sol.gateway.connect(user).spawnToken('GLOOP SUPREME', 'GLOOP', '{}', 0, 0)).wait()

    // in flight: the hub knows nothing yet
    expect(await world.endpoint.pending()).to.equal(1n)
    expect(await world.pad.tokensLength()).to.equal(0n)

    // the executor lands OP_SPAWN -> genesis on the hub. Base lives on the
    // hub chain: its replica deploys in that same transaction (loopback).
    // The five remote chains get a SYNC packet each.
    await (await world.endpoint.deliverNext()).wait()
    expect(await world.pad.tokensLength()).to.equal(1n)
    expect(await world.endpoint.pending()).to.equal(5n)

    const token = await world.pad.allTokens(0)
    expect(await sol.gateway.replicaOf(token)).to.equal(ethers.ZeroAddress)
    expect(await world.chains[2].gateway.replicaOf(token)).to.not.equal(ethers.ZeroAddress)

    await world.deliverAll()
    for (const c of world.chains) {
      expect(await c.gateway.replicaOf(token)).to.not.equal(ethers.ZeroAddress)
    }
  })

  it('a buy settles in two async legs; curve, bag and supply stay exact', async () => {
    const token = await spawnVia(world.chains[0])
    const base = world.chains[5] // optimism — a remote chain, two real legs
    await fundUsd(base, user, 1_000)
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
    await fundUsd(arb, user, 500)
    await (await arb.gateway.connect(user).buyToken(token, E(200))).wait()
    await world.deliverAll()

    const rep = await ethers.getContractAt('SpawnToken', await arb.gateway.replicaOf(token))
    const bag = await rep.balanceOf(user)
    const before = await worth(arb, user)
    const usdcBefore = await arb.usdc.balanceOf(user)
    await (await arb.gateway.connect(user).sellToken(token, bag / 2n)).wait()
    await world.deliverAll()
    expect(await worth(arb, user)).to.be.gt(before)
    // v7: the payout settled in real USDC out of this chain's vault
    expect(await arb.usdc.balanceOf(user)).to.be.gt(usdcBefore)

    // nothing in flight: every oUSD on every chain is backed 1:1 by USDC
    const { usdc, supply } = await backing(world)
    expect(supply).to.equal(usdc)
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
    await (await rogue.setDestination(0, 500_000, 0)).wait()
    await (await rogue.register(user.address, 9)).wait()
    const payload = ethers.AbiCoder.defaultAbiCoder().encode(['uint8', 'bytes'], [2, '0x'])
    await (
      await rogue.connect(user).send(0, ethers.zeroPadValue(world.pad.target, 32), payload, 0, { value: world.FEE })
    ).wait()
    await expect(world.endpoint.deliverNext()).to.be.revertedWith('LZM: not a peer')

    // and only registered protocol contracts may send at all
    await expect(
      world.hubMessenger.connect(user).send(1, ethers.zeroPadValue(user.address, 32), '0x', 0),
    ).to.be.revertedWith('LZM: unknown sender')
  })

  it('a wide identity rides the whole wire intact — and only its own chain can cash it', async () => {
    // v5: a Solana-style 32-byte creator spawns, earns dev fees from EVM
    // traders, and claims. We assert the OP_PAYOUT packet queued toward its
    // chain carries the wide identity byte-for-byte, then prove an EVM spoke
    // refuses to mint to it.
    const { impersonateAccount, setBalance } = require('@nomicfoundation/hardhat-network-helpers')
    const b32 = (a) => ethers.zeroPadValue(a, 32)
    const coder = ethers.AbiCoder.defaultAbiCoder()
    const sol = world.chains[0] // label 1

    await impersonateAccount(world.hubMessenger.target)
    await setBalance(world.hubMessenger.target, E(1))
    const msgr = await ethers.getSigner(world.hubMessenger.target)
    const srcId = b32(sol.gateway.target)
    const wideCreator = '0x33' + 'ef'.repeat(31)

    // spawn (fee mode 2: 100% dev) injected as if from the Solana gateway
    const spawn = coder.encode(
      ['uint8', 'bytes'],
      [1, coder.encode(['bytes32', 'string', 'string', 'string', 'uint256', 'uint8'], [wideCreator, 'SOL GLOOP', 'SGLP', '{}', 0, 2])],
    )
    await (await world.pad.connect(msgr).onOmniMessage(1, srcId, spawn)).wait()
    const token = await world.pad.allTokens(0)
    expect((await world.pad.metas(token)).creator).to.equal(wideCreator)
    await world.deliverAll() // SYNC_TOKEN fan-out
    await time.increase(601) // past the FAIR GENESIS window

    // EVM users trade; the wide dev's pot fills
    const base = world.chains[2]
    await fundUsd(base, user, 1_000)
    await (await base.gateway.connect(user).buyToken(token, E(500))).wait()
    await world.deliverAll()
    expect((await world.pad.feesOf(token)).dev).to.equal(E(5))

    // the wide creator claims from its chain; the payout packet queues
    const claim = coder.encode(
      ['uint8', 'bytes'],
      [4, coder.encode(['bytes32', 'bytes32'], [b32(token), wideCreator])],
    )
    await (await world.pad.connect(msgr).onOmniMessage(1, srcId, claim)).wait()
    expect(await world.endpoint.pending()).to.equal(1n)

    // inspect the packet WITHOUT delivering: envelope + payload, byte-exact
    const pkt = await world.endpoint.peek(0)
    const [envSender, envTarget, envPayload] = coder.decode(['bytes32', 'bytes32', 'bytes'], pkt.message)
    expect(envSender).to.equal(b32(world.pad.target))
    expect(envTarget).to.equal(srcId)
    const [op, inner] = coder.decode(['uint8', 'bytes'], envPayload)
    expect(op).to.equal(12n) // OP_PAYOUT
    const [recipient, amount] = coder.decode(['bytes32', 'uint256'], inner)
    expect(recipient).to.equal(wideCreator) // intact, byte-for-byte
    expect(amount).to.equal(E(5))

    // an EVM spoke cannot cash a wide identity: the local mint refuses
    await expect(world.endpoint.deliverNext()).to.be.revertedWith('GW: bad recipient')
  })
})
