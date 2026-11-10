use crate::*;
use oapp::{
    lz_receive_types_v2::{LzReceiveTypesV2Accounts, LZ_RECEIVE_TYPES_VERSION},
    LzReceiveParams,
};

/// Versioning handshake: tells the Executor we speak LzReceiveTypes V2 and
/// which accounts the lz_receive_types_v2 call itself needs.
#[derive(Accounts)]
pub struct LzReceiveTypesInfo<'info> {
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        seeds = [LZ_RECEIVE_TYPES_SEED, &store.key().to_bytes()],
        bump = lz_receive_types_accounts.bump
    )]
    pub lz_receive_types_accounts: Account<'info, LzReceiveTypesAccounts>,
}

impl LzReceiveTypesInfo<'_> {
    pub fn apply(
        ctx: &Context<LzReceiveTypesInfo>,
        _params: &LzReceiveParams,
    ) -> Result<(u8, LzReceiveTypesV2Accounts)> {
        let alt = ctx.accounts.lz_receive_types_accounts.alt;
        let accounts = if alt == Pubkey::default() {
            vec![ctx.accounts.store.key()]
        } else {
            vec![ctx.accounts.store.key(), alt]
        };
        Ok((LZ_RECEIVE_TYPES_VERSION, LzReceiveTypesV2Accounts { accounts }))
    }
}
