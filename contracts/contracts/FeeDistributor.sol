// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OmniUSD} from "./OmniUSD.sol";

interface IFeeDistributor {
    function handleTransfer(address from, address to, uint256 amount) external;
}

/// @title FeeDistributor — the holders' share of trading fees, paid out HERE.
/// @notice One instance per chain. The hub splits each token's holders pot
/// pro-rata to where the supply lives and drops each chain's slice into this
/// contract (in this chain's OmniUSD). Holders then claim with a pure local
/// transaction on their own chain — no cross-chain hop, no snapshot ceremony.
///
/// Accounting is the classic magnified-dividends-per-share pattern: every
/// token transfer reports in through its hook, so a holder's claimable
/// amount follows their balance automatically — buy more, earn more of the
/// next drop; sell, and the earned part stays claimable. Protocol accounts
/// (pad, venue, gateways, this contract) hold inventory, not bags: they are
/// excluded and earn nothing.
contract FeeDistributor is IFeeDistributor {
    uint256 internal constant MAG = 2 ** 128;

    OmniUSD public immutable usd;
    address public immutable admin;
    /// This chain's protocol agent — the pad on the hub, the gateway on a
    /// spoke. Only it can drop fees in.
    address public agent;

    mapping(address => bool) public excluded;

    // Everything below is keyed by the LOCAL token contract: the hub token
    // on the hub, the replica on a spoke. The token itself is the caller of
    // `handleTransfer`, so a rogue contract can only corrupt its own key.
    mapping(address => uint256) public magDPS;
    mapping(address => uint256) public totalShares;
    /// Drops that arrive while nobody holds the token wait here and fold
    /// into the stream as soon as the first holder appears.
    mapping(address => uint256) public pendingOf;
    mapping(address => mapping(address => uint256)) public sharesOf;
    mapping(address => mapping(address => int256)) internal corrections;
    mapping(address => mapping(address => uint256)) public withdrawnOf;

    event FeeDropped(address indexed token, uint256 amount);
    event HolderClaimed(address indexed token, address indexed holder, uint256 amount);

    constructor(OmniUSD _usd) {
        usd = _usd;
        admin = msg.sender;
        excluded[address(this)] = true;
    }

    function setAgent(address a) external {
        require(msg.sender == admin, "DIST: not admin");
        require(agent == address(0), "DIST: agent set");
        agent = a;
        excluded[a] = true;
    }

    /// Wire-up only: exclusions are set before the first token exists, so no
    /// live shares ever need resyncing.
    function exclude(address a) external {
        require(msg.sender == admin, "DIST: not admin");
        excluded[a] = true;
    }

    /* ---------------------------- token hook ---------------------------- */

    /// Every SpawnToken reports its transfers here (mints come from the zero
    /// address, burns go to it). Shares mirror the balances of non-excluded
    /// accounts, with the standard per-account corrections so already-earned
    /// dividends never move when tokens do.
    function handleTransfer(address from, address to, uint256 amount) external {
        address token = msg.sender;
        if (amount > 0) {
            if (from != address(0) && !excluded[from]) {
                uint256 cur = sharesOf[token][from];
                _decrease(token, from, amount > cur ? cur : amount);
            }
            if (to != address(0) && !excluded[to]) {
                _increase(token, to, amount);
            }
        }
        _flush(token);
    }

    /* ------------------------------ drops ------------------------------ */

    /// The agent has already moved `amount` oUSD into this contract; fold it
    /// into the dividend stream for `token`'s current holders.
    function drop(address token, uint256 amount) external {
        require(msg.sender == agent, "DIST: not agent");
        pendingOf[token] += amount;
        _flush(token);
        emit FeeDropped(token, amount);
    }

    /* ------------------------------ claims ------------------------------ */

    /// Total ever earned by `account` on `token` drops.
    function accumulated(address token, address account) public view returns (uint256) {
        return
            uint256(int256(magDPS[token] * sharesOf[token][account]) + corrections[token][account]) /
            MAG;
    }

    function withdrawable(address token, address account) public view returns (uint256) {
        return accumulated(token, account) - withdrawnOf[token][account];
    }

    function claim(address token) external returns (uint256 amount) {
        amount = withdrawable(token, msg.sender);
        require(amount > 0, "DIST: nothing to claim");
        withdrawnOf[token][msg.sender] += amount;
        usd.transfer(msg.sender, amount);
        emit HolderClaimed(token, msg.sender, amount);
    }

    /* ----------------------------- internal ----------------------------- */

    function _increase(address token, address account, uint256 x) internal {
        sharesOf[token][account] += x;
        totalShares[token] += x;
        corrections[token][account] -= int256(magDPS[token] * x);
    }

    function _decrease(address token, address account, uint256 x) internal {
        sharesOf[token][account] -= x;
        totalShares[token] -= x;
        corrections[token][account] += int256(magDPS[token] * x);
    }

    function _flush(address token) internal {
        uint256 p = pendingOf[token];
        uint256 s = totalShares[token];
        if (p == 0 || s == 0) return;
        pendingOf[token] = 0;
        magDPS[token] += (p * MAG) / s;
    }
}
