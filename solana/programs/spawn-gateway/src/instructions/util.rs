//! Shared plumbing: raw SPL token-account reads, rent-funded PDA creation,
//! and the one way dollars leave the vault.
//!
//! Solana has no try/catch: a CPI that fails takes the whole transaction —
//! and with it the hub message being delivered — down. So everything that
//! could make a payout fail is CHECKED FIRST, and a payout that cannot be
//! made becomes a claim instead (the EVM gateways' `OmniUSD.payout` rule).

use crate::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use anchor_spl::token;

/// SPL token account layout (165 bytes): mint 0..32, owner 32..64, amount
/// 64..72, state at 108 (1 = initialized, 2 = frozen).
pub const TOKEN_ACCOUNT_LEN: usize = 165;

/// True when `info` is a live, unfrozen SPL token account of `mint` owned
/// by `owner` — i.e. a transfer or mint into it cannot fail.
pub fn token_account_ok(info: &AccountInfo, mint: &Pubkey, owner: &Pubkey) -> bool {
    if info.owner != &token::ID {
        return false;
    }
    let Ok(data) = info.try_borrow_data() else { return false };
    data.len() == TOKEN_ACCOUNT_LEN
        && data[0..32] == mint.to_bytes()
        && data[32..64] == owner.to_bytes()
        && data[108] == 1
}

pub fn token_amount(info: &AccountInfo) -> u64 {
    let Ok(data) = info.try_borrow_data() else { return 0 };
    if data.len() < 72 {
        return 0;
    }
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

/// Reads a program account from a raw AccountInfo (owner + discriminator
/// checked).
pub fn load<T: AccountDeserialize>(info: &AccountInfo) -> Result<T> {
    require!(info.owner == &crate::ID, GatewayError::AccountMismatch);
    T::try_deserialize(&mut &info.try_borrow_data()?[..])
}

pub fn save<T: AccountSerialize>(info: &AccountInfo, value: &T) -> Result<()> {
    value.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])
}

/// The replica entry for `hub_token`, or None when it was never synced.
pub fn load_replica(info: &AccountInfo, hub_token: &[u8; 32]) -> Result<Option<Replica>> {
    let (pda, _) = Pubkey::find_program_address(&[REPLICA_SEED, hub_token], &crate::ID);
    require!(*info.key == pda, GatewayError::AccountMismatch);
    if info.owner != &crate::ID || info.data_is_empty() {
        return Ok(None);
    }
    let replica: Replica = load(info)?;
    require!(replica.hub_token == *hub_token, GatewayError::AccountMismatch);
    Ok(Some(replica))
}

/// The user account of `owner`, or None when it does not exist yet.
pub fn load_user(info: &AccountInfo, owner: &Pubkey) -> Result<Option<UserAccount>> {
    Ok(locate_user(info, owner)?.0)
}

/// The same, with the bump of the address — what creating it needs.
pub fn locate_user(info: &AccountInfo, owner: &Pubkey) -> Result<(Option<UserAccount>, u8)> {
    let (pda, bump) = Pubkey::find_program_address(&[USER_SEED, owner.as_ref()], &crate::ID);
    require!(*info.key == pda, GatewayError::AccountMismatch);
    if info.owner != &crate::ID || info.data_is_empty() {
        return Ok((None, bump));
    }
    Ok((Some(load(info)?), bump))
}

/// The tank's address, checked; returns its bump.
pub fn check_tank(tank: &AccountInfo) -> Result<u8> {
    let (pda, bump) = Pubkey::find_program_address(&[GAS_TANK_SEED], &crate::ID);
    require!(*tank.key == pda, GatewayError::AccountMismatch);
    Ok(bump)
}

/// Creates a program account for a hub message that has nobody to charge:
/// out of the tank when it holds the rent, otherwise out of the
/// transaction's payer (LayerZero's executor declines that unless the
/// message brought the lamports; anyone else may accept it). Returns true
/// when the tank paid.
pub fn create_from_tank<'info>(
    payer: &AccountInfo<'info>,
    tank: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    new_account: &AccountInfo<'info>,
    new_seeds: &[&[u8]],
    space: usize,
    owner: &Pubkey,
) -> Result<bool> {
    require!(*system_program.key == anchor_lang::system_program::ID, GatewayError::AccountMismatch);
    let tank_bump = check_tank(tank)?;
    let need = Rent::get()?.minimum_balance(space).saturating_sub(new_account.lamports());
    let from_tank = tank_spendable(tank)? >= need;
    let tank_seeds: &[&[u8]] = &[GAS_TANK_SEED, &[tank_bump]];
    let (funder, funder_seeds) = if from_tank { (tank, Some(tank_seeds)) } else { (payer, None) };
    create_pda_account(funder, funder_seeds, new_account, new_seeds, space, owner, system_program)?;
    Ok(from_tank)
}

/// Creates a PDA-addressed account of `space` bytes owned by `owner`,
/// funded by `funder`. Works even if someone pre-funded the address (a
/// plain `create_account` would fail on it forever): top up, allocate,
/// assign.
pub fn create_pda_account<'info>(
    funder: &AccountInfo<'info>,
    funder_seeds: Option<&[&[u8]]>,
    new_account: &AccountInfo<'info>,
    new_seeds: &[&[u8]],
    space: usize,
    owner: &Pubkey,
    system_program: &AccountInfo<'info>,
) -> Result<()> {
    let need = Rent::get()?.minimum_balance(space);
    let have = new_account.lamports();
    let mut signers: Vec<&[&[u8]]> = vec![new_seeds];
    if let Some(s) = funder_seeds {
        signers.push(s);
    }
    if have == 0 {
        invoke_signed(
            &system_instruction::create_account(funder.key, new_account.key, need, space as u64, owner),
            &[funder.clone(), new_account.clone(), system_program.clone()],
            &signers,
        )?;
        return Ok(());
    }
    if have < need {
        invoke_signed(
            &system_instruction::transfer(funder.key, new_account.key, need - have),
            &[funder.clone(), new_account.clone(), system_program.clone()],
            &signers,
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(new_account.key, space as u64),
        &[new_account.clone(), system_program.clone()],
        &[new_seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(new_account.key, owner),
        &[new_account.clone(), system_program.clone()],
        &[new_seeds],
    )?;
    Ok(())
}

/// What the tank can spend without dropping below its own rent floor.
pub fn tank_spendable(tank: &AccountInfo) -> Result<u64> {
    Ok(tank.lamports().saturating_sub(Rent::get()?.minimum_balance(0)))
}

/// The accounts a dollar payout needs.
pub struct PayoutAccounts<'a, 'info> {
    pub usdc_mint: &'a AccountInfo<'info>,
    pub vault: &'a AccountInfo<'info>,
    /// The recipient's USDC associated token account (may not exist).
    pub recipient_usdc: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
}

/// How a payout settled.
pub enum Paid {
    Usdc(u64),
    Claim(u64),
    Nothing,
}

/// Pays `units` USDC out of the vault into `recipient`'s own token account
/// — if, and only if, that transfer cannot fail: the vault is live, not
/// frozen and holds the amount, and the destination is the recipient's
/// associated USDC account, initialised, theirs, and not frozen. Returns
/// false, having moved nothing, in every other case. Solana has no
/// try/catch: this check IS the catch.
pub fn try_pay_usdc<'info>(
    store: &Account<'info, Store>,
    accounts: &PayoutAccounts<'_, 'info>,
    recipient: &Pubkey,
    units: u64,
) -> Result<bool> {
    require!(*accounts.usdc_mint.key == store.usdc_mint, GatewayError::AccountMismatch);
    require!(*accounts.vault.key == store.vault, GatewayError::AccountMismatch);
    require!(*accounts.token_program.key == token::ID, GatewayError::AccountMismatch);

    let store_key = store.key();
    let direct = token_account_ok(accounts.vault, &store.usdc_mint, &store_key)
        && token_amount(accounts.vault) >= units
        && *accounts.recipient_usdc.key
            == anchor_spl::associated_token::get_associated_token_address(recipient, &store.usdc_mint)
        && token_account_ok(accounts.recipient_usdc, &store.usdc_mint, recipient);
    if !direct {
        return Ok(false);
    }
    token::transfer(
        CpiContext::new_with_signer(
            accounts.token_program.clone(),
            token::Transfer {
                from: accounts.vault.clone(),
                to: accounts.recipient_usdc.clone(),
                authority: store.to_account_info(),
            },
            &[&[STORE_SEED, &[store.bump]]],
        ),
        units,
    )?;
    Ok(true)
}

/// Books `units` as a claim of `user` (redeemed later with `redeem_claim`,
/// or moved to another chain with `move_claim`).
pub fn book_claim(store: &mut Store, user: &mut UserAccount, units: u64) -> Result<()> {
    user.usd_claim = user.usd_claim.checked_add(units).ok_or(GatewayError::AmountOverflow)?;
    store.claims_total = store.claims_total.checked_add(units).ok_or(GatewayError::AmountOverflow)?;
    Ok(())
}

/// Settles `units` USDC for a user whose account is at hand (a LOCAL
/// instruction: the caller signed and funded it): straight from the vault
/// when that cannot fail, otherwise as a claim. NEVER fails for a short
/// vault or an unusable token account. The hub's messages settle through
/// `lz_receive.rs::Recipient`, which also covers a recipient who has no
/// account here at all.
pub fn pay_usdc<'info>(
    store: &mut Account<'info, Store>,
    accounts: &PayoutAccounts<'_, 'info>,
    recipient: &Pubkey,
    user: &mut UserAccount,
    units: u64,
) -> Result<Paid> {
    if units == 0 {
        return Ok(Paid::Nothing);
    }
    if try_pay_usdc(store, accounts, recipient, units)? {
        return Ok(Paid::Usdc(units));
    }
    book_claim(store, user, units)?;
    Ok(Paid::Claim(units))
}

/// Mints `units` of a replica (authority = the store) into `to`.
pub fn mint_replica<'info>(
    store: &Account<'info, Store>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    units: u64,
) -> Result<()> {
    if units == 0 {
        return Ok(());
    }
    token::mint_to(
        CpiContext::new_with_signer(
            token_program.clone(),
            token::MintTo { mint: mint.clone(), to: to.clone(), authority: store.to_account_info() },
            &[&[STORE_SEED, &[store.bump]]],
        ),
        units,
    )
}

pub const MINT_LEN: usize = 82;
