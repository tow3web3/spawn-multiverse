pub mod constants;
pub mod error;
pub mod instructions;
pub mod msg_codec;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use error::GatewayError;
pub use instructions::*;
pub use msg_codec::SpawnMsg;
pub use state::*;

use oapp::{
    lz_receive_types_v2::{LzReceiveTypesV2Accounts, LzReceiveTypesV2Result},
    LzReceiveParams,
};

declare_id!("3mypQvfiLtRHQhWStYyQ6cUu6YC4hqUFBXcNNme3H95g");

/// SPAWN! gateway, Solana leg (chain label 1) — a LayerZero V2 OApp.
///
/// Phase 2a: Store/Peer OApp pattern, the byte-exact SPAWN! codec, and the
/// hub→solana receive path (SYNC_TOKEN replicas as SPL mints, DELIVER,
/// PAYOUT, FEE_DROP). Phase 2b (local half): the send path — spawn / buy /
/// sell / claim toward the hub, self-quoting through the endpoint with the
/// gas-tank PDA footing the LayerZero fee — proven against the REAL devnet
/// endpoint/ULN/executor/pricefeed/DVN binaries under LiteSVM. Devnet
/// deploy + hub wiring remain — see solana/NOTES.md.
#[program]
pub mod spawn_gateway {
    use super::*;

    pub fn init_store(mut ctx: Context<InitStore>, params: InitStoreParams) -> Result<()> {
        InitStore::apply(&mut ctx, &params)
    }

    pub fn set_peer_config(
        mut ctx: Context<SetPeerConfig>,
        params: SetPeerConfigParams,
    ) -> Result<()> {
        SetPeerConfig::apply(&mut ctx, &params)
    }

    pub fn init_usd_mint(mut ctx: Context<InitUsdMint>) -> Result<()> {
        InitUsdMint::apply(&mut ctx)
    }

    pub fn lz_receive<'info>(
        mut ctx: Context<'_, '_, 'info, 'info, LzReceive<'info>>,
        params: LzReceiveParams,
    ) -> Result<()> {
        LzReceive::apply(&mut ctx, &params)
    }

    pub fn lz_receive_types_v2(
        ctx: Context<LzReceiveTypesV2>,
        params: LzReceiveParams,
    ) -> Result<LzReceiveTypesV2Result> {
        LzReceiveTypesV2::apply(&ctx, &params)
    }

    pub fn lz_receive_types_info(
        ctx: Context<LzReceiveTypesInfo>,
        params: LzReceiveParams,
    ) -> Result<(u8, LzReceiveTypesV2Accounts)> {
        LzReceiveTypesInfo::apply(&ctx, &params)
    }

    pub fn spawn_token<'info>(
        mut ctx: Context<'_, '_, 'info, 'info, SpawnToken<'info>>,
        params: SpawnTokenParams,
    ) -> Result<()> {
        SpawnToken::apply(&mut ctx, &params)
    }

    pub fn buy_token<'info>(
        mut ctx: Context<'_, '_, 'info, 'info, BuyToken<'info>>,
        params: BuyTokenParams,
    ) -> Result<()> {
        BuyToken::apply(&mut ctx, &params)
    }

    pub fn sell_token<'info>(
        mut ctx: Context<'_, '_, 'info, 'info, SellToken<'info>>,
        params: SellTokenParams,
    ) -> Result<()> {
        SellToken::apply(&mut ctx, &params)
    }

    pub fn claim_fees<'info>(
        mut ctx: Context<'_, '_, 'info, 'info, ClaimFees<'info>>,
        params: ClaimFeesParams,
    ) -> Result<()> {
        ClaimFees::apply(&mut ctx, &params)
    }
}
