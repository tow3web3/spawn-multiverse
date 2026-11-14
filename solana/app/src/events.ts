import { PublicKey } from '@solana/web3.js'
import { EVENT_DISC } from './constants'
import { BorshReader, equalBytes } from './bytes'

export interface SentToHub {
  op: number
  user: PublicKey
  /** Lamports LayerZero actually charged. */
  nativeFee: bigint
  legs: number
  sponsored: boolean
  /** The deadline a BUY or SELL left with (unix seconds, stamped from the
   * cluster clock; the hub reads it against its own); 0n otherwise. */
  deadline: bigint
}

function b64(s: string): Uint8Array | null {
  try {
    const bin = atob(s)
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** The `SentToHub` event of a send, from its logs (`Program data: …`). */
export function findSentToHub(logs: string[]): SentToHub | null {
  for (const l of logs) {
    if (!l.startsWith('Program data: ')) continue
    const raw = b64(l.slice('Program data: '.length))
    if (!raw || raw.length < 60 || !equalBytes(raw.slice(0, 8), EVENT_DISC.SentToHub)) continue
    const r = new BorshReader(raw, 8)
    // `legs` is a u16 since v7.2: a move prepays up to 4,096 of them
    return { op: r.u8(), user: new PublicKey(r.fixed(32)), nativeFee: r.u64(), legs: r.u16(), sponsored: r.bool(), deadline: r.u64() }
  }
  return null
}

export interface PaidOut {
  to: PublicKey
  /** USDC units that left the vault… */
  usdc: bigint
  /** …or the claim that was booked instead. */
  claim: bigint
}

function events<T>(logs: string[], disc: Uint8Array, min: number, read: (r: BorshReader) => T): T[] {
  const out: T[] = []
  for (const l of logs) {
    if (!l.startsWith('Program data: ')) continue
    const raw = b64(l.slice('Program data: '.length))
    if (!raw || raw.length < min || !equalBytes(raw.slice(0, 8), disc)) continue
    out.push(read(new BorshReader(raw, 8)))
  }
  return out
}

/** How the dollars of a delivered hub message settled (`PaidOut`). */
export function findPaidOut(logs: string[]): PaidOut[] {
  return events(logs, EVENT_DISC.PaidOut, 56, (r) => ({ to: new PublicKey(r.fixed(32)), usdc: r.u64(), claim: r.u64() }))
}

/** Who paid the rent of an account a hub message created: the lamports the
 * message brought, the program's tank, or whoever executed it. */
export const RENT_FROM = ['message', 'tank', 'caller'] as const
export type RentFrom = (typeof RENT_FROM)[number]

/** User accounts a hub message opened for a recipient who had none. */
export function findUserAccountOpened(logs: string[]): { owner: PublicKey; rentFrom: RentFrom }[] {
  return events(logs, EVENT_DISC.UserAccountOpened, 41, (r) => ({ owner: new PublicKey(r.fixed(32)), rentFrom: RENT_FROM[r.u8()] }))
}

/** Lamports a hub message arrived with, and how many it left in the tank. */
export function findValueReceived(logs: string[]): { lamports: bigint; toTank: bigint }[] {
  return events(logs, EVENT_DISC.ValueReceived, 24, (r) => ({ lamports: r.u64(), toTank: r.u64() }))
}
