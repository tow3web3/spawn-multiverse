/**
 * A Market wraps a MarketState with everything observable: the trade tape,
 * the price history, per-trader balances (holders) and per-chain allocation.
 * Every trade — yours or a bot's, from any chain — goes through execute()
 * and moves the one global curve.
 */
import {
  applyBuy,
  applySell,
  initialState,
  quoteBuy,
  quoteSell,
  spotPrice,
  type MarketState,
  type Quote,
} from './curve'

export type Side = 'buy' | 'sell'

/** Who eats the 1% trading fee — the dev picks this at launch, forever. */
export type FeeMode = 'holders' | 'split' | 'dev' | 'burn'

export interface Fees {
  mode: FeeMode
  /** Everything ever collected (USD). */
  total: number
  /** Streamed to holders (USD). */
  holders: number
  /** Accrued to the dev (USD) and what they already claimed. */
  dev: number
  devClaimed: number
  /** Burn mode: pot waiting for the next buyback, and what's been torched. */
  burnPot: number
  burnedUsd: number
  burnedTokens: number
  /** Holder modes: slice of `holders` already dropped to the per-chain distributors. */
  holdersPaid: number
}

export interface Trade {
  id: number
  ts: number
  side: Side
  chain: string
  usd: number
  tokens: number
  price: number
  trader: string
}

export interface PricePoint {
  ts: number
  price: number
}

export interface Market {
  state: MarketState
  /** Newest first. */
  trades: Trade[]
  /** Oldest first. */
  history: PricePoint[]
  volume: number
  chainTokens: Record<string, number>
  balances: Map<string, number>
  fees: Fees
  ascendedAt?: number
  /** FAIR GENESIS: when this market opened, and per-wallet window spend. */
  spawnTs: number
  genesisSpent: Map<string, number>
}

const MAX_TRADES = 30
const MAX_HISTORY = 420

/** 1% on every trade, taken on the executed notional. */
export const FEE_RATE = 0.01
/** Burn mode buys back in chunks, not dust. */
const BURN_TRIGGER = 4
/** The protocol's buyback executor, visible on the tape. */
export const BURNER = 'SPAWN·BURNER'

/* FAIR GENESIS (protocol v6) — mirrors the hub contract exactly:
 * for 10 minutes after spawn every buy pays 1% + a snipe tax decaying
 * linearly from 29% to 0, each wallet may spend at most $250, and the
 * first beats after spawn ("block 0" — 2s stands in for one hub block)
 * accept no buys at all. Bots are subject to it like everyone: a sniping
 * bot pays the tax into the token's fee stream.
 * One deliberate SIM divergence: on-chain a refused buy BOUNCES (refund via
 * DELIVER, never a revert); the SIM simply rejects with a reason — there is
 * no in-flight value to strand in a browser. */
export const GENESIS_WINDOW_MS = 600_000
export const SNIPE_MAX_RATE = 0.29
export const GENESIS_MAX_USD = 250
export const GENESIS_BLOCK_MS = 2_000

/** The extra fee rate a buy pays right now (0 once the window closes). */
export function genesisTax(m: Market, ts: number = Date.now()): number {
  const end = m.spawnTs + GENESIS_WINDOW_MS
  if (ts >= end) return 0
  return (SNIPE_MAX_RATE * (end - ts)) / GENESIS_WINDOW_MS
}

let tradeId = 1

export function emptyFees(mode: FeeMode): Fees {
  return { mode, total: 0, holders: 0, dev: 0, devClaimed: 0, burnPot: 0, burnedUsd: 0, burnedTokens: 0, holdersPaid: 0 }
}

export function createMarket(spawnTs: number, feeMode: FeeMode = 'holders'): Market {
  const state = initialState()
  return {
    state,
    trades: [],
    history: [{ ts: spawnTs, price: spotPrice(state) }],
    volume: 0,
    chainTokens: {},
    balances: new Map(),
    fees: emptyFees(feeMode),
    spawnTs,
    genesisSpent: new Map(),
  }
}

export function holdersCount(m: Market): number {
  let n = 0
  for (const v of m.balances.values()) if (v > 1) n++
  return n
}

export function priceOf(m: Market): number {
  return spotPrice(m.state)
}

/** Price at (or just before) `ts`; falls back to the first recorded point. */
export function priceAt(m: Market, ts: number): number {
  const h = m.history
  let p = h[0]?.price ?? spotPrice(m.state)
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].ts <= ts) return h[i].price
    p = h[i].price
  }
  return p
}

function record(m: Market, trade: Trade) {
  m.trades.unshift(trade)
  if (m.trades.length > MAX_TRADES) m.trades.length = MAX_TRADES
  m.history.push({ ts: trade.ts, price: spotPrice(m.state) })
  if (m.history.length > MAX_HISTORY) {
    // Decimate the older half to keep long histories light.
    const keep: PricePoint[] = []
    const half = Math.floor(m.history.length / 2)
    for (let i = 0; i < half; i += 2) keep.push(m.history[i])
    m.history = keep.concat(m.history.slice(half))
  }
  m.volume += trade.usd
}

export interface ExecInput {
  side: Side
  /** Buy: USD to spend. */
  usd?: number
  /** Sell: tokens to sell. */
  tokens?: number
  chain: string
  trader: string
  ts?: number
  /** The dev buy inside the spawn — the one disclosed FAIR GENESIS exemption. */
  genesisBuy?: boolean
}

export type ExecResult =
  | { ok: true; usd: number; tokens: number; price: number; ascended: boolean }
  | { ok: false; reason: string }

/** Splits a collected fee per the token's mode; burn mode buys back & burns. */
function accrueFee(m: Market, fee: number, chain: string, ts: number) {
  if (fee <= 0) return
  const f = m.fees
  f.total += fee
  switch (f.mode) {
    case 'holders':
      f.holders += fee
      break
    case 'split':
      f.holders += fee / 2
      f.dev += fee / 2
      break
    case 'dev':
      f.dev += fee
      break
    case 'burn': {
      f.burnPot += fee
      if (f.burnPot < BURN_TRIGGER) break
      // The buyback is a REAL buy on the same curve — it moves the price —
      // and the tokens it gets never touch a balance: they're burned.
      const pot = f.burnPot
      f.burnPot = 0
      const r = applyBuy(m.state, pot)
      if (r.tokens <= 0) break
      m.state = r.state
      if (r.ascended) m.ascendedAt = ts
      f.burnedUsd += r.usd
      f.burnedTokens += r.tokens
      record(m, {
        id: tradeId++,
        ts,
        side: 'buy',
        chain,
        usd: r.usd,
        tokens: r.tokens,
        price: r.usd / r.tokens,
        trader: BURNER,
      })
      break
    }
  }
}

export function execute(m: Market, input: ExecInput): ExecResult {
  const ts = input.ts ?? Date.now()

  if (input.side === 'buy') {
    let usd = input.usd ?? 0
    if (usd <= 0) return { ok: false, reason: 'Nothing to buy.' }

    // FAIR GENESIS gate — same rules as the hub, for everyone but the dev buy.
    let feeRate = FEE_RATE
    if (input.genesisBuy !== true) {
      if (ts < m.spawnTs + GENESIS_BLOCK_MS)
        return { ok: false, reason: 'FAIR GENESIS — block 0 does not exist. Wait a beat.' }
      const tax = genesisTax(m, ts)
      if (tax > 0) {
        const spent = m.genesisSpent.get(input.trader) ?? 0
        const room = GENESIS_MAX_USD - spent
        if (room <= 0)
          return { ok: false, reason: 'FAIR GENESIS — $250 cap reached until the window ends.' }
        if (usd > room) usd = room
        feeRate = FEE_RATE + tax
        m.genesisSpent.set(input.trader, spent + usd)
      }
    }

    const feeIn = usd * feeRate
    const r = applyBuy(m.state, usd - feeIn)
    if (r.tokens <= 0) return { ok: false, reason: 'Curve is out of tokens.' }
    // If the curve capped the buy, the fee shrinks with it.
    const fee = r.usd < usd - feeIn - 1e-9 ? r.usd * feeRate : feeIn
    m.state = r.state
    if (r.ascended) m.ascendedAt = ts
    m.balances.set(input.trader, (m.balances.get(input.trader) ?? 0) + r.tokens)
    m.chainTokens[input.chain] = (m.chainTokens[input.chain] ?? 0) + r.tokens
    const spent = r.usd + fee
    const price = r.usd / r.tokens
    record(m, {
      id: tradeId++,
      ts,
      side: 'buy',
      chain: input.chain,
      usd: spent,
      tokens: r.tokens,
      price,
      trader: input.trader,
    })
    accrueFee(m, fee, input.chain, ts)
    return { ok: true, usd: spent, tokens: r.tokens, price, ascended: r.ascended }
  }

  const want = input.tokens ?? 0
  const held = m.balances.get(input.trader) ?? 0
  const tokens = Math.min(want, held)
  if (tokens <= 0) return { ok: false, reason: 'Nothing to sell.' }
  const r = applySell(m.state, tokens)
  m.state = r.state
  m.balances.set(input.trader, held - tokens)
  m.chainTokens[input.chain] = Math.max(0, (m.chainTokens[input.chain] ?? 0) - tokens)
  const fee = r.usd * FEE_RATE
  const net = r.usd - fee
  const price = r.usd / tokens
  record(m, {
    id: tradeId++,
    ts,
    side: 'sell',
    chain: input.chain,
    usd: net,
    tokens,
    price,
    trader: input.trader,
  })
  accrueFee(m, fee, input.chain, ts)
  return { ok: true, usd: net, tokens, price, ascended: false }
}

export function quote(m: Market, side: Side, amount: number): Quote {
  return side === 'buy' ? quoteBuy(m.state, amount) : quoteSell(m.state, amount)
}

/* ------------------------------------------------------------------ */
/* Bots — the organic market. Same engine, same curve, same price.    */
/* ------------------------------------------------------------------ */

const CHAIN_WEIGHTS: [string, number][] = [
  ['solana', 0.3],
  ['base', 0.25],
  ['ethereum', 0.15],
  ['bnb', 0.12],
  ['arbitrum', 0.1],
  ['optimism', 0.08],
]

export function randomChain(rng: () => number = Math.random): string {
  let r = rng()
  for (const [id, w] of CHAIN_WEIGHTS) {
    r -= w
    if (r <= 0) return id
  }
  return 'solana'
}

/** Power-law bot ids: a few whales trade often, a long tail trades once. */
function randomBot(rng: () => number): string {
  return `bot:${Math.floor(rng() ** 1.6 * 900)}`
}

export interface BotOpts {
  /** Probability the bot buys (vs. sells). */
  buyBias: number
  ts?: number
  rng?: () => number
}

export function randomBotTrade(m: Market, opts: BotOpts): ExecResult {
  const rng = opts.rng ?? Math.random
  const chain = randomChain(rng)
  const wantBuy = rng() < opts.buyBias

  if (!wantBuy) {
    // Find a bot that actually holds something.
    const holders = [...m.balances.entries()].filter(
      ([who, bal]) => who.startsWith('bot:') && bal > 1,
    )
    if (holders.length > 0) {
      const [who, bal] = holders[Math.floor(rng() * holders.length)]
      const tokens = bal * (0.1 + rng() * 0.7)
      return execute(m, { side: 'sell', tokens, chain, trader: who, ts: opts.ts })
    }
  }
  const usd = 5 + rng() * rng() * 420
  return execute(m, { side: 'buy', usd, chain, trader: randomBot(rng), ts: opts.ts })
}

/* ------------------------------------------------------------------ */
/* Seed histories — replay a plausible life for the demo creatures.   */
/* ------------------------------------------------------------------ */

export interface SeedPhase {
  /** Fraction of the timeline this phase ends at (0..1]. */
  until: number
  buyBias: number
  /** Stop this phase early once the spot price reaches this. */
  stopAtPrice?: number
}

export function simulateLife(
  m: Market,
  from: number,
  to: number,
  steps: number,
  phases: SeedPhase[],
) {
  for (let i = 0; i < steps; i++) {
    const frac = i / steps
    const phase = phases.find((p) => frac < p.until) ?? phases[phases.length - 1]
    if (phase.stopAtPrice && spotPrice(m.state) >= phase.stopAtPrice) continue
    const ts = from + (to - from) * frac + Math.random() * 400
    randomBotTrade(m, { buyBias: phase.buyBias, ts })
  }
}
