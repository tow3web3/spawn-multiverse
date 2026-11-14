// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockDollar — a stand-in dollar token of any decimals (tests only).
/// @notice Open `mint`, like MockUSDC, plus the ways a real dollar can
/// misbehave from a vault's point of view: an issuer freeze on an account, a
/// fee taken on every transfer, and a transfer hook that calls back into a
/// vault (what an upgrade of the token could one day do).
contract MockDollar is ERC20 {
    uint8 private immutable _decimals;
    address public immutable admin;

    /// Accounts the "issuer" froze: transfers from or to them revert.
    mapping(address => bool) public frozen;
    /// Basis points burned out of every transfer (fee-on-transfer).
    uint16 public feeBps;
    /// When armed: the next transfer INTO `reentryVault` re-enters it.
    address public reentryVault;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
        admin = msg.sender;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFrozen(address account, bool on) external {
        require(msg.sender == admin, "MOCK: not admin");
        frozen[account] = on;
    }

    function setFeeBps(uint16 bps) external {
        require(msg.sender == admin, "MOCK: not admin");
        feeBps = bps;
    }

    /// Makes this token re-enter `vault.unwrap` during the next deposit —
    /// the reentrancy a vault must refuse. (`unwrap` because both vaults
    /// have it and guard it; `OmniUSDLocal` has no `wrap` since v7.2.)
    function armReentry(address vault) external {
        require(msg.sender == admin, "MOCK: not admin");
        _mint(address(this), 10 ** uint256(_decimals));
        _approve(address(this), vault, type(uint256).max);
        reentryVault = vault;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!frozen[from] && !frozen[to], "MOCK: frozen");
        if (reentryVault != address(0) && to == reentryVault && from != address(this)) {
            address vault = reentryVault;
            reentryVault = address(0);
            (bool ok, bytes memory ret) = vault.call(abi.encodeWithSignature("unwrap(uint256)", 10 ** uint256(_decimals)));
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        uint256 fee = from != address(0) && to != address(0) ? (value * feeBps) / 10_000 : 0;
        super._update(from, to, value - fee);
        if (fee > 0) super._update(from, address(0), fee);
    }
}

/// @title MockNoReturnDollar — a dollar whose `transfer`, `transferFrom` and
/// `approve` return NOTHING (USDT on Ethereum behaves this way). Tests only.
contract MockNoReturnDollar {
    string public name = "No Return Dollar";
    string public symbol = "NRUSD";
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 value) external {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
    }

    function transfer(address to, uint256 value) external {
        _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external {
        uint256 a = allowance[from][msg.sender];
        require(a >= value, "NR: allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        _move(from, to, value);
    }

    function _move(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "NR: balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
