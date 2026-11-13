// Unit tests for the amount helpers (run: `npm run test:units`, bare node —
// the .ts modules are dependency-free and load through type stripping).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  scaleOf,
  parseDollars,
  toUnits,
  unitsToString,
  fromUnits,
  unitsToWei,
  weiToUnits,
  lessBps,
} from './dollars.ts'
import { expectBuy, expectSell, CURVE_SUPPLY } from './curveMath.ts'

const DECIMALS = [6, 8, 18]

test('scale: one unit of a d-decimal dollar is 10^(18-d) wei', () => {
  assert.equal(scaleOf(6), 10n ** 12n)
  assert.equal(scaleOf(8), 10n ** 10n)
  assert.equal(scaleOf(18), 1n)
  assert.throws(() => scaleOf(19))
  assert.throws(() => scaleOf(6.5))
})

test('strings parse exactly at 6, 8 and 18 decimals, and never round up', () => {
  for (const d of DECIMALS) {
    assert.equal(parseDollars('1', d), 10n ** BigInt(d))
    assert.equal(parseDollars('0.1', d), 10n ** BigInt(d - 1))
    assert.equal(parseDollars('250', d), 250n * 10n ** BigInt(d))
    assert.equal(parseDollars('.5', d), 5n * 10n ** BigInt(d - 1))
    assert.equal(parseDollars('0', d), 0n)
  }
  // digits beyond the token's precision are dropped, not rounded
  assert.equal(parseDollars('0.1234567', 6), 123456n)
  assert.equal(parseDollars('0.9999999', 6), 999999n)
  assert.equal(parseDollars('1.123456789012345678', 18), 1123456789012345678n)
  assert.equal(parseDollars('1.1234567890123456789', 18), 1123456789012345678n)
  for (const bad of ['', '.', '-1', '1e6', '1,5', 'abc', '1.2.3']) {
    assert.throws(() => parseDollars(bad, 6), new RegExp('not a dollar amount'))
  }
})

test('a typed number becomes units with no float noise — at 18 decimals too', () => {
  for (const d of DECIMALS) {
    const one = 10n ** BigInt(d)
    assert.equal(toUnits(50, d), 50n * one)
    assert.equal(toUnits(0.1, d), one / 10n) // 0.1 is not representable in binary
    assert.equal(toUnits(0.3, d), (3n * one) / 10n)
    assert.equal(toUnits(1337, d), 1337n * one)
    assert.equal(toUnits(12.34, d), (1234n * one) / 100n)
    assert.equal(toUnits(0.000001, d), one / 1_000_000n)
  }
  assert.throws(() => toUnits(-1, 6))
  assert.throws(() => toUnits(Number.NaN, 6))
})

test('round trips: units → string → units is the identity for every decimals', () => {
  const samples = (d) => [
    0n,
    1n,
    10n ** BigInt(d) - 1n,
    10n ** BigInt(d),
    10n ** BigInt(d) + 1n,
    123456789n * 10n ** BigInt(d) + 987654n,
    2n ** 96n - 1n,
  ]
  for (const d of DECIMALS) {
    for (const u of samples(d)) {
      assert.equal(parseDollars(unitsToString(u, d), d), u, `${u} at ${d} decimals`)
    }
  }
  assert.equal(unitsToString(1_500_000n, 6), '1.5')
  assert.equal(unitsToString(1n, 18), '0.000000000000000001')
  assert.equal(unitsToString(5067072776474506000n, 18), '5.067072776474506')
  assert.equal(fromUnits(20_325_912n, 6), 20.325912)
})

test('units ↔ wei: nothing lost going up, dust reported going down', () => {
  for (const d of DECIMALS) {
    const scale = scaleOf(d)
    for (const u of [0n, 1n, 999n, 10n ** BigInt(d), 2n ** 80n]) {
      const wei = unitsToWei(u, d)
      assert.deepEqual(weiToUnits(wei, d), { units: u, dust: 0n })
      if (scale > 1n) {
        assert.deepEqual(weiToUnits(wei + scale - 1n, d), { units: u, dust: scale - 1n })
      }
    }
  }
  // an 18-decimal dollar has no dust at all
  assert.deepEqual(weiToUnits(123n, 18), { units: 123n, dust: 0n })
})

test('a tolerance rounds the minimum down, never up', () => {
  assert.equal(lessBps(1_000_000n, 200), 980_000n)
  assert.equal(lessBps(101n, 200), 98n) // 98.98 floors
  assert.equal(lessBps(1n, 200), 0n)
  assert.equal(lessBps(7n, 0), 7n)
  assert.throws(() => lessBps(1n, 10_001))
})

/* ---- the hub's own arithmetic, mirrored ---- */

const E = (n) => BigInt(n) * 10n ** 18n
const GENESIS_CURVE = { vBase: E(6000), vTokens: E(1_073_000_000), sold: 0n, ascended: false }
const ceilDiv = (a, b) => (a - 1n) / b + 1n

test('buy: 1% off the top, the venue rounds against the buyer', () => {
  const usd = E(100)
  const e = expectBuy(GENESIS_CURVE, usd)
  assert.equal(e.spendable, usd)
  assert.equal(e.clamped, 0n)
  assert.equal(e.feeBps, 100n)
  const toCurve = usd - usd / 100n
  const k = GENESIS_CURVE.vBase * GENESIS_CURVE.vTokens
  assert.equal(e.tokens, GENESIS_CURVE.vTokens - ceilDiv(k, GENESIS_CURVE.vBase + toCurve))
  // ~17.4M tokens for the first $100: the right order of magnitude
  assert.ok(e.tokens > E(17_000_000) && e.tokens < E(18_000_000))
})

test('buy inside FAIR GENESIS: the tax is in the expectation and the cap cuts the spend', () => {
  const g = { snipeBps: 2900n, spent: E(200), cap: E(250) }
  const e = expectBuy(GENESIS_CURVE, E(100), g)
  assert.equal(e.spendable, E(50)) // only $50 of room left
  assert.equal(e.clamped, E(50))
  assert.equal(e.feeBps, 3000n)
  const plain = expectBuy(GENESIS_CURVE, E(50))
  assert.ok(e.tokens < plain.tokens, 'a 30% fee buys fewer tokens than a 1% fee')
  // cap used up: nothing spendable, nothing delivered
  const none = expectBuy(GENESIS_CURVE, E(10), { snipeBps: 100n, spent: E(250), cap: E(250) })
  assert.deepEqual([none.spendable, none.clamped, none.tokens], [0n, E(10), 0n])
  // window closed (no tax): the cap no longer applies
  const after = expectBuy(GENESIS_CURVE, E(100), { snipeBps: 0n, spent: E(250), cap: E(250) })
  assert.equal(after.spendable, E(100))
})

test('buy at the end of the curve is capped at what is left', () => {
  const nearEnd = { ...GENESIS_CURVE, sold: CURVE_SUPPLY - E(1000) }
  const e = expectBuy(nearEnd, E(1_000_000))
  assert.equal(e.tokens, E(1000))
})

test('sell: net of the 1% fee, rounded against the seller; a round trip loses money', () => {
  const bought = expectBuy(GENESIS_CURVE, E(100))
  const after = {
    ...GENESIS_CURVE,
    vBase: GENESIS_CURVE.vBase + E(99),
    vTokens: GENESIS_CURVE.vTokens - bought.tokens,
    sold: bought.tokens,
  }
  const back = expectSell(after, bought.tokens)
  assert.ok(back < E(99) && back > E(97), `round trip returned ${back}`)
  assert.equal(expectSell(after, 0n), 0n)
})
