use crate::*;
use anchor_lang::solana_program::address_lookup_table::program::ID as ALT_PROGRAM_ID;
use oapp::endpoint::{instructions::RegisterOAppParams, ID as ENDPOINT_ID};

#[derive(Accounts)]
#[instruction(params: InitStoreParams)]
pub struct InitStore<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = Store::SIZE, seeds = [STORE_SEED], bump)]
    pub store: Account<'info, Store>,
    #[account(
        init,
        payer = payer,
        space = LzReceiveTypesAccounts::SIZE,
        seeds = [LZ_RECEIVE_TYPES_SEED, &store.key().to_bytes()],
        bump
    )]
    pub lz_receive_types_accounts: Account<'info, LzReceiveTypesAccounts>,
    #[account(owner = ALT_PROGRAM_ID)]
    pub alt: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

impl InitStore<'_> {
    pub fn apply(ctx: &mut Context<InitStore>, params: &InitStoreParams) -> Result<()> {
        // Either the real endpoint, or the explicit LiteSVM test sentinel
        // (default pubkey). Anything else is a misconfiguration.
        require!(
            params.endpoint == ENDPOINT_ID || params.endpoint == Pubkey::default(),
            GatewayError::BadEndpoint
        );

        let store = &mut ctx.accounts.store;
        store.admin = params.admin;
        store.bump = ctx.bumps.store;
        store.endpoint_program = params.endpoint;
        store.hub_eid = params.hub_eid;
        store.hub_pad = params.hub_pad;
        store.usd_mint = Pubkey::default(); // set by init_usd_mint

        let t = &mut ctx.accounts.lz_receive_types_accounts;
        t.store = store.key();
        t.alt = ctx.accounts.alt.as_ref().map(|a| a.key()).unwrap_or_default();
        t.bump = ctx.bumps.lz_receive_types_accounts;

        if params.endpoint != Pubkey::default() {
            let register_params = RegisterOAppParams { delegate: params.admin };
            let seeds: &[&[u8]] = &[STORE_SEED, &[ctx.bumps.store]];
            oapp::endpoint_cpi::register_oapp(
                ENDPOINT_ID,
                ctx.accounts.store.key(),
                ctx.remaining_accounts,
                seeds,
                register_params,
            )?;
        }
        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct InitStoreParams {
    pub admin: Pubkey,
    pub endpoint: Pubkey,
    pub hub_eid: u32,
    /// The hub pad's wide identity (EVM address left-padded).
    pub hub_pad: [u8; 32],
}
