//! Setup and the three keys (Roles.sol): the ADMIN decides topology and
//! custody, the OPERATOR tunes prices and limits and can unpause, the
//! GUARDIAN can only pause.

use crate::*;
use anchor_lang::solana_program::{
    address_lookup_table::program::ID as ALT_PROGRAM_ID, program::invoke_signed, system_instruction,
};
use anchor_spl::token::{Mint, Token, TokenAccount};
use oapp::endpoint::{
    instructions::{RegisterOAppParams, SetDelegateParams},
    ID as ENDPOINT_ID,
};

/* ------------------------------ init_store ----------------------------- */

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
        store.pending_admin = Pubkey::default();
        store.operator = Pubkey::default();
        store.guardian = Pubkey::default();
        store.bump = ctx.bumps.store;
        store.paused = false;
        store.sponsored = false;
        store.endpoint_program = params.endpoint;
        store.hub_eid = params.hub_eid;
        store.hub_pad = params.hub_pad;
        store.usdc_mint = Pubkey::default(); // set by init_vault
        store.vault = Pubkey::default();
        store.deposit_cap = 0; // deposits closed until the operator opens them
        store.claims_total = 0;
        store.pool_total = 0;
        store.usd_dust_e18 = 0;
        store.gas_to_hub = 0; // sends refuse until set_fee_config
        store.return_unit = 0;
        store.trade_legs = 1;
        store.spawn_legs = 0;

        let t = &mut ctx.accounts.lz_receive_types_accounts;
        t.store = store.key();
        t.alt = ctx.accounts.alt.as_ref().map(|a| a.key()).unwrap_or_default();
        t.bump = ctx.bumps.lz_receive_types_accounts;

        if params.endpoint != Pubkey::default() {
            // the admin is the LayerZero delegate: it alone can choose the
            // DVN set — custody security, like the EVM adapters' delegate
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

/* ------------------------------ init_vault ----------------------------- */

/// Names the backing dollar and creates this chain's vault — once. On
/// mainnet the mint is Circle's USDC (EPjF…Dt1v); the program only insists
/// on 6 decimals, like `OmniUSD`'s constructor.
#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(mut, address = store.admin @ GatewayError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = store,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

impl InitVault<'_> {
    pub fn apply(ctx: &mut Context<InitVault>) -> Result<()> {
        require!(ctx.accounts.store.vault == Pubkey::default(), GatewayError::VaultSet);
        require!(ctx.accounts.usdc_mint.decimals == SPL_DECIMALS, GatewayError::BadUsdcDecimals);
        ctx.accounts.store.usdc_mint = ctx.accounts.usdc_mint.key();
        ctx.accounts.store.vault = ctx.accounts.vault.key();
        Ok(())
    }
}

/* ----------------------------- set_peer_config ------------------------- */

/// Names the hub adapter for a remote eid. The most dangerous setter here:
/// whoever is the peer can forge PAYOUTs out of the vault.
#[derive(Accounts)]
#[instruction(params: SetPeerConfigParams)]
pub struct SetPeerConfig<'info> {
    #[account(mut, address = store.admin @ GatewayError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        space = PeerConfig::SIZE,
        seeds = [PEER_SEED, &store.key().to_bytes(), &params.remote_eid.to_be_bytes()],
        bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    pub system_program: Program<'info, System>,
}

impl SetPeerConfig<'_> {
    pub fn apply(ctx: &mut Context<SetPeerConfig>, params: &SetPeerConfigParams) -> Result<()> {
        ctx.accounts.peer.peer_address = params.peer_address;
        ctx.accounts.peer.bump = ctx.bumps.peer;
        emit!(PeerSet { remote_eid: params.remote_eid, peer: params.peer_address });
        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SetPeerConfigParams {
    pub remote_eid: u32,
    pub peer_address: [u8; 32],
}

/* --------------------------------- roles ------------------------------- */

/// One account shape for every role-gated setter: the signer and the store.
/// Which role is required is decided per instruction.
#[derive(Accounts)]
pub struct Govern<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
}

impl<'info> Govern<'info> {
    /// Names the next admin; nothing changes until the nominee accepts.
    /// Naming the default key cancels a pending transfer.
    pub fn transfer_admin(ctx: &mut Context<Govern>, nominee: Pubkey) -> Result<()> {
        ctx.accounts.store.require_admin(ctx.accounts.authority.key)?;
        ctx.accounts.store.pending_admin = nominee;
        emit!(AdminTransferStarted { admin: ctx.accounts.store.admin, nominee });
        Ok(())
    }

    /// The nominee takes over — and becomes the LayerZero delegate in the
    /// same instruction, so the old admin keeps no power over the DVN set.
    /// remaining_accounts (live endpoint only): the endpoint's SetDelegate
    /// list — [endpoint program, store, oapp_registry(mut), event authority,
    /// endpoint program].
    pub fn accept_admin(ctx: &mut Context<'_, '_, 'info, 'info, Govern<'info>>) -> Result<()> {
        let who = ctx.accounts.authority.key();
        require!(
            who == ctx.accounts.store.pending_admin && who != Pubkey::default(),
            GatewayError::NotNominee
        );
        let previous = ctx.accounts.store.admin;
        ctx.accounts.store.admin = who;
        ctx.accounts.store.pending_admin = Pubkey::default();
        if ctx.accounts.store.endpoint_program != Pubkey::default() {
            let seeds: &[&[u8]] = &[STORE_SEED, &[ctx.accounts.store.bump]];
            oapp::endpoint_cpi::set_delegate(
                ENDPOINT_ID,
                ctx.accounts.store.key(),
                ctx.remaining_accounts,
                seeds,
                SetDelegateParams { delegate: who },
            )?;
        }
        emit!(AdminTransferred { previous, admin: who });
        Ok(())
    }

    pub fn set_operator(ctx: &mut Context<Govern>, operator: Pubkey) -> Result<()> {
        ctx.accounts.store.require_admin(ctx.accounts.authority.key)?;
        ctx.accounts.store.operator = operator;
        emit!(RoleSet { role: 1, key: operator });
        Ok(())
    }

    pub fn set_guardian(ctx: &mut Context<Govern>, guardian: Pubkey) -> Result<()> {
        ctx.accounts.store.require_admin(ctx.accounts.authority.key)?;
        ctx.accounts.store.guardian = guardian;
        emit!(RoleSet { role: 2, key: guardian });
        Ok(())
    }

    /// Sponsoring makes the tank pay every send: a testnet convenience, a
    /// drain on mainnet. Admin only, like the EVM adapters' `setSponsored`.
    pub fn set_sponsored(ctx: &mut Context<Govern>, on: bool) -> Result<()> {
        ctx.accounts.store.require_admin(ctx.accounts.authority.key)?;
        ctx.accounts.store.sponsored = on;
        emit!(SponsoredSet { on });
        Ok(())
    }

    pub fn pause(ctx: &mut Context<Govern>) -> Result<()> {
        ctx.accounts.store.require_guardian(ctx.accounts.authority.key)?;
        ctx.accounts.store.paused = true;
        emit!(PauseSet { paused: true, by: ctx.accounts.authority.key() });
        Ok(())
    }

    pub fn unpause(ctx: &mut Context<Govern>) -> Result<()> {
        ctx.accounts.store.require_operator(ctx.accounts.authority.key)?;
        ctx.accounts.store.paused = false;
        emit!(PauseSet { paused: false, by: ctx.accounts.authority.key() });
        Ok(())
    }

    /// The reply budget and the executor gas of this chain's sends. Bounded
    /// like the EVM operator's setters: it can misprice, never withdraw.
    pub fn set_fee_config(ctx: &mut Context<Govern>, params: FeeConfigParams) -> Result<()> {
        ctx.accounts.store.require_operator(ctx.accounts.authority.key)?;
        require!(
            params.trade_legs <= MAX_TRADE_LEGS
                && params.spawn_legs <= MAX_SPAWN_LEGS
                && params.return_unit <= MAX_RETURN_UNIT
                && params.gas_to_hub > 0,
            GatewayError::OutOfBounds
        );
        let store = &mut ctx.accounts.store;
        store.gas_to_hub = params.gas_to_hub;
        store.return_unit = params.return_unit;
        store.trade_legs = params.trade_legs;
        store.spawn_legs = params.spawn_legs;
        emit!(FeeConfigSet {
            gas_to_hub: params.gas_to_hub,
            return_unit: params.return_unit,
            trade_legs: params.trade_legs,
            spawn_legs: params.spawn_legs,
        });
        Ok(())
    }

    pub fn set_deposit_cap(ctx: &mut Context<Govern>, cap: u64) -> Result<()> {
        ctx.accounts.store.require_operator(ctx.accounts.authority.key)?;
        ctx.accounts.store.deposit_cap = cap;
        emit!(DepositCapSet { cap });
        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct FeeConfigParams {
    pub gas_to_hub: u128,
    pub return_unit: u128,
    pub trade_legs: u8,
    pub spawn_legs: u8,
}

/* ------------------------------ recover_tank --------------------------- */

/// Drains SOL from the tank (admin) — the adapters' `recover`.
#[derive(Accounts)]
pub struct RecoverTank<'info> {
    #[account(address = store.admin @ GatewayError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(mut, seeds = [GAS_TANK_SEED], bump)]
    pub gas_tank: SystemAccount<'info>,
    /// CHECK: any lamport recipient the admin names
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl RecoverTank<'_> {
    pub fn apply(ctx: &mut Context<RecoverTank>, lamports: u64) -> Result<()> {
        invoke_signed(
            &system_instruction::transfer(ctx.accounts.gas_tank.key, ctx.accounts.to.key, lamports),
            &[
                ctx.accounts.gas_tank.to_account_info(),
                ctx.accounts.to.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[&[GAS_TANK_SEED, &[ctx.bumps.gas_tank]]],
        )?;
        Ok(())
    }
}

/* -------------------------------- events ------------------------------- */

#[event]
pub struct PeerSet {
    pub remote_eid: u32,
    pub peer: [u8; 32],
}
#[event]
pub struct AdminTransferStarted {
    pub admin: Pubkey,
    pub nominee: Pubkey,
}
#[event]
pub struct AdminTransferred {
    pub previous: Pubkey,
    pub admin: Pubkey,
}
#[event]
pub struct RoleSet {
    /// 1 = operator, 2 = guardian
    pub role: u8,
    pub key: Pubkey,
}
#[event]
pub struct SponsoredSet {
    pub on: bool,
}
#[event]
pub struct PauseSet {
    pub paused: bool,
    pub by: Pubkey,
}
#[event]
pub struct FeeConfigSet {
    pub gas_to_hub: u128,
    pub return_unit: u128,
    pub trade_legs: u8,
    pub spawn_legs: u8,
}
#[event]
pub struct DepositCapSet {
    pub cap: u64,
}
