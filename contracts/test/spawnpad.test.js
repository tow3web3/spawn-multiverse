const { expect } = require('chai')
const { ethers } = require('hardhat')
const { time } = require('@nomicfoundation/hardhat-network-helpers')
const { deployWorld, fundUsd, worth, backing, U } = require('../scripts/lib-deploy')

const E = (n) => ethers.parseEther(String(n))
// FAIR GENESIS (v6): most suites test steady-state economics, so they hop
// past the 10-minute anti-snipe window; the window itself has its own suite.
const pastGenesis = () => time.increase(601)

describe('SPAWN! omnichain protocol', () => {
  let world, user, user2

  beforeEach(async () => {
    ;[, user, user2] = await ethers.getSigners()
    world = await deployWorld()
  })

  async function spawnVia(chain, name = 'GLOOP SUPREME', sym = 'GLOOP', dev = 0n, feeMode = 0) {
    await (await chain.gateway.connect(user).spawnToken(name, sym, '{"face":"frog"}', dev, feeMode)).wait()
    await pastGenesis()
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

    await fundUsd(sol, user, 1_000)
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
    await fundUsd(base, user2, 1_000)
    await (await base.gateway.connect(user2).buyToken(token, E(100))).wait()
    expect(await world.pad.spotPrice(token)).to.be.gt(p1)
    const rep2 = await ethers.getContractAt('SpawnToken', await base.gateway.replicaOf(token))
    expect(await rep2.balanceOf(user2)).to.be.lt(bal)
  })

  it('global token supply is conserved across all chains', async () => {
    const token = await spawnVia(world.chains[0])
    await fundUsd(world.chains[1], user, 5_000)
    await (await world.chains[1].gateway.connect(user).buyToken(token, E(2_500))).wait()

    let total = await (await ethers.getContractAt('SpawnToken', token)).totalSupply()
    for (const c of world.chains) {
      const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
      total += await rep.totalSupply()
    }
    expect(total).to.equal(E(1_000_000_000))
  })

  it('sells back on any chain and receives dollars there', async () => {
    const token = await spawnVia(world.chains[0])
    const c = world.chains[4] // arbitrum
    await fundUsd(c, user, 500)
    await (await c.gateway.connect(user).buyToken(token, E(200))).wait()

    const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
    const bal = await rep.balanceOf(user)
    const usdBefore = await worth(c, user)

    await (await c.gateway.connect(user).sellToken(token, bal / 2n)).wait()
    expect(await rep.balanceOf(user)).to.equal(bal - bal / 2n)

    // selling the FIRST half of the bag happens on the upper half of the
    // curve, so it returns about half the spend (minus the 1% fee each way)
    // v7: the payout settles in USDC (this chain's vault is liquid)
    const got = (await worth(c, user)) - usdBefore
    expect(got).to.be.gt(E(96))
    expect(got).to.be.lt(E(103))
  })

  it('ascends when the curve fills: refund, omnipool, trading continues', async () => {
    const token = await spawnVia(world.chains[0])
    const c = world.chains[0]
    await fundUsd(c, user, 20_000)

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
    const refund = await worth(c, user)
    expect(refund).to.be.gt(E(2_100))
    expect(refund).to.be.lt(E(2_400))

    // the buyer holds the entire curve allocation
    const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
    expect(await rep.balanceOf(user)).to.equal(E(800_000_000))

    // trading continues on the omnipool, from any chain
    const d = world.chains[5]
    await fundUsd(d, user2, 1_000)
    const pBefore = await world.pad.spotPrice(token)
    await (await d.gateway.connect(user2).buyToken(token, E(500))).wait()
    expect(await world.pad.spotPrice(token)).to.be.gt(pBefore)
  })

  it('dev buy at spawn gives the creator the first bag', async () => {
    const c = world.chains[2]
    await fundUsd(c, user, 100)
    await (await c.gateway.connect(user).spawnToken('SUNNY BLOB', 'SUNNY', '{}', E(25), 0)).wait()

    const token = await world.pad.allTokens(0)
    const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
    expect(await rep.balanceOf(user)).to.be.gt(0n)
    expect(await c.usd.balanceOf(user)).to.equal(E(75))
  })

  it('dollar value is conserved end to end (burn-and-mint, nothing leaks)', async () => {
    const token = await spawnVia(world.chains[0])
    const a = world.chains[0]
    const b = world.chains[3]
    await fundUsd(a, user, 1_000)
    await fundUsd(b, user2, 1_000)

    await (await a.gateway.connect(user).buyToken(token, E(400))).wait()
    await (await b.gateway.connect(user2).buyToken(token, E(300))).wait()
    const rep = await ethers.getContractAt('SpawnToken', await a.gateway.replicaOf(token))
    await (await a.gateway.connect(user).sellToken(token, (await rep.balanceOf(user)) / 2n)).wait()

    // v7: every oUSD anywhere (hub ledger included) is backed 1:1 by USDC in
    // a vault, and not one mock dollar left the system or appeared in it
    const { usdc, supply } = await backing(world)
    expect(supply).to.equal(usdc)
    let dollars = 0n
    for (const ch of world.chains) {
      dollars += await ch.usdc.balanceOf(ch.usd.target)
      dollars += (await ch.usdc.balanceOf(user)) + (await ch.usdc.balanceOf(user2))
    }
    expect(dollars).to.equal(U(2_000)) // exactly what was minted
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
    await pastGenesis()
    const token = await world.pad.allTokens(0)
    await fundUsd(c, user, 1_000)
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
    await pastGenesis()
    const token = await world.pad.allTokens(0)
    const away = world.chains[3]
    await fundUsd(away, user2, 500)
    await (await away.gateway.connect(user2).buyToken(token, E(400))).wait()

    // the dev claims from a chain they never touched — payout lands there
    const claimChain = world.chains[5]
    const before = await worth(claimChain, user)
    await (await claimChain.gateway.connect(user).claimFees(token)).wait()
    expect((await worth(claimChain, user)) - before).to.equal(E(4)) // 1% of $400
    // v7: nobody ever deposited on the claim chain, so its vault is empty —
    // the payout arrived as an oUSD claim instead of reverting
    expect(await claimChain.usd.balanceOf(user.address)).to.equal(E(4))

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
    await pastGenesis()
    const token = await world.pad.allTokens(0)
    await fundUsd(c, user, 2_000)
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
    const b32 = (a) => ethers.zeroPadValue(a, 32)
    const token = await spawnVia(world.chains[0])
    const payload = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint8', 'bytes'],
      [2, ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32', 'uint256'], [b32(token), b32(user.address), E(100)])],
    )
    await expect(world.pad.connect(user).onOmniMessage(1, b32(user.address), payload)).to.be.revertedWith(
      'PAD: not messenger',
    )
    await expect(
      world.chains[0].gateway.connect(user).onOmniMessage(0, b32(user.address), payload),
    ).to.be.revertedWith('GW: not messenger')
    await expect(world.messenger.connect(user).send(0, b32(world.pad.target), payload, 0)).to.be.revertedWith(
      'LOM: unknown sender',
    )
  })

  it('wide token ids revert; wide identities never reach an EVM-local mint', async () => {
    // v5: ACTORS may be wide (Solana pubkeys) — but token ids are hub EVM
    // contracts and must downcast, and an EVM spoke must refuse to mint to a
    // wide recipient.
    const { impersonateAccount, setBalance } = require('@nomicfoundation/hardhat-network-helpers')
    const b32 = (a) => ethers.zeroPadValue(a, 32)
    const coder = ethers.AbiCoder.defaultAbiCoder()
    const token = await spawnVia(world.chains[0])
    await impersonateAccount(world.messenger.target)
    await setBalance(world.messenger.target, E(1))
    const msgr = await ethers.getSigner(world.messenger.target)
    const src = world.chains[0]
    const srcId = b32(src.gateway.target)
    const label = await src.gateway.chainLabel()

    // a wide TOKEN id is corruption — the hub refuses it
    const wideToken = '0x01' + '00'.repeat(11) + token.slice(2)
    const badTokenBuy = coder.encode(
      ['uint8', 'bytes'],
      [2, coder.encode(['bytes32', 'bytes32', 'uint256'], [wideToken, b32(user.address), E(100)])],
    )
    await expect(world.pad.connect(msgr).onOmniMessage(label, srcId, badTokenBuy)).to.be.revertedWith(
      'PAD: bad recipient',
    )

    // a wide BUYER is legal on the hub — but this spoke is EVM, so when the
    // hub's synchronous delivery tries to mint to it, the GATEWAY refuses:
    // the wide identity never reaches a local ERC20 mint.
    const wideBuyer = '0x11' + 'ab'.repeat(31)
    const wideBuy = coder.encode(
      ['uint8', 'bytes'],
      [2, coder.encode(['bytes32', 'bytes32', 'uint256'], [b32(token), wideBuyer, E(100)])],
    )
    await expect(world.pad.connect(msgr).onOmniMessage(label, srcId, wideBuy)).to.be.revertedWith(
      'GW: bad recipient',
    )
  })

  it('a wide (Solana-style) creator owns, earns and claims like anyone', async () => {
    // Simulated label-1 gateway over the sync world: inject hub-bound
    // messages as the messenger, with actors that no EVM address can hold.
    const { impersonateAccount, setBalance } = require('@nomicfoundation/hardhat-network-helpers')
    const b32 = (a) => ethers.zeroPadValue(a, 32)
    const coder = ethers.AbiCoder.defaultAbiCoder()
    await impersonateAccount(world.messenger.target)
    await setBalance(world.messenger.target, E(1))
    const msgr = await ethers.getSigner(world.messenger.target)
    const src = world.chains[0] // label 1 = solana in the local world
    const srcId = b32(src.gateway.target)
    const wideCreator = '0x22' + 'cd'.repeat(31)

    // spawn with a wide creator, fee mode 2 (100% dev)
    const spawn = coder.encode(
      ['uint8', 'bytes'],
      [1, coder.encode(['bytes32', 'string', 'string', 'string', 'uint256', 'uint8'], [wideCreator, 'SOL GLOOP', 'SGLP', '{}', 0, 2])],
    )
    await (await world.pad.connect(msgr).onOmniMessage(1, srcId, spawn)).wait()
    await pastGenesis()
    const token = await world.pad.allTokens(0)
    expect((await world.pad.metas(token)).creator).to.equal(wideCreator)

    // an ordinary EVM user trades; fees accrue to the wide dev
    const base = world.chains[2]
    await fundUsd(base, user, 1_000)
    await (await base.gateway.connect(user).buyToken(token, E(500))).wait()
    const fees = await world.pad.feesOf(token)
    expect(fees.dev).to.equal(E(5))

    // the wide creator claims; the OP_PAYOUT re-materializes the exact oUSD
    // on their chain — delivery works because the sync world's label-1 spoke
    // credits by message, and the wide identity rides the wire intact.
    const claim = coder.encode(
      ['uint8', 'bytes'],
      [4, coder.encode(['bytes32', 'bytes32'], [b32(token), wideCreator])],
    )
    // the sync spoke is EVM, so the final local mint must refuse the wide
    // recipient — proving the payout LEFT the hub with the identity intact
    // and that no EVM account can intercept it.
    await expect(world.pad.connect(msgr).onOmniMessage(1, srcId, claim)).to.be.revertedWith(
      'GW: bad recipient',
    )
    // and an EVM impostor (padded) cannot claim the wide dev's fees
    const impostor = coder.encode(
      ['uint8', 'bytes'],
      [4, coder.encode(['bytes32', 'bytes32'], [b32(token), b32(user.address)])],
    )
    await expect(world.pad.connect(msgr).onOmniMessage(1, srcId, impostor)).to.be.revertedWith(
      'PAD: not the dev',
    )
  })
})
