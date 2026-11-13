/**
 * The dollar of a universe is a parameter: USDC (6 decimals) in the core
 * universe and on Ethereum, BSC USDT (18 decimals) on BNB Chain. Everything
 * that turns an amount into the token's smallest units — or back — goes
 * through this file, so no place can quietly assume six decimals.
 *
 * Three unit systems meet here:
 *  - UNITS: the dollar token's own smallest units (10^-decimals of a dollar);
 *  - WEI:   the protocol's 18-decimal dollar (oUSD, hub accounting, events);
 *  - a JS number: display only — never fed back into a transaction as is.
 * One unit is `scaleOf(decimals)` wei; with 18 decimals that is 1.
 *
 * This module is deliberately dependency-free (plain bigint and strings) so
 * its tests run on bare node.
 */

export interface Dollar {
  /** Ticker of the settlement token: "USDC", "USDT". */
  symbol: string
  /** Decimals of that token: 6 … 18. */
  decimals: number
}

export const USDC: Dollar = { symbol: 'USDC', decimals: 6 }

/** oUSD wei per smallest unit of a `decimals`-decimal dollar (the vault's SCALE). */
export function scaleOf(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error(`unsupported dollar decimals: ${decimals}`)
  return 10n ** BigInt(18 - decimals)
}

/**
 * A decimal STRING → smallest units, exactly. Digits beyond `decimals` are
 * dropped (floor): an amount is never rounded up into money the user did not
 * type. Rejects anything that is not a plain non-negative decimal.
 */
export function parseDollars(text: string, decimals: number): bigint {
  const s = text.trim()
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') throw new Error(`not a dollar amount: "${text}"`)
  const [whole = '', frac = ''] = s.split('.')
  const kept = frac.slice(0, decimals).padEnd(decimals, '0')
  return BigInt((whole || '0') + kept)
}

/**
 * A JS number the user typed (or a UI quick-amount) → smallest units. A
 * float cannot carry 18 decimals, so the number is read at SIX decimals — the
 * finest step the interface offers — and the rest is exact zeros: $0.1 is
 * 100000000000000000 units at 18 decimals, never …006.
 */
export function toUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`not a dollar amount: ${amount}`)
  return parseDollars(amount.toFixed(Math.min(6, decimals)), decimals)
}

/** Smallest units → an exact decimal string (no rounding, no exponent). */
export function unitsToString(units: bigint, decimals: number): string {
  const neg = units < 0n
  const digits = (neg ? -units : units).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const frac = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, '') : ''
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/** Smallest units → a JS number, for DISPLAY only. */
export function fromUnits(units: bigint, decimals: number): number {
  return Number(unitsToString(units, decimals))
}

/** Smallest units → 18-decimal dollar wei (what a message or the hub carries). */
export function unitsToWei(units: bigint, decimals: number): bigint {
  return units * scaleOf(decimals)
}

/** 18-decimal wei → whole smallest units (floor), and the sub-unit dust left over. */
export function weiToUnits(wei: bigint, decimals: number): { units: bigint; dust: bigint } {
  const scale = scaleOf(decimals)
  return { units: wei / scale, dust: wei % scale }
}

/** `bps` basis points off an amount, rounding DOWN (a minimum must never be
 * rounded up past what the chain will deliver). */
export function lessBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error(`bad bps: ${bps}`)
  return (amount * BigInt(10_000 - bps)) / 10_000n
}
