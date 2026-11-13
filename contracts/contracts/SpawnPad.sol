// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOmniMessenger, IOmniReceiver} from "./OmniMessenger.sol";
import {OmniUSD} from "./OmniUSD.sol";
import {SpawnToken} from "./SpawnToken.sol";
import {ICurveVenue} from "./ICurveVenue.sol";
import {FeeDistributor} from "./FeeDistributor.sol";

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

    /// 1% on every trade, routed per the token's launch-time fee mode.
    uint256 public constant FEE_BPS = 100;
    /// Burn mode buys back in chunks, not dust.
    uint256 public constant BURN_TRIGGER = 4e18;
    /// Holder modes distribute in chunks too — cross-chain drops aren't free.
    uint256 public constant DIST_TRIGGER = 2e18;

    /// FAIR GENESIS (v6) — the anti-snipe opening. For GENESIS_WINDOW seconds
    /// after spawn every buy pays FEE_BPS plus a snipe tax that starts at
    /// SNIPE_MAX_BPS and decays linearly to zero, each actor may spend at most
    /// GENESIS_MAX_USD, and the spawn block itself accepts no buys at all
    /// ("block 0 does not exist"). The tax rides the token's fee mode like any
    /// other fee — snipers pay everyone else.
    uint256 public constant GENESIS_WINDOW = 600;
    uint256 public constant SNIPE_MAX_BPS = 2900;
    uint256 public constant GENESIS_MAX_USD = 250e18;

    // Fee modes (locked at launch, forever)
    uint8 public constant FEE_HOLDERS = 0; // 100% streams to holders
    uint8 public constant FEE_SPLIT = 1; // 50/50 holders & dev
    uint8 public constant FEE_DEV = 2; // 100% to the dev, claimable
    uint8 public constant FEE_BURN = 3; // auto buyback & burn

    // Message opcodes (gateway -> pad)
    uint8 internal constant OP_SPAWN = 1;
    uint8 internal constant OP_BUY = 2;
    uint8 internal constant OP_SELL = 3;
    uint8 internal constant OP_CLAIM = 4;
    // Message opcodes (pad -> gateway)
    uint8 internal constant OP_SYNC_TOKEN = 10;
    uint8 internal constant OP_DELIVER = 11;
    uint8 internal constant OP_PAYOUT = 12;
    uint8 internal constant OP_FEE_DROP = 13;

    struct Meta {
        string name;
        string symbol;
        string metaURI;
        /// Wide identity (v5): a creator may live on a 32-byte chain. EVM
        /// creators are stored left-padded; they are never downcast here —
        /// the hub pays and delivers by MESSAGE, not by local transfer.
        bytes32 creator;
        uint64 spawnedAt;
        uint32 homeChain;
    }

    /// One global fee pot per token — fees from all six chains land HERE,
    /// because there is only one market. That is what makes holder streams,
    /// dev claims and buyback&burn single-pot problems instead of six.
    struct FeeState {
        uint8 mode;
        uint256 total;
        uint256 holders;
        uint256 dev;
        uint256 devClaimed;
        uint256 burnPot;
        uint256 burnedUsd;
        uint256 burnedTokens;
        uint256 holdersPaid;
    }

    IOmniMessenger public immutable messenger;
    OmniUSD public immutable usd; // hub instance
    address public immutable admin;
    ICurveVenue public venue;
    FeeDistributor public distributor; // hub-chain instance

    uint32[] public chainLabels;
    /// Gateways are wide too (v5): a Solana gateway is an OApp store pubkey,
    /// not an EVM address. EVM gateways are stored left-padded.
    mapping(uint32 => bytes32) public gateways;
    mapping(bytes32 => uint32) public gatewayChain;

    address[] public allTokens;
    mapping(address => Meta) public metas;
    mapping(address => FeeState) public feesOf;
    /// Where each token's circulating supply lives, maintained at every
    /// mint/burn the hub orchestrates. The pad's own custody (curve
    /// inventory) is not circulating, so Σ over labels ≡ supply sold out of
    /// the curve and still alive.
    mapping(address => mapping(uint32 => uint256)) public supplyByChain;
    /// FAIR GENESIS bookkeeping: the hub block each token spawned in (its
    /// "block 0", where buys bounce) and what each wide actor has spent
    /// during the token's genesis window.
    mapping(address => uint256) public spawnBlock;
    mapping(address => mapping(bytes32 => uint256)) public genesisSpent;

    // Actors in events are wide (v5): an EVM actor shows up left-padded, a
    // Solana one as its raw 32-byte key. Token addresses stay `address` —
    // tokens always live on the hub.
    event Spawned(
        address indexed token,
        bytes32 indexed creator,
        uint32 homeChain,
        string name,
        string symbol,
        string metaURI
    );
    event Trade(
        address indexed token,
        uint32 indexed chain,
        bytes32 indexed trader,
        bool isBuy,
        uint256 usd,
        uint256 tokens,
        uint256 priceAfter,
        uint64 ts
    );
    event Ascended(address indexed token, uint256 raisedUsd, uint64 ts);
    event FeeAccrued(address indexed token, uint8 mode, uint256 amount);
    event BuybackBurn(address indexed token, uint256 usd, uint256 tokens);
    event DevClaimed(address indexed token, bytes32 indexed dev, uint256 amount);
    event HoldersDistributed(address indexed token, uint256 amount);
    /// A FAIR GENESIS action: a snipe tax collected and/or a clamped or
    /// bounced spend refunded. `refundedUsd` is only the guard's own clamp
    /// (cap/block-0), not a curve-cap refund.
    event GenesisGuard(
        address indexed token,
        bytes32 indexed actor,
        uint256 taxBps,
        uint256 taxUsd,
        uint256 refundedUsd
    );

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

    function setDistributor(FeeDistributor d) external {
        require(msg.sender == admin, "PAD: not admin");
        require(address(distributor) == address(0), "PAD: distributor set");
        distributor = d;
    }

    /// `gw` is the gateway's wide id: an EVM gateway left-padded, a Solana
    /// OApp store pubkey raw.
    function setGateway(uint32 chain, bytes32 gw) external {
        require(msg.sender == admin, "PAD: not admin");
        require(gateways[chain] == bytes32(0) && gw != bytes32(0), "PAD: gateway set");
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
            bytes32 creator,
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

    /// FAIR GENESIS, in one call for the UI: when the window ends, the snipe
    /// tax right now, and how much of the per-wallet cap this actor has used.
    function fairGenesisOf(address token, bytes32 actor)
        external
        view
        returns (uint64 endsAt, uint256 snipeBpsNow, uint256 spentUsd, uint256 capUsd)
    {
        uint64 spawnedAt = metas[token].spawnedAt;
        endsAt = spawnedAt + uint64(GENESIS_WINDOW);
        if (spawnedAt != 0 && block.timestamp < endsAt) {
            snipeBpsNow = (SNIPE_MAX_BPS * (endsAt - block.timestamp)) / GENESIS_WINDOW;
        }
        spentUsd = genesisSpent[token][actor];
        capUsd = GENESIS_MAX_USD;
    }

    /* -------------------------- messaging -------------------------- */

    /// WIRE CONVENTION (v5): every account rider in a cross-chain payload is
    /// a `bytes32`, and ACTORS (creators, buyers, sellers, claimers) STAY
    /// wide end-to-end — the hub stores, authenticates and pays them by
    /// message, never by local transfer, so a Solana identity flows through
    /// untouched. The only values downcast on the hub are TOKEN ids, because
    /// every token is an EVM contract deployed HERE; a wide token id is
    /// corruption and reverts.
    function _addr(bytes32 b) internal pure returns (address) {
        require(uint256(b) >> 160 == 0, "PAD: bad recipient");
        return address(uint160(uint256(b)));
    }

    function _b32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// FEES (v7): the pad never attaches value and never prepays a reply —
    /// every `messenger.send` below passes `returnLegs = 0`. Its messages ARE
    /// the replies: the user who caused them prepaid them into the hub
    /// adapter's tank, and the pad rides that tank as a sponsored sender.
    function onOmniMessage(uint32 srcChain, bytes32 srcSender, bytes calldata payload) external {
        require(msg.sender == address(messenger), "PAD: not messenger");
        require(gateways[srcChain] == srcSender, "PAD: not a gateway");
        (uint8 op, bytes memory data) = abi.decode(payload, (uint8, bytes));
        if (op == OP_SPAWN) {
            (
                bytes32 creator, // actor: stays wide
                string memory name,
                string memory symbol,
                string memory metaURI,
                uint256 devBuyUsd,
                uint8 feeMode
            ) = abi.decode(data, (bytes32, string, string, string, uint256, uint8));
            _spawn(srcChain, creator, name, symbol, metaURI, devBuyUsd, feeMode);
        } else if (op == OP_CLAIM) {
            (bytes32 token, bytes32 claimer) = abi.decode(data, (bytes32, bytes32));
            // token: hub-local EVM contract, downcast; claimer: actor, wide
            _claim(srcChain, _addr(token), claimer);
        } else if (op == OP_BUY) {
            (bytes32 token, bytes32 buyer, uint256 usdIn) = abi.decode(
                data,
                (bytes32, bytes32, uint256)
            );
            // token: hub-local, downcast; buyer: actor, wide
            _buy(srcChain, _addr(token), buyer, usdIn, false);
        } else if (op == OP_SELL) {
            (bytes32 token, bytes32 seller, uint256 tokensIn) = abi.decode(
                data,
                (bytes32, bytes32, uint256)
            );
            // token: hub-local, downcast; seller: actor, wide
            _sell(srcChain, _addr(token), seller, tokensIn);
        } else {
            revert("PAD: bad op");
        }
    }

    /* --------------------------- protocol --------------------------- */

    function _spawn(
        uint32 srcChain,
        bytes32 creator,
        string memory name,
        string memory symbol,
        string memory metaURI,
        uint256 devBuyUsd,
        uint8 feeMode
    ) internal {
        require(feeMode <= FEE_BURN, "PAD: bad fee mode");
        SpawnToken token = new SpawnToken(
            name,
            symbol,
            address(this),
            true,
            TOTAL_SUPPLY,
            address(this),
            address(distributor)
        );
        allTokens.push(address(token));
        metas[address(token)] = Meta(name, symbol, metaURI, creator, uint64(block.timestamp), srcChain);
        spawnBlock[address(token)] = block.number;
        feesOf[address(token)].mode = feeMode;
        venue.openMarket(address(token));
        emit Spawned(address(token), creator, srcChain, name, symbol, metaURI);

        // One genesis, every chain: deploy a native replica on each spoke.
        for (uint256 i = 0; i < chainLabels.length; i++) {
            uint32 ch = chainLabels[i];
            messenger.send(
                ch,
                gateways[ch],
                // token id rides as bytes32: the hub is EVM so it always
                // fits; a Solana gateway consumes it as a raw 32-byte seed.
                abi.encode(OP_SYNC_TOKEN, abi.encode(_b32(address(token)), name, symbol)),
                0
            );
        }

        // The dev buy is part of the spawn itself — the one disclosed FAIR
        // GENESIS exemption (no block-0 rule, no tax, no cap).
        if (devBuyUsd > 0) _buy(srcChain, address(token), creator, devBuyUsd, true);
    }

    /// Decides how much of a buy may touch the curve and at what snipe tax.
    /// Pure clamp semantics: 0 spendable = full bounce, NEVER a revert — the
    /// spoke already burned the buyer's oUSD, so refusal must ride home as a
    /// refund, not strand value in a reverted message.
    function _genesisGate(address token, bytes32 buyer, uint256 usdIn, bool genesisBuy)
        internal
        returns (uint256 spendable, uint256 snipeBps)
    {
        if (genesisBuy) return (usdIn, 0);
        // Block 0 does not exist: a buy landing in the spawn block bounces
        // whole. Executor batching CAN land OP_SPAWN and OP_BUY in the same
        // hub block, which is exactly why this clamps instead of reverting.
        if (block.number <= spawnBlock[token]) return (0, 0);
        uint256 end = metas[token].spawnedAt + GENESIS_WINDOW;
        if (block.timestamp >= end) return (usdIn, 0);
        snipeBps = (SNIPE_MAX_BPS * (end - block.timestamp)) / GENESIS_WINDOW;
        uint256 spent = genesisSpent[token][buyer];
        uint256 room = spent >= GENESIS_MAX_USD ? 0 : GENESIS_MAX_USD - spent;
        spendable = usdIn <= room ? usdIn : room;
        // The whole clamped intent counts against the cap even if the curve
        // later caps the spend further (ascension edge): simpler, and
        // strictly tighter against snipers.
        if (spendable > 0) genesisSpent[token][buyer] = spent + spendable;
    }

    function _buy(uint32 srcChain, address token, bytes32 buyer, uint256 usdIn, bool genesisBuy) internal {
        // The spoke burned the buyer's OmniUSD; the value re-materializes here.
        usd.bridgeMint(address(this), usdIn);

        (uint256 spendable, uint256 snipeBps) = _genesisGate(token, buyer, usdIn, genesisBuy);
        uint256 feeRate = FEE_BPS + snipeBps;

        // Fee off the top; price discovery is the venue's job.
        uint256 out;
        uint256 spend;
        uint256 fee;
        if (spendable > 0) {
            uint256 feeIn = (spendable * feeRate) / 10_000;
            bool ascendedNow;
            (out, spend, ascendedNow) = venue.execBuy(token, spendable - feeIn);
            // If the curve capped the buy, the fee shrinks with it.
            fee = spend < spendable - feeIn ? (spend * feeRate) / 10_000 : feeIn;
            if (ascendedNow) {
                emit Ascended(token, venue.curveOf(token).vBase, uint64(block.timestamp));
            }
        }
        uint256 refund = usdIn - spend - fee;

        // Ship the creature to the buyer's chain (burn hub-side, mint spoke-side).
        if (out > 0) {
            SpawnToken(token).bridgeBurn(address(this), out);
            supplyByChain[token][srcChain] += out;
        }
        if (refund > 0) usd.bridgeBurn(address(this), refund);
        messenger.send(
            srcChain,
            gateways[srcChain],
            // token id padded; buyer already wide — passthrough, no re-cast
            abi.encode(OP_DELIVER, abi.encode(_b32(token), buyer, out, refund)),
            0
        );

        if (snipeBps > 0 || usdIn > spendable) {
            emit GenesisGuard(token, buyer, snipeBps, (fee * snipeBps) / feeRate, usdIn - spendable);
        }
        if (spend + fee > 0) {
            emit Trade(token, srcChain, buyer, true, spend + fee, out, venue.spotPrice(token), uint64(block.timestamp));
        }
        _accrueFee(token, fee);
    }

    function _sell(uint32 srcChain, address token, bytes32 seller, uint256 tokensIn) internal {
        // The spoke burned the seller's replicas; they re-materialize in inventory.
        SpawnToken(token).bridgeMint(address(this), tokensIn);
        supplyByChain[token][srcChain] -= tokensIn;

        uint256 usdOut = venue.execSell(token, tokensIn);
        uint256 fee = (usdOut * FEE_BPS) / 10_000;
        uint256 net = usdOut - fee;

        // Pay the seller out on their chain, net of the fee.
        usd.bridgeBurn(address(this), net);
        // seller already wide — passthrough, no re-cast
        messenger.send(srcChain, gateways[srcChain], abi.encode(OP_PAYOUT, abi.encode(seller, net)), 0);

        emit Trade(token, srcChain, seller, false, net, tokensIn, venue.spotPrice(token), uint64(block.timestamp));
        _accrueFee(token, fee);
    }

    /// Routes a collected fee per the token's mode. Fees are oUSD already
    /// held by the pad, so every mode settles inside one pot on the hub.
    function _accrueFee(address token, uint256 fee) internal {
        if (fee == 0) return;
        FeeState storage f = feesOf[token];
        f.total += fee;
        if (f.mode == FEE_HOLDERS) {
            f.holders += fee;
        } else if (f.mode == FEE_SPLIT) {
            uint256 half = fee / 2;
            f.holders += half;
            f.dev += fee - half;
        } else if (f.mode == FEE_DEV) {
            f.dev += fee;
        } else {
            f.burnPot += fee;
            if (f.burnPot >= BURN_TRIGGER) {
                // The buyback is a REAL buy on the same curve — it moves the
                // price — and the tokens it gets are burned on the spot, so
                // global supply shrinks for every chain at once.
                uint256 pot = f.burnPot;
                f.burnPot = 0;
                (uint256 out, uint256 spent, bool asc) = venue.execBuy(token, pot);
                if (spent < pot) f.burnPot = pot - spent;
                f.burnedUsd += spent;
                f.burnedTokens += out;
                SpawnToken(token).bridgeBurn(address(this), out);
                if (asc) emit Ascended(token, venue.curveOf(token).vBase, uint64(block.timestamp));
                emit BuybackBurn(token, spent, out);
                emit Trade(token, HUB_CHAIN, _b32(address(this)), true, spent, out, venue.spotPrice(token), uint64(block.timestamp));
            }
        }
        if (
            (f.mode == FEE_HOLDERS || f.mode == FEE_SPLIT) &&
            f.holders - f.holdersPaid >= DIST_TRIGGER
        ) {
            _distributeHolders(token, f);
        }
        emit FeeAccrued(token, f.mode, fee);
    }

    /// Splits the accrued holders pot pro-rata to where the supply lives and
    /// drops each chain's slice into that chain's FeeDistributor. Holders
    /// then claim with a pure local tx on their own chain — the dividend
    /// stream follows balances automatically from there.
    function _distributeHolders(address token, FeeState storage f) internal {
        uint256 pot = f.holders - f.holdersPaid;
        uint256 circ = supplyByChain[token][HUB_CHAIN];
        for (uint256 i = 0; i < chainLabels.length; i++) {
            circ += supplyByChain[token][chainLabels[i]];
        }
        if (circ == 0) return; // nobody holds yet — the pot keeps growing

        uint256 paid;
        uint256 hubShare = (pot * supplyByChain[token][HUB_CHAIN]) / circ;
        if (hubShare > 0) {
            usd.transfer(address(distributor), hubShare);
            distributor.drop(token, hubShare);
            paid += hubShare;
        }
        for (uint256 i = 0; i < chainLabels.length; i++) {
            uint32 ch = chainLabels[i];
            uint256 share = (pot * supplyByChain[token][ch]) / circ;
            if (share == 0) continue;
            // The slice burns here and re-materializes in the spoke's
            // distributor — the same burn/mint pattern as every payout.
            usd.bridgeBurn(address(this), share);
            // token id rides as bytes32 (wire convention)
            messenger.send(ch, gateways[ch], abi.encode(OP_FEE_DROP, abi.encode(_b32(token), share)), 0);
            paid += share;
        }
        f.holdersPaid += paid; // rounding dust stays in the pot
        emit HoldersDistributed(token, paid);
    }

    /// The dev claims their accrued share, paid out in oUSD on the chain
    /// they claim from — like every other payout.
    function _claim(uint32 srcChain, address token, bytes32 claimer) internal {
        require(metas[token].creator == claimer, "PAD: not the dev");
        FeeState storage f = feesOf[token];
        uint256 amount = f.dev - f.devClaimed;
        require(amount > 0, "PAD: nothing to claim");
        f.devClaimed += amount;
        usd.bridgeBurn(address(this), amount);
        // claimer already wide — passthrough, no re-cast
        messenger.send(srcChain, gateways[srcChain], abi.encode(OP_PAYOUT, abi.encode(claimer, amount)), 0);
        emit DevClaimed(token, claimer, amount);
    }
}
