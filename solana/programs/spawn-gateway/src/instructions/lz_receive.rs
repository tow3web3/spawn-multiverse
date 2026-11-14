use crate::*;
use anchor_lang::{
    solana_program::{program::invoke, system_instruction},
    system_program,
};
use anchor_spl::{associated_token::get_associated_token_address, token};
use oapp::{
    endpoint::{cpi::accounts::Clear, instructions::ClearParams, ConstructCPIContext, ID as ENDPOINT_ID},
    LzReceiveParams,
};
use util::PayoutAccounts;

/// The executor (or anyone — a verified message is permissionless to
/// execute) delivers a hub message here.
///
/// NO LAMPORTS FROM THE CALLER, UNLESS THE MESSAGE BROUGHT THEM. The hub's
/// messages carry an executor option with gas only — the pad prepays no
/// reply, so the envelope's `value` is 0 — and LayerZero's executor refuses
/// an `lz_receive` that spends more of its SOL than that value. So nothing
/// here creates an account at the caller's expense: a delivery or a payout
/// lands in accounts its recipient opened (and paid for) when they sent, or
/// in the recipient's user account; an account the hub's message itself
/// calls for — a replica (SYNC), the user account of a recipient who never
/// came here (a PAYOUT of a claim moved from another chain) — is created out
/// of the program's own tank, and out of the caller only when the tank is
/// dry: the executor then declines, the packet stays verified, and it lands
/// as soon as the tank is refilled or anyone runs it and pays that rent.
/// Should a message ever arrive with a `value` (the same number the hub
/// adapter put in its executor option), that many lamports are taken from
/// the caller into the tank first — the mirror of the hub adapter's rule
/// that a delivery must bring what its sender paid for.
///
/// NOTHING THAT CAN BE REFUSED IS FAILED. Solana has no try/catch, so every
/// condition that could make a token CPI fail is checked first; what cannot
/// be settled is parked (tokens) or becomes a claim (dollars) — FOR ANY
/// 32-BYTE RECIPIENT (v7.2): the recipient of a moved claim is typed by a
/// user on another chain and need not be a wallet, hold a token account, or
/// have ever been seen here.
///
/// remaining_accounts layout:
///   [0 .. Clear::MIN_ACCOUNTS_LEN)  endpoint accounts for the clear() CPI
///                                   (ABSENT in test-sentinel mode — the
///                                   rest then starts at index 0)
///   [+0] gas_tank (mut)             the same two for every message
///   [+1] system_program
///   [+2 ..)                         op-specific accounts, see each handler
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

/// The accounts every hub message gets, whatever its op.
struct Common<'a, 'info> {
    payer: AccountInfo<'info>,
    tank: &'a AccountInfo<'info>,
    system_program: &'a AccountInfo<'info>,
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
        require!(ctx.remaining_accounts.len() >= clear_len + 2, GatewayError::AccountMismatch);
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

        let common = Common {
            payer: ctx.accounts.payer.to_account_info(),
            tank: &ctx.remaining_accounts[clear_len],
            system_program: &ctx.remaining_accounts[clear_len + 1],
        };
        let rest = &ctx.remaining_accounts[clear_len + 2..];

        // Unwrap the inter-transport envelope: the LZ-level peer is the hub
        // ADAPTER (checked above via PeerConfig); the envelope names the
        // PROTOCOL sender and target. Only the hub pad may speak to us, and
        // only messages addressed to this store are ours.
        let env = msg_codec::Envelope::decode(&params.message)?;
        require!(env.src_sender.0 == ctx.accounts.store.hub_pad, GatewayError::NotPeer);
        require!(env.dst_addr.pubkey() == store_key, GatewayError::NotPeer);

        // What the executor was asked to deliver WITH the message goes into
        // the tank (v7.2 envelope). The hub sends 0 today; a delivery that
        // names a value and does not bring it is turned away, like on the
        // hub, and stays executable by whoever brings it.
        if !env.value.is_zero() {
            let lamports = env
                .value
                .as_u128()
                .and_then(|v| u64::try_from(v).ok())
                .ok_or(GatewayError::AmountOverflow)?;
            util::check_tank(common.tank)?;
            require!(*common.system_program.key == system_program::ID, GatewayError::AccountMismatch);
            // (a tank that was emptied below its own rent floor cannot take
            // less than that floor — the runtime would fail the whole
            // delivery; the value then simply stays with the caller)
            if common.tank.lamports().saturating_add(lamports) >= Rent::get()?.minimum_balance(0) {
                invoke(
                    &system_instruction::transfer(common.payer.key, common.tank.key, lamports),
                    &[common.payer.clone(), common.tank.clone(), common.system_program.clone()],
                )?;
                emit!(ValueReceived { lamports });
            }
        }

        match SpawnMsg::decode(&env.payload)? {
            SpawnMsg::SyncToken { hub_token, name, symbol } => {
                handle_sync_token(ctx, &common, rest, hub_token, name, symbol)
            }
            SpawnMsg::Deliver { hub_token, to, tokens, refund } => {
                handle_deliver(ctx, &common, rest, hub_token, to, tokens, refund)
            }
            SpawnMsg::Payout { to, usd_out } => handle_payout(ctx, &common, rest, to, usd_out),
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

/// Whoever a hub message names, as far as this program is concerned: their
/// user account — WHERE WHAT CANNOT BE SETTLED ON THE SPOT IS KEPT — which
/// exists already for anyone who ever sent from here, and is created the
/// moment it is first needed for anyone else (a recipient chosen on another
/// chain). Its owner need not be a wallet: any 32 bytes have one address.
struct Recipient<'a, 'info> {
    key: Pubkey,
    info: &'a AccountInfo<'info>,
    common: &'a Common<'a, 'info>,
    bump: u8,
    user: Option<UserAccount>,
    dirty: bool,
}

impl<'a, 'info> Recipient<'a, 'info> {
    fn locate(common: &'a Common<'a, 'info>, info: &'a AccountInfo<'info>, key: &Pubkey) -> Result<Self> {
        let (user, bump) = util::locate_user(info, key)?;
        Ok(Self { key: *key, info, common, bump, user, dirty: false })
    }

    /// The user account, created now if it never was (rent: the tank).
    fn account(&mut self) -> Result<&mut UserAccount> {
        if self.user.is_none() {
            let rent_from_tank = util::create_from_tank(
                &self.common.payer,
                self.common.tank,
                self.common.system_program,
                self.info,
                &[USER_SEED, self.key.as_ref(), &[self.bump]],
                UserAccount::SIZE,
                &crate::ID,
            )?;
            emit!(UserAccountOpened { owner: self.key, rent_from_tank });
            self.user = Some(UserAccount { owner: self.key, bump: self.bump, usd_claim: 0, parked: Vec::new() });
        }
        self.dirty = true;
        Ok(self.user.as_mut().unwrap())
    }

    fn save(&self) -> Result<()> {
        match (&self.user, self.dirty) {
            (Some(user), true) => util::save(self.info, user),
            _ => Ok(()),
        }
    }
}

/// Dollars for a recipient: USDC when the transfer cannot fail, a claim
/// otherwise — never a failure because of who or what the recipient is.
fn settle<'info>(
    store: &mut Account<'info, Store>,
    accounts: &PayoutAccounts<'_, 'info>,
    recipient: &mut Recipient<'_, 'info>,
    units: u64,
) -> Result<()> {
    if units == 0 {
        return Ok(());
    }
    if util::try_pay_usdc(store, accounts, &recipient.key, units)? {
        emit!(PaidOut { to: recipient.key, usdc: units, claim: 0 });
        return Ok(());
    }
    util::book_claim(store, recipient.account()?, units)?;
    emit!(PaidOut { to: recipient.key, usdc: 0, claim: units });
    Ok(())
}

/// OP_SYNC_TOKEN — the replica entry and its SPL mint.
/// accounts: [replica(mut), mint(mut), token_program]
///
/// A replica is forever: a second SYNC for the same token is ignored. The
/// rent of both accounts comes from whoever opened the token here
/// (`open_token` leaves it at the two addresses), else from the tank; with a
/// dry tank it comes from the transaction's payer — LayerZero's executor
/// will not accept that (the message then simply waits, executable by
/// anyone willing to pay the rent, or by the executor once the tank is
/// refilled).
fn handle_sync_token<'info>(
    ctx: &mut Context<'_, '_, 'info, 'info, LzReceive<'info>>,
    common: &Common<'_, 'info>,
    rest: &'info [AccountInfo<'info>],
    hub_token: msg_codec::WireAddr,
    name: String,
    symbol: String,
) -> Result<()> {
    require!(rest.len() >= 3, GatewayError::AccountMismatch);
    let (replica_info, mint_info, tok) = (&rest[0], &rest[1], &rest[2]);
    let (tank, sys) = (common.tank, common.system_program);
    require!(*sys.key == system_program::ID, GatewayError::AccountMismatch);
    require!(*tok.key == token::ID, GatewayError::AccountMismatch);
    let tank_bump = util::check_tank(tank)?;

    if util::load_replica(replica_info, &hub_token.0)?.is_some() {
        emit!(SyncIgnored { hub_token: hub_token.0 });
        return Ok(());
    }
    let (_, replica_bump) = Pubkey::find_program_address(&[REPLICA_SEED, &hub_token.0], ctx.program_id);
    let (mint_pda, mint_bump) = Pubkey::find_program_address(&[MINT_SEED, &hub_token.0], ctx.program_id);
    require!(*mint_info.key == mint_pda, GatewayError::AccountMismatch);

    // who funds what the two addresses do not hold yet: the tank when it
    // can cover both accounts, the payer otherwise (never half of each)
    let rent = Rent::get()?;
    let need = rent
        .minimum_balance(Replica::SIZE)
        .saturating_sub(replica_info.lamports())
        .saturating_add(rent.minimum_balance(util::MINT_LEN).saturating_sub(mint_info.lamports()));
    let from_tank = util::tank_spendable(tank)? >= need;
    let tank_seeds: &[&[u8]] = &[GAS_TANK_SEED, &[tank_bump]];
    let (funder, funder_seeds) = if from_tank { (tank, Some(tank_seeds)) } else { (&common.payer, None) };

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
    emit!(ReplicaCreated { hub_token: hub_token.0, mint: mint_pda, rent_from_tank: from_tank && need > 0 });
    Ok(())
}

/// OP_DELIVER — a bag for `to`, and/or a refund of dollars (a buy the hub
/// clamped or refused — under its minimum, since v7.2 — comes home here; a
/// sale the hub refused comes back as its bag).
/// accounts: [replica(mut), mint(mut), recipient, recipient_token(mut),
///            user_account(mut), usdc_mint, vault(mut), recipient_usdc(mut),
///            token_program]
///
/// The bag is minted into the recipient's own token account (they created
/// it when they bought). If the replica is not here yet (delivery is
/// unordered: a DELIVER can beat the SYNC that creates it; a chain the hub
/// left out of a launch has none until the token is opened), or that token
/// account is gone, the bag is PARKED in the recipient's user account, to
/// the wei, and claimed later with `claim_parked`. The refund settles like
/// every payout.
fn handle_deliver<'info>(
    ctx: &mut Context<'_, '_, 'info, 'info, LzReceive<'info>>,
    common: &Common<'_, 'info>,
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
    let mut who = Recipient::locate(common, user_info, recipient.key)?;

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
            who.account()?.park(hub_token.0, amount_e18)?;
            emit!(DeliveryParked { hub_token: hub_token.0, to: *recipient.key, amount_e18 });
        }
    }

    if !refund.is_zero() {
        let (units, dust) = refund.split_spl()?;
        let store = &mut ctx.accounts.store;
        store.usd_dust_e18 = store.usd_dust_e18.saturating_add(dust);
        let accounts = PayoutAccounts { usdc_mint, vault, recipient_usdc, token_program: tok };
        settle(store, &accounts, &mut who, units)?;
    }
    who.save()
}

/// OP_PAYOUT — dollars for `to`: a sale's proceeds, a dev claim, a refused
/// buy — and, since v7.2, a claim MOVED here from another chain for a
/// recipient its sender chose, or coming home.
/// accounts: [recipient, user_account(mut), usdc_mint, vault(mut),
///            recipient_usdc(mut), token_program]
///
/// USDC when the vault holds it and the recipient's own USDC account can
/// take it; a claim in the recipient's user account in EVERY other case —
/// that account is created here if the recipient never had one.
fn handle_payout<'info>(
    ctx: &mut Context<'_, '_, 'info, 'info, LzReceive<'info>>,
    common: &Common<'_, 'info>,
    rest: &'info [AccountInfo<'info>],
    to: msg_codec::WireAddr,
    usd_out: msg_codec::U256,
) -> Result<()> {
    require!(rest.len() >= 6, GatewayError::AccountMismatch);
    let (recipient, user_info, usdc_mint, vault, recipient_usdc, tok) =
        (&rest[0], &rest[1], &rest[2], &rest[3], &rest[4], &rest[5]);
    check_recipient(&to, recipient.key)?;
    let mut who = Recipient::locate(common, user_info, recipient.key)?;

    let (units, dust) = usd_out.split_spl()?;
    let store = &mut ctx.accounts.store;
    store.usd_dust_e18 = store.usd_dust_e18.saturating_add(dust);
    let accounts = PayoutAccounts { usdc_mint, vault, recipient_usdc, token_program: tok };
    settle(store, &accounts, &mut who, units)?;
    who.save()
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
/// A hub message created the user account of a recipient who had none.
#[event]
pub struct UserAccountOpened {
    pub owner: Pubkey,
    pub rent_from_tank: bool,
}
/// Lamports a hub message arrived with, now in the tank.
#[event]
pub struct ValueReceived {
    pub lamports: u64,
}
