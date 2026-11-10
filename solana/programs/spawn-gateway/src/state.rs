use anchor_lang::prelude::*;

/// The OApp's one global account (PDA, seeds = [STORE_SEED]). Its key IS the
/// OApp's "address" on Solana — the hub routes to it as bytes32, exactly like
/// an EVM adapter address.
#[account]
pub struct Store {
    pub admin: Pubkey,
    pub bump: u8,
    /// The LayerZero EndpointV2 program — or `Pubkey::default()`, the
    /// explicit TEST SENTINEL under which every endpoint CPI (register,
    /// clear) is skipped so LiteSVM can exercise the message handlers.
    /// `init_store` refuses anything else that isn't the real endpoint id,
    /// so a live deploy can't end up half-configured.
    pub endpoint_program: Pubkey,
    /// The hub's LayerZero eid (Base Sepolia testnet: 40245).
    pub hub_eid: u32,
    /// This chain's oUSD stand-in mint (created by `init_usd_mint`).
    pub usd_mint: Pubkey,
}

impl Store {
    pub const SIZE: usize = 8 + std::mem::size_of::<Self>();
}

/// Executor prerequisite: tells it how to call lz_receive_types.
/// (PDA, seeds = [LZ_RECEIVE_TYPES_SEED, store]).
#[account]
pub struct LzReceiveTypesAccounts {
    pub store: Pubkey,
    pub alt: Pubkey,
    pub bump: u8,
}

impl LzReceiveTypesAccounts {
    pub const SIZE: usize = 8 + std::mem::size_of::<Self>();
}

/// Per-remote-chain config (PDA, seeds = [PEER_SEED, store, eid_be]).
/// `peer_address` is the 32-byte remote sender we accept — for the hub leg,
/// the Base Sepolia LayerZeroOmniMessenger adapter, left-padded like every
/// EVM bytes32 peer.
#[account]
pub struct PeerConfig {
    pub peer_address: [u8; 32],
    pub enforced_options: EnforcedOptions,
    pub bump: u8,
}

impl PeerConfig {
    pub const SIZE: usize = 8 + std::mem::size_of::<Self>() + 512 + 1024;
}

#[derive(Clone, Default, AnchorSerialize, AnchorDeserialize, InitSpace)]
pub struct EnforcedOptions {
    #[max_len(512)]
    pub send: Vec<u8>,
    #[max_len(1024)]
    pub send_and_call: Vec<u8>,
}

/// Replica registry entry (PDA, seeds = [REPLICA_SEED, hub_token]) — the
/// Solana analog of SpawnGateway.replicaOf: maps the 32-byte wire token id
/// (the EVM hub token, left-padded) to its local SPL mint. Created on
/// OP_SYNC_TOKEN.
#[account]
pub struct Replica {
    pub hub_token: [u8; 32],
    pub mint: Pubkey,
    pub name: String,
    pub symbol: String,
    pub bump: u8,
}

impl Replica {
    pub const MAX_NAME: usize = 64;
    pub const MAX_SYMBOL: usize = 16;
    pub const SIZE: usize = 8 + std::mem::size_of::<Self>() + Self::MAX_NAME + Self::MAX_SYMBOL;
}
