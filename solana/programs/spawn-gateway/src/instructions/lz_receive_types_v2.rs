use crate::*;
use anchor_lang::system_program;
use anchor_spl::{associated_token::get_associated_token_address, token};
use oapp::{
    common::{compact_accounts_with_alts, AccountMetaRef, AddressLocator, EXECUTION_CONTEXT_VERSION_1},
    endpoint::ID as ENDPOINT_ID,
    lz_receive_types_v2::{get_accounts_for_clear, Instruction, LzReceiveTypesV2Result},
    LzReceiveParams,
};

/// The Executor calls this off-chain to learn which accounts lz_receive
/// needs — Solana's answer to the EVM's dynamic storage access. The list
/// must mirror each handler's layout in lz_receive.rs exactly.
#[derive(Accounts)]
#[instruction(params: LzReceiveParams)]
pub struct LzReceiveTypesV2<'info> {
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
}

impl LzReceiveTypesV2<'_> {
    pub fn apply(
        ctx: &Context<LzReceiveTypesV2>,
        params: &LzReceiveParams,
    ) -> Result<LzReceiveTypesV2Result> {
        let store_key = ctx.accounts.store.key();
        let usdc_mint = ctx.accounts.store.usdc_mint;
        let vault = ctx.accounts.store.vault;
        let program_id = ctx.program_id;

        let peer_seeds = [PEER_SEED, store_key.as_ref(), &params.src_eid.to_be_bytes()];
        let (peer, _) = Pubkey::find_program_address(&peer_seeds, program_id);

        let mut accounts = vec![
            AccountMetaRef { pubkey: AddressLocator::Payer, is_writable: true },
            AccountMetaRef { pubkey: store_key.into(), is_writable: true },
            AccountMetaRef { pubkey: peer.into(), is_writable: false },
        ];
        accounts.extend(get_accounts_for_clear(
            ENDPOINT_ID,
            &store_key,
            params.src_eid,
            &params.sender,
            params.nonce,
        ));

        let meta = |key: Pubkey, writable: bool| AccountMetaRef { pubkey: key.into(), is_writable: writable };
        let pda = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, program_id).0;
        // the wire carries the op inside the inter-transport envelope (v5)
        let env = msg_codec::Envelope::decode(&params.message)?;
        match SpawnMsg::decode(&env.payload)? {
            SpawnMsg::SyncToken { hub_token, .. } => {
                accounts.extend([
                    meta(pda(&[REPLICA_SEED, &hub_token.0]), true),
                    meta(pda(&[MINT_SEED, &hub_token.0]), true),
                    meta(pda(&[GAS_TANK_SEED]), true),
                    meta(system_program::ID, false),
                    meta(token::ID, false),
                ]);
            }
            // Wire riders are bytes32 (protocol v4): the recipient IS a
            // Solana pubkey, so the executor can resolve delivery accounts.
            SpawnMsg::Deliver { hub_token, to, .. } => {
                let mint = pda(&[MINT_SEED, &hub_token.0]);
                let recipient = to.pubkey();
                accounts.extend([
                    meta(pda(&[REPLICA_SEED, &hub_token.0]), true),
                    meta(mint, true),
                    meta(recipient, false),
                    meta(get_associated_token_address(&recipient, &mint), true),
                    meta(pda(&[USER_SEED, recipient.as_ref()]), true),
                    meta(usdc_mint, false),
                    meta(vault, true),
                    meta(get_associated_token_address(&recipient, &usdc_mint), true),
                    meta(token::ID, false),
                ]);
            }
            SpawnMsg::Payout { to, .. } => {
                let recipient = to.pubkey();
                accounts.extend([
                    meta(recipient, false),
                    meta(pda(&[USER_SEED, recipient.as_ref()]), true),
                    meta(usdc_mint, false),
                    meta(vault, true),
                    meta(get_associated_token_address(&recipient, &usdc_mint), true),
                    meta(token::ID, false),
                ]);
            }
            SpawnMsg::FeeDrop { hub_token, .. } => {
                accounts.push(meta(pda(&[REPLICA_SEED, &hub_token.0]), true));
            }
            _ => return Err(GatewayError::UnknownOp.into()),
        }

        Ok(LzReceiveTypesV2Result {
            context_version: EXECUTION_CONTEXT_VERSION_1,
            alts: ctx.remaining_accounts.iter().map(|alt| alt.key()).collect(),
            instructions: vec![Instruction::LzReceive {
                accounts: compact_accounts_with_alts(ctx.remaining_accounts, accounts)?,
            }],
        })
    }
}
