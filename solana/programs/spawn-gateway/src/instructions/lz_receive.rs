use crate::*;
use anchor_lang::{
    solana_program::{program::invoke_signed, system_instruction},
    system_program,
};
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::{
    associated_token::{self, get_associated_token_address},
    token::{self, spl_token},
};
use oapp::{
    endpoint::{cpi::accounts::Clear, instructions::ClearParams, ConstructCPIContext, ID as ENDPOINT_ID},
    LzReceiveParams,
};

/// The executor (or a test) delivers a verified hub message here.
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

        // Replay protection FIRST: burn the nonce at the endpoint before any
        // state changes. Skipped only under the explicit test sentinel
        // (endpoint_program == default), where no endpoint program exists.
        let test_mode = ctx.accounts.store.endpoint_program == Pubkey::default();
        let clear_len = if test_mode { 0 } else { Clear::MIN_ACCOUNTS_LEN };
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
        match SpawnMsg::decode(&params.message)? {
            SpawnMsg::SyncToken { hub_token, name, symbol } => {
                handle_sync_token(ctx, rest, hub_token, name, symbol)
            }
            SpawnMsg::Deliver { hub_token, to, tokens, refund } => {
                handle_deliver(ctx, rest, hub_token, to, tokens, refund)
            }
            SpawnMsg::Payout { to, usd_out } => handle_payout(ctx, rest, to, usd_out),
            SpawnMsg::FeeDrop { hub_token, amount } => {
                handle_fee_drop(ctx, rest, hub_token, amount)
            }
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

/// accounts: [replica(mut), mint(mut), system_program, token_program]
fn handle_sync_token<'info>(
    ctx: &Context<'_, '_, 'info, 'info, LzReceive<'info>>,
    rest: &[AccountInfo<'info>],
    hub_token: msg_codec::WireAddr,
    name: String,
    symbol: String,
) -> Result<()> {
    require!(rest.len() >= 4, GatewayError::AccountMismatch);
    let (replica_info, mint_info, sys_info, token_info) = (&rest[0], &rest[1], &rest[2], &rest[3]);
    require!(*sys_info.key == system_program::ID, GatewayError::AccountMismatch);
    require!(*token_info.key == token::ID, GatewayError::AccountMismatch);

    let payer = ctx.accounts.payer.to_account_info();
    let store_key = ctx.accounts.store.key();
    let rent = Rent::get()?;

    // replica registry PDA, owned by this program
    let (replica_pda, replica_bump) =
        Pubkey::find_program_address(&[REPLICA_SEED, &hub_token.0], ctx.program_id);
    require!(*replica_info.key == replica_pda, GatewayError::AccountMismatch);
    if replica_info.data_is_empty() {
        invoke_signed(
            &system_instruction::create_account(
                payer.key,
                &replica_pda,
                rent.minimum_balance(Replica::SIZE),
                Replica::SIZE as u64,
                ctx.program_id,
            ),
            &[payer.clone(), replica_info.clone(), sys_info.clone()],
            &[&[REPLICA_SEED, &hub_token.0, &[replica_bump]]],
        )?;
    } else {
        return Ok(()); // already synced — a replayed sync is a no-op
    }

    // replica SPL mint PDA, authority = store
    let (mint_pda, mint_bump) =
        Pubkey::find_program_address(&[MINT_SEED, &hub_token.0], ctx.program_id);
    require!(*mint_info.key == mint_pda, GatewayError::AccountMismatch);
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            &mint_pda,
            rent.minimum_balance(spl_token::state::Mint::LEN),
            spl_token::state::Mint::LEN as u64,
            &token::ID,
        ),
        &[payer.clone(), mint_info.clone(), sys_info.clone()],
        &[&[MINT_SEED, &hub_token.0, &[mint_bump]]],
    )?;
    token::initialize_mint2(
        CpiContext::new(token_info.clone(), token::InitializeMint2 { mint: mint_info.clone() }),
        SPL_DECIMALS,
        &store_key,
        None,
    )?;

    let replica = Replica {
        hub_token: hub_token.0,
        mint: mint_pda,
        name: clip(&name, Replica::MAX_NAME),
        symbol: clip(&symbol, Replica::MAX_SYMBOL),
        bump: replica_bump,
    };
    replica.try_serialize(&mut &mut replica_info.try_borrow_mut_data()?[..])?;
    Ok(())
}

/// Validates the replica registry entry and its mint, as passed in accounts.
fn load_replica<'info>(
    program_id: &Pubkey,
    replica_info: &AccountInfo<'info>,
    hub_token: &msg_codec::WireAddr,
) -> Result<Replica> {
    require!(replica_info.owner == program_id, GatewayError::NoReplica);
    let replica = Replica::try_deserialize(&mut &replica_info.try_borrow_data()?[..])?;
    require!(replica.hub_token == hub_token.0, GatewayError::AccountMismatch);
    Ok(replica)
}

/// Mints `amount` of `mint` (authority = store PDA) into the recipient's
/// ATA, creating the ATA if needed (payer funds the rent).
#[allow(clippy::too_many_arguments)]
fn mint_into_ata<'info>(
    payer: &AccountInfo<'info>,
    mint_info: &AccountInfo<'info>,
    owner_info: &AccountInfo<'info>,
    ata_info: &AccountInfo<'info>,
    store_info: &AccountInfo<'info>,
    sys_info: &AccountInfo<'info>,
    token_info: &AccountInfo<'info>,
    ata_prog_info: &AccountInfo<'info>,
    store_bump: u8,
    amount: u64,
) -> Result<()> {
    require!(
        *ata_info.key == get_associated_token_address(owner_info.key, mint_info.key),
        GatewayError::AccountMismatch
    );
    require!(*ata_prog_info.key == associated_token::ID, GatewayError::AccountMismatch);
    // CreateIdempotent is a private alias of Create in anchor-spl 0.31
    associated_token::create_idempotent(CpiContext::new(
        ata_prog_info.clone(),
        associated_token::Create {
            payer: payer.clone(),
            associated_token: ata_info.clone(),
            authority: owner_info.clone(),
            mint: mint_info.clone(),
            system_program: sys_info.clone(),
            token_program: token_info.clone(),
        },
    ))?;
    if amount > 0 {
        token::mint_to(
            CpiContext::new_with_signer(
                token_info.clone(),
                token::MintTo {
                    mint: mint_info.clone(),
                    to: ata_info.clone(),
                    authority: store_info.clone(),
                },
                &[&[STORE_SEED, &[store_bump]]],
            ),
            amount,
        )?;
    }
    Ok(())
}

/// accounts: [replica, mint(mut), recipient, recipient_ata(mut), usd_mint(mut),
///            recipient_usd_ata(mut), system_program, token_program, ata_program]
fn handle_deliver<'info>(
    ctx: &Context<'_, '_, 'info, 'info, LzReceive<'info>>,
    rest: &[AccountInfo<'info>],
    hub_token: msg_codec::WireAddr,
    to: msg_codec::WireAddr,
    tokens: msg_codec::U256,
    refund: msg_codec::U256,
) -> Result<()> {
    require!(rest.len() >= 9, GatewayError::AccountMismatch);
    let replica = load_replica(ctx.program_id, &rest[0], &hub_token)?;
    let (mint, recipient, ata, usd_mint, usd_ata) = (&rest[1], &rest[2], &rest[3], &rest[4], &rest[5]);
    let (sys, tok, ata_prog) = (&rest[6], &rest[7], &rest[8]);
    require!(*mint.key == replica.mint, GatewayError::AccountMismatch);
    require!(*usd_mint.key == ctx.accounts.store.usd_mint, GatewayError::AccountMismatch);
    check_recipient(&to, recipient.key)?;

    let payer = ctx.accounts.payer.to_account_info();
    let store_info = ctx.accounts.store.to_account_info();
    let bump = ctx.accounts.store.bump;
    mint_into_ata(&payer, mint, recipient, ata, &store_info, sys, tok, ata_prog, bump, tokens.to_spl_amount()?)?;
    if !refund.is_zero() {
        mint_into_ata(&payer, usd_mint, recipient, usd_ata, &store_info, sys, tok, ata_prog, bump, refund.to_spl_amount()?)?;
    }
    Ok(())
}

/// accounts: [recipient, usd_mint(mut), recipient_usd_ata(mut),
///            system_program, token_program, ata_program]
fn handle_payout<'info>(
    ctx: &Context<'_, '_, 'info, 'info, LzReceive<'info>>,
    rest: &[AccountInfo<'info>],
    to: msg_codec::WireAddr,
    usd_out: msg_codec::U256,
) -> Result<()> {
    require!(rest.len() >= 6, GatewayError::AccountMismatch);
    let (recipient, usd_mint, usd_ata) = (&rest[0], &rest[1], &rest[2]);
    let (sys, tok, ata_prog) = (&rest[3], &rest[4], &rest[5]);
    require!(*usd_mint.key == ctx.accounts.store.usd_mint, GatewayError::AccountMismatch);
    check_recipient(&to, recipient.key)?;

    let payer = ctx.accounts.payer.to_account_info();
    let store_info = ctx.accounts.store.to_account_info();
    let bump = ctx.accounts.store.bump;
    mint_into_ata(&payer, usd_mint, recipient, usd_ata, &store_info, sys, tok, ata_prog, bump, usd_out.to_spl_amount()?)
}

/// accounts: [replica, usd_mint(mut), store_usd_ata(mut),
///            system_program, token_program, ata_program]
///
/// Phase 2a parks the holder slice in the store's own oUSD ATA; the Solana
/// FeeDistributor (phase 3) will take over this flow.
fn handle_fee_drop<'info>(
    ctx: &Context<'_, '_, 'info, 'info, LzReceive<'info>>,
    rest: &[AccountInfo<'info>],
    hub_token: msg_codec::WireAddr,
    amount: msg_codec::U256,
) -> Result<()> {
    require!(rest.len() >= 6, GatewayError::AccountMismatch);
    let _ = load_replica(ctx.program_id, &rest[0], &hub_token)?;
    let (usd_mint, vault_ata) = (&rest[1], &rest[2]);
    let (sys, tok, ata_prog) = (&rest[3], &rest[4], &rest[5]);
    require!(*usd_mint.key == ctx.accounts.store.usd_mint, GatewayError::AccountMismatch);

    let payer = ctx.accounts.payer.to_account_info();
    let store_info = ctx.accounts.store.to_account_info();
    let bump = ctx.accounts.store.bump;
    mint_into_ata(&payer, usd_mint, &store_info, vault_ata, &store_info, sys, tok, ata_prog, bump, amount.to_spl_amount()?)
}
