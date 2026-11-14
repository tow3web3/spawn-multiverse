// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICurveVenue} from "../ICurveVenue.sol";
import {InternalCurveVenue} from "../InternalCurveVenue.sol";

/// @title RecordingVenue — TEST ONLY. The internal curve behind a venue that
/// writes down the minimum the pad asked it to enforce, and then trades
/// WITHOUT enforcing it — so a test can read what the pad passed even for a
/// minimum no trade could meet (an enforcing venue would revert, and take
/// the record with it). Never deploy outside tests.
contract RecordingVenue is ICurveVenue {
    InternalCurveVenue public immutable inner;
    address public immutable pad;
    uint256 public lastBuyMin;
    uint256 public lastSellMin;

    modifier onlyPad() {
        require(msg.sender == pad, "VENUE: not pad");
        _;
    }

    constructor(address _pad) {
        pad = _pad;
        inner = new InternalCurveVenue(address(this));
    }

    function openMarket(address token) external onlyPad {
        inner.openMarket(token);
    }

    function execBuy(address token, uint256 usdIn, uint256 minOut) external onlyPad returns (uint256, uint256, bool) {
        lastBuyMin = minOut;
        return inner.execBuy(token, usdIn, 0);
    }

    function execSell(address token, uint256 tokensIn, uint256 minOut) external onlyPad returns (uint256) {
        lastSellMin = minOut;
        return inner.execSell(token, tokensIn, 0);
    }

    function spotPrice(address token) external view returns (uint256) {
        return inner.spotPrice(token);
    }

    function curveOf(address token) external view returns (Curve memory) {
        return inner.curveOf(token);
    }
}
