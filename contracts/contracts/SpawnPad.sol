// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOmniMessenger, IOmniReceiver} from "./OmniMessenger.sol";
import {OmniUSD} from "./OmniUSD.sol";
import {SpawnToken} from "./SpawnToken.sol";
import {ICurveVenue} from "./ICurveVenue.sol";
import {Roles} from "./Roles.sol";

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
///
/// NEVER REVERT ON AN AUTHENTICATED MESSAGE (v7). A message that reaches the
/// pad carries value the spoke already took from a user. Whatever the pad
/// cannot do, it REFUSES by sending that value home (a refund, or the
/// tokens back) and logging `Refused` — it does not revert. The only
/// reverts left on this path are an empty reply tank (LayerZero keeps the
/// message retryable until it is refilled) and guards that cannot fire
/// while the protocol's own invariants hold.
contract SpawnPad is IOmniReceiver, Roles {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint32 public constant HUB_CHAIN = 0;

    /// 1% on every trade, routed per the token's launch-time fee mode.
    uint256 public constant FEE_BPS = 100;
    /// Burn mode buys back in chunks, not dust.
    uint256 public constant BURN_TRIGGER = 4e18;
    /// Holder modes split the pot into per-chain slices in chunks, not on
    /// every trade.
    uint256 public constant DIST_TRIGGER = 2e18;
    /// Gas that must remain after a skippable send (or its quote) FAILED
    /// for the failure to count as the leg's refusal rather than as
    /// starvation (see `_notStarved`). A starved call leaves 1/64 of what it
    /// was given, and each frame between here and the one that ran dry
    /// hands back another 1/64 of its own: under this floor for any send
    /// that needs less than ~6.3M gas divided by its call depth (about 1M
    /// through a real LayerZero send, which needs a quarter of that).
    uint256 internal constant SYNC_GAS_FLOOR = 100_000;

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
    uint8 internal constant OP_PULL_FEES = 5;
    uint8 internal constant OP_OPEN = 6;
    uint8 internal constant OP_MOVE = 7;
    // Message opcodes (pad -> gateway)
    uint8 internal constant OP_SYNC_TOKEN = 10;
    uint8 internal constant OP_DELIVER = 11;
    uint8 internal constant OP_PAYOUT = 12;
    uint8 internal constant OP_FEE_DROP = 13;

    // Why a message was refused (`Refused.reason`)
    uint8 internal constant R_PAUSED = 1;
    uint8 internal constant R_UNKNOWN_TOKEN = 2;
    uint8 internal constant R_BAD_FEE_MODE = 3;
    uint8 internal constant R_NOT_DEV = 4;
    uint8 internal constant R_NOTHING = 5;
    uint8 internal constant R_VENUE = 6;

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
    ICurveVenue public venue;
    /// Circuit breaker. While set, buys bounce whole and spawns are refused
    /// (both refund); sells and claims keep working — exits never close.
    bool public paused;

    uint32[] public chainLabels;
    /// Gateways are wide too (v5): a Solana gateway is an OApp store pubkey,
    /// not an EVM address. EVM gateways are stored left-padded.
    mapping(uint32 => bytes32) public gateways;
    /// Chains whose holder slice is shipped the moment it is computed — only
    /// where shipping is free (the hub chain's own gateway, a loopback).
    /// Every other chain's slice waits in `pendingDrop` for a user-paid pull.
    mapping(uint32 => bool) public autoDrop;
    /// TWO CEILINGS PER CHAIN (v7.2), in hub-native wei, on what one
    /// message the pad is FREE TO SKIP may cost the tank. Above its ceiling
    /// the message is not sent (see `_trySend`). Neither applies to a reply
    /// that carries a user's value home, nor to `resync` (its caller pays).
    ///
    /// `syncCap` — a token's SYNC in the fan-out of a SPAWN, which the
    /// launcher prepaid at another chain's prices. 0 = no ceiling, and no
    /// quote is made: the fan-out behaves as before v7.2. (For the chain
    /// the spawn came FROM, the ceiling is the larger of the two.)
    mapping(uint32 => uint256) public syncCap;
    /// `requestCap` — a message someone ASKED for toward this chain and
    /// prepaid themselves: the SYNC of an OP_OPEN, the PAYOUT an OP_MOVE
    /// forwards. Always quoted, so 0 lets through only a leg that costs
    /// nothing (the hub chain's own gateway): a remote chain is closed to
    /// opens and to incoming moves until the operator prices it — at what
    /// such a request prepays. It can sit far above `syncCap`: a dear chain
    /// (an L1) is then left out of every launch and opened token by token,
    /// by those who want it there and pay for it.
    mapping(uint32 => uint256) public requestCap;

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
    /// Holder-fee slices already attributed to a chain and waiting on the
    /// hub for someone on that chain to pull them (OP_PULL_FEES). The oUSD
    /// stays in the pad's books until then.
    mapping(address => mapping(uint32 => uint256)) public pendingDrop;

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
    event FeesPulled(address indexed token, uint32 indexed chain, uint256 amount);
    /// A message the pad would not execute. Any value it carried was sent
    /// home (`amount`: the dollars or tokens concerned). `reason`: 1 paused,
    /// 2 unknown token, 3 bad fee mode, 4 not the dev, 5 nothing to pay,
    /// 6 the venue refused the trade.
    event Refused(
        uint8 indexed op,
        uint32 indexed srcChain,
        bytes32 token,
        bytes32 actor,
        uint256 amount,
        uint8 reason
    );
    event VenueSet(address venue);
    event GatewaySet(uint32 indexed chain, bytes32 gateway);
    event AutoDropSet(uint32 indexed chain, bool on);
    event SyncCapSet(uint32 indexed chain, uint256 cap);
    event RequestCapSet(uint32 indexed chain, uint256 cap);
    /// A token's SYNC was not sent to `chain` — at spawn, or when that chain
    /// asked for it (OP_OPEN): the send failed, or its fee was above the
    /// chain's ceiling (`syncCap` at spawn, `requestCap` for an open). The
    /// token has no replica there until a `resync` (anyone, paid) or an
    /// OP_OPEN from that chain goes through.
    event SyncFailed(address indexed token, uint32 indexed chain);
    /// A token's SYNC left for `chain` after its spawn (`resync`, OP_OPEN).
    event Resynced(address indexed token, uint32 indexed chain);
    /// OP_MOVE: `amount` of oUSD claim, burned by `from` on `srcChain`, was
    /// forwarded as a PAYOUT to (`dstChain`, `to`) — or, when `forwarded` is
    /// false, sent back as a PAYOUT to (`srcChain`, `from`).
    event Moved(
        uint32 indexed srcChain,
        uint32 indexed dstChain,
        bytes32 indexed from,
        bytes32 to,
        uint256 amount,
        bool forwarded
    );
    event Paused(address by);
    event Unpaused(address by);
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
    }

    /* ---------------------------- admin ---------------------------- */

    function setVenue(ICurveVenue v) external onlyAdmin {
        require(address(venue) == address(0), "PAD: venue set");
        venue = v;
        emit VenueSet(address(v));
    }

    /// `gw` is the gateway's wide id: an EVM gateway left-padded, a Solana
    /// OApp store pubkey raw. One gateway per chain, forever: a gateway can
    /// mint value into the hub's books, so this is the most dangerous
    /// setter in the protocol.
    function setGateway(uint32 chain, bytes32 gw) external onlyAdmin {
        require(chain != HUB_CHAIN, "PAD: hub label");
        require(gateways[chain] == bytes32(0) && gw != bytes32(0), "PAD: gateway set");
        gateways[chain] = gw;
        chainLabels.push(chain);
        emit GatewaySet(chain, gw);
    }

    /// Flag a chain whose FEE_DROP costs nothing to send (the hub chain's
    /// own gateway). Flagging a remote chain makes the hub tank pay for its
    /// drops — the unfunded fan-out v7 removed.
    function setAutoDrop(uint32 chain, bool on) external onlyAdmin {
        autoDrop[chain] = on;
        emit AutoDropSet(chain, on);
    }

    /// Prices, not topology: what the tank may front for one skippable
    /// message toward `chain` — see `syncCap` and `requestCap`.
    function setSyncCap(uint32 chain, uint256 cap) external onlyOperator {
        syncCap[chain] = cap;
        emit SyncCapSet(chain, cap);
    }

    function setRequestCap(uint32 chain, uint256 cap) external onlyOperator {
        requestCap[chain] = cap;
        emit RequestCapSet(chain, cap);
    }

    /* ----------------------- circuit breaker ----------------------- */

    function pause() external onlyGuardian {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOperator {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /* ---------------------------- views ---------------------------- */

    function tokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    function chainsLength() external view returns (uint256) {
        return chainLabels.length;
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
    /// every token is an EVM contract deployed HERE.
    function _b32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// A token id the hub can act on: it downcasts (top 12 bytes zero) AND
    /// names a token this pad spawned. Anything else is refused, never
    /// reverted on — see the contract header.
    function _known(bytes32 tokenB) internal view returns (bool ok, address token) {
        if (uint256(tokenB) >> 160 != 0) return (false, address(0));
        token = address(uint160(uint256(tokenB)));
        ok = metas[token].spawnedAt != 0;
    }

    /// The one place `Refused` is emitted from (ten call sites: this is
    /// bytecode the pad needs elsewhere).
    function _refuse(uint8 op, uint32 srcChain, bytes32 token, bytes32 actor, uint256 amount, uint8 reason)
        internal
    {
        emit Refused(op, srcChain, token, actor, amount, reason);
    }

    /// A REPLY: a message that carries a user's value to a chain, paid out
    /// of the tank its cause prepaid into (`returnLegs` is always 0 — see
    /// FEES below). A reply is never skipped: if it cannot be sent, the
    /// message that caused it reverts and stays retryable.
    function _reply(uint32 chain, uint8 op, bytes memory data) internal {
        messenger.send(chain, gateways[chain], abi.encode(op, data), 0);
    }

    /// OP_PAYOUT: dollars the hub's books no longer hold (a sale's proceeds,
    /// a dev claim), or never held — the spoke took them from the user and
    /// the hub refused the message, or forwards them (OP_MOVE). `to` is
    /// already wide: passthrough, no re-cast.
    function _sendHome(uint32 chain, bytes32 to, uint256 amount) internal {
        _reply(chain, OP_PAYOUT, abi.encode(to, amount));
    }

    /// OP_DELIVER: tokens (and a refund) to an account on `chain`. The
    /// token id rides padded; `to` is already wide.
    function _deliver(uint32 chain, address token, bytes32 to, uint256 tokens, uint256 refund) internal {
        _reply(chain, OP_DELIVER, abi.encode(_b32(token), to, tokens, refund));
    }

    /// FEES (v7): the pad never attaches value and never prepays a reply —
    /// every `messenger.send` passes `returnLegs = 0`. Its messages ARE the
    /// replies: the user who caused them prepaid them into the hub adapter's
    /// tank, and the pad rides that tank as a sponsored sender. Since the
    /// holder-fee fan-out became a user-paid pull, that is true of EVERY
    /// remote message the pad sends.
    function onOmniMessage(uint32 srcChain, bytes32 srcSender, bytes calldata payload) external {
        require(msg.sender == address(messenger), "PAD: not messenger");
        // an UNSET gateway (bytes32(0)) is never a match: label 0 can have
        // no gateway at all, so (chain 0, sender 0) must not pass (F-11)
        require(srcSender != bytes32(0) && gateways[srcChain] == srcSender, "PAD: not a gateway");
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
        } else if (op == OP_BUY || op == OP_SELL) {
            // one tuple for both: (token, buyer, usdIn) / (token, seller, tokensIn)
            (bytes32 tokenB, bytes32 actor, uint256 amount) = abi.decode(data, (bytes32, bytes32, uint256));
            (bool ok, address token) = _known(tokenB);
            if (!ok) {
                _refuse(op, srcChain, tokenB, actor, amount, R_UNKNOWN_TOKEN);
                // a buyer's dollars are in flight: they go straight home. (An
                // unknown id names nothing a spoke could have burned to sell.)
                if (op == OP_BUY) _sendHome(srcChain, actor, amount);
            } else if (op == OP_BUY) {
                _buy(srcChain, token, actor, amount, false);
            } else {
                _sell(srcChain, token, actor, amount);
            }
        } else if (op == OP_CLAIM) {
            (bytes32 tokenB, bytes32 claimer) = abi.decode(data, (bytes32, bytes32));
            (bool ok, address token) = _known(tokenB);
            if (ok) _claim(srcChain, token, claimer);
            else _refuse(op, srcChain, tokenB, claimer, 0, R_UNKNOWN_TOKEN);
        } else if (op == OP_PULL_FEES || op == OP_OPEN) {
            bytes32 tokenB = abi.decode(data, (bytes32));
            (bool ok, address token) = _known(tokenB);
            if (!ok) _refuse(op, srcChain, tokenB, bytes32(0), 0, R_UNKNOWN_TOKEN);
            else if (op == OP_PULL_FEES) _pull(srcChain, token);
            else {
                // OP_OPEN (v7.2): a chain this token never reached asks for
                // its replica and prepaid the SYNC — which is sent if it
                // costs no more than that chain's `requestCap`. No value
                // rides it, and it runs through a paused pad: a replica is
                // not exposure.
                Meta storage m = metas[token];
                bytes memory sync = _syncPayload(token, m.name, m.symbol);
                if (_within(srcChain, sync, requestCap[srcChain]) && _trySend(srcChain, sync)) {
                    emit Resynced(token, srcChain);
                } else {
                    emit SyncFailed(token, srcChain);
                }
            }
        } else if (op == OP_MOVE) {
            (bytes32 from, bytes32 to, uint256 amount, uint32 dstChain) = abi.decode(
                data,
                (bytes32, bytes32, uint256, uint32)
            );
            _move(srcChain, from, to, amount, dstChain);
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
        if (paused || feeMode > FEE_BURN) {
            // no token is created; a dev buy that came along goes home
            _refuse(OP_SPAWN, srcChain, bytes32(0), creator, devBuyUsd, paused ? R_PAUSED : R_BAD_FEE_MODE);
            if (devBuyUsd > 0) _sendHome(srcChain, creator, devBuyUsd);
            return;
        }
        // The hub instance never leaves the pad's custody, so it reports to
        // no FeeDistributor: holders live on the user-facing chains.
        SpawnToken token = new SpawnToken(name, symbol, address(this), true, TOTAL_SUPPLY, address(this), address(0));
        allTokens.push(address(token));
        metas[address(token)] = Meta(name, symbol, metaURI, creator, uint64(block.timestamp), srcChain);
        spawnBlock[address(token)] = block.number;
        feesOf[address(token)].mode = feeMode;
        venue.openMarket(address(token));
        emit Spawned(address(token), creator, srcChain, name, symbol, metaURI);

        // One genesis, every chain: deploy a native replica on each spoke.
        // ONE DEAD LEG MUST NOT BRICK EVERY LAUNCH (v7.1): a gateway is
        // forever, so a chain whose send reverts — a pathway LayerZero
        // retired, a message its executor will not carry, a route not set
        // yet — would otherwise undo every spawn from every chain. A SYNC
        // that cannot leave is logged and the spawn goes on; the operator
        // sends it again with `resync` once the leg is repaired.
        // ONE EXPENSIVE LEG MUST NOT DRAIN THE TANK (v7.2): a chain with a
        // `syncCap` is quoted first and skipped the same way while its SYNC
        // costs more than the ceiling; someone on that chain opens the token
        // there later (OP_OPEN), or anyone pays a `resync`. The launcher's
        // OWN chain is one somebody asked for and prepaid at its own price:
        // there the ceiling is never lower than a request's (`requestCap`),
        // or a chain left out of every launch could not launch for itself.
        bytes memory sync = _syncPayload(address(token), name, symbol);
        for (uint256 i = 0; i < chainLabels.length; i++) {
            uint32 ch = chainLabels[i];
            uint256 cap = syncCap[ch];
            if (ch == srcChain && cap != 0 && requestCap[ch] > cap) cap = requestCap[ch];
            if (!((cap == 0 || _within(ch, sync, cap)) && _trySend(ch, sync))) emit SyncFailed(address(token), ch);
        }

        // The dev buy is part of the spawn itself — the one disclosed FAIR
        // GENESIS exemption (no block-0 rule, no tax, no cap).
        if (devBuyUsd > 0) _buy(srcChain, address(token), creator, devBuyUsd, true);
    }

    /// MESSAGES THE PAD IS FREE TO SKIP — a token's SYNC (at spawn, or asked
    /// for by OP_OPEN) and the PAYOUT a move forwards. Unlike a reply, such
    /// a message may stay behind: the caller logs the miss (`SyncFailed`)
    /// or sends the value home instead. `_within` prices it against a
    /// ceiling, `_trySend` sends it; neither reverts because the leg
    /// refused. Two rules hold for both:
    ///
    ///  - THE CEILING. A message is not sent if its quote is above the
    ///    ceiling the caller names, or if the quote itself reverts (a leg
    ///    that cannot be priced cannot be sent either). The tank pays
    ///    nothing for a message that was not sent.
    ///  - RUNNING OUT OF GAS IS NOT A DEAD LEG. A quote or a send that
    ///    merely starved got 63/64 of what was left, so almost nothing
    ///    remains here — whereas a leg that REFUSES reverts early and
    ///    leaves plenty. Revert in the first case (the message is retried
    ///    with enough gas): otherwise whoever delivers a message could pick
    ///    the gas that skips a chain, or that turns a move back.

    /// Sends `payload` to `ch`; false if the leg would not take it.
    function _trySend(uint32 ch, bytes memory payload) internal returns (bool sent) {
        try messenger.send(ch, gateways[ch], payload, 0) {
            sent = true;
        } catch {
            _notStarved();
        }
    }

    /// True if sending `payload` to `ch` costs the tank at most `cap` right
    /// now. A leg that costs nothing (a loopback) is within any ceiling.
    function _within(uint32 ch, bytes memory payload, uint256 cap) internal view returns (bool ok) {
        try messenger.quote(ch, gateways[ch], payload, 0) returns (uint256 fee) {
            ok = fee <= cap;
        } catch {
            _notStarved();
        }
    }

    /// A call that failed with this little gas left behind it was starved,
    /// not refused (see `SYNC_GAS_FLOOR`).
    function _notStarved() internal view {
        require(gasleft() >= SYNC_GAS_FLOOR, "PAD: gas");
    }

    /// OP_MOVE (v7.2): a dollar claim leaves a chain whose vault cannot pay
    /// it. The spoke burned `amount` of `from`'s oUSD; the pad forwards it
    /// as an OP_PAYOUT to (`dstChain`, `to`), where that vault pays dollars
    /// if it has them and a claim otherwise. The hub's own books are never
    /// touched, and nothing here looks at `paused`: this is an exit.
    ///
    /// The value goes back to (`srcChain`, `from`) instead — never into the
    /// void — when the destination has no gateway; when it names nobody;
    /// when it is an EVM chain (a gateway id that fits an address) and `to`
    /// is not an address, which an EVM gateway's PAYOUT handler would
    /// revert on for good; when the forward leg costs more than the
    /// destination's `requestCap` (what a mover prepays for it); or when
    /// that leg will not take the message. The way home is a reply like
    /// any other: it is never skipped.
    function _move(uint32 srcChain, bytes32 from, bytes32 to, uint256 amount, uint32 dstChain) internal {
        bytes32 gw = gateways[dstChain];
        bytes memory payout = abi.encode(OP_PAYOUT, abi.encode(to, amount));
        bool forwarded = gw != bytes32(0) &&
            to != bytes32(0) &&
            (uint256(gw) >> 160 != 0 || uint256(to) >> 160 == 0) &&
            _within(dstChain, payout, requestCap[dstChain]) &&
            _trySend(dstChain, payout);
        if (!forwarded) _sendHome(srcChain, from, amount);
        emit Moved(srcChain, dstChain, from, to, amount, forwarded);
    }

    /// OP_SYNC_TOKEN for one token. The token id rides as bytes32: the hub
    /// is EVM so it always fits; a Solana gateway consumes it as a raw
    /// 32-byte seed.
    function _syncPayload(address token, string memory name, string memory symbol)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(OP_SYNC_TOKEN, abi.encode(_b32(token), name, symbol));
    }

    /// Sends a token's SYNC to one chain again — for a leg whose SYNC failed
    /// or was skipped at spawn (`SyncFailed`), was lost, or for a chain that
    /// joined after the token. ANYONE may call it (v7.2), on one condition:
    /// the pad's sends ride the hub tank, so whoever is not the operator
    /// attaches at least what the message costs. All of `msg.value` goes to
    /// the messenger — into the tank the fee is paid from — so the tank is
    /// never out of pocket; the operator may still send it on the tank's
    /// account, with no value. No ceiling applies: the caller is paying.
    ///
    /// It moves no value, which is why it ignores `paused`, and it cannot
    /// fork a token: a gateway ignores a SYNC for a replica it already has,
    /// and whatever reached that chain before its replica (a dev-buy
    /// DELIVER, a FEE_DROP) is parked there until this lands.
    function resync(address token, uint32 chain) external payable {
        Meta storage m = metas[token];
        bytes32 gw = gateways[chain];
        require(m.spawnedAt != 0 && gw != bytes32(0), "PAD: unknown");
        bytes memory sync = _syncPayload(token, m.name, m.symbol);
        if (msg.sender != operator && msg.sender != admin) {
            require(msg.value >= messenger.quote(chain, gw, sync, 0), "PAD: fee");
        }
        messenger.send{value: msg.value}(chain, gw, sync, 0);
        emit Resynced(token, chain);
    }

    /// Decides how much of a buy may touch the curve and at what snipe tax.
    /// Pure clamp semantics: 0 spendable = full bounce, NEVER a revert — the
    /// spoke already took the buyer's dollars, so refusal must ride home as
    /// a refund, not strand value in a reverted message.
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
        uint256 spendable;
        uint256 snipeBps;
        if (paused) {
            _refuse(OP_BUY, srcChain, _b32(token), buyer, usdIn, R_PAUSED);
        } else {
            (spendable, snipeBps) = _genesisGate(token, buyer, usdIn, genesisBuy);
        }
        // what the genesis guard itself turned away (not a pause, not the venue)
        uint256 guarded = paused ? 0 : usdIn - spendable;
        uint256 feeRate = FEE_BPS + snipeBps;

        // Fee off the top; price discovery is the venue's job. A venue that
        // will not take the trade (any venue, for any reason) bounces it.
        uint256 out;
        uint256 spend;
        uint256 fee;
        if (spendable > 0) {
            uint256 feeIn = (spendable * feeRate) / 10_000;
            try venue.execBuy(token, spendable - feeIn) returns (uint256 o, uint256 s, bool ascendedNow) {
                out = o;
                spend = s;
                // If the curve capped the buy, the fee shrinks with it.
                fee = s < spendable - feeIn ? (s * feeRate) / 10_000 : feeIn;
                if (ascendedNow) emit Ascended(token, venue.curveOf(token).vBase, uint64(block.timestamp));
            } catch {
                _refuse(OP_BUY, srcChain, _b32(token), buyer, usdIn, R_VENUE);
                // nothing was bought: the gate's cap accounting (which only
                // runs inside the window, i.e. when there is a snipe tax) is undone
                if (snipeBps > 0) genesisSpent[token][buyer] -= spendable;
            }
        }
        uint256 refund = usdIn - spend - fee;

        // The spoke took the buyer's dollars; the part that stays on the hub
        // (curve + fee) re-materializes in the books, the rest rides home.
        if (spend + fee > 0) usd.bridgeMint(address(this), spend + fee);
        // Ship the creature to the buyer's chain (burn hub-side, mint spoke-side).
        if (out > 0) {
            SpawnToken(token).bridgeBurn(address(this), out);
            supplyByChain[token][srcChain] += out;
        }
        _deliver(srcChain, token, buyer, out, refund);

        if (snipeBps > 0 || guarded > 0) {
            emit GenesisGuard(token, buyer, snipeBps, (fee * snipeBps) / feeRate, guarded);
        }
        if (spend + fee > 0) {
            emit Trade(token, srcChain, buyer, true, spend + fee, out, venue.spotPrice(token), uint64(block.timestamp));
        }
        _accrueFee(token, fee);
    }

    function _sell(uint32 srcChain, address token, bytes32 seller, uint256 tokensIn) internal {
        uint256 usdOut;
        try venue.execSell(token, tokensIn) returns (uint256 u) {
            usdOut = u;
        } catch {
            // the venue will not price it (dust): the spoke burned the bag,
            // so it goes back the way a delivery does
            _refuse(OP_SELL, srcChain, _b32(token), seller, tokensIn, R_VENUE);
            _deliver(srcChain, token, seller, tokensIn, 0);
            return;
        }
        // The spoke burned the seller's replicas; they re-materialize in
        // inventory. The subtraction cannot underflow while the hub's ledger
        // matches the spokes (S2): a gateway can only burn what was delivered.
        SpawnToken(token).bridgeMint(address(this), tokensIn);
        supplyByChain[token][srcChain] -= tokensIn;

        uint256 fee = (usdOut * FEE_BPS) / 10_000;
        uint256 net = usdOut - fee;

        // Pay the seller out on their chain, net of the fee.
        usd.bridgeBurn(address(this), net);
        _sendHome(srcChain, seller, net);

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
                // global supply shrinks for every chain at once. If the
                // venue refuses, the pot simply waits for the next fee.
                uint256 pot = f.burnPot;
                try venue.execBuy(token, pot) returns (uint256 out, uint256 spent, bool asc) {
                    f.burnPot = pot - spent;
                    f.burnedUsd += spent;
                    f.burnedTokens += out;
                    SpawnToken(token).bridgeBurn(address(this), out);
                    if (asc) emit Ascended(token, venue.curveOf(token).vBase, uint64(block.timestamp));
                    emit BuybackBurn(token, spent, out);
                    emit Trade(token, HUB_CHAIN, _b32(address(this)), true, spent, out, venue.spotPrice(token), uint64(block.timestamp));
                } catch {}
            }
        }
        if ((f.mode == FEE_HOLDERS || f.mode == FEE_SPLIT) && f.holders - f.holdersPaid >= DIST_TRIGGER) {
            _distributeHolders(token, f);
        }
        emit FeeAccrued(token, f.mode, fee);
    }

    /// Splits the accrued holders pot pro-rata to where the supply lives.
    /// ACCRUE, THEN PULL (v7): a chain's slice is only an entry in
    /// `pendingDrop` — no message leaves, so no trade can make the hub tank
    /// pay for a fan-out. Someone on that chain pulls it when they want it
    /// (OP_PULL_FEES, prepaid like any trade); it then lands in that chain's
    /// FeeDistributor and holders claim locally. Only `autoDrop` chains —
    /// where the drop is a free same-transaction call — are shipped here.
    function _distributeHolders(address token, FeeState storage f) internal {
        uint256 pot = f.holders - f.holdersPaid;
        uint256 circ;
        for (uint256 i = 0; i < chainLabels.length; i++) {
            circ += supplyByChain[token][chainLabels[i]];
        }
        if (circ == 0) return; // nobody holds yet — the pot keeps growing

        uint256 paid;
        for (uint256 i = 0; i < chainLabels.length; i++) {
            uint32 ch = chainLabels[i];
            uint256 share = (pot * supplyByChain[token][ch]) / circ;
            if (share == 0) continue;
            paid += share;
            if (autoDrop[ch]) {
                uint256 amount = share + pendingDrop[token][ch];
                // token id rides as bytes32 (wire convention). A drop that
                // cannot be shipped must not undo the trade that caused it:
                // it falls back to waiting for a pull.
                try messenger.send(ch, gateways[ch], abi.encode(OP_FEE_DROP, abi.encode(_b32(token), amount)), 0) {
                    // the slice left the hub's books and re-materialized in
                    // that chain's distributor — burn/mint, like every payout
                    pendingDrop[token][ch] = 0;
                    usd.bridgeBurn(address(this), amount);
                    continue;
                } catch {}
            }
            pendingDrop[token][ch] += share;
        }
        if (paid == 0) return; // a pot of dust splits into nothing
        f.holdersPaid += paid; // rounding dust stays in the pot
        emit HoldersDistributed(token, paid);
    }

    /// Someone on `srcChain` asked for that chain's waiting holder fees and
    /// prepaid the reply. Anything not yet split is split first, so the
    /// puller gets everything due. Nothing to send → no reply, no revert.
    function _pull(uint32 srcChain, address token) internal {
        FeeState storage f = feesOf[token];
        if ((f.mode == FEE_HOLDERS || f.mode == FEE_SPLIT) && f.holders > f.holdersPaid) {
            _distributeHolders(token, f);
        }
        uint256 amount = pendingDrop[token][srcChain];
        if (amount == 0) {
            // (an autoDrop chain was just served by the split above, if there was anything)
            if (!autoDrop[srcChain]) _refuse(OP_PULL_FEES, srcChain, _b32(token), bytes32(0), 0, R_NOTHING);
            return;
        }
        pendingDrop[token][srcChain] = 0;
        usd.bridgeBurn(address(this), amount);
        _reply(srcChain, OP_FEE_DROP, abi.encode(_b32(token), amount));
        emit FeesPulled(token, srcChain, amount);
    }

    /// The dev claims their accrued share, paid out on the chain they claim
    /// from — like every other payout. A claim by someone else, or with
    /// nothing accrued, is refused: it carries no value to send home.
    function _claim(uint32 srcChain, address token, bytes32 claimer) internal {
        FeeState storage f = feesOf[token];
        uint256 amount = f.dev - f.devClaimed;
        if (metas[token].creator != claimer || amount == 0) {
            _refuse(
                OP_CLAIM,
                srcChain,
                _b32(token),
                claimer,
                0,
                metas[token].creator != claimer ? R_NOT_DEV : R_NOTHING
            );
            return;
        }
        f.devClaimed += amount;
        usd.bridgeBurn(address(this), amount);
        _sendHome(srcChain, claimer, amount);
        emit DevClaimed(token, claimer, amount);
    }
}
