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

/// SPAWN! chain label of the Solana leg (lib-deploy CHAINS: 1 = solana).
pub const CHAIN_LABEL: u32 = 1;

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
pub const MAX_SPAWN_LEGS: u8 = 32;
pub const MAX_RETURN_UNIT: u128 = 50_000_000_000_000_000; // 0.05 ETH, in wei

/// Holder-fee stream: a drop only folds into the stream once at least this
/// many replica units are staked (1,000 tokens — FeeDistributor.MIN_SHARES);
/// until then it waits in `Replica.pending_fees`.
pub const MIN_STAKED: u64 = 1_000 * 1_000_000;
/// Fixed-point scale of `Replica.acc_per_share`.
pub const ACC_PRECISION: u128 = 1_000_000_000_000_000_000;

/// Parked deliveries one user account can hold (distinct tokens).
pub const MAX_PARKED: usize = 4;
