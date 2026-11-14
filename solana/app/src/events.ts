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
    if (!raw || raw.length < 51 || !equalBytes(raw.slice(0, 8), EVENT_DISC.SentToHub)) continue
    const r = new BorshReader(raw, 8)
    return { op: r.u8(), user: new PublicKey(r.fixed(32)), nativeFee: r.u64(), legs: r.u8(), sponsored: r.bool() }
  }
  return null
}
