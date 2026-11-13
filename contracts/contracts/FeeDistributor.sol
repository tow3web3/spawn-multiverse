// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OmniUSD} from "./OmniUSD.sol";
import {Roles} from "./Roles.sol";

interface IFeeDistributor {
    function handleTransfer(address from, address to, uint256 amount) external;
}

/// @title FeeDistributor — the holders' share of trading fees, paid out HERE.
/// @notice One instance per user-facing chain. The hub splits each token's
/// holders pot pro-rata to where the supply lives; this chain's slice lands
/// in this contract (in this chain's OmniUSD) when someone pulls it. Holders
/// then claim with a pure local transaction on their own chain — no
/// cross-chain hop, no snapshot ceremony.
///
/// Accounting is the classic magnified-dividends-per-share pattern: every
/// token transfer reports in through its hook, so a holder's claimable
/// amount follows their balance automatically — buy more, earn more of the
/// next drop; sell, and the earned part stays claimable. Protocol accounts
/// (the gateway, this contract) hold inventory, not bags: they are excluded
/// and earn nothing.
contract FeeDistributor is IFeeDistributor, Roles {
    uint256 internal constant MAG = 2 ** 128;
    /// A drop only folds into the stream once at least this many shares
    /// (1,000 tokens) exist on this chain; until then it waits in
    /// `pendingOf`. Without a floor, a drop landing on a few wei of shares
    /// sends `magDPS` so high that `magDPS × balance` overflows on the next
    /// real mint — which reverts the token's transfer hook and bricks every
    /// delivery of that token on this chain. With the floor, that product
    /// stays below 2^255 until more than $1.7e14 has been dropped on one
    /// token here.
    uint256 public constant MIN_SHARES = 1_000e18;

    OmniUSD public immutable usd;
    /// This chain's protocol agent — the gateway. Only it can drop fees in.
    address public agent;

    mapping(address => bool) public excluded;
    /// Once sealed, the excluded set is final.
    bool public exclusionsSealed;
    /// Shares alive across every token of this chain. Exclusions are only
    /// legal while this is zero: excluding an account that already holds
    /// shares would leave them counted forever.
    uint256 public liveShares;

    // Everything below is keyed by the LOCAL token contract (this chain's
    // replica). The token itself is the caller of `handleTransfer`, so a
    // rogue contract can only corrupt its own key.
    mapping(address => uint256) public magDPS;
    mapping(address => uint256) public totalShares;
    /// Drops that arrive while too few shares exist wait here and fold into
    /// the stream as soon as holders reach MIN_SHARES.
    mapping(address => uint256) public pendingOf;
    mapping(address => mapping(address => uint256)) public sharesOf;
    mapping(address => mapping(address => int256)) internal corrections;
    mapping(address => mapping(address => uint256)) public withdrawnOf;

    event FeeDropped(address indexed token, uint256 amount);
    event HolderClaimed(address indexed token, address indexed holder, uint256 amount);
    event AgentSet(address agent);
    event Excluded(address indexed account);
    event ExclusionsSealed();

    constructor(OmniUSD _usd) {
        usd = _usd;
        excluded[address(this)] = true;
    }

    function setAgent(address a) external onlyAdmin {
        require(agent == address(0), "DIST: agent set");
        agent = a;
        excluded[a] = true;
        emit AgentSet(a);
        emit Excluded(a);
    }

    /// Wire-up only: legal until the set is sealed, and only while no share
    /// exists yet — so no live share ever needs resyncing.
    function exclude(address a) external onlyAdmin {
        require(!exclusionsSealed, "DIST: exclusions sealed");
        require(liveShares == 0, "DIST: shares live");
        excluded[a] = true;
        emit Excluded(a);
    }

    function sealExclusions() external onlyAdmin {
        exclusionsSealed = true;
        emit ExclusionsSealed();
    }

    /* ---------------------------- token hook ---------------------------- */

    /// Every replica reports its transfers here (mints come from the zero
    /// address, burns go to it). Shares mirror the balances of non-excluded
    /// accounts, with the standard per-account corrections so already-earned
    /// dividends never move when tokens do.
    function handleTransfer(address from, address to, uint256 amount) external {
        address token = msg.sender;
        if (amount > 0) {
            uint256 dec;
            uint256 inc;
            if (from != address(0) && !excluded[from]) {
                uint256 cur = sharesOf[token][from];
                dec = amount > cur ? cur : amount;
                if (dec > 0) _decrease(token, from, dec);
            }
            if (to != address(0) && !excluded[to]) {
                inc = amount;
                _increase(token, to, amount);
            }
            if (inc != dec) liveShares = liveShares + inc - dec;
        }
        _flush(token);
    }

    /* ------------------------------ drops ------------------------------ */

    /// Fold `amount` oUSD into the dividend stream for `token`'s current
    /// holders. The agent funds this contract with the same amount in the
    /// same transaction.
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
        if (p == 0 || s < MIN_SHARES) return;
        pendingOf[token] = 0;
        magDPS[token] += (p * MAG) / s;
    }
}
