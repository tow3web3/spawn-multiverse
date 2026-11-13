// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOmniMessenger, IOmniReceiver} from "../OmniMessenger.sol";
import {
    ILayerZeroEndpointV2,
    ILayerZeroReceiver,
    MessagingParams,
    MessagingFee,
    Origin
} from "./ILayerZeroV2.sol";

/// @title LayerZeroOmniMessenger — the production transport adapter.
/// @notice One instance per chain. The protocol contracts (pad, gateway) keep
/// talking to `IOmniMessenger.send` / receiving `onOmniMessage`; this adapter
/// translates to LayerZero V2 packets between peered adapters.
///
/// Trust model: a message is accepted only from the real endpoint AND only if
/// it originates from the peer adapter we configured for that source eid. The
/// embedded `srcSender` is trustworthy because the sending adapter only
/// accepts registered protocol contracts, and the source chain label is
/// derived from the packet's srcEid — never from message content.
///
/// WHO PAYS (v7). LayerZero charges a native fee per message, and a message
/// usually causes replies (a BUY causes a DELIVER). The rule is that whoever
/// causes a message pays for it AND for the replies it triggers:
///  - `send` is payable: the caller must attach at least the quoted fee,
///    unless the admin marked it `sponsored` (the hub pad always is — see
///    below; gateways are only on testnets).
///  - the fee includes `returnUnit[dst] × returnLegs` of DESTINATION-chain
///    native currency, which the executor delivers into the remote adapter
///    together with the message. That is the reply budget.
///  - the remote adapter's balance is its GAS TANK: prepaid reply budgets
///    land in it, replies are paid out of it. A tank is a buffer, not a
///    subsidy — it only drains if `returnUnit` is set below the real reply
///    cost. An empty tank reverts the reply; LayerZero keeps the inbound
///    message retryable until the tank is refilled.
///
/// LOCAL LOOPBACK (v7). Labels marked `isLocal` live on this very chain
/// (the hub's own gateway). A send to one makes NO LayerZero call: it is a
/// direct, same-transaction `onOmniMessage` on a REGISTERED local endpoint of
/// that label, carrying the caller's registered label and address as source
/// — the same two facts a peered adapter would vouch for.
contract LayerZeroOmniMessenger is IOmniMessenger, ILayerZeroReceiver {
    ILayerZeroEndpointV2 public immutable endpoint;
    uint32 public immutable localEid;
    address public immutable admin;

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

    modifier onlyAdmin() {
        require(msg.sender == admin, "LZM: not admin");
        _;
    }

    constructor(ILayerZeroEndpointV2 _endpoint, uint32 _localEid) {
        endpoint = _endpoint;
        localEid = _localEid;
        admin = msg.sender;
        // Without a delegate nobody can call endpoint.setConfig for this
        // OApp, and it would ride LayerZero's default DVN set forever.
        _endpoint.setDelegate(msg.sender);
    }

    /// The gas tank: anyone may top the adapter up with native currency.
    receive() external payable {}

    /// Tank recovery: lets the admin drain the gas tank when this adapter is
    /// retired (an incompatible upgrade must never strand testnet ETH again).
    function recover(address payable to) external onlyAdmin {
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "LZM: recover failed");
    }

    /// Admits a local protocol contract and records the chain label it
    /// speaks for (hub adapter: pad -> 0, the hub chain's gateway -> its
    /// label). The label is what a loopback hands the receiver as source.
    function register(address sender_, uint32 label) external onlyAdmin {
        senders[sender_] = true;
        labelOfSender[sender_] = label;
    }

    function setSponsored(address sender_, bool on) external onlyAdmin {
        sponsored[sender_] = on;
    }

    function setLocal(uint32 chainLabel, bool on) external onlyAdmin {
        isLocal[chainLabel] = on;
    }

    function setRoute(uint32 chainLabel, uint32 eid, bytes32 peer) external onlyAdmin {
        require(eid != 0 && peer != bytes32(0), "LZM: bad route");
        eidOf[chainLabel] = eid;
        labelOf[eid] = chainLabel;
        peers[eid] = peer;
    }

    /// Per-destination executor settings. `gas` is ignored for a local label
    /// (no executor involved); `unit` is charged per reply leg either way.
    function setDestination(uint32 chainLabel, uint128 gas, uint128 unit) external onlyAdmin {
        gasLimit[chainLabel] = gas;
        returnUnit[chainLabel] = unit;
    }

    /// Hands endpoint configuration rights (DVN set, executor, libraries)
    /// to `delegate`.
    function setDelegate(address delegate) external onlyAdmin {
        endpoint.setDelegate(delegate);
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
