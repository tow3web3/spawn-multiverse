// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOmniMessenger, IOmniReceiver} from "./OmniMessenger.sol";
import {OmniUSD} from "./OmniUSD.sol";
import {SpawnToken} from "./SpawnToken.sol";
import {ICurveVenue} from "./ICurveVenue.sol";

/// @title SpawnPad — the hub of the multiverse.
/// @notice One global market per token lives HERE, on the hub chain. The six
/// user-facing chains are entry points: their gateways forward buys and sells
/// as omnichain messages, the pad executes them against the single market,
/// and sends tokens (or USD) back. That is what makes the price identical on
/// every chain — there is only one market.
///
/// The pad owns SETTLEMENT: token custody, OmniUSD burn/mint, messaging and
/// the canonical `Spawned` / `Trade` / `Ascended` event stream (one address
/// for indexers to watch). PRICE DISCOVERY is delegated to a pluggable
/// `ICurveVenue` — the internal genesis curve locally, a Raydium LaunchLab /
/// Meteora DBC adapter on the production Solana hub, so curve-phase trades
/// are visible on Axiom / Dexscreener from the first second.
contract SpawnPad is IOmniReceiver {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint32 public constant HUB_CHAIN = 0;

    // Message opcodes (gateway -> pad)
    uint8 internal constant OP_SPAWN = 1;
    uint8 internal constant OP_BUY = 2;
    uint8 internal constant OP_SELL = 3;
    // Message opcodes (pad -> gateway)
    uint8 internal constant OP_SYNC_TOKEN = 10;
    uint8 internal constant OP_DELIVER = 11;
    uint8 internal constant OP_PAYOUT = 12;

    struct Meta {
        string name;
        string symbol;
        string metaURI;
        address creator;
        uint64 spawnedAt;
        uint32 homeChain;
    }

    IOmniMessenger public immutable messenger;
    OmniUSD public immutable usd; // hub instance
    address public immutable admin;
    ICurveVenue public venue;

    uint32[] public chainLabels;
    mapping(uint32 => address) public gateways;
    mapping(address => uint32) public gatewayChain;

    address[] public allTokens;
    mapping(address => Meta) public metas;

    event Spawned(
        address indexed token,
        address indexed creator,
        uint32 homeChain,
        string name,
        string symbol,
        string metaURI
    );
    event Trade(
        address indexed token,
        uint32 indexed chain,
        address indexed trader,
        bool isBuy,
        uint256 usd,
        uint256 tokens,
        uint256 priceAfter,
        uint64 ts
    );
    event Ascended(address indexed token, uint256 raisedUsd, uint64 ts);

    constructor(IOmniMessenger _messenger, OmniUSD _usd) {
        messenger = _messenger;
        usd = _usd;
        admin = msg.sender;
    }

    function setVenue(ICurveVenue v) external {
        require(msg.sender == admin, "PAD: not admin");
        require(address(venue) == address(0), "PAD: venue set");
        venue = v;
    }

    function setGateway(uint32 chain, address gw) external {
        require(msg.sender == admin, "PAD: not admin");
        require(gateways[chain] == address(0), "PAD: gateway set");
        gateways[chain] = gw;
        gatewayChain[gw] = chain;
        chainLabels.push(chain);
    }

    /* ---------------------------- views ---------------------------- */

    function tokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    function spotPrice(address token) public view returns (uint256) {
        return venue.spotPrice(token);
    }

    /// Facade over the live venue, so tooling reads one address.
    function curves(address token) external view returns (ICurveVenue.Curve memory) {
        return venue.curveOf(token);
    }

    /// Everything the UI needs for one token, in one call.
    function getToken(uint256 i)
        external
        view
        returns (
            address token,
            string memory name,
            string memory symbol,
            string memory metaURI,
            address creator,
            uint64 spawnedAt,
            uint32 homeChain,
            uint256 vBase,
            uint256 vTokens,
            uint256 sold,
            bool ascended,
            uint256 price
        )
    {
        token = allTokens[i];
        Meta storage m = metas[token];
        ICurveVenue.Curve memory c = venue.curveOf(token);
        return (
            token,
            m.name,
            m.symbol,
            m.metaURI,
            m.creator,
            m.spawnedAt,
            m.homeChain,
            c.vBase,
            c.vTokens,
            c.sold,
            c.ascended,
            venue.spotPrice(token)
        );
    }

    /* -------------------------- messaging -------------------------- */

    function onOmniMessage(uint32 srcChain, address srcSender, bytes calldata payload) external {
        require(msg.sender == address(messenger), "PAD: not messenger");
        require(gateways[srcChain] == srcSender, "PAD: not a gateway");
        (uint8 op, bytes memory data) = abi.decode(payload, (uint8, bytes));
        if (op == OP_SPAWN) {
            (
                address creator,
                string memory name,
                string memory symbol,
                string memory metaURI,
                uint256 devBuyUsd
            ) = abi.decode(data, (address, string, string, string, uint256));
            _spawn(srcChain, creator, name, symbol, metaURI, devBuyUsd);
        } else if (op == OP_BUY) {
            (address token, address buyer, uint256 usdIn) = abi.decode(
                data,
                (address, address, uint256)
            );
            _buy(srcChain, token, buyer, usdIn);
        } else if (op == OP_SELL) {
            (address token, address seller, uint256 tokensIn) = abi.decode(
                data,
                (address, address, uint256)
            );
            _sell(srcChain, token, seller, tokensIn);
        } else {
            revert("PAD: bad op");
        }
    }

    /* --------------------------- protocol --------------------------- */

    function _spawn(
        uint32 srcChain,
        address creator,
        string memory name,
        string memory symbol,
        string memory metaURI,
        uint256 devBuyUsd
    ) internal {
        SpawnToken token = new SpawnToken(name, symbol, address(this), true, TOTAL_SUPPLY, address(this));
        allTokens.push(address(token));
        metas[address(token)] = Meta(name, symbol, metaURI, creator, uint64(block.timestamp), srcChain);
        venue.openMarket(address(token));
        emit Spawned(address(token), creator, srcChain, name, symbol, metaURI);

        // One genesis, every chain: deploy a native replica on each spoke.
        for (uint256 i = 0; i < chainLabels.length; i++) {
            uint32 ch = chainLabels[i];
            messenger.send(
                ch,
                gateways[ch],
                abi.encode(OP_SYNC_TOKEN, abi.encode(address(token), name, symbol))
            );
        }

        if (devBuyUsd > 0) _buy(srcChain, address(token), creator, devBuyUsd);
    }

    function _buy(uint32 srcChain, address token, address buyer, uint256 usdIn) internal {
        // The spoke burned the buyer's OmniUSD; the value re-materializes here.
        usd.bridgeMint(address(this), usdIn);

        // Price discovery is the venue's job; settlement stays here.
        (uint256 out, uint256 spend, bool ascendedNow) = venue.execBuy(token, usdIn);
        uint256 refund = usdIn - spend;
        if (ascendedNow) {
            emit Ascended(token, venue.curveOf(token).vBase, uint64(block.timestamp));
        }

        // Ship the creature to the buyer's chain (burn hub-side, mint spoke-side).
        SpawnToken(token).bridgeBurn(address(this), out);
        if (refund > 0) usd.bridgeBurn(address(this), refund);
        messenger.send(
            srcChain,
            gateways[srcChain],
            abi.encode(OP_DELIVER, abi.encode(token, buyer, out, refund))
        );

        emit Trade(token, srcChain, buyer, true, spend, out, venue.spotPrice(token), uint64(block.timestamp));
    }

    function _sell(uint32 srcChain, address token, address seller, uint256 tokensIn) internal {
        // The spoke burned the seller's replicas; they re-materialize in inventory.
        SpawnToken(token).bridgeMint(address(this), tokensIn);

        uint256 usdOut = venue.execSell(token, tokensIn);

        // Pay the seller out on their chain.
        usd.bridgeBurn(address(this), usdOut);
        messenger.send(srcChain, gateways[srcChain], abi.encode(OP_PAYOUT, abi.encode(seller, usdOut)));

        emit Trade(token, srcChain, seller, false, usdOut, tokensIn, venue.spotPrice(token), uint64(block.timestamp));
    }
}
