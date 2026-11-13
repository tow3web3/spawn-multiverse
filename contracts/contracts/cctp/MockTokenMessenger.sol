// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITokenMessengerV2} from "./ITokenMessengerV2.sol";

/// @title MockTokenMessenger — TESTS ONLY.
/// @notice Stands in for Circle's TokenMessengerV2: pulls the burn token from
/// the caller (holding it forever is this mock's "burn") and records the
/// exact arguments so a test can assert where a rebalance was aimed.
contract MockTokenMessenger is ITokenMessengerV2 {
    struct Call {
        address caller;
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
    }

    Call public lastCall;
    uint256 public calls;

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        // the same guards the real TokenMessengerV2 applies
        require(amount > 0, "Amount must be nonzero");
        require(mintRecipient != bytes32(0), "Mint recipient must be nonzero");
        require(maxFee < amount, "Max fee must be less than amount");
        require(IERC20(burnToken).transferFrom(msg.sender, address(this), amount), "transfer failed");
        lastCall = Call(
            msg.sender,
            amount,
            destinationDomain,
            mintRecipient,
            burnToken,
            destinationCaller,
            maxFee,
            minFinalityThreshold
        );
        calls++;
    }
}
