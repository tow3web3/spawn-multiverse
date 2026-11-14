/**
 * Decoders for the gateway's accounts (layouts: programs/spawn-gateway/src/
 * state.rs, Anchor = 8-byte discriminator + Borsh), plus the derived
 * numbers a UI shows.
 */
import { PublicKey } from '@solana/web3.js'
import { ACCOUNT_DISC, ACC_PRECISION, EVM_TO_SPL } from './constants'
import { BorshReader, equalBytes } from './bytes'

function reader(data: Uint8Array, name: keyof typeof ACCOUNT_DISC): BorshReader {
  if (data.length < 8 || !equalBytes(data.slice(0, 8), ACCOUNT_DISC[name])) {
    throw new Error(`not a ${name} account (discriminator mismatch)`)
  }
  return new BorshReader(data, 8)
}
const key = (r: BorshReader) => new PublicKey(r.fixed(32))

export interface Store {
  admin: PublicKey
  pendingAdmin: PublicKey
  operator: PublicKey
  guardian: PublicKey
  bump: number
  paused: boolean
  sponsored: boolean
  endpointProgram: PublicKey
  hubEid: number
  hubPad: Uint8Array
  usdcMint: PublicKey
  vault: PublicKey
  depositCap: bigint
  claimsTotal: bigint
  poolTotal: bigint
  usdDustE18: bigint
  gasToHub: bigint
  returnUnit: bigint
  tradeLegs: number
  spawnLegs: number
  /** Legs an `open_token` prepays (v7.2). */
  openLegs: number
}

export function decodeStore(data: Uint8Array): Store {
  const r = reader(data, 'Store')
  return {
    admin: key(r),
    pendingAdmin: key(r),
    operator: key(r),
    guardian: key(r),
    bump: r.u8(),
    paused: r.bool(),
    sponsored: r.bool(),
    endpointProgram: key(r),
    hubEid: r.u32(),
    hubPad: r.fixed(32),
    usdcMint: key(r),
    vault: key(r),
    depositCap: r.u64(),
    claimsTotal: r.u64(),
    poolTotal: r.u64(),
    usdDustE18: r.u128(),
    gasToHub: r.u128(),
    returnUnit: r.u128(),
    tradeLegs: r.u8(),
    spawnLegs: r.u8(),
    openLegs: r.u8(),
  }
}

/** The price of moves toward one chain (v7.2). No account, or 0 legs: closed. */
export interface MoveRoute {
  dstChain: number
  legs: number
  bump: number
}

export function decodeMoveRoute(data: Uint8Array): MoveRoute {
  const r = reader(data, 'MoveRoute')
  return { dstChain: r.u32(), legs: r.u16(), bump: r.u8() }
}

/** What a move to `dstChain` prepays (`send_to_hub.rs::move_legs`): the
 * route's price, never fewer legs than a trade's; 0 = closed. */
export function moveLegs(store: Store, route: MoveRoute | null, dstChain: number): number {
  if (!route || route.dstChain !== dstChain || route.legs === 0) return 0
  return Math.max(route.legs, store.tradeLegs)
}

/** A peer vault for CCTP rebalancing (set once per label). */
export interface CctpPeer {
  label: number
  domain: number
  /** CCTP's mint recipient there: an EVM `OmniUSD` address, left-padded. */
  vault: Uint8Array
  bump: number
}

export function decodeCctpPeer(data: Uint8Array): CctpPeer {
  const r = reader(data, 'CctpPeer')
  return { label: r.u32(), domain: r.u32(), vault: r.fixed(32), bump: r.u8() }
}

export interface PeerConfig {
  peerAddress: Uint8Array
  bump: number
}

export function decodePeerConfig(data: Uint8Array): PeerConfig {
  const r = reader(data, 'PeerConfig')
  return { peerAddress: r.fixed(32), bump: r.u8() }
}

export interface LzReceiveTypesAccounts {
  store: PublicKey
  /** The address lookup table the executor is told about, or the default key. */
  alt: PublicKey
  bump: number
}

export function decodeLzReceiveTypesAccounts(data: Uint8Array): LzReceiveTypesAccounts {
  const r = reader(data, 'LzReceiveTypesAccounts')
  return { store: key(r), alt: key(r), bump: r.u8() }
}

export interface Replica {
  hubToken: Uint8Array
  mint: PublicKey
  bump: number
  name: string
  symbol: string
  /** 18-decimal wei delivered and not yet minted (< 1e12). */
  dustCarry: bigint
  stakedTotal: bigint
  accPerShare: bigint
  pendingFees: bigint
}

export function decodeReplica(data: Uint8Array): Replica {
  const r = reader(data, 'Replica')
  return {
    hubToken: r.fixed(32),
    mint: key(r),
    bump: r.u8(),
    name: r.string(),
    symbol: r.string(),
    dustCarry: r.u64(),
    stakedTotal: r.u64(),
    accPerShare: r.u128(),
    pendingFees: r.u64(),
  }
}

export interface Parked {
  hubToken: Uint8Array
  /** Exact 18-decimal amount; converted when claimed. */
  amountE18: bigint
}

export interface UserAccount {
  owner: PublicKey
  bump: number
  /** USDC units owed (redeemable with `redeem_claim` when the vault has them). */
  usdClaim: bigint
  parked: Parked[]
}

export function decodeUserAccount(data: Uint8Array): UserAccount {
  const r = reader(data, 'UserAccount')
  const owner = key(r)
  const bump = r.u8()
  const usdClaim = r.u64()
  const n = r.u32()
  const parked: Parked[] = []
  for (let i = 0; i < n; i++) parked.push({ hubToken: r.fixed(32), amountE18: r.u128() })
  return { owner, bump, usdClaim, parked }
}

export interface Position {
  owner: PublicKey
  hubToken: Uint8Array
  bump: number
  staked: bigint
  rewardDebt: bigint
  /** USDC units earned and settled, not yet claimed. */
  owed: bigint
}

export function decodePosition(data: Uint8Array): Position {
  const r = reader(data, 'Position')
  return { owner: key(r), hubToken: r.fixed(32), bump: r.u8(), staked: r.u64(), rewardDebt: r.u128(), owed: r.u64() }
}

/* ----------------------------- UI arithmetic -------------------------- */

/** USDC units `claim_rewards` would pay right now (Position::settle). Fees
 * waiting in `replica.pendingFees` (below the 1,000-token floor) are not
 * included: they fold into the stream on the next stake or drop. */
export function claimableRewards(pos: Position, replica: Replica): bigint {
  const accrued = (pos.staked * replica.accPerShare) / ACC_PRECISION
  const earned = accrued > pos.rewardDebt ? accrued - pos.rewardDebt : 0n
  return pos.owed + earned
}

/** SPL units `claim_parked` would mint for a parked delivery, given the
 * replica's current carry (Replica::take_units). */
export function parkedUnits(parked: Parked, replica: Replica): bigint {
  return (parked.amountE18 + replica.dustCarry) / EVM_TO_SPL
}

/* ------------------------------ SPL helpers --------------------------- */

/** The amount and state of a classic SPL token account (165 bytes). */
export function decodeTokenAccount(data: Uint8Array): { mint: PublicKey; owner: PublicKey; amount: bigint; frozen: boolean } {
  if (data.length !== 165) throw new Error('not an SPL token account')
  const r = new BorshReader(data)
  const mint = key(r)
  const owner = key(r)
  const amount = r.u64()
  return { mint, owner, amount, frozen: data[108] === 2 }
}
