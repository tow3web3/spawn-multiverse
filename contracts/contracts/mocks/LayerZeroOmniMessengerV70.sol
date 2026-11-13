// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOmniMessenger, IOmniReceiver} from "../OmniMessenger.sol";
import {
    ILayerZeroEndpointV2,
    ILayerZeroReceiver,
    MessagingParams,
    MessagingFee,
    Origin
} from "../lz/ILayerZeroV2.sol";
import {Roles} from "../Roles.sol";

/// @title LayerZeroOmniMessengerV70 — RETIRED. TEST ONLY. NEVER DEPLOY.
/// @notice A frozen, byte-for-byte copy of the body of the transport adapter
/// that ran the v7.0 mainnet deployment (git 4e3552d), kept for ONE purpose:
/// the regression test of SPEC finding F-11 delivers the same forged packet
/// to this contract (which pays it) and to the v7.1 adapter (which refuses
/// it). Its `lzReceive` and `allowInitializePath` compare an UNSET peer
/// (bytes32(0)) with the packet's sender, so a zero-sender packet from a
/// chain that was never configured is taken for the hub. Do not fix it here:
/// the fix lives in lz/LayerZeroOmniMessenger.sol.
contract LayerZeroOmniMessengerV70 is IOmniMessenger, ILayerZeroReceiver, Roles {
    /// Hard ceiling on the reply budget per leg an operator can make users
    /// prepay (destination-chain native currency).
    uint128 public constant MAX_RETURN_UNIT = 0.05 ether;

    ILayerZeroEndpointV2 public immutable endpoint;
    uint32 public immutable localEid;

    /// Local protocol contracts allowed to send through this adapter, and
    /// the chain label each one speaks for.
    mapping(address => bool) public senders;
    mapping(address => uint32) public labelOfSender;
    /// Senders whose fees ride the tank instead of msg.value.
    mapping(address => bool) public sponsored;
    /// Chain labels hosted on this very chain (loopback destinations).
    mapping(uint32 => bool) public isLocal;
    /// SPAWN! chain label -> remote LayerZero eid (and back).
    mapping(uint32 => uint32) public eidOf;
    mapping(uint32 => uint32) public labelOf;
    /// Remote eid -> the peer adapter over there.
    mapping(uint32 => bytes32) public peers;
    /// Per destination label: executor gas for lzReceive over there, and the
    /// native amount (destination currency) forwarded per prepaid reply.
    mapping(uint32 => uint128) public gasLimit;
    mapping(uint32 => uint128) public returnUnit;

    /// One event per message, enough to audit the fee model: what the route
    /// cost (`nativeFee`), how much of it was reply budget
    /// (`valueForwarded`), what the caller attached (`paid` — less than the
    /// fee only for a sponsored sender), and whether it was a loopback.
    event Routed(
        uint32 indexed dstChain,
        uint32 indexed dstEid,
        bytes32 guid,
        uint256 nativeFee,
        uint256 valueForwarded,
        uint256 paid,
        bool local
    );

    event SenderRegistered(address indexed sender, uint32 label);
    event SenderUnregistered(address indexed sender);
    event SponsoredSet(address indexed sender, bool on);
    event LocalSet(uint32 indexed chainLabel, bool on);
    event RouteSet(uint32 indexed chainLabel, uint32 eid, bytes32 peer);
    event RouteRepointed(uint32 indexed chainLabel, uint32 oldEid, bytes32 oldPeer, uint32 eid, bytes32 peer);
    event DestinationSet(uint32 indexed chainLabel, uint128 gas, uint128 unit);
    event DelegateSet(address delegate);
    event Recovered(address to, uint256 amount);

    constructor(ILayerZeroEndpointV2 _endpoint, uint32 _localEid) {
        endpoint = _endpoint;
        localEid = _localEid;
        // Without a delegate nobody can call endpoint.setConfig for this
        // OApp, and it would ride LayerZero's default DVN set forever.
        _endpoint.setDelegate(msg.sender);
        emit DelegateSet(msg.sender);
    }

    /// The DVN set is custody security, so the right to choose it follows
    /// the admin: a new admin becomes the endpoint delegate as it accepts.
    function _onAdminChanged(address newAdmin) internal override {
        endpoint.setDelegate(newAdmin);
        emit DelegateSet(newAdmin);
    }

    /// The gas tank: anyone may top the adapter up with native currency.
    receive() external payable {}

    /* ------------------------- admin (topology) ------------------------- */

    /// Tank recovery: lets the admin drain the gas tank when this adapter is
    /// retired (an incompatible upgrade must never strand testnet ETH again).
    function recover(address payable to) external onlyAdmin {
        uint256 amount = address(this).balance;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "LZM: recover failed");
        emit Recovered(to, amount);
    }

    /// Admits a local protocol contract and records the chain label it
    /// speaks for (hub adapter: pad -> 0, the hub chain's gateway -> its
    /// label). The label is what a loopback hands the receiver as source.
    function register(address sender_, uint32 label) external onlyAdmin {
        senders[sender_] = true;
        labelOfSender[sender_] = label;
        emit SenderRegistered(sender_, label);
    }

    function unregister(address sender_) external onlyAdmin {
        delete senders[sender_];
        delete labelOfSender[sender_];
        delete sponsored[sender_];
        emit SenderUnregistered(sender_);
    }

    function setSponsored(address sender_, bool on) external onlyAdmin {
        sponsored[sender_] = on;
        emit SponsoredSet(sender_, on);
    }

    /// A label is either hosted here or reached over LayerZero, never both.
    function setLocal(uint32 chainLabel, bool on) external onlyAdmin {
        require(eidOf[chainLabel] == 0, "LZM: label routed");
        isLocal[chainLabel] = on;
        emit LocalSet(chainLabel, on);
    }

    /// Opens the route to a chain: one label, one eid, one peer. It refuses
    /// a label that already has a route and an eid that already has a
    /// label — changing a live route is `repointRoute`, on purpose.
    function setRoute(uint32 chainLabel, uint32 eid, bytes32 peer) external onlyAdmin {
        require(eid != 0 && peer != bytes32(0), "LZM: bad route");
        require(!isLocal[chainLabel], "LZM: label is local");
        require(eidOf[chainLabel] == 0, "LZM: label routed");
        require(peers[eid] == bytes32(0), "LZM: eid taken");
        eidOf[chainLabel] = eid;
        labelOf[eid] = chainLabel;
        peers[eid] = peer;
        emit RouteSet(chainLabel, eid, peer);
    }

    /// Changes whose word is believed for a chain. The single most
    /// dangerous call here: the new peer can speak as that chain.
    function repointRoute(uint32 chainLabel, uint32 eid, bytes32 peer) external onlyAdmin {
        require(eid != 0 && peer != bytes32(0), "LZM: bad route");
        uint32 oldEid = eidOf[chainLabel];
        require(oldEid != 0, "LZM: no route");
        bytes32 oldPeer = peers[oldEid];
        if (eid != oldEid) {
            require(peers[eid] == bytes32(0), "LZM: eid taken");
            delete labelOf[oldEid];
            delete peers[oldEid];
        }
        eidOf[chainLabel] = eid;
        labelOf[eid] = chainLabel;
        peers[eid] = peer;
        emit RouteRepointed(chainLabel, oldEid, oldPeer, eid, peer);
    }

    /// Hands endpoint configuration rights (DVN set, executor, libraries)
    /// to `delegate`.
    function setDelegate(address delegate) external onlyAdmin {
        endpoint.setDelegate(delegate);
        emit DelegateSet(delegate);
    }

    /* ------------------------- operator (prices) ------------------------- */

    /// Per-destination executor settings. `gas` is ignored for a local label
    /// (no executor involved); `unit` is charged per reply leg either way.
    function setDestination(uint32 chainLabel, uint128 gas, uint128 unit) external onlyOperator {
        require(unit <= MAX_RETURN_UNIT, "LZM: unit too high");
        gasLimit[chainLabel] = gas;
        returnUnit[chainLabel] = unit;
        emit DestinationSet(chainLabel, gas, unit);
    }

    /* ----------------------- IOmniMessenger ----------------------- */

    function quote(uint32 dstChain, bytes32 dstAddr, bytes calldata payload, uint256 returnLegs)
        external
        view
        returns (uint256)
    {
        if (isLocal[dstChain]) return uint256(returnUnit[dstChain]) * returnLegs;
        (MessagingParams memory p, ) = _packet(dstChain, dstAddr, payload, returnLegs, msg.sender);
        return endpoint.quote(p, address(this)).nativeFee;
    }

    function send(uint32 dstChain, bytes32 dstAddr, bytes calldata payload, uint256 returnLegs)
        external
        payable
    {
        require(senders[msg.sender], "LZM: unknown sender");

        if (isLocal[dstChain]) {
            // No packet: the reply budget is the whole fee, and it stays in
            // this tank — it prepays whatever the receiver fans out remotely.
            uint256 budget = uint256(returnUnit[dstChain]) * returnLegs;
            require(msg.value >= budget || sponsored[msg.sender], "LZM: fee");
            require(uint256(dstAddr) >> 160 == 0, "LZM: bad target");
            address dst = address(uint160(uint256(dstAddr)));
            require(senders[dst] && labelOfSender[dst] == dstChain, "LZM: bad target");
            emit Routed(dstChain, 0, bytes32(0), budget, budget, msg.value, true);
            IOmniReceiver(dst).onOmniMessage(
                labelOfSender[msg.sender],
                bytes32(uint256(uint160(msg.sender))),
                payload
            );
            return;
        }

        (MessagingParams memory p, uint256 value) = _packet(dstChain, dstAddr, payload, returnLegs, msg.sender);
        uint256 fee = endpoint.quote(p, address(this)).nativeFee;
        require(msg.value >= fee || sponsored[msg.sender], "LZM: fee");
        // msg.value already sits in this balance; any surplus stays in the tank
        require(address(this).balance >= fee, "LZM: gas tank empty");
        bytes32 guid = endpoint.send{value: fee}(p, address(this)).guid;
        emit Routed(dstChain, p.dstEid, guid, fee, value, msg.value, false);
    }

    /// The LayerZero packet for one message, and the reply budget it carries.
    function _packet(
        uint32 dstChain,
        bytes32 dstAddr,
        bytes calldata payload,
        uint256 returnLegs,
        address sender
    ) internal view returns (MessagingParams memory p, uint256 value) {
        uint32 eid = eidOf[dstChain];
        require(eid != 0 && peers[eid] != bytes32(0), "LZM: no route");
        uint128 gas = gasLimit[dstChain];
        require(gas != 0, "LZM: no gas limit");
        value = uint256(returnUnit[dstChain]) * returnLegs;
        require(value <= type(uint128).max, "LZM: value overflow");

        // The inter-adapter envelope is bytes32-addressed (v5): a Solana
        // destination or sender does not fit in 20 bytes. Local senders are
        // EVM contracts, so they ride left-padded.
        bytes memory message = abi.encode(bytes32(uint256(uint160(sender))), dstAddr, payload);
        // Type-3 options, one executor lzReceive option: gas only (17 bytes)
        // or gas + native value delivered into the remote lzReceive (33).
        bytes memory options = value == 0
            ? abi.encodePacked(uint16(3), uint8(1), uint16(17), uint8(1), gas)
            : abi.encodePacked(uint16(3), uint8(1), uint16(33), uint8(1), gas, uint128(value));
        p = MessagingParams(eid, peers[eid], message, options, false);
    }

    /* ---------------------- ILayerZeroReceiver ---------------------- */

    /// Payable on purpose: the executor delivers the sender's prepaid reply
    /// budget as msg.value, straight into this adapter's tank.
    function lzReceive(
        Origin calldata origin,
        bytes32,
        bytes calldata message,
        address,
        bytes calldata
    ) external payable {
        require(msg.sender == address(endpoint), "LZM: not endpoint");
        require(peers[origin.srcEid] == origin.sender, "LZM: not a peer");
        (bytes32 srcSender, bytes32 dstAddr, bytes memory payload) = abi.decode(
            message,
            (bytes32, bytes32, bytes)
        );
        // We are an EVM chain, so the local target must downcast; the source
        // sender stays wide — the receiver authenticates it as bytes32.
        require(uint256(dstAddr) >> 160 == 0, "LZM: bad target");
        IOmniReceiver(address(uint160(uint256(dstAddr)))).onOmniMessage(
            labelOf[origin.srcEid],
            srcSender,
            payload
        );
    }

    function allowInitializePath(Origin calldata origin) external view returns (bool) {
        return peers[origin.srcEid] == origin.sender;
    }

    /// 0 = unordered delivery; the protocol is order-independent per design
    /// (every message is self-contained and idempotent at the pad/gateway).
    function nextNonce(uint32, bytes32) external pure returns (uint64) {
        return 0;
    }
}
