// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICurveVenue} from "./ICurveVenue.sol";

/// @title InternalCurveVenue — the built-in genesis curve.
/// @notice Phase 1: constant-product with virtual reserves (pump.fun style),
/// 800M of the 1B supply sold on the curve. Phase 2: when the curve fills,
/// the token ascends — raised USD + the reserved 200M seed the omnipool.
///
/// Pure accounting: the pad keeps custody of every token and all OmniUSD;
/// this contract only decides prices and amounts. That is what makes the
/// venue swappable for a Raydium LaunchLab / Meteora DBC adapter without
/// touching settlement or the gateways (see ICurveVenue).
///
/// ROUNDING IS ALWAYS AGAINST THE TRADER. Every trade computes the new
/// reserve on the other side with a CEILING division, so `vBase × vTokens`
/// never decreases. With `vTokens` never above its starting value (a sell
/// can only return what a buy took out), that keeps `vBase ≥ V_BASE_0`: the
/// curve can never owe more dollars than were paid in. Rounding the other
/// way — as this contract did before v7 — let a 1-wei sell take a whole wei
/// of oUSD and left the pad a wei short of its own fee pots, which is a
/// revert on the message path the day someone tries to burn the last wei.
contract InternalCurveVenue is ICurveVenue {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_SUPPLY = 800_000_000e18;
    uint256 public constant POOL_SUPPLY = TOTAL_SUPPLY - CURVE_SUPPLY;
    uint256 public constant V_BASE_0 = 6_000e18;
    uint256 public constant V_TOKENS_0 = 1_073_000_000e18;

    address public immutable pad;
    mapping(address => Curve) internal _curves;

    modifier onlyPad() {
        require(msg.sender == pad, "VENUE: not pad");
        _;
    }

    constructor(address _pad) {
        pad = _pad;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function openMarket(address token) external onlyPad {
        require(_curves[token].vTokens == 0, "VENUE: market open");
        _curves[token] = Curve(V_BASE_0, V_TOKENS_0, 0, false);
    }

    /// An order that lands after its deadline is no order: it is turned
    /// away before anything is looked at (0 = no deadline; the second
    /// itself is in time).
    function _inTime(uint256 deadline) internal view {
        require(deadline == 0 || block.timestamp <= deadline, "VENUE: expired");
    }

    function execBuy(address token, uint256 usdIn, uint256 minOut, uint256 deadline)
        external
        onlyPad
        returns (uint256 out, uint256 spend, bool ascendedNow)
    {
        _inTime(deadline);
        Curve storage c = _curves[token];
        require(c.vTokens > 0, "VENUE: unknown token");
        require(usdIn > 0, "VENUE: zero buy");

        uint256 k = c.vBase * c.vTokens;
        out = c.vTokens - _ceilDiv(k, c.vBase + usdIn);
        spend = usdIn;

        if (!c.ascended) {
            uint256 remaining = CURVE_SUPPLY - c.sold;
            if (out >= remaining) {
                // The buy overshoots the curve: cap at the remainder, charge
                // only what that costs (+1 rounds against the buyer).
                out = remaining;
                spend = k / (c.vTokens - out) - c.vBase + 1;
                if (spend > usdIn) spend = usdIn;
            }
            require(out > 0, "VENUE: dust");
            // all or nothing: a fill under the minimum — the cap just above
            // included — is no fill
            require(out >= minOut, "VENUE: min out");
            c.vBase += spend;
            c.vTokens -= out;
            c.sold += out;
            if (c.sold >= CURVE_SUPPLY) {
                // Ascension: raised USD + reserved supply seed the omnipool.
                c.vBase = c.vBase - V_BASE_0;
                c.vTokens = POOL_SUPPLY;
                c.ascended = true;
                ascendedNow = true;
            }
        } else {
            require(out > 0, "VENUE: dust");
            require(out >= minOut, "VENUE: min out");
            c.vBase += spend;
            c.vTokens -= out;
        }
    }

    function execSell(address token, uint256 tokensIn, uint256 minOut, uint256 deadline)
        external
        onlyPad
        returns (uint256 usdOut)
    {
        _inTime(deadline);
        Curve storage c = _curves[token];
        require(c.vTokens > 0, "VENUE: unknown token");
        require(tokensIn > 0, "VENUE: zero sell");

        uint256 k = c.vBase * c.vTokens;
        usdOut = c.vBase - _ceilDiv(k, c.vTokens + tokensIn);
        require(usdOut > 0, "VENUE: dust");
        require(usdOut >= minOut, "VENUE: min out");
        c.vBase -= usdOut;
        c.vTokens += tokensIn;
        if (!c.ascended) {
            c.sold = c.sold > tokensIn ? c.sold - tokensIn : 0;
        }
    }

    function spotPrice(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        if (c.vTokens == 0) return 0;
        return (c.vBase * 1e18) / c.vTokens;
    }

    function curveOf(address token) external view returns (Curve memory) {
        return _curves[token];
    }
}
