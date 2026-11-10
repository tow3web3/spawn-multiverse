pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("3mypQvfiLtRHQhWStYyQ6cUu6YC4hqUFBXcNNme3H95g");

/// SPAWN! gateway, Solana leg (chain label 1).
///
/// Phase 1: the skeleton — a config account naming the admin and the hub
/// (LayerZero eid + 32-byte address on the EVM side), and a ping that proves
/// the deploy/client loop. Phase 2 turns this into a real LayerZero OApp:
/// spawn/buy/sell/claim messages to the hub, SPL replicas minted/burned on
/// delivery (see solana/NOTES.md).
#[program]
pub mod spawn_gateway {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        hub_eid: u32,
        hub_address: [u8; 32],
    ) -> Result<()> {
        instructions::initialize::handler(ctx, hub_eid, hub_address)
    }

    pub fn ping(ctx: Context<Ping>) -> Result<()> {
        instructions::ping::handler(ctx)
    }
}
