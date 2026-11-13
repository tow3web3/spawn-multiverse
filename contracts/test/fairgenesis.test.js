const { expect } = require('chai')
const { ethers, network } = require('hardhat')
const { time } = require('@nomicfoundation/hardhat-network-helpers')
const { deployWorld, fundUsd, worth } = require('../scripts/lib-deploy')

const E = (n) => ethers.parseEther(String(n))
const DUST = E(0.000001)

/**
 * FAIR GENESIS (protocol v6): block 0 does not exist, the opening window
 * taxes snipers on a linear decay (30% -> 1% over 10 minutes), caps each
 * wallet at $250, and NEVER reverts on the message path — every refusal
 * rides home as a refund in the ordinary OP_DELIVER.
 */
describe('FAIR GENESIS (protocol v6)', () => {
  let world, user, user2

  beforeEach(async () => {
    ;[, user, user2] = await ethers.getSigners()
    world = await deployWorld()
  })

  async function spawn(chain, feeMode = 0, dev = 0n) {
    await (await chain.gateway.connect(user).spawnToken('GUARDED', 'GRD', '{}', dev, feeMode)).wait()
    const token = await world.pad.allTokens((await world.pad.tokensLength()) - 1n)
    const spawnedAt = (await world.pad.metas(token)).spawnedAt
    return { token, spawnedAt: Number(spawnedAt) }
  }

  it('a buy in the spawn block bounces whole — refund, zero tokens, no revert', async () => {
    const c = world.chains[2]
    await fundUsd(c, user2, 100)
    // The pad deploys the token with CREATE at nonce 1 — precompute it so the
    // snipe tx can target the token before the spawn has even executed.
    const predicted = ethers.getCreateAddress({ from: world.pad.target, nonce: 1 })

    await network.provider.send('evm_setAutomine', [false])
    const txSpawn = await c.gateway.connect(user).spawnToken('GUARDED', 'GRD', '{}', 0, 0)
    const txSnipe = await c.gateway.connect(user2).buyToken(predicted, E(50))
    await network.provider.send('evm_mine')
    await network.provider.send('evm_setAutomine', [true])
    await txSpawn.wait()
    const rcpt = await txSnipe.wait()

    const token = await world.pad.allTokens(0)
    expect(token).to.equal(predicted)
    expect((await rcpt.getBlock()).number).to.equal(
      Number(await world.pad.spawnBlock(token)),
    ) // truly the same block

    // the sniper got nothing, paid nothing: the $50 bounced home in the
    // DELIVER (v7: as USDC, straight out of the vault)
    const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
    expect(await rep.balanceOf(user2)).to.equal(0n)
    expect(await worth(c, user2)).to.equal(E(100))
    await expect(txSnipe).to.emit(world.pad, 'GenesisGuard')
    expect((await world.pad.feesOf(token)).total).to.equal(0n)
  })

  it('the snipe tax decays linearly: ~27% early, 15.5% mid-window, exactly 1% after', async () => {
    const c = world.chains[2]
    const { token, spawnedAt } = await spawn(c)
    await fundUsd(c, user, 1_000)

    // t = +60s: snipeBps = 2900 * 540/600 = 2610 -> total fee 27.10%
    await time.setNextBlockTimestamp(spawnedAt + 60)
    await (await c.gateway.connect(user).buyToken(token, E(100))).wait()
    let f = await world.pad.feesOf(token)
    expect(f.total).to.equal(E(27.1))

    // t = +300s: snipeBps = 1450 -> total fee 15.50%
    await time.setNextBlockTimestamp(spawnedAt + 300)
    await (await c.gateway.connect(user).buyToken(token, E(100))).wait()
    f = await world.pad.feesOf(token)
    expect(f.total).to.equal(E(27.1) + E(15.5))

    // t past the window: plain 1%, and the guard stays silent
    await time.setNextBlockTimestamp(spawnedAt + 601)
    const tx = await c.gateway.connect(user).buyToken(token, E(100))
    await tx.wait()
    f = await world.pad.feesOf(token)
    expect(f.total).to.equal(E(27.1) + E(15.5) + E(1))
    await expect(tx).to.not.emit(world.pad, 'GenesisGuard')
  })

  it('the tax rides the fee mode: holders get paid by the sniper', async () => {
    const c = world.chains[1]
    const { token, spawnedAt } = await spawn(c, 0) // FEE_HOLDERS
    await fundUsd(c, user2, 500)

    await time.setNextBlockTimestamp(spawnedAt + 60) // 27.1% total fee
    await (await c.gateway.connect(user2).buyToken(token, E(100))).wait()

    const f = await world.pad.feesOf(token)
    expect(f.total).to.equal(E(27.1))
    expect(f.holders).to.equal(E(27.1))
    // over the $2 trigger: already dropped into the sniper's own chain pool —
    // the sniper is also the only holder, so the tax streams back pro-rata
    // like any fee (the POINT is that later holders share every next drop)
    const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
    expect(await c.dist.withdrawable(rep.target, user2.address)).to.be.closeTo(E(27.1), DUST)
  })

  it('the tax rides FEE_BURN mode into the burn pot', async () => {
    const c = world.chains[4]
    const { token, spawnedAt } = await spawn(c, 3) // FEE_BURN
    await fundUsd(c, user2, 500)

    await time.setNextBlockTimestamp(spawnedAt + 60)
    await (await c.gateway.connect(user2).buyToken(token, E(100))).wait()
    // $27.10 of tax blows past the $4 trigger: the sniper just financed an
    // instant buyback & burn — global supply shrank because they sniped
    const f = await world.pad.feesOf(token)
    expect(f.burnPot).to.equal(0n)
    expect(f.burnedUsd).to.equal(E(27.1))
    expect(f.burnedTokens).to.be.gt(0n)
  })

  it('caps each wallet at $250 in the window: clamp, refund, then full bounce', async () => {
    const c = world.chains[2]
    const { token, spawnedAt } = await spawn(c)
    await fundUsd(c, user2, 1_000)

    // $300 intent -> only $250 reaches the market, $50 rides home
    await time.setNextBlockTimestamp(spawnedAt + 300)
    const tx = await c.gateway.connect(user2).buyToken(token, E(300))
    await tx.wait()
    expect(await worth(c, user2)).to.equal(E(750)) // 1000 - 250
    expect(await world.pad.genesisSpent(token, ethers.zeroPadValue(user2.address, 32))).to.equal(
      E(250),
    )
    // snipeBps 1450 -> feeRate 15.5%: fee = $38.75, of which tax = $36.25
    await expect(tx)
      .to.emit(world.pad, 'GenesisGuard')
      .withArgs(token, ethers.zeroPadValue(user2.address, 32), 1450n, E(36.25), E(50))

    // at the cap: the next buy bounces whole
    const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
    const bag = await rep.balanceOf(user2)
    await (await c.gateway.connect(user2).buyToken(token, E(10))).wait()
    expect(await rep.balanceOf(user2)).to.equal(bag)
    expect(await worth(c, user2)).to.equal(E(750))

    // the window closes: the cap lifts
    await time.setNextBlockTimestamp(spawnedAt + 601)
    await (await c.gateway.connect(user2).buyToken(token, E(500))).wait()
    expect(await rep.balanceOf(user2)).to.be.gt(bag)
  })

  it('the dev buy at spawn is the one disclosed exemption: no tax, no cap, no block-0', async () => {
    const c = world.chains[2]
    await fundUsd(c, user, 600)
    await (await c.gateway.connect(user).spawnToken('DEVBAG', 'DEV', '{}', E(500), 0)).wait()
    const token = await world.pad.allTokens(0)

    // plain 1% fee on $500, straight through the spawn block, above the cap
    expect((await world.pad.feesOf(token)).total).to.equal(E(5))
    expect(await world.pad.genesisSpent(token, ethers.zeroPadValue(user.address, 32))).to.equal(0n)
    const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
    expect(await rep.balanceOf(user)).to.be.gt(0n)
  })

  it('fairGenesisOf reports the window to the UI, live and after', async () => {
    const c = world.chains[2]
    const { token, spawnedAt } = await spawn(c)
    const actor = ethers.zeroPadValue(user2.address, 32)

    let g = await world.pad.fairGenesisOf(token, actor)
    expect(g.endsAt).to.equal(spawnedAt + 600)
    expect(g.snipeBpsNow).to.be.gt(2800n) // seconds in: near the 2900 max
    expect(g.spentUsd).to.equal(0n)
    expect(g.capUsd).to.equal(E(250))

    await fundUsd(c, user2, 100)
    await time.setNextBlockTimestamp(spawnedAt + 300)
    await (await c.gateway.connect(user2).buyToken(token, E(100))).wait()
    g = await world.pad.fairGenesisOf(token, actor)
    expect(g.spentUsd).to.equal(E(100))
    expect(g.snipeBpsNow).to.be.lte(1450n)

    await time.increase(600)
    g = await world.pad.fairGenesisOf(token, actor)
    expect(g.snipeBpsNow).to.equal(0n)
  })
})
