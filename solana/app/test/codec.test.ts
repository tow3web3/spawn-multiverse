/**
 * The client's wire bytes against tests/codec-vectors.json — the vectors
 * ethers produced (contracts/scripts/gen-codec-vectors.js) and the Rust
 * codec decodes and re-encodes byte for byte (`msg_codec.rs` tests).
 */
import { expect } from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import { PublicKey } from '@solana/web3.js'
import {
  SpawnMsg,
  bytes32ToEvmAddress,
  bytesToHex,
  decodeEnvelope,
  decodeMsg,
  encodeEnvelope,
  encodeMsg,
  formatUnits,
  hexToBytes,
  lzReceiveOptions,
  outboundMessage,
  parseUnits,
  splToE18,
  splitE18,
  toBytes32,
} from '../src'
import { SOLANA_DIR } from './harness'

const vectors = JSON.parse(fs.readFileSync(path.join(SOLANA_DIR, 'tests', 'codec-vectors.json'), 'utf8'))
const b = (x: string) => hexToBytes(x)
const u = (x: string) => BigInt(x)

function fromVector(v: any): SpawnMsg {
  const i = v.inner
  switch (v.name) {
    case 'SPAWN':
      return { op: 'SPAWN', creator: b(i[0]), name: i[1], symbol: i[2], metaUri: i[3], devBuyUsd: u(i[4]), feeMode: Number(i[5]) }
    case 'BUY':
      return { op: 'BUY', hubToken: b(i[0]), buyer: b(i[1]), usdIn: u(i[2]) }
    case 'SELL':
      return { op: 'SELL', hubToken: b(i[0]), seller: b(i[1]), tokensIn: u(i[2]) }
    case 'CLAIM':
      return { op: 'CLAIM', hubToken: b(i[0]), claimer: b(i[1]) }
    case 'PULL_FEES':
      return { op: 'PULL_FEES', hubToken: b(i[0]) }
    case 'SYNC_TOKEN':
      return { op: 'SYNC_TOKEN', hubToken: b(i[0]), name: i[1], symbol: i[2] }
    case 'DELIVER':
      return { op: 'DELIVER', hubToken: b(i[0]), to: b(i[1]), tokens: u(i[2]), refund: u(i[3]) }
    case 'PAYOUT':
      return { op: 'PAYOUT', to: b(i[0]), usdOut: u(i[1]) }
    case 'FEE_DROP':
      return { op: 'FEE_DROP', hubToken: b(i[0]), amount: u(i[1]) }
  }
  throw new Error(`unknown vector ${v.name}`)
}

describe('wire codec = the Rust codec vectors', () => {
  it(`encodes all ${vectors.ops.length} op vectors byte for byte, and decodes them back`, () => {
    expect(vectors.ops.length).to.be.at.least(29)
    for (const v of vectors.ops) {
      const msg = fromVector(v)
      expect(bytesToHex(encodeMsg(msg)), `vector ${v.idx} (${v.name})`).to.equal(v.hex.toLowerCase())
      expect(encodeMsg(decodeMsg(b(v.hex)))).to.deep.equal(b(v.hex))
    }
    expect(vectors.ops.some((v: any) => v.wide)).to.equal(true, 'wide (Solana-shaped) riders are covered')
  })

  it('encodes the envelopes byte for byte', () => {
    for (const v of vectors.envelopes) {
      const env = encodeEnvelope(b(v.src), b(v.dst), b(v.payload))
      expect(bytesToHex(env), v.name).to.equal(v.hex.toLowerCase())
      const d = decodeEnvelope(env)
      expect(bytesToHex(d.payload)).to.equal(v.payload.toLowerCase())
    }
  })

  it('builds the executor option bytes of the EVM adapters', () => {
    for (const v of vectors.options) {
      expect(bytesToHex(lzReceiveOptions(BigInt(v.gas), BigInt(v.value))), `option ${v.idx}`).to.equal(v.hex.toLowerCase())
    }
    expect(lzReceiveOptions(1n, 0n).length).to.equal(22)
    expect(lzReceiveOptions(1n, 1n).length).to.equal(38)
  })

  it('a send carries the op inside the envelope: this store → the hub pad', () => {
    const store = new PublicKey('GF11J7y5MhHFVDKJhcMFBYwVD2QirCDF2bJi9U2dUzKB')
    const pad = toBytes32('0x' + 'c2'.repeat(20))
    const msg: SpawnMsg = { op: 'PULL_FEES', hubToken: toBytes32('0x' + '11'.repeat(20)) }
    const out = outboundMessage(store, pad, msg)
    const env = decodeEnvelope(out)
    expect(env.srcSender).to.deep.equal(store.toBytes())
    expect(env.dstAddr).to.deep.equal(pad)
    expect(decodeMsg(env.payload)).to.deep.equal(msg)
  })
})

describe('wire helpers', () => {
  it('the 18 ↔ 6 decimal bridge', () => {
    expect(splToE18(884_495_291_384n)).to.equal(884_495_291_384_000_000_000_000n)
    expect(splitE18(884_495_291_384_607_698_648_615n)).to.deep.equal({ units: 884_495_291_384n, dustE18: 607_698_648_615n })
    expect(parseUnits('12.5')).to.equal(12_500_000n)
    expect(parseUnits('0.000001')).to.equal(1n)
    expect(() => parseUnits('0.0000001')).to.throw()
    expect(formatUnits(12_500_000n)).to.equal('12.5')
    expect(formatUnits(1_000_000n)).to.equal('1')
  })

  it('token ids as bytes32', () => {
    const id = toBytes32('0xC2f3855ECcB6bD2261831743Ece9752ec9E53811')
    expect(id.length).to.equal(32)
    expect(bytesToHex(id)).to.equal('0x000000000000000000000000c2f3855eccb6bd2261831743ece9752ec9e53811')
    expect(bytes32ToEvmAddress(id)).to.equal('0xc2f3855eccb6bd2261831743ece9752ec9e53811')
    expect(bytes32ToEvmAddress(new PublicKey('GF11J7y5MhHFVDKJhcMFBYwVD2QirCDF2bJi9U2dUzKB').toBytes())).to.equal(null)
    expect(() => toBytes32('0x1234')).to.throw()
  })

  it('derives the addresses V7.md §6 states', () => {
    const { GatewayPdas } = require('../src')
    const p = new GatewayPdas()
    expect(p.store.toBase58()).to.equal('GF11J7y5MhHFVDKJhcMFBYwVD2QirCDF2bJi9U2dUzKB')
    expect(bytesToHex(p.store.toBytes())).to.equal('0xe27570e3d9d6dca198b299fae076f3dc69a86c1f543637ed0c21d61d1661aefa')
    expect(p.vault.toBase58()).to.equal('Bgf7rsFXzp6vDD8zZKwsDViKW3FT8LDdhB63My5a5nZB')
    expect(p.gasTank.toBase58()).to.equal('9hPZ897FzdLBQnGZpvFo8TwyKu7KGRTYB41LDHVMJCqW')
  })
})
