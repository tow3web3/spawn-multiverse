//! Setup and the three keys (Roles.sol): the ADMIN decides topology and
//! custody, the OPERATOR tunes prices and limits and can unpause, the
//! GUARDIAN can only pause.

use crate::*;
use anchor_lang::solana_program::{
    address_lookup_table::program::ID as ALT_PROGRAM_ID, program::invoke_signed, system_instruction,
};
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
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
        // BORN PAUSED: between this instruction and the end of the wiring
        // (peer, vault, verifier set, prices, the hub's own batch) nothing
        // may go out. The operator unpauses when it is all in place.
        store.paused = true;
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
        store.open_legs = 1; // never 0 by default: see `Store::open_legs`

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

/* ---------------------------- set_receive_table ------------------------ */

/// Names (or clears) the address lookup table LayerZero's executor is told
/// to build its delivery transaction with. `init_store` records one if it
/// is given one; this is how it is set afterwards, or replaced — a table
/// cannot be edited, only extended, so a changed verifier set or a table
/// that was closed needs a new one. Admin: the executor resolves every
/// inbound message through it, so a table that vanished stalls deliveries
/// (never changes them: a table only shortens addresses the program lists
/// itself).
#[derive(Accounts)]
pub struct SetReceiveTable<'info> {
    #[account(address = store.admin @ GatewayError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        mut,
        seeds = [LZ_RECEIVE_TYPES_SEED, &store.key().to_bytes()],
        bump = lz_receive_types_accounts.bump
    )]
    pub lz_receive_types_accounts: Account<'info, LzReceiveTypesAccounts>,
    #[account(owner = ALT_PROGRAM_ID @ GatewayError::BadLookupTable)]
    pub alt: Option<UncheckedAccount<'info>>,
}

impl SetReceiveTable<'_> {
    pub fn apply(ctx: &mut Context<SetReceiveTable>) -> Result<()> {
        let alt = ctx.accounts.alt.as_ref().map(|a| a.key()).unwrap_or_default();
        ctx.accounts.lz_receive_types_accounts.alt = alt;
        emit!(ReceiveTableSet { alt });
        Ok(())
    }
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

    /// What an open prepays (`SpawnGateway.setOpenLegs`): a price, the
    /// operator's, bounded.
    pub fn set_open_legs(ctx: &mut Context<Govern>, legs: u8) -> Result<()> {
        ctx.accounts.store.require_operator(ctx.accounts.authority.key)?;
        require!(legs <= MAX_OPEN_LEGS, GatewayError::OutOfBounds);
        ctx.accounts.store.open_legs = legs;
        emit!(OpenLegsSet { legs });
        Ok(())
    }
}

/* ------------------------------ set_move_legs -------------------------- */

/// Prices — and thereby opens or closes — moves of claims toward one chain
/// (`SpawnGateway.setMoveLegs`): the operator's, bounded. 0 closes the
/// route. The signer funds the route's account the first time.
#[derive(Accounts)]
#[instruction(dst_chain: u32)]
pub struct SetMoveLegs<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        init_if_needed,
        payer = authority,
        space = MoveRoute::SIZE,
        seeds = [MOVE_ROUTE_SEED, &dst_chain.to_be_bytes()],
        bump
    )]
    pub route: Account<'info, MoveRoute>,
    pub system_program: Program<'info, System>,
}

impl SetMoveLegs<'_> {
    pub fn apply(ctx: &mut Context<SetMoveLegs>, dst_chain: u32, legs: u16) -> Result<()> {
        ctx.accounts.store.require_operator(ctx.accounts.authority.key)?;
        require!(legs <= MAX_MOVE_LEGS, GatewayError::OutOfBounds);
        // a claim cannot be moved to where it is, nor into the hub's books
        require!(dst_chain != CHAIN_LABEL && dst_chain != HUB_LABEL, GatewayError::BadDestination);
        let route = &mut ctx.accounts.route;
        route.dst_chain = dst_chain;
        route.legs = legs;
        route.bump = ctx.bumps.route;
        emit!(MoveLegsSet { dst_chain, legs });
        Ok(())
    }
}

/* ------------------------- CCTP: peers and rebalance ------------------- */

/// Names the vault of another chain as a destination for this vault's USDC
/// (`OmniUSD.setPeer`). ONCE per label, never re-aimed (`init`: a second
/// call finds the account and fails): a peer is a way out of the vault, so
/// it is the admin's — a multisig behind a delay — and it is forever.
#[derive(Accounts)]
#[instruction(label: u32)]
pub struct SetCctpPeer<'info> {
    #[account(mut, address = store.admin @ GatewayError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        init,
        payer = admin,
        space = CctpPeer::SIZE,
        seeds = [CCTP_PEER_SEED, &label.to_be_bytes()],
        bump
    )]
    pub cctp_peer: Account<'info, CctpPeer>,
    pub system_program: Program<'info, System>,
}

impl SetCctpPeer<'_> {
    pub fn apply(ctx: &mut Context<SetCctpPeer>, label: u32, domain: u32, vault: [u8; 32]) -> Result<()> {
        require!(label != CHAIN_LABEL && vault != [0u8; 32], GatewayError::BadCctpPeer);
        let peer = &mut ctx.accounts.cctp_peer;
        peer.label = label;
        peer.domain = domain;
        peer.vault = vault;
        peer.bump = ctx.bumps.cctp_peer;
        emit!(CctpPeerSet { label, domain, vault });
        Ok(())
    }
}

/// Levels this vault with a peer vault: burns `usdc` of the vault's USDC
/// through Circle CCTP V2 (`deposit_for_burn`), to be minted to the peer's
/// vault on its chain — `OmniUSD.rebalance`, with the same fixed terms: the
/// recipient is the peer the admin named and nothing else, anyone may relay
/// the attestation (no destination caller), no fee is accepted (a non-zero
/// CCTP minimum fee makes this fail — safely: a fee would break the backing
/// by its amount), Standard finality.
///
/// The OPERATOR's: it moves liquidity between protocol vaults and nowhere
/// else — a liveness power (local payouts fall back to claims until it
/// comes back), not a way out. The operator pays the rent of Circle's
/// message account (`message_sent_event_data`, a fresh keypair that signs).
///
/// The store signs as the vault's owner, toward Circle's program ONLY: the
/// program id is pinned (`CCTP_TOKEN_MESSENGER_MINTER_V2`); every other
/// account below is Circle's to check.
#[derive(Accounts)]
#[instruction(label: u32)]
pub struct Rebalance<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,
    #[account(seeds = [CCTP_PEER_SEED, &label.to_be_bytes()], bump = cctp_peer.bump)]
    pub cctp_peer: Account<'info, CctpPeer>,
    #[account(mut, address = store.vault @ GatewayError::NoVault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = store.usdc_mint @ GatewayError::NoVault)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// CHECK: Circle's `sender_authority` PDA
    pub sender_authority: UncheckedAccount<'info>,
    /// CHECK: Circle's denylist PDA of the store (must not exist)
    pub denylist_account: UncheckedAccount<'info>,
    /// CHECK: Circle's MessageTransmitter state
    #[account(mut)]
    pub message_transmitter: UncheckedAccount<'info>,
    /// CHECK: Circle's TokenMessenger state
    pub token_messenger: UncheckedAccount<'info>,
    /// CHECK: Circle's RemoteTokenMessenger of the peer's domain
    pub remote_token_messenger: UncheckedAccount<'info>,
    /// CHECK: Circle's TokenMinter state
    pub token_minter: UncheckedAccount<'info>,
    /// CHECK: Circle's LocalToken of USDC
    #[account(mut)]
    pub local_token: UncheckedAccount<'info>,
    /// A fresh account for Circle's message; it signs its own creation.
    #[account(mut)]
    pub message_sent_event_data: Signer<'info>,
    /// CHECK: pinned id
    #[account(address = CCTP_MESSAGE_TRANSMITTER_V2 @ GatewayError::BadCctpProgram)]
    pub message_transmitter_program: UncheckedAccount<'info>,
    /// CHECK: pinned id — the only program the store ever signs toward here
    #[account(address = CCTP_TOKEN_MESSENGER_MINTER_V2 @ GatewayError::BadCctpProgram)]
    pub token_messenger_minter_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: Circle's event authority PDA
    pub cctp_event_authority: UncheckedAccount<'info>,
}

impl Rebalance<'_> {
    pub fn apply(ctx: &mut Context<Rebalance>, label: u32, usdc: u64) -> Result<()> {
        let a = &ctx.accounts;
        a.store.require_operator(a.operator.key)?;
        require!(usdc > 0, GatewayError::ZeroAmount);
        require!(a.cctp_peer.label == label && a.cctp_peer.vault != [0u8; 32], GatewayError::NoCctpPeer);
        require!(a.vault.amount >= usdc, GatewayError::VaultShort);

        // deposit_for_burn(DepositForBurnParams { amount, destination_domain,
        // mint_recipient, destination_caller, max_fee, min_finality_threshold })
        let mut data = CCTP_DEPOSIT_FOR_BURN.to_vec();
        data.extend_from_slice(&usdc.to_le_bytes());
        data.extend_from_slice(&a.cctp_peer.domain.to_le_bytes());
        data.extend_from_slice(&a.cctp_peer.vault);
        data.extend_from_slice(&[0u8; 32]); // destination_caller: anyone
        data.extend_from_slice(&CCTP_MAX_FEE.to_le_bytes());
        data.extend_from_slice(&CCTP_MIN_FINALITY.to_le_bytes());

        let infos = [
            a.store.to_account_info(),
            a.operator.to_account_info(),
            a.sender_authority.to_account_info(),
            a.vault.to_account_info(),
            a.denylist_account.to_account_info(),
            a.message_transmitter.to_account_info(),
            a.token_messenger.to_account_info(),
            a.remote_token_messenger.to_account_info(),
            a.token_minter.to_account_info(),
            a.local_token.to_account_info(),
            a.usdc_mint.to_account_info(),
            a.message_sent_event_data.to_account_info(),
            a.message_transmitter_program.to_account_info(),
            a.token_messenger_minter_program.to_account_info(),
            a.token_program.to_account_info(),
            a.system_program.to_account_info(),
            a.cctp_event_authority.to_account_info(),
            a.token_messenger_minter_program.to_account_info(),
        ];
        let ro = |i: usize| AccountMeta::new_readonly(*infos[i].key, false);
        let rw = |i: usize| AccountMeta::new(*infos[i].key, false);
        let metas = vec![
            AccountMeta::new_readonly(*infos[0].key, true), // owner: the store, signed below
            AccountMeta::new(*infos[1].key, true),          // event_rent_payer
            ro(2),                                          // sender_authority_pda
            rw(3),                                          // burn_token_account: the vault
            ro(4),                                          // denylist_account
            rw(5),                                          // message_transmitter
            ro(6),                                          // token_messenger
            ro(7),                                          // remote_token_messenger
            ro(8),                                          // token_minter
            rw(9),                                          // local_token
            rw(10),                                         // burn_token_mint
            AccountMeta::new(*infos[11].key, true),         // message_sent_event_data
            ro(12),                                         // message_transmitter_program
            ro(13),                                         // token_messenger_minter_program
            ro(14),                                         // token_program
            ro(15),                                         // system_program
            ro(16),                                         // event_authority
            ro(17),                                         // program (event CPI)
        ];
        invoke_signed(
            &Instruction { program_id: CCTP_TOKEN_MESSENGER_MINTER_V2, accounts: metas, data },
            &infos,
            &[&[STORE_SEED, &[a.store.bump]]],
        )?;
        emit!(Rebalanced { label, domain: a.cctp_peer.domain, vault: a.cctp_peer.vault, usdc });
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
#[event]
pub struct OpenLegsSet {
    pub legs: u8,
}
#[event]
pub struct MoveLegsSet {
    pub dst_chain: u32,
    pub legs: u16,
}
#[event]
pub struct ReceiveTableSet {
    pub alt: Pubkey,
}
#[event]
pub struct CctpPeerSet {
    pub label: u32,
    pub domain: u32,
    pub vault: [u8; 32],
}
#[event]
pub struct Rebalanced {
    pub label: u32,
    pub domain: u32,
    pub vault: [u8; 32],
    pub usdc: u64,
}
