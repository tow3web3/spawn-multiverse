/**
 * The client a UI or a script holds: it reads the deployment once (store,
 * peer, the LayerZero send path, the lookup table the store names), then
 * quotes and builds every user transaction as an unsigned v0 transaction
 * for a wallet to sign.
 */
import { AddressLookupTableAccount, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { LOCAL_COMPUTE_UNITS, PROGRAM_ID, SEND_COMPUTE_UNITS } from './constants'
import { readUintLE } from './bytes'
import {
  Position,
  Replica,
  Store,
  UserAccount,
  decodeLzReceiveTypesAccounts,
  decodePeerConfig,
  decodePosition,
  decodeReplica,
  decodeStore,
  decodeTokenAccount,
  decodeUserAccount,
} from './accounts'
import { SendPath, resolveSendPath } from './layerzero'
import {
  BuyParams,
  SENDS,
  SellParams,
  SendContext,
  SendSpec,
  SpawnParams,
  TokenParams,
  buildSendIx,
  claimParkedIx,
  claimRewardsIx,
  openUserAccountIx,
  quoteSendIx,
  redeemClaimIx,
  stakeIx,
  unstakeIx,
} from './instructions'
import { GatewayPdas, ata } from './pda'
import { GatewayRpc, getLookupTable } from './rpc'
import { assembleV0, txSize } from './transaction'
import { SpawnMsg, outboundMessage } from './wire'

export interface ClientOptions {
  programId?: PublicKey
  /** CU limit for sends (default 700,000 — NOTES.md). */
  sendComputeUnits?: number
  /** CU limit for local instructions (default 200,000). */
  localComputeUnits?: number
  /** Priority fee, micro-lamports per CU (default none). */
  microLamportsPerCu?: number
  /** Ceiling over the quote, in basis points (default 1,000 = +10%). */
  feeMarginBps?: number
}

export interface BuiltSend {
  tx: VersionedTransaction
  /** The quote (lamports) at build time. */
  quotedFee: bigint
  /** The ceiling written into the instruction (`max_native_fee`). */
  maxNativeFee: bigint
  /** The enveloped message the program will put on the wire. */
  message: Uint8Array
  payload: SpawnMsg
  size: number
}

export interface SendOptions {
  /** Skip the quote and use this ceiling (0 = no ceiling). */
  maxNativeFee?: bigint
  recentBlockhash?: string
}

export class GatewayClient {
  readonly pdas: GatewayPdas
  store!: Store
  peerAddress!: Uint8Array
  path!: SendPath
  /** The lookup table named in the store's LzReceiveTypes account, if any. */
  table: AddressLookupTableAccount | null = null

  private constructor(readonly rpc: GatewayRpc, readonly opts: ClientOptions) {
    this.pdas = new GatewayPdas(opts.programId ?? PROGRAM_ID)
  }

  static async load(rpc: GatewayRpc, opts: ClientOptions = {}): Promise<GatewayClient> {
    const c = new GatewayClient(rpc, opts)
    await c.refresh()
    return c
  }

  /** Re-reads the store, the peer, the send path and the table. */
  async refresh(): Promise<void> {
    const [s, t] = await this.rpc.getAccounts([this.pdas.store, this.pdas.lzReceiveTypes])
    if (!s) throw new Error(`no store at ${this.pdas.store.toBase58()}: the gateway is not initialised on this cluster`)
    this.store = decodeStore(s.data)
    const [p] = await this.rpc.getAccounts([this.pdas.peer(this.store.hubEid)])
    if (!p) throw new Error(`no peer for hub eid ${this.store.hubEid}: run set_peer_config`)
    this.peerAddress = decodePeerConfig(p.data).peerAddress
    this.path = await resolveSendPath(this.rpc, this.pdas.store, this.store.hubEid, this.peerAddress)
    this.table = null
    if (t) {
      const alt = decodeLzReceiveTypesAccounts(t.data).alt
      if (!alt.equals(PublicKey.default)) this.table = await getLookupTable(this.rpc, alt)
    }
  }

  /** Use another table (e.g. one created after `init_store`). */
  useTable(table: AddressLookupTableAccount | null): void {
    this.table = table
  }

  get context(): SendContext {
    return { pdas: this.pdas, hubEid: this.store.hubEid, usdcMint: this.store.usdcMint, vault: this.store.vault, path: this.path }
  }

  private tables(): AddressLookupTableAccount[] {
    return this.table ? [this.table] : []
  }

  /* --------------------------------- reads -------------------------------- */

  async replica(hubToken: Uint8Array): Promise<Replica | null> {
    const [a] = await this.rpc.getAccounts([this.pdas.replica(hubToken)])
    return a ? decodeReplica(a.data) : null
  }
  async userAccount(owner: PublicKey): Promise<UserAccount | null> {
    const [a] = await this.rpc.getAccounts([this.pdas.user(owner)])
    return a ? decodeUserAccount(a.data) : null
  }
  async position(hubToken: Uint8Array, owner: PublicKey): Promise<Position | null> {
    const [a] = await this.rpc.getAccounts([this.pdas.position(hubToken, owner)])
    return a ? decodePosition(a.data) : null
  }
  /** Balance of `owner`'s ATA for `mint` (0 if it does not exist). */
  async tokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
    const [a] = await this.rpc.getAccounts([ata(owner, mint)])
    return a ? decodeTokenAccount(a.data).amount : 0n
  }
  async vaultBalance(): Promise<bigint> {
    const [a] = await this.rpc.getAccounts([this.store.vault])
    return a ? decodeTokenAccount(a.data).amount : 0n
  }

  /* --------------------------------- quote -------------------------------- */

  /** The lamports a send costs right now: `quote_send` simulated with the
   * same send list. `payer` must be an existing account on the cluster (it
   * pays the simulation; nothing is charged). */
  async quote<P>(spec: SendSpec<P>, params: P, payer: PublicKey): Promise<bigint> {
    const ix = quoteSendIx(this.context, spec.quote(params), payer)
    const tx = assembleV0({
      payer,
      instructions: [ix],
      recentBlockhash: await this.rpc.latestBlockhash(),
      lookupTables: this.tables(),
      computeUnits: this.opts.sendComputeUnits ?? SEND_COMPUTE_UNITS,
    })
    const r = await this.rpc.simulate(tx)
    if (r.err || !r.returnData || r.returnData.length < 8) {
      throw new Error(`quote_send failed: ${JSON.stringify(r.err)}\n${r.logs.join('\n')}`)
    }
    return readUintLE(r.returnData, 0, 8)
  }

  /* --------------------------------- build -------------------------------- */

  /** Any send, by spec: quote → ceiling → v0 transaction. */
  async buildSend<P>(spec: SendSpec<P>, user: PublicKey, params: P, o: SendOptions = {}): Promise<BuiltSend> {
    spec.check?.(params)
    let quotedFee = 0n
    let maxNativeFee = o.maxNativeFee
    if (maxNativeFee === undefined) {
      quotedFee = await this.quote(spec, params, user)
      maxNativeFee = (quotedFee * BigInt(10_000 + (this.opts.feeMarginBps ?? 1_000))) / 10_000n
    }
    const ix = buildSendIx(spec, this.context, user, params, maxNativeFee)
    const tx = assembleV0({
      payer: user,
      instructions: [ix],
      recentBlockhash: o.recentBlockhash ?? (await this.rpc.latestBlockhash()),
      lookupTables: this.tables(),
      computeUnits: this.opts.sendComputeUnits ?? SEND_COMPUTE_UNITS,
      microLamportsPerCu: this.opts.microLamportsPerCu,
    })
    const payload = spec.message(user, params)
    return {
      tx,
      quotedFee,
      maxNativeFee,
      payload,
      message: outboundMessage(this.pdas.store, this.store.hubPad, payload),
      size: txSize(tx),
    }
  }

  spawn(user: PublicKey, p: SpawnParams, o?: SendOptions) {
    return this.buildSend(SENDS.spawn_token, user, p, o)
  }
  buy(user: PublicKey, p: BuyParams, o?: SendOptions) {
    return this.buildSend(SENDS.buy_token, user, p, o)
  }
  sell(user: PublicKey, p: SellParams, o?: SendOptions) {
    return this.buildSend(SENDS.sell_token, user, p, o)
  }
  claimFees(user: PublicKey, p: TokenParams, o?: SendOptions) {
    return this.buildSend(SENDS.claim_fees, user, p, o)
  }
  pullFees(user: PublicKey, p: TokenParams, o?: SendOptions) {
    return this.buildSend(SENDS.pull_fees, user, p, o)
  }

  /** A local (non-send) transaction. */
  async buildLocal(payer: PublicKey, instructions: TransactionInstruction[], recentBlockhash?: string): Promise<VersionedTransaction> {
    return assembleV0({
      payer,
      instructions,
      recentBlockhash: recentBlockhash ?? (await this.rpc.latestBlockhash()),
      lookupTables: this.tables(),
      computeUnits: this.opts.localComputeUnits ?? LOCAL_COMPUTE_UNITS,
      microLamportsPerCu: this.opts.microLamportsPerCu,
    })
  }

  openUserAccount(payer: PublicKey, owner: PublicKey = payer) {
    return this.buildLocal(payer, [openUserAccountIx(this.context, payer, owner)])
  }
  redeemClaim(user: PublicKey, units: bigint) {
    return this.buildLocal(user, [redeemClaimIx(this.context, user, units)])
  }
  claimParked(user: PublicKey, hubToken: Uint8Array) {
    return this.buildLocal(user, [claimParkedIx(this.context, user, hubToken)])
  }
  stake(user: PublicKey, hubToken: Uint8Array, units: bigint) {
    return this.buildLocal(user, [stakeIx(this.context, user, hubToken, units)])
  }
  unstake(user: PublicKey, hubToken: Uint8Array, units: bigint) {
    return this.buildLocal(user, [unstakeIx(this.context, user, hubToken, units)])
  }
  claimRewards(user: PublicKey, hubToken: Uint8Array) {
    return this.buildLocal(user, [claimRewardsIx(this.context, user, hubToken)])
  }
}
