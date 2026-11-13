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
    #[msg("GW: gas tank cannot cover the LayerZero fee")]
    TankTooPoor,
    #[msg("GW: fee settings not configured")]
    NoSendOptions,
    #[msg("GW: endpoint account list too short")]
    BadSendAccounts,
    #[msg("GW: bad fee mode")]
    BadFeeMode,
    #[msg("GW: zero amount")]
    ZeroAmount,
    #[msg("GW: not operator")]
    NotOperator,
    #[msg("GW: not guardian")]
    NotGuardian,
    #[msg("GW: not the nominated admin")]
    NotNominee,
    #[msg("GW: paused")]
    Paused,
    #[msg("GW: unknown token")]
    UnknownToken,
    #[msg("GW: deposit cap")]
    DepositCap,
    #[msg("GW: vault not initialized")]
    NoVault,
    #[msg("GW: vault already initialized")]
    VaultSet,
    #[msg("GW: backing mint must have 6 decimals")]
    BadUsdcDecimals,
    #[msg("GW: vault short")]
    VaultShort,
    #[msg("GW: nothing to redeem")]
    NothingToRedeem,
    #[msg("GW: nothing parked for this token")]
    NothingParked,
    #[msg("GW: the recipient has no user account to park into")]
    NoUserAccount,
    #[msg("GW: too many parked deliveries — claim one first")]
    ParkingFull,
    #[msg("GW: fee setting out of bounds")]
    OutOfBounds,
    #[msg("GW: not enough staked")]
    NotEnoughStaked,
    #[msg("GW: the fee payer of the send list must be the user")]
    BadFeePayer,
}
