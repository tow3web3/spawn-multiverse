// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title SpawnToken — one creature, every chain.
/// @notice The hub instance pre-mints the entire global supply to the SpawnPad
/// (which runs the genesis curve). Spoke replicas start at zero and are minted
/// / burned by their chain's gateway as tokens cross chains, so the SUM of
/// supplies across all chains is always exactly the global supply.
contract SpawnToken is ERC20 {
    /// The protocol contract allowed to bridge-mint/burn: the pad on the hub,
    /// the gateway on a spoke.
    address public immutable controller;
    bool public immutable isHub;

    constructor(
        string memory name_,
        string memory symbol_,
        address controller_,
        bool isHub_,
        uint256 premint,
        address premintTo
    ) ERC20(name_, symbol_) {
        controller = controller_;
        isHub = isHub_;
        if (premint > 0) _mint(premintTo, premint);
    }

    function bridgeMint(address to, uint256 amount) external {
        require(msg.sender == controller, "ST: not controller");
        _mint(to, amount);
    }

    function bridgeBurn(address from, uint256 amount) external {
        require(msg.sender == controller, "ST: not controller");
        _burn(from, amount);
    }
}
