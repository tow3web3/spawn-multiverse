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

    /// Executes a buy of up to `usdIn`. Returns the tokens bought, the USD
    /// actually spent (the pad refunds the remainder) and whether this buy
    /// completed the curve — ascension.
    function execBuy(address token, uint256 usdIn)
        external
        returns (uint256 tokensOut, uint256 usdSpent, bool ascendedNow);

    /// Executes a sell. Returns the USD owed to the seller.
    function execSell(address token, uint256 tokensIn) external returns (uint256 usdOut);

    function spotPrice(address token) external view returns (uint256);

    function curveOf(address token) external view returns (Curve memory);
}
