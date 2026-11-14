/**
 * LayerZero V2 on Solana, as far as this gateway needs it: reading the
 * endpoint / ULN / worker state that decides a send's account list, the
 * list itself in the order `send_to_hub.rs` documents, and the delegate's
 * endpoint instructions used by the wiring.
 *
 * Layouts were read from the real mainnet accounts in
 * tests/fixtures/mainnet/accounts.json (and match what
 * tests/test_live_endpoint.rs parses); the decoders check discriminators.
 */
import { AccountMeta, PublicKey, TransactionInstruction } from '@solana/web3.js'
import { LZ_ENDPOINT, LZ_IX, LZ_ULN, SYSTEM_PROGRAM } from './constants'
import { BorshReader, BorshWriter, concat, equalBytes, hexToBytes, toBuffer, uintLE } from './bytes'
import { lzPda } from './pda'
import { AccountData, GatewayRpc } from './rpc'

const DISC = {
  SendLibraryConfig: hexToBytes('3dee1f48fb7542b0'),
  ReceiveLibraryConfig: hexToBytes('8ee2fb8a01ce5bc1'),
  SendConfig: hexToBytes('5bdd878983c7ae19'),
  ReceiveConfig: hexToBytes('a29f99bc3841f53a'),
  UlnSettings: hexToBytes('e2c764fd2673a79a'),
  ExecutorConfig: hexToBytes('8611e2180aad9d4e'),
  DvnConfig: hexToBytes('31512162eaa85d49'),
  Nonce: hexToBytes('8fc5935f6aa5322b'),
}

function check(data: Uint8Array, disc: Uint8Array, what: string): BorshReader {
  if (data.length < 8 || !equalBytes(data.slice(0, 8), disc)) throw new Error(`${what}: discriminator mismatch`)
  return new BorshReader(data, 8)
}
const key = (r: BorshReader) => new PublicKey(r.fixed(32))
const keyVec = (r: BorshReader) => Array.from({ length: r.u32() }, () => key(r))
const DEFAULT_KEY = PublicKey.default

/* ------------------------------ decoders ------------------------------ */

export function decodeSendLibraryConfig(data: Uint8Array): { messageLib: PublicKey } {
  const r = check(data, DISC.SendLibraryConfig, 'SendLibraryConfig')
  return { messageLib: key(r) }
}

/** ReceiveLibraryConfig: message_lib, timeout: Option<{message_lib, expiry}>, bump.
 * The default key (all zeros) means "whatever the endpoint's default is". */
export function decodeReceiveLibraryConfig(data: Uint8Array): { messageLib: PublicKey } {
  const r = check(data, DISC.ReceiveLibraryConfig, 'ReceiveLibraryConfig')
  return { messageLib: key(r) }
}

export interface UlnConfig {
  confirmations: bigint
  requiredDvnCount: number
  optionalDvnCount: number
  optionalDvnThreshold: number
  requiredDvns: PublicKey[]
  optionalDvns: PublicKey[]
}

export interface SendConfig {
  uln: UlnConfig
  executor: { maxMessageSize: number; executor: PublicKey }
}

function readUln(r: BorshReader): UlnConfig {
  return {
    confirmations: r.u64(),
    requiredDvnCount: r.u8(),
    optionalDvnCount: r.u8(),
    optionalDvnThreshold: r.u8(),
    requiredDvns: keyVec(r),
    optionalDvns: keyVec(r),
  }
}

export function decodeSendConfig(data: Uint8Array): SendConfig {
  const r = check(data, DISC.SendConfig, 'SendConfig')
  r.u8() // bump
  const uln = readUln(r)
  return { uln, executor: { maxMessageSize: r.u32(), executor: key(r) } }
}

/** ReceiveConfig: bump + UlnConfig (no executor part). */
export function decodeReceiveConfig(data: Uint8Array): UlnConfig {
  const r = check(data, DISC.ReceiveConfig, 'ReceiveConfig')
  r.u8()
  return readUln(r)
}

export function compareKeys(a: PublicKey, b: PublicKey): number {
  const x = a.toBytes()
  const y = b.toBytes()
  for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/** The ULN treasury's native receiver, or null when the ULN has none (the
 * send list then carries the ULN program id as Anchor's `None`). */
export function decodeUlnTreasury(data: Uint8Array): PublicKey | null {
  const r = check(data, DISC.UlnSettings, 'UlnSettings')
  r.skip(4 + 32 + 32 + 1 + 32) // eid, endpoint, endpoint_program, bump, admin
  if (r.u8() === 0) return null
  if (r.u8() === 1) r.skip(32) // treasury.admin: Option<Pubkey>
  return key(r)
}

/** ExecutorConfig: bump owner acl{allow,deny} admins executors msglibs
 * paused default_multiplier_bps price_feed … */
export function decodeExecutorPriceFeed(data: Uint8Array): PublicKey {
  const r = check(data, DISC.ExecutorConfig, 'ExecutorConfig')
  r.skip(1 + 32)
  for (let i = 0; i < 5; i++) keyVec(r)
  r.skip(1 + 2)
  return key(r)
}

/** DvnConfig: vid bump multisig{signers Vec<[u8;64]>, quorum} acl{allow,deny}
 * paused admins msglibs price_feed … */
export function decodeDvnPriceFeed(data: Uint8Array): PublicKey {
  const r = check(data, DISC.DvnConfig, 'DvnConfig')
  r.skip(4 + 1)
  r.skip(r.u32() * 64 + 1)
  keyVec(r)
  keyVec(r)
  r.skip(1)
  keyVec(r)
  keyVec(r)
  return key(r)
}

/** Endpoint Nonce: bump, outbound, inbound. */
export function decodeNonce(data: Uint8Array): { outbound: bigint; inbound: bigint } {
  const r = check(data, DISC.Nonce, 'Nonce')
  r.u8()
  return { outbound: r.u64(), inbound: r.u64() }
}

/* ------------------------ effective configuration --------------------- */

const NIL_CONFIRMATIONS = (1n << 64n) - 1n
const NIL_COUNT = 255

/** The ULN's merge of an OApp's own config over the pathway default
 * (0 = take the default, NIL = explicitly none). */
export function effectiveUln(def: UlnConfig, custom: UlnConfig | null): UlnConfig {
  if (!custom) return def
  const out: UlnConfig = { ...def }
  if (custom.confirmations === NIL_CONFIRMATIONS) out.confirmations = 0n
  else if (custom.confirmations !== 0n) out.confirmations = custom.confirmations
  if (custom.requiredDvnCount === NIL_COUNT) {
    out.requiredDvnCount = 0
    out.requiredDvns = []
  } else if (custom.requiredDvnCount !== 0) {
    out.requiredDvnCount = custom.requiredDvnCount
    out.requiredDvns = custom.requiredDvns
  }
  if (custom.optionalDvnCount === NIL_COUNT) {
    out.optionalDvnCount = 0
    out.optionalDvns = []
    out.optionalDvnThreshold = 0
  } else if (custom.optionalDvnCount !== 0) {
    out.optionalDvnCount = custom.optionalDvnCount
    out.optionalDvns = custom.optionalDvns
    out.optionalDvnThreshold = custom.optionalDvnThreshold
  }
  return out
}

/* ------------------------------ send path ----------------------------- */

/** A worker as the ULN wants it in the send list: its program, its config
 * account, and the price feed its config names. */
export interface Worker {
  program: PublicKey
  config: PublicKey
  priceFeedProgram: PublicKey
  priceFeedConfig: PublicKey
}

export interface SendPath {
  oapp: PublicKey
  dstEid: number
  receiver: Uint8Array
  sendLibProgram: PublicKey
  /** The message library account (ULN 302's settings PDA). */
  msglib: PublicKey
  treasury: PublicKey | null
  uln: UlnConfig
  maxMessageSize: number
  executor: Worker
  /** Required DVNs first, then optional ones, in config order. */
  dvns: Worker[]
}

async function need(rpc: GatewayRpc, keys: PublicKey[], what: string[]): Promise<AccountData[]> {
  const got = await rpc.getAccounts(keys)
  return got.map((a, i) => {
    if (!a) throw new Error(`${what[i]} (${keys[i].toBase58()}) does not exist on this cluster`)
    return a
  })
}

/** Reads everything that decides a send's account list for `oapp` → `dstEid`.
 * Stable until the delegate changes the libraries or verifier set: cache
 * it per session, re-resolve when a send fails with a config mismatch. */
export async function resolveSendPath(
  rpc: GatewayRpc,
  oapp: PublicKey,
  dstEid: number,
  receiver: Uint8Array,
  /** Plan with this verifier set instead of the one on chain (the wiring's
   * dry run, before the delegate has set it). */
  ulnOverride?: UlnConfig,
): Promise<SendPath> {
  const [own, def] = await rpc.getAccounts([lzPda.sendLibraryConfig(oapp, dstEid), lzPda.defaultSendLibraryConfig(dstEid)])
  if (!def) throw new Error(`the endpoint has no default send library toward eid ${dstEid}`)
  let msglib = decodeSendLibraryConfig(def.data).messageLib
  if (own) {
    const m = decodeSendLibraryConfig(own.data).messageLib
    if (!m.equals(DEFAULT_KEY)) msglib = m
  }
  const [lib] = await need(rpc, [msglib], ['send library'])
  const sendLibProgram = lib.owner
  if (!sendLibProgram.equals(LZ_ULN)) {
    throw new Error(`send library ${msglib.toBase58()} is owned by ${sendLibProgram.toBase58()}, not ULN 302: unsupported`)
  }
  const treasury = decodeUlnTreasury(lib.data)

  const [ownCfg, defCfg] = await rpc.getAccounts([lzPda.sendConfig(dstEid, oapp), lzPda.defaultSendConfig(dstEid)])
  if (!defCfg) throw new Error(`the ULN has no default send config toward eid ${dstEid}`)
  const d = decodeSendConfig(defCfg.data)
  const c = ownCfg ? decodeSendConfig(ownCfg.data) : null
  const uln = ulnOverride ?? effectiveUln(d.uln, c?.uln ?? null)
  const executorCfg = c && !c.executor.executor.equals(DEFAULT_KEY) ? c.executor.executor : d.executor.executor
  const maxMessageSize = c && c.executor.maxMessageSize !== 0 ? c.executor.maxMessageSize : d.executor.maxMessageSize

  const dvnCfgs = [...uln.requiredDvns, ...uln.optionalDvns]
  const cfgs = await need(rpc, [executorCfg, ...dvnCfgs], ['executor config', ...dvnCfgs.map((k) => `DVN config ${k}`)])
  const feeds = [decodeExecutorPriceFeed(cfgs[0].data), ...cfgs.slice(1).map((a) => decodeDvnPriceFeed(a.data))]
  const uniqueFeeds = [...new Map(feeds.map((f) => [f.toBase58(), f])).values()]
  const feedAccs = await need(rpc, uniqueFeeds, uniqueFeeds.map((f) => `price feed ${f}`))
  const feedOwner = new Map(uniqueFeeds.map((f, i) => [f.toBase58(), feedAccs[i].owner]))
  const workers: Worker[] = [executorCfg, ...dvnCfgs].map((config, i) => ({
    program: cfgs[i].owner,
    config,
    priceFeedProgram: feedOwner.get(feeds[i].toBase58())!,
    priceFeedConfig: feeds[i],
  }))
  return {
    oapp,
    dstEid,
    receiver,
    sendLibProgram,
    msglib,
    treasury,
    uln,
    maxMessageSize,
    executor: workers[0],
    dvns: workers.slice(1),
  }
}

const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false })
const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true })

/** The endpoint SEND list — remaining_accounts of every send, in the order
 * `send_to_hub.rs` documents, `payer` at index 13 (the user: the ULN
 * debits it). The quote takes the same list (the program strips the
 * writable bits itself). */
export function sendRemainingAccounts(path: SendPath, payer: PublicKey, payerSigns = true): AccountMeta[] {
  const { oapp, dstEid } = path
  const uln = path.sendLibProgram
  const list: AccountMeta[] = [
    ro(LZ_ENDPOINT),
    ro(oapp),
    ro(uln),
    ro(lzPda.sendLibraryConfig(oapp, dstEid)),
    ro(lzPda.defaultSendLibraryConfig(dstEid)),
    ro(lzPda.messageLibInfo(path.msglib)), // MUST stay read-only
    ro(lzPda.endpointSettings()),
    rw(lzPda.nonce(oapp, dstEid, path.receiver)),
    ro(lzPda.endpointEventAuthority()),
    ro(LZ_ENDPOINT),
    ro(path.msglib),
    ro(lzPda.sendConfig(dstEid, oapp, uln)),
    ro(lzPda.defaultSendConfig(dstEid, uln)),
    { pubkey: payer, isSigner: payerSigns, isWritable: true },
    path.treasury ? rw(path.treasury) : ro(uln),
    ro(SYSTEM_PROGRAM),
    ro(lzPda.ulnEventAuthority(uln)),
    ro(uln),
  ]
  for (const w of [path.executor, ...path.dvns]) {
    list.push(ro(w.program), rw(w.config), ro(w.priceFeedProgram), ro(w.priceFeedConfig))
  }
  return list
}

/** Every address of a send list that is the same for every user and every
 * token — what belongs in the lookup table. */
export function sendStaticAddresses(path: SendPath): PublicKey[] {
  return sendRemainingAccounts(path, LZ_ENDPOINT, false)
    .filter((_, i) => i !== 13)
    .map((m) => m.pubkey)
}

/* -------------------- the delegate's endpoint calls -------------------- */

const eidLE = (eid: number) => uintLE(BigInt(eid), 4)
const signer = (pubkey: PublicKey, writable: boolean): AccountMeta => ({ pubkey, isSigner: true, isWritable: writable })

/** remaining_accounts of `init_store` (the register_oapp CPI). */
export function registerOAppAccounts(payer: PublicKey, oapp: PublicKey): AccountMeta[] {
  return [
    ro(LZ_ENDPOINT),
    signer(payer, true),
    ro(oapp),
    rw(lzPda.oappRegistry(oapp)),
    ro(SYSTEM_PROGRAM),
    ro(lzPda.endpointEventAuthority()),
    ro(LZ_ENDPOINT),
  ]
}

/** remaining_accounts of `accept_admin` (the set_delegate CPI). */
export function setDelegateAccounts(oapp: PublicKey): AccountMeta[] {
  return [ro(LZ_ENDPOINT), ro(oapp), rw(lzPda.oappRegistry(oapp)), ro(lzPda.endpointEventAuthority()), ro(LZ_ENDPOINT)]
}

export function initSendLibraryIx(delegate: PublicKey, oapp: PublicKey, eid: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: LZ_ENDPOINT,
    data: toBuffer(concat(LZ_IX.init_send_library, oapp.toBytes(), eidLE(eid))),
    keys: [signer(delegate, true), ro(lzPda.oappRegistry(oapp)), rw(lzPda.sendLibraryConfig(oapp, eid)), ro(SYSTEM_PROGRAM)],
  })
}

export function initReceiveLibraryIx(delegate: PublicKey, oapp: PublicKey, eid: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: LZ_ENDPOINT,
    data: toBuffer(concat(LZ_IX.init_receive_library, oapp.toBytes(), eidLE(eid))),
    keys: [
      signer(delegate, true),
      ro(lzPda.oappRegistry(oapp)),
      rw(lzPda.receiveLibraryConfig(oapp, eid)),
      ro(SYSTEM_PROGRAM),
    ],
  })
}

export function initNonceIx(delegate: PublicKey, oapp: PublicKey, eid: number, remote: Uint8Array): TransactionInstruction {
  return new TransactionInstruction({
    programId: LZ_ENDPOINT,
    data: toBuffer(concat(LZ_IX.init_nonce, oapp.toBytes(), eidLE(eid), remote)),
    keys: [
      signer(delegate, true),
      ro(lzPda.oappRegistry(oapp)),
      rw(lzPda.nonce(oapp, eid, remote)),
      rw(lzPda.pendingNonce(oapp, eid, remote)),
      ro(SYSTEM_PROGRAM),
    ],
  })
}

/** Pins the OApp's SEND library for `eid` to `msglib` (a message-library
 * account, e.g. ULN 302's settings PDA) instead of following the
 * endpoint's default. Delegate only. */
export function setSendLibraryIx(delegate: PublicKey, oapp: PublicKey, eid: number, msglib: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: LZ_ENDPOINT,
    data: toBuffer(concat(LZ_IX.set_send_library, oapp.toBytes(), eidLE(eid), msglib.toBytes())),
    keys: [
      { pubkey: delegate, isSigner: true, isWritable: false },
      ro(lzPda.oappRegistry(oapp)),
      rw(lzPda.sendLibraryConfig(oapp, eid)),
      ro(lzPda.messageLibInfo(msglib)),
      ro(lzPda.endpointEventAuthority()),
      ro(LZ_ENDPOINT),
    ],
  })
}

/** Pins the OApp's RECEIVE library for `eid` to `msglib` (no grace period:
 * from the endpoint's default to the very library that default names).
 * Delegate only. */
export function setReceiveLibraryIx(delegate: PublicKey, oapp: PublicKey, eid: number, msglib: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: LZ_ENDPOINT,
    data: toBuffer(concat(LZ_IX.set_receive_library, oapp.toBytes(), eidLE(eid), msglib.toBytes(), uintLE(0n, 8))),
    keys: [
      { pubkey: delegate, isSigner: true, isWritable: false },
      ro(lzPda.oappRegistry(oapp)),
      rw(lzPda.receiveLibraryConfig(oapp, eid)),
      ro(lzPda.messageLibInfo(msglib)),
      ro(lzPda.endpointEventAuthority()),
      ro(LZ_ENDPOINT),
    ],
  })
}

function endpointConfigHead(delegate: PublicKey, oapp: PublicKey, uln: PublicKey): AccountMeta[] {
  const msglib = lzPda.ulnSettings(uln)
  return [
    { pubkey: delegate, isSigner: true, isWritable: false },
    ro(lzPda.oappRegistry(oapp)),
    ro(lzPda.messageLibInfo(msglib)),
    ro(msglib),
    ro(uln),
  ]
}

/** Creates the OApp's own send and receive config accounts on the ULN. */
export function initUlnConfigIx(
  delegate: PublicKey,
  payer: PublicKey,
  oapp: PublicKey,
  eid: number,
  uln: PublicKey = LZ_ULN,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: LZ_ENDPOINT,
    data: toBuffer(concat(LZ_IX.init_config, oapp.toBytes(), eidLE(eid))),
    keys: [
      ...endpointConfigHead(delegate, oapp, uln),
      signer(payer, true),
      ro(lzPda.ulnSettings(uln)),
      rw(lzPda.sendConfig(eid, oapp, uln)),
      rw(lzPda.receiveConfig(eid, oapp, uln)),
      ro(SYSTEM_PROGRAM),
    ],
  })
}

export const CONFIG_TYPE = { EXECUTOR: 1, SEND_ULN: 2, RECEIVE_ULN: 3 } as const

const cmpKey = compareKeys

/** Borsh UlnConfig, DVN lists sorted by address as the ULN demands. */
export function encodeUlnConfig(confirmations: bigint, required: PublicKey[], optional: PublicKey[], threshold: number): Uint8Array {
  const req = [...required].sort(cmpKey)
  const opt = [...optional].sort(cmpKey)
  const w = new BorshWriter().u64(confirmations).u8(req.length).u8(opt.length).u8(threshold)
  for (const list of [req, opt]) {
    w.u32(list.length)
    for (const k of list) w.fixed(k.toBytes(), 32)
  }
  return w.done()
}

export function setUlnConfigIx(
  delegate: PublicKey,
  oapp: PublicKey,
  eid: number,
  configType: number,
  config: Uint8Array,
  uln: PublicKey = LZ_ULN,
): TransactionInstruction {
  const data = new BorshWriter().raw(LZ_IX.set_config).fixed(oapp.toBytes(), 32).u32(eid).u32(configType).bytes(config).done()
  return new TransactionInstruction({
    programId: LZ_ENDPOINT,
    data: toBuffer(data),
    keys: [
      ...endpointConfigHead(delegate, oapp, uln),
      ro(lzPda.ulnSettings(uln)),
      rw(lzPda.sendConfig(eid, oapp, uln)),
      rw(lzPda.receiveConfig(eid, oapp, uln)),
      ro(lzPda.defaultSendConfig(eid, uln)),
      ro(lzPda.defaultReceiveConfig(eid, uln)),
      ro(lzPda.ulnEventAuthority(uln)),
      ro(uln),
    ],
  })
}
