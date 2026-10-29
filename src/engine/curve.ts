/**
 * The genesis curve — one constant-product market per token, shared by all
 * six chains. Chains are entry points; the curve (and therefore the price)
 * is global. This module is pure math: no React, no side effects.
 *
 * Phase 1 — 'curve': virtual-reserve bonding curve (pump.fun style).
 *   Up to CURVE_SUPPLY tokens are sold. Price starts at START_PRICE and
 *   rises deterministically with net buys.
 * Phase 2 — 'pool': when the curve sells out, the token "ascends": the USD
 *   raised plus the reserved POOL_SUPPLY seed a real constant-product pool
 *   and trading continues there, still with one global price.
 */

export const TOTAL_SUPPLY = 1_000_000_000
export const CURVE_SUPPLY = 800_000_000
export const POOL_SUPPLY = TOTAL_SUPPLY - CURVE_SUPPLY

/** Virtual reserves at genesis. */
export const V_BASE_0 = 6_000 // USD
export const V_TOKENS_0 = 1_073_000_000

export const START_PRICE = V_BASE_0 / V_TOKENS_0

export type Phase = 'curve' | 'pool'

export interface MarketState {
  phase: Phase
  /** USD side of the reserve (virtual in curve phase, real in pool phase). */
  vBase: number
  /** Token side of the reserve. */
  vTokens: number
  /** Net tokens sold from the curve (curve phase bookkeeping). */
  sold: number
}

export function initialState(): MarketState {
  return { phase: 'curve', vBase: V_BASE_0, vTokens: V_TOKENS_0, sold: 0 }
}

export function spotPrice(s: MarketState): number {
  return s.vBase / s.vTokens
}

export function marketCap(s: MarketState): number {
  return spotPrice(s) * TOTAL_SUPPLY
}

/** 0..1 — how much of the curve has been sold. 1 once ascended. */
export function ascensionProgress(s: MarketState): number {
  return s.phase === 'pool' ? 1 : Math.min(1, s.sold / CURVE_SUPPLY)
}

export interface Quote {
  /** Tokens moved. */
  tokens: number
  /** USD moved (what a buy actually costs / what a sell actually returns). */
  usd: number
  /** Effective price vs. spot, as a fraction (0.021 = 2.1% impact). */
  impact: number
}

/** How many tokens `usd` buys right now. Caps at what's left on the curve. */
export function quoteBuy(s: MarketState, usd: number): Quote {
  const k = s.vBase * s.vTokens
  let tokens = s.vTokens - k / (s.vBase + usd)
  let spend = usd
  if (s.phase === 'curve') {
    const remaining = CURVE_SUPPLY - s.sold
    if (tokens > remaining) {
      tokens = remaining
      spend = k / (s.vTokens - tokens) - s.vBase
    }
  }
  const effective = tokens > 0 ? spend / tokens : spotPrice(s)
  return { tokens, usd: spend, impact: effective / spotPrice(s) - 1 }
}

/** How much USD selling `tokens` returns right now. */
export function quoteSell(s: MarketState, tokens: number): Quote {
  const k = s.vBase * s.vTokens
  const usd = s.vBase - k / (s.vTokens + tokens)
  const effective = tokens > 0 ? usd / tokens : spotPrice(s)
  return { tokens, usd, impact: effective / spotPrice(s) - 1 }
}

export interface BuyResult extends Quote {
  state: MarketState
  ascended: boolean
}

export function applyBuy(s: MarketState, usd: number): BuyResult {
  const q = quoteBuy(s, usd)
  let state: MarketState = {
    ...s,
    vBase: s.vBase + q.usd,
    vTokens: s.vTokens - q.tokens,
    sold: s.phase === 'curve' ? s.sold + q.tokens : s.sold,
  }
  let ascended = false
  if (state.phase === 'curve' && state.sold >= CURVE_SUPPLY - 1) {
    // Ascension: the raised USD + the reserved supply seed the omnipool.
    const raised = state.vBase - V_BASE_0
    state = { phase: 'pool', vBase: raised, vTokens: POOL_SUPPLY, sold: CURVE_SUPPLY }
    ascended = true
  }
  return { ...q, state, ascended }
}

export interface SellResult extends Quote {
  state: MarketState
}

export function applySell(s: MarketState, tokens: number): SellResult {
  const q = quoteSell(s, tokens)
  const state: MarketState = {
    ...s,
    vBase: s.vBase - q.usd,
    vTokens: s.vTokens + tokens,
    sold: s.phase === 'curve' ? Math.max(0, s.sold - tokens) : s.sold,
  }
  return { ...q, state }
}
