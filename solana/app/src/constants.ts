import { PublicKey } from '@solana/web3.js'
import { hexToBytes } from './bytes'

/** The gateway program (`declare_id!` in programs/spawn-gateway/src/lib.rs). */
export const PROGRAM_ID = new PublicKey('3mypQvfiLtRHQhWStYyQ6cUu6YC4hqUFBXcNNme3H95g')

/* LayerZero V2 on Solana — the same program ids on mainnet-beta and devnet
 * (NOTES.md, "the facts"). */
export const LZ_ENDPOINT = new PublicKey('76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6')
export const LZ_ULN = new PublicKey('7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH')
export const LZ_EXECUTOR = new PublicKey('6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn')
export const LZ_PRICEFEED = new PublicKey('8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP')

export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
export const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111')
export const ALT_PROGRAM = new PublicKey('AddressLookupTab1e1111111111111111111111111')
export const COMPUTE_BUDGET_PROGRAM = new PublicKey('ComputeBudget111111111111111111111111111111')
/** The cluster clock (its `unix_timestamp` is what the program stamps an
 * order's deadline from). */
export const SYSVAR_CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111')

/* Circle CCTP V2 on Solana — the same program ids on mainnet-beta and
 * devnet (developers.circle.com/cctp/solana-programs). */
export const CCTP_MESSAGE_TRANSMITTER_V2 = new PublicKey('CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC')
export const CCTP_TOKEN_MESSENGER_MINTER_V2 = new PublicKey('CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe')

/** SPAWN! chain labels (contracts/scripts/lib-deploy.js CHAINS). 0 is the
 * hub's own books — never a gateway, never a destination. */
export const CHAIN_LABEL = { hub: 0, solana: 1, ethereum: 2, base: 3, bnb: 4, arbitrum: 5, optimism: 6 } as const
/** This gateway's label. */
export const SOLANA_LABEL = CHAIN_LABEL.solana
/** The labels whose gateway is an EVM contract: a recipient there is a
 * 20-byte address (the hub sends a wider one home — `SpawnPad._move`). */
export const EVM_LABELS: readonly number[] = [
  CHAIN_LABEL.ethereum,
  CHAIN_LABEL.base,
  CHAIN_LABEL.bnb,
  CHAIN_LABEL.arbitrum,
  CHAIN_LABEL.optimism,
]
/** Circle CCTP domains of the chains whose vault holds Circle USDC (BNB's
 * vault holds USDT: no CCTP, no peer). Solana itself is domain 5. */
export const CCTP_DOMAIN = { ethereum: 0, optimism: 2, arbitrum: 3, solana: 5, base: 6 } as const

/** LayerZero endpoint ids. */
export const EID = {
  SOLANA_MAINNET: 30168,
  SOLANA_DEVNET: 40168,
  BASE: 30184,
  BASE_SEPOLIA: 40245,
} as const

export type Cluster = 'mainnet-beta' | 'devnet' | 'localnet'

/** Per-cluster defaults. Every one of them can be overridden by the caller;
 * hub addresses are deliberately absent (they change with each hub
 * deployment and are always parameters). */
export const CLUSTERS: Record<Cluster, { rpc: string; usdcMint: PublicKey; solanaEid: number; defaultHubEid: number }> = {
  'mainnet-beta': {
    rpc: 'https://api.mainnet-beta.solana.com',
    // Circle's native USDC (V7.md §6 step 4)
    usdcMint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    solanaEid: EID.SOLANA_MAINNET,
    defaultHubEid: EID.BASE,
  },
  devnet: {
    rpc: 'https://api.devnet.solana.com',
    // Circle's devnet USDC (developers.circle.com, "USDC on test networks")
    usdcMint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
    solanaEid: EID.SOLANA_DEVNET,
    defaultHubEid: EID.BASE_SEPOLIA,
  },
  localnet: {
    rpc: 'http://127.0.0.1:8899',
    usdcMint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    solanaEid: EID.SOLANA_MAINNET,
    defaultHubEid: EID.BASE,
  },
}

/** The verifier set the EVM side runs (V7.md §6 step 6), as DVN CONFIG
 * accounts on Solana MAINNET. Devnet addresses differ and are not known
 * here: pass them explicitly for a devnet rehearsal. */
export const MAINNET_DVNS = {
  layerZeroLabs: new PublicKey('4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb'),
  google: new PublicKey('F7gu9kLcpn4bSTZn183mhn2RXUuMy7zckdxJZdUjuALw'),
  horizen: new PublicKey('HR9NQKK1ynW9NzgdM37dU5CBtqRHTukmbMKS7qkwSkHX'),
  twinstake: new PublicKey('GPjyWr8vCotGuFubDpTxDxy9Vj1ZeEN4F2dwRmFiaGab'),
} as const

/* ------------------------------- seeds -------------------------------- */

const s = (x: string) => new TextEncoder().encode(x)
export const SEED = {
  STORE: s('Store'),
  PEER: s('Peer'),
  VAULT: s('Vault'),
  GAS_TANK: s('GasTank'),
  REPLICA: s('Replica'),
  MINT: s('Mint'),
  USER: s('User'),
  ESCROW: s('Escrow'),
  POSITION: s('Pos'),
  MOVE_ROUTE: s('Move'),
  CCTP_PEER: s('CctpPeer'),
  LZ_RECEIVE_TYPES: s('LzReceiveTypes'),
} as const

/* ------------------------ program limits (constants.rs) ---------------- */

export const SPL_DECIMALS = 6
export const EVM_TO_SPL = 1_000_000_000_000n
export const MAX_FEE_MODE = 3
export const MAX_NAME_BYTES = 64
export const MAX_SYMBOL_BYTES = 16
export const MAX_META_BYTES = 1024
export const MAX_TRADE_LEGS = 4
export const MAX_SPAWN_LEGS = 128
/** Executor gas a send may buy on the hub (the EVM adapters' bound). */
export const MAX_GAS_TO_HUB = 15_000_000n
/** How long an order lives, in seconds (constants.rs): the operator's,
 * between two minutes and a day; one hour from birth. */
export const MIN_ORDER_TTL = 2 * 60
export const MAX_ORDER_TTL = 24 * 60 * 60
export const DEFAULT_ORDER_TTL = 60 * 60
/** What the tooling refuses to set, though the program would take it: under
 * ten minutes an ordinary delay of the pathway bounces every order. */
export const MIN_SENSIBLE_ORDER_TTL = 10 * 60
/** Sizes of the accounts a hub message may have to create here (state.rs
 * `Replica::SIZE`, an SPL mint, `UserAccount::SIZE`). */
export const REPLICA_BYTES = 201
export const MINT_BYTES = 82
export const USER_ACCOUNT_BYTES = 245
export const MAX_OPEN_LEGS = 8
export const MAX_MOVE_LEGS = 4096
export const MAX_RETURN_UNIT = 50_000_000_000_000_000n
export const MIN_STAKED = 1_000n * 1_000_000n
export const ACC_PRECISION = 1_000_000_000_000_000_000n
export const MAX_PARKED = 4

/** Compute budgets (NOTES.md / V7.md §5: sends measured at 470k–536k CU on
 * the default 4-DVN pathway; "clients should request 700,000"). */
export const SEND_COMPUTE_UNITS = 700_000
export const LOCAL_COMPUTE_UNITS = 200_000

/* --------------------------- discriminators ---------------------------
 * Copied from target/idl/spawn_gateway.json (`test/idl.test.ts` checks
 * every one against the IDL, so a rebuild that renames something fails
 * loudly instead of producing dead transactions). */

const d = hexToBytes
export const IX = {
  init_store: d('fa4a065fa3bc13b5'),
  init_vault: d('4d4f559621d9346a'),
  set_peer_config: d('4fbba8398b8c5d2f'),
  transfer_admin: d('2af2426ae40a6f9c'),
  accept_admin: d('702a2d5a74b50daa'),
  set_operator: d('ee9965a9f3832401'),
  set_guardian: d('93f332799aa4321e'),
  set_sponsored: d('f5dd62e805cb106a'),
  pause: d('d316ddfb4a79c12f'),
  unpause: d('a99004260a8dbcff'),
  set_fee_config: d('ddde34ce72c6405b'),
  set_deposit_cap: d('1e2bdb5afe0455ec'),
  recover_tank: d('552bb31a13623c25'),
  set_receive_table: d('6efd52cb345bf4a2'),
  set_open_legs: d('81f608ec45d87d00'),
  set_order_ttl: d('122368538a949a63'),
  set_move_legs: d('8cd9c04eb6403905'),
  set_cctp_peer: d('672ff3c845ffc038'),
  rebalance: d('6c9e4d09d234583e'),
  lz_receive: d('08b3786d2176bd50'),
  lz_receive_types_v2: d('6d9dc88e8adf9fa4'),
  lz_receive_types_info: d('2b94d55d657f25aa'),
  spawn_token: d('008dc19b0360099f'),
  buy_token: d('8a7f0e5b26577369'),
  sell_token: d('6d3d28bbe6b087ae'),
  claim_fees: d('52fbe99c0c34b8ca'),
  pull_fees: d('a57c45e31ac9afd6'),
  open_token: d('0bc6fe28cfac5976'),
  move_claim: d('104b763e5a686acf'),
  quote_send: d('cf0031d6a0d34cd3'),
  open_user_account: d('53aab61d8eeb3a2b'),
  redeem_claim: d('886b8504b06b99ef'),
  claim_parked: d('bd8abfbaad578154'),
  stake: d('ceb0ca12c8d1b36c'),
  unstake: d('5a5f6b2acd7c32e1'),
  claim_rewards: d('0490844774179750'),
} as const

export const ACCOUNT_DISC = {
  Store: d('8230f7f4b6bf1e1a'),
  PeerConfig: d('b59d56c621c15ecb'),
  Replica: d('0c2e7442196a6fd7'),
  UserAccount: d('d3218810ba6ef27f'),
  Position: d('aabc8fe47a40f7d0'),
  LzReceiveTypesAccounts: d('f857a77505fb157e'),
  MoveRoute: d('7f2e9acbedc0a2bc'),
  CctpPeer: d('ea6d740140f057e8'),
} as const

export const EVENT_DISC = {
  SentToHub: d('089c6e33cb7b78ad'),
  ClaimMoved: d('4e1a5e2ccc7fc862'),
  PaidOut: d('0689d1e1fc35f9fc'),
  UserAccountOpened: d('df83649768e11ae3'),
  ValueReceived: d('bdcfe72ae1e4f8b4'),
} as const

/** LayerZero programs' Anchor sighashes (sha256("global:<name>")[..8]). */
export const LZ_IX = {
  init_send_library: d('9c18eb7849c19013'),
  init_receive_library: d('c57251642de924e6'),
  init_nonce: d('ccab10d6b6bf1bc4'),
  init_config: d('17eb73e8a86001e7'),
  set_config: d('6c9e9aafd4623442'),
  set_send_library: d('fb764e9e86958105'),
  set_receive_library: d('dfacb469a5a193e4'),
  execute: d('82ddf29a0dc1bd1d'),
} as const

/** Circle's TokenMessengerMinterV2 `deposit_for_burn` sighash. */
export const CCTP_IX = {
  deposit_for_burn: d('d73c3d2e723780b0'),
} as const
