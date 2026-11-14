/**
 * Instruction builders for every gateway instruction. Account orders follow
 * the `#[derive(Accounts)]` structs in programs/spawn-gateway/src/
 * instructions/ (cross-checked against target/idl/spawn_gateway.json by
 * test/idl.test.ts).
 *
 * The five sends share one generic builder: a `SendSpec` says which named
 * accounts the instruction takes, how its arguments encode, and how it is
 * quoted; `buildSendIx` appends the LayerZero send list. Adding a send
 * (`open_token`, `move_claim`, …) is one more entry in `SENDS`.
 */
import { AccountMeta, PublicKey, TransactionInstruction } from '@solana/web3.js'
import {
  ATA_PROGRAM,
  IX,
  MAX_FEE_MODE,
  MAX_META_BYTES,
  MAX_NAME_BYTES,
  MAX_SYMBOL_BYTES,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from './constants'
import { BorshWriter, encodeUtf8, toBuffer } from './bytes'
import { GatewayPdas, asBytes32, ata } from './pda'
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
  /** The payload the program will put on the wire (for display / checks). */
  message(user: PublicKey, p: P): SpawnMsg
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
  /** The USDC account to pay from (default: the user's ATA). */
  userUsdc?: PublicKey
}
export interface SellParams {
  hubToken: Uint8Array
  /** Replica units (6 decimals). */
  amount: bigint
  /** The replica account to burn from (default: the user's ATA). */
  userToken?: PublicKey
}
export interface TokenParams {
  hubToken: Uint8Array
}

const noStrings = { name: '', symbol: '', metaUri: '', withDevBuy: false }
const positive = (v: bigint, what: string) => {
  if (v <= 0n) throw new Error(`${what} must be > 0 (the program refuses ZeroAmount)`)
}

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
    quote: (p) => ({ op: OP.SPAWN, name: p.name, symbol: p.symbol, metaUri: p.metaUri, withDevBuy: p.devBuyUsdc > 0n }),
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
    args: (p, fee) => new BorshWriter().fixed(asBytes32(p.hubToken), 32).u64(p.usdcIn).u64(fee).done(),
    quote: () => ({ op: OP.BUY, ...noStrings }),
    message: (user, p) => ({ op: 'BUY', hubToken: p.hubToken, buyer: user.toBytes(), usdIn: splToE18(p.usdcIn) }),
    check: (p) => positive(p.usdcIn, 'usdcIn'),
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
    args: (p, fee) => new BorshWriter().fixed(asBytes32(p.hubToken), 32).u64(p.amount).u64(fee).done(),
    quote: () => ({ op: OP.SELL, ...noStrings }),
    message: (user, p) => ({ op: 'SELL', hubToken: p.hubToken, seller: user.toBytes(), tokensIn: splToE18(p.amount) }),
    check: (p) => positive(p.amount, 'amount'),
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
  } as SendSpec<TokenParams>,

  pull_fees: {
    name: 'pull_fees',
    accounts: (c, user, p) => [...head(c, user), ro(c.pdas.replica(p.hubToken)), ro(SYSTEM_PROGRAM)],
    args: (p, fee) => new BorshWriter().fixed(asBytes32(p.hubToken), 32).u64(fee).done(),
    quote: () => ({ op: OP.PULL_FEES, ...noStrings }),
    message: (_user, p) => ({ op: 'PULL_FEES', hubToken: p.hubToken }),
  } as SendSpec<TokenParams>,
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
 * `payer` only fills the list's payer slot). */
export function quoteSendIx(c: SendContext, q: QuoteSendParams, payer: PublicKey): TransactionInstruction {
  const args = new BorshWriter().u8(q.op).string(q.name).string(q.symbol).string(q.metaUri).bool(q.withDevBuy).done()
  const keys = [ro(c.pdas.store), ro(c.pdas.peer(c.hubEid)), ...sendRemainingAccounts(c.path, payer, false)]
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
 * the executor will be told about — it can only be set here (there is no
 * setter), and it must already exist (owner check). */
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
}

export function recoverTankIx(pdas: GatewayPdas, admin: PublicKey, to: PublicKey, lamports: bigint): TransactionInstruction {
  return ix(
    pdas.programId,
    IX.recover_tank,
    [sgn(admin, false), ro(pdas.store), rw(pdas.gasTank), rw(to), ro(SYSTEM_PROGRAM)],
    new BorshWriter().u64(lamports).done(),
  )
}

