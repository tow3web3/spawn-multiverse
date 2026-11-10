use crate::*;
use anchor_spl::token::{Mint, Token};

/// Creates this chain's oUSD stand-in mint (testnet money, the analog of the
/// EVM OmniUSD). Authority is the Store PDA — only the gateway mints, on
/// OP_DELIVER refunds, OP_PAYOUT and OP_FEE_DROP.
#[derive(Accounts)]
pub struct InitUsdMint<'info> {
    #[account(mut, address = store.admin @ GatewayError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        init,
        payer = admin,
        seeds = [USD_MINT_SEED],
        bump,
        mint::decimals = SPL_DECIMALS,
        mint::authority = store,
    )]
    pub usd_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

impl InitUsdMint<'_> {
    pub fn apply(ctx: &mut Context<InitUsdMint>) -> Result<()> {
        ctx.accounts.store.usd_mint = ctx.accounts.usd_mint.key();
        Ok(())
    }
}
