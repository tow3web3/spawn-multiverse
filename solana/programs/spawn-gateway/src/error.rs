use anchor_lang::prelude::*;

#[error_code]
pub enum GatewayError {
    #[msg("GW: not admin")]
    NotAdmin,
}
