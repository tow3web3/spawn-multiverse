use anchor_lang::prelude::*;

/// The Executor derives this PDA by this exact seed — never change it.
#[constant]
pub const LZ_RECEIVE_TYPES_SEED: &[u8] = b"LzReceiveTypes";
#[constant]
pub const STORE_SEED: &[u8] = b"Store";
#[constant]
pub const PEER_SEED: &[u8] = b"Peer";
/// Replica registry entry PDA: seeds = [REPLICA_SEED, hub_token(20)].
#[constant]
pub const REPLICA_SEED: &[u8] = b"Replica";
/// Replica SPL mint PDA: seeds = [MINT_SEED, hub_token(20)].
#[constant]
pub const MINT_SEED: &[u8] = b"Mint";
/// The chain's oUSD stand-in mint PDA (testnet money, like the EVM OmniUSD).
#[constant]
pub const USD_MINT_SEED: &[u8] = b"UsdMint";

/// SPAWN! chain label of the Solana leg (lib-deploy CHAINS: 1 = solana).
pub const CHAIN_LABEL: u32 = 1;

/// Decimal bridge: EVM amounts are 1e18 fixed-point; SPL mints here use 6
/// decimals, so every hub amount divides by 1e12 on the way in (floor; the
/// sub-1e-6 dust is simply never minted) and multiplies by 1e12 on the way
/// out. 1B tokens × 1e6 = 1e15 ≪ u64::MAX, so nothing can overflow.
pub const SPL_DECIMALS: u8 = 6;
pub const EVM_TO_SPL_DIVISOR: u128 = 1_000_000_000_000;
