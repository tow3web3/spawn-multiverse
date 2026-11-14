use anchor_lang::prelude::*;

/// The Executor derives this PDA by this exact seed — never change it.
#[constant]
pub const LZ_RECEIVE_TYPES_SEED: &[u8] = b"LzReceiveTypes";
#[constant]
pub const STORE_SEED: &[u8] = b"Store";
#[constant]
pub const PEER_SEED: &[u8] = b"Peer";
/// Replica registry entry PDA: seeds = [REPLICA_SEED, hub_token(32)] — the
/// full 32-byte wire id, exactly as it rides the message.
#[constant]
pub const REPLICA_SEED: &[u8] = b"Replica";
/// Replica SPL mint PDA: seeds = [MINT_SEED, hub_token(32)].
#[constant]
pub const MINT_SEED: &[u8] = b"Mint";
/// The USDC vault: an SPL token account PDA (authority = the store) — this
/// chain's OmniUSD vault.
#[constant]
pub const VAULT_SEED: &[u8] = b"Vault";
/// Per-user account PDA: seeds = [USER_SEED, owner]. Holds what could not be
/// paid or minted on the spot (a USDC claim, parked deliveries).
#[constant]
pub const USER_SEED: &[u8] = b"User";
/// Staking escrow token account of a replica: seeds = [ESCROW_SEED, hub_token].
#[constant]
pub const ESCROW_SEED: &[u8] = b"Escrow";
/// A holder's staking position: seeds = [POSITION_SEED, hub_token, owner].
#[constant]
pub const POSITION_SEED: &[u8] = b"Pos";
/// The tank: a zero-data, system-owned PDA holding SOL. It pays the rent of
/// the replicas the hub tells this chain to create (hub messages can never
/// carry lamports — see V7.md), and, on a sponsored deployment (testnets),
/// the LayerZero fee of every send. Anyone funds it with a plain transfer.
#[constant]
pub const GAS_TANK_SEED: &[u8] = b"GasTank";
/// What a claim moved to one destination chain prepays (v7.2):
/// seeds = [MOVE_ROUTE_SEED, dst_chain_be(4)] — `SpawnGateway.moveLegs[dst]`.
#[constant]
pub const MOVE_ROUTE_SEED: &[u8] = b"Move";
/// The vault of another chain this vault may be levelled with over CCTP:
/// seeds = [CCTP_PEER_SEED, label_be(4)] — `OmniUSD.peers[label]`.
#[constant]
pub const CCTP_PEER_SEED: &[u8] = b"CctpPeer";

/// SPAWN! chain label of the Solana leg (lib-deploy CHAINS: 1 = solana).
pub const CHAIN_LABEL: u32 = 1;
/// The hub's own label: the pad's books, never a destination for a claim.
pub const HUB_LABEL: u32 = 0;

/// Decimal bridge: the hub counts tokens and dollars in 1e18 fixed-point;
/// SPL replicas and USDC use 6 decimals. Hub amounts divide by 1e12 on the
/// way in and multiply by 1e12 on the way out (always exact that way).
pub const SPL_DECIMALS: u8 = 6;
pub const EVM_TO_SPL_DIVISOR: u128 = 1_000_000_000_000;

/// Entry limits the hub relies on (SpawnGateway.sol: MAX_FEE_MODE,
/// MAX_NAME_BYTES, MAX_SYMBOL_BYTES, MAX_META_BYTES).
pub const MAX_FEE_MODE: u8 = 3;
pub const MAX_NAME_BYTES: usize = 64;
pub const MAX_SYMBOL_BYTES: usize = 16;
pub const MAX_META_BYTES: usize = 1024;

/// Operator bounds on the fee model (SpawnGateway.sol MAX_TRADE_LEGS /
/// MAX_SPAWN_LEGS; the adapter's cap on a reply budget: 0.05 native).
pub const MAX_TRADE_LEGS: u8 = 4;
/// 128 since the last round of v7.2: a launch whose fan-out reaches an L1
/// needs tens of its origin's legs. (What ONE message can carry toward the
/// hub is capped lower by LayerZero's executor — 0.05 ETH today, V7.md §2.)
pub const MAX_SPAWN_LEGS: u8 = 128;
pub const MAX_RETURN_UNIT: u128 = 50_000_000_000_000_000; // 0.05 ETH, in wei
/// The most executor gas the operator can make a user buy on the hub
/// (`LayerZeroOmniMessenger.MAX_EXECUTOR_GAS`): a slip above it would
/// over-charge every sender, and what it buys goes to LayerZero's executor
/// — no tank holds it, nobody can give it back.
pub const MAX_GAS_TO_HUB: u128 = 15_000_000;

/// HOW LONG AN ORDER LIVES (v7.2, `SpawnGateway.orderTtl`), in seconds.
/// Every BUY and SELL leaves with `cluster clock + order_ttl` as its
/// deadline; the hub refuses, whole, an order that lands after it. The
/// bounds are the EVM gateways': there is always a deadline, never an
/// absurd one. The floor is a guard against a slip, not a promise that an
/// order reaches the hub that fast.
pub const MIN_ORDER_TTL: u32 = 2 * 60;
pub const MAX_ORDER_TTL: u32 = 24 * 60 * 60;
/// One hour from birth: the EVM gateways' thirty minutes, plus thirty for
/// THIS chain's clock. `Clock::unix_timestamp` is not a block's wall time
/// but a stake-weighted estimate, held within 25% fast / 150% slow of the
/// nominal slot time since the epoch began: within a second of real time
/// on an ordinary day, behind it — by minutes, once by about half an hour —
/// when the cluster runs slow or comes back from a halt. The deadline is
/// written from this clock and read against the hub's, so a clock that
/// lags makes orders expire that much EARLY (they bounce whole: a fee, no
/// loss). The lifetime must absorb the lag it is expected to meet; beyond
/// it, the operator lengthens it.
pub const DEFAULT_ORDER_TTL: u32 = 60 * 60;
/// v7.2 (SpawnGateway.sol MAX_OPEN_LEGS / MAX_MOVE_LEGS): the SYNC an open
/// asks for, and the PAYOUT a move sends to ANOTHER chain — an L1 seen from
/// here costs many of this chain's reply units, hence the wide bound.
pub const MAX_OPEN_LEGS: u8 = 8;
pub const MAX_MOVE_LEGS: u16 = 4096;

/// Circle CCTP V2 on Solana — the same program ids on mainnet-beta and
/// devnet (developers.circle.com/cctp/solana-programs). Solana is domain 5.
pub const CCTP_MESSAGE_TRANSMITTER_V2: Pubkey = pubkey!("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
pub const CCTP_TOKEN_MESSENGER_MINTER_V2: Pubkey = pubkey!("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
/// `OmniUSD.rebalance`'s constants: a Standard Transfer (finality 2000),
/// no fee accepted (a fee would break the backing by its amount), anyone
/// may relay the attestation on the other side.
/// Anchor sighash of TokenMessengerMinterV2 `deposit_for_burn`
/// (sha256("global:deposit_for_burn")[..8]).
pub const CCTP_DEPOSIT_FOR_BURN: [u8; 8] = [0xd7, 0x3c, 0x3d, 0x2e, 0x72, 0x37, 0x80, 0xb0];
pub const CCTP_MIN_FINALITY: u32 = 2000;
pub const CCTP_MAX_FEE: u64 = 0;

/// Holder-fee stream: a drop only folds into the stream once at least this
/// many replica units are staked (1,000 tokens — FeeDistributor.MIN_SHARES);
/// until then it waits in `Replica.pending_fees`.
pub const MIN_STAKED: u64 = 1_000 * 1_000_000;
/// Fixed-point scale of `Replica.acc_per_share`.
pub const ACC_PRECISION: u128 = 1_000_000_000_000_000_000;

/// Parked deliveries one user account can hold (distinct tokens).
pub const MAX_PARKED: usize = 4;
