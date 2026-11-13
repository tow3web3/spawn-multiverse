// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Minimal interface to Circle's CCTP V2 TokenMessengerV2.
/// @notice Signature copied from circlefin/evm-cctp-contracts
/// `src/v2/TokenMessengerV2.sol` (master). The real contract also reverts
/// when the caller is denylisted by Circle, when `maxFee >= amount`, and —
/// if Circle ever switches its `minFee` on — when `maxFee` is below
/// `getMinFeeAmount(amount)`.
interface ITokenMessengerV2 {
    /// @param amount amount of `burnToken` to burn (pulled from msg.sender)
    /// @param destinationDomain CCTP domain of the destination chain
    /// @param mintRecipient address minted to on the destination, as bytes32
    /// @param burnToken the local USDC
    /// @param destinationCaller who may relay on the destination; bytes32(0)
    /// lets anyone relay
    /// @param maxFee max fee paid on the destination, in burnToken units
    /// @param minFinalityThreshold 2000 = finalized (Standard Transfer),
    /// 1000 = confirmed (Fast Transfer)
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}
