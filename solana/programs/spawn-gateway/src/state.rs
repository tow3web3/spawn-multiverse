use anchor_lang::prelude::*;

/// The gateway's single config account (PDA, seeds = ["config"]).
/// `hub_address` is the EVM hub pad address, left-padded to 32 bytes — the
/// same bytes32 convention the EVM adapters use for LayerZero peers.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub hub_eid: u32,
    pub hub_address: [u8; 32],
    pub pings: u64,
    pub bump: u8,
}
