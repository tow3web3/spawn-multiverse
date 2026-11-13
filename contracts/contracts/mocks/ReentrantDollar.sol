// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title ReentrantDollar — TEST ONLY. A dollar token with a transfer hook
/// (what an ERC-777-style upgrade of a real dollar would be): when armed, the
/// next transfer between two accounts makes ONE call of the test's choosing,
/// records whether it went through, and lets the transfer finish either way.
/// It proves that nothing a dollar token does in the middle of a deposit or
/// of a payout can get back into the gateway. Never deploy outside tests.
contract ReentrantDollar is ERC20 {
    uint8 private immutable _decimals;

    address public target;
    bytes public data;
    /// How many transfers to let through before the hook fires (0 = the
    /// next one). Lets a test aim at the payout rather than the deposit.
    uint256 public skip;
    bool public fired;
    bool public ok;
    bytes public ret;

    constructor(uint8 decimals_) ERC20("Reentrant Dollar", "RUSD") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata data_, uint256 skip_) external {
        target = target_;
        data = data_;
        skip = skip_;
        fired = false;
        ok = false;
        delete ret;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (target == address(0) || from == address(0) || to == address(0)) return;
        if (skip > 0) {
            skip--;
            return;
        }
        address t = target;
        target = address(0);
        fired = true;
        (ok, ret) = t.call(data);
    }
}
