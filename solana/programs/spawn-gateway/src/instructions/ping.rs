use anchor_lang::prelude::*;

use crate::{constants::CONFIG_SEED, state::Config};

#[event]
pub struct Pinged {
    pub by: Pubkey,
    pub seq: u64,
    pub hub_eid: u32,
}

#[derive(Accounts)]
pub struct Ping<'info> {
    pub by: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

pub fn handler(ctx: Context<Ping>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.pings += 1;
    emit!(Pinged {
        by: ctx.accounts.by.key(),
        seq: c.pings,
        hub_eid: c.hub_eid,
    });
    Ok(())
}
