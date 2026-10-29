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
  ascendedAt?: number
}

const MAX_TRADES = 30
const MAX_HISTORY = 420

let tradeId = 1

export function createMarket(spawnTs: number): Market {
  const state = initialState()
  return {
    state,
    trades: [],
    history: [{ ts: spawnTs, price: spotPrice(state) }],
    volume: 0,
    chainTokens: {},
    balances: new Map(),
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
}

export type ExecResult =
  | { ok: true; usd: number; tokens: number; price: number; ascended: boolean }
  | { ok: false; reason: string }

export function execute(m: Market, input: ExecInput): ExecResult {
  const ts = input.ts ?? Date.now()

  if (input.side === 'buy') {
    const usd = input.usd ?? 0
    if (usd <= 0) return { ok: false, reason: 'Nothing to buy.' }
    const r = applyBuy(m.state, usd)
    if (r.tokens <= 0) return { ok: false, reason: 'Curve is out of tokens.' }
    m.state = r.state
    if (r.ascended) m.ascendedAt = ts
    m.balances.set(input.trader, (m.balances.get(input.trader) ?? 0) + r.tokens)
    m.chainTokens[input.chain] = (m.chainTokens[input.chain] ?? 0) + r.tokens
    const price = r.usd / r.tokens
    record(m, {
      id: tradeId++,
      ts,
      side: 'buy',
      chain: input.chain,
      usd: r.usd,
      tokens: r.tokens,
      price,
      trader: input.trader,
    })
    return { ok: true, usd: r.usd, tokens: r.tokens, price, ascended: r.ascended }
  }

  const want = input.tokens ?? 0
  const held = m.balances.get(input.trader) ?? 0
  const tokens = Math.min(want, held)
  if (tokens <= 0) return { ok: false, reason: 'Nothing to sell.' }
  const r = applySell(m.state, tokens)
  m.state = r.state
  m.balances.set(input.trader, held - tokens)
  m.chainTokens[input.chain] = Math.max(0, (m.chainTokens[input.chain] ?? 0) - tokens)
  const price = r.usd / tokens
  record(m, {
    id: tradeId++,
    ts,
    side: 'sell',
    chain: input.chain,
    usd: r.usd,
    tokens,
    price,
    trader: input.trader,
  })
  return { ok: true, usd: r.usd, tokens, price, ascended: false }
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
