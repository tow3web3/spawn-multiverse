// Unit tests for the v7.2 decisions the provider takes on hub events and
// chain state (run: `npm run test:units`, bare node). The local devnet
// delivers every message synchronously, so the outcomes a cross-chain user
// meets minutes later — a trade refused at its minimum and sent back whole,
// an open the hub would not send, a move turned back — are pinned here.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OP,
  R,
  availability,
  declaredDollar,
  designDollar,
  moveTargets,
  narrow,
  openVerdict,
  readMove,
  readOpen,
  readTrade,
  returnedText,
  stuckClaim,
  CLAIM_DUST,
  expired,
  isWide,
  moveRecipient,
  ttlText,
} from './v72.ts'
import { encodeAbiParameters, encodeEventTopics, parseAbi, parseEventLogs } from 'viem'

const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n
const ME = '0x8626f6940e2eb28930efb4cef49b2d1f2c9c1199'
const OTHER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
const TOKEN = '0xA6D6d7c556ce6Ada136ba32Dbe530993f128CA44'
const b32 = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase()

const trade = (over = {}) => ({
  eventName: 'Trade',
  args: {
    token: TOKEN,
    chain: 6,
    trader: b32(ME),
    isBuy: true,
    usd: E(50),
    tokens: E(1_000_000),
    priceAfter: E(0.00005),
    ts: 1n,
    ...over,
  },
})
const refused = (op, reason, over = {}) => ({
  eventName: 'Refused',
  args: { op, srcChain: 6, token: b32(TOKEN), actor: b32(ME), amount: E(50), reason, ...over },
})

test('dollars: a chain declares its own dollar, else the deployment one, else USDC', () => {
  assert.deepEqual(declaredDollar({ symbol: 'USDC', decimals: 6 }, { dollar: { symbol: 'USDT', decimals: 18 } }), {
    symbol: 'USDT',
    decimals: 18,
  })
  assert.deepEqual(declaredDollar({ symbol: 'USDC', decimals: 6 }, {}), { symbol: 'USDC', decimals: 6 })
  assert.deepEqual(declaredDollar(undefined, undefined), { symbol: 'USDC', decimals: 6 })
  assert.equal(designDollar('bnb').decimals, 18)
  assert.equal(designDollar('ethereum').symbol, 'USDC')
})

test('narrow: an EVM wire identity narrows to its address, a wide one stays whole', () => {
  assert.equal(narrow(b32(ME)), ME)
  const wide = '0x' + 'ab'.repeat(32)
  assert.equal(narrow(wide), wide)
})

test('a filled trade is read from its Trade event, matched on chain, trader and side', () => {
  const got = readTrade([trade()], { token: TOKEN, actor: ME, want: 'buy', label: 6 })
  assert.equal(got.kind, 'trade')
  assert.equal(got.usd, 50)
  // same wallet, same token, another chain: not this message
  assert.equal(readTrade([trade({ chain: 5 })], { token: TOKEN, actor: ME, want: 'buy', label: 6 }), null)
  // someone else's trade
  assert.equal(readTrade([trade({ trader: b32(OTHER) })], { token: TOKEN, actor: ME, want: 'buy', label: 6 }), null)
  // a sell is not a buy
  assert.equal(readTrade([trade()], { token: TOKEN, actor: ME, want: 'sell', label: 6 }), null)
})

test('a cross-chain buy under its minimum is REFUSED at the hub, with the amount sent home', () => {
  const got = readTrade([refused(OP.BUY, R.TERMS)], { token: TOKEN, actor: ME, want: 'buy', label: 6 })
  assert.deepEqual(got, { kind: 'refused', reason: R.TERMS, amount: 50, block: undefined })
  // a sell refused the same way
  const sold = readTrade([refused(OP.SELL, R.TERMS, { amount: E(1_000_000) })], {
    token: TOKEN,
    actor: ME,
    want: 'sell',
    label: 6,
  })
  assert.equal(sold.kind, 'refused')
  // a refusal of another op, another chain, or another wallet is not ours
  for (const ev of [
    refused(OP.SELL, R.TERMS),
    refused(OP.BUY, R.TERMS, { srcChain: 4 }),
    refused(OP.BUY, R.TERMS, { actor: b32(OTHER) }),
  ])
    assert.equal(readTrade([ev], { token: TOKEN, actor: ME, want: 'buy', label: 6 }), null)
})

test('a refused trade is said as what happened: it came back whole, in plain words', () => {
  const buy = returnedText('buy', R.TERMS, { chain: 'OPTIMISM', ticker: 'PICKL', money: '$50.00 USDC', hadMin: true })
  assert.match(buy, /price moved past the minimum you set/)
  assert.match(buy, /\$50\.00 USDC came back to you on OPTIMISM/)
  assert.doesNotMatch(buy, /error|failed/i)
  const sell = returnedText('sell', R.TERMS, { chain: 'BNB', ticker: 'PICKL', hadMin: true })
  assert.match(sell, /\$PICKL came back to you on BNB/)
  // any other refusal still says why, and that the value came back
  assert.match(returnedText('buy', R.PAUSED, { chain: 'ARBITRUM', ticker: 'X' }), /hub is paused.*came back/)
  assert.match(returnedText('buy', 99, { chain: 'ARBITRUM', ticker: 'X' }), /see the hub events/)
  // read on the hub while the value still crosses back: "on the way", not "came back"
  const flying = returnedText('buy', R.TERMS, { chain: 'ARBITRUM', ticker: 'X', money: '$30.00 USDC', hadMin: true, arriving: true, sponsored: true })
  assert.match(flying, /\$30\.00 USDC are on the way back to you on ARBITRUM — whole, within a few minutes/)
  assert.match(flying, /Nothing is spent but gas/)
  assert.doesNotMatch(flying, /network fee/)
  // reason 6 without a minimum: the market refused it, said as such
  assert.match(returnedText('buy', R.TERMS, { chain: 'BASE', ticker: 'X' }), /terms were not met, or the market refused it.*came back/)
  // reason 6 after the deadline: expired, not a price move
  const late = returnedText('sell', R.TERMS, { chain: 'ETHEREUM', ticker: 'X', hadMin: true, expired: true })
  assert.match(late, /after its deadline, so it expired unfilled/)
  assert.doesNotMatch(late, /price moved/)
})

test('a refusal dated after the order deadline is an expiry; unknown TTL never is', () => {
  const sent = 1_000_000
  assert.equal(expired(sent, sent + 30 * 60_000 + 1, 1800), true)
  assert.equal(expired(sent, sent + 29 * 60_000, 1800), false)
  assert.equal(expired(sent, sent + 99 * 60_000, undefined), false) // gateway without orderTtl()
  assert.equal(expired(undefined, sent, 1800), false)
  assert.equal(ttlText(1800), '30 min')
  assert.equal(ttlText(5400), '1 h 30 min')
  assert.equal(ttlText(45), '45 s')
})

test('a move recipient must have the shape of its destination', () => {
  const r = moveRecipient(ME, false)
  assert.deepEqual(r, { ok: true, to: b32(ME) })
  assert.equal(moveRecipient('0x' + 'ab'.repeat(32), false).ok, false) // a 32-byte key to an EVM chain
  assert.equal(moveRecipient(ME, true).ok, false) // an address to Solana
  assert.equal(moveRecipient(b32(ME), true).ok, false) // a padded address is still an address
  assert.deepEqual(moveRecipient('0x' + 'AB'.repeat(32), true), { ok: true, to: '0x' + 'ab'.repeat(32) })
  assert.equal(moveRecipient('0x' + '0'.repeat(40), false).ok, false)
  assert.equal(isWide(b32(ME)), false)
  assert.equal(isWide('0x' + 'ab'.repeat(32)), true)
})

test('FAIR GENESIS: a buy turned away whole is a bounce, a capped one a trade with a refund', () => {
  const guard = { eventName: 'GenesisGuard', args: { token: TOKEN, actor: b32(ME), taxBps: 0n, taxUsd: 0n, refundedUsd: E(20) } }
  assert.deepEqual(readTrade([guard], { token: TOKEN, actor: ME, want: 'buy', label: 6 }), { kind: 'bounced', refunded: 20 })
  const both = readTrade([guard, trade()], { token: TOKEN, actor: ME, want: 'buy', label: 6 })
  assert.equal(both.kind, 'trade')
  assert.equal(both.guardRefund, 20)
})

test('an open: Resynced means the replica is on its way, SyncFailed that the hub did not send it', () => {
  const ok = [{ eventName: 'Resynced', args: { token: TOKEN, chain: 2 } }]
  const no = [{ eventName: 'SyncFailed', args: { token: TOKEN, chain: 2 } }]
  assert.equal(readOpen(ok, TOKEN, 2), 'opened')
  assert.equal(readOpen(no, TOKEN, 2), 'failed')
  assert.equal(readOpen(ok, TOKEN, 4), null) // another chain's open
  assert.equal(readOpen([refused(OP.OPEN, R.UNKNOWN, { srcChain: 2 })], TOKEN, 2), 'unknown-token')
  assert.equal(readOpen([], TOKEN, 2), null)
})

test('an open is offered only when the hub would send the SYNC: its quote within the request ceiling', () => {
  assert.deepEqual(openVerdict(100n, 100n), { ok: true })
  assert.deepEqual(openVerdict(0n, 0n), { ok: true }) // the hub chain's own leg is free
  assert.deepEqual(openVerdict(101n, 100n), { ok: false, why: 'too-dear' })
  assert.deepEqual(openVerdict(1n, 0n), { ok: false, why: 'too-dear' }) // a ceiling never set closes the chain
  assert.deepEqual(openVerdict(null, 100n), { ok: false, why: 'unpriced' })
})

test('availability: arriving while a fresh SYNC may still land, closed (openable) once it will not', () => {
  const base = { hasReplica: false, syncFailed: false, synchronous: false, hubChain: false, ageMs: 60_000, canOpen: true }
  assert.equal(availability({ ...base, hasReplica: true }), null)
  assert.equal(availability(base), 'arriving')
  assert.equal(availability({ ...base, syncFailed: true }), 'closed')
  assert.equal(availability({ ...base, ageMs: 3_600_000 }), 'closed') // a chain that joined later
  assert.equal(availability({ ...base, synchronous: true }), 'closed') // the devnet: nothing is in flight
  assert.equal(availability({ ...base, syncFailed: true, canOpen: false }), 'failed') // a pre-7.2 gateway
  assert.equal(availability({ ...base, hubChain: true }), null)
})

test('a claim the local vault cannot pay in full is stuck; dust is not', () => {
  const S6 = 10n ** 12n
  assert.equal(stuckClaim({ claim: E(100), liquidity: 99_000_000n, scale: S6 }), true)
  assert.equal(stuckClaim({ claim: E(100), liquidity: 100_000_000n, scale: S6 }), false)
  assert.equal(stuckClaim({ claim: E(100), liquidity: E(50), scale: 1n }), true) // an 18-decimal vault
  assert.equal(stuckClaim({ claim: CLAIM_DUST - 1n, liquidity: 0n, scale: 1n }), false)
})

test('a move is offered to a priced route whose vault can pay the claim in full', () => {
  const S6 = 10n ** 12n
  const routes = [
    { chain: 'base', fee: 10n, liquidity: 5_000_000_000n, scale: S6 }, // $5,000 USDC
    { chain: 'optimism', fee: 10n, liquidity: 50_000_000n, scale: S6 }, // $50: too little
    { chain: 'arbitrum', fee: null, liquidity: 9_000_000_000n, scale: S6 }, // GW: route closed
    { chain: 'bnb', fee: 10n, liquidity: E(2_000), scale: 1n }, // $2,000 USDT
  ]
  assert.deepEqual(
    moveTargets(E(1_000), routes).map((r) => r.chain),
    ['base', 'bnb'],
  )
  assert.deepEqual(moveTargets(E(10_000), routes), [])
})

test('a move is read from the pad: forwarded to its destination, or sent back home', () => {
  const moved = (forwarded, over = {}) => ({
    eventName: 'Moved',
    args: { srcChain: 4, dstChain: 3, from: b32(ME), to: b32(ME), amount: E(1_687.31), forwarded, ...over },
  })
  assert.deepEqual(readMove([moved(true)], { from: ME, label: 4, dst: 3 }), { forwarded: true, amount: 1687.31, to: ME })
  assert.equal(readMove([moved(false)], { from: ME, label: 4, dst: 3 }).forwarded, false)
  assert.equal(readMove([moved(true, { dstChain: 6 })], { from: ME, label: 4, dst: 3 }), null)
  assert.equal(readMove([moved(true, { from: b32(OTHER) })], { from: ME, label: 4, dst: 3 }), null)
})

// The same verdicts from RAW logs: the events as SpawnPad emits them (its
// signatures, pinned by contracts/test/v72.test.js), encoded and decoded by
// viem exactly as the provider does — so the integer and hex shapes the
// decoder hands over (uint32 → number, uint256 → bigint, bytes32 → hex) are
// what the readers above were written for.
const PAD_EVENTS = parseAbi([
  'event Trade(address indexed token, uint32 indexed chain, bytes32 indexed trader, bool isBuy, uint256 usd, uint256 tokens, uint256 priceAfter, uint64 ts)',
  'event Refused(uint8 indexed op, uint32 indexed srcChain, bytes32 token, bytes32 actor, uint256 amount, uint8 reason)',
  'event SyncFailed(address indexed token, uint32 indexed chain)',
  'event Resynced(address indexed token, uint32 indexed chain)',
  'event Moved(uint32 indexed srcChain, uint32 indexed dstChain, bytes32 indexed from, bytes32 to, uint256 amount, bool forwarded)',
])
const PAD = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
function rawLog(eventName, indexed, types, values, i = 0) {
  return {
    address: PAD,
    topics: encodeEventTopics({ abi: PAD_EVENTS, eventName, args: indexed }),
    data: encodeAbiParameters(types, values),
    blockNumber: 7n,
    blockHash: '0x' + '11'.repeat(32),
    transactionHash: '0x' + '22'.repeat(32),
    transactionIndex: 0,
    logIndex: i,
    removed: false,
  }
}
const decode = (logs) => parseEventLogs({ abi: PAD_EVENTS, logs })

test('raw logs: a refused cross-chain buy decodes into "it came back whole"', () => {
  const log = rawLog(
    'Refused',
    { op: OP.BUY, srcChain: 6 },
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint8' }],
    [b32(TOKEN), b32(ME), E(50), R.TERMS],
  )
  const got = readTrade(decode([log]), { token: TOKEN, actor: ME, want: 'buy', label: 6 })
  assert.deepEqual(got, { kind: 'refused', reason: R.TERMS, amount: 50, block: 7n })
})

test('raw logs: a filled trade, an open and a move decode into their verdicts', () => {
  const tradeLog = rawLog(
    'Trade',
    { token: TOKEN, chain: 4, trader: b32(ME) },
    [{ type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' }],
    [false, E(49.5), E(990_000), E(0.00005), 1n],
    0,
  )
  const sold = readTrade(decode([tradeLog]), { token: TOKEN, actor: ME, want: 'sell', label: 4 })
  assert.equal(sold.kind, 'trade')
  assert.equal(sold.usd, 49.5)

  const opened = rawLog('Resynced', { token: TOKEN, chain: 2 }, [], [], 1)
  assert.equal(readOpen(decode([opened]), TOKEN, 2), 'opened')
  const skipped = rawLog('SyncFailed', { token: TOKEN, chain: 2 }, [], [], 2)
  assert.equal(readOpen(decode([skipped]), TOKEN, 2), 'failed')

  const home = rawLog(
    'Moved',
    { srcChain: 4, dstChain: 3, from: b32(ME) },
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bool' }],
    [b32(ME), E(1_000), false],
    3,
  )
  assert.deepEqual(readMove(decode([home]), { from: ME, label: 4, dst: 3 }), { forwarded: false, amount: 1000, to: ME })
})
