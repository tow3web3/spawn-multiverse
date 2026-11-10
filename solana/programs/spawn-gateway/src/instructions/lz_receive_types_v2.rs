use crate::*;
use anchor_spl::{associated_token::get_associated_token_address, token};
use anchor_lang::system_program;
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
        let usd_mint = ctx.accounts.store.usd_mint;
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
        match SpawnMsg::decode(&params.message)? {
            SpawnMsg::SyncToken { hub_token, .. } => {
                let (replica, _) = Pubkey::find_program_address(&[REPLICA_SEED, &hub_token.0], program_id);
                let (mint, _) = Pubkey::find_program_address(&[MINT_SEED, &hub_token.0], program_id);
                accounts.extend([
                    meta(replica, true),
                    meta(mint, true),
                    meta(system_program::ID, false),
                    meta(token::ID, false),
                ]);
            }
            SpawnMsg::FeeDrop { hub_token, .. } => {
                let (replica, _) = Pubkey::find_program_address(&[REPLICA_SEED, &hub_token.0], program_id);
                accounts.extend([
                    meta(replica, false),
                    meta(usd_mint, true),
                    meta(get_associated_token_address(&store_key, &usd_mint), true),
                    meta(system_program::ID, false),
                    meta(token::ID, false),
                    meta(anchor_spl::associated_token::ID, false),
                ]);
            }
            // PHASE-2A LIMIT: a 20-byte EVM recipient cannot be resolved to
            // a Solana pubkey, so executor-driven delivery of these two ops
            // waits for the bytes32-recipient protocol evolution (phase 2b).
            // lz_receive itself handles them fine when the caller supplies
            // the accounts (see the LiteSVM tests).
            SpawnMsg::Deliver { .. } | SpawnMsg::Payout { .. } => {
                return Err(GatewayError::RecipientMismatch.into());
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
