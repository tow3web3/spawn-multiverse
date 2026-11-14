/**
 * The SPAWN! wire (protocol v7.2), client side: the 18 ↔ 6 decimal bridge,
 * bytes32 ids, and a byte-exact port of programs/spawn-gateway/src/
 * msg_codec.rs (ops 1–7 and 10–13, the four-field envelope, the executor
 * option bytes). The program builds every message itself; the client needs
 * the codec to show a user what will be sent, to check a packet, and to
 * read a hub message.
 */
import { PublicKey } from '@solana/web3.js'
import { EVM_TO_SPL } from './constants'
import { bytesToHex, concat, decodeUtf8, encodeUtf8, hexToBytes, readUintBE, uintBE } from './bytes'

/* --------------------------- decimal bridge --------------------------- */

/** SPL units (6 decimals) → the hub's 18-decimal amount (always exact). */
export function splToE18(units: bigint): bigint {
  if (units < 0n) throw new Error('negative amount')
  return units * EVM_TO_SPL
}

/** The hub's 18-decimal amount → whole SPL units and the sub-unit
 * remainder (in 18-decimal wei) the floor drops — what the program does
 * on every delivery (`U256::split_spl`). */
export function splitE18(amountE18: bigint): { units: bigint; dustE18: bigint } {
  if (amountE18 < 0n) throw new Error('negative amount')
  return { units: amountE18 / EVM_TO_SPL, dustE18: amountE18 % EVM_TO_SPL }
}

/** Parses a decimal string ("12.5") into integer units of `decimals`.
 * Refuses more fractional digits than the unit has (no silent rounding). */
export function parseUnits(s: string, decimals = 6): bigint {
  const m = /^\s*(\d+)(?:\.(\d*))?\s*$/.exec(s)
  if (!m) throw new Error(`not a decimal amount: "${s}"`)
  const frac = m[2] ?? ''
  if (frac.length > decimals) throw new Error(`"${s}" has more than ${decimals} decimals`)
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')
}

export function formatUnits(v: bigint, decimals = 6): string {
  const neg = v < 0n
  const a = neg ? -v : v
  const base = 10n ** BigInt(decimals)
  const frac = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${a / base}${frac ? '.' + frac : ''}`
}

/* ------------------------------ bytes32 ------------------------------- */

/** A hub token id (or any EVM address) as the 32-byte wire rider: the
 * 20-byte address left-padded with zeros. Accepts a 20-byte address or a
 * full 32-byte hex word. */
export function toBytes32(x: string | Uint8Array | PublicKey): Uint8Array {
  if (x instanceof PublicKey) return x.toBytes()
  const b = typeof x === 'string' ? hexToBytes(x) : x
  if (b.length === 32) return Uint8Array.from(b)
  if (b.length === 20) return concat(new Uint8Array(12), b)
  throw new Error(`a wire id is 20 or 32 bytes, got ${b.length}`)
}

export const tokenId = toBytes32

export function bytes32ToHex(b: Uint8Array): string {
  if (b.length !== 32) throw new Error('not 32 bytes')
  return bytesToHex(b)
}

/** The EVM address inside a left-padded rider, or null for a wide one (a
 * Solana pubkey uses all 32 bytes). */
export function bytes32ToEvmAddress(b: Uint8Array): string | null {
  if (b.length !== 32 || b.slice(0, 12).some((x) => x !== 0)) return null
  return bytesToHex(b.slice(12))
}

/* ------------------------------- codec -------------------------------- */

export const OP = {
  SPAWN: 1,
  BUY: 2,
  SELL: 3,
  CLAIM: 4,
  PULL_FEES: 5,
  OPEN: 6,
  MOVE: 7,
  SYNC_TOKEN: 10,
  DELIVER: 11,
  PAYOUT: 12,
  FEE_DROP: 13,
} as const

type B32 = Uint8Array
export type SpawnMsg =
  | { op: 'SPAWN'; creator: B32; name: string; symbol: string; metaUri: string; devBuyUsd: bigint; feeMode: number }
  /** v7.2: `minTokensOut` (18-decimal token units; 0 = none) rides the wire. */
  | { op: 'BUY'; hubToken: B32; buyer: B32; usdIn: bigint; minTokensOut: bigint }
  /** v7.2: `minUsdOut` (net dollars, 18 decimals; 0 = none) rides the wire. */
  | { op: 'SELL'; hubToken: B32; seller: B32; tokensIn: bigint; minUsdOut: bigint }
  | { op: 'CLAIM'; hubToken: B32; claimer: B32 }
  | { op: 'PULL_FEES'; hubToken: B32 }
  /** v7.2: ask the hub for this chain's replica of a token. */
  | { op: 'OPEN'; hubToken: B32 }
  /** v7.2: a claim burned here, paid out to (`dstChain`, `to`). */
  | { op: 'MOVE'; from: B32; to: B32; amount: bigint; dstChain: number }
  | { op: 'SYNC_TOKEN'; hubToken: B32; name: string; symbol: string }
  | { op: 'DELIVER'; hubToken: B32; to: B32; tokens: bigint; refund: bigint }
  | { op: 'PAYOUT'; to: B32; usdOut: bigint }
  | { op: 'FEE_DROP'; hubToken: B32; amount: bigint }

type Slot = { word: Uint8Array } | { tail: Uint8Array }

const word = (b: Uint8Array): Slot => {
  if (b.length !== 32) throw new Error('a word is 32 bytes')
  return { word: b }
}
const uint = (v: bigint): Slot => word(uintBE(v, 32))
const dyn = (data: Uint8Array): Slot => {
  const padded = new Uint8Array(Math.ceil(data.length / 32) * 32)
  padded.set(data)
  return { tail: concat(uintBE(BigInt(data.length), 32), padded) }
}

/** Solidity's abi.encode of a tuple (head/tail). */
function abiEncode(slots: Slot[]): Uint8Array {
  const headLen = slots.length * 32
  const head: Uint8Array[] = []
  const tail: Uint8Array[] = []
  let tailLen = 0
  for (const s of slots) {
    if ('word' in s) head.push(s.word)
    else {
      head.push(uintBE(BigInt(headLen + tailLen), 32))
      tail.push(s.tail)
      tailLen += s.tail.length
    }
  }
  return concat(...head, ...tail)
}

function innerSlots(m: SpawnMsg): Slot[] {
  switch (m.op) {
    case 'SPAWN':
      return [
        word(m.creator),
        dyn(encodeUtf8(m.name)),
        dyn(encodeUtf8(m.symbol)),
        dyn(encodeUtf8(m.metaUri)),
        uint(m.devBuyUsd),
        uint(BigInt(m.feeMode)),
      ]
    case 'BUY':
      return [word(m.hubToken), word(m.buyer), uint(m.usdIn), uint(m.minTokensOut)]
    case 'SELL':
      return [word(m.hubToken), word(m.seller), uint(m.tokensIn), uint(m.minUsdOut)]
    case 'CLAIM':
      return [word(m.hubToken), word(m.claimer)]
    case 'PULL_FEES':
    case 'OPEN':
      return [word(m.hubToken)]
    case 'MOVE':
      if (!Number.isInteger(m.dstChain) || m.dstChain < 0 || m.dstChain > 0xffffffff) throw new Error('dstChain is a uint32')
      return [word(m.from), word(m.to), uint(m.amount), uint(BigInt(m.dstChain))]
    case 'SYNC_TOKEN':
      return [word(m.hubToken), dyn(encodeUtf8(m.name)), dyn(encodeUtf8(m.symbol))]
    case 'DELIVER':
      return [word(m.hubToken), word(m.to), uint(m.tokens), uint(m.refund)]
    case 'PAYOUT':
      return [word(m.to), uint(m.usdOut)]
    case 'FEE_DROP':
      return [word(m.hubToken), uint(m.amount)]
  }
}

/** abi.encode(uint8 op, bytes abi.encode(<op tuple>)) — `SpawnMsg::encode`. */
export function encodeMsg(m: SpawnMsg): Uint8Array {
  return abiEncode([uint(BigInt(OP[m.op])), dyn(abiEncode(innerSlots(m)))])
}

/** The envelope (v7.2): abi.encode(bytes32 srcSender, bytes32 dstAddr,
 * bytes payload, uint256 value). `value` is the destination-native amount
 * the executor was asked to deliver with the message — toward the hub, the
 * reply budget the user prepaid (the hub adapter refuses a delivery that
 * brings less); from the hub, 0. */
export function encodeEnvelope(srcSender: Uint8Array, dstAddr: Uint8Array, payload: Uint8Array, value: bigint): Uint8Array {
  return abiEncode([word(srcSender), word(dstAddr), dyn(payload), uint(value)])
}

/** The exact message a send from this store carries (`send_to_hub.rs`
 * `envelope`): this store as protocol sender, the hub pad as target, and
 * the reply budget (`return_unit × legs`, hub-native wei). */
export function outboundMessage(store: PublicKey, hubPad: Uint8Array, m: SpawnMsg, value: bigint): Uint8Array {
  return encodeEnvelope(store.toBytes(), hubPad, encodeMsg(m), value)
}

/** The executor option bytes of one send (`msg_codec::lz_receive_options`). */
export function lzReceiveOptions(gas: bigint, value: bigint): Uint8Array {
  const head = concat(uintBE(3n, 2), Uint8Array.of(1))
  if (value === 0n) return concat(head, uintBE(17n, 2), Uint8Array.of(1), uintBE(gas, 16))
  return concat(head, uintBE(33n, 2), Uint8Array.of(1), uintBE(gas, 16), uintBE(value, 16))
}

/* ------------------------------ decoding ------------------------------ */

class AbiReader {
  constructor(private d: Uint8Array) {}
  word(slot: number): Uint8Array {
    const s = slot * 32
    if (s + 32 > this.d.length) throw new Error('payload too short')
    return this.d.slice(s, s + 32)
  }
  uint(slot: number): bigint {
    return readUintBE(this.word(slot), 0, 32)
  }
  u8(slot: number): number {
    const w = this.word(slot)
    if (w.slice(0, 31).some((x) => x !== 0)) throw new Error('dirty u8 word')
    return w[31]
  }
  u32(slot: number): number {
    const w = this.word(slot)
    if (w.slice(0, 28).some((x) => x !== 0)) throw new Error('dirty u32 word')
    return Number(readUintBE(w, 28, 4))
  }
  offset(slot: number): number {
    return Number(this.uint(slot))
  }
  bytes(slot: number): Uint8Array {
    const off = Number(this.uint(slot))
    if (off % 32 !== 0 || off + 32 > this.d.length) throw new Error('bad offset')
    const len = Number(readUintBE(this.d, off, 32))
    if (off + 32 + len > this.d.length) throw new Error('bad length')
    return this.d.slice(off + 32, off + 32 + len)
  }
  string(slot: number): string {
    return decodeUtf8(this.bytes(slot))
  }
}

export function decodeMsg(payload: Uint8Array): SpawnMsg {
  const env = new AbiReader(payload)
  const op = env.u8(0)
  const r = new AbiReader(env.bytes(1))
  switch (op) {
    case OP.SPAWN:
      return {
        op: 'SPAWN',
        creator: r.word(0),
        name: r.string(1),
        symbol: r.string(2),
        metaUri: r.string(3),
        devBuyUsd: r.uint(4),
        feeMode: r.u8(5),
      }
    case OP.BUY:
      return { op: 'BUY', hubToken: r.word(0), buyer: r.word(1), usdIn: r.uint(2), minTokensOut: r.uint(3) }
    case OP.SELL:
      return { op: 'SELL', hubToken: r.word(0), seller: r.word(1), tokensIn: r.uint(2), minUsdOut: r.uint(3) }
    case OP.CLAIM:
      return { op: 'CLAIM', hubToken: r.word(0), claimer: r.word(1) }
    case OP.PULL_FEES:
      return { op: 'PULL_FEES', hubToken: r.word(0) }
    case OP.OPEN:
      return { op: 'OPEN', hubToken: r.word(0) }
    case OP.MOVE:
      return { op: 'MOVE', from: r.word(0), to: r.word(1), amount: r.uint(2), dstChain: r.u32(3) }
    case OP.SYNC_TOKEN:
      return { op: 'SYNC_TOKEN', hubToken: r.word(0), name: r.string(1), symbol: r.string(2) }
    case OP.DELIVER:
      return { op: 'DELIVER', hubToken: r.word(0), to: r.word(1), tokens: r.uint(2), refund: r.uint(3) }
    case OP.PAYOUT:
      return { op: 'PAYOUT', to: r.word(0), usdOut: r.uint(1) }
    case OP.FEE_DROP:
      return { op: 'FEE_DROP', hubToken: r.word(0), amount: r.uint(1) }
    default:
      throw new Error(`unknown op ${op}`)
  }
}

export function decodeEnvelope(message: Uint8Array): { srcSender: Uint8Array; dstAddr: Uint8Array; payload: Uint8Array; value: bigint } {
  const r = new AbiReader(message)
  // the canonical offset only: a pre-v7.2 envelope has three head words
  if (r.offset(2) !== 4 * 32) throw new Error('not a v7.2 envelope (payload offset is not 0x80)')
  return { srcSender: r.word(0), dstAddr: r.word(1), payload: r.bytes(2), value: r.uint(3) }
}
