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
    uint8 public constant MAX_SPAWN_LEGS = 32;

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
        _sendBuy(hubToken, usdIn);
    }

    /// Buy with USDC (6 decimals), pulled into this chain's vault.
    function buyTokenUsdc(address hubToken, uint256 usdcIn) external payable nonReentrant whenNotPaused {
        require(usdcIn > 0, "GW: zero");
        _requireKnown(hubToken);
        _sendBuy(hubToken, usd.depositFor(msg.sender, usdcIn));
    }

    /// A message about a token id the hub does not know can do nothing
    /// there, and a BUY would have to be refunded across the wire — refuse
    /// it here, where a revert is atomic. A replica exists on this chain iff
    /// the hub spawned the token.
    function _requireKnown(address hubToken) internal view {
        require(address(replicaOf[hubToken]) != address(0), "GW: unknown token");
    }

    function _sendBuy(address hubToken, uint256 usdIn) internal {
        // token id + buyer ride as bytes32 (wire convention)
        messenger.send{value: msg.value}(
            HUB_CHAIN,
            _b32(pad),
            abi.encode(OP_BUY, abi.encode(_b32(hubToken), _b32(msg.sender), usdIn)),
            tradeLegs
        );
    }

    function sellToken(address hubToken, uint256 tokens) external payable nonReentrant {
        require(tokens > 0, "GW: zero");
        require(tokens >= MIN_AMOUNT, "GW: dust");
        SpawnToken rep = replicaOf[hubToken];
        require(address(rep) != address(0), "GW: no replica");
        rep.bridgeBurn(msg.sender, tokens);
        // token id + seller ride as bytes32 (wire convention)
        messenger.send{value: msg.value}(
            HUB_CHAIN,
            _b32(pad),
            abi.encode(OP_SELL, abi.encode(_b32(hubToken), _b32(msg.sender), tokens)),
            tradeLegs
        );
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
    /// payloads have a fixed size, so a placeholder payload quotes exactly;
    /// a SPAWN's size depends on its strings, so its quote takes them.

    function quoteBuy() external view returns (uint256) {
        return _quote(abi.encode(OP_BUY, abi.encode(bytes32(0), bytes32(0), uint256(0))), tradeLegs);
    }

    function quoteSell() external view returns (uint256) {
        return _quote(abi.encode(OP_SELL, abi.encode(bytes32(0), bytes32(0), uint256(0))), tradeLegs);
    }

    function quoteClaim() external view returns (uint256) {
        return _quote(abi.encode(OP_CLAIM, abi.encode(bytes32(0), bytes32(0))), tradeLegs);
    }

    function quotePull() external view returns (uint256) {
        return _quote(abi.encode(OP_PULL_FEES, abi.encode(bytes32(0))), tradeLegs);
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
