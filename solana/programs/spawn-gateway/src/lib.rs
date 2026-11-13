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

/// SPAWN! gateway, Solana leg (chain label 1) — a LayerZero V2 OApp that
/// speaks protocol v7 to the hub exactly as an EVM SpawnGateway does:
///
///  - real USDC settlement: a program-owned vault takes USDC on buys and
///    pays it out on PAYOUT / refunds; what cannot be paid on the spot is a
///    redeemable claim, never a failed message;
///  - users pay for their messages and for the hub's replies (an executor
///    option forwards the reply budget into the hub adapter's tank);
///  - the whole v7 wire (ops 1–5 out, 10–13 in), entry limits, parking of
///    deliveries that beat their SYNC, roles and pause.
///
/// What Solana changes, and why, is in solana/V7.md.
#[program]
pub mod spawn_gateway {
    use super::*;

    /* ------------------------------ setup ------------------------------ */

    pub fn init_store(mut ctx: Context<InitStore>, params: InitStoreParams) -> Result<()> {
        InitStore::apply(&mut ctx, &params)
    }

    pub fn init_vault(mut ctx: Context<InitVault>) -> Result<()> {
        InitVault::apply(&mut ctx)
    }

    pub fn set_peer_config(mut ctx: Context<SetPeerConfig>, params: SetPeerConfigParams) -> Result<()> {
        SetPeerConfig::apply(&mut ctx, &params)
    }

    /* ------------------------------ roles ------------------------------ */

    pub fn transfer_admin(mut ctx: Context<Govern>, nominee: Pubkey) -> Result<()> {
        Govern::transfer_admin(&mut ctx, nominee)
    }

    pub fn accept_admin<'info>(mut ctx: Context<'_, '_, 'info, 'info, Govern<'info>>) -> Result<()> {
        Govern::accept_admin(&mut ctx)
    }

    pub fn set_operator(mut ctx: Context<Govern>, operator: Pubkey) -> Result<()> {
        Govern::set_operator(&mut ctx, operator)
    }

    pub fn set_guardian(mut ctx: Context<Govern>, guardian: Pubkey) -> Result<()> {
        Govern::set_guardian(&mut ctx, guardian)
    }

    pub fn set_sponsored(mut ctx: Context<Govern>, on: bool) -> Result<()> {
        Govern::set_sponsored(&mut ctx, on)
    }

    pub fn pause(mut ctx: Context<Govern>) -> Result<()> {
        Govern::pause(&mut ctx)
    }

    pub fn unpause(mut ctx: Context<Govern>) -> Result<()> {
        Govern::unpause(&mut ctx)
    }

    pub fn set_fee_config(mut ctx: Context<Govern>, params: FeeConfigParams) -> Result<()> {
        Govern::set_fee_config(&mut ctx, params)
    }

    pub fn set_deposit_cap(mut ctx: Context<Govern>, cap: u64) -> Result<()> {
        Govern::set_deposit_cap(&mut ctx, cap)
    }

    pub fn recover_tank(mut ctx: Context<RecoverTank>, lamports: u64) -> Result<()> {
        RecoverTank::apply(&mut ctx, lamports)
    }

    /* ----------------------------- hub → here --------------------------- */

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

    /* ----------------------------- here → hub --------------------------- */

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
        params: TokenMsgParams,
    ) -> Result<()> {
        ClaimFees::apply(&mut ctx, &params)
    }

    pub fn pull_fees<'info>(
        mut ctx: Context<'_, '_, 'info, 'info, PullFees<'info>>,
        params: TokenMsgParams,
    ) -> Result<()> {
        PullFees::apply(&mut ctx, &params)
    }

    pub fn quote_send<'info>(
        ctx: Context<'_, '_, 'info, 'info, QuoteSend<'info>>,
        params: QuoteSendParams,
    ) -> Result<u64> {
        QuoteSend::apply(&ctx, &params)
    }

    /* ------------------------------- users ------------------------------ */

    pub fn open_user_account(mut ctx: Context<OpenUserAccount>) -> Result<()> {
        OpenUserAccount::apply(&mut ctx)
    }

    pub fn redeem_claim(mut ctx: Context<RedeemClaim>, units: u64) -> Result<()> {
        RedeemClaim::apply(&mut ctx, units)
    }

    pub fn claim_parked(mut ctx: Context<ClaimParked>, hub_token: [u8; 32]) -> Result<()> {
        ClaimParked::apply(&mut ctx, hub_token)
    }

    pub fn stake(mut ctx: Context<Stake>, hub_token: [u8; 32], units: u64) -> Result<()> {
        Stake::apply(&mut ctx, hub_token, units)
    }

    pub fn unstake(mut ctx: Context<Unstake>, hub_token: [u8; 32], units: u64) -> Result<()> {
        Unstake::apply(&mut ctx, hub_token, units)
    }

    pub fn claim_rewards<'info>(
        mut ctx: Context<'_, '_, '_, 'info, ClaimRewards<'info>>,
        hub_token: [u8; 32],
    ) -> Result<()> {
        ClaimRewards::apply(&mut ctx, hub_token)
    }
}
