/**
 * Instruction builders for every gateway instruction. Account orders follow
 * the `#[derive(Accounts)]` structs in programs/spawn-gateway/src/
 * instructions/ (cross-checked against target/idl/spawn_gateway.json by
 * test/idl.test.ts).
 *
 * The seven sends share one generic builder: a `SendSpec` says which named
 * accounts the instruction takes, how its arguments encode, how many reply
 * legs it prepays and how it is quoted; `buildSendIx` appends the LayerZero
 * send list. Adding a send is one more entry in `SENDS`.
 */
import { AccountMeta, PublicKey, TransactionInstruction } from '@solana/web3.js'
import {
  ATA_PROGRAM,
  CCTP_MESSAGE_TRANSMITTER_V2,
  CCTP_TOKEN_MESSENGER_MINTER_V2,
  CHAIN_LABEL,
  EVM_LABELS,
  IX,
  MAX_FEE_MODE,
  MAX_META_BYTES,
  MAX_MOVE_LEGS,
  MAX_NAME_BYTES,
  MAX_OPEN_LEGS,
  MAX_ORDER_TTL,
  MIN_ORDER_TTL,
  MAX_SYMBOL_BYTES,
  SOLANA_LABEL,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from './constants'
import { BorshWriter, encodeUtf8, toBuffer } from './bytes'
import { MoveRoute, Store, moveLegs } from './accounts'
import { GatewayPdas, asBytes32, ata, cctpPda } from './pda'
import { SendPath, registerOAppAccounts, sendRemainingAccounts, setDelegateAccounts } from './layerzero'
import { OP, SpawnMsg, splToE18 } from './wire'

const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false })
const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true })
const sgn = (pubkey: PublicKey, writable = true): AccountMeta => ({ pubkey, isSigner: true, isWritable: writable })

function ix(programId: PublicKey, disc: Uint8Array, keys: AccountMeta[], args: Uint8Array = new Uint8Array()): TransactionInstruction {
  return new TransactionInstruction({ programId, keys, data: toBuffer(new BorshWriter().raw(disc).raw(args).done()) })
}

/** What every gateway instruction needs to know about the deployment. */
export interface GatewayContext {
  pdas: GatewayPdas
  hubEid: number
  usdcMint: PublicKey
  /** The vault named in the store (`init_vault`). */
  vault: PublicKey
}

/** …and what a send needs on top of it. */
export interface SendContext extends GatewayContext {
  path: SendPath
}

/* -------------------------------- sends -------------------------------- */

export interface QuoteSendParams {
  op: number
  name: string
  symbol: string
  metaUri: string
  withDevBuy: boolean
  /** The destination of a move (op 7); 0 otherwise. */
  dstChain: number
}

export interface SendSpec<P> {
  /** Instruction name (a key of `IX`). */
  name: keyof typeof IX
  /** The named accounts, before the LayerZero send list. */
  accounts(c: GatewayContext, user: PublicKey, p: P): AccountMeta[]
  /** Borsh of the params struct; `maxNativeFee` is always its last field. */
  args(p: P, maxNativeFee: bigint): Uint8Array
  /** The `quote_send` params that price this send. */
  quote(p: P): QuoteSendParams
  /** The payload the program will put on the wire (for display / checks).
   * `deadline` is what a trade will be stamped with — the cluster clock at
   * execution plus the store's lifetime: the client can only predict it. */
  message(user: PublicKey, p: P, deadline: bigint): SpawnMsg
  /** True for a BUY or a SELL: the program stamps a deadline on it. */
  trade?: boolean
  /** Reply legs the program prepays for it (× `store.returnUnit` = the
   * value in the executor option and in the envelope). `route` is the move
   * route of `routeOf`, when the send has one. */
  legs(store: Store, p: P, route: MoveRoute | null): number
  /** The move-route account that prices this send (a move only). */
  routeOf?(c: GatewayContext, p: P): PublicKey
  /** Entry checks the program would refuse with — refused here for free. */
  check?(p: P): void
}

export interface SpawnParams {
  name: string
  symbol: string
  metaUri: string
  /** USDC units (6 decimals); 0 = no dev buy. */
  devBuyUsdc: bigint
  feeMode: number
}
export interface BuyParams {
  hubToken: Uint8Array
  /** USDC units (6 decimals). */
  usdcIn: bigint
  /** The least replica units (6 decimals) the buyer accepts — REQUIRED
   * (v7.2): the hub fills for at least this or sends every dollar home.
   * `ANY_FILL` (one unit) accepts anything; a UI derives it from the
   * hub's price and a slippage tolerance. (The order's DEADLINE is not a
   * parameter: the program stamps it — cluster clock + `store.orderTtl`.) */
  minTokensOut: bigint
  /** The USDC account to pay from (default: the user's ATA). */
  userUsdc?: PublicKey
}
export interface SellParams {
  hubToken: Uint8Array
  /** Replica units (6 decimals). */
  amount: bigint
  /** The least USDC units (6 decimals) the seller accepts, net of the fee
   * — REQUIRED (v7.2): under it the hub delivers the bag back. */
  minUsdcOut: bigint
  /** The replica account to burn from (default: the user's ATA). */
  userToken?: PublicKey
}
export interface TokenParams {
  hubToken: Uint8Array
}
export interface MoveParams {
  /** SPAWN! chain label of the destination (`CHAIN_LABEL`). */
  dstChain: number
  /** The recipient there: an EVM address (20 bytes, left-padded here) or a
   * full 32-byte id. */
  to: Uint8Array
  /** USDC units (6 decimals) of the caller's claim. */
  units: bigint
}

/** The smallest minimum a trade can name: one unit (0.000001) — "any fill". */
export const ANY_FILL = 1n

const noStrings = { name: '', symbol: '', metaUri: '', withDevBuy: false, dstChain: 0 }
const positive = (v: bigint, what: string) => {
  if (v <= 0n) throw new Error(`${what} must be > 0 (the program refuses ZeroAmount)`)
}
const minimum = (v: bigint, what: string) => {
  if (v <= 0n) throw new Error(`${what} must be > 0 (the program refuses ZeroMinimum): a trade names what it accepts`)
}
const isZero = (b: Uint8Array) => b.every((x) => x === 0)

/** The user-side accounts every send that may get a reply opens. */
const head = (c: GatewayContext, user: PublicKey): AccountMeta[] => [
  sgn(user),
  ro(c.pdas.store),
  ro(c.pdas.peer(c.hubEid)),
  rw(c.pdas.gasTank),
]

export const SENDS = {
  spawn_token: {
    name: 'spawn_token',
    accounts: (c, user) => [
      ...head(c, user),
      rw(c.pdas.user(user)),
      ro(c.usdcMint),
      rw(ata(user, c.usdcMint)),
      rw(c.vault),
      ro(TOKEN_PROGRAM),
      ro(ATA_PROGRAM),
      ro(SYSTEM_PROGRAM),
    ],
    args: (p, fee) =>
      new BorshWriter().string(p.name).string(p.symbol).string(p.metaUri).u64(p.devBuyUsdc).u8(p.feeMode).u64(fee).done(),
    quote: (p) => ({ op: OP.SPAWN, name: p.name, symbol: p.symbol, metaUri: p.metaUri, withDevBuy: p.devBuyUsdc > 0n, dstChain: 0 }),
    legs: (s, p) => s.spawnLegs + (p.devBuyUsdc > 0n ? s.tradeLegs : 0),
    message: (user, p) => ({
      op: 'SPAWN',
      creator: user.toBytes(),
      name: p.name,
      symbol: p.symbol,
      metaUri: p.metaUri,
      devBuyUsd: splToE18(p.devBuyUsdc),
      feeMode: p.feeMode,
    }),
    check: (p) => {
      if (p.feeMode < 0 || p.feeMode > MAX_FEE_MODE) throw new Error(`fee mode ${p.feeMode} > ${MAX_FEE_MODE}`)
      if (encodeUtf8(p.name).length > MAX_NAME_BYTES) throw new Error(`name over ${MAX_NAME_BYTES} bytes`)
      if (encodeUtf8(p.symbol).length > MAX_SYMBOL_BYTES) throw new Error(`symbol over ${MAX_SYMBOL_BYTES} bytes`)
      if (encodeUtf8(p.metaUri).length > MAX_META_BYTES) throw new Error(`metadata URI over ${MAX_META_BYTES} bytes`)
      if (p.devBuyUsdc < 0n) throw new Error('negative dev buy')
    },
  } as SendSpec<SpawnParams>,

  buy_token: {
    name: 'buy_token',
    accounts: (c, user, p) => {
      const mint = c.pdas.mint(p.hubToken)
      return [
        ...head(c, user),
        ro(c.pdas.replica(p.hubToken)),
        ro(mint),
        rw(ata(user, mint)),
        rw(c.pdas.user(user)),
        ro(c.usdcMint),
        rw(p.userUsdc ?? ata(user, c.usdcMint)),
        rw(c.vault),
        ro(TOKEN_PROGRAM),
        ro(ATA_PROGRAM),
        ro(SYSTEM_PROGRAM),
      ]
    },
    args: (p, fee) => new BorshWriter().fixed(asBytes32(p.hubToken), 32).u64(p.usdcIn).u64(p.minTokensOut).u64(fee).done(),
    quote: () => ({ op: OP.BUY, ...noStrings }),
    message: (user, p, deadline) => ({
      op: 'BUY',
      hubToken: p.hubToken,
      buyer: user.toBytes(),
      usdIn: splToE18(p.usdcIn),
      minTokensOut: splToE18(p.minTokensOut),
      deadline,
    }),
    trade: true,
    legs: (s) => s.tradeLegs,
    check: (p) => {
      positive(p.usdcIn, 'usdcIn')
      minimum(p.minTokensOut, 'minTokensOut')
    },
  } as SendSpec<BuyParams>,

  sell_token: {
    name: 'sell_token',
    accounts: (c, user, p) => {
      const mint = c.pdas.mint(p.hubToken)
      return [
        ...head(c, user),
        ro(c.pdas.replica(p.hubToken)),
        rw(mint),
        rw(p.userToken ?? ata(user, mint)),
        rw(c.pdas.user(user)),
        ro(c.usdcMint),
        rw(ata(user, c.usdcMint)),
        ro(TOKEN_PROGRAM),
        ro(ATA_PROGRAM),
        ro(SYSTEM_PROGRAM),
      ]
    },
    args: (p, fee) => new BorshWriter().fixed(asBytes32(p.hubToken), 32).u64(p.amount).u64(p.minUsdcOut).u64(fee).done(),
    quote: () => ({ op: OP.SELL, ...noStrings }),
    message: (user, p, deadline) => ({
      op: 'SELL',
      hubToken: p.hubToken,
      seller: user.toBytes(),
      tokensIn: splToE18(p.amount),
      minUsdOut: splToE18(p.minUsdcOut),
      deadline,
    }),
    trade: true,
    legs: (s) => s.tradeLegs,
    check: (p) => {
      positive(p.amount, 'amount')
      minimum(p.minUsdcOut, 'minUsdcOut')
    },
  } as SendSpec<SellParams>,

  claim_fees: {
    name: 'claim_fees',
    accounts: (c, user, p) => [
      ...head(c, user),
      ro(c.pdas.replica(p.hubToken)),
      rw(c.pdas.user(user)),
      ro(c.usdcMint),
      rw(ata(user, c.usdcMint)),
      ro(TOKEN_PROGRAM),
      ro(ATA_PROGRAM),
      ro(SYSTEM_PROGRAM),
    ],
    args: (p, fee) => new BorshWriter().fixed(asBytes32(p.hubToken), 32).u64(fee).done(),
    quote: () => ({ op: OP.CLAIM, ...noStrings }),
    message: (user, p) => ({ op: 'CLAIM', hubToken: p.hubToken, claimer: user.toBytes() }),
    legs: (s) => s.tradeLegs,
  } as SendSpec<TokenParams>,

  pull_fees: {
    name: 'pull_fees',
    accounts: (c, user, p) => [...head(c, user), ro(c.pdas.replica(p.hubToken)), ro(SYSTEM_PROGRAM)],
    args: (p, fee) => new BorshWriter().fixed(asBytes32(p.hubToken), 32).u64(fee).done(),
    quote: () => ({ op: OP.PULL_FEES, ...noStrings }),
    message: (_user, p) => ({ op: 'PULL_FEES', hubToken: p.hubToken }),
    legs: (s) => s.tradeLegs,
  } as SendSpec<TokenParams>,

  /** v7.2: asks the hub for this chain's replica of a token it never got.
   * The caller pays the message and the hub's SYNC; the replica's rent
   * comes WITH that SYNC (the hub attaches it), not from the caller. */
  open_token: {
    name: 'open_token',
    accounts: (c, user, p) => [...head(c, user), ro(c.pdas.replica(p.hubToken)), ro(SYSTEM_PROGRAM)],
    args: (p, fee) => new BorshWriter().fixed(asBytes32(p.hubToken), 32).u64(fee).done(),
    quote: () => ({ op: OP.OPEN, ...noStrings }),
    message: (_user, p) => ({ op: 'OPEN', hubToken: p.hubToken }),
    legs: (s) => s.openLegs,
    check: (p) => {
      if (asBytes32(p.hubToken).slice(0, 12).some((x) => x !== 0)) {
        throw new Error('a hub token id is an EVM address, left-padded (the program refuses BadTokenId)')
      }
    },
  } as SendSpec<TokenParams>,

  /** v7.2: sends `units` of the caller's dollar claim to `to` on another
   * chain. Never paused. */
  move_claim: {
    name: 'move_claim',
    accounts: (c, user, p) => [
      sgn(user),
      rw(c.pdas.store),
      ro(c.pdas.peer(c.hubEid)),
      rw(c.pdas.gasTank),
      rw(c.pdas.user(user)),
      ro(c.pdas.moveRoute(p.dstChain)),
      ro(SYSTEM_PROGRAM),
    ],
    args: (p, fee) => new BorshWriter().u32(p.dstChain).fixed(wideId(p.to), 32).u64(p.units).u64(fee).done(),
    quote: (p) => ({ op: OP.MOVE, ...noStrings, dstChain: p.dstChain }),
    message: (user, p) => ({ op: 'MOVE', from: user.toBytes(), to: wideId(p.to), amount: splToE18(p.units), dstChain: p.dstChain }),
    legs: (s, p, route) => moveLegs(s, route, p.dstChain),
    routeOf: (c, p) => c.pdas.moveRoute(p.dstChain),
    check: (p) => {
      positive(p.units, 'units')
      if (p.dstChain === SOLANA_LABEL || p.dstChain === CHAIN_LABEL.hub) {
        throw new Error(`chain ${p.dstChain} is not a destination (the program refuses BadDestination)`)
      }
      const to = wideId(p.to)
      if (isZero(to)) throw new Error('the recipient is zero (the program refuses BadDestination)')
      // not the program's to know, but the hub's rule: an EVM chain pays
      // addresses only, and the claim would make the round trip for nothing
      if (EVM_LABELS.includes(p.dstChain) && to.slice(0, 12).some((x) => x !== 0)) {
        throw new Error(`chain ${p.dstChain} is an EVM chain: the recipient must be a 20-byte address (the hub would send the claim home)`)
      }
    },
  } as SendSpec<MoveParams>,
}

/** A recipient as the 32-byte wire id: 20 bytes are an EVM address and
 * ride left-padded; 32 bytes ride as they are. */
function wideId(x: Uint8Array): Uint8Array {
  if (x.length === 32) return x
  if (x.length === 20) {
    const out = new Uint8Array(32)
    out.set(x, 12)
    return out
  }
  throw new Error(`a recipient is 20 or 32 bytes, got ${x.length}`)
}

export type SendName = keyof typeof SENDS
export type SendParamsOf<K extends SendName> = (typeof SENDS)[K] extends SendSpec<infer P> ? P : never

/** A send instruction: named accounts + the LayerZero send list, the user
 * as fee payer. `maxNativeFee` is the ceiling in lamports (0 = none). */
export function buildSendIx<P>(spec: SendSpec<P>, c: SendContext, user: PublicKey, p: P, maxNativeFee: bigint): TransactionInstruction {
  spec.check?.(p)
  const keys = [...spec.accounts(c, user, p), ...sendRemainingAccounts(c.path, user)]
  return ix(c.pdas.programId, IX[spec.name], keys, spec.args(p, maxNativeFee))
}

/** `quote_send` with the same list as a send (nothing needs to sign;
 * `payer` only fills the list's payer slot). `moveRoute` is the route
 * account of a move's destination — pass it when it EXISTS; without it a
 * move quotes as `RouteClosed`, which is what it is. */
export function quoteSendIx(c: SendContext, q: QuoteSendParams, payer: PublicKey, moveRoute: PublicKey | null = null): TransactionInstruction {
  const args = new BorshWriter().u8(q.op).string(q.name).string(q.symbol).string(q.metaUri).bool(q.withDevBuy).u32(q.dstChain).done()
  const keys = [
    ro(c.pdas.store),
    ro(c.pdas.peer(c.hubEid)),
    // Anchor 0.31: an absent Option<Account> is the program id
    ro(moveRoute ?? c.pdas.programId),
    ...sendRemainingAccounts(c.path, payer, false),
  ]
  return ix(c.pdas.programId, IX.quote_send, keys, args)
}

/* ----------------------------- user, local ----------------------------- */

export function openUserAccountIx(c: GatewayContext, payer: PublicKey, owner: PublicKey): TransactionInstruction {
  return ix(c.pdas.programId, IX.open_user_account, [sgn(payer), ro(owner), rw(c.pdas.user(owner)), ro(SYSTEM_PROGRAM)])
}

export function redeemClaimIx(c: GatewayContext, user: PublicKey, units: bigint): TransactionInstruction {
  positive(units, 'units')
  return ix(
    c.pdas.programId,
    IX.redeem_claim,
    [
      sgn(user),
      rw(c.pdas.store),
      rw(c.pdas.user(user)),
      ro(c.usdcMint),
      rw(c.vault),
      rw(ata(user, c.usdcMint)),
      ro(TOKEN_PROGRAM),
      ro(ATA_PROGRAM),
      ro(SYSTEM_PROGRAM),
    ],
    new BorshWriter().u64(units).done(),
  )
}

export function claimParkedIx(c: GatewayContext, user: PublicKey, hubToken: Uint8Array): TransactionInstruction {
  const mint = c.pdas.mint(hubToken)
  return ix(
    c.pdas.programId,
    IX.claim_parked,
    [
      sgn(user),
      ro(c.pdas.store),
      rw(c.pdas.user(user)),
      rw(c.pdas.replica(hubToken)),
      rw(mint),
      rw(ata(user, mint)),
      ro(TOKEN_PROGRAM),
      ro(ATA_PROGRAM),
      ro(SYSTEM_PROGRAM),
    ],
    asBytes32(hubToken),
  )
}

export function stakeIx(c: GatewayContext, user: PublicKey, hubToken: Uint8Array, units: bigint): TransactionInstruction {
  positive(units, 'units')
  const mint = c.pdas.mint(hubToken)
  return ix(
    c.pdas.programId,
    IX.stake,
    [
      sgn(user),
      ro(c.pdas.store),
      rw(c.pdas.replica(hubToken)),
      ro(mint),
      rw(c.pdas.escrow(hubToken)),
      rw(c.pdas.position(hubToken, user)),
      rw(ata(user, mint)),
      ro(TOKEN_PROGRAM),
      ro(SYSTEM_PROGRAM),
    ],
    new BorshWriter().fixed(asBytes32(hubToken), 32).u64(units).done(),
  )
}

export function unstakeIx(c: GatewayContext, user: PublicKey, hubToken: Uint8Array, units: bigint): TransactionInstruction {
  positive(units, 'units')
  const mint = c.pdas.mint(hubToken)
  return ix(
    c.pdas.programId,
    IX.unstake,
    [
      sgn(user),
      ro(c.pdas.store),
      rw(c.pdas.replica(hubToken)),
      ro(mint),
      rw(c.pdas.escrow(hubToken)),
      rw(c.pdas.position(hubToken, user)),
      rw(ata(user, mint)),
      ro(TOKEN_PROGRAM),
      ro(ATA_PROGRAM),
      ro(SYSTEM_PROGRAM),
    ],
    new BorshWriter().fixed(asBytes32(hubToken), 32).u64(units).done(),
  )
}

export function claimRewardsIx(c: GatewayContext, user: PublicKey, hubToken: Uint8Array): TransactionInstruction {
  return ix(
    c.pdas.programId,
    IX.claim_rewards,
    [
      sgn(user),
      rw(c.pdas.store),
      ro(c.pdas.replica(hubToken)),
      rw(c.pdas.position(hubToken, user)),
      rw(c.pdas.user(user)),
      ro(c.usdcMint),
      rw(c.vault),
      rw(ata(user, c.usdcMint)),
      ro(TOKEN_PROGRAM),
      ro(ATA_PROGRAM),
      ro(SYSTEM_PROGRAM),
    ],
    asBytes32(hubToken),
  )
}

/* -------------------------------- admin -------------------------------- */

export interface InitStoreParams {
  admin: PublicKey
  /** The real endpoint (or PublicKey.default, the test sentinel). */
  endpoint: PublicKey
  hubEid: number
  hubPad: Uint8Array
}

/** `init_store` + the register_oapp CPI accounts. `alt` is the lookup table
 * the executor will be told about — it must already exist (owner check);
 * `setReceiveTableIx` names or replaces it afterwards. */
export function initStoreIx(pdas: GatewayPdas, payer: PublicKey, p: InitStoreParams, alt: PublicKey | null): TransactionInstruction {
  const keys = [
    sgn(payer),
    rw(pdas.store),
    rw(pdas.lzReceiveTypes),
    // Anchor 0.31: an absent Option<Account> is the program id
    ro(alt ?? pdas.programId),
    ro(SYSTEM_PROGRAM),
  ]
  if (!p.endpoint.equals(PublicKey.default)) keys.push(...registerOAppAccounts(payer, pdas.store))
  const args = new BorshWriter()
    .fixed(p.admin.toBytes(), 32)
    .fixed(p.endpoint.toBytes(), 32)
    .u32(p.hubEid)
    .fixed(asBytes32(p.hubPad), 32)
    .done()
  return ix(pdas.programId, IX.init_store, keys, args)
}

export function initVaultIx(pdas: GatewayPdas, admin: PublicKey, usdcMint: PublicKey): TransactionInstruction {
  return ix(pdas.programId, IX.init_vault, [
    sgn(admin),
    rw(pdas.store),
    ro(usdcMint),
    rw(pdas.vault),
    ro(SYSTEM_PROGRAM),
    ro(TOKEN_PROGRAM),
  ])
}

export function setPeerConfigIx(pdas: GatewayPdas, admin: PublicKey, remoteEid: number, peer: Uint8Array): TransactionInstruction {
  return ix(
    pdas.programId,
    IX.set_peer_config,
    [sgn(admin), rw(pdas.peer(remoteEid)), ro(pdas.store), ro(SYSTEM_PROGRAM)],
    new BorshWriter().u32(remoteEid).fixed(asBytes32(peer), 32).done(),
  )
}

const govern = (pdas: GatewayPdas, authority: PublicKey) => [sgn(authority, false), rw(pdas.store)]

export const governIx = {
  transferAdmin: (pdas: GatewayPdas, admin: PublicKey, nominee: PublicKey) =>
    ix(pdas.programId, IX.transfer_admin, govern(pdas, admin), nominee.toBytes()),
  /** The nominee accepts and becomes the LayerZero delegate in the same
   * instruction (`liveEndpoint` = false only for a sentinel store). */
  acceptAdmin: (pdas: GatewayPdas, nominee: PublicKey, liveEndpoint = true) =>
    ix(pdas.programId, IX.accept_admin, [
      ...govern(pdas, nominee),
      ...(liveEndpoint ? setDelegateAccounts(pdas.store) : []),
    ]),
  setOperator: (pdas: GatewayPdas, admin: PublicKey, operator: PublicKey) =>
    ix(pdas.programId, IX.set_operator, govern(pdas, admin), operator.toBytes()),
  setGuardian: (pdas: GatewayPdas, admin: PublicKey, guardian: PublicKey) =>
    ix(pdas.programId, IX.set_guardian, govern(pdas, admin), guardian.toBytes()),
  setSponsored: (pdas: GatewayPdas, admin: PublicKey, on: boolean) =>
    ix(pdas.programId, IX.set_sponsored, govern(pdas, admin), Uint8Array.of(on ? 1 : 0)),
  pause: (pdas: GatewayPdas, who: PublicKey) => ix(pdas.programId, IX.pause, govern(pdas, who)),
  unpause: (pdas: GatewayPdas, who: PublicKey) => ix(pdas.programId, IX.unpause, govern(pdas, who)),
  setFeeConfig: (
    pdas: GatewayPdas,
    who: PublicKey,
    f: { gasToHub: bigint; returnUnit: bigint; tradeLegs: number; spawnLegs: number },
  ) =>
    ix(
      pdas.programId,
      IX.set_fee_config,
      govern(pdas, who),
      new BorshWriter().u128(f.gasToHub).u128(f.returnUnit).u8(f.tradeLegs).u8(f.spawnLegs).done(),
    ),
  setDepositCap: (pdas: GatewayPdas, who: PublicKey, cap: bigint) =>
    ix(pdas.programId, IX.set_deposit_cap, govern(pdas, who), new BorshWriter().u64(cap).done()),
  /** How long an order lives, in seconds (operator; 2 minutes to a day). */
  setOrderTtl: (pdas: GatewayPdas, who: PublicKey, ttl: number) => {
    if (!Number.isInteger(ttl) || ttl < MIN_ORDER_TTL || ttl > MAX_ORDER_TTL) {
      throw new Error(`order lifetime ${ttl}s out of bounds (${MIN_ORDER_TTL}–${MAX_ORDER_TTL}s: there is always a deadline)`)
    }
    return ix(pdas.programId, IX.set_order_ttl, govern(pdas, who), new BorshWriter().u32(ttl).done())
  },
  /** What an open prepays (operator; ≤ 8). */
  setOpenLegs: (pdas: GatewayPdas, who: PublicKey, legs: number) => {
    if (legs < 0 || legs > MAX_OPEN_LEGS) throw new Error(`open legs ${legs} out of bounds (≤ ${MAX_OPEN_LEGS})`)
    return ix(pdas.programId, IX.set_open_legs, govern(pdas, who), Uint8Array.of(legs))
  },
}

/** The price of moves toward `dstChain` (operator; ≤ 4,096; 0 closes the
 * route). The signer funds the route's account the first time. */
export function setMoveLegsIx(pdas: GatewayPdas, who: PublicKey, dstChain: number, legs: number): TransactionInstruction {
  if (legs < 0 || legs > MAX_MOVE_LEGS) throw new Error(`move legs ${legs} out of bounds (≤ ${MAX_MOVE_LEGS})`)
  return ix(
    pdas.programId,
    IX.set_move_legs,
    [sgn(who), ro(pdas.store), rw(pdas.moveRoute(dstChain)), ro(SYSTEM_PROGRAM)],
    new BorshWriter().u32(dstChain).u16(legs).done(),
  )
}

/** Names (or, with null, clears) the lookup table LayerZero's executor is
 * told to use (admin). The table must exist. */
export function setReceiveTableIx(pdas: GatewayPdas, admin: PublicKey, alt: PublicKey | null): TransactionInstruction {
  return ix(pdas.programId, IX.set_receive_table, [
    sgn(admin, false),
    ro(pdas.store),
    rw(pdas.lzReceiveTypes),
    ro(alt ?? pdas.programId),
  ])
}

/** Names the vault of chain `label` as a CCTP destination for this vault
 * (admin) — ONCE: a second call for the same label fails. `vault` is the
 * peer `OmniUSD` (20-byte EVM address or 32 bytes). */
export function setCctpPeerIx(pdas: GatewayPdas, admin: PublicKey, label: number, domain: number, vault: Uint8Array): TransactionInstruction {
  return ix(
    pdas.programId,
    IX.set_cctp_peer,
    [sgn(admin), ro(pdas.store), rw(pdas.cctpPeer(label)), ro(SYSTEM_PROGRAM)],
    new BorshWriter().u32(label).u32(domain).fixed(wideId(vault), 32).done(),
  )
}

/** Burns `usdc` of the vault through Circle CCTP V2 for the peer vault of
 * chain `label` (operator). `eventData` is a FRESH keypair's key: it holds
 * Circle's message and must sign the transaction; the operator pays its
 * rent. `domain` is the peer's CCTP domain (read it from the CctpPeer
 * account). */
export function rebalanceIx(
  c: GatewayContext,
  operator: PublicKey,
  label: number,
  domain: number,
  usdc: bigint,
  eventData: PublicKey,
): TransactionInstruction {
  positive(usdc, 'usdc')
  return ix(
    c.pdas.programId,
    IX.rebalance,
    [
      sgn(operator),
      ro(c.pdas.store),
      ro(c.pdas.cctpPeer(label)),
      rw(c.vault),
      rw(c.usdcMint),
      ro(cctpPda.senderAuthority()),
      ro(cctpPda.denylist(c.pdas.store)),
      rw(cctpPda.messageTransmitter()),
      ro(cctpPda.tokenMessenger()),
      ro(cctpPda.remoteTokenMessenger(domain)),
      ro(cctpPda.tokenMinter()),
      rw(cctpPda.localToken(c.usdcMint)),
      sgn(eventData),
      ro(CCTP_MESSAGE_TRANSMITTER_V2),
      ro(CCTP_TOKEN_MESSENGER_MINTER_V2),
      ro(TOKEN_PROGRAM),
      ro(SYSTEM_PROGRAM),
      ro(cctpPda.eventAuthority()),
    ],
    new BorshWriter().u32(label).u64(usdc).done(),
  )
}

export function recoverTankIx(pdas: GatewayPdas, admin: PublicKey, to: PublicKey, lamports: bigint): TransactionInstruction {
  return ix(
    pdas.programId,
    IX.recover_tank,
    [sgn(admin, false), ro(pdas.store), rw(pdas.gasTank), rw(to), ro(SYSTEM_PROGRAM)],
    new BorshWriter().u64(lamports).done(),
  )
}

