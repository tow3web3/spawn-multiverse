/**
 * The client a UI or a script holds: it reads the deployment once (store,
 * peer, the LayerZero send path, the lookup table the store names), then
 * quotes and builds every user transaction as an unsigned v0 transaction
 * for a wallet to sign.
 */
import { AddressLookupTableAccount, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import {
  LOCAL_COMPUTE_UNITS,
  MINT_BYTES,
  PROGRAM_ID,
  REPLICA_BYTES,
  SEND_COMPUTE_UNITS,
  SYSVAR_CLOCK,
  USER_ACCOUNT_BYTES,
} from './constants'
import { readUintLE } from './bytes'
import {
  CctpPeer,
  MoveRoute,
  Position,
  Replica,
  Store,
  UserAccount,
  decodeCctpPeer,
  decodeClockUnixTime,
  decodeLzReceiveTypesAccounts,
  decodeMoveRoute,
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
  MoveParams,
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
import { AccountData, GatewayRpc, getLookupTable } from './rpc'
import { assembleV0, txSize } from './transaction'
import { SpawnMsg, outboundMessage } from './wire'

/** What a hub message that creates accounts here costs in rent, and what
 * the HUB adapter's operator should therefore set as `returnUnit` for this
 * chain's label (lamports; V7.md §9). */
export interface HubUnit {
  /** A replica's two accounts (a SYNC): the unit must be AT LEAST this. */
  replicaRent: bigint
  /** The user account of a recipient who never came here (a moved PAYOUT). */
  userAccountRent: bigint
  /** The figure to set: the dearer rent plus about a tenth, rounded. */
  suggested: bigint
}

/** The rule behind `HubUnit.suggested`: a tenth over the dearer rent,
 * rounded down to 100,000 lamports — never under that rent rounded up. */
export function suggestedHubUnit(replicaRent: bigint): bigint {
  const step = 100_000n
  const up = ((replicaRent + step - 1n) / step) * step
  const tenthOver = (((replicaRent * 11n) / 10n) / step) * step
  return tenthOver > up ? tenthOver : up
}

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
  /** Reply legs the send prepays, and what they amount to in hub-native
   * wei — the value in the executor option and in the envelope. */
  legs: number
  value: bigint
  /** A trade's deadline as the client expects it: the cluster clock when
   * this was built plus the store's lifetime (unix seconds). The program
   * stamps the real one when the transaction executes — later by however
   * long signing took. 0n for a message that is not a trade. */
  deadline: bigint
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

  /** A program account at `key`, or null: an address that only holds
   * lamports is not one yet (an opened token's replica address holds its
   * rent until the hub's SYNC arrives; anyone can pre-fund any address). */
  private async own(key: PublicKey): Promise<AccountData | null> {
    const [a] = await this.rpc.getAccounts([key])
    return a && a.owner.equals(this.pdas.programId) && a.data.length > 0 ? a : null
  }

  async replica(hubToken: Uint8Array): Promise<Replica | null> {
    const a = await this.own(this.pdas.replica(hubToken))
    return a ? decodeReplica(a.data) : null
  }
  async userAccount(owner: PublicKey): Promise<UserAccount | null> {
    const a = await this.own(this.pdas.user(owner))
    return a ? decodeUserAccount(a.data) : null
  }
  async position(hubToken: Uint8Array, owner: PublicKey): Promise<Position | null> {
    const a = await this.own(this.pdas.position(hubToken, owner))
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
  /** The price of moves toward `dstChain`, or null when the operator never
   * set one (the route is closed). */
  async moveRoute(dstChain: number): Promise<MoveRoute | null> {
    const a = await this.own(this.pdas.moveRoute(dstChain))
    return a ? decodeMoveRoute(a.data) : null
  }
  async cctpPeer(label: number): Promise<CctpPeer | null> {
    const a = await this.own(this.pdas.cctpPeer(label))
    return a ? decodeCctpPeer(a.data) : null
  }
  /** The cluster clock's unix time — what the program stamps a trade's
   * deadline from, and what the hub compares it with is NOT this clock. */
  async clusterTime(): Promise<bigint> {
    const [a] = await this.rpc.getAccounts([SYSVAR_CLOCK])
    if (!a) throw new Error('the cluster has no Clock sysvar')
    return decodeClockUnixTime(a.data)
  }
  /** What the hub adapter's `returnUnit` for this chain has to cover, at
   * this cluster's rent. */
  async hubUnit(): Promise<HubUnit> {
    const replicaRent = (await this.rpc.rent(REPLICA_BYTES)) + (await this.rpc.rent(MINT_BYTES))
    return { replicaRent, userAccountRent: await this.rpc.rent(USER_ACCOUNT_BYTES), suggested: suggestedHubUnit(replicaRent) }
  }
  /** Lamports in the tank (it covers what a hub message creates when the
   * message did not bring enough for it). */
  async tankBalance(): Promise<bigint> {
    const [a] = await this.rpc.getAccounts([this.pdas.gasTank])
    return BigInt(a?.lamports ?? 0)
  }

  /* --------------------------------- quote -------------------------------- */

  /** The lamports a send costs right now: `quote_send` simulated with the
   * same send list. `payer` must be an existing account on the cluster (it
   * pays the simulation; nothing is charged). */
  async quote<P>(spec: SendSpec<P>, params: P, payer: PublicKey): Promise<bigint> {
    const route = spec.routeOf ? await this.routeFor(spec, params) : null
    const ix = quoteSendIx(this.context, spec.quote(params), payer, route ? spec.routeOf!(this.context, params) : null)
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

  /** The move route a spec is priced by, if it exists on chain. */
  private async routeFor<P>(spec: SendSpec<P>, params: P): Promise<MoveRoute | null> {
    if (!spec.routeOf) return null
    const a = await this.own(spec.routeOf(this.context, params))
    return a ? decodeMoveRoute(a.data) : null
  }

  /* --------------------------------- build -------------------------------- */

  /** Any send, by spec: quote → ceiling → v0 transaction. */
  async buildSend<P>(spec: SendSpec<P>, user: PublicKey, params: P, o: SendOptions = {}): Promise<BuiltSend> {
    spec.check?.(params)
    const legs = spec.legs(this.store, params, await this.routeFor(spec, params))
    if (spec.routeOf && legs === 0) throw new Error('this destination has no price: the route is closed (the program refuses RouteClosed)')
    const value = this.store.returnUnit * BigInt(legs)
    const deadline = spec.trade ? (await this.clusterTime()) + BigInt(this.store.orderTtl) : 0n
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
    const payload = spec.message(user, params, deadline)
    return {
      tx,
      quotedFee,
      maxNativeFee,
      legs,
      value,
      deadline,
      payload,
      message: outboundMessage(this.pdas.store, this.store.hubPad, payload, value),
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
  /** v7.2: ask the hub for this chain's replica of a token it never got.
   * The hub's SYNC brings the replica's rent; the caller pays the message. */
  openToken(user: PublicKey, p: TokenParams, o?: SendOptions) {
    return this.buildSend(SENDS.open_token, user, p, o)
  }
  /** v7.2: send `units` of the caller's claim to `to` on another chain. */
  moveClaim(user: PublicKey, p: MoveParams, o?: SendOptions) {
    return this.buildSend(SENDS.move_claim, user, p, o)
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
