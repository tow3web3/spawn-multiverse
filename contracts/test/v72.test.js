const { expect } = require('chai')
const { ethers, artifacts } = require('hardhat')
const { time, impersonateAccount, setBalance, takeSnapshot } = require('@nomicfoundation/hardhat-network-helpers')
const { deployWorld, deployWorldAsync, deployDistributor, setV72Legs, fundUsdc, fundUsd, backing, U, GAS_TO_SPOKE, MOCK_GAS_TO_HUB } = require('../scripts/lib-deploy')

const E = (n) => ethers.parseEther(String(n))
const b32 = (a) => ethers.zeroPadValue(a, 32)
const coder = ethers.AbiCoder.defaultAbiCoder()
const bal = (who) => ethers.provider.getBalance(who.target ?? who.address ?? who)
const pastGenesis = () => time.increase(601)
const BILLION = E(1_000_000_000)

/** What the mock endpoint charges for one message, to any chain. */
const FEE = E('0.001')
/** A cheap chain's reply unit: one reply to it, plus a margin. */
const UNIT = E('0.0012')
const EID = (label) => 30_000 + label
/** A 32-byte identity that is not an address (a Solana key, say). */
const WIDE = '0x' + 'ab'.repeat(32)

/* Wire payloads, as the pad and the gateways build them. */
const op = (code, types, values) => coder.encode(['uint8', 'bytes'], [code, coder.encode(types, values)])
const syncOf = (token, name, symbol) => op(10, ['bytes32', 'string', 'string'], [b32(token), name, symbol])
const moveOf = (from, to, amount, dstChain) => op(7, ['bytes32', 'bytes32', 'uint256', 'uint32'], [from, to, amount, dstChain])
/** A queued packet's protocol opcode and its inner tuple. */
function unpack(pkt) {
  const [, , payload] = coder.decode(['bytes32', 'bytes32', 'bytes'], pkt.message)
  const [code, data] = coder.decode(['uint8', 'bytes'], payload)
  return { op: Number(code), data }
}

/** Runs `fn`, returns what it returns, and puts the chain back as it was. */
async function peek(fn) {
  const snap = await takeSnapshot()
  try {
    return await fn()
  } finally {
    await snap.restore()
  }
}

async function as(address) {
  await impersonateAccount(address)
  await setBalance(address, E(10))
  return ethers.getSigner(address)
}

/** Label 3 is the hub chain's own gateway: it reaches the pad by loopback. */
const HOME = 3
const LAYOUT = [
  { label: 3, id: 'base', dollar: 'USDC' },
  { label: 6, id: 'optimism', dollar: 'USDC' },
  { label: 5, id: 'arbitrum', dollar: 'USDC' },
  { label: 2, id: 'ethereum', dollar: 'USDC' },
  { label: 4, id: 'bnb', dollar: 'USDT' },
]

/**
 * THE MIXED UNIVERSE (v7.2) — one hub, five user-facing EVM chains, two
 * dollars, in the mainnet topology and with the mainnet fee setting (nobody
 * is sponsored but the pad: every user call attaches its quoted fee):
 *
 *   label 3  base      the hub chain's own gateway (loopback)   USDC   OmniUSD
 *   label 6  optimism  remote                                   USDC   OmniUSD
 *   label 5  arbitrum  remote                                   USDC   OmniUSD
 *   label 2  ethereum  remote — the dear leg                    USDC   OmniUSD
 *   label 4  bnb       remote                                   USDT   OmniUSDLocal (18 decimals, SCALE 1, no CCTP)
 *
 * all over the mock endpoint, which charges FEE per message (plus what a
 * test adds for one destination). Every remote chain prepays UNIT per reply
 * leg; the hub's ceiling for a request toward a remote chain is that UNIT.
 * `homePool: false` leaves the hub chain's gateway without its holder pool,
 * so that its SYNC fails at launch; `homeDollar` swaps the hub chain's USDC
 * for a test token (one with a transfer hook).
 */
async function deployMixed({ homePool = true, homeDollar = 'MockUSDC' } = {}) {
  const [funder] = await ethers.getSigners()
  const endpoint = await ethers.deployContract('MockLZEndpointV2', [FEE])
  const hubMessenger = await ethers.deployContract('LayerZeroOmniMessenger', [endpoint.target, EID(0)])
  await (await endpoint.registerAdapter(hubMessenger.target, EID(0))).wait()
  // the hub tank's float
  await (await funder.sendTransaction({ to: hubMessenger.target, value: E(1) })).wait()

  const hubUsd = await ethers.deployContract('OmniUSD', [0, ethers.ZeroAddress, ethers.ZeroAddress])
  const pad = await ethers.deployContract('SpawnPad', [hubMessenger.target, hubUsd.target])
  const venue = await ethers.deployContract('InternalCurveVenue', [pad.target])
  await (await pad.setVenue(venue.target)).wait()
  await (await hubUsd.setAgent(pad.target)).wait()
  await (await hubMessenger.register(pad.target, 0)).wait()
  await (await hubMessenger.setSponsored(pad.target, true)).wait()
  await (await hubMessenger.setLocal(0, true)).wait()
  await (await hubMessenger.setLocal(HOME, true)).wait()
  // what a user of the hub chain's gateway prepays per leg the hub must send for them
  await (await hubMessenger.setDestination(0, 0, UNIT)).wait()

  const labels = LAYOUT.map((c) => c.label)
  const remotes = labels.filter((l) => l !== HOME).length
  const chains = []
  for (const c of LAYOUT) {
    const local = c.label === HOME
    let messenger = hubMessenger
    if (!local) {
      // a spoke adapter with an EMPTY tank: nothing here is paid by anyone but the user
      messenger = await ethers.deployContract('LayerZeroOmniMessenger', [endpoint.target, EID(c.label)])
      await (await endpoint.registerAdapter(messenger.target, EID(c.label))).wait()
    }
    let dollar, usd, decimals
    if (c.dollar === 'USDT') {
      decimals = 18
      dollar = await ethers.deployContract('MockDollar', ['Tether USD', 'USDT', decimals])
      usd = await ethers.deployContract('OmniUSDLocal', [c.label, dollar.target])
    } else {
      decimals = 6
      // (`homeDollar`: the hub chain's dollar as a token with a transfer hook — tests only)
      dollar =
        c.label === HOME && homeDollar !== 'MockUSDC'
          ? await ethers.deployContract(homeDollar, [decimals])
          : await ethers.deployContract('MockUSDC')
      const cctp = await ethers.deployContract('MockTokenMessenger')
      usd = await ethers.deployContract('OmniUSD', [c.label, dollar.target, cctp.target])
    }
    const T = (n) => ethers.parseUnits(String(n), decimals)
    await (await usd.setDepositCap(T(1_000_000_000))).wait()
    const gateway = await ethers.deployContract('SpawnGateway', [messenger.target, usd.target, c.label, pad.target])
    await (await usd.setAgent(gateway.target)).wait()
    await (await messenger.register(gateway.target, c.label)).wait()
    if (!local) {
      await (await messenger.setRoute(0, EID(0), b32(hubMessenger.target))).wait()
      await (await hubMessenger.setRoute(c.label, EID(c.label), b32(messenger.target))).wait()
      await (await messenger.setDestination(0, MOCK_GAS_TO_HUB, UNIT)).wait()
      await (await hubMessenger.setDestination(c.label, GAS_TO_SPOKE, 0)).wait()
    }
    const chain = { ...c, local, dollar, usd, gateway, messenger, decimals, T, SCALE: await usd.SCALE() }
    chain.wirePool = async () => {
      chain.dist = await deployDistributor(usd, gateway)
    }
    if (!local || homePool) await chain.wirePool()
    await (await pad.setGateway(c.label, b32(gateway.target))).wait()
    if (local) await (await pad.setAutoDrop(c.label, true)).wait()
    await (await gateway.setLegs(local ? 0 : 1, remotes)).wait()
    // v7.2: an open prepays one leg (none at home), a move one leg to any other chain;
    // on the hub, a request toward a remote chain may cost up to what it prepaid
    await setV72Legs(gateway, { local, labels, self: c.label })
    if (!local) await (await pad.setRequestCap(c.label, UNIT)).wait()
    chains.push(chain)
  }

  const w = { endpoint, hubMessenger, hubUsd, pad, venue, chains, labels }
  w.at = (label) => chains.find((c) => c.label === label)
  w.tank = () => bal(hubMessenger)
  w.deliverAll = async () => {
    while ((await endpoint.pending()) > 0n) await (await endpoint.deliverAll(32)).wait()
  }
  /** Gives `who` `dollars` of `c`'s dollar token, approved to its vault. */
  w.fund = async (c, who, dollars) => {
    await (await c.dollar.mint(who.address, c.T(dollars))).wait()
    await (await c.dollar.connect(who).approve(c.usd.target, ethers.MaxUint256)).wait()
  }
  /** Leaves `who` holding `dollars` of oUSD on `c`, backed — the way a claim
   * comes to exist: the gateway took the dollars in, their value came back
   * as oUSD. (The USDT vault has no `wrap`; this works on both.) */
  w.claim = async (c, who, dollars) => {
    await w.fund(c, who, dollars)
    const agent = await as(c.gateway.target)
    await (await c.usd.connect(agent).depositFor(who.address, c.T(dollars))).wait()
    await (await c.usd.connect(agent).bridgeMint(who.address, E(dollars))).wait()
  }
  /** Everything `who` holds in `c`'s dollars, in oUSD wei: tokens + claims. */
  w.worth = async (c, who) => (await c.dollar.balanceOf(who.address)) * c.SCALE + (await c.usd.balanceOf(who.address))
  /** Both sides of the GLOBAL backing invariant: every vault's dollars at
   * that vault's SCALE, and oUSD supply over every instance, ledger included. */
  w.backing = async () => {
    let held = 0n
    let supply = await hubUsd.totalSupply()
    for (const c of chains) {
      held += (await c.dollar.balanceOf(c.usd.target)) * c.SCALE
      supply += await c.usd.totalSupply()
    }
    return { held, supply }
  }
  w.tokens = async () => {
    const n = Number(await pad.tokensLength())
    const out = []
    for (let i = 0; i < n; i++) out.push(await pad.allTokens(i))
    return out
  }
  w.lastToken = async () => pad.allTokens((await pad.tokensLength()) - 1n)
  w.replica = async (c, token) => ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
  /** The labels that hold a replica of `token`, sorted. */
  w.replicated = async (token) => {
    const have = []
    for (const c of chains) if ((await c.gateway.replicaOf(token)) !== ethers.ZeroAddress) have.push(c.label)
    return have.sort((a, b) => a - b)
  }
  /** What must hold whenever nothing is in flight. `parked`: tokens the hub
   * delivered that wait in a gateway for their replica. */
  w.check = async ({ parked = 0n } = {}) => {
    expect(await endpoint.pending(), 'messages in flight').to.equal(0n)
    const b = await w.backing()
    expect(b.held, 'Σ vault dollars × SCALE == Σ oUSD supply').to.equal(b.supply)
    for (const t of await w.tokens()) {
      let total = await (await ethers.getContractAt('SpawnToken', t)).totalSupply()
      for (const c of chains) {
        const rep = await c.gateway.replicaOf(t)
        const there = rep === ethers.ZeroAddress ? 0n : await (await ethers.getContractAt('SpawnToken', rep)).totalSupply()
        // S2: the hub's ledger of where the supply lives is what the chain holds
        if (parked === 0n) expect(await pad.supplyByChain(t, c.label), `supplyByChain ${c.id}`).to.equal(there)
        total += there
      }
      expect(total + parked, 'token supply').to.equal(BILLION - (await pad.feesOf(t)).burnedTokens)
    }
  }
  /** One step of a scenario: the transaction, every message it causes, then
   * the invariants — and the hub tank, which a prepaid step never lowers. */
  w.step = async (send, { tankMayFall = false, parked = 0n } = {}) => {
    const tank = await w.tank()
    const rc = await (await send()).wait()
    await w.deliverAll()
    await w.check({ parked })
    if (!tankMayFall) expect(await w.tank(), 'hub tank').to.be.gte(tank)
    return rc
  }
  /* user actions, each with its quoted fee attached */
  w.spawn = async (c, who, { name = 'GLOOP', symbol = 'GLP', meta = '{}', devBuy = 0, mode = 0 } = {}) =>
    c.gateway.connect(who).spawnTokenUsdc(name, symbol, meta, c.T(devBuy), mode, {
      value: await c.gateway.quoteSpawn(name, symbol, meta, devBuy > 0),
    })
  w.buy = async (c, who, token, dollars) =>
    c.gateway.connect(who).buyTokenUsdc(token, c.T(dollars), { value: await c.gateway.quoteBuy() })
  w.sell = async (c, who, token, tokens) =>
    c.gateway.connect(who).sellToken(token, tokens, { value: await c.gateway.quoteSell() })
  w.open = async (c, who, token) => c.gateway.connect(who).openToken(token, { value: await c.gateway.quoteOpen() })
  w.move = async (c, who, dst, to, amount) =>
    c.gateway.connect(who).moveClaim(dst, to, amount, { value: await c.gateway.quoteMove(dst) })
  /** What the hub's adapter asks the pad for `token`'s SYNC to `label`. */
  w.syncQuote = async (token, label) => {
    const m = await pad.metas(token)
    return hubMessenger
      .connect(ethers.provider)
      .quote(label, await pad.gateways(label), syncOf(token, m.name, m.symbol), 0, { from: pad.target })
  }
  return w
}

/**
 * Makes Ethereum the dear leg it is: a message to it costs `times` what a
 * message to an L2 does. Its own users prepay their replies at that price
 * (+20%), a claim moved there prepays it in the sender's cheap units, and
 * the hub's ceiling for a request toward it follows.
 */
async function dearEthereum(w, times = 10n) {
  const eth = w.at(2)
  await (await w.endpoint.setDstFee(EID(2), FEE * (times - 1n))).wait()
  const l1 = FEE * times
  const unit = (l1 * 12n) / 10n
  await (await eth.messenger.setDestination(0, MOCK_GAS_TO_HUB, unit)).wait()
  await (await w.pad.setRequestCap(2, unit)).wait()
  for (const c of w.chains) if (c.label !== 2) await (await c.gateway.setMoveLegs(2, unit / UNIT)).wait()
  return { l1, unit }
}

/** The parsed `name` events of `contract` in a receipt. */
function events(rc, contract, name) {
  return rc.logs
    .filter((l) => l.address === contract.target)
    .map((l) => {
      try {
        return contract.interface.parseLog(l)
      } catch {
        return null
      }
    })
    .filter((e) => e?.name === name)
}

describe('Protocol v7.2 — one universe, six chains, two dollars', () => {
  let admin, dev, alice, bob, carol, stranger, operator, guardian

  beforeEach(async () => {
    ;[admin, dev, alice, bob, carol, stranger, operator, guardian] = await ethers.getSigners()
  })

  /* ====================================================================== */
  /*  The mixed universe works as one                                        */
  /* ====================================================================== */

  describe('the mixed universe: a USDT chain among USDC chains, one curve', () => {
    it('a spawn from each chain creates every replica — and the dev buy is paid in that chain\'s own dollar', async () => {
      const w = await deployMixed()
      for (const c of w.chains) {
        await w.fund(c, dev, 100)
        const name = `FROM ${c.id.toUpperCase()}`
        // a remote launch prepays the SYNC to the four remote chains and the dev buy's DELIVER;
        // a launch on the hub chain only the four SYNCs (its own replies are local calls)
        expect(await c.gateway.quoteSpawn(name, 'T', '{}', true)).to.equal(c.local ? 4n * UNIT : FEE + 5n * UNIT)
        await w.step(() => w.spawn(c, dev, { name, symbol: 'T', devBuy: 25 }))
        const token = await w.lastToken()
        expect(await w.replicated(token)).to.deep.equal([2, 3, 4, 5, 6])
        expect((await w.pad.metas(token)).homeChain).to.equal(BigInt(c.label))
        // the bag is on the launcher's chain, bought with 25 of ITS dollar
        expect(await (await w.replica(c, token)).balanceOf(dev.address)).to.be.gt(E(4_000_000))
        expect(await c.dollar.balanceOf(dev.address)).to.equal(c.T(75))
        expect(await c.dollar.balanceOf(c.usd.target)).to.equal(c.T(25))
      }
      // five launches: 125 dollars in five vaults — 100 USDC (6 decimals) and 25 USDT (18)
      const b = await w.backing()
      expect(b.held).to.equal(E(125))
      expect(await w.at(4).dollar.balanceOf(w.at(4).usd.target)).to.equal(E(25))
      expect(await w.hubUsd.totalSupply()).to.equal(E(125))
    })

    it('a buy on BNB in USDT and a sell on Optimism paid in USDC move the same curve; a vault only pays what it holds', async () => {
      const w = await deployMixed()
      const [base, opt, bnb] = [w.at(3), w.at(6), w.at(4)]
      await w.step(() => w.spawn(base, dev))
      const token = await w.lastToken()
      await pastGenesis()
      await w.fund(opt, alice, 1_000)
      await w.fund(bnb, bob, 1_000)

      await w.step(() => w.buy(opt, alice, token, 400))
      const p1 = await w.pad.spotPrice(token)
      const repOpt = await w.replica(opt, token)
      const bagAlice = await repOpt.balanceOf(alice.address)
      expect(bagAlice).to.be.gt(0n)

      // USDT in: 600 units of an 18-decimal dollar — the hub books 600 dollars, like any others
      const books = await w.hubUsd.totalSupply()
      await w.step(() => w.buy(bnb, bob, token, 600))
      expect(await bnb.dollar.balanceOf(bnb.usd.target)).to.equal(E(600))
      expect(await bnb.dollar.balanceOf(bob.address)).to.equal(E(400))
      expect((await w.hubUsd.totalSupply()) - books).to.equal(E(600))
      const bagBob = await (await w.replica(bnb, token)).balanceOf(bob.address)
      expect(bagBob).to.be.gt(0n)
      const p2 = await w.pad.spotPrice(token)
      expect(p2).to.be.gt(p1) // Bob's USDT moved the price Alice sells at

      // Alice sells half on Optimism: paid in USDC, out of Optimism's vault
      const usdc = await opt.dollar.balanceOf(alice.address)
      await w.step(() => w.sell(opt, alice, token, bagAlice / 2n))
      const got = (await opt.dollar.balanceOf(alice.address)) - usdc
      expect(got).to.be.gt(U(200)) // more than half of what she paid: the price rose
      expect(await opt.usd.balanceOf(alice.address)).to.be.lt(opt.SCALE) // only sub-unit dust is a claim
      expect(await w.pad.spotPrice(token)).to.be.lt(p2)

      // …and the rest: worth more than the 400 − got USDC her chain's vault still holds, so
      // the WHOLE payout is a claim — the dollars that would pay it sit on BNB, as USDT
      const left = await opt.dollar.balanceOf(opt.usd.target)
      await w.step(() => w.sell(opt, alice, token, bagAlice - bagAlice / 2n))
      const claim = await opt.usd.balanceOf(alice.address)
      expect(claim).to.be.gt(left * opt.SCALE)
      expect(await opt.dollar.balanceOf(opt.usd.target)).to.equal(left)
      await expect(opt.usd.connect(alice).unwrap(claim)).to.be.revertedWith('oUSD: vault short')

      // Bob sells on BNB: paid in USDT, to the wei (SCALE 1: no dust, no claim)
      const usdt = await bnb.dollar.balanceOf(bob.address)
      await w.step(() => w.sell(bnb, bob, token, bagBob))
      expect(await bnb.dollar.balanceOf(bob.address)).to.be.gt(usdt)
      expect(await bnb.usd.balanceOf(bob.address)).to.equal(0n)
    })

    it('the USDT vault behind a REMOTE gateway: deposits, refunds, payouts and holder fees to the wei — and no `wrap`', async () => {
      const w = await deployMixed()
      const [base, bnb] = [w.at(3), w.at(4)]
      expect(bnb.SCALE).to.equal(1n)
      expect(bnb.local).to.equal(false)
      expect(await bnb.gateway.tradeLegs()).to.equal(1n)
      expect(bnb.usd.interface.fragments.some((f) => f.type === 'function' && f.name === 'wrap')).to.equal(false)
      expect(base.usd.interface.getFunction('wrap')).to.not.equal(null) // the USDC vault keeps it

      await w.fund(bnb, dev, 1_000)
      await w.fund(bnb, bob, 1_000)
      // a launch from BNB, fee mode 0 (holders), with an odd dev buy: 18 decimals carry every wei
      const odd = E(40) + 123_456_789n
      const fee = await bnb.gateway.quoteSpawn('BNB FROG', 'BFROG', '{}', true)
      await w.step(() => bnb.gateway.connect(dev).spawnTokenUsdc('BNB FROG', 'BFROG', '{}', odd, 0, { value: fee }))
      const token = await w.lastToken()
      expect(await bnb.dollar.balanceOf(bnb.usd.target)).to.equal(odd)
      expect(await w.hubUsd.totalSupply()).to.equal(odd)

      // inside the genesis window: $260 is clamped to $250 — the $10 comes back across the wire, in USDT
      await w.step(() => w.buy(bnb, bob, token, 260))
      expect(await bnb.dollar.balanceOf(bob.address)).to.equal(E(750))
      expect(await bnb.usd.balanceOf(bob.address)).to.equal(0n)
      await pastGenesis()

      // holder fees: booked on the hub, pulled to BNB by a user-paid message, claimed as oUSD, unwrapped as USDT
      const rep = await w.replica(bnb, token)
      expect(await w.pad.pendingDrop(token, 4)).to.be.gt(0n)
      await w.step(async () => bnb.gateway.connect(stranger).pullFees(token, { value: await bnb.gateway.quotePull() }))
      const owed = await bnb.dist.withdrawable(rep.target, bob.address)
      expect(owed).to.be.gt(0n)
      await w.step(() => bnb.dist.connect(bob).claim(rep.target))
      expect(await bnb.usd.balanceOf(bob.address)).to.equal(owed)
      const usdt = await bnb.dollar.balanceOf(bob.address)
      await w.step(() => bnb.usd.connect(bob).unwrap(owed))
      expect(await bnb.dollar.balanceOf(bob.address)).to.equal(usdt + owed)
      expect(await bnb.usd.balanceOf(bob.address)).to.equal(0n)

      // a sell: paid in USDT, exactly what the hub sent
      const bag = await rep.balanceOf(bob.address)
      const before = await bnb.dollar.balanceOf(bob.address)
      await w.step(() => w.sell(bnb, bob, token, bag))
      const paid = (await bnb.dollar.balanceOf(bob.address)) - before
      expect(paid).to.be.gt(E(150))
      expect(await bnb.usd.balanceOf(bob.address)).to.equal(0n)

      // the issuer freezes a seller: a claim, not a stuck message
      await w.step(() => w.buy(bnb, bob, token, 100))
      await (await bnb.dollar.setFrozen(bob.address, true)).wait()
      await w.step(async () => w.sell(bnb, bob, token, await rep.balanceOf(bob.address)))
      const claim = await bnb.usd.balanceOf(bob.address)
      expect(claim).to.be.gt(E(90))
      await (await bnb.dollar.setFrozen(bob.address, false)).wait()
      await w.step(() => bnb.usd.connect(bob).unwrap(claim))
    })
  })

  /* ====================================================================== */
  /*  1 + 2 + 3 — the ceiling, the open, the paid resync                     */
  /* ====================================================================== */

  describe('a dear chain: a ceiling at launch, then opened from there — or by anyone who pays', () => {
    it('the chain above its ceiling is skipped, the others are served, the tank is not charged; openToken, a paid resync and the operator each bring the replica', async () => {
      const w = await deployMixed()
      const [base, opt, eth] = [w.at(3), w.at(6), w.at(2)]
      const { l1, unit } = await dearEthereum(w)

      // WITHOUT a ceiling: a launch from Optimism prepaid four cheap legs; the hub sends three
      // cheap SYNCs and the dear one — every launch takes the difference out of the tank
      const drained = await peek(async () => {
        const tank = await w.tank()
        await w.step(() => w.spawn(opt, dev), { tankMayFall: true })
        expect(await w.replicated(await w.lastToken())).to.deep.equal([2, 3, 4, 5, 6])
        return tank - (await w.tank())
      })
      expect(drained).to.equal(3n * FEE + l1 - 4n * UNIT)
      expect(drained).to.be.gt(0n)

      // the ceiling is a price: the operator's, nobody else's
      await expect(w.pad.connect(stranger).setSyncCap(2, 1n)).to.be.revertedWith('ROLES: not operator')
      await expect(w.pad.connect(stranger).setRequestCap(2, 1n)).to.be.revertedWith('ROLES: not operator')
      await (await w.pad.setOperator(operator.address)).wait()
      await (await w.pad.setGuardian(guardian.address)).wait()
      await expect(w.pad.connect(guardian).setSyncCap(2, 1n)).to.be.revertedWith('ROLES: not operator')
      await expect(w.pad.connect(operator).setSyncCap(2, 2n * FEE)).to.emit(w.pad, 'SyncCapSet').withArgs(2, 2n * FEE)
      expect(await w.pad.syncCap(2)).to.equal(2n * FEE)
      expect(await w.pad.syncCap(6)).to.equal(0n) // no ceiling anywhere else

      // WITH it: the same launch
      let tank = await w.tank()
      await (await w.spawn(opt, dev, { name: 'ALPHA', symbol: 'A' })).wait()
      const landed = await w.endpoint.deliverNext() // the SPAWN lands on the hub
      const a = await w.lastToken()
      await expect(landed).to.emit(w.pad, 'SyncFailed').withArgs(a, 2)
      expect(events(await landed.wait(), w.pad, 'SyncFailed')).to.have.length(1)
      // four prepaid legs in, three cheap SYNCs out — and not a wei for Ethereum
      expect((await w.tank()) - tank).to.equal(4n * UNIT - 3n * FEE)
      expect(await w.endpoint.pending()).to.equal(3n)
      await w.deliverAll()
      expect(await w.replicated(a)).to.deep.equal([3, 4, 5, 6])
      await w.check()

      // on Ethereum the token does not exist: every entry is refused before anything moves
      await w.fund(eth, alice, 500)
      await expect(eth.gateway.connect(alice).buyTokenUsdc(a, eth.T(10), { value: await eth.gateway.quoteBuy() })).to.be.revertedWith('GW: unknown token')

      // 1. SOMEONE ON ETHEREUM OPENS IT, in Ethereum's coin: the message, and one reply at Ethereum's price
      const openFee = await eth.gateway.quoteOpen()
      expect(openFee).to.equal(FEE + unit)
      await expect(eth.gateway.connect(alice).openToken(a, { value: openFee - 1n })).to.be.revertedWith('LZM: fee')
      tank = await w.tank()
      await (await w.open(eth, alice, a)).wait()
      expect(unpack(await w.endpoint.peek(0))).to.deep.equal({ op: 6, data: coder.encode(['bytes32'], [b32(a)]) })
      await expect(w.endpoint.deliverNext()).to.emit(w.pad, 'Resynced').withArgs(a, 2)
      expect((await w.tank()) - tank).to.equal(unit - l1) // the opener paid for the dear SYNC, margin included
      await w.deliverAll()
      expect(await w.replicated(a)).to.deep.equal([2, 3, 4, 5, 6])
      await w.check()
      // an open is for a token that is NOT there
      await expect(eth.gateway.connect(alice).openToken(a, { value: openFee })).to.be.revertedWith('GW: already open')
      // …and Ethereum is now a chain like the others for it
      await pastGenesis()
      await w.step(() => w.buy(eth, alice, a, 100))
      expect(await (await w.replica(eth, a)).balanceOf(alice.address)).to.be.gt(0n)

      // 2. ANYONE PAYS A RESYNC on the hub — at least what the message costs, and all of it goes to the tank
      await w.step(() => w.spawn(base, dev, { name: 'BETA', symbol: 'B' }))
      const b = await w.lastToken()
      expect(await w.replicated(b)).to.deep.equal([3, 4, 5, 6])
      const quote = await w.syncQuote(b, 2)
      expect(quote).to.equal(l1)
      await expect(w.pad.connect(stranger).resync(b, 2)).to.be.revertedWith('PAD: fee')
      await expect(w.pad.connect(stranger).resync(b, 2, { value: quote - 1n })).to.be.revertedWith('PAD: fee')
      expect(await w.endpoint.pending()).to.equal(0n)
      tank = await w.tank()
      await expect(w.pad.connect(stranger).resync(b, 2, { value: quote })).to.emit(w.pad, 'Resynced').withArgs(b, 2)
      expect(await w.tank()).to.equal(tank) // in: the stranger's value; out: the fee
      expect(await bal(w.pad)).to.equal(0n) // nothing stays in the pad
      await w.deliverAll()
      expect(await w.replicated(b)).to.deep.equal([2, 3, 4, 5, 6])
      // a second one is ignored by the gateway (the replica is the same contract) — and whoever sent it paid for it
      const rep = await eth.gateway.replicaOf(b)
      await (await w.pad.connect(stranger).resync(b, 2, { value: quote + E('0.003') })).wait()
      expect(await w.tank()).to.equal(tank + E('0.003')) // a surplus stays in the tank
      await w.deliverAll()
      expect(await eth.gateway.replicaOf(b)).to.equal(rep)
      // a resync is only for a real token on a real chain, whoever pays
      await expect(w.pad.connect(stranger).resync(stranger.address, 2, { value: quote })).to.be.revertedWith('PAD: unknown')
      await expect(w.pad.connect(stranger).resync(b, 9, { value: quote })).to.be.revertedWith('PAD: unknown')
      await expect(w.pad.connect(stranger).resync(b, 0, { value: quote })).to.be.revertedWith('PAD: unknown')

      // 3. THE OPERATOR sends one on the tank's account, as before — and so may the admin
      await w.step(() => w.spawn(base, dev, { name: 'GAMMA', symbol: 'C' }))
      const c = await w.lastToken()
      tank = await w.tank()
      await expect(w.pad.connect(operator).resync(c, 2)).to.emit(w.pad, 'Resynced').withArgs(c, 2)
      expect(tank - (await w.tank())).to.equal(l1)
      await w.deliverAll()
      expect(await w.replicated(c)).to.deep.equal([2, 3, 4, 5, 6])
      await (await w.pad.resync(c, 2)).wait() // the admin may always act as operator
      // the guardian is not the operator: it pays like anyone
      await expect(w.pad.connect(guardian).resync(c, 2)).to.be.revertedWith('PAD: fee')
      await w.deliverAll()
      await w.check()
    })

    it('a price spike: an open is not sent above what an open prepays — the tank keeps the fee, and a paid resync still goes at any price', async () => {
      const w = await deployMixed()
      const [base, eth] = [w.at(3), w.at(2)]
      const { unit } = await dearEthereum(w)
      await (await w.pad.setSyncCap(2, 2n * FEE)).wait()
      await w.step(() => w.spawn(base, dev))
      const token = await w.lastToken()
      expect(await w.replicated(token)).to.deep.equal([3, 4, 5, 6])

      // Ethereum's gas price jumps fivefold between the quote and the hub
      const spike = 50n * FEE
      await (await w.endpoint.setDstFee(EID(2), spike - FEE)).wait()
      expect(await w.syncQuote(token, 2)).to.equal(spike)

      // unbounded, each open would take (spike − unit) out of the tank, for as long as anyone liked;
      // bounded, the SYNC is not sent
      let tank = await w.tank()
      await (await w.open(eth, alice, token)).wait()
      await expect(w.endpoint.deliverNext()).to.emit(w.pad, 'SyncFailed').withArgs(token, 2)
      expect((await w.tank()) - tank).to.equal(unit) // what the opener prepaid stays; nothing left the tank
      expect(await w.endpoint.pending()).to.equal(0n)
      expect(await w.replicated(token)).to.deep.equal([3, 4, 5, 6])
      // the same open, again and again: the tank only grows
      for (let i = 0; i < 3; i++) await w.step(() => w.open(eth, alice, token))

      // someone who wants it there NOW pays today's price, on the hub
      tank = await w.tank()
      await expect(w.pad.connect(stranger).resync(token, 2, { value: spike - 1n })).to.be.revertedWith('PAD: fee')
      await (await w.pad.connect(stranger).resync(token, 2, { value: spike })).wait()
      expect(await w.tank()).to.equal(tank)
      await w.deliverAll()
      expect(await w.replicated(token)).to.deep.equal([2, 3, 4, 5, 6])

      // the spike passes: an open goes through again
      await (await w.endpoint.setDstFee(EID(2), 9n * FEE)).wait()
      await w.step(() => w.spawn(base, dev, { name: 'NEXT', symbol: 'N' }))
      const next = await w.lastToken()
      await w.step(() => w.open(eth, alice, next))
      expect(await w.replicated(next)).to.deep.equal([2, 3, 4, 5, 6])
    })

    it('the launcher\'s OWN chain is a chain someone asked for: under a launch ceiling it is served up to the request ceiling', async () => {
      const w = await deployMixed()
      const eth = w.at(2)
      const { l1, unit } = await dearEthereum(w)
      // Ethereum is left out of every launch: its ceiling sits far below its ordinary price
      await (await w.pad.setSyncCap(2, 2n * FEE)).wait()
      await w.fund(eth, dev, 1_000)

      // …except a launch FROM Ethereum: its launcher prepaid at Ethereum's own price (five legs of
      // it: four SYNCs and the dev buy's DELIVER), and wants the token where they stand
      expect(await eth.gateway.quoteSpawn('HOME', 'HOME', '{}', true)).to.equal(FEE + 5n * unit)
      let tank = await w.tank()
      await w.step(() => w.spawn(eth, dev, { name: 'HOME', symbol: 'HOME', devBuy: 50 }))
      const home = await w.lastToken()
      expect(await w.replicated(home)).to.deep.equal([2, 3, 4, 5, 6])
      // the bag is in the launcher's wallet, not parked behind a missing replica
      expect(await (await w.replica(eth, home)).balanceOf(dev.address)).to.be.gt(0n)
      expect(await eth.gateway.pendingDelivery(home, dev.address)).to.equal(0n)
      // in: five dear legs; out: three cheap SYNCs, the dear SYNC, the dear DELIVER
      expect((await w.tank()) - tank).to.equal(5n * unit - 3n * FEE - 2n * l1)

      // a launch from anywhere else still skips Ethereum
      await w.step(() => w.spawn(w.at(6), dev, { name: 'AWAY', symbol: 'AWAY' }))
      expect(await w.replicated(await w.lastToken())).to.deep.equal([3, 4, 5, 6])

      // and the request ceiling holds for the launcher too: at a spike their own SYNC is not sent
      await (await w.endpoint.setDstFee(EID(2), 49n * FEE)).wait()
      tank = await w.tank()
      await (await w.spawn(eth, dev, { name: 'SPIKE', symbol: 'SPK' })).wait()
      const landed = await w.endpoint.deliverNext()
      await expect(landed).to.emit(w.pad, 'SyncFailed').withArgs(await w.lastToken(), 2)
      expect((await w.tank()) - tank).to.equal(4n * unit - 3n * FEE)
      await w.deliverAll()
      expect(await w.replicated(await w.lastToken())).to.deep.equal([3, 4, 5, 6])

      // with NO launch ceiling on a chain nothing is priced, the launcher's chain included: as before v7.2
      await (await w.pad.setSyncCap(2, 0)).wait()
      await (await w.pad.setRequestCap(2, 0)).wait()
      await w.step(() => w.spawn(eth, dev, { name: 'PLAIN', symbol: 'PLN' }), { tankMayFall: true })
      expect(await w.replicated(await w.lastToken())).to.deep.equal([2, 3, 4, 5, 6])
    })

    it('a ceiling that is not reached changes nothing; a leg that cannot even be priced is skipped like a dead one', async () => {
      const w = await deployMixed()
      const [base, opt] = [w.at(3), w.at(6)]
      // a ceiling on every remote chain, above the price: every chain is quoted, and served
      for (const c of w.chains) if (!c.local) await (await w.pad.setSyncCap(c.label, FEE)).wait()
      const tank = await w.tank()
      await w.step(() => w.spawn(opt, dev))
      expect(await w.replicated(await w.lastToken())).to.deep.equal([2, 3, 4, 5, 6])
      expect((await w.tank()) - tank).to.equal(4n * (UNIT - FEE))
      // one wei under the price: skipped
      await (await w.pad.setSyncCap(5, FEE - 1n)).wait()
      await w.step(() => w.spawn(opt, dev, { name: 'TWO', symbol: 'TWO' }))
      expect(await w.replicated(await w.lastToken())).to.deep.equal([2, 3, 4, 6])

      // a leg whose QUOTE reverts (no executor gas configured): SyncFailed, not a revert of the launch
      await (await w.pad.setSyncCap(5, FEE)).wait()
      await (await w.hubMessenger.setDestination(5, 0, 0)).wait()
      const rc = await w.step(() => w.spawn(base, dev, { name: 'THREE', symbol: 'THREE' }))
      const three = await w.lastToken()
      expect(events(rc, w.pad, 'SyncFailed').map((e) => Number(e.args.chain))).to.deep.equal([5])
      expect(await w.replicated(three)).to.deep.equal([2, 3, 4, 6])
      // a leg that can be priced but will not take the message: the same
      await (await w.hubMessenger.setDestination(5, GAS_TO_SPOKE, 0)).wait()
      await (await w.endpoint.setSendBlocked(EID(5), true)).wait()
      const rc2 = await w.step(() => w.spawn(base, dev, { name: 'FOUR', symbol: 'FOUR' }))
      expect(events(rc2, w.pad, 'SyncFailed').map((e) => Number(e.args.chain))).to.deep.equal([5])
      // the hub chain's own replica costs nothing: no ceiling can skip it
      await (await w.endpoint.setSendBlocked(EID(5), false)).wait()
      await (await w.pad.setSyncCap(HOME, 1n)).wait()
      await w.step(() => w.spawn(opt, dev, { name: 'FIVE', symbol: 'FIVE' }))
      expect(await w.replicated(await w.lastToken())).to.deep.equal([2, 3, 4, 5, 6])
    })

    it('no ceiling, no quote: a chain without one is not priced at all (the fan-out is what it was)', async () => {
      const w = await deployMixed()
      const opt = w.at(6)
      // a quote that would revert while the send goes through cannot exist on the adapter, so
      // count the quotes instead: with the ceiling the launch costs one staticcall more per chain
      await (await w.spawn(opt, dev)).wait()
      const plain = await peek(async () => {
        const rc = await (await w.endpoint.deliverNext()).wait()
        return events(rc, w.endpoint, 'PacketDelivered')[0].args.gasUsed
      })
      for (const c of w.chains) if (!c.local) await (await w.pad.setSyncCap(c.label, E(1))).wait()
      const quoted = await peek(async () => {
        const rc = await (await w.endpoint.deliverNext()).wait()
        return events(rc, w.endpoint, 'PacketDelivered')[0].args.gasUsed
      })
      // four more quotes (≥ 5k each through the adapter and the endpoint) — and nothing else changed
      expect(quoted - plain).to.be.gt(20_000n)
      expect(quoted - plain).to.be.lt(200_000n)
    })

    it('an open asks for what the hub knows: an id it never spawned is refused, a paused gateway does not open, the legs are the operator\'s', async () => {
      const w = await deployMixed()
      const [base, opt] = [w.at(3), w.at(6)]
      // a fresh gateway prepays ONE leg for an open, not none: on a remote chain "none" would be the hub tank's
      const fresh = await ethers.deployContract('SpawnGateway', [opt.messenger.target, opt.usd.target, 7, w.pad.target])
      expect(await fresh.openLegs()).to.equal(1n)
      expect(await opt.gateway.openLegs()).to.equal(1n)
      expect(await base.gateway.openLegs()).to.equal(0n) // set at deploy: at home the SYNC is a local call
      expect(await base.gateway.quoteOpen()).to.equal(0n)
      expect(await opt.gateway.quoteOpen()).to.equal(FEE + UNIT)
      await expect(opt.gateway.connect(stranger).setOpenLegs(0)).to.be.revertedWith('ROLES: not operator')
      await expect(opt.gateway.setOpenLegs(9)).to.be.revertedWith('GW: legs too high')
      await expect(opt.gateway.setOpenLegs(3)).to.emit(opt.gateway, 'OpenLegsSet').withArgs(3)
      expect(await opt.gateway.quoteOpen()).to.equal(FEE + 3n * UNIT)
      // the existing setter and its signature are untouched, and do not move the new count
      await (await opt.gateway.setLegs(1, 4)).wait()
      expect(await opt.gateway.openLegs()).to.equal(3n)
      await (await opt.gateway.setOpenLegs(1)).wait()

      // an id the hub never spawned: the message is consumed, refused, and nothing is sent back
      const tank = await w.tank()
      await (await w.open(opt, alice, stranger.address)).wait()
      await expect(w.endpoint.deliverNext())
        .to.emit(w.pad, 'Refused')
        .withArgs(6, 6, b32(stranger.address), ethers.ZeroHash, 0, 2)
      expect(await w.endpoint.pending()).to.equal(0n)
      expect((await w.tank()) - tank).to.equal(UNIT)

      // a paused gateway opens nothing (a new market on this chain is new exposure)
      await w.step(() => w.spawn(base, dev))
      await (await opt.gateway.pause()).wait()
      await expect(opt.gateway.connect(alice).openToken(stranger.address, { value: FEE + UNIT })).to.be.revertedWith('GW: paused')
      await (await opt.gateway.unpause()).wait()
      await w.check()
    })

    it('the hub chain\'s own gateway: an open is one free transaction, replica included', async () => {
      const w = await deployMixed({ homePool: false })
      const [base, opt] = [w.at(3), w.at(6)]
      // launched while the hub chain's gateway could not take its SYNC (no holder pool yet)
      const rc = await w.step(() => w.spawn(opt, dev))
      const token = await w.lastToken()
      expect(events(rc, w.pad, 'SyncFailed')).to.have.length(0) // (the hub spoke when the message landed, not here)
      expect(await w.replicated(token)).to.deep.equal([2, 4, 5, 6])
      await w.step(() => w.spawn(opt, dev, { name: 'SECOND', symbol: 'SND' }))
      const second = await w.lastToken()
      // while the cause lasts, an open fails like the SYNC did — logged, not reverted
      await expect(w.open(base, alice, token)).to.emit(w.pad, 'SyncFailed').withArgs(token, HOME)
      expect(await base.gateway.replicaOf(token)).to.equal(ethers.ZeroAddress)

      await base.wirePool()
      const sent = await w.endpoint.packetsSent()
      const tank = await w.tank()
      expect(await base.gateway.quoteOpen()).to.equal(0n)
      await expect(base.gateway.connect(alice).openToken(token)).to.emit(w.pad, 'Resynced').withArgs(token, HOME)
      expect(await base.gateway.replicaOf(token)).to.not.equal(ethers.ZeroAddress) // in that very transaction
      expect(await w.endpoint.packetsSent()).to.equal(sent) // and not one packet
      expect(await w.tank()).to.equal(tank)
      await expect(base.gateway.connect(alice).openToken(token)).to.be.revertedWith('GW: already open')
      // a resync toward the hub chain costs nothing to send, so a stranger owes nothing for it
      await expect(w.pad.connect(stranger).resync(second, HOME)).to.emit(w.pad, 'Resynced').withArgs(second, HOME)
      expect(await base.gateway.replicaOf(second)).to.not.equal(ethers.ZeroAddress)
      expect(await w.tank()).to.equal(tank)
      await pastGenesis()
      await w.fund(base, alice, 100)
      await w.step(() => w.buy(base, alice, token, 50))
      expect(await (await w.replica(base, token)).balanceOf(alice.address)).to.be.gt(0n)
    })

    it('the paid resync on the simulated transport: the flat fee, or the operator', async () => {
      const w = await deployWorld()
      const [base, arb] = [w.chains[2], w.chains[4]]
      await (await w.messenger.register(arb.gateway.target, 77)).wait() // Arbitrum's leg is dead
      await fundUsdc(base, dev, 100)
      await (await base.gateway.connect(dev).spawnTokenUsdc('GLOOP', 'GLP', '{}', 0, 0)).wait()
      const token = await w.pad.allTokens(0)
      await (await w.messenger.register(arb.gateway.target, 5)).wait()
      const flat = E('0.002')
      await (await w.messenger.setFlatFee(flat)).wait()
      await expect(w.pad.connect(stranger).resync(token, 5, { value: flat - 1n })).to.be.revertedWith('PAD: fee')
      await (await w.pad.connect(stranger).resync(token, 5, { value: flat })).wait()
      expect(await arb.gateway.replicaOf(token)).to.not.equal(ethers.ZeroAddress)
      expect(await bal(w.messenger)).to.equal(flat)
      await (await w.pad.resync(token, 5)).wait() // the operator (here the admin): no value
    })
  })

  /* ====================================================================== */
  /*  4 — a claim leaves a chain whose vault cannot pay it                   */
  /* ====================================================================== */

  describe('moveClaim: a claim leaves a chain whose vault cannot pay it', () => {
    /** A token launched on the hub chain, Bob holding a claim on BNB that its
     * vault cannot pay: he bought with USDT, the price rose on USDC bought
     * on Base, he sold — and BNB's vault holds less than his proceeds. */
    async function shortBnb() {
      const w = await deployMixed()
      const [base, bnb] = [w.at(3), w.at(4)]
      await w.step(() => w.spawn(base, dev))
      const token = await w.lastToken()
      await pastGenesis()
      await w.fund(bnb, bob, 300)
      await w.fund(base, carol, 3_000)
      await w.step(() => w.buy(bnb, bob, token, 300))
      await w.step(() => w.buy(base, carol, token, 3_000))
      const bag = await (await w.replica(bnb, token)).balanceOf(bob.address)
      await w.step(() => w.sell(bnb, bob, token, bag))
      const claim = await bnb.usd.balanceOf(bob.address)
      return { w, token, claim }
    }

    it('short vault on BNB → a claim → moved to Base: paid there in USDC; moved to a chain that is short too: a claim there, which moves on', async () => {
      const { w, claim } = await shortBnb()
      const [base, arb, bnb] = [w.at(3), w.at(5), w.at(4)]
      // Bob sold for more than BNB's vault holds: the whole payout is a claim, the 300 USDT are still there
      expect(claim).to.be.gt(E(600))
      expect(await bnb.dollar.balanceOf(bnb.usd.target)).to.equal(E(300))
      expect(await bnb.dollar.balanceOf(bob.address)).to.equal(0n)
      await expect(bnb.usd.connect(bob).unwrap(claim)).to.be.revertedWith('oUSD: vault short')
      // …while Base's vault holds Carol's 3,000 USDC: the universe is whole, this chain is not

      // what a move costs from BNB: the message, and the hub's leg to the destination
      const fee = await bnb.gateway.quoteMove(HOME)
      expect(fee).to.equal(FEE + UNIT)
      const half = claim / 2n
      await expect(bnb.gateway.connect(bob).moveClaim(HOME, b32(bob.address), half, { value: fee - 1n })).to.be.revertedWith('LZM: fee')

      // ── to Base: Base's vault pays
      let tank = await w.tank()
      const move = await bnb.gateway.connect(bob).moveClaim(HOME, b32(bob.address), half, { value: fee })
      await expect(move).to.emit(bnb.gateway, 'ClaimMoved').withArgs(bob.address, HOME, b32(bob.address), half)
      expect(await bnb.usd.balanceOf(bob.address)).to.equal(claim - half) // burned here…
      expect(unpack(await w.endpoint.peek(0))).to.deep.equal({
        op: 7,
        data: coder.encode(['bytes32', 'bytes32', 'uint256', 'uint32'], [b32(bob.address), b32(bob.address), half, HOME]),
      })
      // …and in flight: the only moment the two sides differ, by exactly that claim
      let b = await w.backing()
      expect(b.held - b.supply).to.equal(half)
      const books = await w.hubUsd.totalSupply()
      await expect(w.endpoint.deliverNext())
        .to.emit(w.pad, 'Moved')
        .withArgs(4, HOME, b32(bob.address), b32(bob.address), half, true)
      expect(await w.hubUsd.totalSupply()).to.equal(books) // the hub's own books never saw it
      expect(await w.endpoint.pending()).to.equal(0n) // the leg to Base is a local call
      expect((await w.tank()) - tank).to.equal(UNIT) // …so the prepaid leg is the tank's
      expect(await base.dollar.balanceOf(bob.address)).to.equal(half / base.SCALE) // USDC, in Bob's wallet on Base
      expect(await base.usd.balanceOf(bob.address)).to.equal(half % base.SCALE) // and the sub-unit dust as a claim
      await w.check()

      // ── to Arbitrum, whose vault is empty: the claim simply lives there now
      const rest = claim - half
      tank = await w.tank()
      await w.step(() => w.move(bnb, bob, 5, b32(bob.address), rest))
      expect((await w.tank()) - tank).to.equal(UNIT - FEE)
      expect(await bnb.usd.balanceOf(bob.address)).to.equal(0n)
      expect(await arb.dollar.balanceOf(bob.address)).to.equal(0n)
      expect(await arb.usd.balanceOf(bob.address)).to.equal(rest)
      await expect(arb.usd.connect(bob).unwrap(rest)).to.be.revertedWith('oUSD: vault short')
      // …and moves on from there, to where the dollars are
      const usdc = await base.dollar.balanceOf(bob.address)
      await w.step(() => w.move(arb, bob, HOME, b32(bob.address), rest))
      expect(await arb.usd.balanceOf(bob.address)).to.equal(0n)
      expect((await base.dollar.balanceOf(bob.address)) - usdc).to.equal(rest / base.SCALE)

      // Bob put in 300 USDT and took his whole proceeds out in USDC; BNB's 300 USDT now back claims elsewhere
      expect(await bnb.usd.totalSupply()).to.equal(0n)
      expect(await bnb.dollar.balanceOf(bnb.usd.target)).to.equal(E(300))
      b = await w.backing()
      expect(b.held).to.equal(b.supply)
    })

    it('the reverse: a claim on a USDC chain is paid on BNB in USDT — and a claim can be sent to somebody else', async () => {
      const w = await deployMixed()
      const [base, opt, bnb] = [w.at(3), w.at(6), w.at(4)]
      // BNB's vault is liquid (a buyer's 500 USDT), Alice holds a claim on Optimism
      await w.step(() => w.spawn(base, dev))
      const token = await w.lastToken()
      await pastGenesis()
      await w.fund(bnb, bob, 500)
      await w.step(() => w.buy(bnb, bob, token, 500))
      await w.claim(opt, alice, 80)
      const amount = E(80) - 7n // an odd amount: 18 decimals on the other side take every wei
      await w.step(() => w.move(opt, alice, 4, b32(carol.address), amount))
      expect(await bnb.dollar.balanceOf(carol.address)).to.equal(amount)
      expect(await bnb.usd.balanceOf(carol.address)).to.equal(0n)
      expect(await opt.usd.balanceOf(alice.address)).to.equal(7n)
    })

    it('a move never costs the tank — from every chain to every other, the hub chain\'s own gateway included', async () => {
      const w = await deployMixed()
      const base = w.at(3)
      // trades on the hub chain are free of messaging fees; a move from it is not: its reply goes to another chain
      expect(await base.gateway.tradeLegs()).to.equal(0n)
      expect(await base.gateway.quoteSell()).to.equal(0n)
      for (const d of w.chains) if (!d.local) expect(await base.gateway.quoteMove(d.label)).to.equal(UNIT)
      await w.claim(base, carol, 10)
      await expect(base.gateway.connect(carol).moveClaim(6, b32(carol.address), E(10), { value: UNIT - 1n })).to.be.revertedWith('LZM: fee')
      await expect(base.gateway.connect(carol).moveClaim(6, b32(carol.address), E(10))).to.be.revertedWith('LZM: fee')
      expect(await base.usd.balanceOf(carol.address)).to.equal(E(10)) // nothing burned, nothing sent
      expect(await w.endpoint.pending()).to.equal(0n)

      for (const s of w.chains) {
        for (const d of w.chains) {
          if (s.label === d.label) continue
          await w.claim(s, alice, 10)
          const tank = await w.tank()
          const before = await w.worth(d, bob)
          const rc = await w.step(() => w.move(s, alice, d.label, b32(bob.address), E(10)))
          // the dollars stay in the mover's vault; the recipient is paid by the destination's if it
          // holds any (it does once it has been a source), and holds a claim there if not
          expect((await w.worth(d, bob)) - before, `${s.id} → ${d.id}`).to.equal(E(10))
          expect(await s.usd.balanceOf(alice.address)).to.equal(0n)
          // in: one prepaid leg; out: one message to a remote destination, none to the hub chain's own
          const expected = UNIT - (d.local ? 0n : FEE)
          expect((await w.tank()) - tank, `${s.id} → ${d.id}`).to.equal(expected)
          if (s.local) expect(events(rc, w.pad, 'Moved')[0].args.forwarded).to.equal(true)
        }
      }
      // 20 moves later, every claim sits where it was sent, backed by dollars that never left a vault
      // except to pay one (Carol's 10 on Base never moved at all)
      const b = await w.backing()
      expect(b.held).to.equal(b.supply)
      let claims = 0n
      for (const c of w.chains) claims += await w.worth(c, bob)
      expect(claims).to.equal(E(200))
    })

    it('a destination has a price or it is closed; the price is the operator\'s; a dear destination costs what it costs', async () => {
      const w = await deployMixed()
      const [base, opt] = [w.at(3), w.at(6)]
      await w.claim(opt, alice, 50)
      await w.claim(base, alice, 50)
      const fresh = await ethers.deployContract('SpawnGateway', [opt.messenger.target, opt.usd.target, 7, w.pad.target])
      expect(await fresh.moveLegs(HOME)).to.equal(0n) // nothing is open until it is priced

      await expect(opt.gateway.connect(stranger).setMoveLegs(5, 0)).to.be.revertedWith('ROLES: not operator')
      await expect(opt.gateway.setMoveLegs(5, 4097)).to.be.revertedWith('GW: legs too high')
      await expect(opt.gateway.setMoveLegs(5, 0)).to.emit(opt.gateway, 'MoveLegsSet').withArgs(5, 0)
      await expect(opt.gateway.quoteMove(5)).to.be.revertedWith('GW: route closed')
      await expect(opt.gateway.connect(alice).moveClaim(5, b32(alice.address), E(10), { value: E(1) })).to.be.revertedWith('GW: route closed')
      await expect(opt.gateway.connect(alice).moveClaim(9, b32(alice.address), E(10), { value: E(1) })).to.be.revertedWith('GW: route closed')
      expect(await opt.usd.balanceOf(alice.address)).to.equal(E(50)) // nothing burned

      // what a gateway refuses by itself, whatever the operator priced
      await (await opt.gateway.setMoveLegs(6, 1)).wait()
      await (await opt.gateway.setMoveLegs(0, 1)).wait()
      const bad = (dst, to, amount) => opt.gateway.connect(alice).moveClaim(dst, to, amount, { value: E(1) })
      await expect(bad(6, b32(alice.address), E(10))).to.be.revertedWith('GW: bad destination') // its own chain
      await expect(bad(0, b32(alice.address), E(10))).to.be.revertedWith('GW: bad destination') // the hub's label
      await expect(bad(HOME, ethers.ZeroHash, E(10))).to.be.revertedWith('GW: bad destination') // nobody
      await expect(bad(HOME, b32(alice.address), 10n ** 12n - 1n)).to.be.revertedWith('GW: dust')
      await expect(bad(HOME, b32(alice.address), E(51))).to.be.reverted // more than she holds
      expect(await opt.usd.balanceOf(alice.address)).to.equal(E(50))
      expect(await w.endpoint.pending()).to.equal(0n)

      // a dear destination: ten of this chain's units from an L2 — and from the hub chain's own gateway
      const { l1, unit } = await dearEthereum(w)
      expect(await opt.gateway.moveLegs(2)).to.equal(10n)
      expect(await opt.gateway.quoteMove(2)).to.equal(FEE + unit)
      expect(await base.gateway.quoteMove(2)).to.equal(unit)
      for (const s of [opt, base]) {
        const tank = await w.tank()
        await w.step(() => w.move(s, alice, 2, b32(alice.address), E(20)))
        expect((await w.tank()) - tank).to.equal(unit - l1)
        expect(await w.at(2).usd.balanceOf(alice.address)).to.equal(s === opt ? E(20) : E(40))
      }
      // never fewer legs than a trade prepays: the way home must be paid for too
      await (await opt.gateway.setLegs(3, 4)).wait()
      expect(await opt.gateway.quoteMove(HOME)).to.equal(FEE + 3n * UNIT)
      await w.check()
    })
  })

  /* ====================================================================== */
  /*  A move the hub cannot hand on comes home                               */
  /* ====================================================================== */

  describe('a move the hub cannot hand on comes home — never into the void', () => {
    /** Alice holds 100 dollars of claim on BNB; its vault holds the 100 USDT. */
    async function holder() {
      const w = await deployMixed()
      const bnb = w.at(4)
      await w.claim(bnb, alice, 100)
      return { w, bnb }
    }
    /** Sends a move from `s` and returns what the hub said about it. */
    async function moved(w, s, dst, to, amount) {
      const worth = await w.worth(s, alice)
      const rc = await w.step(() => w.move(s, alice, dst, to, amount))
      let ev = events(rc, w.pad, 'Moved')[0]
      if (!ev) {
        // a remote source: the hub spoke when the message landed
        const logs = await w.pad.queryFilter(w.pad.filters.Moved(), rc.blockNumber)
        ev = logs[logs.length - 1]
      }
      expect(ev.args.amount).to.equal(amount)
      expect(ev.args.to).to.equal(to)
      expect(Number(ev.args.dstChain)).to.equal(dst)
      return { forwarded: ev.args.forwarded, delta: (await w.worth(s, alice)) - worth }
    }

    it('to a chain the hub has no gateway for', async () => {
      const { w, bnb } = await holder()
      // the gateway refuses a destination nobody priced — so this takes an operator's mistake
      await expect(bnb.gateway.connect(alice).moveClaim(9, b32(alice.address), E(40), { value: E(1) })).to.be.revertedWith('GW: route closed')
      await (await bnb.gateway.setMoveLegs(9, 1)).wait()
      await (await w.pad.setRequestCap(9, E(1))).wait()
      const usdt = await bnb.dollar.balanceOf(alice.address)
      const r = await moved(w, bnb, 9, b32(alice.address), E(40))
      expect(r.forwarded).to.equal(false)
      expect(r.delta).to.equal(0n) // whole
      // BNB's vault holds the dollars, so what came home is USDT rather than the claim
      expect((await bnb.dollar.balanceOf(alice.address)) - usdt).to.equal(E(40))
      expect(await bnb.usd.balanceOf(alice.address)).to.equal(E(60))

      // The variant that matters: a chain being ADDED. The hub's adapter already has its route,
      // the pad does not know its gateway yet (it waits in the timelock). A payout forwarded there
      // would be addressed to nobody on that chain, for good — so it is not forwarded.
      await (await w.hubMessenger.setRoute(9, EID(9), '0x' + 'd9'.repeat(32))).wait()
      await (await w.hubMessenger.setDestination(9, GAS_TO_SPOKE, 0)).wait()
      const r2 = await moved(w, bnb, 9, b32(alice.address), E(40))
      expect(r2.forwarded).to.equal(false)
      expect(r2.delta).to.equal(0n)
      expect(await w.endpoint.pending()).to.equal(0n)
    })

    it('to an EVM chain, for a recipient that is not an address — a remote one, and the hub chain\'s own', async () => {
      const { w, bnb } = await holder()
      for (const dst of [6, HOME]) {
        const r = await moved(w, bnb, dst, WIDE, E(10))
        expect(r.forwarded, `to ${dst}`).to.equal(false)
        expect(r.delta).to.equal(0n)
      }
      // (the same recipient, left-padded to an address, is paid)
      const r = await moved(w, bnb, 6, b32(bob.address), E(10))
      expect(r.forwarded).to.equal(true)
      expect(await w.at(6).usd.balanceOf(bob.address)).to.equal(E(10))
    })

    it('to a chain whose leg fails: it cannot be priced, it will not take the message, or it costs more than its ceiling', async () => {
      const { w, bnb } = await holder()
      const arb = w.at(5)
      const breaks = [
        ['no executor gas: the quote reverts', () => w.hubMessenger.setDestination(5, 0, 0), () => w.hubMessenger.setDestination(5, GAS_TO_SPOKE, 0)],
        ['the send reverts', () => w.endpoint.setSendBlocked(EID(5), true), () => w.endpoint.setSendBlocked(EID(5), false)],
        ['twice the price a move prepays', () => w.endpoint.setDstFee(EID(5), FEE), () => w.endpoint.setDstFee(EID(5), 0)],
        ['a ceiling of nothing', () => w.pad.setRequestCap(5, 0), () => w.pad.setRequestCap(5, UNIT)],
        // (the ceiling is inclusive: at exactly the price the move goes — see the end of this test)
        ['a ceiling one wei under the price', () => w.pad.setRequestCap(5, FEE - 1n), () => w.pad.setRequestCap(5, FEE)],
      ]
      for (const [what, breakIt, repair] of breaks) {
        await (await breakIt()).wait()
        const tank = await w.tank()
        const r = await moved(w, bnb, 5, b32(alice.address), E(10))
        expect(r.forwarded, what).to.equal(false)
        expect(r.delta, what).to.equal(0n)
        expect(await arb.usd.balanceOf(alice.address), what).to.equal(0n)
        // the mover prepaid a leg; the hub spent it on the way home
        expect((await w.tank()) - tank, what).to.equal(UNIT - FEE)
        await (await repair()).wait()
      }
      const r = await moved(w, bnb, 5, b32(alice.address), E(10))
      expect(r.forwarded).to.equal(true)
      expect(await arb.usd.balanceOf(alice.address)).to.equal(E(10))
    })

    it('home is where the claim was: a short vault gets the claim back, not dollars — and the way home is never skipped', async () => {
      const w = await deployMixed()
      const [arb, opt] = [w.at(5), w.at(6)]
      // Alice holds a claim on Arbitrum whose vault is EMPTY (it was paid to her from another chain)
      await w.claim(opt, alice, 30)
      await w.step(() => w.move(opt, alice, 5, b32(alice.address), E(30)))
      expect(await arb.usd.balanceOf(alice.address)).to.equal(E(30))
      expect(await arb.dollar.balanceOf(arb.usd.target)).to.equal(0n)
      // she sends it to a recipient Optimism cannot pay: it comes back to Arbitrum as the same claim
      await w.step(() => w.move(arb, alice, 6, WIDE, E(30)))
      expect(await arb.usd.balanceOf(alice.address)).to.equal(E(30))

      // if the hub cannot send it home either, the message is not consumed: LayerZero keeps it
      await (await w.hubMessenger.setDestination(5, 0, 0)).wait()
      await (await w.move(arb, alice, 6, WIDE, E(30))).wait()
      expect(await arb.usd.balanceOf(alice.address)).to.equal(0n)
      await expect(w.endpoint.deliverNext()).to.be.revertedWith('LZM: no gas limit')
      expect(await w.endpoint.pending()).to.equal(1n)
      await (await w.hubMessenger.setDestination(5, GAS_TO_SPOKE, 0)).wait()
      await w.deliverAll()
      expect(await arb.usd.balanceOf(alice.address)).to.equal(E(30))
      await w.check()
    })

    it('from the hub chain\'s own gateway everything happens in the mover\'s transaction', async () => {
      const w = await deployMixed()
      const base = w.at(3)
      await w.claim(base, alice, 100)
      const usdc = await base.dollar.balanceOf(alice.address)
      const sent = await w.endpoint.packetsSent()

      // a wide recipient on an EVM chain: back before the transaction ends, as USDC (Base's vault is liquid)
      const tx = await w.move(base, alice, 6, WIDE, E(25))
      await expect(tx).to.emit(w.pad, 'Moved').withArgs(HOME, 6, b32(alice.address), WIDE, E(25), false)
      expect(await base.usd.balanceOf(alice.address)).to.equal(E(75))
      expect((await base.dollar.balanceOf(alice.address)) - usdc).to.equal(U(25))
      expect(await w.endpoint.packetsSent()).to.equal(sent)

      // a leg that fails: the same, in one transaction
      await (await w.endpoint.setSendBlocked(EID(5), true)).wait()
      await expect(w.move(base, alice, 5, b32(alice.address), E(25)))
        .to.emit(w.pad, 'Moved')
        .withArgs(HOME, 5, b32(alice.address), b32(alice.address), E(25), false)
      expect((await base.dollar.balanceOf(alice.address)) - usdc).to.equal(U(50))
      expect(await w.endpoint.packetsSent()).to.equal(sent)
      await w.check()
    })

    it('defence in depth on the hub: a gateway that named nobody, or its own chain, strands nothing', async () => {
      const { w, bnb } = await holder()
      // what a faulty gateway could send (the real one refuses both at entry): speak as BNB's
      // gateway through the hub's adapter, after burning the claim as it would have
      const agent = await as(bnb.gateway.target)
      const messenger = await as(w.hubMessenger.target)
      const worth = await w.worth(bnb, alice)

      await (await bnb.usd.connect(agent).bridgeBurn(alice.address, E(10))).wait()
      await expect(w.pad.connect(messenger).onOmniMessage(4, b32(bnb.gateway.target), moveOf(b32(alice.address), ethers.ZeroHash, E(10), 6)))
        .to.emit(w.pad, 'Moved')
        .withArgs(4, 6, b32(alice.address), ethers.ZeroHash, E(10), false)
      await w.deliverAll()
      expect(await w.worth(bnb, alice)).to.equal(worth)

      // its own chain as destination is just a payout there
      await (await bnb.usd.connect(agent).bridgeBurn(alice.address, E(10))).wait()
      await (await w.pad.connect(messenger).onOmniMessage(4, b32(bnb.gateway.target), moveOf(b32(alice.address), b32(alice.address), E(10), 4))).wait()
      await w.deliverAll()
      expect(await w.worth(bnb, alice)).to.equal(worth)
      await w.check()

      // and none of it is for anyone but a gateway to say
      const forged = moveOf(b32(stranger.address), b32(stranger.address), E(1_000_000), HOME)
      await expect(w.pad.connect(messenger).onOmniMessage(4, b32(stranger.address), forged)).to.be.revertedWith('PAD: not a gateway')
      await expect(w.pad.connect(messenger).onOmniMessage(9, b32(bnb.gateway.target), forged)).to.be.revertedWith('PAD: not a gateway')
      await expect(w.pad.connect(stranger).onOmniMessage(4, b32(bnb.gateway.target), forged)).to.be.revertedWith('PAD: not messenger')
    })

    it('a dollar token with a transfer hook on the hub chain: what it re-enters while an incoming move is being paid cannot touch the books', async () => {
      // An incoming move is the first case where a message from ANOTHER chain makes the hub chain's
      // gateway pay someone in the same transaction — with none of its own guards on the stack.
      const w = await deployMixed({ homeDollar: 'ReentrantDollar' })
      const [base, bnb] = [w.at(3), w.at(4)]
      await w.step(() => w.spawn(base, dev))
      const token = await w.lastToken()
      await w.claim(base, carol, 1_000) // Base's vault is liquid: the move is PAID, so the token's hook runs
      await w.claim(bnb, alice, 500)
      // the hook's caller is the dollar contract: give it a claim of its own to play with
      await (await base.usd.connect(carol).transfer(base.dollar.target, E(100))).wait()
      const gw = base.gateway.interface
      const forged = op(12, ['bytes32', 'uint256'], [b32(stranger.address), E(1_000)])
      const attempts = [
        ['a forged payout, straight to the gateway', base.gateway.target, gw.encodeFunctionData('onOmniMessage', [0, b32(w.pad.target), forged]), false],
        ['a forged move, straight to the pad', w.pad.target, w.pad.interface.encodeFunctionData('onOmniMessage', [HOME, b32(base.gateway.target), moveOf(b32(stranger.address), b32(stranger.address), E(1_000), 6)]), false],
        ['unwrap on the vault that is paying', base.usd.target, base.usd.interface.encodeFunctionData('unwrap', [E(1)]), false],
        ['wrap on the vault that is paying', base.usd.target, base.usd.interface.encodeFunctionData('wrap', [U(1)]), false],
        ['a sell (its payout needs the vault that is paying)', base.gateway.target, gw.encodeFunctionData('sellToken', [token, E(1)]), false],
        ['a move of its own claim, unpaid', base.gateway.target, gw.encodeFunctionData('moveClaim', [6, b32(stranger.address), E(50)]), false],
        // what does get through is what anyone may do at any time
        ['a resync toward the hub chain (free, and anyone\'s)', w.pad.target, w.pad.interface.encodeFunctionData('resync', [token, HOME]), true],
        ['a buy with its own claim', base.gateway.target, gw.encodeFunctionData('buyToken', [token, E(10)]), true],
      ]
      await pastGenesis()
      for (const [what, target, data, goesThrough] of attempts) {
        await (await base.dollar.arm(target, data, 0)).wait()
        const usdc = await base.dollar.balanceOf(bob.address)
        await w.step(() => w.move(bnb, alice, HOME, b32(bob.address), E(20)))
        expect(await base.dollar.fired(), what).to.equal(true)
        expect(await base.dollar.ok(), what).to.equal(goesThrough)
        // the move itself was paid, whatever the hook did
        expect((await base.dollar.balanceOf(bob.address)) - usdc, what).to.equal(U(20))
      }
      expect(await base.dollar.balanceOf(stranger.address)).to.equal(0n)
      expect(await base.usd.balanceOf(stranger.address)).to.equal(0n)
      expect(await w.at(6).usd.balanceOf(stranger.address)).to.equal(0n)
      // the hook's own buy was a buy like any other
      expect(await (await w.replica(base, token)).balanceOf(base.dollar.target)).to.be.gt(0n)
    })

    it('a destination that is not an EVM chain takes a wide recipient as it is', async () => {
      const { w, bnb } = await holder()
      // a gateway whose id is a 32-byte key (a Solana OApp store), reached over a route of its own
      const STORE = '0x' + 'c1'.repeat(32)
      const PEER = '0x' + 'c2'.repeat(32)
      await (await w.hubMessenger.setRoute(1, EID(1), PEER)).wait()
      await (await w.hubMessenger.setDestination(1, 200_000, 0)).wait()
      await (await w.pad.setGateway(1, STORE)).wait()
      await (await w.pad.setRequestCap(1, UNIT)).wait()
      await (await bnb.gateway.setMoveLegs(1, 1)).wait()

      await (await w.move(bnb, alice, 1, WIDE, E(15))).wait()
      await expect(w.endpoint.deliverNext())
        .to.emit(w.pad, 'Moved')
        .withArgs(4, 1, b32(alice.address), WIDE, E(15), true)
      // the PAYOUT is on the wire toward that chain, recipient untouched
      const pkt = await w.endpoint.peek(0)
      expect(pkt.dstEid).to.equal(BigInt(EID(1)))
      expect(pkt.receiver).to.equal(PEER)
      const [src, dst] = coder.decode(['bytes32', 'bytes32', 'bytes'], pkt.message)
      expect([src, dst]).to.deep.equal([b32(w.pad.target), STORE])
      expect(unpack(pkt)).to.deep.equal({ op: 12, data: coder.encode(['bytes32', 'uint256'], [WIDE, E(15)]) })
      // in flight to a chain this test has no program on: the two sides differ by exactly that
      const b = await w.backing()
      expect(b.held - b.supply).to.equal(E(15))
      // an address-shaped recipient is forwarded there too: it is that chain's business what a key is
      await (await w.move(bnb, alice, 1, b32(alice.address), E(15))).wait()
      await expect(w.endpoint.deliverAt(1)).to.emit(w.pad, 'Moved').withArgs(4, 1, b32(alice.address), b32(alice.address), E(15), true)
    })
  })

  /* ====================================================================== */
  /*  Pauses                                                                 */
  /* ====================================================================== */

  describe('a paused hub still opens tokens, resyncs them and moves claims; a paused gateway still lets a claim leave', () => {
    it('OP_OPEN, OP_MOVE and resync run through a paused pad — while a buy bounces and a launch is refused', async () => {
      const w = await deployMixed()
      const [base, opt, eth, bnb] = [w.at(3), w.at(6), w.at(2), w.at(4)]
      await (await w.pad.setSyncCap(2, 1n)).wait() // Ethereum is left out of every launch
      await w.step(() => w.spawn(base, dev, { name: 'ONE', symbol: 'ONE' }))
      const one = await w.lastToken()
      await w.step(() => w.spawn(base, dev, { name: 'TWO', symbol: 'TWO' }))
      const two = await w.lastToken()
      await pastGenesis()
      await w.claim(bnb, alice, 100)
      await w.fund(opt, bob, 100)

      await (await w.pad.setGuardian(guardian.address)).wait()
      await (await w.pad.connect(guardian).pause()).wait()
      // the pause is on: a buy comes back whole, a launch is refused
      const usdc = await opt.dollar.balanceOf(bob.address)
      await (await w.buy(opt, bob, one, 50)).wait()
      await expect(w.endpoint.deliverNext()).to.emit(w.pad, 'Refused').withArgs(2, 6, b32(one), b32(bob.address), E(50), 1)
      await w.deliverAll()
      expect(await opt.dollar.balanceOf(bob.address)).to.equal(usdc)
      await w.step(() => w.spawn(base, dev, { name: 'NO', symbol: 'NO' }))
      expect(await w.pad.tokensLength()).to.equal(2n)

      // an open: the replica is created
      await w.step(() => w.open(eth, alice, one))
      expect(await w.replicated(one)).to.deep.equal([2, 3, 4, 5, 6])
      // a paid resync, by a stranger; and the operator's
      await w.step(async () => w.pad.connect(stranger).resync(two, 2, { value: await w.syncQuote(two, 2) }))
      expect(await w.replicated(two)).to.deep.equal([2, 3, 4, 5, 6])
      await w.step(() => w.pad.resync(two, 2), { tankMayFall: true })
      // a move: the claim leaves BNB and lands on Optimism
      await w.step(() => w.move(bnb, alice, 6, b32(alice.address), E(60)))
      expect(await opt.usd.balanceOf(alice.address)).to.equal(E(60))
      expect(await bnb.usd.balanceOf(alice.address)).to.equal(E(40))
      // …and one that cannot be handed on still comes home
      await w.step(() => w.move(bnb, alice, 6, WIDE, E(40)))
      expect(await w.worth(bnb, alice)).to.equal(E(40))
      expect(await w.pad.paused()).to.equal(true)
    })

    it('a paused gateway: no open (new exposure), but a claim still leaves (an exit)', async () => {
      const w = await deployMixed()
      const [base, bnb] = [w.at(3), w.at(4)]
      await w.claim(bnb, alice, 50)
      await (await bnb.gateway.pause()).wait()
      await (await bnb.usd.pauseDeposits()).wait()
      await expect(w.open(bnb, alice, stranger.address)).to.be.revertedWith('GW: paused')
      await w.step(() => w.move(bnb, alice, HOME, b32(alice.address), E(50)))
      expect(await base.usd.balanceOf(alice.address)).to.equal(E(50)) // Base's vault is empty here: a claim there
      // and a paused DESTINATION still takes it (a payout has no switch)
      await (await base.gateway.pause()).wait()
      await w.claim(w.at(6), alice, 20)
      await w.step(() => w.move(w.at(6), alice, HOME, b32(alice.address), E(20)))
      expect(await base.usd.balanceOf(alice.address)).to.equal(E(70))
    })
  })

  /* ====================================================================== */
  /*  Gas                                                                    */
  /* ====================================================================== */

  describe('gas cannot choose the outcome', () => {
    const SYNC_FAILED = ethers.id('SyncFailed(address,uint32)')

    it('whatever gas a spawn is delivered with, it reverts or it SYNCs every chain that is under its ceiling', async () => {
      const w = await deployMixed()
      const opt = w.at(6)
      // A quote that costs what a real one does (the mock's is nearly free): only then is there
      // a gas at which the QUOTE runs dry and enough is left to finish the launch without it.
      await (await w.endpoint.setQuoteWork(300_000)).wait()
      // The ceiling sits on the LAST chain of the fan-out: after its SYNC only an event remains
      // (no dev buy), so that is where a starved call could pass for a refusal.
      expect(await w.pad.chainLabels((await w.pad.chainsLength()) - 1n)).to.equal(4n)
      await (await w.pad.setSyncCap(4, 2n * FEE)).wait()
      await (await w.spawn(opt, dev)).wait()
      expect(await w.endpoint.pending()).to.equal(1n)

      /** Delivers the SPAWN with `gas`: 'reverted', or the number of SYNCs skipped. */
      const tryWith = (gas) =>
        peek(async () => {
          let rc
          try {
            rc = await (await w.endpoint.deliverAtWithGas(0, gas, { gasLimit: 15_000_000 })).wait()
          } catch {
            return 'reverted'
          }
          expect(await w.pad.tokensLength()).to.equal(1n)
          return rc.logs.filter((l) => l.address === w.pad.target && l.topics[0] === SYNC_FAILED).length
        })

      let lo = 200_000
      let hi = 12_000_000
      expect(await tryWith(hi)).to.equal(0)
      expect(await tryWith(lo)).to.equal('reverted')
      while (hi - lo > 2_000) {
        const mid = Math.floor((lo + hi) / 2)
        if ((await tryWith(mid)) === 'reverted') lo = mid
        else hi = mid
      }
      // sweep densely below the threshold — first where the last SEND would starve, then, some
      // 0.8M lower, where its QUOTE would — and around it
      const outcomes = new Set()
      for (let gas = hi - 1_500_000; gas <= hi + 60_000; gas += 9_500) {
        const r = await tryWith(gas)
        outcomes.add(r)
        expect(r === 'reverted' || r === 0, `gas ${gas}: delivered with ${r} SYNC(s) skipped`).to.equal(true)
      }
      expect([...outcomes].sort()).to.deep.equal([0, 'reverted'])
    })

    it('whatever gas a move or an open is delivered with, it reverts or it is handed on — never turned back, never left closed', async () => {
      const w = await deployMixed()
      const [base, opt, bnb] = [w.at(3), w.at(6), w.at(4)]
      await (await w.pad.setSyncCap(6, 1n)).wait()
      await w.step(() => w.spawn(base, dev))
      const token = await w.lastToken()
      await w.claim(bnb, alice, 100)

      const sweep = async (label, outcomeOf, below = 500_000) => {
        const tryWith = (gas) =>
          peek(async () => {
            let rc
            try {
              rc = await (await w.endpoint.deliverAtWithGas(0, gas, { gasLimit: 15_000_000 })).wait()
            } catch {
              return 'reverted'
            }
            return outcomeOf(rc)
          })
        let lo = 30_000
        let hi = 4_000_000
        expect(await tryWith(hi), label).to.equal('done')
        expect(await tryWith(lo), label).to.equal('reverted')
        while (hi - lo > 1_000) {
          const mid = Math.floor((lo + hi) / 2)
          if ((await tryWith(mid)) === 'reverted') lo = mid
          else hi = mid
        }
        const outcomes = new Set()
        for (let gas = Math.max(30_000, hi - below); gas <= hi + 40_000; gas += 9_400) {
          const r = await tryWith(gas)
          outcomes.add(r)
          expect(r === 'reverted' || r === 'done', `${label}, gas ${gas}: ${r}`).to.equal(true)
        }
        expect([...outcomes].sort()).to.deep.equal(['done', 'reverted'])
      }

      // a move to a REMOTE chain (a quote, then a LayerZero send)
      await (await w.move(bnb, alice, 6, b32(alice.address), E(10))).wait()
      await sweep('move to a remote chain', (rc) => (events(rc, w.pad, 'Moved')[0].args.forwarded ? 'done' : 'turned back'))
      await w.deliverAll()
      // a move to the hub chain's own gateway (a quote, then the payout itself, by loopback)
      await (await w.move(bnb, alice, HOME, b32(alice.address), E(10))).wait()
      await sweep('move to the hub chain', (rc) => (events(rc, w.pad, 'Moved')[0].args.forwarded ? 'done' : 'turned back'))
      await w.deliverAll()
      // an open, with a quote that costs what a real one does: after a failed quote only an event
      // remains to be emitted, so a starved quote must not pass for a ceiling
      await (await w.endpoint.setQuoteWork(300_000)).wait()
      await (await w.open(opt, alice, token)).wait()
      await sweep('open', (rc) => (events(rc, w.pad, 'Resynced').length === 1 ? 'done' : 'left closed'), 1_400_000)
    })

    it('every new op lands inside the executor gas it was sold; the worst-case spawn with four remote chains, with and without a ceiling', async () => {
      const w = await deployMixed()
      const [base, opt, eth, bnb] = [w.at(3), w.at(6), w.at(2), w.at(4)]
      const used = {}
      const gasOf = async (label) => {
        const code = unpack(await w.endpoint.peek(0)).op
        const rc = await (await w.endpoint.deliverNext()).wait()
        const gas = events(rc, w.endpoint, 'PacketDelivered')[0].args.gasUsed
        used[label ?? code] = gas
        return gas
      }
      // the largest spawn a gateway admits: 64 + 16 + 1024 bytes of strings, and a dev buy
      const big = { name: 'N'.repeat(64), symbol: 'S'.repeat(16), meta: 'm'.repeat(1024), devBuy: 50 }
      await w.fund(opt, dev, 1_000)
      await (await w.spawn(opt, dev, big)).wait()
      // the same queued SPAWN, delivered under four configurations of the hub
      const worst = (label, setup) =>
        peek(async () => {
          await setup()
          return gasOf(label)
        })
      const none = await worst('SPAWN, no ceiling', async () => {})
      const under = await worst('SPAWN, a ceiling on one chain, under it', async () => {
        await (await w.pad.setSyncCap(2, 2n * FEE)).wait()
      })
      const over = await worst('SPAWN, a ceiling on one chain, over it (skipped)', async () => {
        await (await w.pad.setSyncCap(2, 1n)).wait()
      })
      const all = await worst('SPAWN, a ceiling on all four, under them', async () => {
        for (const c of w.chains) if (!c.local) await (await w.pad.setSyncCap(c.label, 2n * FEE)).wait()
      })
      await w.deliverAll()
      // a ceiling costs one quote; a skipped chain saves one send
      expect(under).to.be.gt(none)
      expect(under - none).to.be.lt(60_000n)
      expect(over).to.be.lt(none)
      expect(all).to.be.lt(MOCK_GAS_TO_HUB)
      expect(all - none).to.be.lt(240_000n)

      // the new ops
      await (await w.pad.setSyncCap(2, 1n)).wait()
      await w.step(() => w.spawn(base, dev, { name: 'OPEN ME', symbol: 'OPN' }))
      const closed = await w.lastToken()
      await (await w.open(eth, alice, closed)).wait()
      await gasOf('OPEN (hub)') // incl. one quote and one send
      await gasOf('SYNC (spoke)')
      await w.claim(bnb, alice, 100)
      await (await w.move(bnb, alice, 6, b32(alice.address), E(10))).wait()
      await gasOf('MOVE to a remote chain (hub)')
      await gasOf('PAYOUT (spoke)')
      await (await w.move(bnb, alice, HOME, b32(alice.address), E(10))).wait()
      await gasOf('MOVE to the hub chain (hub)')
      await (await w.move(bnb, alice, 6, WIDE, E(10))).wait()
      await gasOf('MOVE turned back (hub)')
      await w.deliverAll()

      expect(used['OPEN (hub)']).to.be.lt(1_500_000n)
      expect(used['MOVE to a remote chain (hub)']).to.be.lt(1_500_000n)
      expect(used['MOVE to the hub chain (hub)']).to.be.lt(1_500_000n)
      expect(used['MOVE turned back (hub)']).to.be.lt(1_500_000n)
      expect(used['SYNC (spoke)']).to.be.lt(GAS_TO_SPOKE / 2n)
      expect(used['PAYOUT (spoke)']).to.be.lt(GAS_TO_SPOKE / 4n)
      // PRINT_GAS=1 npx hardhat test --grep "executor gas" prints what SPEC §3 quotes
      if (process.env.PRINT_GAS) console.log('v7.2 lzReceive gas (mock endpoint):', used)
    })
  })

  /* ====================================================================== */
  /*  The invariant, through everything at once                              */
  /* ====================================================================== */

  describe('Σ vault dollars × SCALE == Σ oUSD supply, ledger included — after every step', () => {
    it('a long mixed scenario over both dollars: launches, trades, pulls, claims, moves, bounces, opens', async () => {
      const w = await deployMixed()
      const [base, opt, arb, eth, bnb] = [w.at(3), w.at(6), w.at(5), w.at(2), w.at(4)]
      await dearEthereum(w)
      await (await w.pad.setSyncCap(2, 2n * FEE)).wait()
      for (const c of w.chains) for (const who of [dev, alice, bob, carol]) await w.fund(c, who, 20_000)

      await w.step(() => w.spawn(bnb, dev, { name: 'ALPHA', symbol: 'A', devBuy: 120, mode: 1 }))
      const a = await w.lastToken()
      await w.step(() => w.spawn(base, dev, { name: 'BETA', symbol: 'B', mode: 3 }))
      const b = await w.lastToken()
      expect(await w.replicated(a)).to.deep.equal([3, 4, 5, 6])
      // inside the window: taxed, clamped, refunded — in each chain's dollar
      await w.step(() => w.buy(opt, alice, a, 400))
      await w.step(() => w.buy(bnb, bob, b, 90))
      await pastGenesis()

      await w.step(() => w.buy(bnb, bob, a, 1_500))
      await w.step(() => w.buy(base, carol, a, 2_500))
      await w.step(() => w.buy(arb, alice, b, 700))
      await w.step(() => w.open(eth, carol, a))
      await w.step(() => w.buy(eth, carol, a, 300))
      const bag = async (c, who, t) => (await w.replica(c, t)).balanceOf(who.address)
      await w.step(async () => w.sell(bnb, bob, a, await bag(bnb, bob, a))) // more than BNB's vault may hold
      await w.step(async () => w.sell(opt, alice, a, (await bag(opt, alice, a)) / 3n))
      await w.step(async () => bnb.gateway.connect(bob).pullFees(a, { value: await bnb.gateway.quotePull() }))
      await w.step(async () => opt.gateway.connect(alice).pullFees(a, { value: await opt.gateway.quotePull() }))
      const repOptA = await w.replica(opt, a)
      expect(await opt.dist.withdrawable(repOptA.target, alice.address)).to.be.gt(0n)
      await w.step(() => opt.dist.connect(alice).claim(repOptA.target))
      // the dev launched on BNB and claims the dev half on Base: fees paid in both dollars, paid out in USDC
      const devUsdc = await base.dollar.balanceOf(dev.address)
      const devOwed = (await w.pad.feesOf(a)).dev
      expect(devOwed).to.be.gt(E(50))
      await w.step(() => base.gateway.connect(dev).claimFees(a))
      expect((await base.dollar.balanceOf(dev.address)) - devUsdc).to.equal(devOwed / base.SCALE)
      // claims travel: whatever Bob and Alice hold as oUSD goes where the dollars are
      for (const [c, who, dst] of [[bnb, bob, 3], [opt, alice, 4], [bnb, bob, 5], [arb, bob, 2], [eth, bob, 6]]) {
        const held = await c.usd.balanceOf(who.address)
        if (held >= 10n ** 12n) await w.step(() => w.move(c, who, dst, b32(who.address), held))
      }
      await w.step(() => base.usd.connect(carol).wrap(U(500))) // (the USDC vault keeps its `wrap`)
      await w.step(() => w.move(base, carol, 4, b32(carol.address), E(200)))
      await w.step(() => w.move(base, carol, 6, WIDE, E(100))) // turned back
      await w.step(() => w.move(base, carol, 2, b32(carol.address), E(100)))
      await w.step(async () => w.sell(base, carol, a, await bag(base, carol, a)))
      await w.step(async () => w.sell(eth, carol, a, await bag(eth, carol, a)))
      await w.step(async () => w.sell(arb, alice, b, await bag(arb, alice, b)))
      await w.step(async () => w.sell(bnb, bob, b, await bag(bnb, bob, b)))
      await w.step(() => w.pad.connect(stranger).resync(b, 2, { value: E('0.01') }))
      expect(await w.replicated(b)).to.deep.equal([2, 3, 4, 5, 6])
      expect((await w.pad.feesOf(b)).burnedTokens).to.be.gt(0n)

      // everybody redeems what their chain can pay; what is left is claims on short vaults — still exactly backed
      for (const c of w.chains) {
        for (const who of [dev, alice, bob, carol]) {
          const held = await c.usd.balanceOf(who.address)
          const liquid = (await c.dollar.balanceOf(c.usd.target)) * c.SCALE
          const can = held < liquid ? held : liquid
          if (can >= c.SCALE) await w.step(() => c.usd.connect(who).unwrap(can))
        }
      }
      const end = await w.backing()
      expect(end.held).to.equal(end.supply)
    })

    it('a randomized sequence of trades and moves across the five chains', async () => {
      const w = await deployMixed()
      const people = [alice, bob, carol]
      for (const c of w.chains) for (const who of people) await w.fund(c, who, 50_000)
      await w.step(() => w.spawn(w.at(4), dev, { name: 'RANDOM ONE', symbol: 'R1', mode: 0 }))
      const t1 = await w.lastToken()
      await w.step(() => w.spawn(w.at(6), dev, { name: 'RANDOM TWO', symbol: 'R2', mode: 2 }))
      const t2 = await w.lastToken()
      await pastGenesis()

      let seed = 0x72c0ffeen
      const rnd = (mod) => {
        seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n
        return (seed >> 24n) % BigInt(mod)
      }
      let moves = 0
      let trades = 0
      for (let i = 0; i < 60; i++) {
        const c = w.chains[Number(rnd(5))]
        const who = people[Number(rnd(3))]
        const token = rnd(2) === 0n ? t1 : t2
        const action = Number(rnd(10))
        if (action < 4) {
          // a buy, odd wei included where the dollar has them
          const amount = c.T(1 + Number(rnd(900))) + rnd(10n ** BigInt(c.decimals))
          await w.step(async () => c.gateway.connect(who).buyTokenUsdc(token, amount, { value: await c.gateway.quoteBuy() }))
          trades++
        } else if (action < 7) {
          const bag = await (await w.replica(c, token)).balanceOf(who.address)
          const part = bag / (1n + rnd(3))
          if (part >= 10n ** 12n) {
            await w.step(() => w.sell(c, who, token, part))
            trades++
          }
        } else if (action < 9) {
          // a claim this user holds here goes to another chain — sometimes to someone who cannot be
          // paid there. With none in hand they first get one the way a claim comes to exist.
          if ((await c.usd.balanceOf(who.address)) < 10n ** 12n) {
            await w.claim(c, who, 20 + Number(rnd(200)))
            await w.check()
          }
          const held = await c.usd.balanceOf(who.address)
          let d = w.chains[Number(rnd(5))]
          if (d.label === c.label) d = w.chains[(w.chains.indexOf(c) + 1) % 5]
          const to = rnd(5) === 0n ? WIDE : b32(people[Number(rnd(3))].address)
          const part = held - rnd(held / 2n + 1n)
          await w.step(() => w.move(c, who, d.label, to, part >= 10n ** 12n ? part : held))
          moves++
        } else {
          await w.step(async () => c.gateway.connect(who).pullFees(token, { value: await c.gateway.quotePull() }))
          const rep = await w.replica(c, token)
          if ((await c.dist.withdrawable(rep.target, who.address)) > 0n) await w.step(() => c.dist.connect(who).claim(rep.target))
        }
      }
      expect(trades).to.be.gt(20)
      expect(moves).to.be.gt(8)
    })

    it('the six-label worlds of the other suites: a move and an open work there too (sync and async transports)', async () => {
      // the simulated one-node network
      const s = await deployWorld({ requests: true })
      const [solana, bnbS] = [s.chains[0], s.chains[3]]
      await fundUsd(solana, alice, 100)
      await (await solana.gateway.connect(alice).moveClaim(4, b32(bob.address), E(100))).wait()
      expect(await bnbS.usd.balanceOf(bob.address)).to.equal(E(100)) // that vault is empty: a claim
      let b = await backing(s)
      expect(b.supply).to.equal(b.usdc)

      // the async one, sponsored like a testnet
      const a = await deployWorldAsync({ requests: true })
      const [baseA, optA] = [a.chains[2], a.chains[5]]
      await (await a.pad.setSyncCap(6, 1n)).wait()
      await (await baseA.gateway.connect(dev).spawnToken('GLOOP', 'GLP', '{}', 0, 0)).wait()
      await a.deliverAll()
      const token = await a.pad.allTokens(0)
      expect(await optA.gateway.replicaOf(token)).to.equal(ethers.ZeroAddress)
      await (await optA.gateway.connect(alice).openToken(token)).wait()
      await a.deliverAll()
      expect(await optA.gateway.replicaOf(token)).to.not.equal(ethers.ZeroAddress)
      await fundUsd(optA, alice, 40)
      await (await optA.gateway.connect(alice).moveClaim(3, b32(alice.address), E(40))).wait()
      await a.deliverAll()
      expect(await baseA.usd.balanceOf(alice.address)).to.equal(E(40))
      b = await backing(a)
      expect(b.supply).to.equal(b.usdc)
    })
  })

  /* ====================================================================== */
  /*  ABI                                                                    */
  /* ====================================================================== */

  describe('what v7.2 adds to the ABI, and what it leaves alone', () => {
    it('the pad and the gateway gained exactly these; nothing that existed changed shape', async () => {
      const pad = new ethers.Interface((await artifacts.readArtifact('SpawnPad')).abi)
      const gw = new ethers.Interface((await artifacts.readArtifact('SpawnGateway')).abi)
      const sig = (i, name) => i.getFunction(name)?.format('full')
      const names = (i, type) => i.fragments.filter((f) => f.type === type).map((f) => f.format('sighash')).sort()
      /** `all` minus the v7.2 additions must be the v7.1 surface, entry for entry. */
      const split = (all, added) => {
        for (const a of added) expect(all, a).to.include(a)
        return all.filter((x) => !added.includes(x))
      }
      // the whole external surface, pinned: what v7.1 had (unchanged selectors)…
      const PAD_V71 = [
        'BURN_TRIGGER()', 'DIST_TRIGGER()', 'FEE_BPS()', 'FEE_BURN()', 'FEE_DEV()', 'FEE_HOLDERS()', 'FEE_SPLIT()',
        'GENESIS_MAX_USD()', 'GENESIS_WINDOW()', 'HUB_CHAIN()', 'SNIPE_MAX_BPS()', 'TOTAL_SUPPLY()', 'acceptAdmin()',
        'admin()', 'allTokens(uint256)', 'autoDrop(uint32)', 'chainLabels(uint256)', 'chainsLength()', 'curves(address)',
        'fairGenesisOf(address,bytes32)', 'feesOf(address)', 'gateways(uint32)', 'genesisSpent(address,bytes32)',
        'getToken(uint256)', 'guardian()', 'messenger()', 'metas(address)', 'onOmniMessage(uint32,bytes32,bytes)',
        'operator()', 'pause()', 'paused()', 'pendingAdmin()', 'pendingDrop(address,uint32)', 'resync(address,uint32)',
        'setAutoDrop(uint32,bool)', 'setGateway(uint32,bytes32)', 'setGuardian(address)', 'setOperator(address)',
        'setVenue(address)', 'spawnBlock(address)', 'spotPrice(address)', 'supplyByChain(address,uint32)', 'tokensLength()',
        'transferAdmin(address)', 'unpause()', 'usd()', 'venue()',
      ]
      const GW_V71 = [
        'HUB_CHAIN()', 'MAX_FEE_MODE()', 'MAX_META_BYTES()', 'MAX_NAME_BYTES()', 'MAX_SPAWN_LEGS()', 'MAX_SYMBOL_BYTES()',
        'MAX_TRADE_LEGS()', 'MIN_AMOUNT()', 'acceptAdmin()', 'admin()', 'buyToken(address,uint256)',
        'buyTokenMin(address,uint256,uint256)', 'buyTokenUsdc(address,uint256)', 'buyTokenUsdcMin(address,uint256,uint256)',
        'chainLabel()', 'claimFees(address)', 'claimPending(address)', 'distributor()', 'flushFeeDrop(address)', 'guardian()',
        'messenger()', 'onOmniMessage(uint32,bytes32,bytes)', 'operator()', 'pad()', 'pause()', 'paused()', 'pendingAdmin()',
        'pendingDelivery(address,address)', 'pendingFeeDrop(address)', 'pullFees(address)', 'quoteBuy()', 'quoteClaim()',
        'quotePull()', 'quoteSell()', 'quoteSpawn(string,string,string,bool)', 'replicaOf(address)',
        'sellToken(address,uint256)', 'sellTokenMin(address,uint256,uint256)', 'setDistributor(address)',
        'setGuardian(address)', 'setLegs(uint8,uint8)', 'setOperator(address)', 'spawnLegs()',
        'spawnToken(string,string,string,uint256,uint8)', 'spawnTokenUsdc(string,string,string,uint256,uint8)', 'tradeLegs()',
        'transferAdmin(address)', 'unpause()', 'usd()',
      ]
      // …and exactly what v7.2 adds
      expect(
        split(names(pad, 'function'), ['requestCap(uint32)', 'setRequestCap(uint32,uint256)', 'setSyncCap(uint32,uint256)', 'syncCap(uint32)']),
      ).to.deep.equal(PAD_V71)
      expect(
        split(names(gw, 'function'), [
          'MAX_MOVE_LEGS()', 'MAX_OPEN_LEGS()', 'moveClaim(uint32,bytes32,uint256)', 'moveLegs(uint32)', 'openLegs()',
          'openToken(address)', 'quoteMove(uint32)', 'quoteOpen()', 'setMoveLegs(uint32,uint16)', 'setOpenLegs(uint8)',
        ]),
      ).to.deep.equal(GW_V71)
      expect(
        split(names(pad, 'event'), ['Moved(uint32,uint32,bytes32,bytes32,uint256,bool)', 'RequestCapSet(uint32,uint256)', 'SyncCapSet(uint32,uint256)']),
      ).to.have.length(21)
      expect(
        split(names(gw, 'event'), ['ClaimMoved(address,uint32,bytes32,uint256)', 'MoveLegsSet(uint32,uint16)', 'OpenLegsSet(uint8)']),
      ).to.have.length(13)
      // new
      expect(sig(pad, 'syncCap')).to.equal('function syncCap(uint32) view returns (uint256)')
      expect(sig(pad, 'requestCap')).to.equal('function requestCap(uint32) view returns (uint256)')
      expect(sig(pad, 'setSyncCap')).to.equal('function setSyncCap(uint32 chain, uint256 cap)')
      expect(sig(pad, 'setRequestCap')).to.equal('function setRequestCap(uint32 chain, uint256 cap)')
      expect(pad.getEvent('SyncCapSet').format('full')).to.equal('event SyncCapSet(uint32 indexed chain, uint256 cap)')
      expect(pad.getEvent('RequestCapSet').format('full')).to.equal('event RequestCapSet(uint32 indexed chain, uint256 cap)')
      expect(pad.getEvent('Moved').format('full')).to.equal(
        'event Moved(uint32 indexed srcChain, uint32 indexed dstChain, bytes32 indexed from, bytes32 to, uint256 amount, bool forwarded)',
      )
      expect(sig(gw, 'openToken')).to.equal('function openToken(address hubToken) payable')
      expect(sig(gw, 'moveClaim')).to.equal('function moveClaim(uint32 dstChain, bytes32 to, uint256 amount) payable')
      expect(sig(gw, 'quoteOpen')).to.equal('function quoteOpen() view returns (uint256)')
      expect(sig(gw, 'quoteMove')).to.equal('function quoteMove(uint32 dstChain) view returns (uint256)')
      expect(sig(gw, 'openLegs')).to.equal('function openLegs() view returns (uint8)')
      expect(sig(gw, 'moveLegs')).to.equal('function moveLegs(uint32) view returns (uint16)')
      expect(sig(gw, 'setOpenLegs')).to.equal('function setOpenLegs(uint8 legs)')
      expect(sig(gw, 'setMoveLegs')).to.equal('function setMoveLegs(uint32 dstChain, uint16 legs)')
      expect(sig(gw, 'MAX_OPEN_LEGS')).to.equal('function MAX_OPEN_LEGS() view returns (uint8)')
      expect(sig(gw, 'MAX_MOVE_LEGS')).to.equal('function MAX_MOVE_LEGS() view returns (uint16)')
      // changed: payable, and no longer the operator's alone — same selector
      expect(sig(pad, 'resync')).to.equal('function resync(address token, uint32 chain) payable')
      // untouched
      expect(sig(gw, 'setLegs')).to.equal('function setLegs(uint8 trade, uint8 spawn)')
      expect(pad.getEvent('SyncFailed').format('full')).to.equal('event SyncFailed(address indexed token, uint32 indexed chain)')
      expect(pad.getEvent('Resynced').format('full')).to.equal('event Resynced(address indexed token, uint32 indexed chain)')
      expect(pad.getEvent('Refused').format('full')).to.equal(
        'event Refused(uint8 indexed op, uint32 indexed srcChain, bytes32 token, bytes32 actor, uint256 amount, uint8 reason)',
      )
    })
  })
})
