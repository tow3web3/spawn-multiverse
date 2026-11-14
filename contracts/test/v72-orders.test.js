const { expect } = require('chai')
const { ethers, artifacts } = require('hardhat')
const { time } = require('@nomicfoundation/hardhat-network-helpers')
const { U, GAS_TO_SPOKE, MOCK_GAS_TO_HUB } = require('../scripts/lib-deploy')
const {
  E, b32, coder, pastGenesis, FEE, UNIT, EID, TTL, HOME, op, unpack, peek, as, events, timeOf, deployMixed,
} = require('./mixed-world')

/** OP_BUY / OP_SELL data (v7.2): (token, trader, amount, minimum, deadline). */
const TRADE = ['bytes32', 'bytes32', 'uint256', 'uint256', 'uint256']
const MAX = ethers.MaxUint256
/** The exact type-3 executor option the adapter builds. */
const opts = (gas, value = 0n) =>
  value > 0n
    ? ethers.solidityPacked(['uint16', 'uint8', 'uint16', 'uint8', 'uint128', 'uint128'], [3, 1, 33, 1, gas, value])
    : ethers.solidityPacked(['uint16', 'uint8', 'uint16', 'uint8', 'uint128'], [3, 1, 17, 1, gas])

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
/** The pad's conversion of a seller's net minimum into the venue's gross one. */
const grossFor = (n) => (n === 0n ? 0n : n + (n - 1n) / 99n)
/** What `dollars` buy on the curve as it stands (1% fee off the top, rounding against the buyer). */
const curveBuy = (curve, dollars) => {
  const usdIn = dollars - dollars / 100n
  const k = curve.vBase * curve.vTokens
  return curve.vTokens - ((k - 1n) / (curve.vBase + usdIn) + 1n)
}

/**
 * The third and last round of protocol v7.2, before the hub and its transport
 * are frozen:
 *  - EVERY ORDER HAS A DEADLINE. A BUY and a SELL carry a fifth word, unix
 *    seconds, stamped by the gateway (`block.timestamp + orderTtl`) and read on
 *    the hub against the hub's clock — by the venue, next to the minimum. An
 *    order that lands after it is refused whole, exactly like one under its
 *    minimum. A minimum protects a fresh
 *    order; it does not protect one that sat undelivered while the price moved
 *    away from it — and orders get stuck when something of ours fails, many at
 *    once, with delivery open to anyone.
 *  - EXECUTOR GAS HAS A CEILING in the adapter (15,000,000).
 * On the mixed universe of test/v72.test.js.
 */
describe('Protocol v7.2 — orders expire; executor gas has a ceiling', () => {
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
  /** Lands the oldest packet in a block whose time is exactly `at`. */
  const landAt = async (w, at) => {
    await time.setNextBlockTimestamp(at)
    return w.endpoint.deliverNext()
  }

  /* ====================================================================== */
  /*  the deadline                                                           */
  /* ====================================================================== */

  describe('every order has a deadline', () => {
    it('every BUY and SELL leaves with its chain\'s time plus the lifetime as its fifth word — plain or with a minimum, in dollars or in oUSD, on a USDC chain and on the USDT one', async () => {
      const { w, token } = await launched()
      for (const c of [w.at(6), w.at(4)]) {
        expect(await c.gateway.orderTtl()).to.equal(TTL) // thirty minutes, from birth
        await w.fund(c, alice, 2_000)
        const rep = await w.replica(c, token)
        /** Sends an order and reads it off the wire. */
        const stamped = async (send, code, amount, min) => {
          const rc = await (await send()).wait()
          expect(await w.endpoint.pending()).to.equal(1n)
          expect(unpack(await w.endpoint.peek(0)), c.id).to.deep.equal({
            op: code,
            data: coder.encode(TRADE, [b32(token), b32(alice.address), amount, min, (await timeOf(rc)) + TTL]),
          })
          await w.deliverAll()
        }
        await stamped(() => w.buy(c, alice, token, 100), 2, E(100), 0n)
        await stamped(() => buyMin(c, alice, token, 100, 5n), 2, E(100), 5n)
        // oUSD already held (a claim): the same two entrypoints, the same wire
        await w.claim(c, alice, 80)
        await stamped(async () => c.gateway.connect(alice).buyToken(token, E(30), { value: await c.gateway.quoteBuy() }), 2, E(30), 0n)
        await stamped(async () => c.gateway.connect(alice).buyTokenMin(token, E(50), 7n, { value: await c.gateway.quoteBuy() }), 2, E(50), 7n)
        const part = (await rep.balanceOf(alice.address)) / 4n
        await stamped(() => w.sell(c, alice, token, part), 3, part, 0n)
        await stamped(() => sellMin(c, alice, token, part, 9n), 3, part, 9n)
        await w.check()
      }

      // the quote counts the word: with a price per byte, it is the fee of the very message that leaves
      const opt = w.at(6)
      const BYTE = ethers.parseUnits('1', 'gwei')
      await (await w.endpoint.setByteFee(BYTE)).wait()
      const [qBuy, qSell] = [await opt.gateway.quoteBuy(), await opt.gateway.quoteSell()]
      await expect(opt.gateway.connect(alice).buyTokenUsdc(token, U(10), { value: qBuy - 1n })).to.be.revertedWith('LZM: fee')
      await (await opt.gateway.connect(alice).buyTokenUsdc(token, U(10), { value: qBuy })).wait()
      expect(qBuy).to.equal(FEE + BYTE * BigInt(ethers.dataLength((await w.endpoint.peek(0)).message)) + UNIT)
      const bag = await (await w.replica(opt, token)).balanceOf(alice.address)
      await expect(opt.gateway.connect(alice).sellToken(token, bag / 2n, { value: qSell - 1n })).to.be.revertedWith('LZM: fee')
      await (await opt.gateway.connect(alice).sellToken(token, bag / 2n, { value: qSell })).wait()
      expect(qSell).to.equal(FEE + BYTE * BigInt(ethers.dataLength((await w.endpoint.peek(1)).message)) + UNIT)
      // (five words of data: 32 more bytes than the four of the second round)
      expect(ethers.dataLength(unpack(await w.endpoint.peek(0)).data)).to.equal(160)
      await w.deliverAll()
      await w.check()
    })

    it('a BUY that sat undelivered: at its deadline, to the second, it still fills — one second later every dollar comes home, in that chain\'s own dollar', async () => {
      const { w, token } = await launched()
      for (const c of [w.at(6), w.at(4)]) {
        await w.fund(c, alice, 1_000)
        const rep = await w.replica(c, token)
        const out = await fillOf(w, c, alice, token, 300)
        for (const min of [out, 0n]) {
          // an order with the minimum the market meets, then a plain one: a deadline needs no minimum
          const before = {
            dollars: await c.dollar.balanceOf(alice.address),
            bag: await rep.balanceOf(alice.address),
            books: await w.hubUsd.totalSupply(),
            curve: await w.pad.curves(token),
            fees: (await w.pad.feesOf(token)).total,
          }
          const send = () => (min === 0n ? w.buy(c, alice, token, 300) : buyMin(c, alice, token, 300, min))
          const deadline = (await timeOf(await (await send()).wait())) + TTL

          // the last second: the order is as good as new
          await peek(async () => {
            const landed = await landAt(w, deadline)
            expect(events(await landed.wait(), w.pad, 'Refused')).to.have.length(0)
            await w.deliverAll()
            expect((await rep.balanceOf(alice.address)) - before.bag).to.equal(out)
            expect(await c.dollar.balanceOf(alice.address)).to.equal(before.dollars - c.T(300))
            await w.check()
          })

          // one second late: refused whole (reason 6, like a fill under a minimum); nothing on the hub moved
          const tank = await w.tank()
          await expect(landAt(w, deadline + 1n))
            .to.emit(w.pad, 'Refused')
            .withArgs(2, c.label, b32(token), b32(alice.address), E(300), 6)
          expect(await w.hubUsd.totalSupply()).to.equal(before.books)
          expect(await w.pad.curves(token)).to.deep.equal(before.curve)
          expect((await w.pad.feesOf(token)).total).to.equal(before.fees) // not even a fee
          expect((await w.tank()) - tank).to.equal(UNIT - FEE) // the way home was prepaid, like any reply
          // …and the reply is a DELIVER of nothing with the whole order as its refund
          expect(unpack(await w.endpoint.peek(0))).to.deep.equal({
            op: 11,
            data: coder.encode(['bytes32', 'bytes32', 'uint256', 'uint256'], [b32(token), b32(alice.address), 0n, E(300)]),
          })
          await w.deliverAll()
          expect(await c.dollar.balanceOf(alice.address), c.id).to.equal(before.dollars) // every dollar, as dollars
          expect(await c.usd.balanceOf(alice.address)).to.equal(0n)
          expect(await rep.balanceOf(alice.address)).to.equal(before.bag)
          await w.check()
        }
      }
    })

    it('a SELL that sat undelivered: paid at its deadline, to the second — one second later the bag is delivered back, unsold', async () => {
      const { w, token } = await launched()
      for (const c of [w.at(6), w.at(4)]) {
        await w.fund(c, alice, 2_000)
        await w.step(() => w.buy(c, alice, token, 1_000))
        const rep = await w.replica(c, token)
        const bag = await rep.balanceOf(alice.address)
        const part = bag / 3n
        const net = await paidFor(w, c, alice, token, part)
        for (const min of [net, 0n]) {
          const before = {
            worth: await w.worth(c, alice),
            books: await w.hubUsd.totalSupply(),
            curve: await w.pad.curves(token),
            there: await w.pad.supplyByChain(token, c.label),
          }
          const send = () => (min === 0n ? w.sell(c, alice, token, part) : sellMin(c, alice, token, part, min))
          const deadline = (await timeOf(await (await send()).wait())) + TTL
          expect(await rep.balanceOf(alice.address)).to.equal(bag - part) // the spoke burned it: it is in flight

          await peek(async () => {
            const landed = await landAt(w, deadline)
            expect(events(await landed.wait(), w.pad, 'Refused')).to.have.length(0)
            await w.deliverAll()
            expect((await w.worth(c, alice)) - before.worth).to.equal(net)
            expect(await rep.balanceOf(alice.address)).to.equal(bag - part)
            await w.check()
          })

          await expect(landAt(w, deadline + 1n))
            .to.emit(w.pad, 'Refused')
            .withArgs(3, c.label, b32(token), b32(alice.address), part, 6)
          expect(await w.hubUsd.totalSupply()).to.equal(before.books)
          expect(await w.pad.curves(token)).to.deep.equal(before.curve)
          expect(await w.pad.supplyByChain(token, c.label)).to.equal(before.there) // the hub's ledger never moved
          expect(unpack(await w.endpoint.peek(0))).to.deep.equal({
            op: 11,
            data: coder.encode(['bytes32', 'bytes32', 'uint256', 'uint256'], [b32(token), b32(alice.address), part, 0n]),
          })
          await w.deliverAll()
          expect(await rep.balanceOf(alice.address), c.id).to.equal(bag) // the bag is whole again
          expect(await w.worth(c, alice)).to.equal(before.worth)
          await w.check()
        }
      }
    })

    it('the pad hands the deadline to the venue as it came, next to the minimum; the venue reads it against the hub\'s clock — 0 is none, the second itself is in time, the next is late, whatever clock wrote the word', async () => {
      // These orders are handed to the pad as a gateway's (nobody burned anything for them on a
      // spoke), so this test reads decisions, not balances.
      const order = (token, code, amount, min, deadline) => op(code, TRADE, [b32(token), b32(alice.address), amount, min, deadline])

      // ── WHAT THE PAD PASSES: a venue that writes down what it is handed, and trades regardless
      const rec = await launched({ venueName: 'RecordingVenue' })
      {
        const { w, token } = rec
        const opt = w.at(6)
        await w.fund(opt, alice, 2_000)
        // a real order first (it also puts supply on that chain, to sell from): the gateway's stamp reaches the venue
        const sent = await w.step(() => w.buy(opt, alice, token, 1_000))
        expect([await w.venue.lastBuyMin(), await w.venue.lastBuyDeadline()]).to.deep.equal([0n, (await timeOf(sent)) + TTL])
        // a launch's dev buy names neither a minimum nor a deadline
        await w.fund(w.at(HOME), dev, 100)
        await w.step(() => w.spawn(w.at(HOME), dev, { name: 'DEVBUY', symbol: 'DVB', devBuy: 20 }))
        expect([await w.venue.lastBuyMin(), await w.venue.lastBuyDeadline()]).to.deep.equal([0n, 0n])
        const hub = await as(w.hubMessenger.target)
        const seen = async (code, min, deadline) => {
          await (await w.pad.connect(hub).onOmniMessage(6, b32(opt.gateway.target), order(token, code, code === 2 ? E(10) : E(1_000), min, deadline))).wait()
          return code === 2 ? [await w.venue.lastBuyMin(), await w.venue.lastBuyDeadline()] : [await w.venue.lastSellMin(), await w.venue.lastSellDeadline()]
        }
        const now = BigInt(await time.latest())
        for (const deadline of [0n, 1n, now - 1n, now + 1_800n, MAX]) {
          // each word where it belongs, untouched — a minimum is not a deadline, and no arithmetic is done on either
          expect(await seen(2, 5n, deadline)).to.deep.equal([5n, deadline])
          expect(await seen(3, 100n, deadline)).to.deep.equal([grossFor(100n), deadline]) // (a seller's net minimum, as gross)
        }
        // (this venue ignores what it records, so a late order FILLED here: the deadline, like the
        // minimum, is the venue's to enforce — `ICurveVenue` says so, and the real one does, below)
        expect(await w.venue.lastBuyDeadline()).to.equal(MAX)
      }

      // ── WHAT THE VENUE DOES WITH IT: the real curve
      const { w, token } = await launched()
      const opt = w.at(6)
      await w.fund(opt, alice, 2_000)
      await w.step(() => w.buy(opt, alice, token, 1_000))
      const hub = await as(w.hubMessenger.target)
      const pad = await as(w.pad.target)
      const T = BigInt(await time.latest()) + 1_000n
      /** Lands a BUY and then a SELL at hub time `at` (and `at + 1`); true if both traded, false if both were refused. */
      const land = async (at, deadline) => {
        const outcomes = []
        for (const [code, amount, when] of [[2, E(10), at], [3, E(1_000), at + 1n]]) {
          await time.setNextBlockTimestamp(when)
          const rc = await (await w.pad.connect(hub).onOmniMessage(6, b32(opt.gateway.target), order(token, code, amount, 1n, deadline))).wait()
          const refused = events(rc, w.pad, 'Refused')
          if (refused.length) expect(refused[0].args.reason).to.equal(6n)
          expect(events(rc, w.pad, 'Trade').length + refused.length).to.equal(1)
          outcomes.push(refused.length === 0)
        }
        expect(outcomes[0], `deadline ${deadline} at ${at}`).to.equal(outcomes[1])
        return outcomes[0]
      }
      expect(await land(T, T + 1n)).to.equal(true) // the second itself is in time (the buy a second before, the sell on it)
      expect(await land(T + 2n, T + 1n)).to.equal(false) // the next one is late
      expect(await land(T + 4n, 0n)).to.equal(true) // 0: no deadline (the wire allows it; no gateway sends it)
      expect(await land(T + 6n, 1n)).to.equal(false) // long gone
      expect(await land(T + 8n, MAX)).to.equal(true) // a deadline at the end of time
      expect(await land(T + 10n, T + 10n + 86_400n)).to.equal(true) // a source clock a day ahead: alive, and bounded by its minimum
      expect(await land(T + 12n, T + 11n)).to.equal(false) // a source clock behind: late already

      // the venue's own word for it, before it looks at anything else (the boundary itself is above, in
      // real blocks: a simulated call has no block time of its own to pin a second on)
      const seenAt = BigInt(await time.latest())
      const v = w.venue.connect(pad)
      for (const late of [1n, seenAt - 3_600n, seenAt - 10n]) {
        await expect(v.execBuy.staticCall(token, E(10), 0, late)).to.be.revertedWith('VENUE: expired')
        await expect(v.execSell.staticCall(token, E(1_000), 0, late)).to.be.revertedWith('VENUE: expired')
        // …even for a trade it would refuse anyway: lateness comes first
        await expect(v.execBuy.staticCall(token, 0, 0, late)).to.be.revertedWith('VENUE: expired')
        await expect(v.execBuy.staticCall(stranger.address, E(10), 0, late)).to.be.revertedWith('VENUE: expired')
      }
      for (const inTime of [0n, seenAt + 3_600n, MAX]) {
        expect((await v.execBuy.staticCall(token, E(10), 0, inTime))[0]).to.be.gt(0n)
        expect(await v.execSell.staticCall(token, E(1_000), 0, inTime)).to.be.gt(0n)
      }
      // and only the pad may ask
      await expect(w.venue.connect(stranger).execBuy(token, E(10), 0, 0)).to.be.revertedWith('VENUE: not pad')

      // THE FOUR-WORD ORDER OF THE SECOND ROUND IS MALFORMED FOR THIS HUB: it reverts, on every
      // delivery, whatever it carries — a gateway that still sends it (in any language) strands its
      // traders' orders. Words after the fifth are ignored.
      const FOUR = ['bytes32', 'bytes32', 'uint256', 'uint256']
      for (const code of [2, 3]) {
        const short = op(code, FOUR, [b32(token), b32(alice.address), E(10), 0n])
        await expect(w.pad.connect(hub).onOmniMessage(6, b32(opt.gateway.target), short)).to.be.reverted
        const long = op(code, [...TRADE, 'uint256'], [b32(token), b32(alice.address), E(10), 0n, 0n, 7n])
        await expect(w.pad.connect(hub).onOmniMessage(6, b32(opt.gateway.target), long)).to.emit(w.pad, 'Trade')
      }
    })

    it('the incident: orders stuck behind an empty tank, a leg the operator closed and one that takes no message — repaired in time they fill; repaired after their deadline every one of them bounces whole', async () => {
      const { w, token } = await launched()
      const opt = w.at(6)
      await w.fund(opt, alice, 2_000)
      await w.fund(opt, bob, 2_000)
      await w.step(() => w.buy(opt, alice, token, 1_000))
      const rep = await w.replica(opt, token)
      const incidents = [
        {
          what: 'an empty tank (and a reply that got dear)',
          why: 'LZM: gas tank empty',
          start: async () => {
            await (await w.endpoint.setDstFee(EID(6), E('0.05'))).wait()
            await (await w.hubMessenger.recover(admin.address)).wait()
          },
          repair: async () => {
            await (await w.endpoint.setDstFee(EID(6), 0)).wait()
            await (await admin.sendTransaction({ to: w.hubMessenger.target, value: E(1) })).wait()
          },
        },
        {
          what: 'a leg the operator closed',
          why: 'LZM: no gas limit',
          start: async () => (await w.hubMessenger.setDestination(6, 0, 0)).wait(),
          repair: async () => (await w.hubMessenger.setDestination(6, GAS_TO_SPOKE, 0)).wait(),
        },
        {
          what: 'a leg that takes no message',
          why: 'ENDPOINT: send blocked',
          start: async () => (await w.endpoint.setSendBlocked(EID(6), true)).wait(),
          repair: async () => (await w.endpoint.setSendBlocked(EID(6), false)).wait(),
        },
      ]
      for (const { what, why, start, repair } of incidents) {
        const before = { dollars: await opt.dollar.balanceOf(bob.address), bag: await rep.balanceOf(alice.address), worth: await w.worth(opt, alice) }
        const part = before.bag / 4n
        const out = await fillOf(w, opt, bob, token, 200)
        const net = await paidFor(w, opt, alice, token, part)

        await start()
        // two orders with a 1% tolerance: the market meets both, now and for as long as nothing else trades
        const d1 = (await timeOf(await (await buyMin(opt, bob, token, 200, (out * 99n) / 100n)).wait())) + TTL
        const d2 = (await timeOf(await (await sellMin(opt, alice, token, part, (net * 99n) / 100n)).wait())) + TTL
        // neither can land: the hub cannot send what it would owe them, so it takes nothing
        await expect(w.endpoint.deliverAt(0), what).to.be.revertedWith(why)
        await expect(w.endpoint.deliverAt(1), what).to.be.revertedWith(why)
        expect(await w.endpoint.pending()).to.equal(2n)

        // repaired within the lifetime: both orders are still good, and fill
        await peek(async () => {
          await time.increase(600)
          await repair()
          await w.deliverAll()
          expect((await rep.balanceOf(bob.address)) * 100n).to.be.gte(out * 99n)
          expect(((await w.worth(opt, alice)) - before.worth) * 100n).to.be.gte(net * 99n)
          await w.check()
        })

        // repaired after it: whoever delivers them, and whenever, they are refunds
        await time.setNextBlockTimestamp(d2 + 1n)
        await repair()
        expect(d2).to.be.gte(d1)
        await expect(w.endpoint.connect(stranger).deliverNext())
          .to.emit(w.pad, 'Refused')
          .withArgs(2, 6, b32(token), b32(bob.address), E(200), 6)
        await expect(w.endpoint.connect(stranger).deliverNext())
          .to.emit(w.pad, 'Refused')
          .withArgs(3, 6, b32(token), b32(alice.address), part, 6)
        await w.deliverAll()
        expect(await opt.dollar.balanceOf(bob.address), what).to.equal(before.dollars)
        expect(await rep.balanceOf(bob.address)).to.equal(0n)
        expect(await rep.balanceOf(alice.address), what).to.equal(before.bag)
        expect(await w.worth(opt, alice)).to.equal(before.worth)
        await w.check()
      }
    })

    it('the stale order that was free money: the price falls while a buy is stuck — pump to its limit, deliver it, dump. In time that pays; after the deadline the buyer loses nothing and the attacker pays two fees', async () => {
      const { w, token } = await launched()
      const [base, opt] = [w.at(HOME), w.at(6)]
      await w.fund(base, carol, 5_000)
      await w.fund(opt, alice, 1_000)
      const rep = await w.replica(opt, token)
      // the market is high when the order is placed…
      await w.step(() => w.buy(base, carol, token, 5_000))
      const fair = await fillOf(w, opt, alice, token, 1_000)
      const min = (fair * 99n) / 100n // a careful buyer: 1% of slippage, no more
      // …and the order gets stuck (the leg home is closed: the hub will not take what it cannot answer)
      await (await w.hubMessenger.setDestination(6, 0, 0)).wait()
      const deadline = (await timeOf(await (await buyMin(opt, alice, token, 1_000, min)).wait())) + TTL
      await expect(w.endpoint.deliverNext()).to.be.revertedWith('LZM: no gas limit')
      // the price falls back while it waits
      const held = await (await w.replica(base, token)).balanceOf(carol.address)
      await (await w.sell(base, carol, token, held)).wait()
      await (await w.hubMessenger.setDestination(6, GAS_TO_SPOKE, 0)).wait() // the leg is repaired
      const fairNow = curveBuy(await w.pad.curves(token), E(1_000))
      expect(fairNow).to.be.gt(fair * 3n) // $1,000 now buys three times the order's minimum

      // the attacker: a contract on the hub chain. It buys the price back up to the order's limit,
      // lands the order there, and sells into the buyer's own money — one transaction, no risk
      const s = await ethers.deployContract('Sandwicher')
      await (await base.dollar.mint(s.target, base.T(5_000))).wait()
      const attack = () => s.aroundBuy(base.gateway.target, base.dollar.target, base.usd.target, token, U(5_000), w.endpoint.target, 0)
      const worthOf = async () => w.worth(base, { address: s.target })

      // ── delivered inside its lifetime: the minimum is met, so the minimum is no help
      const inTime = await peek(async () => {
        await time.setNextBlockTimestamp(deadline)
        const rc = await (await attack()).wait()
        expect(events(rc, w.pad, 'Refused')).to.have.length(0)
        expect(events(rc, w.pad, 'Trade')).to.have.length(3) // their buy, the victim's, their sell
        await w.deliverAll()
        return { bag: await rep.balanceOf(alice.address), profit: (await worthOf()) - E(5_000) }
      })
      expect(inTime.bag).to.be.gte(min)
      expect(inTime.bag * 100n).to.be.lt(fairNow * 35n) // a third of what the $1,000 were worth by then
      expect(inTime.profit).to.be.gt(E(550)) // and most of the rest in the attacker's pocket, fees paid
      expect(inTime.profit).to.be.lt(E(650))

      // ── one second after it: the same transaction
      await time.setNextBlockTimestamp(deadline + 1n)
      const tx = await attack()
      await expect(tx).to.emit(w.pad, 'Refused').withArgs(2, 6, b32(token), b32(alice.address), E(1_000), 6)
      expect(events(await tx.wait(), w.pad, 'Trade')).to.have.length(2) // only the attacker's own two
      await w.deliverAll()
      expect(await opt.dollar.balanceOf(alice.address)).to.equal(U(1_000)) // every dollar is home
      expect(await rep.balanceOf(alice.address)).to.equal(0n)
      const loss = E(5_000) - (await worthOf())
      expect(loss).to.be.gt(E(99)) // 1% in, 1% out, into nobody
      expect(loss).to.be.lt(E(100))
      if (process.env.PRINT_GAS) {
        console.log('stale order, in time: the buyer got', Number((inTime.bag * 1000n) / fairNow) / 10, '% of the fair fill; the attacker kept $' + ethers.formatEther(inTime.profit))
        console.log('stale order, late: the attacker lost $' + ethers.formatEther(loss))
      }
      await w.check()
    })

    it('a randomized sequence over both dollars, every order landed at a random second around its deadline: in time it trades, late it comes home whole — and the books balance after each', async () => {
      const { w, token } = await launched()
      const chains = [w.at(6), w.at(5), w.at(4)] // two USDC chains and the USDT one
      const users = [alice, bob, carol]
      for (const c of chains) {
        for (const u of users) {
          await w.fund(c, u, 5_000)
          await w.step(() => w.buy(c, u, token, 300))
        }
      }
      let seed = 0xdead11e5n
      const rnd = (mod) => {
        seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n
        return (seed >> 24n) % BigInt(mod)
      }
      const count = { filled: 0, bounced: 0 }
      for (let i = 0; i < 36; i++) {
        const c = chains[Number(rnd(3))]
        const u = users[Number(rnd(3))]
        const rep = await w.replica(c, token)
        const before = { worth: await w.worth(c, u), bag: await rep.balanceOf(u.address) }
        const isBuy = rnd(2) === 0n
        const sent = isBuy
          ? await (await w.buy(c, u, token, 20 + Number(rnd(400)))).wait()
          : await (await w.sell(c, u, token, before.bag / (2n + rnd(5)) + rnd(10n ** 18n))).wait()
        // two seconds early to two seconds late
        const offset = rnd(5) - 2n
        const landed = await (await landAt(w, (await timeOf(sent)) + TTL + offset)).wait()
        const late = offset > 0n
        expect(events(landed, w.pad, 'Refused').length, `order ${i}, offset ${offset}`).to.equal(late ? 1 : 0)
        expect(events(landed, w.pad, 'Trade').length, `order ${i}`).to.equal(late ? 0 : 1)
        await w.deliverAll()
        await w.check() // Σ vault dollars × SCALE == Σ oUSD supply; every token's supply is where the hub says
        const after = { worth: await w.worth(c, u), bag: await rep.balanceOf(u.address) }
        if (late) {
          expect(after, `order ${i}: home whole`).to.deep.equal(before)
          count.bounced++
        } else {
          expect(isBuy ? after.bag > before.bag && after.worth < before.worth : after.bag < before.bag && after.worth > before.worth).to.equal(true)
          count.filled++
        }
      }
      expect(count.filled).to.be.gte(8)
      expect(count.bounced).to.be.gte(8)
    })

    it('FAIR GENESIS: a buy that expires inside the window leaves the buyer\'s $250 cap intact, and no tax is taken', async () => {
      const w = await deployMixed()
      const opt = w.at(6)
      await (await opt.gateway.setOrderTtl(120)).wait()
      await w.step(() => w.spawn(w.at(HOME), dev))
      const token = await w.lastToken()
      const t0 = (await w.pad.metas(token)).spawnedAt
      await w.fund(opt, alice, 1_000)
      const rep = await w.replica(opt, token)

      const deadline = (await timeOf(await (await w.buy(opt, alice, token, 300)).wait())) + 120n
      expect(deadline + 1n).to.be.lt(t0 + 600n) // late, and still inside the genesis window
      await expect(landAt(w, deadline + 1n))
        .to.emit(w.pad, 'Refused')
        .withArgs(2, 6, b32(token), b32(alice.address), E(300), 6)
      await w.deliverAll()
      expect(await opt.dollar.balanceOf(alice.address)).to.equal(U(1_000))
      expect(await w.pad.genesisSpent(token, b32(alice.address))).to.equal(0n) // the cap is intact
      expect((await w.pad.feesOf(token)).total).to.equal(0n)
      await w.check()

      // the same buyer, in time: the cap is all there ($250 on the curve, $50 back)
      const d2 = (await timeOf(await (await w.buy(opt, alice, token, 300)).wait())) + 120n
      await landAt(w, d2)
      await w.deliverAll()
      expect(await w.pad.genesisSpent(token, b32(alice.address))).to.equal(E(250))
      expect(await opt.dollar.balanceOf(alice.address)).to.equal(U(750))
      expect(await rep.balanceOf(alice.address)).to.be.gt(0n)
      await w.check()
    })

    it('a paused hub: a late buy bounces as a paused one does, a late sale comes back — and a sale in time is still paid (exits never close)', async () => {
      const { w, token } = await launched()
      const opt = w.at(6)
      await w.fund(opt, alice, 2_000)
      await w.step(() => w.buy(opt, alice, token, 1_000))
      const rep = await w.replica(opt, token)
      const bag = await rep.balanceOf(alice.address)
      await (await w.pad.pause()).wait()

      const dBuy = (await timeOf(await (await w.buy(opt, alice, token, 100)).wait())) + TTL
      const dSell = (await timeOf(await (await w.sell(opt, alice, token, bag / 4n)).wait())) + TTL
      void dBuy
      await time.setNextBlockTimestamp(dSell + 1n)
      await expect(w.endpoint.deliverNext()).to.emit(w.pad, 'Refused').withArgs(2, 6, b32(token), b32(alice.address), E(100), 1)
      await expect(w.endpoint.deliverNext()).to.emit(w.pad, 'Refused').withArgs(3, 6, b32(token), b32(alice.address), bag / 4n, 6)
      await w.deliverAll()
      expect(await opt.dollar.balanceOf(alice.address)).to.equal(U(1_000))
      expect(await rep.balanceOf(alice.address)).to.equal(bag)

      const worth = await w.worth(opt, alice)
      await w.step(() => w.sell(opt, alice, token, bag / 4n))
      expect(await w.worth(opt, alice)).to.be.gt(worth)
      expect(await rep.balanceOf(alice.address)).to.equal(bag - bag / 4n)
    })

    it('what has no deadline: a launch with its dev buy lands days later, and so do a fee claim and a moved claim', async () => {
      const w = await deployMixed()
      const [opt, bnb] = [w.at(6), w.at(4)]
      await w.fund(opt, dev, 100)
      await (await w.spawn(opt, dev, { devBuy: 20, mode: 2 })).wait()
      // the dev buy is the first trade of a curve born in the same delivery: there is no price for it to go stale against
      expect(unpack(await w.endpoint.peek(0)).op).to.equal(1)
      await time.increase(3 * 86_400)
      await w.deliverAll()
      const token = await w.lastToken()
      expect(await (await w.replica(opt, token)).balanceOf(dev.address)).to.be.gt(0n)
      expect(await opt.dollar.balanceOf(dev.address)).to.equal(U(80))
      await w.check()

      // requests that name no price have nothing to go stale against either: sent, left for days, delivered
      await w.claim(bnb, alice, 50)
      await (await opt.gateway.connect(dev).claimFees(token, { value: await opt.gateway.quoteClaim() })).wait()
      await (await w.move(bnb, alice, 6, b32(alice.address), E(50))).wait()
      await time.increase(3 * 86_400)
      const dollars = await opt.dollar.balanceOf(dev.address)
      await w.deliverAll()
      expect(await opt.dollar.balanceOf(dev.address)).to.be.gt(dollars) // the dev's fees, three days on
      expect(await opt.usd.balanceOf(alice.address)).to.equal(E(50)) // the moved claim
      await w.check()
    })

    it('the lifetime is the operator\'s, between two minutes and a day; orders in flight keep the deadline they left with; it is what gets lengthened when orders arrive late', async () => {
      const { w, token } = await launched()
      const [base, opt] = [w.at(HOME), w.at(6)]
      await w.fund(opt, alice, 2_000)
      const rep = await w.replica(opt, token)
      expect(await opt.gateway.MIN_ORDER_TTL()).to.equal(120n)
      expect(await opt.gateway.MAX_ORDER_TTL()).to.equal(86_400n)
      expect(await opt.gateway.orderTtl()).to.equal(1_800n)

      await expect(opt.gateway.connect(stranger).setOrderTtl(600)).to.be.revertedWith('ROLES: not operator')
      for (const bad of [0, 1, 119, 86_401, 2 ** 32 - 1]) {
        await expect(opt.gateway.setOrderTtl(bad), `${bad}`).to.be.revertedWith('GW: bad ttl')
      }
      expect(await opt.gateway.orderTtl()).to.equal(1_800n) // there is always a deadline, and never an absurd one

      // an order leaves with thirty minutes; the lifetime is then cut to two
      const first = (await timeOf(await (await w.buy(opt, alice, token, 100)).wait())) + 1_800n
      await expect(opt.gateway.setOrderTtl(120)).to.emit(opt.gateway, 'OrderTtlSet').withArgs(120)
      const second = (await timeOf(await (await w.buy(opt, alice, token, 100)).wait())) + 120n
      expect(coder.decode(TRADE, unpack(await w.endpoint.peek(0)).data)[4]).to.equal(first)
      expect(coder.decode(TRADE, unpack(await w.endpoint.peek(1)).data)[4]).to.equal(second)
      // twenty minutes on: the first is still good, the second is a refund
      await time.setNextBlockTimestamp(second + 1_080n)
      await (await w.endpoint.deliverNext()).wait()
      await expect(w.endpoint.deliverNext()).to.emit(w.pad, 'Refused').withArgs(2, 6, b32(token), b32(alice.address), E(100), 6)
      await w.deliverAll()
      const bag = await rep.balanceOf(alice.address)
      expect(bag).to.be.gt(0n)
      expect(await opt.dollar.balanceOf(alice.address)).to.equal(U(1_900))
      // two minutes is two minutes: in at the 120th second, out at the 121st
      for (const [late, filled] of [[0n, true], [1n, false]]) {
        const had = await rep.balanceOf(alice.address)
        const d = (await timeOf(await (await w.buy(opt, alice, token, 100)).wait())) + 120n
        await landAt(w, d + late)
        await w.deliverAll()
        expect((await rep.balanceOf(alice.address)) > had, `${late}`).to.equal(filled)
      }

      // ORDERS THAT ARRIVE LATE — a slow leg, or a source chain whose clock runs behind the hub's (the
      // same arithmetic: the hub's time at delivery minus the gateway's at sending). An hour of it,
      // against a lifetime of thirty minutes: every order from that chain bounces, whole…
      await (await opt.gateway.setOrderTtl(1_800)).wait()
      const dollars = await opt.dollar.balanceOf(alice.address)
      for (let i = 0; i < 3; i++) {
        const sent = await timeOf(await (await w.buy(opt, alice, token, 50)).wait())
        await expect(landAt(w, sent + 3_600n)).to.emit(w.pad, 'Refused')
        await w.deliverAll()
        expect(await opt.dollar.balanceOf(alice.address)).to.equal(dollars)
      }
      // …until the operator lengthens it (a day at most), and they fill
      await expect(opt.gateway.setOrderTtl(86_400)).to.emit(opt.gateway, 'OrderTtlSet').withArgs(86_400)
      const sent = await timeOf(await (await w.buy(opt, alice, token, 50)).wait())
      await landAt(w, sent + 3_600n)
      await w.deliverAll()
      expect(await opt.dollar.balanceOf(alice.address)).to.equal(dollars - U(50))
      // each gateway has its own; on the hub chain an order executes in the transaction that sends it
      expect(await base.gateway.orderTtl()).to.equal(1_800n)
      await (await base.gateway.setOrderTtl(120)).wait()
      await w.fund(base, alice, 100)
      await time.increase(86_400)
      await w.step(() => buyMin(base, alice, token, 100, 1n))
      expect(await (await w.replica(base, token)).balanceOf(alice.address)).to.be.gt(0n)
      await w.check()
    })
  })

  /* ====================================================================== */
  /*  the ceiling on executor gas                                            */
  /* ====================================================================== */

  describe('executor gas has a ceiling', () => {
    it('15,000,000 for a destination and for a kind of message — what a limit above it would overcharge goes to the executor, and nobody can give it back', async () => {
      const { w, token } = await launched()
      const opt = w.at(6)
      const CEILING = 15_000_000n
      for (const m of [opt.messenger, w.hubMessenger]) expect(await m.MAX_EXECUTOR_GAS()).to.equal(CEILING)
      // under the 2^24 gas one transaction may use where that is capped — with room for the 1/64 the
      // caller keeps and for the endpoint's own work around the call
      expect((CEILING * 64n) / 63n + 1_000_000n).to.be.lt(2n ** 24n)

      // one gas over: refused, for the destination's limit and for one kind of message alike
      await expect(opt.messenger.setDestination(0, CEILING + 1n, UNIT)).to.be.revertedWith('LZM: gas too high')
      await expect(opt.messenger.setGasForOp(0, 1, CEILING + 1n)).to.be.revertedWith('LZM: gas too high')
      await expect(opt.messenger.setDestination(0, 2n ** 128n - 1n, UNIT)).to.be.revertedWith('LZM: gas too high')
      await expect(opt.messenger.setGasForOp(0, 2, 2n ** 128n - 1n)).to.be.revertedWith('LZM: gas too high')
      await expect(w.hubMessenger.setDestination(6, CEILING + 1n, 0)).to.be.revertedWith('LZM: gas too high')
      await expect(w.hubMessenger.setGasForOp(6, 10, CEILING + 1n)).to.be.revertedWith('LZM: gas too high')
      // nothing was written
      expect(await opt.messenger.gasLimit(0)).to.equal(MOCK_GAS_TO_HUB)
      expect(await opt.messenger.gasForOp(0, 1)).to.equal(0n)
      // the reply unit keeps its own bound, checked as before
      await expect(opt.messenger.setDestination(0, CEILING, E('0.051'))).to.be.revertedWith('LZM: unit too high')
      // still the operator's
      await expect(opt.messenger.connect(stranger).setDestination(0, 1, 0)).to.be.revertedWith('ROLES: not operator')
      await expect(opt.messenger.connect(stranger).setGasForOp(0, 1, 1)).to.be.revertedWith('ROLES: not operator')

      // the ceiling itself is allowed, and is what a message is then sold
      await expect(opt.messenger.setDestination(0, CEILING, UNIT)).to.emit(opt.messenger, 'DestinationSet').withArgs(0, CEILING, UNIT)
      await expect(opt.messenger.setGasForOp(0, 3, CEILING)).to.emit(opt.messenger, 'GasForOpSet').withArgs(0, 3, CEILING)
      await (await opt.messenger.setGasForOp(0, 2, 700_000)).wait()
      const PRICE = 10n ** 8n
      await (await w.endpoint.setGasPrice(PRICE)).wait()
      expect(await opt.gateway.quoteClaim()).to.equal(FEE + PRICE * CEILING + UNIT) // the destination's limit
      expect(await opt.gateway.quoteSell()).to.equal(FEE + PRICE * CEILING + UNIT) // that kind's own
      expect(await opt.gateway.quoteBuy()).to.equal(FEE + PRICE * 700_000n + UNIT)
      // the most an operator's slip can now cost a user for one message: the ceiling at the day's price
      await w.fund(opt, alice, 1_000)
      await (await w.buy(opt, alice, token, 100)).wait()
      await w.deliverAll()
      const bag = await (await w.replica(opt, token)).balanceOf(alice.address)
      await (await w.sell(opt, alice, token, bag)).wait()
      const pkt = await w.endpoint.peek(0)
      expect(pkt.gas).to.equal(CEILING)
      expect(pkt.options).to.equal(opts(CEILING, UNIT))
      // and a message sold the ceiling can still be delivered with it, inside one transaction
      await (await w.endpoint.deliverAtWithGas(0, CEILING, { gasLimit: 16_700_000 })).wait()
      await w.deliverAll()
      expect(await opt.dollar.balanceOf(alice.address)).to.be.gt(U(900))
      await w.check()

      // 0 still closes a destination, and still clears an override
      await (await opt.messenger.setGasForOp(0, 3, 0)).wait()
      await (await opt.messenger.setDestination(0, 0, UNIT)).wait()
      await expect(opt.gateway.quoteBuy()).to.be.revertedWith('LZM: no gas limit')
    })
  })

  /* ====================================================================== */
  /*  ABI                                                                    */
  /* ====================================================================== */

  describe('what this round changes in the ABI', () => {
    it('a lifetime and its setter on the gateway, a ceiling on the adapter, a deadline next to the minimum in the venue — no trade function and no pad function changed', async () => {
      const iface = async (name) => new ethers.Interface((await artifacts.readArtifact(name)).abi)
      const [gw, pad, lzm, venue] = [await iface('SpawnGateway'), await iface('SpawnPad'), await iface('LayerZeroOmniMessenger'), await iface('ICurveVenue')]
      const sig = (i, fn) => i.getFunction(fn)?.format('full')
      // added
      expect(sig(gw, 'orderTtl')).to.equal('function orderTtl() view returns (uint32)')
      expect(sig(gw, 'setOrderTtl')).to.equal('function setOrderTtl(uint32 ttl)')
      expect(sig(gw, 'MIN_ORDER_TTL')).to.equal('function MIN_ORDER_TTL() view returns (uint32)')
      expect(sig(gw, 'MAX_ORDER_TTL')).to.equal('function MAX_ORDER_TTL() view returns (uint32)')
      expect(gw.getEvent('OrderTtlSet').format('full')).to.equal('event OrderTtlSet(uint32 ttl)')
      expect(sig(lzm, 'MAX_EXECUTOR_GAS')).to.equal('function MAX_EXECUTOR_GAS() view returns (uint128)')
      // unchanged: whoever trades signs what they signed before
      expect(sig(gw, 'buyToken')).to.equal('function buyToken(address hubToken, uint256 usdIn) payable')
      expect(sig(gw, 'buyTokenUsdc')).to.equal('function buyTokenUsdc(address hubToken, uint256 usdcIn) payable')
      expect(sig(gw, 'sellToken')).to.equal('function sellToken(address hubToken, uint256 tokens) payable')
      expect(sig(gw, 'buyTokenUsdcMin')).to.equal('function buyTokenUsdcMin(address hubToken, uint256 usdcIn, uint256 minTokensOut) payable')
      expect(sig(gw, 'buyTokenMin')).to.equal('function buyTokenMin(address hubToken, uint256 usdIn, uint256 minTokensOut) payable')
      expect(sig(gw, 'sellTokenMin')).to.equal('function sellTokenMin(address hubToken, uint256 tokens, uint256 minDollarsOut) payable')
      expect(sig(gw, 'quoteBuy')).to.equal('function quoteBuy() view returns (uint256)')
      expect(sig(gw, 'quoteSell')).to.equal('function quoteSell() view returns (uint256)')
      expect(sig(lzm, 'setDestination')).to.equal('function setDestination(uint32 chainLabel, uint128 gas, uint128 unit)')
      expect(sig(lzm, 'setGasForOp')).to.equal('function setGasForOp(uint32 chainLabel, uint8 op, uint128 gas)')
      // changed: the pad's side of the venue (nothing else calls it)
      expect(sig(venue, 'execBuy')).to.equal(
        'function execBuy(address token, uint256 usdIn, uint256 minOut, uint256 deadline) returns (uint256 tokensOut, uint256 usdSpent, bool ascendedNow)',
      )
      expect(sig(venue, 'execSell')).to.equal(
        'function execSell(address token, uint256 tokensIn, uint256 minOut, uint256 deadline) returns (uint256 usdOut)',
      )
      expect(pad.getEvent('Refused').format('full')).to.equal(
        'event Refused(uint8 indexed op, uint32 indexed srcChain, bytes32 token, bytes32 actor, uint256 amount, uint8 reason)',
      )
      expect(sig(pad, 'onOmniMessage')).to.equal('function onOmniMessage(uint32 srcChain, bytes32 srcSender, bytes payload)')
    })
  })
})
