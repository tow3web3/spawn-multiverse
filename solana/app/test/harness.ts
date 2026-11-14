/**
 * The local world of the client tests: LiteSVM (Node binding) with the
 * gateway's built program and the REAL LayerZero V2 programs and state of
 * Solana mainnet, exactly as tests/test_live_endpoint.rs loads them
 * (tests/fixtures/mainnet, from `tests/fetch-fixtures.sh mainnet`), plus
 * Circle's real USDC mint. The client talks to it through the same
 * `GatewayRpc` interface it uses against an RPC node.
 *
 * Throwaway keys only. Nothing here reads .keys/.
 */
import * as fs from 'fs'
import * as path from 'path'
import { FailedTransactionMetadata, LiteSVM, TransactionMetadata } from 'litesvm'
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  Signer,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  AccountData,
  GatewayPdas,
  GatewayRpc,
  LZ_ENDPOINT,
  LZ_EXECUTOR,
  LZ_IX,
  LzReceiveParams,
  StepSender,
  TOKEN_PROGRAM,
  assembleV0,
  ata,
  concat,
  decodeSendConfig,
  describeIx,
  encodeEnvelope,
  encodeLzReceiveParams,
  encodeMsg,
  lzPda,
  resolveLzReceiveAccounts,
  SpawnMsg,
  toBuffer,
  txSize,
  uintBE,
  uintLE,
} from '../src'

export const SOLANA_DIR = path.resolve(__dirname, '..', '..')
const FIX = path.join(SOLANA_DIR, 'tests', 'fixtures', 'mainnet')
export const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')

export interface FixtureAccount {
  name: string
  dvn?: string
  pubkey: PublicKey
  owner: PublicKey
  lamports: number
  data: Uint8Array
}

export function fixtureAccounts(): FixtureAccount[] {
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, 'accounts.json'), 'utf8'))
  return raw.map((a: any) => ({
    name: a.name,
    dvn: a.dvn,
    pubkey: new PublicKey(a.pubkey),
    owner: new PublicKey(a.owner),
    lamports: a.lamports,
    data: new Uint8Array(Buffer.from(a.data_b64, 'base64')),
  }))
}

/** (fixture label suffix) → DVN config account, e.g. "Google". */
export function fixtureDvn(name: string): PublicKey {
  const a = fixtureAccounts().find((x) => x.dvn?.endsWith(`|${name}`))
  if (!a) throw new Error(`no DVN fixture ${name}`)
  return a.pubkey
}

export interface Sent {
  logs: string[]
  cu: number
  size: number
  innerData: Uint8Array[]
}

function failure(r: FailedTransactionMetadata): string {
  return `${r.err().toString()}\n${r.meta().logs().join('\n')}`
}

export class World {
  readonly svm: LiteSVM
  readonly pdas = new GatewayPdas()
  /** The signer LayerZero's executor sees (enlisted in its config). */
  readonly exec = Keypair.generate()

  constructor() {
    this.svm = new LiteSVM()
    this.svm.addProgram(this.pdas.programId, fs.readFileSync(path.join(SOLANA_DIR, 'target', 'deploy', 'spawn_gateway.so')))
    const programs = JSON.parse(fs.readFileSync(path.join(FIX, 'programs.json'), 'utf8'))
    for (const p of programs) this.svm.addProgram(new PublicKey(p.id), fs.readFileSync(path.join(FIX, p.file)))
    for (const a of fixtureAccounts()) {
      this.svm.setAccount(a.pubkey, { lamports: a.lamports, data: a.data, owner: a.owner, executable: false })
    }
    this.svm.airdrop(this.exec.publicKey, 1_000_000_000n)
    this.warp(100n)
  }

  /** Advances the clock, and keeps SlotHashes current (LiteSVM's warp
   * leaves it at slot 0; `createLookupTable` wants a recent slot). */
  warp(slot: bigint) {
    this.svm.warpToSlot(slot)
    const hs = this.svm.getSlotHashes()
    hs[0].slot = slot
    this.svm.setSlotHashes(hs)
  }

  slot(): bigint {
    return this.svm.getClock().slot
  }

  /* --------------------------- the client's rpc -------------------------- */

  rpc(): GatewayRpc {
    return {
      getAccounts: async (keys) => keys.map((k) => this.account(k)),
      simulate: async (tx) => {
        // an RPC node simulates with sigVerify: false; so does this
        this.svm.withSigverify(false)
        const r = this.svm.simulateTransaction(tx)
        this.svm.withSigverify(true)
        if ('err' in r) {
          return { err: r.err().toString(), logs: r.meta().logs() }
        }
        const m = r.meta()
        const rd = m.returnData().data()
        return { err: null, logs: m.logs(), unitsConsumed: Number(m.computeUnitsConsumed()), returnData: rd.length ? rd : undefined }
      },
      latestBlockhash: async () => this.svm.latestBlockhash(),
      slot: async () => Number(this.slot()),
      rent: async (bytes) => this.svm.minimumBalanceForRentExemption(BigInt(bytes)),
    }
  }

  account(k: PublicKey): AccountData | null {
    const a = this.svm.getAccount(k)
    if (!a || (a.lamports === 0 && a.data.length === 0)) return null
    return { owner: a.owner, data: a.data, lamports: a.lamports, executable: a.executable }
  }

  lamports(k: PublicKey): bigint {
    return this.svm.getBalance(k) ?? 0n
  }

  tokenAmount(k: PublicKey): bigint {
    const a = this.svm.getAccount(k)
    if (!a || a.data.length < 72) return 0n
    return Buffer.from(a.data).readBigUInt64LE(64)
  }

  /* -------------------------------- sending ------------------------------ */

  /** Signs and sends; throws with the logs on failure. */
  sendTx(tx: VersionedTransaction, signers: Signer[]): Sent {
    tx.sign(signers)
    const size = txSize(tx)
    const r = this.svm.sendTransaction(tx)
    this.svm.expireBlockhash()
    if ('err' in r) throw new Error(failure(r as FailedTransactionMetadata))
    const m = r as TransactionMetadata
    return {
      logs: m.logs(),
      cu: Number(m.computeUnitsConsumed()),
      size,
      innerData: m
        .innerInstructions()
        .flat()
        .map((i) => i.instruction().data()),
    }
  }

  send(payer: Keypair, ixs: TransactionInstruction[], signers: Signer[] = [], tables: AddressLookupTableAccount[] = [], computeUnits = 1_400_000): Sent {
    const tx = assembleV0({ payer: payer.publicKey, instructions: ixs, recentBlockhash: this.svm.latestBlockhash(), lookupTables: tables, computeUnits })
    return this.sendTx(tx, [payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey))])
  }

  /** A wiring sender over LiteSVM that also records what it sent. */
  sender(admin: Keypair, record: string[] = []): StepSender {
    return {
      dryRun: false,
      send: async (label, ixs, extra = [], tables = []) => {
        record.push(label)
        this.send(admin, ixs, extra, tables)
      },
      // a freshly extended table is usable from the next slot
      settle: async () => this.warp(this.slot() + 1n),
    }
  }

  newUser(lamports = 5_000_000_000n): Keypair {
    const k = Keypair.generate()
    this.svm.airdrop(k.publicKey, lamports)
    return k
  }

  /** A synthetic SPL token account (what `plant_token_account` does). */
  plantTokenAccount(addr: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint) {
    const data = new Uint8Array(165)
    data.set(mint.toBytes(), 0)
    data.set(owner.toBytes(), 32)
    data.set(uintLE(amount, 8), 64)
    data[108] = 1
    this.svm.setAccount(addr, { lamports: 2_039_280, data, owner: TOKEN_PROGRAM, executable: false })
  }

  giveUsdc(owner: PublicKey, amount: bigint): PublicKey {
    const a = ata(owner, USDC)
    this.plantTokenAccount(a, USDC, owner, amount)
    return a
  }

  setTokenAmount(account: PublicKey, amount: bigint) {
    const a = this.svm.getAccount(account)!
    const data = Uint8Array.from(a.data)
    data.set(uintLE(amount, 8), 64)
    this.svm.setAccount(account, { ...a, data })
  }

  /* ----------------------- the hub's side of the wire --------------------- */

  /** The executor config the default send config names. */
  executorConfig(): PublicKey {
    const cfg = fixtureAccounts().find((a) => a.name === 'default_send_config')!
    return decodeSendConfig(cfg.data).executor.executor
  }

  /** Swaps `exec` into the real ExecutorConfig's executors list — the only
   * edit to mainnet state, as in the Rust tests. */
  enlistExecutor() {
    const cfg = this.executorConfig()
    const a = this.svm.getAccount(cfg)!
    const d = Buffer.from(a.data)
    let off = 8 + 1 + 32
    for (let i = 0; i < 3; i++) off += 4 + d.readUInt32LE(off) * 32
    if (d.readUInt32LE(off) < 1) throw new Error('no executor listed')
    d.set(this.exec.publicKey.toBytes(), off + 4)
    this.svm.setAccount(cfg, { ...a, data: new Uint8Array(d) })
  }

  /** Plants a VERIFIED inbound packet: the payload hash account and an
   * inbound nonce that covers it (what DVNs + the ULN commit leave). */
  plantVerified(hubEid: number, hubAdapter: Uint8Array, nonce: bigint, guid: Uint8Array, message: Uint8Array) {
    const { keccak_256 } = require('@noble/hashes/sha3')
    const [ph, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('PayloadHash'), this.pdas.store.toBuffer(), uintBE(BigInt(hubEid), 4), hubAdapter, uintBE(nonce, 8)],
      LZ_ENDPOINT,
    )
    const disc = require('crypto').createHash('sha256').update('account:PayloadHash').digest().subarray(0, 8)
    const data = concat(disc, keccak_256(concat(guid, message)), Uint8Array.of(bump))
    this.svm.setAccount(ph, { lamports: 1_200_000, data, owner: LZ_ENDPOINT, executable: false })
    const nk = lzPda.nonce(this.pdas.store, hubEid, hubAdapter)
    const n = this.svm.getAccount(nk)!
    const nd = Buffer.from(n.data)
    if (nd.readBigUInt64LE(17) < nonce) nd.writeBigUInt64LE(nonce, 17)
    this.svm.setAccount(nk, { ...n, data: new Uint8Array(nd) })
  }

  /** Circle's REAL CCTP V2 programs and mainnet state
   * (tests/fetch-cctp.cjs), for the vault's outbound leg. */
  loadCctp() {
    const f = JSON.parse(fs.readFileSync(path.join(FIX, 'cctp.json'), 'utf8'))
    for (const p of f.programs) this.svm.addProgram(new PublicKey(p.id), fs.readFileSync(path.join(FIX, p.file)))
    for (const a of f.accounts) {
      this.svm.setAccount(new PublicKey(a.pubkey), {
        lamports: a.lamports,
        data: new Uint8Array(Buffer.from(a.data_b64, 'base64')),
        owner: new PublicKey(a.owner),
        executable: false,
      })
    }
  }

  /** A hub message delivered the way mainnet does it: LayerZero's REAL
   * executor program `execute` → our `lz_receive` → the real `clear`, with
   * the account list our `lz_receive_types_v2` returns, resolved by the
   * client. `value` is what the packet bought and `named` what its
   * envelope says it bought (the hub always buys, and says, 0). */
  async execute(
    hubEid: number,
    hubPad: Uint8Array,
    hubAdapter: Uint8Array,
    nonce: bigint,
    msg: SpawnMsg,
    value = 0n,
    named = 0n,
  ): Promise<Sent> {
    const message = encodeEnvelope(hubPad, this.pdas.store.toBytes(), encodeMsg(msg), named)
    const { keccak_256 } = require('@noble/hashes/sha3')
    const guid: Uint8Array = keccak_256(concat(Buffer.from('guid'), uintBE(nonce, 8)))
    this.plantVerified(hubEid, hubAdapter, nonce, guid, message)
    const params: LzReceiveParams = { srcEid: hubEid, sender: hubAdapter, nonce, guid, message, extraData: new Uint8Array() }
    const { accounts, alts } = await resolveLzReceiveAccounts(this.rpc(), this.pdas, params, this.exec.publicKey)
    const data = concat(LZ_IX.execute, this.pdas.store.toBytes(), encodeLzReceiveParams(params), uintLE(value, 8), uintLE(400_000n, 8))
    const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false })
    const ix = new TransactionInstruction({
      programId: LZ_EXECUTOR,
      data: toBuffer(data),
      keys: [
        { pubkey: this.exec.publicKey, isSigner: true, isWritable: true },
        ro(this.executorConfig()),
        ro(LZ_ENDPOINT),
        ro(lzPda.endpointEventAuthority()),
        ro(lzPda.eventAuthority(LZ_EXECUTOR)),
        ro(LZ_EXECUTOR),
        ro(this.pdas.programId),
        ...accounts,
      ],
    })
    return this.send(this.exec, [ix], [], alts)
  }
}

export { describeIx }

/** Prints a measurement line and keeps it for the summary. */
export const measurements: string[] = []
export function measure(line: string) {
  measurements.push(line)
  console.log('      ' + line)
}
