// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFeeDistributor} from "../FeeDistributor.sol";

/// @title BrickableDistributor — TEST ONLY. A holder pool that can be told
/// to revert, standing in for any future failure of the transfer hook or of
/// `drop`. It proves the gateway parks instead of stranding. Never deploy
/// outside tests.
contract BrickableDistributor is IFeeDistributor {
    bool public bricked;
    uint256 public dropped;

    function setBricked(bool on) external {
        bricked = on;
    }

    function handleTransfer(address, address, uint256) external view {
        require(!bricked, "BRICK: hook");
    }

    function drop(address, uint256 amount) external {
        require(!bricked, "BRICK: drop");
        dropped += amount;
    }
}
