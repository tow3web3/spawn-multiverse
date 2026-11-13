// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC — TESTS AND TESTNETS ONLY. Never deploy to a mainnet.
/// @notice A 6-decimal stand-in for Circle's USDC so testnets and the local
/// world run the exact mainnet settlement contracts. Anyone can mint (it is
/// play money), and the admin can blacklist accounts the way Circle can —
/// which is what lets the suite prove payouts survive a blacklisted
/// recipient.
contract MockUSDC is ERC20 {
    uint256 public constant MAX_MINT = 100_000e6;

    address public immutable admin;
    mapping(address => bool) public blacklisted;

    constructor() ERC20("USD Coin (mock)", "USDC") {
        admin = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open faucet — anyone can print play dollars.
    function mint(address to, uint256 amount) external {
        require(amount <= MAX_MINT, "USDC: greedy");
        _mint(to, amount);
    }

    function setBlacklisted(address account, bool on) external {
        require(msg.sender == admin, "USDC: not admin");
        blacklisted[account] = on;
    }

    /// Mirrors real USDC: a blacklisted account can neither send nor receive.
    function _update(address from, address to, uint256 value) internal override {
        require(!blacklisted[from] && !blacklisted[to], "Blacklistable: account is blacklisted");
        super._update(from, to, value);
    }
}
