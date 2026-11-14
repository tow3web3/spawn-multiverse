// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICurveVenue} from "../ICurveVenue.sol";
import {InternalCurveVenue} from "../InternalCurveVenue.sol";

/// @title FlakyVenue — TEST ONLY. The internal curve behind a switch that
/// makes it refuse trades, standing in for any venue that can say no (a
/// paused pool, a slippage guard, dust). Never deploy outside tests.
contract FlakyVenue is ICurveVenue {
    InternalCurveVenue public immutable inner;
    address public immutable pad;
    bool public refuse;
    /// How many more buys go through before the venue starts refusing them
    /// (max = no limit). Lets a test let the user's buy pass and refuse the
    /// buyback it triggers.
    uint256 public buysLeft = type(uint256).max;

    modifier onlyPad() {
        require(msg.sender == pad, "VENUE: not pad");
        _;
    }

    constructor(address _pad) {
        pad = _pad;
        inner = new InternalCurveVenue(address(this));
    }

    function setRefuse(bool on) external {
        refuse = on;
    }

    function setBuysLeft(uint256 n) external {
        buysLeft = n;
    }

    function openMarket(address token) external onlyPad {
        inner.openMarket(token);
    }

    function execBuy(address token, uint256 usdIn, uint256 minOut, uint256 deadline)
        external
        onlyPad
        returns (uint256, uint256, bool)
    {
        require(!refuse && buysLeft > 0, "FLAKY: refused");
        if (buysLeft != type(uint256).max) buysLeft--;
        return inner.execBuy(token, usdIn, minOut, deadline);
    }

    function execSell(address token, uint256 tokensIn, uint256 minOut, uint256 deadline)
        external
        onlyPad
        returns (uint256)
    {
        require(!refuse, "FLAKY: refused");
        return inner.execSell(token, tokensIn, minOut, deadline);
    }

    function spotPrice(address token) external view returns (uint256) {
        return inner.spotPrice(token);
    }

    function curveOf(address token) external view returns (Curve memory) {
        return inner.curveOf(token);
    }
}
