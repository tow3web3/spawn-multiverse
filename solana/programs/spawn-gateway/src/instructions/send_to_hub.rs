use crate::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount},
};
use oapp::endpoint::instructions::{QuoteParams, SendParams as EndpointSendParams};

/// The spoke→hub send path: spawn / buy / sell / claim / pull — and, since
/// v7.2, open / move — each one encoding a protocol payload and shipping it
/// through the real endpoint.
///
/// WHO PAYS (v7). The user who causes a message pays for it AND for the
/// replies it triggers, exactly like an EVM gateway: every send carries one
/// executor lzReceive option — `gas_to_hub` for the hub's lzReceive, plus
/// `return_unit × legs` of HUB-chain native delivered into the hub adapter's
/// tank with the message. The program builds the option itself (the caller
/// cannot shrink the reply budget), the real executor prices both, and the
/// ULN debits the user's own lamports. On a `sponsored` store (testnets)
/// the tank gives the user the fee back. The same budget is written in the
/// envelope (v7.2): the hub adapter refuses a delivery that brings less,
/// so nobody can land a message with nothing and leave its reply to the
/// hub tank.
///
/// remaining_accounts carry the ENDPOINT SEND LIST, resolved client-side
/// exactly like the OFT example (the TS SDK's send account resolution). With
/// the 4–5 workers of a mainnet pathway the list no longer fits a legacy
/// transaction: clients send a v0 transaction with an address lookup table
/// holding the static part (see V7.md).
///
///   [0]  endpoint program
///   [1]  store (the OApp "sender"; signs via CPI seeds)
///   [2]  send library program (ULN)
///   [3]  send_library_config        [SendLibraryConfig, store, dst_eid] @ endpoint
///   [4]  default_send_library_config [SendLibraryConfig, dst_eid]        @ endpoint
///   [5]  send_library_info           [MessageLib, msglib]               @ endpoint  (read-only!)
///   [6]  endpoint settings           [Endpoint]                          @ endpoint
///   [7]  nonce                       [Nonce, store, dst_eid, receiver]   @ endpoint
///   [8]  endpoint event authority    [__event_authority]                 @ endpoint
///   [9]  endpoint program (event CPI)
///   [10] uln settings                [ULN]                               @ uln
///   [11] send_config                 [SendConfig, dst_eid, store]        @ uln (may be virgin)
///   [12] default_send_config         [SendConfig, dst_eid]               @ uln
///   [13] payer — MUST be the user: the ULN debits it
///   [14] treasury (uln.treasury.native_receiver, or the ULN program id as
///        the Anchor "None" placeholder)
///   [15] system program
///   [16] uln event authority         [__event_authority]                 @ uln
///   [17] uln program (event CPI)
///   [18..] worker quads: [executor_program, executor_config, price_feed
///        program, price_feed config], then one such quad per DVN.
const IDX_SEND_LIB: usize = 2;
const IDX_NONCE_END: usize = 8; // [2..8) = the endpoint Quote's named accounts
const IDX_ULN_SETTINGS: usize = 10;
const IDX_DSC_END: usize = 13; // [10..13) = ULN quote pass-through
const IDX_PAYER: usize = 13;
const IDX_WORKERS: usize = 18;
const MIN_SEND_ACCOUNTS: usize = IDX_WORKERS + 4; // at least the executor quad

/// The wire bytes of one message: the op payload inside the inter-transport
/// envelope — this store as protocol sender, the hub pad as target, and the
/// reply budget the message must arrive with.
fn envelope(store: &Account<Store>, msg: &SpawnMsg, value: u128) -> Vec<u8> {
    msg_codec::Envelope {
        src_sender: msg_codec::WireAddr(store.key().to_bytes()),
        dst_addr: msg_codec::WireAddr(store.hub_pad),
        payload: msg.encode(),
        value: msg_codec::U256::from_u128(value),
    }
    .encode()
}

/// The executor options of a send that will cause `legs` hub replies, and
/// the reply budget (hub-native wei) they carry — ONE number, written in
/// the option and in the envelope alike.
fn options_for(store: &Store, legs: u16) -> Result<(Vec<u8>, u128)> {
    require!(store.gas_to_hub > 0, GatewayError::NoSendOptions);
    let value = store
        .return_unit
        .checked_mul(legs as u128)
        .ok_or(GatewayError::AmountOverflow)?;
    Ok((msg_codec::lz_receive_options(store.gas_to_hub, value), value))
}

/// CPI-quotes the endpoint for `message` + `options`. The endpoint refuses
/// WRITABLE accounts on quote (it is pure) while send needs several of them
/// mutable — so the quote gets read-only clones of the same list.
fn quote_native<'info>(
    store: &Account<'info, Store>,
    peer: &PeerConfig,
    rem: &[AccountInfo<'info>],
    message: &[u8],
    options: &[u8],
) -> Result<u64> {
    require!(store.endpoint_program != Pubkey::default(), GatewayError::BadEndpoint);
    require!(rem.len() >= MIN_SEND_ACCOUNTS, GatewayError::BadSendAccounts);
    let ro = |a: &AccountInfo<'info>| {
        let mut a = a.clone();
        a.is_writable = false;
        a
    };
    let mut quote_accounts: Vec<AccountInfo<'info>> = Vec::with_capacity(rem.len() - 7);
    quote_accounts.push(ro(&rem[0]));
    quote_accounts.extend(rem[IDX_SEND_LIB..IDX_NONCE_END].iter().map(&ro));
    quote_accounts.extend(rem[IDX_ULN_SETTINGS..IDX_DSC_END].iter().map(&ro));
    quote_accounts.extend(rem[IDX_WORKERS..].iter().map(&ro));
    let fee = oapp::endpoint_cpi::quote(
        store.endpoint_program,
        &quote_accounts,
        QuoteParams {
            sender: store.key(),
            dst_eid: store.hub_eid,
            receiver: peer.peer_address,
            message: message.to_vec(),
            options: options.to_vec(),
            pay_in_lz_token: false,
        },
    )?;
    Ok(fee.native_fee)
}

/// Sends, and settles who pays. Returns the native fee LayerZero charged.
///
/// No on-chain quote: the ULN charges the ACTUAL fee and only requires it
/// to be within the `native_fee` it is handed, so the caller's ceiling goes
/// straight in (0 = no ceiling) and the receipt says what was paid. (A
/// quote CPI before every send would double the compute and — with the 4–5
/// workers of a mainnet pathway — exhaust the 32 KB heap.) Clients size the
/// ceiling with `quote_send`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn send_to_hub<'info>(
    store: &Account<'info, Store>,
    peer: &Account<'info, PeerConfig>,
    gas_tank: &AccountInfo<'info>,
    gas_tank_bump: u8,
    user: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    rem: &[AccountInfo<'info>],
    msg: &SpawnMsg,
    legs: u16,
    max_native_fee: u64,
) -> Result<u64> {
    // Sends need the real endpoint — the LiteSVM sentinel cannot carry one.
    require!(store.endpoint_program != Pubkey::default(), GatewayError::BadEndpoint);
    require!(rem.len() >= MIN_SEND_ACCOUNTS, GatewayError::BadSendAccounts);
    // the ULN debits the list's payer: it must be the user who signed
    require!(*rem[IDX_PAYER].key == *user.key && rem[IDX_PAYER].is_signer, GatewayError::BadFeePayer);
    let (options, value) = options_for(store, legs)?;
    let message = envelope(store, msg, value);

    let seeds: &[&[u8]] = &[STORE_SEED, &[store.bump]];
    let receipt = oapp::endpoint_cpi::send(
        store.endpoint_program,
        store.key(),
        rem,
        seeds,
        EndpointSendParams {
            dst_eid: store.hub_eid,
            receiver: peer.peer_address,
            message,
            options,
            native_fee: if max_native_fee == 0 { u64::MAX } else { max_native_fee },
            lz_token_fee: 0,
        },
    )?;
    let fee = receipt.fee.native_fee;

    if store.sponsored && fee > 0 {
        // testnets: the tank gives the user back what the ULN just took
        require!(util::tank_spendable(gas_tank)? >= fee, GatewayError::TankTooPoor);
        invoke_signed(
            &system_instruction::transfer(gas_tank.key, user.key, fee),
            &[gas_tank.clone(), user.clone(), system_program.clone()],
            &[&[GAS_TANK_SEED, &[gas_tank_bump]]],
        )?;
    }
    emit!(SentToHub { op: msg.op(), user: *user.key, native_fee: fee, legs, sponsored: store.sponsored });
    Ok(fee)
}

/// Takes `units` USDC from the user into the vault under the deposit cap —
/// `OmniUSD.depositFor`: nothing is minted, the value rides the message.
fn deposit<'info>(
    store: &Store,
    vault: &Account<'info, TokenAccount>,
    user_usdc: &Account<'info, TokenAccount>,
    user: &Signer<'info>,
    token_program: &Program<'info, Token>,
    units: u64,
) -> Result<()> {
    let after = vault.amount.checked_add(units).ok_or(GatewayError::AmountOverflow)?;
    require!(after <= store.deposit_cap, GatewayError::DepositCap);
    token::transfer(
        CpiContext::new(
            token_program.to_account_info(),
            token::Transfer {
                from: user_usdc.to_account_info(),
                to: vault.to_account_info(),
                authority: user.to_account_info(),
            },
        ),
        units,
    )
}

/// A user account is created by its owner's first action; this stamps it.
fn stamp(user_account: &mut Account<UserAccount>, owner: &Pubkey, bump: u8) {
    if user_account.owner == Pubkey::default() {
        user_account.owner = *owner;
        user_account.bump = bump;
    }
}

/* ------------------------------- spawn ------------------------------- */

#[derive(Accounts)]
pub struct SpawnToken<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &store.hub_eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(mut, seeds = [GAS_TANK_SEED], bump)]
    pub gas_tank: SystemAccount<'info>,
    /// Where the hub's replies land when they cannot be settled on the spot
    /// (the dev buy of a token whose replica is not here yet, a refund the
    /// vault cannot pay). The user funds it once.
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
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usdc_mint,
        associated_token::authority = user
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = store.vault @ GatewayError::NoVault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SpawnTokenParams {
    pub name: String,
    pub symbol: String,
    pub meta_uri: String,
    /// USDC units (6 decimals); rides the wire ×1e12.
    pub dev_buy_usdc: u64,
    pub fee_mode: u8,
    /// Ceiling on the LayerZero fee, in lamports (0 = none) — the ULN refuses
    /// the send (`InsufficientFee`) rather than charge more.
    pub max_native_fee: u64,
}

/// Everything the hub would refuse — or choke on — about a spawn, refused
/// here where it costs the user nothing (SpawnGateway._checkSpawn).
fn check_spawn(name: &str, symbol: &str, meta_uri: &str, fee_mode: u8) -> Result<()> {
    require!(fee_mode <= MAX_FEE_MODE, GatewayError::BadFeeMode);
    require!(
        name.len() <= MAX_NAME_BYTES && symbol.len() <= MAX_SYMBOL_BYTES && meta_uri.len() <= MAX_META_BYTES,
        GatewayError::StringTooLong
    );
    Ok(())
}

impl<'info> SpawnToken<'info> {
    pub fn apply(
        ctx: &mut Context<'_, '_, 'info, 'info, SpawnToken<'info>>,
        params: &SpawnTokenParams,
    ) -> Result<()> {
        require!(!ctx.accounts.store.paused, GatewayError::Paused);
        check_spawn(&params.name, &params.symbol, &params.meta_uri, params.fee_mode)?;
        let user_key = ctx.accounts.user.key();
        stamp(&mut ctx.accounts.user_account, &user_key, ctx.bumps.user_account);
        if params.dev_buy_usdc > 0 {
            deposit(
                &ctx.accounts.store,
                &ctx.accounts.vault,
                &ctx.accounts.user_usdc,
                &ctx.accounts.user,
                &ctx.accounts.token_program,
                params.dev_buy_usdc,
            )?;
        }
        let msg = SpawnMsg::Spawn {
            creator: msg_codec::WireAddr::from_pubkey(&user_key),
            name: params.name.clone(),
            symbol: params.symbol.clone(),
            meta_uri: params.meta_uri.clone(),
            dev_buy_usd: msg_codec::U256::from_spl_amount(params.dev_buy_usdc),
            fee_mode: params.fee_mode,
        };
        // a spawn makes the hub SYNC every remote chain; a dev buy adds the
        // DELIVER that brings the creator's bag home
        let store = &ctx.accounts.store;
        let legs = store.spawn_legs as u16 + if params.dev_buy_usdc > 0 { store.trade_legs as u16 } else { 0 };
        send_to_hub(
            &ctx.accounts.store,
            &ctx.accounts.peer,
            &ctx.accounts.gas_tank.to_account_info(),
            ctx.bumps.gas_tank,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            ctx.remaining_accounts,
            &msg,
            legs,
            params.max_native_fee,
        )?;
        Ok(())
    }
}

/* -------------------------------- buy -------------------------------- */

#[derive(Accounts)]
#[instruction(params: BuyTokenParams)]
pub struct BuyToken<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &store.hub_eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(mut, seeds = [GAS_TANK_SEED], bump)]
    pub gas_tank: SystemAccount<'info>,
    /// A BUY for a token the hub does not know would have to be refunded
    /// across the wire: a replica exists here iff the hub spawned the token,
    /// so an unknown id fails right here (the account does not exist).
    #[account(seeds = [REPLICA_SEED, &params.hub_token], bump = replica.bump)]
    pub replica: Box<Account<'info, Replica>>,
    #[account(address = replica.mint)]
    pub mint: Box<Account<'info, Mint>>,
    /// The buyer's token account, created now — and paid for by the buyer —
    /// so the DELIVER has somewhere to mint without spending anyone's SOL.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user
    )]
    pub user_token: Box<Account<'info, TokenAccount>>,
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
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = store.vault @ GatewayError::NoVault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct BuyTokenParams {
    /// The 32-byte wire token id (the EVM hub token, left-padded).
    pub hub_token: [u8; 32],
    /// USDC units (6 decimals); rides the wire ×1e12. One unit is exactly
    /// the EVM gateways' dust floor (1e12 wei).
    pub usdc_in: u64,
    /// The least replica units (6 decimals) the buyer will take for it;
    /// rides the wire ×1e12 (v7.2). The hub fills the buy for at least this
    /// much or not at all — the dollars then come home whole. REQUIRED
    /// (> 0): see `BuyToken::apply`.
    pub min_tokens_out: u64,
    pub max_native_fee: u64,
}

impl<'info> BuyToken<'info> {
    pub fn apply(
        ctx: &mut Context<'_, '_, 'info, 'info, BuyToken<'info>>,
        params: &BuyTokenParams,
    ) -> Result<()> {
        require!(!ctx.accounts.store.paused, GatewayError::Paused);
        require!(params.usdc_in > 0, GatewayError::ZeroAmount);
        // A MINIMUM, ALWAYS (v7.2). From here every trade is a cross-chain
        // one: it executes minutes after it became public, and anyone may
        // deliver it — between a buy and a sell of their own. There is no
        // synchronous path on this chain where an unprotected trade would
        // be safe, so there is no unprotected entry point: the caller names
        // what they will accept, and one unit (0.000001) says "anything".
        require!(params.min_tokens_out > 0, GatewayError::ZeroMinimum);
        let user_key = ctx.accounts.user.key();
        stamp(&mut ctx.accounts.user_account, &user_key, ctx.bumps.user_account);
        deposit(
            &ctx.accounts.store,
            &ctx.accounts.vault,
            &ctx.accounts.user_usdc,
            &ctx.accounts.user,
            &ctx.accounts.token_program,
            params.usdc_in,
        )?;
        let msg = SpawnMsg::Buy {
            hub_token: msg_codec::WireAddr(params.hub_token),
            buyer: msg_codec::WireAddr::from_pubkey(&user_key),
            usd_in: msg_codec::U256::from_spl_amount(params.usdc_in),
            min_tokens_out: msg_codec::U256::from_spl_amount(params.min_tokens_out),
        };
        let legs = ctx.accounts.store.trade_legs as u16;
        send_to_hub(
            &ctx.accounts.store,
            &ctx.accounts.peer,
            &ctx.accounts.gas_tank.to_account_info(),
            ctx.bumps.gas_tank,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            ctx.remaining_accounts,
            &msg,
            legs,
            params.max_native_fee,
        )?;
        Ok(())
    }
}

/* -------------------------------- sell ------------------------------- */

#[derive(Accounts)]
#[instruction(params: SellTokenParams)]
pub struct SellToken<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &store.hub_eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(mut, seeds = [GAS_TANK_SEED], bump)]
    pub gas_tank: SystemAccount<'info>,
    #[account(seeds = [REPLICA_SEED, &params.hub_token], bump = replica.bump)]
    pub replica: Box<Account<'info, Replica>>,
    #[account(mut, address = replica.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = user)]
    pub user_token: Box<Account<'info, TokenAccount>>,
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
    /// Where the payout will land — created now if the seller has none.
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

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SellTokenParams {
    pub hub_token: [u8; 32],
    /// Replica units (6 decimals); the hub re-materializes amount ×1e12 —
    /// always an exact multiple, so the hub's supply ledger never underflows.
    pub amount: u64,
    /// The least USDC units (6 decimals) the seller will be PAID, net of
    /// the fee; rides the wire ×1e12 (v7.2). Under it the hub refuses the
    /// sale and delivers the bag back. REQUIRED (> 0), like a buy's.
    pub min_usdc_out: u64,
    pub max_native_fee: u64,
}

impl<'info> SellToken<'info> {
    /// Never paused: a pause blocks new exposure, not exits.
    pub fn apply(
        ctx: &mut Context<'_, '_, 'info, 'info, SellToken<'info>>,
        params: &SellTokenParams,
    ) -> Result<()> {
        require!(params.amount > 0, GatewayError::ZeroAmount);
        require!(params.min_usdc_out > 0, GatewayError::ZeroMinimum);
        let user_key = ctx.accounts.user.key();
        stamp(&mut ctx.accounts.user_account, &user_key, ctx.bumps.user_account);
        // burn the replicas FIRST — the hub mints them back into curve
        // inventory on OP_SELL, exactly like the EVM spokes
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.user_token.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            params.amount,
        )?;
        let msg = SpawnMsg::Sell {
            hub_token: msg_codec::WireAddr(params.hub_token),
            seller: msg_codec::WireAddr::from_pubkey(&user_key),
            tokens_in: msg_codec::U256::from_spl_amount(params.amount),
            min_usd_out: msg_codec::U256::from_spl_amount(params.min_usdc_out),
        };
        let legs = ctx.accounts.store.trade_legs as u16;
        send_to_hub(
            &ctx.accounts.store,
            &ctx.accounts.peer,
            &ctx.accounts.gas_tank.to_account_info(),
            ctx.bumps.gas_tank,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            ctx.remaining_accounts,
            &msg,
            legs,
            params.max_native_fee,
        )?;
        Ok(())
    }
}

/* --------------------------- claim (the dev) -------------------------- */

#[derive(Accounts)]
#[instruction(params: TokenMsgParams)]
pub struct ClaimFees<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &store.hub_eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(mut, seeds = [GAS_TANK_SEED], bump)]
    pub gas_tank: SystemAccount<'info>,
    #[account(seeds = [REPLICA_SEED, &params.hub_token], bump = replica.bump)]
    pub replica: Box<Account<'info, Replica>>,
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

/// The params of a message that only names a token (claim, pull).
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct TokenMsgParams {
    pub hub_token: [u8; 32],
    pub max_native_fee: u64,
}

impl<'info> ClaimFees<'info> {
    pub fn apply(
        ctx: &mut Context<'_, '_, 'info, 'info, ClaimFees<'info>>,
        params: &TokenMsgParams,
    ) -> Result<()> {
        // The hub checks metas[token].creator == claimer; a wrong claimer
        // costs a message and claims nothing, same as the EVM spokes.
        let user_key = ctx.accounts.user.key();
        stamp(&mut ctx.accounts.user_account, &user_key, ctx.bumps.user_account);
        let msg = SpawnMsg::Claim {
            hub_token: msg_codec::WireAddr(params.hub_token),
            claimer: msg_codec::WireAddr::from_pubkey(&user_key),
        };
        let legs = ctx.accounts.store.trade_legs as u16;
        send_to_hub(
            &ctx.accounts.store,
            &ctx.accounts.peer,
            &ctx.accounts.gas_tank.to_account_info(),
            ctx.bumps.gas_tank,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            ctx.remaining_accounts,
            &msg,
            legs,
            params.max_native_fee,
        )?;
        Ok(())
    }
}

/* --------------------------- pull holder fees ------------------------- */

/// Brings home this chain's share of a token's holder fees (v7: the hub
/// accrues it and waits to be asked — SpawnPad._distributeHolders). Anyone
/// may pull; it lands in the token's pool for everyone staked here. The
/// caller pays the round trip.
#[derive(Accounts)]
#[instruction(params: TokenMsgParams)]
pub struct PullFees<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &store.hub_eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(mut, seeds = [GAS_TANK_SEED], bump)]
    pub gas_tank: SystemAccount<'info>,
    #[account(seeds = [REPLICA_SEED, &params.hub_token], bump = replica.bump)]
    pub replica: Box<Account<'info, Replica>>,
    pub system_program: Program<'info, System>,
}

impl<'info> PullFees<'info> {
    pub fn apply(
        ctx: &mut Context<'_, '_, 'info, 'info, PullFees<'info>>,
        params: &TokenMsgParams,
    ) -> Result<()> {
        let msg = SpawnMsg::PullFees { hub_token: msg_codec::WireAddr(params.hub_token) };
        let legs = ctx.accounts.store.trade_legs as u16;
        send_to_hub(
            &ctx.accounts.store,
            &ctx.accounts.peer,
            &ctx.accounts.gas_tank.to_account_info(),
            ctx.bumps.gas_tank,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            ctx.remaining_accounts,
            &msg,
            legs,
            params.max_native_fee,
        )?;
        Ok(())
    }
}

/* ------------------------- open a token (v7.2) ------------------------ */

/// Asks the hub for this chain's replica of a token it never got: the SYNC
/// was skipped at launch (its fee was above the hub's ceiling for this
/// chain), failed, or the token is older than the chain's gateway
/// (`SpawnGateway.openToken`). Anyone may; the caller pays the round trip —
/// the message, the SYNC the hub sends back (`open_legs`), AND THE RENT OF
/// THE REPLICA: its two accounts are created by that SYNC, which arrives
/// with no lamports, so the opener leaves their rent at the two addresses
/// now. The answer then costs the tank nothing, whoever executes it.
///
/// The hub answers with an ordinary SYNC, or with nothing: an id it never
/// spawned, or a SYNC that costs more right now than its ceiling for
/// requests toward this chain (`SpawnPad.requestCap`). The fee is then
/// spent and the rent stays at the two addresses — it serves the next open
/// of that token; for an id that names no token it is lost. A frontend
/// reads the hub before offering this.
#[derive(Accounts)]
#[instruction(params: TokenMsgParams)]
pub struct OpenToken<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &store.hub_eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(mut, seeds = [GAS_TANK_SEED], bump)]
    pub gas_tank: SystemAccount<'info>,
    /// CHECK: where the replica entry will live — it must not exist yet
    #[account(mut, seeds = [REPLICA_SEED, &params.hub_token], bump)]
    pub replica: UncheckedAccount<'info>,
    /// CHECK: where its SPL mint will live
    #[account(mut, seeds = [MINT_SEED, &params.hub_token], bump)]
    pub mint: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> OpenToken<'info> {
    pub fn apply(
        ctx: &mut Context<'_, '_, 'info, 'info, OpenToken<'info>>,
        params: &TokenMsgParams,
    ) -> Result<()> {
        // a replica is new exposure to a market: opens stop with the rest
        require!(!ctx.accounts.store.paused, GatewayError::Paused);
        // every token is a contract on the hub: its id is an EVM address,
        // left-padded. The hub refuses anything wider — refuse it here,
        // where it costs nothing.
        require!(params.hub_token[..12] == [0u8; 12], GatewayError::BadTokenId);
        let replica = ctx.accounts.replica.to_account_info();
        require!(
            replica.owner != ctx.program_id || replica.data_is_empty(),
            GatewayError::AlreadyOpen
        );
        // the rent of what the SYNC will create, left where it will be
        // needed (a top-up: what an earlier open left there counts)
        let rent = Rent::get()?;
        let mint = ctx.accounts.mint.to_account_info();
        for (target, space) in [(&replica, Replica::SIZE), (&mint, util::MINT_LEN)] {
            let missing = rent.minimum_balance(space).saturating_sub(target.lamports());
            if missing > 0 {
                anchor_lang::solana_program::program::invoke(
                    &system_instruction::transfer(ctx.accounts.user.key, target.key, missing),
                    &[
                        ctx.accounts.user.to_account_info(),
                        target.clone(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                )?;
            }
        }
        let msg = SpawnMsg::Open { hub_token: msg_codec::WireAddr(params.hub_token) };
        let legs = ctx.accounts.store.open_legs as u16;
        send_to_hub(
            &ctx.accounts.store,
            &ctx.accounts.peer,
            &ctx.accounts.gas_tank.to_account_info(),
            ctx.bumps.gas_tank,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            ctx.remaining_accounts,
            &msg,
            legs,
            params.max_native_fee,
        )?;
        Ok(())
    }
}

/* -------------------------- move a claim (v7.2) ----------------------- */

/// What a move to `dst_chain` prepays: the route's price, never fewer legs
/// than a trade's (they pay for the way home if the hub returns the claim).
/// A chain with no price is closed — which is also what refuses a chain
/// that does not exist. `SpawnGateway._moveLegs`.
fn move_legs(store: &Store, route: Option<&MoveRoute>, dst_chain: u32) -> Result<u16> {
    require!(dst_chain != CHAIN_LABEL && dst_chain != HUB_LABEL, GatewayError::BadDestination);
    let legs = route.filter(|r| r.dst_chain == dst_chain).map(|r| r.legs).unwrap_or(0);
    require!(legs != 0, GatewayError::RouteClosed);
    Ok(legs.max(store.trade_legs as u16))
}

/// Sends a dollar claim to `to` on another chain, whose vault pays it in
/// that chain's dollar if it can and as a claim there if it cannot
/// (`SpawnGateway.moveClaim`). For the claim a short vault left behind:
/// dollars enter where buyers are and leave where sellers are.
///
/// What moves is the caller's CLAIM (`user_account.usd_claim`), nothing
/// else: this chain has no oUSD token and no `wrap`, so USDC in a wallet is
/// not a claim and cannot leave this way (the USDT vault's rule on the EVM
/// side, for the same reason: it would be a free exchange through the
/// vaults).
///
/// AN EXIT: it ignores the pause. If the hub cannot hand the claim on — no
/// such chain, a recipient that chain cannot pay, a leg that fails or costs
/// more right now than the hub's ceiling for it — it comes back to the
/// caller here, as USDC or as the same claim. The caller pays the message
/// and the hub's leg to the destination.
#[derive(Accounts)]
#[instruction(params: MoveClaimParams)]
pub struct MoveClaim<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &store.hub_eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(mut, seeds = [GAS_TANK_SEED], bump)]
    pub gas_tank: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [USER_SEED, user.key().as_ref()],
        bump = user_account.bump,
        constraint = user_account.owner == user.key() @ GatewayError::AccountMismatch
    )]
    pub user_account: Box<Account<'info, UserAccount>>,
    /// CHECK: the price of this destination — absent or 0 = route closed
    #[account(seeds = [MOVE_ROUTE_SEED, &params.dst_chain.to_be_bytes()], bump)]
    pub route: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct MoveClaimParams {
    /// SPAWN! chain label of the destination.
    pub dst_chain: u32,
    /// The recipient there, as a wide id: an EVM address left-padded.
    pub to: [u8; 32],
    /// USDC units (6 decimals) of the caller's claim; rides the wire ×1e12.
    pub units: u64,
    pub max_native_fee: u64,
}

impl<'info> MoveClaim<'info> {
    /// Never paused: a pause blocks new exposure, not exits.
    pub fn apply(
        ctx: &mut Context<'_, '_, 'info, 'info, MoveClaim<'info>>,
        params: &MoveClaimParams,
    ) -> Result<()> {
        // one unit is exactly the EVM gateways' dust floor (1e12 wei)
        require!(params.units > 0, GatewayError::ZeroAmount);
        require!(params.to != [0u8; 32], GatewayError::BadDestination);
        let route_info = ctx.accounts.route.to_account_info();
        let route: Option<MoveRoute> = if route_info.owner == ctx.program_id && !route_info.data_is_empty() {
            Some(util::load(&route_info)?)
        } else {
            None
        };
        let legs = move_legs(&ctx.accounts.store, route.as_ref(), params.dst_chain)?;

        // burn the claim FIRST — the value now rides the message
        let user_account = &mut ctx.accounts.user_account;
        require!(user_account.usd_claim >= params.units, GatewayError::ClaimTooSmall);
        user_account.usd_claim -= params.units;
        let store = &mut ctx.accounts.store;
        store.claims_total = store.claims_total.saturating_sub(params.units);

        let user_key = ctx.accounts.user.key();
        let msg = SpawnMsg::Move {
            from: msg_codec::WireAddr::from_pubkey(&user_key),
            to: msg_codec::WireAddr(params.to),
            amount: msg_codec::U256::from_spl_amount(params.units),
            dst_chain: params.dst_chain,
        };
        send_to_hub(
            &ctx.accounts.store,
            &ctx.accounts.peer,
            &ctx.accounts.gas_tank.to_account_info(),
            ctx.bumps.gas_tank,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            ctx.remaining_accounts,
            &msg,
            legs,
            params.max_native_fee,
        )?;
        emit!(ClaimMoved { user: user_key, dst_chain: params.dst_chain, to: params.to, usdc: params.units });
        Ok(())
    }
}

/* -------------------------------- quote ------------------------------- */

/// The native fee an action costs right now — simulate it before signing
/// (the gateways' `quote*` views). BUY, SELL, CLAIM, PULL, OPEN and MOVE
/// payloads have a fixed size; a SPAWN's size depends on its strings, so its
/// quote takes them; a MOVE's price depends on where it goes, so its quote
/// takes the destination and that destination's route account.
/// remaining_accounts: the same send list as the action itself.
#[derive(Accounts)]
pub struct QuoteSend<'info> {
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &store.hub_eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    /// The price of a move's destination (op 7 only; absent = route closed).
    pub move_route: Option<Account<'info, MoveRoute>>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct QuoteSendParams {
    /// The wire op: 1 spawn, 2 buy, 3 sell, 4 claim, 5 pull, 6 open, 7 move.
    pub op: u8,
    pub name: String,
    pub symbol: String,
    pub meta_uri: String,
    pub with_dev_buy: bool,
    /// The destination of a move (op 7); ignored otherwise.
    pub dst_chain: u32,
}

impl<'info> QuoteSend<'info> {
    pub fn apply(
        ctx: &Context<'_, '_, 'info, 'info, QuoteSend<'info>>,
        params: &QuoteSendParams,
    ) -> Result<u64> {
        let store = &ctx.accounts.store;
        let zero = msg_codec::WireAddr([0u8; 32]);
        let nil = msg_codec::U256([0u8; 32]);
        let trade = store.trade_legs as u16;
        let (msg, legs) = match params.op {
            msg_codec::OP_SPAWN => (
                SpawnMsg::Spawn {
                    creator: zero,
                    name: params.name.clone(),
                    symbol: params.symbol.clone(),
                    meta_uri: params.meta_uri.clone(),
                    dev_buy_usd: nil,
                    fee_mode: 0,
                },
                store.spawn_legs as u16 + if params.with_dev_buy { trade } else { 0 },
            ),
            msg_codec::OP_BUY => (SpawnMsg::Buy { hub_token: zero, buyer: zero, usd_in: nil, min_tokens_out: nil }, trade),
            msg_codec::OP_SELL => (SpawnMsg::Sell { hub_token: zero, seller: zero, tokens_in: nil, min_usd_out: nil }, trade),
            msg_codec::OP_CLAIM => (SpawnMsg::Claim { hub_token: zero, claimer: zero }, trade),
            msg_codec::OP_PULL_FEES => (SpawnMsg::PullFees { hub_token: zero }, trade),
            msg_codec::OP_OPEN => (SpawnMsg::Open { hub_token: zero }, store.open_legs as u16),
            msg_codec::OP_MOVE => (
                SpawnMsg::Move { from: zero, to: zero, amount: nil, dst_chain: params.dst_chain },
                move_legs(store, ctx.accounts.move_route.as_deref(), params.dst_chain)?,
            ),
            _ => return Err(GatewayError::UnknownOp.into()),
        };
        let (options, value) = options_for(store, legs)?;
        let message = envelope(store, &msg, value);
        quote_native(store, &ctx.accounts.peer, ctx.remaining_accounts, &message, &options)
    }
}

#[event]
pub struct SentToHub {
    pub op: u8,
    pub user: Pubkey,
    pub native_fee: u64,
    pub legs: u16,
    pub sponsored: bool,
}

#[event]
pub struct ClaimMoved {
    pub user: Pubkey,
    pub dst_chain: u32,
    pub to: [u8; 32],
    pub usdc: u64,
}
