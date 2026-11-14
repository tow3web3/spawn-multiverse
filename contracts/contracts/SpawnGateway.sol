// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOmniMessenger, IOmniReceiver} from "./OmniMessenger.sol";
import {OmniUSD} from "./OmniUSD.sol";
import {SpawnToken} from "./SpawnToken.sol";
import {FeeDistributor} from "./FeeDistributor.sol";
import {Roles} from "./Roles.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SpawnGateway — one per user-facing chain.
/// @notice The gateway is the local face of the protocol: users spawn, buy and
/// sell here, on their own chain, in their own dollars. Under the hood every
/// action is forwarded to the hub's single global curve, and tokens / payouts
/// come back as omnichain messages.
///
/// Money enters two ways (v7): straight USDC (`buyTokenUsdc`,
/// `spawnTokenUsdc` — one USDC approval to this chain's OmniUSD vault) or
/// oUSD the user already holds (`buyToken`, `spawnToken` — no approval: the
/// gateway is this chain's authorized oUSD agent). Either way the SAME wire
/// message leaves. Money comes back through `OmniUSD.payout`: USDC when the
/// local vault is liquid, an oUSD claim otherwise — never a revert. The
/// gateway only ever moves funds of `msg.sender`.
///
/// Messages are paid by the user who causes them (v7): every action is
/// `payable` and forwards its native value to the messenger, which requires
/// the quoted fee — the outbound message plus the hub's replies it triggers
/// (`tradeLegs` for a buy/sell/claim/pull, `spawnLegs` more for a spawn's
/// SYNC fan-out). The `quote*` views return that fee exactly, before
/// signing. A short fee reverts the whole call: nothing is burned or pulled.
///
/// EVERY ORDER HAS A DEADLINE (v7.2). A buy or a sell sent from here is
/// stamped with `block.timestamp + orderTtl`; the hub refuses it whole — the
/// dollars or the bag come home — if it lands later than that. See
/// `orderTtl`.
///
/// v7.2 adds two actions that are not trades. `openToken` asks the hub for
/// this chain's replica of a token that never reached it (its SYNC was
/// skipped or failed, or the chain joined later). `moveClaim` sends an oUSD
/// claim to another chain of the universe, for the holder whose vault here
/// cannot pay it: the vaults do not all hold the same dollar, so they cannot
/// all be levelled with one another.
///
/// TWO RULES FOR REVERTS (v7).
///  - A USER CALL may revert freely: it is atomic, nothing is in flight. So
///    everything the hub would refuse is refused HERE first (unknown token,
///    bad fee mode, oversized strings, dust).
///  - A MESSAGE FROM THE HUB must not revert: it carries tokens or dollars
///    the hub already debited. What cannot be settled right now is PARKED
///    for its owner (`pendingDelivery`, `pendingFeeDrop`), never dropped.
contract SpawnGateway is IOmniReceiver, ReentrancyGuard, Roles {
    uint32 public constant HUB_CHAIN = 0;

    uint8 internal constant OP_SPAWN = 1;
    uint8 internal constant OP_BUY = 2;
    uint8 internal constant OP_SELL = 3;
    uint8 internal constant OP_CLAIM = 4;
    uint8 internal constant OP_PULL_FEES = 5;
    uint8 internal constant OP_OPEN = 6;
    uint8 internal constant OP_MOVE = 7;
    uint8 internal constant OP_SYNC_TOKEN = 10;
    uint8 internal constant OP_DELIVER = 11;
    uint8 internal constant OP_PAYOUT = 12;
    uint8 internal constant OP_FEE_DROP = 13;

    /// The hub knows four fee modes; anything else it would refuse.
    uint8 public constant MAX_FEE_MODE = 3;
    /// Spawn strings are stored on the hub and replayed to every chain: an
    /// oversized one could exhaust the gas the message bought and stall the
    /// spawn (and its dev buy) until someone retries it by hand.
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_SYMBOL_BYTES = 16;
    uint256 public constant MAX_META_BYTES = 1024;
    /// Below this (oUSD wei on a buy, token wei on a sell) the curve can
    /// round a trade to nothing; USDC's own smallest unit is exactly this.
    uint256 public constant MIN_AMOUNT = 1e12;
    /// Sanity bounds on what a user can be asked to prepay.
    uint8 public constant MAX_TRADE_LEGS = 4;
    /// (128 since v7.2: a SYNC toward Ethereum costs seven or eight times
    /// one toward an L2 and some 10 of an L2's reply units — measured on
    /// forks — so a launch that reaches it needs 15–30 of the origin's
    /// legs, and more as executor gas per kind of message shrinks the
    /// unit.)
    uint8 public constant MAX_SPAWN_LEGS = 128;
    uint8 public constant MAX_OPEN_LEGS = 8;
    /// A move is answered on ANOTHER chain, which can cost hundreds of this
    /// chain's reply units (an L1 seen from an L2).
    uint16 public constant MAX_MOVE_LEGS = 4096;
    /// Bounds on `orderTtl`, so that there is always a deadline and never
    /// an absurd one. The floor is a guard against a slip, NOT a promise
    /// that an order reaches the hub that fast from every chain: a message
    /// waits for its source chain's block confirmations before it is even
    /// verified (some three minutes from Ethereum), so the lifetime is set
    /// per chain, well above what that chain's messages take. Set too
    /// short, every order from here bounces whole until it is lengthened.
    uint32 public constant MIN_ORDER_TTL = 2 minutes;
    uint32 public constant MAX_ORDER_TTL = 1 days;

    IOmniMessenger public immutable messenger;
    OmniUSD public immutable usd; // this chain's instance
    uint32 public immutable chainLabel;
    address public immutable pad;
    /// This chain's holder-dividend pool; replicas report transfers to it and
    /// the hub drops fee slices into it.
    FeeDistributor public distributor;
    /// Circuit breaker for NEW exposure only: spawns and buys. Sells, dev
    /// claims, fee pulls and parked-delivery claims stay open, always.
    bool public paused;

    /// hub token address -> native replica on this chain
    mapping(address => SpawnToken) public replicaOf;

    /// Replies the hub sends back because of one message from this chain,
    /// prepaid by the user: `tradeLegs` for the DELIVER / PAYOUT / FEE_DROP
    /// of a buy, sell, claim or pull (1 on a remote chain, 0 on the hub's
    /// own chain where the reply is a free local call), `spawnLegs` for the
    /// SYNC fan-out of a spawn (the number of REMOTE chains the hub must
    /// reach).
    uint8 public tradeLegs;
    uint8 public spawnLegs;
    /// Legs prepaid by `openToken` (v7.2): the SYNC the hub sends back to
    /// THIS chain. It has its own count because a SYNC can cost more than
    /// the DELIVER a trade leg is priced on. It starts at 1, not 0: on a
    /// remote chain an open that prepays nothing would be paid by the hub
    /// tank, and anyone could ask for one. The hub chain's own gateway is
    /// set to 0 (its SYNC is a free local call).
    uint8 public openLegs = 1;
    /// HOW LONG AN ORDER LIVES (v7.2), in seconds. Every BUY and SELL this
    /// gateway sends — plain or `...Min` — carries `block.timestamp +
    /// orderTtl` as its deadline, and the hub refuses an order that lands
    /// after it exactly as it refuses one under its minimum: a buy's dollars
    /// ride home whole, a sold bag is delivered back. Orders get stuck when
    /// something of ours fails (an empty tank, executor gas set too low, a
    /// paused leg) — many at once — and delivery is open to anyone: without
    /// a deadline, each one stays executable at its minimum for ever, for
    /// whoever finds the moment the price has moved away from it. With one,
    /// a stale order bounces and the incident ends in refunds.
    ///
    /// There is always a deadline: the operator can move it only between
    /// `MIN_ORDER_TTL` and `MAX_ORDER_TTL`. No caller chooses it, so no
    /// signature changed.
    ///
    /// TWO CLOCKS: the deadline is THIS chain's `block.timestamp` plus the
    /// lifetime, and the hub compares it with its own. If this chain's
    /// clock runs behind the hub's, orders expire that much early and
    /// bounce whole (lengthen `orderTtl`); if it runs ahead, they live that
    /// much longer and are still bounded by their minimum. On the hub's own
    /// chain the order executes in the very transaction that sends it and
    /// can never be late.
    uint32 public orderTtl = 30 minutes;
    /// Legs prepaid by `moveClaim` (v7.2), per DESTINATION chain: what the
    /// hub pays to carry the PAYOUT there, in this chain's reply units —
    /// never fewer than `tradeLegs`, which pays for the way back if the
    /// hub has to return the claim. 0 = no price was set: moves to that
    /// chain are refused. `tradeLegs` alone would not do: it is priced on a
    /// reply to THIS chain, and it is 0 on the hub chain's own gateway —
    /// where a move would then make the hub tank pay a remote message for
    /// nothing, as often as anyone liked.
    mapping(uint32 => uint16) public moveLegs;

    /// Tokens the hub delivered that could not be minted when they landed
    /// (the replica's SYNC had not arrived yet, or the mint failed):
    /// hub token -> recipient -> amount. The recipient claims them.
    mapping(address => mapping(address => uint256)) public pendingDelivery;
    /// Holder fees that landed before this chain could book them (no
    /// replica or no distributor yet): hub token -> oUSD. Flushed by the
    /// SYNC that creates the replica, or by anyone via `flushFeeDrop`.
    mapping(address => uint256) public pendingFeeDrop;

    event ReplicaDeployed(address indexed hubToken, address replica, string name, string symbol);
    event LegsSet(uint8 tradeLegs, uint8 spawnLegs);
    event OpenLegsSet(uint8 openLegs);
    event OrderTtlSet(uint32 ttl);
    event MoveLegsSet(uint32 indexed dstChain, uint16 legs);
    /// `from` burned `amount` of oUSD here and asked the hub to pay it to
    /// (`dstChain`, `to`). The hub's `Moved` says where it ended up.
    event ClaimMoved(address indexed from, uint32 indexed dstChain, bytes32 to, uint256 amount);
    event DistributorSet(address distributor);
    event Paused(address by);
    event Unpaused(address by);
    event DeliveryParked(address indexed hubToken, address indexed to, uint256 tokens);
    event DeliveryClaimed(address indexed hubToken, address indexed to, uint256 tokens);
    event FeeDropParked(address indexed hubToken, uint256 amount);
    event FeeDropFlushed(address indexed hubToken, uint256 amount);

    constructor(IOmniMessenger _messenger, OmniUSD _usd, uint32 _chainLabel, address _pad) {
        // A gateway settles real dollars: wiring it to a ledger-mode oUSD
        // would make every payout revert on the message path.
        require(address(_usd.usdc()) != address(0), "GW: ledger usd");
        // The hub is authenticated as (chain 0, the pad's address) coming
        // from the messenger: neither may be the zero address, or "nobody"
        // would pass for the hub. And label 0 IS the hub — never a gateway.
        require(address(_messenger) != address(0) && _pad != address(0), "GW: zero address");
        require(_chainLabel != HUB_CHAIN, "GW: hub label");
        messenger = _messenger;
        usd = _usd;
        chainLabel = _chainLabel;
        pad = _pad;
    }

    /* ----------------------------- config ----------------------------- */

    function setDistributor(FeeDistributor d) external onlyAdmin {
        require(address(distributor) == address(0), "GW: distributor set");
        distributor = d;
        emit DistributorSet(address(d));
    }

    function setLegs(uint8 trade, uint8 spawn) external onlyOperator {
        require(trade <= MAX_TRADE_LEGS && spawn <= MAX_SPAWN_LEGS, "GW: legs too high");
        tradeLegs = trade;
        spawnLegs = spawn;
        emit LegsSet(trade, spawn);
    }

    function setOpenLegs(uint8 legs) external onlyOperator {
        require(legs <= MAX_OPEN_LEGS, "GW: legs too high");
        openLegs = legs;
        emit OpenLegsSet(legs);
    }

    /// How long the orders sent from here stay executable on the hub — see
    /// `orderTtl`. Orders already in flight keep the deadline they left with.
    function setOrderTtl(uint32 ttl) external onlyOperator {
        require(ttl >= MIN_ORDER_TTL && ttl <= MAX_ORDER_TTL, "GW: bad ttl");
        orderTtl = ttl;
        emit OrderTtlSet(ttl);
    }

    /// Prices — and thereby opens — moves from this chain to `dstChain`;
    /// 0 closes them again.
    function setMoveLegs(uint32 dstChain, uint16 legs) external onlyOperator {
        require(legs <= MAX_MOVE_LEGS, "GW: legs too high");
        moveLegs[dstChain] = legs;
        emit MoveLegsSet(dstChain, legs);
    }

    function pause() external onlyGuardian {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOperator {
        paused = false;
        emit Unpaused(msg.sender);
    }

    modifier whenNotPaused() {
        require(!paused, "GW: paused");
        _;
    }

    /* ------------------------- user actions ------------------------- */

    /// WIRE CONVENTION: every account rider in a cross-chain payload is a
    /// `bytes32`, so 32-byte chains (Solana) ride the same messages as EVM
    /// ones. EVM addresses left-pad with zeros on send; a value consumed as
    /// an EVM `address` must have its top 12 bytes zero, checked here.
    function _addr(bytes32 b) internal pure returns (address) {
        require(uint256(b) >> 160 == 0, "GW: bad recipient");
        return address(uint160(uint256(b)));
    }

    function _b32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// Spawn paying the optional dev buy in oUSD already held.
    function spawnToken(
        string calldata name,
        string calldata symbol,
        string calldata metaURI,
        uint256 devBuyUsd,
        uint8 feeMode
    ) external payable nonReentrant whenNotPaused {
        _checkSpawn(name, symbol, metaURI, feeMode);
        // same floor as `buyToken`: a dev buy the curve would round to
        // nothing is refused here, not bounced back across the wire
        require(devBuyUsd == 0 || devBuyUsd >= MIN_AMOUNT, "GW: dust");
        if (devBuyUsd > 0) usd.bridgeBurn(msg.sender, devBuyUsd);
        _sendSpawn(name, symbol, metaURI, devBuyUsd, feeMode);
    }

    /// Spawn paying the optional dev buy in USDC (6 decimals).
    function spawnTokenUsdc(
        string calldata name,
        string calldata symbol,
        string calldata metaURI,
        uint256 devBuyUsdc,
        uint8 feeMode
    ) external payable nonReentrant whenNotPaused {
        _checkSpawn(name, symbol, metaURI, feeMode);
        uint256 devBuyUsd = devBuyUsdc > 0 ? usd.depositFor(msg.sender, devBuyUsdc) : 0;
        _sendSpawn(name, symbol, metaURI, devBuyUsd, feeMode);
    }

    /// Everything the hub would refuse about a spawn, refused here where a
    /// revert costs the user nothing.
    function _checkSpawn(
        string calldata name,
        string calldata symbol,
        string calldata metaURI,
        uint8 feeMode
    ) internal pure {
        require(feeMode <= MAX_FEE_MODE, "GW: bad fee mode");
        require(
            bytes(name).length <= MAX_NAME_BYTES &&
                bytes(symbol).length <= MAX_SYMBOL_BYTES &&
                bytes(metaURI).length <= MAX_META_BYTES,
            "GW: string too long"
        );
    }

    function _sendSpawn(
        string calldata name,
        string calldata symbol,
        string calldata metaURI,
        uint256 devBuyUsd,
        uint8 feeMode
    ) internal {
        messenger.send{value: msg.value}(
            HUB_CHAIN,
            _b32(pad),
            // creator rides as bytes32; the hub consumes it as an address
            abi.encode(OP_SPAWN, abi.encode(_b32(msg.sender), name, symbol, metaURI, devBuyUsd, feeMode)),
            _spawnLegs(devBuyUsd > 0)
        );
    }

    /// A spawn makes the hub SYNC every remote chain, and a dev buy adds the
    /// DELIVER that brings the creator's bag home.
    function _spawnLegs(bool withDevBuy) internal view returns (uint256) {
        return uint256(spawnLegs) + (withDevBuy ? tradeLegs : 0);
    }

    /// The dev claims their accrued fee share; the pad pays out on THIS chain.
    function claimFees(address hubToken) external payable nonReentrant {
        _requireKnown(hubToken);
        // token id + claimer ride as bytes32 (wire convention)
        messenger.send{value: msg.value}(
            HUB_CHAIN,
            _b32(pad),
            abi.encode(OP_CLAIM, abi.encode(_b32(hubToken), _b32(msg.sender))),
            tradeLegs
        );
    }

    /// Brings home this chain's share of a token's holder fees (v7: the hub
    /// accrues it and waits to be asked — see SpawnPad._distributeHolders).
    /// Anyone may pull; it lands in this chain's FeeDistributor for every
    /// holder here, who then claim locally. The caller pays the round trip.
    function pullFees(address hubToken) external payable nonReentrant {
        _requireKnown(hubToken);
        messenger.send{value: msg.value}(
            HUB_CHAIN,
            _b32(pad),
            abi.encode(OP_PULL_FEES, abi.encode(_b32(hubToken))),
            tradeLegs
        );
    }

    /// Buy with oUSD already held (18 decimals).
    function buyToken(address hubToken, uint256 usdIn) external payable nonReentrant whenNotPaused {
        require(usdIn > 0, "GW: zero");
        require(usdIn >= MIN_AMOUNT, "GW: dust");
        _requireKnown(hubToken);
        usd.bridgeBurn(msg.sender, usdIn);
        _sendBuy(hubToken, usdIn, 0);
    }

    /// Buy with USDC (6 decimals), pulled into this chain's vault.
    function buyTokenUsdc(address hubToken, uint256 usdcIn) external payable nonReentrant whenNotPaused {
        require(usdcIn > 0, "GW: zero");
        _requireKnown(hubToken);
        _sendBuy(hubToken, usd.depositFor(msg.sender, usdcIn), 0);
    }

    /// A message about a token id the hub does not know can do nothing
    /// there, and a BUY would have to be refunded across the wire — refuse
    /// it here, where a revert is atomic. A replica exists on this chain iff
    /// the hub spawned the token.
    function _requireKnown(address hubToken) internal view {
        require(address(replicaOf[hubToken]) != address(0), "GW: unknown token");
    }

    /// `minTokensOut` rides the wire (v7.2): the hub refuses the buy whole,
    /// and sends every dollar home, if it would fill for less. 0 = any fill.
    /// So does the order's deadline, and the hub does the same after it.
    function _sendBuy(address hubToken, uint256 usdIn, uint256 minTokensOut) internal {
        // token id + buyer ride as bytes32 (wire convention)
        messenger.send{value: msg.value}(
            HUB_CHAIN,
            _b32(pad),
            abi.encode(OP_BUY, abi.encode(_b32(hubToken), _b32(msg.sender), usdIn, minTokensOut, _deadline())),
            tradeLegs
        );
    }

    /// The last second at which the hub will still execute an order sent
    /// now (see `orderTtl`).
    function _deadline() internal view returns (uint256) {
        return block.timestamp + orderTtl;
    }

    function sellToken(address hubToken, uint256 tokens) external payable nonReentrant {
        _sell(hubToken, tokens, 0);
    }

    /// `minUsdOut` rides the wire (v7.2): what the seller must be PAID, net
    /// of the fee, in 18-decimal dollars — or the hub refuses the sale and
    /// sends the bag back. 0 = any price. The order's deadline rides with
    /// it: after it, the bag comes back too.
    function _sell(address hubToken, uint256 tokens, uint256 minUsdOut) internal {
        require(tokens > 0, "GW: zero");
        require(tokens >= MIN_AMOUNT, "GW: dust");
        SpawnToken rep = replicaOf[hubToken];
        require(address(rep) != address(0), "GW: no replica");
        rep.bridgeBurn(msg.sender, tokens);
        // token id + seller ride as bytes32 (wire convention)
        messenger.send{value: msg.value}(
            HUB_CHAIN,
            _b32(pad),
            abi.encode(OP_SELL, abi.encode(_b32(hubToken), _b32(msg.sender), tokens, minUsdOut, _deadline())),
            tradeLegs
        );
    }

    /* --------------- opening a token, moving a claim (v7.2) --------------- */

    /// Asks the hub for this chain's replica of a token it never got: the
    /// SYNC was skipped at spawn (its fee was above the hub's ceiling for
    /// this chain), failed, or the chain joined after the launch. The caller
    /// pays the round trip in THIS chain's coin — the message, and the SYNC
    /// the hub sends back (`openLegs`). Nothing else moves. The hub refuses
    /// an id it never spawned, and does not send a SYNC that costs more
    /// than its ceiling for requests toward this chain right now
    /// (`SpawnPad.requestCap` — set to what an open prepays): the fee is
    /// then spent and the token still closed, so a frontend should compare
    /// the hub's quote with that ceiling before offering this.
    function openToken(address hubToken) external payable nonReentrant whenNotPaused {
        require(address(replicaOf[hubToken]) == address(0), "GW: already open");
        messenger.send{value: msg.value}(
            HUB_CHAIN,
            _b32(pad),
            abi.encode(OP_OPEN, abi.encode(_b32(hubToken))),
            openLegs
        );
    }

    /// Sends a dollar claim (oUSD) to `to` on another chain, whose vault
    /// pays it in that chain's dollar if it can and as a claim there if it
    /// cannot. For the claim a short vault left behind: dollars enter where
    /// buyers are and leave where sellers are, and a vault that settles in
    /// another dollar cannot be levelled with the rest (docs/SPEC.md §7).
    /// `to` is a wide id: an address left-padded for an EVM chain.
    ///
    /// An EXIT: it ignores the pause. If the hub cannot hand the claim on —
    /// no such chain, a recipient that chain cannot pay, a leg that fails or
    /// costs more right now than the hub's ceiling for it
    /// (`SpawnPad.requestCap`) — it comes back to the caller here, as
    /// dollars or as the same claim. The caller pays the message and the
    /// hub's leg to the destination (`moveLegs`).
    function moveClaim(uint32 dstChain, bytes32 to, uint256 amount) external payable nonReentrant {
        require(amount >= MIN_AMOUNT, "GW: dust");
        require(to != bytes32(0) && dstChain != chainLabel && dstChain != HUB_CHAIN, "GW: bad destination");
        uint256 legs = _moveLegs(dstChain);
        usd.bridgeBurn(msg.sender, amount);
        messenger.send{value: msg.value}(
            HUB_CHAIN,
            _b32(pad),
            abi.encode(OP_MOVE, abi.encode(_b32(msg.sender), to, amount, dstChain)),
            legs
        );
        emit ClaimMoved(msg.sender, dstChain, to, amount);
    }

    /// What a move to `dstChain` prepays; reverts for a chain with no price.
    function _moveLegs(uint32 dstChain) internal view returns (uint256 legs) {
        legs = moveLegs[dstChain];
        require(legs != 0, "GW: route closed");
        if (legs < tradeLegs) legs = tradeLegs;
    }

    /* -------------- slippage protection (v7.1, v7.2) -------------- */

    /// ALL-OR-NOTHING TRADES, ON EVERY CHAIN (v7.2). A plain buy or sell
    /// names no price: it takes what the curve gives when it executes. Across
    /// chains that is minutes after the order became public on its source
    /// chain, and anyone may deliver it — so it can be sandwiched inside ONE
    /// hub-chain transaction (buy, deliver the victim's message, sell). These
    /// three functions do exactly what `buyToken`, `buyTokenUsdc` and
    /// `sellToken` do, and put the caller's minimum ON THE WIRE: the hub
    /// enforces it where the price is, and under it the trade does not
    /// happen at all — a buy's dollars come home whole, a sold bag is
    /// delivered back. A fill cut down by FAIR GENESIS or by the end of the
    /// curve is under the minimum too: all or nothing.
    ///
    /// WHERE THE HUB ANSWERS IN THIS VERY TRANSACTION (the hub chain's own
    /// gateway: the messenger is a loopback, so the DELIVER or the PAYOUT has
    /// ALREADY been executed when `messenger.send` returns) the call does
    /// more, as it did in v7.1: it looks at what the caller actually holds
    /// when it returns and REVERTS THE WHOLE TRANSACTION ("GW: min out") if
    /// that rose by less than the minimum. What counts is a BALANCE: replica
    /// tokens for a buy; for a sell, the vault's dollar token plus any oUSD
    /// claim (a short vault pays in claims), in 18-decimal dollars. So a
    /// trade the hub refused, a buy bounced in the launch block or by a
    /// paused hub, and a delivery that had to be parked all revert — the
    /// caller keeps what they came with, and a wallet sees it in simulation.
    ///
    /// ON A REMOTE CHAIN the reply lands minutes later, so there is nothing
    /// to look at: the call returns once the message is sent, and the hub's
    /// refusal — not a revert here — is what protects the trade. The caller
    /// then gets their dollars (or their bag) back by the reply instead of
    /// never having parted with them; the messaging fee is spent.
    ///
    /// A minimum of 0 is refused: it would make these the unprotected
    /// functions under another name.

    /// Buy with USDC (6 decimals) for at least `minTokensOut` tokens, or not
    /// at all.
    function buyTokenUsdcMin(address hubToken, uint256 usdcIn, uint256 minTokensOut)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        require(usdcIn > 0, "GW: zero");
        (SpawnToken rep, uint256 bag) = _bagBefore(hubToken, minTokensOut);
        _sendBuy(hubToken, usd.depositFor(msg.sender, usdcIn), minTokensOut);
        _requireBag(rep, bag, minTokensOut);
    }

    /// Buy with oUSD already held (18 decimals), same guarantee.
    function buyTokenMin(address hubToken, uint256 usdIn, uint256 minTokensOut)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        require(usdIn > 0, "GW: zero");
        require(usdIn >= MIN_AMOUNT, "GW: dust");
        (SpawnToken rep, uint256 bag) = _bagBefore(hubToken, minTokensOut);
        usd.bridgeBurn(msg.sender, usdIn);
        _sendBuy(hubToken, usdIn, minTokensOut);
        _requireBag(rep, bag, minTokensOut);
    }

    /// Sell for at least `minDollarsOut` — what the seller is PAID, net of
    /// the fee, in 18-decimal dollars (dollar tokens × SCALE, plus oUSD
    /// claims) — or not at all. Like every exit, it ignores the pause.
    function sellTokenMin(address hubToken, uint256 tokens, uint256 minDollarsOut)
        external
        payable
        nonReentrant
    {
        require(minDollarsOut > 0, "GW: zero min");
        bool answersNow = _hubAnswersNow();
        uint256 before = answersNow ? _dollarsOf(msg.sender) : 0;
        _sell(hubToken, tokens, minDollarsOut);
        if (answersNow) _requireRise(before, _dollarsOf(msg.sender), minDollarsOut);
    }

    /// True where the hub's reply has already been executed when
    /// `messenger.send` returns: the hub lives on this chain.
    function _hubAnswersNow() internal view returns (bool) {
        return messenger.isLocal(HUB_CHAIN);
    }

    /// Where the hub has already answered: the caller's bag must have grown
    /// by `min`, or the whole transaction is undone.
    function _requireBag(SpawnToken rep, uint256 bag, uint256 min) internal view {
        if (_hubAnswersNow()) _requireRise(bag, rep.balanceOf(msg.sender), min);
    }

    /// `"GW: min out"` unless `afterwards` is at least `before + min` —
    /// written so that no minimum, however large, is an overflow instead.
    function _requireRise(uint256 before, uint256 afterwards, uint256 min) internal pure {
        require(afterwards >= before && afterwards - before >= min, "GW: min out");
    }

    /// The caller's bag of `hubToken` on this chain before a protected buy.
    function _bagBefore(address hubToken, uint256 minTokensOut)
        internal
        view
        returns (SpawnToken rep, uint256 bag)
    {
        require(minTokensOut > 0, "GW: zero min");
        rep = replicaOf[hubToken];
        require(address(rep) != address(0), "GW: unknown token");
        bag = rep.balanceOf(msg.sender);
    }

    /// Everything `who` holds in this chain's dollars, in 18 decimals: the
    /// vault's dollar token and the oUSD claims on it.
    function _dollarsOf(address who) internal view returns (uint256) {
        return usd.usdc().balanceOf(who) * usd.SCALE() + usd.balanceOf(who);
    }

    /// Mints the caller's parked deliveries of `hubToken` (see
    /// `pendingDelivery`). A plain local transaction, no message.
    function claimPending(address hubToken) external nonReentrant returns (uint256 tokens) {
        SpawnToken rep = replicaOf[hubToken];
        require(address(rep) != address(0), "GW: no replica");
        tokens = pendingDelivery[hubToken][msg.sender];
        require(tokens > 0, "GW: nothing pending");
        pendingDelivery[hubToken][msg.sender] = 0;
        rep.bridgeMint(msg.sender, tokens);
        emit DeliveryClaimed(hubToken, msg.sender, tokens);
    }

    /// Books parked holder fees of `hubToken` into the distributor once the
    /// replica and the distributor both exist. Anyone may call.
    function flushFeeDrop(address hubToken) external nonReentrant {
        require(_flushFeeDrop(hubToken), "GW: nothing to flush");
    }

    /* ---------------------------- quotes ---------------------------- */

    /// The native fee each action requires right now — call before signing
    /// and attach the result as msg.value. BUY, SELL, CLAIM and PULL
    /// payloads have a fixed size (with or without a minimum: that word and
    /// the deadline's are always there), so a placeholder payload quotes
    /// exactly;
    /// a SPAWN's size depends on its strings, so its quote takes them.

    function quoteBuy() external view returns (uint256) {
        return
            _quote(
                abi.encode(OP_BUY, abi.encode(bytes32(0), bytes32(0), uint256(0), uint256(0), uint256(0))),
                tradeLegs
            );
    }

    function quoteSell() external view returns (uint256) {
        return
            _quote(
                abi.encode(OP_SELL, abi.encode(bytes32(0), bytes32(0), uint256(0), uint256(0), uint256(0))),
                tradeLegs
            );
    }

    function quoteClaim() external view returns (uint256) {
        return _quote(abi.encode(OP_CLAIM, abi.encode(bytes32(0), bytes32(0))), tradeLegs);
    }

    function quotePull() external view returns (uint256) {
        return _quote(abi.encode(OP_PULL_FEES, abi.encode(bytes32(0))), tradeLegs);
    }

    function quoteOpen() external view returns (uint256) {
        return _quote(abi.encode(OP_OPEN, abi.encode(bytes32(0))), openLegs);
    }

    /// The price depends on where the claim goes; reverts ("GW: route
    /// closed") for a destination this chain has no price for.
    function quoteMove(uint32 dstChain) external view returns (uint256) {
        return
            _quote(
                abi.encode(OP_MOVE, abi.encode(bytes32(0), bytes32(0), uint256(0), uint32(0))),
                _moveLegs(dstChain)
            );
    }

    function quoteSpawn(
        string calldata name,
        string calldata symbol,
        string calldata metaURI,
        bool withDevBuy
    ) external view returns (uint256) {
        return
            _quote(
                abi.encode(OP_SPAWN, abi.encode(bytes32(0), name, symbol, metaURI, uint256(0), uint8(0))),
                _spawnLegs(withDevBuy)
            );
    }

    function _quote(bytes memory payload, uint256 legs) internal view returns (uint256) {
        return messenger.quote(HUB_CHAIN, _b32(pad), payload, legs);
    }

    /* -------------------------- messaging -------------------------- */

    /// NOT nonReentrant on purpose: on the hub's own chain the messenger is
    /// a loopback, so the pad's reply re-enters here while the user's call
    /// above is still on the stack. Authentication is the two checks below.
    ///
    /// The `_addr` downcasts below stay as reverts: this is an EVM chain, so
    /// every recipient and token id the hub echoes back was a local address
    /// when it left (a prior `msg.sender`, a hub token). A wide value here
    /// is corruption, and there is no EVM account to park it for.
    function onOmniMessage(uint32 srcChain, bytes32 srcSender, bytes calldata payload) external {
        require(msg.sender == address(messenger), "GW: not messenger");
        require(srcChain == HUB_CHAIN && srcSender == _b32(pad), "GW: not the pad");
        (uint8 op, bytes memory data) = abi.decode(payload, (uint8, bytes));
        if (op == OP_SYNC_TOKEN) {
            (bytes32 hubTokenB, string memory name, string memory symbol) = abi.decode(
                data,
                (bytes32, string, string)
            );
            address hubToken = _addr(hubTokenB);
            // a replica is forever: a second SYNC must not orphan the first
            if (address(replicaOf[hubToken]) != address(0)) return;
            // A replica deployed with no holder pool could never be given
            // one: its holders would earn nothing, forever. This is a wiring
            // error, and a SYNC carries no user value, so it fails loudly
            // and stays retryable until the admin has set the distributor.
            require(address(distributor) != address(0), "GW: no distributor");
            SpawnToken rep = new SpawnToken(
                name,
                symbol,
                address(this),
                false,
                0,
                address(0),
                address(distributor)
            );
            replicaOf[hubToken] = rep;
            emit ReplicaDeployed(hubToken, address(rep), name, symbol);
            // holder fees that beat the SYNC here can be booked now
            _flushFeeDrop(hubToken);
        } else if (op == OP_DELIVER) {
            (bytes32 hubTokenB, bytes32 toB, uint256 tokens, uint256 refund) = abi.decode(
                data,
                (bytes32, bytes32, uint256, uint256)
            );
            address hubToken = _addr(hubTokenB);
            address to = _addr(toB);
            if (tokens > 0) _deliver(hubToken, to, tokens);
            // refunds settle like every payout: USDC if liquid, else oUSD
            if (refund > 0) usd.payout(to, refund);
        } else if (op == OP_PAYOUT) {
            (bytes32 to, uint256 usdOut) = abi.decode(data, (bytes32, uint256));
            usd.payout(_addr(to), usdOut);
        } else if (op == OP_FEE_DROP) {
            (bytes32 hubTokenB, uint256 amount) = abi.decode(data, (bytes32, uint256));
            address hubToken = _addr(hubTokenB);
            // the hub burned this slice of the holders pot; it re-materializes
            // in the local distributor — or waits until it can be booked
            pendingFeeDrop[hubToken] += amount;
            if (!_flushFeeDrop(hubToken)) emit FeeDropParked(hubToken, amount);
        } else {
            revert("GW: bad op");
        }
    }

    /// Mints a delivery, or parks it for its recipient. Delivery is
    /// unordered, so a DELIVER can land before the SYNC that creates the
    /// replica (a spawn with a dev buy sends both); and a mint that fails
    /// for any reason must not strand what the hub already debited.
    ///
    /// The try cannot be turned into a forced park by starving it of gas:
    /// the call gets 63/64 of what is left, and the park needs a fresh
    /// storage slot out of the remaining 1/64 — whoever leaves enough for
    /// the park has left far more than a mint costs.
    function _deliver(address hubToken, address to, uint256 tokens) internal {
        SpawnToken rep = replicaOf[hubToken];
        if (address(rep) != address(0)) {
            try rep.bridgeMint(to, tokens) {
                return;
            } catch {}
        }
        pendingDelivery[hubToken][to] += tokens;
        emit DeliveryParked(hubToken, to, tokens);
    }

    /// Books `pendingFeeDrop[hubToken]` into the distributor, keyed by this
    /// chain's replica. Returns false (and leaves it parked) while the
    /// replica or the distributor is missing, or if the distributor refuses.
    function _flushFeeDrop(address hubToken) internal returns (bool) {
        uint256 amount = pendingFeeDrop[hubToken];
        SpawnToken rep = replicaOf[hubToken];
        if (amount == 0 || address(rep) == address(0) || address(distributor) == address(0)) return false;
        try distributor.drop(address(rep), amount) {
            pendingFeeDrop[hubToken] = 0;
            usd.bridgeMint(address(distributor), amount);
            emit FeeDropFlushed(hubToken, amount);
            return true;
        } catch {
            return false;
        }
    }
}
