/**
 * What the hub will do with a trade, computed the way the hub computes it —
 * in integers, with its rounding. This mirrors `SpawnPad._buy` / `_sell` /
 * `_genesisGate` and `InternalCurveVenue.execBuy` / `execSell` line for line.
 *
 * It exists for one job: the MINIMUM a protected (`*Min`) trade asks for.
 * A minimum computed from a float approximation could sit above what the
 * chain delivers and make every trade revert, or far below and protect
 * nothing — so the expectation is exact for the state it was computed from,
 * and the user's tolerance is the only slack.
 *
 * Dependency-free on purpose (plain bigint): the tests run on bare node.
 */

/** A token's curve as the venue stores it (18-decimal wei). */
export interface CurveState {
  vBase: bigint
  vTokens: bigint
  sold: bigint
  ascended: boolean
}

/** The FAIR GENESIS window as `pad.fairGenesisOf(token, actor)` reports it. */
export interface GenesisState {
  /** Snipe tax right now, in bps (0 once the window is closed). */
  snipeBps: bigint
  /** 18-decimal dollars this actor already spent inside the window. */
  spent: bigint
  /** The per-actor cap of the window, 18-decimal dollars. */
  cap: bigint
}

export const CURVE_SUPPLY = 800_000_000n * 10n ** 18n
/** 1% on every trade (SpawnPad.FEE_BPS). */
export const FEE_BPS = 100n

const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n)

export interface BuyExpectation {
  /** Dollars (wei) the hub will actually put to work — less than asked when
   * the genesis cap cuts the buy; 0 when the cap is already used up. */
  spendable: bigint
  /** Dollars the genesis cap turns away (sent straight back by the hub). */
  clamped: bigint
  /** Fee rate applied, bps: 1% plus the snipe tax of the moment. */
  feeBps: bigint
  /** Tokens (wei) delivered for it. */
  tokens: bigint
}

/** `usdIn` wei of dollars → what a buy delivers, for this curve and window. */
export function expectBuy(curve: CurveState, usdIn: bigint, genesis?: GenesisState): BuyExpectation {
  let spendable = usdIn
  let snipe = 0n
  if (genesis && genesis.snipeBps > 0n) {
    // inside the window: taxed, and capped per actor
    snipe = genesis.snipeBps
    const room = genesis.spent >= genesis.cap ? 0n : genesis.cap - genesis.spent
    if (spendable > room) spendable = room
  }
  const feeBps = FEE_BPS + snipe
  if (spendable === 0n || curve.vTokens === 0n) {
    return { spendable: 0n, clamped: usdIn, feeBps, tokens: 0n }
  }
  const toCurve = spendable - (spendable * feeBps) / 10_000n
  let tokens = 0n
  if (toCurve > 0n) {
    const k = curve.vBase * curve.vTokens
    tokens = curve.vTokens - ceilDiv(k, curve.vBase + toCurve)
    if (!curve.ascended) {
      const remaining = CURVE_SUPPLY - curve.sold
      if (tokens >= remaining) tokens = remaining
    }
  }
  return { spendable, clamped: usdIn - spendable, feeBps, tokens }
}

/** `tokensIn` wei of tokens → the dollars (wei) a sell pays out, net of the fee. */
export function expectSell(curve: CurveState, tokensIn: bigint): bigint {
  if (tokensIn === 0n || curve.vTokens === 0n) return 0n
  const k = curve.vBase * curve.vTokens
  const gross = curve.vBase - ceilDiv(k, curve.vTokens + tokensIn)
  return gross - (gross * FEE_BPS) / 10_000n
}
