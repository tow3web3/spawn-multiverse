// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ICurveVenue — the price-discovery slot of the hub.
/// @notice The SpawnPad owns settlement: token custody, OmniUSD burn/mint,
/// omnichain messaging and the canonical event stream. WHERE price discovery
/// happens is a pluggable venue behind this interface:
///
///   - Locally / on an EVM hub: `InternalCurveVenue` — our own genesis curve
///     (constant-product with virtual reserves), then the omnipool.
///   - Production target: the hub lives on Solana and this slot is an adapter
///     over an ALREADY-INDEXED launch venue — Raydium LaunchLab or Meteora
///     DBC. Axiom / Photon / Bullx / Dexscreener index those programs today,
///     so curve-phase trades are visible on every terminal from the first
///     second, no integration deal required. Ascension graduates into
///     Raydium liquidity automatically.
///
/// The gateways never know which venue is live: they keep burning OmniUSD
/// and sending the same messages to the pad. One market, one price — only
/// the room where the market sits changes.
interface ICurveVenue {
    struct Curve {
        uint256 vBase;
        uint256 vTokens;
        uint256 sold;
        bool ascended;
    }

    /// Opens the market for a freshly spawned token.
    function openMarket(address token) external;

    /// ALL OR NOTHING (v7.2). Both trades take a minimum and REVERT under
    /// it — before touching any state — so the pad's refusal path does the
    /// rest: a buy rides home whole, a sold bag is re-delivered. The
    /// minimum is on what THIS call returns (tokens out, gross dollars
    /// out); 0 = none. A cross-chain order is public on its source chain
    /// minutes before it executes here, and anyone may deliver it: without
    /// a minimum enforced where the price is, it can be sandwiched inside
    /// one hub-chain transaction. Every venue must enforce it.
    ///
    /// AND IN TIME (v7.2). Both trades take a `deadline` — unix seconds on
    /// THIS chain's clock; 0 = none — and REVERT after it, the same way and
    /// for the same reason: a minimum protects a fresh order, not one that
    /// sat undelivered while the price moved away from it, and whoever
    /// delivers a stale order picks the moment. `block.timestamp ==
    /// deadline` is in time. Every venue must enforce it too.

    /// Executes a buy of up to `usdIn`. Returns the tokens bought, the USD
    /// actually spent (the pad refunds the remainder) and whether this buy
    /// completed the curve — ascension. Reverts if fewer than `minOut`
    /// tokens would be bought (a buy cut short by the end of the curve
    /// included), or after `deadline`.
    function execBuy(address token, uint256 usdIn, uint256 minOut, uint256 deadline)
        external
        returns (uint256 tokensOut, uint256 usdSpent, bool ascendedNow);

    /// Executes a sell. Returns the USD owed for it, before the pad's fee.
    /// Reverts if that is less than `minOut`, or after `deadline`.
    function execSell(address token, uint256 tokensIn, uint256 minOut, uint256 deadline)
        external
        returns (uint256 usdOut);

    function spotPrice(address token) external view returns (uint256);

    function curveOf(address token) external view returns (Curve memory);
}
