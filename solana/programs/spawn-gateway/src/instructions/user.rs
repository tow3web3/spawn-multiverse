//! What a user does with what the hub left them: redeem a dollar claim,
//! claim a parked delivery, and stake replicas to earn the token's holder
//! fees. NONE of this is ever paused — a pause blocks new exposure only.

use crate::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount},
};
use util::{PayoutAccounts, Paid};

/* --------------------------- open_user_account ------------------------- */

/// Opens `owner`'s user account. Anyone may pay for it — it is what lets a
/// hub reply for `owner` be parked instead of failing.
#[derive(Accounts)]
pub struct OpenUserAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: only its address is used
    pub owner: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = UserAccount::SIZE,
        seeds = [USER_SEED, owner.key().as_ref()],
        bump
    )]
    pub user_account: Account<'info, UserAccount>,
    pub system_program: Program<'info, System>,
}

impl OpenUserAccount<'_> {
    pub fn apply(ctx: &mut Context<OpenUserAccount>) -> Result<()> {
        let ua = &mut ctx.accounts.user_account;
        if ua.owner == Pubkey::default() {
            ua.owner = ctx.accounts.owner.key();
            ua.bump = ctx.bumps.user_account;
        }
        Ok(())
    }
}

/* ------------------------------ redeem_claim --------------------------- */

/// Turns a dollar claim into USDC — `OmniUSD.unwrap`. Fails while the vault
/// is short; the claim stays valid until liquidity is rebalanced in.
#[derive(Accounts)]
pub struct RedeemClaim<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,
    #[account(
        mut,
        seeds = [USER_SEED, user.key().as_ref()],
        bump = user_account.bump,
        constraint = user_account.owner == user.key() @ GatewayError::AccountMismatch
    )]
    pub user_account: Box<Account<'info, UserAccount>>,
    #[account(address = store.usdc_mint @ GatewayError::NoVault)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = store.vault @ GatewayError::NoVault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usdc_mint,
        associated_token::authority = user
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl RedeemClaim<'_> {
    pub fn apply(ctx: &mut Context<RedeemClaim>, units: u64) -> Result<()> {
        require!(units > 0, GatewayError::ZeroAmount);
        require!(ctx.accounts.user_account.usd_claim >= units, GatewayError::NothingToRedeem);
        require!(ctx.accounts.vault.amount >= units, GatewayError::VaultShort);
        ctx.accounts.user_account.usd_claim -= units;
        ctx.accounts.store.claims_total = ctx.accounts.store.claims_total.saturating_sub(units);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.store.to_account_info(),
                },
                &[&[STORE_SEED, &[ctx.accounts.store.bump]]],
            ),
            units,
        )?;
        emit!(ClaimRedeemed { user: ctx.accounts.user.key(), usdc: units });
        Ok(())
    }
}

/* ------------------------------ claim_parked --------------------------- */

/// Mints the caller's parked delivery of one token — the gateways'
/// `claimPending`. A plain local transaction, no message; the caller funds
/// their own token account.
#[derive(Accounts)]
#[instruction(hub_token: [u8; 32])]
pub struct ClaimParked<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,
    #[account(
        mut,
        seeds = [USER_SEED, user.key().as_ref()],
        bump = user_account.bump,
        constraint = user_account.owner == user.key() @ GatewayError::AccountMismatch
    )]
    pub user_account: Box<Account<'info, UserAccount>>,
    #[account(mut, seeds = [REPLICA_SEED, &hub_token], bump = replica.bump)]
    pub replica: Box<Account<'info, Replica>>,
    #[account(mut, address = replica.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user
    )]
    pub user_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl ClaimParked<'_> {
    pub fn apply(ctx: &mut Context<ClaimParked>, hub_token: [u8; 32]) -> Result<()> {
        let ua = &mut ctx.accounts.user_account;
        let idx = ua
            .parked
            .iter()
            .position(|p| p.hub_token == hub_token)
            .ok_or(GatewayError::NothingParked)?;
        let amount_e18 = ua.parked.remove(idx).amount_e18;
        let units = ctx.accounts.replica.take_units(amount_e18)?;
        util::mint_replica(
            &ctx.accounts.store,
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.user_token.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            units,
        )?;
        emit!(ParkedClaimed { hub_token, user: ctx.accounts.user.key(), units });
        Ok(())
    }
}

/* ----------------------------- stake / unstake ------------------------- */

/// The holder-fee pool (the Solana FeeDistributor). SPL tokens have no
/// transfer hook, so shares cannot follow wallet balances the way they do
/// on the EVM chains: a holder EARNS on what they STAKE here. Staked
/// replicas sit in the token's escrow; unstaking is always open.
#[derive(Accounts)]
#[instruction(hub_token: [u8; 32])]
pub struct Stake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,
    #[account(mut, seeds = [REPLICA_SEED, &hub_token], bump = replica.bump)]
    pub replica: Box<Account<'info, Replica>>,
    #[account(address = replica.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = user,
        seeds = [ESCROW_SEED, &hub_token],
        bump,
        token::mint = mint,
        token::authority = store,
    )]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = user,
        space = Position::SIZE,
        seeds = [POSITION_SEED, &hub_token, user.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, token::mint = mint, token::authority = user)]
    pub user_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl Stake<'_> {
    pub fn apply(ctx: &mut Context<Stake>, hub_token: [u8; 32], units: u64) -> Result<()> {
        require!(units > 0, GatewayError::ZeroAmount);
        let pos = &mut ctx.accounts.position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.user.key();
            pos.hub_token = hub_token;
            pos.bump = ctx.bumps.position;
        }
        let replica = &mut ctx.accounts.replica;
        pos.settle(replica.acc_per_share);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.user_token.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            units,
        )?;
        pos.staked = pos.staked.checked_add(units).ok_or(GatewayError::AmountOverflow)?;
        replica.staked_total = replica.staked_total.checked_add(units).ok_or(GatewayError::AmountOverflow)?;
        // the new staker's debt is taken at the OLD rate, then any drop that
        // was waiting for enough stake folds in — shared by everyone staked
        // now, this staker included (the FeeDistributor's pending rule)
        pos.rebase(replica.acc_per_share);
        replica.fold(0);
        emit!(Staked { hub_token, user: ctx.accounts.user.key(), units, staked: pos.staked });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(hub_token: [u8; 32])]
pub struct Unstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,
    #[account(mut, seeds = [REPLICA_SEED, &hub_token], bump = replica.bump)]
    pub replica: Box<Account<'info, Replica>>,
    #[account(address = replica.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [ESCROW_SEED, &hub_token], bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &hub_token, user.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ GatewayError::AccountMismatch
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user
    )]
    pub user_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl Unstake<'_> {
    pub fn apply(ctx: &mut Context<Unstake>, hub_token: [u8; 32], units: u64) -> Result<()> {
        require!(units > 0, GatewayError::ZeroAmount);
        let pos = &mut ctx.accounts.position;
        let replica = &mut ctx.accounts.replica;
        require!(pos.staked >= units, GatewayError::NotEnoughStaked);
        pos.settle(replica.acc_per_share);
        pos.staked -= units;
        replica.staked_total = replica.staked_total.saturating_sub(units);
        pos.rebase(replica.acc_per_share);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.escrow.to_account_info(),
                    to: ctx.accounts.user_token.to_account_info(),
                    authority: ctx.accounts.store.to_account_info(),
                },
                &[&[STORE_SEED, &[ctx.accounts.store.bump]]],
            ),
            units,
        )?;
        emit!(Unstaked { hub_token, user: ctx.accounts.user.key(), units, staked: pos.staked });
        Ok(())
    }
}

/* ------------------------------ claim_rewards -------------------------- */

/// Pays the caller the holder fees their stake earned — USDC when the vault
/// has it, a claim otherwise (never a failure).
#[derive(Accounts)]
#[instruction(hub_token: [u8; 32])]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(seeds = [REPLICA_SEED, &hub_token], bump = replica.bump)]
    pub replica: Box<Account<'info, Replica>>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &hub_token, user.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ GatewayError::AccountMismatch
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(
        init_if_needed,
        payer = user,
        space = UserAccount::SIZE,
        seeds = [USER_SEED, user.key().as_ref()],
        bump
    )]
    pub user_account: Box<Account<'info, UserAccount>>,
    #[account(address = store.usdc_mint @ GatewayError::NoVault)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = store.vault @ GatewayError::NoVault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usdc_mint,
        associated_token::authority = user
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> ClaimRewards<'info> {
    pub fn apply(ctx: &mut Context<'_, '_, '_, 'info, ClaimRewards<'info>>, hub_token: [u8; 32]) -> Result<()> {
        let user_key = ctx.accounts.user.key();
        if ctx.accounts.user_account.owner == Pubkey::default() {
            ctx.accounts.user_account.owner = user_key;
            ctx.accounts.user_account.bump = ctx.bumps.user_account;
        }
        let acc = ctx.accounts.replica.acc_per_share;
        let pos = &mut ctx.accounts.position;
        pos.settle(acc);
        pos.rebase(acc);
        let owed = pos.owed;
        require!(owed > 0, GatewayError::NothingToRedeem);
        pos.owed = 0;

        // the fees leave the pool either way: as USDC, or as a claim
        let store = &mut ctx.accounts.store;
        store.pool_total = store.pool_total.saturating_sub(owed);
        let (usdc_mint, vault, recipient_usdc, token_program) = (
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.user_usdc.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        );
        let accounts = PayoutAccounts {
            usdc_mint: &usdc_mint,
            vault: &vault,
            recipient_usdc: &recipient_usdc,
            token_program: &token_program,
        };
        let paid = util::pay_usdc(store, &accounts, &user_key, Some(&mut ctx.accounts.user_account), owed)?;
        let (usdc, claim) = match paid {
            Paid::Usdc(n) => (n, 0),
            Paid::Claim(n) => (0, n),
            Paid::Nothing => (0, 0),
        };
        emit!(RewardsClaimed { hub_token, user: user_key, usdc, claim });
        Ok(())
    }
}

#[event]
pub struct ClaimRedeemed {
    pub user: Pubkey,
    pub usdc: u64,
}
#[event]
pub struct ParkedClaimed {
    pub hub_token: [u8; 32],
    pub user: Pubkey,
    pub units: u64,
}
#[event]
pub struct Staked {
    pub hub_token: [u8; 32],
    pub user: Pubkey,
    pub units: u64,
    pub staked: u64,
}
#[event]
pub struct Unstaked {
    pub hub_token: [u8; 32],
    pub user: Pubkey,
    pub units: u64,
    pub staked: u64,
}
#[event]
pub struct RewardsClaimed {
    pub hub_token: [u8; 32],
    pub user: Pubkey,
    pub usdc: u64,
    pub claim: u64,
}
