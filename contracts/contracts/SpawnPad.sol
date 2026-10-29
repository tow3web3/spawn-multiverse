// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOmniMessenger, IOmniReceiver} from "./OmniMessenger.sol";
import {OmniUSD} from "./OmniUSD.sol";
import {SpawnToken} from "./SpawnToken.sol";

/// @title SpawnPad — the hub of the multiverse.
/// @notice One global genesis curve per token lives HERE, on the hub chain.
/// The six user-facing chains are entry points: their gateways forward buys
/// and sells as omnichain messages, the pad executes them against the single
/// curve, and sends tokens (or USD) back. That is what makes the price
/// identical on every chain — there is only one market.
///
/// Phase 1 (curve): constant-product with virtual reserves, pump.fun style.
/// Phase 2 (omnipool): when CURVE_SUPPLY is sold the token "ascends" — the
/// raised OmniUSD plus the reserved POOL_SUPPLY become a real constant-product
/// pool, owned by the protocol forever (liquidity can never be pulled).
contract SpawnPad is IOmniReceiver {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_SUPPLY = 800_000_000e18;
    uint256 public constant POOL_SUPPLY = TOTAL_SUPPLY - CURVE_SUPPLY;
    uint256 public constant V_BASE_0 = 6_000e18;
    uint256 public constant V_TOKENS_0 = 1_073_000_000e18;
    uint32 public constant HUB_CHAIN = 0;

    // Message opcodes (gateway -> pad)
    uint8 internal constant OP_SPAWN = 1;
    uint8 internal constant OP_BUY = 2;
    uint8 internal constant OP_SELL = 3;
    // Message opcodes (pad -> gateway)
    uint8 internal constant OP_SYNC_TOKEN = 10;
    uint8 internal constant OP_DELIVER = 11;
    uint8 internal constant OP_PAYOUT = 12;

    struct Curve {
        uint256 vBase;
        uint256 vTokens;
        uint256 sold;
        bool ascended;
    }

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

    uint32[] public chainLabels;
    mapping(uint32 => address) public gateways;
    mapping(address => uint32) public gatewayChain;

    address[] public allTokens;
    mapping(address => Curve) public curves;
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
        Curve storage c = curves[token];
        if (c.vTokens == 0) return 0;
        return (c.vBase * 1e18) / c.vTokens;
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
        Curve storage c = curves[token];
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
            spotPrice(token)
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
        curves[address(token)] = Curve(V_BASE_0, V_TOKENS_0, 0, false);
        metas[address(token)] = Meta(name, symbol, metaURI, creator, uint64(block.timestamp), srcChain);
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
        Curve storage c = curves[token];
        require(c.vTokens > 0, "PAD: unknown token");
        require(usdIn > 0, "PAD: zero buy");

        // The spoke burned the buyer's OmniUSD; the value re-materializes here.
        usd.bridgeMint(address(this), usdIn);

        uint256 k = c.vBase * c.vTokens;
        uint256 out = c.vTokens - k / (c.vBase + usdIn);
        uint256 spend = usdIn;
        uint256 refund = 0;

        if (!c.ascended) {
            uint256 remaining = CURVE_SUPPLY - c.sold;
            if (out >= remaining) {
                out = remaining;
                spend = k / (c.vTokens - out) - c.vBase + 1;
                if (spend > usdIn) spend = usdIn;
                refund = usdIn - spend;
            }
            require(out > 0, "PAD: dust");
            c.vBase += spend;
            c.vTokens -= out;
            c.sold += out;
            if (c.sold >= CURVE_SUPPLY) {
                // Ascension: raised USD + reserved supply seed the omnipool.
                uint256 raised = c.vBase - V_BASE_0;
                c.vBase = raised;
                c.vTokens = POOL_SUPPLY;
                c.ascended = true;
                emit Ascended(token, raised, uint64(block.timestamp));
            }
        } else {
            require(out > 0, "PAD: dust");
            c.vBase += usdIn;
            c.vTokens -= out;
        }

        // Ship the creature to the buyer's chain (burn hub-side, mint spoke-side).
        SpawnToken(token).bridgeBurn(address(this), out);
        if (refund > 0) usd.bridgeBurn(address(this), refund);
        messenger.send(
            srcChain,
            gateways[srcChain],
            abi.encode(OP_DELIVER, abi.encode(token, buyer, out, refund))
        );

        emit Trade(token, srcChain, buyer, true, spend, out, spotPrice(token), uint64(block.timestamp));
    }

    function _sell(uint32 srcChain, address token, address seller, uint256 tokensIn) internal {
        Curve storage c = curves[token];
        require(c.vTokens > 0, "PAD: unknown token");
        require(tokensIn > 0, "PAD: zero sell");

        // The spoke burned the seller's replicas; they re-materialize in inventory.
        SpawnToken(token).bridgeMint(address(this), tokensIn);

        uint256 k = c.vBase * c.vTokens;
        uint256 usdOut = c.vBase - k / (c.vTokens + tokensIn);
        require(usdOut > 0, "PAD: dust");
        c.vBase -= usdOut;
        c.vTokens += tokensIn;
        if (!c.ascended) {
            c.sold = c.sold > tokensIn ? c.sold - tokensIn : 0;
        }

        // Pay the seller out on their chain.
        usd.bridgeBurn(address(this), usdOut);
        messenger.send(srcChain, gateways[srcChain], abi.encode(OP_PAYOUT, abi.encode(seller, usdOut)));

        emit Trade(token, srcChain, seller, false, usdOut, tokensIn, spotPrice(token), uint64(block.timestamp));
    }
}
