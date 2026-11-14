// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISandwichGateway {
    function buyTokenUsdc(address hubToken, uint256 usdcIn) external payable;

    function sellToken(address hubToken, uint256 tokens) external payable;

    function replicaOf(address hubToken) external view returns (address);
}

interface ISandwichEndpoint {
    function deliverAt(uint256 at) external;
}

/// @title Sandwicher — TEST ONLY. What a searcher does to a cross-chain order.
/// @notice A cross-chain BUY or SELL is public on its source chain minutes
/// before it executes on the hub, and LayerZero lets ANYONE execute a
/// verified packet. So the whole sandwich fits in ONE hub-chain transaction,
/// with no mempool race and no risk: trade on the hub chain's own gateway
/// (which settles at once), deliver the victim's packet at the price just
/// moved, trade back. This contract does exactly that against the mock
/// endpoint (`deliverAt` stands for `EndpointV2.lzReceive`). Never deploy
/// outside tests.
contract Sandwicher {
    /// A plain buy, so that this contract holds a bag before a sell-side
    /// sandwich.
    function buy(ISandwichGateway gateway, IERC20 dollar, address vault, address hubToken, uint256 amount) external {
        dollar.approve(vault, amount);
        gateway.buyTokenUsdc(hubToken, amount);
    }

    /// Buy `frontRun` dollars of `hubToken`, land the victim's BUY (queue
    /// position `at`), sell everything.
    function aroundBuy(
        ISandwichGateway gateway,
        IERC20 dollar,
        address vault,
        address hubToken,
        uint256 frontRun,
        ISandwichEndpoint endpoint,
        uint256 at
    ) external {
        dollar.approve(vault, frontRun);
        gateway.buyTokenUsdc(hubToken, frontRun);
        endpoint.deliverAt(at);
        gateway.sellToken(hubToken, IERC20(gateway.replicaOf(hubToken)).balanceOf(address(this)));
    }

    /// Sell the bag this contract holds, land the victim's SELL (queue
    /// position `at`), buy back with everything the sale paid.
    function aroundSell(
        ISandwichGateway gateway,
        IERC20 dollar,
        address vault,
        address hubToken,
        ISandwichEndpoint endpoint,
        uint256 at
    ) external {
        uint256 before = dollar.balanceOf(address(this));
        gateway.sellToken(hubToken, IERC20(gateway.replicaOf(hubToken)).balanceOf(address(this)));
        endpoint.deliverAt(at);
        uint256 paid = dollar.balanceOf(address(this)) - before;
        dollar.approve(vault, paid);
        gateway.buyTokenUsdc(hubToken, paid);
    }
}
