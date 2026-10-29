// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title OmniUSD — the demo omnichain settlement currency.
/// @notice One instance lives on each logical chain. Value moves across chains
/// by burn-on-source / mint-on-destination, driven by the protocol agent of
/// each chain (the SpawnPad on the hub, the SpawnGateway on a spoke). In
/// production this slot is filled by USDC moved with Circle CCTP — exactly the
/// same burn/mint pattern.
contract OmniUSD is ERC20 {
    address public immutable admin;
    uint32 public immutable chainLabel;
    address public agent;

    constructor(uint32 _chainLabel) ERC20("OmniUSD", "oUSD") {
        admin = msg.sender;
        chainLabel = _chainLabel;
    }

    function setAgent(address a) external {
        require(msg.sender == admin, "oUSD: not admin");
        require(agent == address(0), "oUSD: agent set");
        agent = a;
    }

    /// @notice Demo faucet — anyone can print play money.
    function faucet(address to, uint256 amount) external {
        require(amount <= 100_000e18, "oUSD: greedy");
        _mint(to, amount);
    }

    function bridgeMint(address to, uint256 amount) external {
        require(msg.sender == agent, "oUSD: not agent");
        _mint(to, amount);
    }

    function bridgeBurn(address from, uint256 amount) external {
        require(msg.sender == agent, "oUSD: not agent");
        _burn(from, amount);
    }
}
