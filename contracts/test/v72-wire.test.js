const { expect } = require('chai')
const { ethers, artifacts } = require('hardhat')
const { time } = require('@nomicfoundation/hardhat-network-helpers')
const { deployWorld, fundUsdc, U, GAS_TO_SPOKE, MOCK_GAS_TO_HUB } = require('../scripts/lib-deploy')
const {
  E, b32, coder, bal, pastGenesis, FEE, UNIT, EID, HOME, op, unpack, peek, events, deployMixed,
} = require('./mixed-world')

/** The exact type-3 executor option the adapter builds. */
const opts = (gas, value = 0n) =>
  value > 0n
    ? ethers.solidityPacked(['uint16', 'uint8', 'uint16', 'uint8', 'uint128', 'uint128'], [3, 1, 33, 1, gas, value])
    : ethers.solidityPacked(['uint16', 'uint8', 'uint16', 'uint8', 'uint128'], [3, 1, 17, 1, gas])
/** The inter-adapter envelope (v7.2): its last word is the reply budget. */
const ENVELOPE = ['bytes32', 'bytes32', 'bytes', 'uint256']
const TRADE = ['bytes32', 'bytes32', 'uint256', 'uint256']
const WHOLE = E(1_000_000_000) // more tokens, or dollars, than any trade gives

/* trades with a minimum, their quoted fee attached */
const buyMin = async (c, who, token, dollars, min) =>
  c.gateway.connect(who).buyTokenUsdcMin(token, c.T(dollars), min, { value: await c.gateway.quoteBuy() })
const sellMin = async (c, who, token, tokens, min) =>
  c.gateway.connect(who).sellTokenMin(token, tokens, min, { value: await c.gateway.quoteSell() })
/** What a plain buy of `dollars` on `c` would deliver right now. */
const fillOf = (w, c, who, token, dollars) =>
  peek(async () => {
    const rep = await w.replica(c, token)
    const before = await rep.balanceOf(who.address)
    await (await w.buy(c, who, token, dollars)).wait()
    await w.deliverAll()
    return (await rep.balanceOf(who.address)) - before
  })
/** What a plain sell would PAY (net of the fee), in 18-decimal dollars. */
const paidFor = (w, c, who, token, tokens) =>
  peek(async () => {
    const before = await w.worth(c, who)
    await (await w.sell(c, who, token, tokens)).wait()
    await w.deliverAll()
    return (await w.worth(c, who)) - before
  })
/** Net of the pad's 1% fee, as the pad computes it. */
const netOf = (gross) => gross - gross / 100n
/** The pad's conversion: the smallest gross whose net is at least `n`. */
const grossFor = (n) => (n === 0n ? 0n : n + (n - 1n) / 99n)

/**
 * The second half of protocol v7.2 — three things that had to be on the wire
 * and in the adapter before the hub and its transport became immutable:
 *  A. a minimum for every trade, enforced on the hub (a cross-chain order is
 *     public minutes before it executes, and anyone may deliver it);
 *  B. the reply budget a message prepaid must ARRIVE with it;
 *  C. executor gas per kind of message.
 * All of it on the mixed universe of test/v72.test.js: the hub chain's own
 * gateway (label 3), USDC spokes on 6, 5 and 2, the USDT spoke on 4.
 */
describe('Protocol v7.2 — the wire: a minimum for every trade, a budget that must arrive, gas per kind of message', () => {
  let admin, dev, alice, bob, carol, stranger

  beforeEach(async () => {
    ;[admin, dev, alice, bob, carol, stranger] = await ethers.getSigners()
  })

  /** A token launched on the hub chain, past its genesis window. */
  async function launched(options) {
    const w = await deployMixed(options)
    await w.step(() => w.spawn(w.at(HOME), dev))
    const token = await w.lastToken()
    await pastGenesis()
    return { w, token }
  }

  /* ====================================================================== */
  /*  A — a minimum on the wire                                              */
  /* ====================================================================== */

  describe('A. the minimum rides the wire: all or nothing, on every chain', () => {
    it('a cross-chain buy fills at the minimum it names, to the wei — one wei more and every dollar comes home, in that chain\'s own dollar', async () => {
      const { w, token } = await launched()
      for (const c of [w.at(6), w.at(4)]) {
        // a USDC chain, then the USDT chain
        await w.fund(c, alice, 2_000)
        const rep = await w.replica(c, token)
        const out = await fillOf(w, c, alice, token, 300)
        expect(out).to.be.gt(0n)
        const before = {
          dollars: await c.dollar.balanceOf(alice.address),
          bag: await rep.balanceOf(alice.address),
          books: await w.hubUsd.totalSupply(),
          vBase: (await w.pad.curves(token)).vBase,
        }

        // ── one wei too many
        await (await buyMin(c, alice, token, 300, out + 1n)).wait()
        // the call did not revert here: the order is on the wire, with its minimum as the fourth word
        expect(unpack(await w.endpoint.peek(0))).to.deep.equal({
          op: 2,
          data: coder.encode(TRADE, [b32(token), b32(alice.address), E(300), out + 1n]),
        })
        expect(await c.dollar.balanceOf(alice.address)).to.equal(before.dollars - c.T(300))
        // the hub refuses it whole (reason 6: the market would not fill it) and touches nothing
        const tank = await w.tank()
        await expect(w.endpoint.deliverNext())
          .to.emit(w.pad, 'Refused')
          .withArgs(2, c.label, b32(token), b32(alice.address), E(300), 6)
        expect(await w.hubUsd.totalSupply()).to.equal(before.books)
        expect((await w.pad.curves(token)).vBase).to.equal(before.vBase)
        expect((await w.tank()) - tank).to.equal(UNIT - FEE) // the way home was prepaid, like any reply
        await w.deliverAll()
        expect(await c.dollar.balanceOf(alice.address)).to.equal(before.dollars) // every dollar, as dollars
        expect(await c.usd.balanceOf(alice.address)).to.equal(0n)
        expect(await rep.balanceOf(alice.address)).to.equal(before.bag)
        await w.check()

        // ── exactly the fill
        await w.step(() => buyMin(c, alice, token, 300, out))
        expect((await rep.balanceOf(alice.address)) - before.bag).to.equal(out)
        expect(await c.dollar.balanceOf(alice.address)).to.equal(before.dollars - c.T(300))
      }
    })

    it('a cross-chain sell pays at least what it names, net of the fee, to the wei — one wei more and the bag comes back', async () => {
      const { w, token } = await launched()
      const opt = w.at(6)
      await w.fund(opt, alice, 5_000)
      await w.step(() => w.buy(opt, alice, token, 2_000))
      const rep = await w.replica(opt, token)
      let seed = 0x5e11n
      const rnd = (mod) => {
        seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n
        return (seed >> 24n) % BigInt(mod)
      }
      for (let i = 0; i < 8; i++) {
        const bag = await rep.balanceOf(alice.address)
        const part = bag / (3n + rnd(6)) + rnd(10n ** 18n) // odd amounts, down to the wei
        const net = await paidFor(w, opt, alice, token, part)
        expect(net).to.be.gt(0n)
        const worth = await w.worth(opt, alice)

        // one wei more than the sale pays: refused, and the bag the spoke burned is delivered back
        await (await sellMin(opt, alice, token, part, net + 1n)).wait()
        expect(unpack(await w.endpoint.peek(0))).to.deep.equal({
          op: 3,
          data: coder.encode(TRADE, [b32(token), b32(alice.address), part, net + 1n]),
        })
        expect(await rep.balanceOf(alice.address)).to.equal(bag - part)
        await expect(w.endpoint.deliverNext())
          .to.emit(w.pad, 'Refused')
          .withArgs(3, 6, b32(token), b32(alice.address), part, 6)
        await w.deliverAll()
        expect(await rep.balanceOf(alice.address), `sell ${i}`).to.equal(bag)
        expect(await w.worth(opt, alice)).to.equal(worth)
        await w.check()

        // exactly what it pays: paid, and not a wei under
        await w.step(() => sellMin(opt, alice, token, part, net))
        expect((await w.worth(opt, alice)) - worth, `sell ${i}`).to.equal(net)
        expect(await rep.balanceOf(alice.address)).to.equal(bag - part)
      }
    })

    it('the seller\'s NET minimum becomes the venue\'s GROSS one exactly — including the one sale in a hundred where a rounded conversion would refuse a seller their own price', async () => {
      // the arithmetic, exhaustively on a range: g = n + ⌊(n−1)/99⌋ is the SMALLEST gross whose net reaches n
      for (let n = 1n; n <= 3_000n; n++) {
        const g = grossFor(n)
        expect(netOf(g) >= n && netOf(g - 1n) < n, `n = ${n}`).to.equal(true)
      }

      // on the hub: a venue that writes down the minimum it is handed (and trades regardless)
      const { w, token } = await launched({ venueName: 'RecordingVenue' })
      const opt = w.at(6)
      await w.fund(opt, alice, 5_000)
      await w.step(() => w.buy(opt, alice, token, 2_000))
      expect(await w.venue.lastBuyMin()).to.equal(0n) // a plain buy names none
      const MAX = ethers.MaxUint256
      const cases = [
        [1n, 1n], [98n, 98n], [99n, 99n], [100n, 101n], [198n, 199n], [199n, 201n], [9_900n, 9_999n],
        [E(1_000), E(1_000) + (E(1_000) - 1n) / 99n],
        // too large to convert: it becomes a minimum no sale can meet, never an overflow
        [MAX, MAX], [MAX - 1n, MAX], [(MAX / 100n) * 99n + 99n, MAX],
        // the largest that still converts
        [(MAX / 100n) * 99n, grossFor((MAX / 100n) * 99n)],
      ]
      for (const [net, gross] of cases) {
        if (gross !== MAX) expect(grossFor(net)).to.equal(gross)
        await w.step(() => sellMin(opt, alice, token, E(1_000), net))
        expect(await w.venue.lastSellMin(), `net ${net}`).to.equal(gross)
      }
      // a buy's minimum is in tokens: it goes to the venue as it is
      await w.step(() => buyMin(opt, alice, token, 10, 123_456_789n))
      expect(await w.venue.lastBuyMin()).to.equal(123_456_789n)

      // and with the real curve: find a sale whose gross ends in …99 (its net is the same as the
      // next wei's: the plateau where n + ⌊n/99⌋ overshoots by one), and sell it for exactly its net
      const real = await launched()
      const [base, far] = [real.w.at(HOME), real.w.at(6)]
      for (const c of [base, far]) {
        await real.w.fund(c, alice, 5_000)
        await real.w.step(() => real.w.buy(c, alice, real.token, 2_000))
        const curve = await real.w.pad.curves(real.token)
        const k = curve.vBase * curve.vTokens
        const grossOf = (tokens) => curve.vBase - ((k - 1n) / (curve.vTokens + tokens) + 1n)
        let part = E(1_000_000)
        while (grossOf(part) % 100n !== 99n) part += 10n ** 5n
        const gross = grossOf(part)
        const net = netOf(gross)
        expect(net).to.equal(netOf(gross + 1n)) // the plateau
        expect(grossFor(net)).to.equal(gross) // exact: the sale passes at its own price…
        expect(net + net / 99n).to.equal(gross + 1n) // …where the rounded formula would ask one wei more
        const worth = await real.w.worth(c, alice)
        await real.w.step(() => sellMin(c, alice, real.token, part, net))
        expect((await real.w.worth(c, alice)) - worth, c.id).to.equal(net)
      }
    })

    it('a minimum no trade can meet — the largest number there is — strands nothing: the dollars and the bag come home', async () => {
      const { w, token } = await launched()
      const opt = w.at(6)
      await w.fund(opt, alice, 1_000)
      await w.step(() => w.buy(opt, alice, token, 500))
      const rep = await w.replica(opt, token)
      const bag = await rep.balanceOf(alice.address)
      const worth = await w.worth(opt, alice)
      for (const impossible of [WHOLE, ethers.MaxUint256, ethers.MaxUint256 - 1n, (ethers.MaxUint256 / 100n) * 99n + 1n]) {
        await w.step(() => buyMin(opt, alice, token, 100, impossible))
        await w.step(() => sellMin(opt, alice, token, bag, impossible))
        expect(await rep.balanceOf(alice.address)).to.equal(bag)
        expect(await w.worth(opt, alice)).to.equal(worth)
      }
      // and on the hub chain the same numbers are a clean "GW: min out", not an arithmetic panic
      const base = w.at(HOME)
      await w.fund(base, alice, 1_000)
      await w.step(() => w.buy(base, alice, token, 500))
      const held = await (await w.replica(base, token)).balanceOf(alice.address)
      for (const impossible of [ethers.MaxUint256, ethers.MaxUint256 - held, ethers.MaxUint256 - held + 1n]) {
        await expect(base.gateway.connect(alice).buyTokenUsdcMin(token, U(100), impossible)).to.be.revertedWith('GW: min out')
        await expect(base.gateway.connect(alice).sellTokenMin(token, held, impossible)).to.be.revertedWith('GW: min out')
      }
    })

    it('the plain functions carry no minimum (a zero on the wire); a minimum of zero is still refused; the quotes count the extra word', async () => {
      const { w, token } = await launched()
      const [base, opt] = [w.at(HOME), w.at(6)]
      await w.fund(opt, alice, 1_000)
      await (await w.buy(opt, alice, token, 100)).wait()
      expect(unpack(await w.endpoint.peek(0))).to.deep.equal({
        op: 2,
        data: coder.encode(TRADE, [b32(token), b32(alice.address), E(100), 0n]),
      })
      await w.deliverAll()
      const rep = await w.replica(opt, token)
      const bag = await rep.balanceOf(alice.address)
      await (await w.sell(opt, alice, token, bag / 2n)).wait()
      expect(unpack(await w.endpoint.peek(0))).to.deep.equal({
        op: 3,
        data: coder.encode(TRADE, [b32(token), b32(alice.address), bag / 2n, 0n]),
      })
      await w.deliverAll()
      // oUSD already held: the same wire
      await (await opt.usd.connect(alice).wrap(U(50))).wait()
      await (await opt.gateway.connect(alice).buyTokenMin(token, E(50), 7n, { value: await opt.gateway.quoteBuy() })).wait()
      expect(unpack(await w.endpoint.peek(0)).data).to.equal(coder.encode(TRADE, [b32(token), b32(alice.address), E(50), 7n]))
      await w.deliverAll()

      for (const c of [base, opt]) {
        const fee = await c.gateway.quoteBuy()
        await expect(c.gateway.connect(alice).buyTokenUsdcMin(token, c.T(10), 0, { value: fee })).to.be.revertedWith('GW: zero min')
        await expect(c.gateway.connect(alice).buyTokenMin(token, E(10), 0, { value: fee })).to.be.revertedWith('GW: zero min')
        await expect(c.gateway.connect(alice).sellTokenMin(token, E(10), 0, { value: fee })).to.be.revertedWith('GW: zero min')
        await expect(c.gateway.connect(alice).buyTokenUsdcMin(stranger.address, c.T(10), 1, { value: fee })).to.be.revertedWith('GW: unknown token')
      }

      // a quote is exactly what the send needs — with a fee per byte, a word short would show
      await (await w.endpoint.setByteFee(ethers.parseUnits('1', 'gwei'))).wait()
      const qBuy = await opt.gateway.quoteBuy()
      const qSell = await opt.gateway.quoteSell()
      await expect(opt.gateway.connect(alice).buyTokenUsdcMin(token, U(10), 1, { value: qBuy - 1n })).to.be.revertedWith('LZM: fee')
      await (await opt.gateway.connect(alice).buyTokenUsdcMin(token, U(10), 1, { value: qBuy })).wait()
      await expect(opt.gateway.connect(alice).sellTokenMin(token, bag / 4n, 1, { value: qSell - 1n })).to.be.revertedWith('LZM: fee')
      await (await opt.gateway.connect(alice).sellTokenMin(token, bag / 4n, 1, { value: qSell })).wait()
      await w.deliverAll()
      await w.check()
    })

    it('where the hub answers in the same transaction the whole call still reverts ("GW: min out") — the hub chain\'s gateway, and the simulated transport', async () => {
      const { w, token } = await launched()
      const [base, opt] = [w.at(HOME), w.at(6)]
      await w.fund(base, alice, 1_000)
      await w.fund(opt, alice, 1_000)
      expect(await base.messenger.isLocal(0)).to.equal(true)
      expect(await opt.messenger.isLocal(0)).to.equal(false)

      // the hub chain: nothing moves, nothing is sent, the wallet sees it in simulation
      const state = async () => ({
        usdc: await base.dollar.balanceOf(alice.address),
        vault: await base.dollar.balanceOf(base.usd.target),
        books: await w.hubUsd.totalSupply(),
        vBase: (await w.pad.curves(token)).vBase,
      })
      const before = await state()
      await expect(base.gateway.connect(alice).buyTokenUsdcMin(token, U(100), WHOLE)).to.be.revertedWith('GW: min out')
      await expect(base.gateway.connect(alice).buyTokenUsdcMin.staticCall(token, U(100), WHOLE)).to.be.revertedWith('GW: min out')
      expect(await state()).to.deep.equal(before)
      const out = await peek(async () => {
        await (await base.gateway.connect(alice).buyTokenUsdc(token, U(100))).wait()
        return (await w.replica(base, token)).balanceOf(alice.address)
      })
      await expect(base.gateway.connect(alice).buyTokenUsdcMin(token, U(100), out + 1n)).to.be.revertedWith('GW: min out')
      await (await base.gateway.connect(alice).buyTokenUsdcMin(token, U(100), out)).wait()
      await expect(base.gateway.connect(alice).sellTokenMin(token, out, WHOLE)).to.be.revertedWith('GW: min out')
      // the very same call on a remote chain does not revert: there the hub is what refuses
      await (await buyMin(opt, alice, token, 100, WHOLE)).wait()
      await w.deliverAll()
      expect(await opt.dollar.balanceOf(alice.address)).to.equal(U(1_000))

      // the simulated one-node network: every delivery is synchronous, so every chain is "local"
      const s = await deployWorld()
      const c = s.chains[1]
      expect(await s.messenger.isLocal(0)).to.equal(true)
      await fundUsdc(c, alice, 1_000)
      await (await c.gateway.connect(dev).spawnToken('GLOOP', 'GLP', '{}', 0, 0)).wait()
      const t = await s.pad.allTokens(0)
      await pastGenesis()
      await expect(c.gateway.connect(alice).buyTokenUsdcMin(t, U(100), WHOLE)).to.be.revertedWith('GW: min out')
      expect(await c.usdc.balanceOf(alice.address)).to.equal(U(1_000))
      await (await c.gateway.connect(alice).buyTokenUsdcMin(t, U(100), 1)).wait()
    })

    it('FAIR GENESIS: a fill cut to the $250 cap is under the minimum — the whole buy comes home, the cap is not consumed', async () => {
      const w = await deployMixed()
      const opt = w.at(6)
      await w.step(() => w.spawn(w.at(HOME), dev))
      const token = await w.lastToken()
      const t0 = Number((await w.pad.metas(token)).spawnedAt)
      await w.fund(opt, alice, 1_000)
      const rep = await w.replica(opt, token)
      /** Sends a $300 buy and lands it on the hub at `t0 + at` seconds. */
      const buyAt = async (at, min) => {
        await (await (min === undefined ? w.buy(opt, alice, token, 300) : buyMin(opt, alice, token, 300, min))).wait()
        await time.setNextBlockTimestamp(t0 + at)
        const landed = await w.endpoint.deliverNext()
        await w.deliverAll()
        return landed
      }
      // what $300 really gets inside the window: $250 on the curve (taxed), $50 back
      const capped = (at) =>
        peek(async () => {
          await buyAt(at)
          expect(await opt.dollar.balanceOf(alice.address)).to.equal(U(750))
          return rep.balanceOf(alice.address)
        })

      // a buyer who wants no less than what $300 would buy gets nothing — and loses nothing
      const fill100 = await capped(100)
      const books = await w.hubUsd.totalSupply()
      await expect(await buyAt(100, fill100 + 1n))
        .to.emit(w.pad, 'Refused')
        .withArgs(2, 6, b32(token), b32(alice.address), E(300), 6)
      expect(await opt.dollar.balanceOf(alice.address)).to.equal(U(1_000))
      expect(await rep.balanceOf(alice.address)).to.equal(0n)
      expect(await w.pad.genesisSpent(token, b32(alice.address))).to.equal(0n) // the cap is intact
      expect(await w.hubUsd.totalSupply()).to.equal(books)
      expect((await w.pad.feesOf(token)).total).to.equal(0n) // and no tax was taken
      await w.check()

      // a minimum the capped fill meets goes through: $250 spent, $50 home
      const fill200 = await capped(200)
      await buyAt(200, fill200)
      expect(await rep.balanceOf(alice.address)).to.equal(fill200)
      expect(await opt.dollar.balanceOf(alice.address)).to.equal(U(750))
      expect(await w.pad.genesisSpent(token, b32(alice.address))).to.equal(E(250))
      await w.check()
    })

    it('the end of the curve: a buy the curve can only fill in part is under its minimum — whole or not at all', async () => {
      const { w, token } = await launched()
      const [base, opt] = [w.at(HOME), w.at(6)]
      await w.fund(base, carol, 17_000)
      await w.fund(opt, alice, 5_000)
      await w.step(() => w.buy(base, carol, token, 17_000)) // the curve is nearly sold out
      const rep = await w.replica(opt, token)
      // $2,000 more buys only what is left, and most of it comes back
      const { out, spent } = await peek(async () => {
        await (await w.buy(opt, alice, token, 2_000)).wait()
        await w.deliverAll()
        return { out: await rep.balanceOf(alice.address), spent: U(5_000) - (await opt.dollar.balanceOf(alice.address)) }
      })
      expect(spent).to.be.lt(U(1_000))
      expect((await w.pad.curves(token)).ascended).to.equal(false)

      await w.step(() => buyMin(opt, alice, token, 2_000, out + 1n))
      expect(await rep.balanceOf(alice.address)).to.equal(0n)
      expect(await opt.dollar.balanceOf(alice.address)).to.equal(U(5_000))
      expect((await w.pad.curves(token)).ascended).to.equal(false) // the refused buy did not end the curve

      await (await buyMin(opt, alice, token, 2_000, out)).wait()
      await expect(w.endpoint.deliverNext()).to.emit(w.pad, 'Ascended')
      await w.deliverAll()
      expect(await rep.balanceOf(alice.address)).to.equal(out)
      expect(U(5_000) - (await opt.dollar.balanceOf(alice.address))).to.equal(spent)
      await w.check()

      // after ascension the token trades on the pool: the minimum holds there the same way
      expect((await w.pad.curves(token)).ascended).to.equal(true)
      const more = await fillOf(w, opt, alice, token, 500)
      const dollars = await opt.dollar.balanceOf(alice.address)
      await (await buyMin(opt, alice, token, 500, more + 1n)).wait()
      await expect(w.endpoint.deliverNext()).to.emit(w.pad, 'Refused').withArgs(2, 6, b32(token), b32(alice.address), E(500), 6)
      await w.deliverAll()
      expect(await opt.dollar.balanceOf(alice.address)).to.equal(dollars)
      await w.step(() => buyMin(opt, alice, token, 500, more))
      expect(await rep.balanceOf(alice.address)).to.equal(out + more)
      const net = await paidFor(w, opt, alice, token, more)
      await w.step(() => sellMin(opt, alice, token, more, net + 1n))
      expect(await rep.balanceOf(alice.address)).to.equal(out + more) // refused: the bag is back
      await w.step(() => sellMin(opt, alice, token, more, net))
      expect(await rep.balanceOf(alice.address)).to.equal(out)
    })

    describe('the sandwich that fits in one hub-chain transaction', () => {
      /** The attacker: a contract on the hub chain holding `dollars` of USDC. */
      async function attacker(w, dollars) {
        const s = await ethers.deployContract('Sandwicher')
        const base = w.at(HOME)
        await (await base.dollar.mint(s.target, base.T(dollars))).wait()
        return s
      }
      const holder = (s) => ({ address: s.target })

      it('a cross-chain BUY: without a minimum the buyer gets a fraction and the attacker keeps the rest; with one, the attacker pays the fees and the buyer loses nothing', async () => {
        const { w, token } = await launched()
        const [base, opt] = [w.at(HOME), w.at(6)]
        await w.fund(opt, alice, 1_000)
        const s = await attacker(w, 6_000)
        const rep = await w.replica(opt, token)
        const fair = await fillOf(w, opt, alice, token, 1_000) // what $1,000 buys with nobody in the way
        const attack = () => s.aroundBuy(base.gateway.target, base.dollar.target, base.usd.target, token, U(6_000), w.endpoint.target, 0)

        // ── a plain order: public on Optimism, delivered by the attacker between a buy and a sell
        const naked = await peek(async () => {
          await (await w.buy(opt, alice, token, 1_000)).wait()
          const rc = await (await attack()).wait() // ONE transaction on the hub chain
          expect(events(rc, w.pad, 'Trade')).to.have.length(3) // their buy, the victim's, their sell
          await w.deliverAll()
          return { bag: await rep.balanceOf(alice.address), profit: (await w.worth(base, holder(s))) - E(6_000) }
        })
        expect(naked.bag * 100n).to.be.lt(fair * 28n) // the buyer got 27% of the tokens their $1,000 was worth
        expect(naked.bag * 100n).to.be.gt(fair * 27n)
        expect(naked.profit).to.be.gt(E(620)) // and the attacker kept $623, fees paid, at no risk
        expect(naked.profit).to.be.lt(E(625))

        // ── the same order with a minimum 1% under the fair fill
        await (await buyMin(opt, alice, token, 1_000, (fair * 99n) / 100n)).wait()
        const tx = await attack()
        await expect(tx).to.emit(w.pad, 'Refused').withArgs(2, 6, b32(token), b32(alice.address), E(1_000), 6)
        expect(events(await tx.wait(), w.pad, 'Trade')).to.have.length(2) // only the attacker's own two
        await w.deliverAll()
        // the attacker bought and sold into nobody: two fees, and nothing to show for them
        const loss = E(6_000) - (await w.worth(base, holder(s)))
        expect(loss).to.be.gt(E(119)) // 1% in, 1% out: $119.40
        expect(loss).to.be.lt(E(120))
        // the buyer has every dollar back (and can send the order again)
        expect(await opt.dollar.balanceOf(alice.address)).to.equal(U(1_000))
        expect(await rep.balanceOf(alice.address)).to.equal(0n)
        await w.check()
        await w.step(() => buyMin(opt, alice, token, 1_000, (fair * 99n) / 100n))
        expect(await rep.balanceOf(alice.address)).to.be.gte((fair * 99n) / 100n)
      })

      it('a cross-chain SELL: without a minimum the seller is paid a third; with one, the bag comes back and the attacker is out of pocket', async () => {
        const { w, token } = await launched()
        const [base, opt] = [w.at(HOME), w.at(6)]
        await w.fund(opt, bob, 1_000)
        await w.step(() => w.buy(opt, bob, token, 1_000))
        const rep = await w.replica(opt, token)
        const bag = await rep.balanceOf(bob.address)
        // the attacker holds a bag of their own on the hub chain
        const s = await attacker(w, 6_000)
        await w.step(() => s.buy(base.gateway.target, base.dollar.target, base.usd.target, token, U(6_000)))
        const repBase = await w.replica(base, token)
        const held = await repBase.balanceOf(s.target)
        const fair = await paidFor(w, opt, bob, token, bag)
        const attack = () => s.aroundSell(base.gateway.target, base.dollar.target, base.usd.target, token, w.endpoint.target, 0)

        const naked = await peek(async () => {
          const usdc = await opt.dollar.balanceOf(bob.address)
          await (await w.sell(opt, bob, token, bag)).wait()
          await (await attack()).wait() // sell first, land the victim's sale at the bottom, buy back
          await w.deliverAll()
          return { paid: ((await opt.dollar.balanceOf(bob.address)) - usdc) * opt.SCALE, held: await repBase.balanceOf(s.target) }
        })
        expect(naked.paid * 100n).to.be.lt(fair * 33n) // a third of what the bag was worth (32.7%)
        expect(naked.paid * 100n).to.be.gt(fair * 32n)
        expect(naked.held).to.be.gt((held * 124n) / 100n) // and the attacker's bag grew by a quarter (24.9%)

        const worth = await w.worth(opt, bob)
        await (await sellMin(opt, bob, token, bag, (fair * 99n) / 100n)).wait()
        const tx = await attack()
        await expect(tx).to.emit(w.pad, 'Refused').withArgs(3, 6, b32(token), b32(bob.address), bag, 6)
        await w.deliverAll()
        expect(await rep.balanceOf(bob.address)).to.equal(bag) // the bag is back, unsold
        expect(await w.worth(opt, bob)).to.equal(worth)
        // the attacker sold and re-bought into nobody: two fees, a bag 1.1% smaller
        expect(await repBase.balanceOf(s.target)).to.be.lt((held * 990n) / 1000n)
        expect(await repBase.balanceOf(s.target)).to.be.gt((held * 988n) / 1000n)
        await w.check()
        // (the attacker's round trip left the price a little lower: the same order with room for it fills)
        await w.step(() => sellMin(opt, bob, token, bag, (fair * 90n) / 100n))
        expect(await rep.balanceOf(bob.address)).to.equal(0n)
      })
    })

    it('gas cannot turn a trade back: delivered with any gas, a buy or a sell under its minimum-that-is-met reverts or fills — and a delivery is minted, never parked', async () => {
      const { w, token } = await launched()
      const opt = w.at(6)
      await w.fund(opt, alice, 5_000)
      await w.step(() => w.buy(opt, alice, token, 1_000))
      const rep = await w.replica(opt, token)

      const sweep = async (label, outcomeOf, top = 4_000_000) => {
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
        let lo = 20_000
        let hi = top
        expect(await tryWith(hi), label).to.equal('done')
        expect(await tryWith(lo), label).to.equal('reverted')
        while (hi - lo > 500) {
          const mid = Math.floor((lo + hi) / 2)
          if ((await tryWith(mid)) === 'reverted') lo = mid
          else hi = mid
        }
        const outcomes = new Set()
        for (let gas = Math.max(20_000, hi - 250_000); gas <= hi + 20_000; gas += 3_100) {
          const r = await tryWith(gas)
          outcomes.add(r)
          expect(r === 'reverted' || r === 'done', `${label}, gas ${gas}: ${r}`).to.equal(true)
        }
        expect([...outcomes].sort()).to.deep.equal(['done', 'reverted'])
      }
      const refused = (rc) => events(rc, w.pad, 'Refused').length > 0

      // a BUY whose minimum the curve meets: it must never come back "refused" for want of gas
      const out = await fillOf(w, opt, alice, token, 200)
      await (await buyMin(opt, alice, token, 200, out)).wait()
      await sweep('buy', (rc) => (refused(rc) ? 'turned back' : 'done'))
      // …and the DELIVER it causes, on the spoke: minted, or not delivered at all
      await (await w.endpoint.deliverNext()).wait()
      expect(unpack(await w.endpoint.peek(0)).op).to.equal(11)
      await sweep('deliver', (rc) => (events(rc, opt.gateway, 'DeliveryParked').length > 0 ? 'parked' : 'done'), 2_000_000)
      await w.deliverAll()

      // a SELL whose minimum the curve meets
      const part = (await rep.balanceOf(alice.address)) / 2n
      const net = await paidFor(w, opt, alice, token, part)
      await (await sellMin(opt, alice, token, part, net)).wait()
      await sweep('sell', (rc) => (refused(rc) ? 'turned back' : 'done'))
      await w.deliverAll()

      // holder fees pulled to the spoke: booked into the pool, or not delivered at all
      expect(await w.pad.pendingDrop(token, 6)).to.be.gt(0n)
      await (await opt.gateway.connect(alice).pullFees(token, { value: await opt.gateway.quotePull() })).wait()
      await (await w.endpoint.deliverNext()).wait()
      expect(unpack(await w.endpoint.peek(0)).op).to.equal(13)
      await sweep('fee drop', (rc) => (events(rc, opt.gateway, 'FeeDropParked').length > 0 ? 'parked' : 'done'), 2_000_000)
    })
  })

  /* ====================================================================== */
  /*  B — the reply budget must arrive                                       */
  /* ====================================================================== */

  describe('B. the reply budget rides in the envelope and must arrive with the message', () => {
    it('a packet delivered with less than its budget is refused and stays deliverable; the tank never pays an unfunded reply', async () => {
      const { w, token } = await launched()
      const opt = w.at(6)
      await w.fund(opt, alice, 1_000)
      await (await w.buy(opt, alice, token, 100)).wait()

      // the budget is the envelope's last word — the very number in the executor option
      const pkt = await w.endpoint.peek(0)
      const [sender, target, payload, value] = coder.decode(ENVELOPE, pkt.message)
      expect([sender, target]).to.deep.equal([b32(opt.gateway.target), b32(w.pad.target)])
      expect(value).to.equal(UNIT)
      expect(pkt.value).to.equal(UNIT)
      expect(pkt.options).to.equal(opts(MOCK_GAS_TO_HUB, UNIT))
      expect(pkt.message).to.equal(coder.encode(ENVELOPE, [sender, target, payload, UNIT]))

      // LayerZero lets anyone execute a verified packet, with any value. With none — or a wei
      // short — the hub's adapter turns the delivery away, whoever makes it
      const tank = await w.tank()
      const books = await w.hubUsd.totalSupply()
      for (const short of [0n, 1n, UNIT - 1n]) {
        await expect(w.endpoint.connect(stranger).deliverAtWithValue(0, short)).to.be.revertedWith('LZM: value')
      }
      expect(await w.endpoint.pending()).to.equal(1n) // still there
      expect(await w.tank()).to.equal(tank) // not a wei left the tank
      expect(await w.hubUsd.totalSupply()).to.equal(books)

      // whoever brings the budget lands it — the executor, or anyone else
      await (await w.endpoint.connect(stranger).deliverAtWithValue(0, UNIT)).wait()
      expect((await w.tank()) - tank).to.equal(UNIT - FEE)
      // the hub's own reply carries no budget: it is delivered with nothing
      const reply = await w.endpoint.peek(0)
      expect(coder.decode(ENVELOPE, reply.message)[3]).to.equal(0n)
      expect(reply.options).to.equal(opts(GAS_TO_SPOKE))
      await (await w.endpoint.connect(stranger).deliverAtWithValue(0, 0)).wait()
      expect(await (await w.replica(opt, token)).balanceOf(alice.address)).to.be.gt(0n)
      await w.check()

      // more than the budget is a gift to the tank
      await (await w.buy(opt, alice, token, 100)).wait()
      const t2 = await w.tank()
      await (await w.endpoint.connect(stranger).deliverAtWithValue(0, UNIT + E('0.003'), { value: E('0.003') })).wait()
      expect((await w.tank()) - t2).to.equal(UNIT + E('0.003') - FEE)
      await w.deliverAll()
    })

    it('it holds for every kind of message, in proportion to its legs — a spawn, an open, a move', async () => {
      const w = await deployMixed()
      const [opt, bnb] = [w.at(6), w.at(4)]
      await w.fund(opt, dev, 100)
      // a spawn with a dev buy prepays four SYNCs and the DELIVER
      await (await w.spawn(opt, dev, { devBuy: 20 })).wait()
      expect(coder.decode(ENVELOPE, (await w.endpoint.peek(0)).message)[3]).to.equal(5n * UNIT)
      await expect(w.endpoint.deliverAtWithValue(0, 4n * UNIT)).to.be.revertedWith('LZM: value')
      expect(await w.pad.tokensLength()).to.equal(0n)
      await w.deliverAll()
      const token = await w.lastToken()

      await w.claim(bnb, alice, 50)
      await (await w.move(bnb, alice, 6, b32(alice.address), E(50))).wait()
      await expect(w.endpoint.deliverAtWithValue(0, 0)).to.be.revertedWith('LZM: value')
      expect(await bnb.usd.balanceOf(alice.address)).to.equal(0n) // burned, in flight — and safe: the packet waits
      await w.deliverAll()
      expect(await opt.usd.balanceOf(alice.address)).to.equal(E(50))

      await (await opt.gateway.connect(alice).openToken(stranger.address, { value: await opt.gateway.quoteOpen() })).wait()
      await expect(w.endpoint.deliverAtWithValue(0, UNIT - 1n)).to.be.revertedWith('LZM: value')
      await w.deliverAll()
      void token
      await w.check()
    })

    it('whatever the envelope says must be brought: a budget named and not attached is refused, at any amount', async () => {
      const { w } = await launched()
      const opt = w.at(6)
      const payload = op(6, ['bytes32'], [b32(stranger.address)]) // an open for a token the hub never spawned
      const from = [EID(6), b32(opt.messenger.target), w.hubMessenger.target]
      // The three-field envelope of v7.1 is not rejected for its shape — ABI decoding does not
      // insist on canonical offsets — but it reads as an envelope whose budget is the LENGTH of its
      // payload, in wei, and is refused for not bringing it. Every adapter of a deployment is the
      // same generation, so this cannot arise; it is pinned so that nobody takes it for a check.
      const old = coder.encode(['bytes32', 'bytes32', 'bytes'], [b32(opt.gateway.target), b32(w.pad.target), payload])
      await expect(w.endpoint.inject(...from, old)).to.be.revertedWith('LZM: value')
      // an envelope saying it brings a budget it does not bring
      const promised = coder.encode(ENVELOPE, [b32(opt.gateway.target), b32(w.pad.target), payload, UNIT])
      await expect(w.endpoint.inject(...from, promised)).to.be.revertedWith('LZM: value')
      await expect(w.endpoint.inject(...from, promised, { value: UNIT - 1n })).to.be.revertedWith('LZM: value')
      await expect(w.endpoint.inject(...from, promised, { value: UNIT })).to.emit(w.pad, 'Refused')
      // and one that names none arrives with none
      const free = coder.encode(ENVELOPE, [b32(opt.gateway.target), b32(w.pad.target), payload, 0n])
      await expect(w.endpoint.inject(...from, free)).to.emit(w.pad, 'Refused')
    })
  })

  /* ====================================================================== */
  /*  C — executor gas per kind of message                                   */
  /* ====================================================================== */

  describe('C. executor gas per kind of message', () => {
    const GWEI_TENTH = 10n ** 8n // the price of one unit of executor gas on the mock, for these tests
    const SYNC = op(10, ['bytes32', 'string', 'string'], [ethers.ZeroHash, 'GLOOP', 'GLP'])
    const DELIVER = op(11, ['bytes32', 'bytes32', 'uint256', 'uint256'], [ethers.ZeroHash, ethers.ZeroHash, 0n, 0n])
    const PAYOUT = op(12, ['bytes32', 'uint256'], [ethers.ZeroHash, 0n])

    it('a kind of message can have its own gas: the quote, the option on the wire and the delivery all follow it; everything else keeps the chain\'s limit', async () => {
      const { w, token } = await launched()
      const [opt, arb] = [w.at(6), w.at(5)]
      await w.fund(opt, alice, 2_000)
      await (await w.endpoint.setGasPrice(GWEI_TENTH)).wait()
      const hubQuote = (label, payload) =>
        w.hubMessenger.connect(ethers.provider).quote(label, b32(w.at(label).gateway.target), payload, 0, { from: w.pad.target })

      // a price, like the others: the operator's
      await expect(opt.messenger.connect(stranger).setGasForOp(0, 2, 1)).to.be.revertedWith('ROLES: not operator')
      expect(await opt.messenger.gasForOp(0, 2)).to.equal(0n)

      // today: every message to the hub buys what the dearest one needs
      const q0 = { buy: await opt.gateway.quoteBuy(), sell: await opt.gateway.quoteSell(), spawn: await opt.gateway.quoteSpawn('X', 'X', '{}', false) }
      expect(q0.buy).to.equal(FEE + GWEI_TENTH * MOCK_GAS_TO_HUB + UNIT)

      // a BUY gets its own, smaller budget
      await expect(opt.messenger.setGasForOp(0, 2, 700_000)).to.emit(opt.messenger, 'GasForOpSet').withArgs(0, 2, 700_000)
      expect(await opt.messenger.gasForOp(0, 2)).to.equal(700_000n)
      const qBuy = await opt.gateway.quoteBuy()
      expect(qBuy).to.equal(FEE + GWEI_TENTH * 700_000n + UNIT)
      expect(q0.buy - qBuy).to.equal(GWEI_TENTH * (MOCK_GAS_TO_HUB - 700_000n)) // what a buyer no longer pays
      // a sell, a spawn: unchanged
      expect(await opt.gateway.quoteSell()).to.equal(q0.sell)
      expect(await opt.gateway.quoteSpawn('X', 'X', '{}', false)).to.equal(q0.spawn)
      // the quote is what the send requires, and the option on the wire says the same
      await expect(opt.gateway.connect(alice).buyTokenUsdc(token, U(100), { value: qBuy - 1n })).to.be.revertedWith('LZM: fee')
      await (await opt.gateway.connect(alice).buyTokenUsdc(token, U(100), { value: qBuy })).wait()
      let pkt = await w.endpoint.peek(0)
      expect(pkt.options).to.equal(opts(700_000n, UNIT))
      expect(pkt.gas).to.equal(700_000n)
      // delivered with exactly that, it lands
      await (await w.endpoint.deliverNext()).wait()

      // on the hub: a DELIVER and a PAYOUT to a spoke no longer buy a replica deployment's worth
      expect(await hubQuote(6, DELIVER)).to.equal(FEE + GWEI_TENTH * GAS_TO_SPOKE)
      await (await w.endpoint.deliverNext()).wait() // (the DELIVER of the buy above, at the old limit)
      await (await w.hubMessenger.setGasForOp(6, 11, 300_000)).wait()
      await (await w.hubMessenger.setGasForOp(6, 12, 200_000)).wait()
      expect(await hubQuote(6, DELIVER)).to.equal(FEE + GWEI_TENTH * 300_000n)
      expect(await hubQuote(6, PAYOUT)).to.equal(FEE + GWEI_TENTH * 200_000n)
      expect(await hubQuote(6, SYNC)).to.equal(FEE + GWEI_TENTH * GAS_TO_SPOKE) // a SYNC still gets the chain's limit
      expect(await hubQuote(5, DELIVER)).to.equal(FEE + GWEI_TENTH * GAS_TO_SPOKE) // and another chain is another chain
      void arb

      // a round trip on those budgets: each message carries its own gas, and lands inside it
      await (await opt.gateway.connect(alice).buyTokenUsdc(token, U(100), { value: qBuy })).wait()
      await (await w.endpoint.deliverNext()).wait()
      pkt = await w.endpoint.peek(0)
      expect([unpack(pkt).op, pkt.gas]).to.deep.equal([11, 300_000n])
      expect(pkt.options).to.equal(opts(300_000n))
      await (await w.endpoint.deliverNext()).wait()
      const rep = await w.replica(opt, token)
      const bag = await rep.balanceOf(alice.address)
      expect(bag).to.be.gt(0n)
      await (await opt.gateway.connect(alice).sellToken(token, bag, { value: await opt.gateway.quoteSell() })).wait()
      expect((await w.endpoint.peek(0)).gas).to.equal(MOCK_GAS_TO_HUB) // a SELL has no budget of its own here
      await (await w.endpoint.deliverNext()).wait()
      pkt = await w.endpoint.peek(0)
      expect([unpack(pkt).op, pkt.gas]).to.deep.equal([12, 200_000n])
      await (await w.endpoint.deliverNext()).wait()
      expect(await rep.balanceOf(alice.address)).to.equal(0n)
      await w.check()

      // back to the chain's limit
      await (await opt.messenger.setGasForOp(0, 2, 0)).wait()
      expect(await opt.gateway.quoteBuy()).to.equal(q0.buy)
    })

    it('a closed destination stays closed; a budget set too low is a delivery to make again with more gas, not a lost message', async () => {
      const { w, token } = await launched()
      const opt = w.at(6)
      await w.fund(opt, alice, 1_000)
      await (await opt.messenger.setGasForOp(0, 2, 700_000)).wait()

      // `gasLimit = 0` is the operator's switch for a leg: an override does not reopen it
      await (await opt.messenger.setDestination(0, 0, UNIT)).wait()
      await expect(opt.gateway.quoteBuy()).to.be.revertedWith('LZM: no gas limit')
      await expect(opt.gateway.connect(alice).buyTokenUsdc(token, U(10), { value: E('0.01') })).to.be.revertedWith('LZM: no gas limit')
      await (await opt.messenger.setDestination(0, MOCK_GAS_TO_HUB, UNIT)).wait()

      // far too little for a buy: the executor's delivery runs out of gas…
      await (await opt.messenger.setGasForOp(0, 2, 60_000)).wait()
      await (await w.buy(opt, alice, token, 100)).wait()
      expect((await w.endpoint.peek(0)).gas).to.equal(60_000n)
      await expect(w.endpoint.deliverNext()).to.be.reverted
      expect(await w.endpoint.pending()).to.equal(1n) // …and the packet waits
      expect(await opt.dollar.balanceOf(opt.usd.target)).to.equal(U(100)) // the money is in the vault
      // anyone delivers it with enough
      await (await w.endpoint.connect(stranger).deliverAtWithGas(0, 1_000_000)).wait()
      await w.deliverAll()
      expect(await (await w.replica(opt, token)).balanceOf(alice.address)).to.be.gt(0n)
      await w.check()
    })

    it('the hub\'s ceiling for a request is per kind too: an open is covered up to what an open prepays, a move up to what a move prepays', async () => {
      // With gas per kind a PAYOUT costs a fraction of a SYNC toward the same chain. One ceiling for
      // both would have to sit at the SYNC's price — and would then let the tank front several times
      // what a move prepaid, every time the price of a PAYOUT rose that far.
      const { w, token } = await launched()
      const [eth, bnb] = [w.at(2), w.at(4)]
      await (await w.endpoint.setGasPrice(GWEI_TENTH)).wait()
      await (await w.hubMessenger.setGasForOp(2, 12, 200_000)).wait() // a PAYOUT to Ethereum: a tenth of a SYNC's gas
      const hubQuote = (payload) =>
        w.hubMessenger.connect(ethers.provider).quote(2, b32(eth.gateway.target), payload, 0, { from: w.pad.target })
      const payoutFee = await hubQuote(PAYOUT)
      const syncFee = await hubQuote(SYNC)
      expect(payoutFee).to.equal(FEE + GWEI_TENTH * 200_000n)
      expect(syncFee).to.equal(FEE + GWEI_TENTH * GAS_TO_SPOKE)

      // the operator's, and one kind at a time
      await expect(w.pad.connect(stranger).setRequestCap(2, 12, 1)).to.be.revertedWith('ROLES: not operator')
      await expect(w.pad.setRequestCap(2, 12, payoutFee)).to.emit(w.pad, 'RequestCapSet').withArgs(2, 12, payoutFee)
      await (await w.pad.setRequestCap(2, 10, syncFee)).wait()
      expect(await w.pad.requestCap(2, 12)).to.equal(payoutFee)
      expect(await w.pad.requestCap(2, 10)).to.equal(syncFee)

      // at these prices both go through
      await w.claim(bnb, alice, 100)
      await w.step(() => w.move(bnb, alice, 2, b32(alice.address), E(10)), { tankMayFall: true })
      expect(await eth.usd.balanceOf(alice.address)).to.equal(E(10))

      // the price of gas on Ethereum doubles: a PAYOUT now costs more than a move prepaid, but
      // still far less than the SYNC's ceiling. The move comes home; the tank fronts nothing for it.
      await (await w.endpoint.setGasPrice(2n * GWEI_TENTH)).wait()
      expect(await hubQuote(PAYOUT)).to.be.gt(payoutFee)
      expect(await hubQuote(PAYOUT)).to.be.lt(syncFee)
      await (await w.move(bnb, alice, 2, b32(alice.address), E(10))).wait()
      await expect(w.endpoint.deliverNext())
        .to.emit(w.pad, 'Moved')
        .withArgs(4, 2, b32(alice.address), b32(alice.address), E(10), false)
      await w.deliverAll()
      expect(await eth.usd.balanceOf(alice.address)).to.equal(E(10))
      expect(await w.worth(bnb, alice)).to.equal(E(90))

      // a ceiling set for one kind does nothing for the other, and no other key is read
      await (await w.endpoint.setGasPrice(GWEI_TENTH)).wait()
      await (await w.pad.setRequestCap(2, 12, 0)).wait()
      await (await w.pad.setRequestCap(2, 11, E(1))).wait()
      await (await w.pad.setRequestCap(2, 7, E(1))).wait()
      await (await w.move(bnb, alice, 2, b32(alice.address), E(10))).wait()
      await expect(w.endpoint.deliverNext())
        .to.emit(w.pad, 'Moved')
        .withArgs(4, 2, b32(alice.address), b32(alice.address), E(10), false) // moves into Ethereum are closed…
      await w.deliverAll()
      // …while opens of it are not (the hub has one switch per kind: this is how incoming claims are
      // stopped toward one chain without closing anything else)
      await (await w.pad.setSyncCap(2, 1n)).wait()
      await w.step(() => w.spawn(w.at(HOME), dev, { name: 'SECOND', symbol: 'SND' }), { tankMayFall: true })
      const second = await w.lastToken()
      expect(await w.replicated(second)).to.deep.equal([3, 4, 5, 6])
      await (await eth.messenger.setDestination(0, MOCK_GAS_TO_HUB, syncFee)).wait() // an open from Ethereum prepays a SYNC to it
      await (await eth.gateway.connect(alice).openToken(second, { value: await eth.gateway.quoteOpen() })).wait()
      await expect(w.endpoint.deliverNext()).to.emit(w.pad, 'Resynced').withArgs(second, 2)
      await w.deliverAll()
      expect(await w.replicated(second)).to.deep.equal([2, 3, 4, 5, 6])
      void token
      await w.check()
    })

    it('the op is read where every payload has it; a message too short to have one gets the chain\'s limit', async () => {
      const { w } = await launched()
      const opt = w.at(6)
      await (await w.endpoint.setGasPrice(GWEI_TENTH)).wait()
      // a SELL gets 900k, a BUY one unit of gas: only the right byte of the payload picks the right one
      await (await opt.messenger.setGasForOp(0, 3, 900_000)).wait()
      await (await opt.messenger.setGasForOp(0, 2, 1)).wait()
      expect(await opt.gateway.quoteSell()).to.equal(FEE + GWEI_TENTH * 900_000n + UNIT)
      expect(await opt.gateway.quoteBuy()).to.equal(FEE + GWEI_TENTH * 1n + UNIT)
      expect(await opt.gateway.quoteClaim()).to.equal(FEE + GWEI_TENTH * MOCK_GAS_TO_HUB + UNIT) // op 4: none set
      // a registered sender with an empty payload: no op, the chain's limit
      await (await opt.messenger.register(stranger.address, 6)).wait()
      expect(await opt.messenger.connect(stranger).quote(0, b32(w.pad.target), '0x', 0)).to.equal(FEE + GWEI_TENTH * MOCK_GAS_TO_HUB)
      expect(await opt.messenger.connect(stranger).quote(0, b32(w.pad.target), '0x' + '00'.repeat(31), 0)).to.equal(FEE + GWEI_TENTH * MOCK_GAS_TO_HUB)
    })
  })

  /* ====================================================================== */
  /*  D — a chain where an account costs money; the floor; the legs          */
  /* ====================================================================== */

  describe('D. what the frozen hub owes a chain where creating an account costs money', () => {
    const RENT = E('0.003') // that chain's unit on the hub adapter: what a message may make it create
    const KEY = '0x' + 'ab'.repeat(32) // an account over there
    const STORE = '0x' + 'c1'.repeat(32) // its gateway: a 32-byte id

    /** The mixed universe plus a sixth chain on label 1 that is NOT an EVM
     * chain: a wide gateway id, a route to a sink standing for its adapter,
     * and — alone among the hub's destinations — a reply unit. */
    async function withSixth() {
      const { w, token } = await launched()
      const sink = await ethers.deployContract('PacketSink')
      await (await w.hubMessenger.setRoute(1, EID(1), b32(sink.target))).wait()
      await (await w.hubMessenger.setDestination(1, 300_000, RENT)).wait()
      await (await w.pad.setGateway(1, STORE)).wait()
      /** The queued packets bound for label 1. */
      const toSixth = async () => {
        const out = []
        for (let i = 0n; i < (await w.endpoint.pending()); i++) {
          const pkt = await w.endpoint.peek(i)
          if (pkt.dstEid === BigInt(EID(1))) out.push(pkt)
        }
        return out
      }
      return { w, token, sink, toSixth }
    }
    const asHub = async (w) => {
      const { impersonateAccount, setBalance } = require('@nomicfoundation/hardhat-network-helpers')
      await impersonateAccount(w.hubMessenger.target)
      const tank = await w.tank()
      await setBalance(w.hubMessenger.target, tank + E(1)) // gas for the impersonated calls
      return ethers.getSigner(w.hubMessenger.target)
    }

    it('a message the pad is free to skip carries one reply unit of native value: nothing toward an EVM chain, the rent toward the sixth — and the ceilings count it', async () => {
      const { w, token, sink, toSixth } = await withSixth()
      const [opt, bnb] = [w.at(6), w.at(4)]
      // the hub adapter prices NO EVM leg — the hub chain's own gateway included — and one chain only
      for (const c of w.chains) expect(await w.hubMessenger.returnUnit(c.label), c.id).to.equal(0n)
      expect(await w.hubMessenger.returnUnit(1)).to.equal(RENT)

      // ── a launch: every SYNC leaves with one leg; only the sixth chain's is worth anything
      let tank = await w.tank()
      await (await w.spawn(opt, dev, { name: 'RENT', symbol: 'RNT' })).wait()
      await (await w.endpoint.deliverNext()).wait() // the SPAWN lands on the hub
      const second = await w.lastToken()
      expect(await w.endpoint.pending()).to.equal(5n) // four remote EVM chains and the sixth
      for (let i = 0n; i < 5n; i++) {
        const pkt = await w.endpoint.peek(i)
        expect(unpack(pkt).op).to.equal(10)
        const sixth = pkt.dstEid === BigInt(EID(1))
        expect(pkt.value, `to ${pkt.dstEid}`).to.equal(sixth ? RENT : 0n)
        expect(pkt.options).to.equal(sixth ? opts(300_000n, RENT) : opts(GAS_TO_SPOKE))
        expect(coder.decode(ENVELOPE, pkt.message)[3]).to.equal(sixth ? RENT : 0n) // and it must ARRIVE with it
      }
      // four prepaid legs in; four plain SYNCs and one that carries its rent out
      expect((await w.tank()) - tank).to.equal(4n * UNIT - 4n * FEE - (FEE + RENT))
      await w.deliverAll()
      expect(await sink.packets()).to.equal(1n)
      expect(await sink.lastValue()).to.equal(RENT) // the replica's accounts are paid for by the message that asks for them
      expect(await bal(sink)).to.equal(RENT)

      // ── the launch ceiling counts the value: one wei under the whole price, the chain is skipped
      await (await w.pad.setSyncCap(1, FEE + RENT - 1n)).wait()
      tank = await w.tank()
      await (await w.spawn(opt, dev, { name: 'CAPPED', symbol: 'CAP' })).wait()
      await expect(w.endpoint.deliverNext()).to.emit(w.pad, 'SyncFailed')
      expect(await toSixth()).to.have.length(0)
      expect((await w.tank()) - tank).to.equal(4n * (UNIT - FEE))
      await w.deliverAll()
      const capped = await w.lastToken()
      await (await w.pad.setSyncCap(1, FEE + RENT)).wait()
      await (await w.spawn(opt, dev, { name: 'OPEN', symbol: 'OPN' })).wait()
      await (await w.endpoint.deliverNext()).wait()
      expect(await toSixth()).to.have.length(1)
      await w.deliverAll()

      // ── a paid resync: its caller pays the rent with the rest
      expect(await w.syncQuote(capped, 1)).to.equal(FEE + RENT)
      await expect(w.pad.connect(stranger).resync(capped, 1, { value: FEE + RENT - 1n })).to.be.revertedWith('PAD: fee')
      await expect(w.pad.connect(stranger).resync(capped, 1, { value: FEE })).to.be.revertedWith('PAD: fee')
      tank = await w.tank()
      await (await w.pad.connect(stranger).resync(capped, 1, { value: FEE + RENT })).wait()
      expect(await w.tank()).to.equal(tank)
      expect((await toSixth())[0].value).to.equal(RENT)
      await w.deliverAll()
      // …and toward an EVM chain a resync costs what it did (its leg is worth nothing)
      expect(await w.syncQuote(capped, 6)).to.equal(FEE)
      expect(await w.syncQuote(capped, HOME)).to.equal(0n)

      // ── a claim moved to an account that chain may have to open: the request ceiling counts the rent too
      await w.claim(bnb, alice, 100)
      await (await bnb.gateway.setMoveLegs(1, 4)).wait() // four of BNB's units: the message, and the rent
      await (await w.pad.setRequestCap(1, 12, FEE + RENT - 1n)).wait()
      await (await w.move(bnb, alice, 1, KEY, E(10))).wait()
      await expect(w.endpoint.deliverNext()).to.emit(w.pad, 'Moved').withArgs(4, 1, b32(alice.address), KEY, E(10), false)
      await w.deliverAll()
      expect(await w.worth(bnb, alice)).to.equal(E(100)) // home
      await (await w.pad.setRequestCap(1, 12, FEE + RENT)).wait()
      tank = await w.tank()
      const before = await sink.packets()
      await (await w.move(bnb, alice, 1, KEY, E(10))).wait()
      await expect(w.endpoint.deliverNext()).to.emit(w.pad, 'Moved').withArgs(4, 1, b32(alice.address), KEY, E(10), true)
      const [payout] = await toSixth()
      expect([unpack(payout).op, payout.value]).to.deep.equal([12, RENT])
      expect((await w.tank()) - tank).to.equal(4n * UNIT - (FEE + RENT)) // the mover paid for it, margin included
      await w.deliverAll()
      expect((await sink.packets()) - before).to.equal(1n)
      expect(await sink.lastValue()).to.equal(RENT)

      // ── an open asked for FROM the sixth chain: the same leg, under the ceiling for a SYNC
      const hub = await asHub(w)
      await (await w.pad.setRequestCap(1, 10, FEE + RENT)).wait()
      await expect(w.pad.connect(hub).onOmniMessage(1, STORE, op(6, ['bytes32'], [b32(token)])))
        .to.emit(w.pad, 'Resynced')
        .withArgs(token, 1)
      expect((await toSixth())[0].value).to.equal(RENT)
      await w.deliverAll()

      // ── REPLIES carry nothing: their recipient acted on that chain already, there is nothing to create
      await (await w.pad.connect(hub).onOmniMessage(1, STORE, op(2, TRADE, [b32(token), KEY, E(50), 0n]))).wait()
      let [reply] = await toSixth()
      expect([unpack(reply).op, reply.value]).to.deep.equal([11, 0n])
      expect(reply.options).to.equal(opts(300_000n))
      const bag = coder.decode(['bytes32', 'bytes32', 'uint256', 'uint256'], unpack(reply).data)[2]
      await w.deliverAll()
      await (await w.pad.connect(hub).onOmniMessage(1, STORE, op(3, TRADE, [b32(token), KEY, bag, 0n]))).wait()
      ;[reply] = await toSixth()
      expect([unpack(reply).op, reply.value]).to.deep.equal([12, 0n])
      await w.deliverAll()
      void second
    })

    it('the hub adapter must price no EVM leg: what a unit set there by mistake would break (the tooling must check it)', async () => {
      const { w, token } = await launched()
      const [base, opt, bnb] = [w.at(HOME), w.at(6), w.at(4)]
      await w.claim(bnb, alice, 100)
      // as deployed: a move toward the hub chain fits under its ceiling of nothing, a resync toward it is free
      expect(await w.pad.requestCap(HOME, 12)).to.equal(0n)
      await w.step(() => w.move(bnb, alice, HOME, b32(alice.address), E(10)))
      expect(await base.usd.balanceOf(alice.address)).to.equal(E(10))
      expect(await w.syncQuote(token, HOME)).to.equal(0n)

      // a reply unit on the hub chain's own label
      await (await w.hubMessenger.setDestination(HOME, 0, UNIT)).wait()
      expect(await w.syncQuote(token, HOME)).to.equal(UNIT) // a local SYNC is no longer free…
      await expect(w.pad.connect(stranger).resync(token, HOME)).to.be.revertedWith('PAD: fee')
      await (await w.move(bnb, alice, HOME, b32(alice.address), E(10))).wait()
      await expect(w.endpoint.deliverNext()) // …and a claim sent to the hub chain comes home
        .to.emit(w.pad, 'Moved')
        .withArgs(4, HOME, b32(alice.address), b32(alice.address), E(10), false)
      await w.deliverAll()
      expect(await base.usd.balanceOf(alice.address)).to.equal(E(10))
      await (await w.hubMessenger.setDestination(HOME, 0, 0)).wait()

      // a reply unit on a remote EVM label: every SYNC there carries a gift to that chain's tank, out of the hub's
      await (await w.hubMessenger.setDestination(6, GAS_TO_SPOKE, UNIT)).wait()
      const spoke = await bal(opt.messenger)
      const tank = await w.tank()
      await (await w.spawn(base, dev, { name: 'GIFT', symbol: 'GFT' })).wait()
      expect((await w.tank()) - tank).to.equal(4n * UNIT - 4n * FEE - UNIT)
      await w.deliverAll()
      expect((await bal(opt.messenger)) - spoke).to.equal(UNIT)
      await (await w.hubMessenger.setDestination(6, GAS_TO_SPOKE, 0)).wait()
      await w.check()
    })

    it('a spawn may prepay up to 128 legs (a launch that reaches Ethereum needs 15–30 of an L2\'s)', async () => {
      const w = await deployMixed()
      const opt = w.at(6)
      expect(await opt.gateway.MAX_SPAWN_LEGS()).to.equal(128n)
      await expect(opt.gateway.setLegs(1, 129)).to.be.revertedWith('GW: legs too high')
      await expect(opt.gateway.setLegs(1, 128)).to.emit(opt.gateway, 'LegsSet').withArgs(1, 128)
      expect(await opt.gateway.quoteSpawn('X', 'X', '{}', false)).to.equal(FEE + 128n * UNIT)
      const tank = await w.tank()
      await w.step(() => w.spawn(opt, dev))
      expect((await w.tank()) - tank).to.equal(128n * UNIT - 4n * FEE)
    })

    it('the floor: a call under `try` twenty times dearer than a real one still cannot be starved into a refusal', async () => {
      // A starved call leaves about depth/64 of what it needed. Measured on forks: at most 34,300 gas,
      // behind the hub chain's own replica deployment (0.77M, three frames deep). The floor is 200,000.
      // Here the QUOTE is made to cost 4M gas, two frames below the pad: starved, it leaves up to
      // ~125,000 — over a floor of 100,000, under this one.
      const { w } = await launched()
      const [base, opt] = [w.at(HOME), w.at(6)]
      await (await w.pad.setSyncCap(6, 1n)).wait()
      await w.step(() => w.spawn(base, dev, { name: 'FLOOR', symbol: 'FLR' }))
      const token = await w.lastToken()
      await (await w.open(opt, alice, token)).wait()
      await (await w.endpoint.setQuoteWork(4_000_000)).wait()
      const tryWith = (gas) =>
        peek(async () => {
          let rc
          try {
            // (a transaction may use 2^24 gas at most on this network: 16M leaves room for 12M inside)
            rc = await (await w.endpoint.deliverAtWithGas(0, gas, { gasLimit: 16_000_000 })).wait()
          } catch {
            return 'reverted'
          }
          return events(rc, w.pad, 'Resynced').length === 1 ? 'opened' : 'left closed'
        })
      expect(await tryWith(12_000_000)).to.equal('opened')
      const outcomes = new Set()
      for (let gas = 2_600_000; gas <= 9_400_000; gas += 85_000) {
        const r = await tryWith(gas)
        outcomes.add(r)
        expect(r, `gas ${gas}`).to.not.equal('left closed')
      }
      expect([...outcomes].sort()).to.deep.equal(['opened', 'reverted'])
    })
  })

  /* ====================================================================== */
  /*  ABI                                                                    */
  /* ====================================================================== */

  describe('what this round changes in the ABI', () => {
    it('the venue takes a minimum, the messenger says whether it answers at once, the adapter prices gas per op — and the gateway is untouched', async () => {
      const sig = async (name, fn) => new ethers.Interface((await artifacts.readArtifact(name)).abi).getFunction(fn)?.format('full')
      expect(await sig('ICurveVenue', 'execBuy')).to.equal(
        'function execBuy(address token, uint256 usdIn, uint256 minOut) returns (uint256 tokensOut, uint256 usdSpent, bool ascendedNow)',
      )
      expect(await sig('ICurveVenue', 'execSell')).to.equal('function execSell(address token, uint256 tokensIn, uint256 minOut) returns (uint256 usdOut)')
      expect(await sig('IOmniMessenger', 'isLocal')).to.equal('function isLocal(uint32 chain) view returns (bool)')
      expect(await sig('LocalOmniMessenger', 'isLocal')).to.equal('function isLocal(uint32) pure returns (bool)')
      expect(await sig('LayerZeroOmniMessenger', 'isLocal')).to.equal('function isLocal(uint32) view returns (bool)')
      expect(await sig('LayerZeroOmniMessenger', 'gasForOp')).to.equal('function gasForOp(uint32, uint8) view returns (uint128)')
      expect(await sig('LayerZeroOmniMessenger', 'setGasForOp')).to.equal('function setGasForOp(uint32 chainLabel, uint8 op, uint128 gas)')
      // the three protected entrypoints keep their signatures; they now work on every chain
      expect(await sig('SpawnGateway', 'buyTokenUsdcMin')).to.equal('function buyTokenUsdcMin(address hubToken, uint256 usdcIn, uint256 minTokensOut) payable')
      expect(await sig('SpawnGateway', 'buyTokenMin')).to.equal('function buyTokenMin(address hubToken, uint256 usdIn, uint256 minTokensOut) payable')
      expect(await sig('SpawnGateway', 'sellTokenMin')).to.equal('function sellTokenMin(address hubToken, uint256 tokens, uint256 minDollarsOut) payable')
    })
  })
})
