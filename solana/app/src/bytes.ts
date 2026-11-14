/**
 * Byte plumbing shared by the codec, the Borsh encoders and the decoders.
 * Plain Uint8Array + bigint: no Node `Buffer` in the core, so the library
 * bundles for a browser without polyfills of its own (web3.js brings its
 * own `Buffer` shim where it needs one).
 */

import { Buffer } from 'buffer'

/** web3.js v1 wants `Buffer` in instruction data. Imported from the
 * `buffer` package (Node's builtin under Node, the polyfill web3.js already
 * depends on in a browser bundle) — never the global. */
export function toBuffer(b: Uint8Array): Buffer {
  return Buffer.from(b.buffer as ArrayBuffer, b.byteOffset, b.length)
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error(`bad hex: ${hex}`)
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16)
  return out
}

export function bytesToHex(b: Uint8Array, prefix = true): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return prefix ? '0x' + s : s
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(n)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Index of `needle` in `hay`, or -1. */
export function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/** Unsigned big-endian of `width` bytes. Refuses values that do not fit. */
export function uintBE(v: bigint, width: number): Uint8Array {
  if (v < 0n || v >= 1n << BigInt(8 * width)) throw new Error(`${v} does not fit ${width} bytes`)
  const out = new Uint8Array(width)
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

export function uintLE(v: bigint, width: number): Uint8Array {
  return uintBE(v, width).reverse()
}

export function readUintLE(b: Uint8Array, off: number, width: number): bigint {
  let v = 0n
  for (let i = width - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i])
  return v
}

export function readUintBE(b: Uint8Array, off: number, width: number): bigint {
  let v = 0n
  for (let i = 0; i < width; i++) v = (v << 8n) | BigInt(b[off + i])
  return v
}

const utf8 = new TextEncoder()
const utf8d = new TextDecoder('utf-8', { fatal: true })
export const encodeUtf8 = (s: string): Uint8Array => utf8.encode(s)
export const decodeUtf8 = (b: Uint8Array): string => utf8d.decode(b)

/* ------------------------------- Borsh -------------------------------- */

/** The few Borsh shapes the program's instruction arguments use. */
export class BorshWriter {
  private parts: Uint8Array[] = []
  raw(b: Uint8Array): this {
    this.parts.push(b)
    return this
  }
  u8(v: number): this {
    return this.raw(Uint8Array.of(v & 0xff))
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0)
  }
  u32(v: number | bigint): this {
    return this.raw(uintLE(BigInt(v), 4))
  }
  u64(v: number | bigint): this {
    return this.raw(uintLE(BigInt(v), 8))
  }
  u128(v: number | bigint): this {
    return this.raw(uintLE(BigInt(v), 16))
  }
  fixed(b: Uint8Array, len: number): this {
    if (b.length !== len) throw new Error(`expected ${len} bytes, got ${b.length}`)
    return this.raw(b)
  }
  bytes(b: Uint8Array): this {
    return this.u32(b.length).raw(b)
  }
  string(s: string): this {
    return this.bytes(encodeUtf8(s))
  }
  done(): Uint8Array {
    return concat(...this.parts)
  }
}

export class BorshReader {
  off: number
  constructor(public readonly data: Uint8Array, off = 0) {
    this.off = off
  }
  private need(n: number) {
    if (this.off + n > this.data.length) throw new Error(`account data too short at ${this.off}+${n}`)
  }
  u8(): number {
    this.need(1)
    return this.data[this.off++]
  }
  bool(): boolean {
    return this.u8() !== 0
  }
  u16(): number {
    this.need(2)
    const v = Number(readUintLE(this.data, this.off, 2))
    this.off += 2
    return v
  }
  u32(): number {
    this.need(4)
    const v = Number(readUintLE(this.data, this.off, 4))
    this.off += 4
    return v
  }
  u64(): bigint {
    this.need(8)
    const v = readUintLE(this.data, this.off, 8)
    this.off += 8
    return v
  }
  u128(): bigint {
    this.need(16)
    const v = readUintLE(this.data, this.off, 16)
    this.off += 16
    return v
  }
  fixed(n: number): Uint8Array {
    this.need(n)
    const v = this.data.slice(this.off, this.off + n)
    this.off += n
    return v
  }
  bytes(): Uint8Array {
    return this.fixed(this.u32())
  }
  string(): string {
    return decodeUtf8(this.bytes())
  }
  skip(n: number): this {
    this.need(n)
    this.off += n
    return this
  }
}
