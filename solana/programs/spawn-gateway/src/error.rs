use anchor_lang::prelude::*;

#[error_code]
pub enum GatewayError {
    #[msg("GW: not admin")]
    NotAdmin,
    #[msg("GW: bad endpoint program")]
    BadEndpoint,
    #[msg("GW: malformed payload")]
    BadPayload,
    #[msg("GW: unknown op")]
    UnknownOp,
    #[msg("GW: amount exceeds the SPL range")]
    AmountOverflow,
    #[msg("GW: sender is not the hub peer")]
    NotPeer,
    #[msg("GW: replica not synced")]
    NoReplica,
    #[msg("GW: account mismatch")]
    AccountMismatch,
    #[msg("GW: recipient does not match the wire address")]
    RecipientMismatch,
    #[msg("GW: string too long")]
    StringTooLong,
}
