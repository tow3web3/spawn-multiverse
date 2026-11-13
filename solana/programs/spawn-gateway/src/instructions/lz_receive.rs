use crate::*;
use anchor_lang::system_program;
use anchor_spl::{associated_token::get_associated_token_address, token};
use oapp::{
    endpoint::{cpi::accounts::Clear, instructions::ClearParams, ConstructCPIContext, ID as ENDPOINT_ID},
    LzReceiveParams,
};
use util::{PayoutAccounts, Paid};

/// The executor (or anyone — a verified message is permissionless to
/// execute) delivers a hub message here.
///
/// NO LAMPORTS FROM THE CALLER. The hub's messages carry an executor option
/// with gas only — its `value` is always zero, fixed in an immutable
/// contract — and LayerZero's executor refuses an `lz_receive` that spends
/// more of its SOL than that value. So nothing here creates an account at
/// the caller's expense: a delivery or a payout lands in accounts its
/// recipient opened (and paid for) when they sent, or is parked in the
/// recipient's user account; only a SYNC creates accounts, out of the
/// program's own tank — and falls back to the caller only when the tank is
/// dry, which the executor will decline and a user may accept.
///
/// NOTHING THAT CAN BE REFUSED IS FAILED. Solana has no try/catch, so every
/// condition that could make a token CPI fail is checked first; what cannot
/// be settled is parked (tokens) or becomes a claim (dollars).
///
/// remaining_accounts layout:
///   [0 .. Clear::MIN_ACCOUNTS_LEN)  endpoint accounts for the clear() CPI
///                                   (ABSENT in test-sentinel mode — the
///                                   op accounts then start at index 0)
///   [clear_len ..)                  op-specific accounts, see each handler
#[derive(Accounts)]
#[instruction(params: LzReceiveParams)]
pub struct LzReceive<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    /// Only the configured hub peer may speak to this gateway.
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &params.src_eid.to_be_bytes()],
        bump = peer.bump,
        constraint = params.sender == peer.peer_address @ GatewayError::NotPeer
    )]
    pub peer: Account<'info, PeerConfig>,
}

impl<'info> LzReceive<'info> {
    pub fn apply(
        ctx: &mut Context<'_, '_, 'info, 'info, LzReceive<'info>>,
        params: &LzReceiveParams,
    ) -> Result<()> {
        let store_key = ctx.accounts.store.key();
        let store_bump = ctx.accounts.store.bump;
        let seeds: &[&[u8]] = &[STORE_SEED, &[store_bump]];
        // only the hub chain speaks to a spoke
        require!(params.src_eid == ctx.accounts.store.hub_eid, GatewayError::NotPeer);

        // Replay protection FIRST: burn the nonce at the endpoint before any
        // state changes. Skipped only under the explicit test sentinel
        // (endpoint_program == default), where no endpoint program exists.
        let test_mode = ctx.accounts.store.endpoint_program == Pubkey::default();
        let clear_len = if test_mode { 0 } else { Clear::MIN_ACCOUNTS_LEN };
        require!(ctx.remaining_accounts.len() >= clear_len, GatewayError::AccountMismatch);
        if !test_mode {
            let accounts_for_clear = &ctx.remaining_accounts[0..clear_len];
            let _ = oapp::endpoint_cpi::clear(
                ENDPOINT_ID,
                store_key,
                accounts_for_clear,
                seeds,
                ClearParams {
                    receiver: store_key,
                    src_eid: params.src_eid,
                    sender: params.sender,
                    nonce: params.nonce,
                    guid: params.guid,
                    message: params.message.clone(),
                },
            )?;
        }

        let rest = &ctx.remaining_accounts[clear_len..];

        // Unwrap the inter-transport envelope (v5): the LZ-level peer is the
        // hub ADAPTER (checked above via PeerConfig); the envelope names the
        // PROTOCOL sender and target. Only the hub pad may speak to us, and
        // only messages addressed to this store are ours.
        let env = msg_codec::Envelope::decode(&params.message)?;
        require!(env.src_sender.0 == ctx.accounts.store.hub_pad, GatewayError::NotPeer);
        require!(env.dst_addr.pubkey() == store_key, GatewayError::NotPeer);

        match SpawnMsg::decode(&env.payload)? {
            SpawnMsg::SyncToken { hub_token, name, symbol } => {
                handle_sync_token(ctx, rest, hub_token, name, symbol)
            }
            SpawnMsg::Deliver { hub_token, to, tokens, refund } => {
                handle_deliver(ctx, rest, hub_token, to, tokens, refund)
            }
            SpawnMsg::Payout { to, usd_out } => handle_payout(ctx, rest, to, usd_out),
            SpawnMsg::FeeDrop { hub_token, amount } => handle_fee_drop(ctx, rest, hub_token, amount),
            // Spoke→hub ops can never arrive at a spoke.
            _ => Err(GatewayError::UnknownOp.into()),
        }
    }
}

/// Clip to a byte budget on a char boundary — a hub token name is data, not
/// a reason to brick the sync.
fn clip(s: &str, max: usize) -> String {
    let mut end = s.len().min(max);
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Wire riders are bytes32 (protocol v4): a Solana recipient IS the 32-byte
/// value — the supplied recipient account must match it exactly.
fn check_recipient(to: &msg_codec::WireAddr, recipient: &Pubkey) -> Result<()> {
    require!(to.0 == recipient.to_bytes(), GatewayError::RecipientMismatch);
    Ok(())
}

/// OP_SYNC_TOKEN — the replica entry and its SPL mint.
/// accounts: [replica(mut), mint(mut), gas_tank(mut), system_program, token_program]
///
/// A replica is forever: a second SYNC for the same token is ignored. The
/// rent (~0.0036 SOL for both accounts) comes from the tank; with a dry
/// tank it comes from the transaction's payer — LayerZero's executor will
/// not accept that (the message then simply waits, executable by anyone
/// willing to pay the rent, or by the executor once the tank is refilled).
fn handle_sync_token<'info>(
    ctx: &mut Context<'_, '_, 'info, 'info, LzReceive<'info>>,
    rest: &'info [AccountInfo<'info>],
    hub_token: msg_codec::WireAddr,
    name: String,
    symbol: String,
) -> Result<()> {
    require!(rest.len() >= 5, GatewayError::AccountMismatch);
    let (replica_info, mint_info, tank, sys, tok) = (&rest[0], &rest[1], &rest[2], &rest[3], &rest[4]);
    require!(*sys.key == system_program::ID, GatewayError::AccountMismatch);
    require!(*tok.key == token::ID, GatewayError::AccountMismatch);
    let (tank_pda, tank_bump) = Pubkey::find_program_address(&[GAS_TANK_SEED], ctx.program_id);
    require!(*tank.key == tank_pda, GatewayError::AccountMismatch);

    if util::load_replica(replica_info, &hub_token.0)?.is_some() {
        emit!(SyncIgnored { hub_token: hub_token.0 });
        return Ok(());
    }
    let (_, replica_bump) = Pubkey::find_program_address(&[REPLICA_SEED, &hub_token.0], ctx.program_id);
    let (mint_pda, mint_bump) = Pubkey::find_program_address(&[MINT_SEED, &hub_token.0], ctx.program_id);
    require!(*mint_info.key == mint_pda, GatewayError::AccountMismatch);

    // who funds the rent: the tank when it can cover both accounts
    let rent = Rent::get()?;
    let need = rent
        .minimum_balance(Replica::SIZE)
        .saturating_sub(replica_info.lamports())
        .saturating_add(rent.minimum_balance(util::MINT_LEN).saturating_sub(mint_info.lamports()));
    let from_tank = util::tank_spendable(tank)? >= need;
    let payer = ctx.accounts.payer.to_account_info();
    let tank_seeds: &[&[u8]] = &[GAS_TANK_SEED, &[tank_bump]];
    let (funder, funder_seeds) = if from_tank { (tank, Some(tank_seeds)) } else { (&payer, None) };

    util::create_pda_account(
        funder,
        funder_seeds,
        replica_info,
        &[REPLICA_SEED, &hub_token.0, &[replica_bump]],
        Replica::SIZE,
        ctx.program_id,
        sys,
    )?;
    util::create_pda_account(
        funder,
        funder_seeds,
        mint_info,
        &[MINT_SEED, &hub_token.0, &[mint_bump]],
        util::MINT_LEN,
        &token::ID,
        sys,
    )?;
    // the store is the only mint authority; no freeze authority, ever
    token::initialize_mint2(
        CpiContext::new(tok.clone(), token::InitializeMint2 { mint: mint_info.clone() }),
        SPL_DECIMALS,
        &ctx.accounts.store.key(),
        None,
    )?;

    let replica = Replica {
        hub_token: hub_token.0,
        mint: mint_pda,
        bump: replica_bump,
        name: clip(&name, MAX_NAME_BYTES),
        symbol: clip(&symbol, MAX_SYMBOL_BYTES),
        dust_carry: 0,
        staked_total: 0,
        acc_per_share: 0,
        pending_fees: 0,
    };
    util::save(replica_info, &replica)?;
    emit!(ReplicaCreated { hub_token: hub_token.0, mint: mint_pda, rent_from_tank: from_tank });
    Ok(())
}

/// OP_DELIVER — a bag for `to`, and/or a refund of dollars.
/// accounts: [replica(mut), mint(mut), recipient, recipient_token(mut),
///            user_account(mut), usdc_mint, vault(mut), recipient_usdc(mut),
///            token_program]
///
/// The bag is minted into the recipient's own token account (they created
/// it when they bought). If the replica is not here yet (delivery is
/// unordered: a DELIVER can beat the SYNC that creates it), or that token
/// account is gone, the bag is PARKED in the recipient's user account, to
/// the wei, and claimed later with `claim_parked`. The refund settles like
/// every payout.
fn handle_deliver<'info>(
    ctx: &mut Context<'_, '_, 'info, 'info, LzReceive<'info>>,
    rest: &'info [AccountInfo<'info>],
    hub_token: msg_codec::WireAddr,
    to: msg_codec::WireAddr,
    tokens: msg_codec::U256,
    refund: msg_codec::U256,
) -> Result<()> {
    require!(rest.len() >= 9, GatewayError::AccountMismatch);
    let (replica_info, mint, recipient, recipient_token, user_info) =
        (&rest[0], &rest[1], &rest[2], &rest[3], &rest[4]);
    let (usdc_mint, vault, recipient_usdc, tok) = (&rest[5], &rest[6], &rest[7], &rest[8]);
    require!(*tok.key == token::ID, GatewayError::AccountMismatch);
    check_recipient(&to, recipient.key)?;

    let mut user = util::load_user(user_info, recipient.key)?;
    let mut user_dirty = false;

    if !tokens.is_zero() {
        let amount_e18 = tokens.as_u128().ok_or(GatewayError::AmountOverflow)?;
        let mut minted = false;
        if let Some(mut replica) = util::load_replica(replica_info, &hub_token.0)? {
            require!(*mint.key == replica.mint, GatewayError::AccountMismatch);
            let ata_ok = *recipient_token.key == get_associated_token_address(recipient.key, &replica.mint)
                && util::token_account_ok(recipient_token, &replica.mint, recipient.key);
            if ata_ok {
                let units = replica.take_units(amount_e18)?;
                util::mint_replica(&ctx.accounts.store, mint, recipient_token, tok, units)?;
                util::save(replica_info, &replica)?;
                minted = true;
                emit!(Delivered { hub_token: hub_token.0, to: *recipient.key, units });
            }
        }
        if !minted {
            let u = user.as_mut().ok_or(GatewayError::NoUserAccount)?;
            u.park(hub_token.0, amount_e18)?;
            user_dirty = true;
            emit!(DeliveryParked { hub_token: hub_token.0, to: *recipient.key, amount_e18 });
        }
    }

    if !refund.is_zero() {
        let (units, dust) = refund.split_spl()?;
        let store = &mut ctx.accounts.store;
        store.usd_dust_e18 = store.usd_dust_e18.saturating_add(dust);
        let accounts = PayoutAccounts { usdc_mint, vault, recipient_usdc, token_program: tok };
        match util::pay_usdc(store, &accounts, recipient.key, user.as_mut(), units)? {
            Paid::Usdc(n) => emit!(PaidOut { to: *recipient.key, usdc: n, claim: 0 }),
            Paid::Claim(n) => {
                user_dirty = true;
                emit!(PaidOut { to: *recipient.key, usdc: 0, claim: n });
            }
            Paid::Nothing => {}
        }
    }

    if user_dirty {
        util::save(user_info, user.as_ref().unwrap())?;
    }
    Ok(())
}

/// OP_PAYOUT — dollars for `to` (a sell, a dev claim, a refused buy).
/// accounts: [recipient, user_account(mut), usdc_mint, vault(mut),
///            recipient_usdc(mut), token_program]
fn handle_payout<'info>(
    ctx: &mut Context<'_, '_, 'info, 'info, LzReceive<'info>>,
    rest: &'info [AccountInfo<'info>],
    to: msg_codec::WireAddr,
    usd_out: msg_codec::U256,
) -> Result<()> {
    require!(rest.len() >= 6, GatewayError::AccountMismatch);
    let (recipient, user_info, usdc_mint, vault, recipient_usdc, tok) =
        (&rest[0], &rest[1], &rest[2], &rest[3], &rest[4], &rest[5]);
    check_recipient(&to, recipient.key)?;

    let mut user = util::load_user(user_info, recipient.key)?;
    let (units, dust) = usd_out.split_spl()?;
    let store = &mut ctx.accounts.store;
    store.usd_dust_e18 = store.usd_dust_e18.saturating_add(dust);
    let accounts = PayoutAccounts { usdc_mint, vault, recipient_usdc, token_program: tok };
    match util::pay_usdc(store, &accounts, recipient.key, user.as_mut(), units)? {
        Paid::Usdc(n) => emit!(PaidOut { to: *recipient.key, usdc: n, claim: 0 }),
        Paid::Claim(n) => {
            util::save(user_info, user.as_ref().unwrap())?;
            emit!(PaidOut { to: *recipient.key, usdc: 0, claim: n });
        }
        Paid::Nothing => {}
    }
    Ok(())
}

/// OP_FEE_DROP — this chain's slice of a token's holder fees.
/// accounts: [replica(mut)]
///
/// Pure bookkeeping: the dollars are already in the vaults (the hub burned
/// its ledger entry); the slice is credited to the token's pool, where
/// stakers earn it. A drop is only ever the reply to a `pull_fees` from
/// this chain, which requires the replica — so a missing replica is a
/// hub-side impossibility, and fails (retryable) rather than lose a slice.
fn handle_fee_drop<'info>(
    ctx: &mut Context<'_, '_, 'info, 'info, LzReceive<'info>>,
    rest: &'info [AccountInfo<'info>],
    hub_token: msg_codec::WireAddr,
    amount: msg_codec::U256,
) -> Result<()> {
    require!(!rest.is_empty(), GatewayError::AccountMismatch);
    let replica_info = &rest[0];
    let mut replica = util::load_replica(replica_info, &hub_token.0)?.ok_or(GatewayError::NoReplica)?;
    let (units, dust) = amount.split_spl()?;
    let store = &mut ctx.accounts.store;
    store.usd_dust_e18 = store.usd_dust_e18.saturating_add(dust);
    store.pool_total = store.pool_total.checked_add(units).ok_or(GatewayError::AmountOverflow)?;
    replica.fold(units);
    util::save(replica_info, &replica)?;
    emit!(FeeDropped { hub_token: hub_token.0, usdc: units, folded: replica.pending_fees == 0 });
    Ok(())
}

#[event]
pub struct ReplicaCreated {
    pub hub_token: [u8; 32],
    pub mint: Pubkey,
    pub rent_from_tank: bool,
}
#[event]
pub struct SyncIgnored {
    pub hub_token: [u8; 32],
}
#[event]
pub struct Delivered {
    pub hub_token: [u8; 32],
    pub to: Pubkey,
    pub units: u64,
}
#[event]
pub struct DeliveryParked {
    pub hub_token: [u8; 32],
    pub to: Pubkey,
    pub amount_e18: u128,
}
/// A dollar payout: `usdc` left the vault, or `claim` was recorded instead.
#[event]
pub struct PaidOut {
    pub to: Pubkey,
    pub usdc: u64,
    pub claim: u64,
}
#[event]
pub struct FeeDropped {
    pub hub_token: [u8; 32],
    pub usdc: u64,
    pub folded: bool,
}
