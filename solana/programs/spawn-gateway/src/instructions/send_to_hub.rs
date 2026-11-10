use crate::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use oapp::endpoint::{
    instructions::{QuoteParams, SendParams as EndpointSendParams},
    MessagingReceipt,
};

/// The spoke→hub send path (phase 2b): spawn / buy / sell / claim, each one
/// encoding a protocol-v4 payload and shipping it through the real endpoint.
///
/// remaining_accounts carry the ENDPOINT SEND LIST, resolved client-side
/// exactly like the OFT example (the TS SDK's send account resolution):
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
///   [13] payer (the user — reimbursed from the gas tank)
///   [14] treasury (uln.treasury.native_receiver, or the ULN program id as
///        the Anchor "None" placeholder)
///   [15] system program
///   [16] uln event authority         [__event_authority]                 @ uln
///   [17] uln program (event CPI)
///   [18..] worker quads: [executor_program, executor_config, price_feed
///        program, price_feed config], then one such quad per DVN.
///
/// The fee flow mirrors the EVM adapters' quote-and-pay gas tank: the
/// instruction CPI-quotes the endpoint, moves exactly that many lamports
/// from the tank PDA to the payer, then sends with native_fee = quote — the
/// ULN debits the payer, so the user's net cost is ~zero.
const IDX_SEND_LIB: usize = 2;
const IDX_NONCE_END: usize = 8; // [2..8) = the endpoint Quote's named accounts
const IDX_ULN_SETTINGS: usize = 10;
const IDX_DSC_END: usize = 13; // [10..13) = ULN quote pass-through
const IDX_WORKERS: usize = 18;
const MIN_SEND_ACCOUNTS: usize = IDX_WORKERS + 4; // at least the executor quad

pub(crate) fn send_to_hub<'info>(
    store: &Account<'info, Store>,
    peer: &Account<'info, PeerConfig>,
    gas_tank: &AccountInfo<'info>,
    gas_tank_bump: u8,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    rem: &[AccountInfo<'info>],
    msg: &SpawnMsg,
) -> Result<MessagingReceipt> {
    // Sends need the real endpoint — the LiteSVM sentinel cannot carry one.
    require!(
        store.endpoint_program != Pubkey::default(),
        GatewayError::BadEndpoint
    );
    require!(rem.len() >= MIN_SEND_ACCOUNTS, GatewayError::BadSendAccounts);
    let options = peer.enforced_options.send.clone();
    require!(!options.is_empty(), GatewayError::NoSendOptions);

    // Wrap in the inter-transport envelope (v5): we are the protocol sender
    // (the store's own key, raw 32 bytes), the hub pad is the target. The
    // hub adapter unwraps this exact layout and routes to the pad.
    let message = msg_codec::Envelope {
        src_sender: msg_codec::WireAddr(store.key().to_bytes()),
        dst_addr: msg_codec::WireAddr(store.hub_pad),
        payload: msg.encode(),
    }
    .encode();

    // 1. quote — same accounts, minus payer/treasury/event rows. The
    // endpoint refuses WRITABLE accounts on quote (it is pure), while send
    // needs several of these mutable — so demote the clones.
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
            message: message.clone(),
            options: options.clone(),
            pay_in_lz_token: false,
        },
    )?;

    // 2. the tank reimburses the payer, who the ULN is about to debit
    if fee.native_fee > 0 {
        require!(
            gas_tank.lamports() >= fee.native_fee,
            GatewayError::TankTooPoor
        );
        invoke_signed(
            &system_instruction::transfer(gas_tank.key, payer.key, fee.native_fee),
            &[gas_tank.clone(), payer.clone(), system_program.clone()],
            &[&[GAS_TANK_SEED, &[gas_tank_bump]]],
        )?;
    }
    msg!("lz fee quoted: {} lamports (tank pays)", fee.native_fee);

    // 3. send
    let seeds: &[&[u8]] = &[STORE_SEED, &[store.bump]];
    oapp::endpoint_cpi::send(
        store.endpoint_program,
        store.key(),
        rem,
        seeds,
        EndpointSendParams {
            dst_eid: store.hub_eid,
            receiver: peer.peer_address,
            message,
            options,
            native_fee: fee.native_fee,
            lz_token_fee: 0,
        },
    )
}

/* ------------------------------- spawn ------------------------------- */

#[derive(Accounts)]
pub struct SpawnToken<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &store.hub_eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    /// CHECK: zero-data system-owned lamport holder, validated by seeds
    #[account(mut, seeds = [GAS_TANK_SEED], bump)]
    pub gas_tank: SystemAccount<'info>,
    #[account(mut, address = store.usd_mint)]
    pub usd_mint: Account<'info, Mint>,
    #[account(mut, token::mint = usd_mint, token::authority = user)]
    pub user_usd: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SpawnTokenParams {
    pub name: String,
    pub symbol: String,
    pub meta_uri: String,
    /// SPL units (6 decimals); rides the wire ×1e12.
    pub dev_buy_usd: u64,
    pub fee_mode: u8,
}

impl<'info> SpawnToken<'info> {
    pub fn apply(
        ctx: &mut Context<'_, '_, 'info, 'info, SpawnToken<'info>>,
        params: &SpawnTokenParams,
    ) -> Result<()> {
        require!(params.fee_mode <= 3, GatewayError::BadFeeMode);
        if params.dev_buy_usd > 0 {
            token::burn(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    token::Burn {
                        mint: ctx.accounts.usd_mint.to_account_info(),
                        from: ctx.accounts.user_usd.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                params.dev_buy_usd,
            )?;
        }
        let msg = SpawnMsg::Spawn {
            creator: msg_codec::WireAddr::from_pubkey(ctx.accounts.user.key),
            name: params.name.clone(),
            symbol: params.symbol.clone(),
            meta_uri: params.meta_uri.clone(),
            dev_buy_usd: msg_codec::U256::from_spl_amount(params.dev_buy_usd),
            fee_mode: params.fee_mode,
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
        )?;
        Ok(())
    }
}

/* -------------------------------- buy -------------------------------- */

#[derive(Accounts)]
pub struct BuyToken<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &store.hub_eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    /// CHECK: zero-data system-owned lamport holder, validated by seeds
    #[account(mut, seeds = [GAS_TANK_SEED], bump)]
    pub gas_tank: SystemAccount<'info>,
    #[account(mut, address = store.usd_mint)]
    pub usd_mint: Account<'info, Mint>,
    #[account(mut, token::mint = usd_mint, token::authority = user)]
    pub user_usd: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct BuyTokenParams {
    /// The 32-byte wire token id (the EVM hub token, left-padded).
    pub hub_token: [u8; 32],
    /// SPL units (6 decimals); rides the wire ×1e12.
    pub usd_in: u64,
}

impl<'info> BuyToken<'info> {
    pub fn apply(
        ctx: &mut Context<'_, '_, 'info, 'info, BuyToken<'info>>,
        params: &BuyTokenParams,
    ) -> Result<()> {
        require!(params.usd_in > 0, GatewayError::ZeroAmount);
        // the hub re-materializes this as curve money — same burn/mint
        // pattern as the EVM spokes
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint: ctx.accounts.usd_mint.to_account_info(),
                    from: ctx.accounts.user_usd.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            params.usd_in,
        )?;
        let msg = SpawnMsg::Buy {
            hub_token: msg_codec::WireAddr(params.hub_token),
            buyer: msg_codec::WireAddr::from_pubkey(ctx.accounts.user.key),
            usd_in: msg_codec::U256::from_spl_amount(params.usd_in),
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
    pub store: Account<'info, Store>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &store.hub_eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    /// CHECK: zero-data system-owned lamport holder, validated by seeds
    #[account(mut, seeds = [GAS_TANK_SEED], bump)]
    pub gas_tank: SystemAccount<'info>,
    #[account(
        seeds = [REPLICA_SEED, &params.hub_token],
        bump = replica.bump
    )]
    pub replica: Account<'info, Replica>,
    #[account(mut, address = replica.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = user)]
    pub user_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SellTokenParams {
    pub hub_token: [u8; 32],
    /// SPL units (6 decimals); the hub re-materializes amount ×1e12.
    pub amount: u64,
}

impl<'info> SellToken<'info> {
    pub fn apply(
        ctx: &mut Context<'_, '_, 'info, 'info, SellToken<'info>>,
        params: &SellTokenParams,
    ) -> Result<()> {
        require!(params.amount > 0, GatewayError::ZeroAmount);
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
            seller: msg_codec::WireAddr::from_pubkey(ctx.accounts.user.key),
            tokens_in: msg_codec::U256::from_spl_amount(params.amount),
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
        )?;
        Ok(())
    }
}

/* ------------------------------- claim ------------------------------- */

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &store.hub_eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    /// CHECK: zero-data system-owned lamport holder, validated by seeds
    #[account(mut, seeds = [GAS_TANK_SEED], bump)]
    pub gas_tank: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct ClaimFeesParams {
    pub hub_token: [u8; 32],
}

impl<'info> ClaimFees<'info> {
    pub fn apply(
        ctx: &mut Context<'_, '_, 'info, 'info, ClaimFees<'info>>,
        params: &ClaimFeesParams,
    ) -> Result<()> {
        // The hub checks metas[token].creator == claimer; a wrong claimer
        // costs a message and claims nothing, same as the EVM spokes.
        let msg = SpawnMsg::Claim {
            hub_token: msg_codec::WireAddr(params.hub_token),
            claimer: msg_codec::WireAddr::from_pubkey(ctx.accounts.user.key),
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
        )?;
        Ok(())
    }
}
