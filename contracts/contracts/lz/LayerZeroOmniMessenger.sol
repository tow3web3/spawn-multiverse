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
import {Roles} from "../Roles.sol";

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
/// AN UNSET PEER IS NEVER A MATCH (v7.1, SPEC F-11). `peers[eid]` is
/// bytes32(0) for every chain nobody configured, and `labelOf[eid]` is 0 —
/// the HUB's label. Comparing the packet's sender with the stored peer and
/// nothing else therefore accepts a packet whose sender is bytes32(0) from
/// ANY unconfigured chain, and hands it on as a message from the hub. No
/// user can send one, but LayerZero's DEFAULT receive library and verifiers
/// for that chain could deliver one — and custody would then rest on those
/// defaults instead of the verifier set pinned for our own pathways. So a
/// chain is a peer only if a peer was SET for it (`_isPeer`), exactly like
/// LayerZero's own OApp base (`NoPeer`).
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
/// THE REPLY BUDGET IS ENFORCED ON ARRIVAL (v7.2). LayerZero lets ANYONE
/// execute a verified packet, with whatever `msg.value` they like: the
/// executor's option is what the sender paid for, not what the endpoint
/// insists on. An adapter that took whatever came would let the sender of a
/// message — or anyone else — deliver it with nothing and make this tank pay
/// its replies; a few dollars of that and every reply of every user stalls.
/// So the budget rides INSIDE the message (the envelope's last word, written
/// by the sending adapter from the very number it put in the executor
/// option) and `lzReceive` refuses a delivery that brings less. The packet
/// stays deliverable: the executor, or anyone who attaches the value, lands
/// it. The hub's own replies carry no budget and are unaffected.
///
/// EXECUTOR GAS PER KIND OF MESSAGE (v7.2). `gasLimit[dst]` is one number per
/// destination, so it has to cover the dearest message that chain ever
/// receives — a spawn on the hub, a replica deployment on a spoke — and every
/// buy, sell and payout pays for that much gas. `gasForOp[dst][op]`
/// overrides it for one kind of message (the op is the first word of every
/// protocol payload). What the option buys is what the HONEST executor
/// delivers with and what the user pays for; it is NOT a guarantee to the
/// receiver, since anyone may deliver the packet with any gas at all. The
/// receivers never rely on it: a delivery that runs short reverts as a whole
/// and stays deliverable, and where a failed inner call is tolerated the pad
/// tells starvation from refusal by itself (`SpawnPad._notStarved`).
///
/// LOCAL LOOPBACK (v7). Labels marked `isLocal` live on this very chain
/// (the hub's own gateway). A send to one makes NO LayerZero call: it is a
/// direct, same-transaction `onOmniMessage` on a REGISTERED local endpoint of
/// that label, carrying the caller's registered label and address as source
/// — the same two facts a peered adapter would vouch for.
///
/// WHO CAN DO WHAT (see Roles). Everything that decides WHO may speak and
/// WHOSE word is believed — senders, routes, local labels, sponsorship, the
/// LayerZero delegate, the tank's exit — is the admin's, i.e. a timelock's:
/// a re-pointed route or a fake sender can forge a hub message, and a
/// forged PAYOUT pays real USDC. The operator only tunes what a message
/// costs (`setDestination`, `setGasForOp`), the reply budget within a hard
/// bound.
contract LayerZeroOmniMessenger is IOmniMessenger, ILayerZeroReceiver, Roles {
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
    /// Executor gas for ONE kind of message to a destination: label -> op
    /// (the first word of the payload) -> gas. 0 = `gasLimit[label]`.
    mapping(uint32 => mapping(uint8 => uint128)) public gasForOp;

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
    event GasForOpSet(uint32 indexed chainLabel, uint8 indexed op, uint128 gas);
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
        require(sender_ != address(0), "LZM: zero sender");
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

    /// Executor gas for one kind of message to `chainLabel` (0 = back to
    /// `gasLimit`). A price like the others: it changes what a user pays and
    /// what the honest executor delivers with, nothing else. Set too low,
    /// that kind of message runs out of gas on arrival and waits to be
    /// delivered again with more — by anyone. A destination whose
    /// `gasLimit` is 0 stays closed whatever is set here.
    function setGasForOp(uint32 chainLabel, uint8 op, uint128 gas) external onlyOperator {
        gasForOp[chainLabel][op] = gas;
        emit GasForOpSet(chainLabel, op, gas);
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
        // this KIND of message may have its own executor gas: every protocol
        // payload is `abi.encode(uint8 op, bytes data)`, so the op is the
        // last byte of its first word
        if (payload.length >= 32) {
            uint128 own = gasForOp[dstChain][uint8(payload[31])];
            if (own != 0) gas = own;
        }
        value = uint256(returnUnit[dstChain]) * returnLegs;
        require(value <= type(uint128).max, "LZM: value overflow");

        // The inter-adapter envelope is bytes32-addressed (v5): a Solana
        // destination or sender does not fit in 20 bytes. Local senders are
        // EVM contracts, so they ride left-padded. Its last word (v7.2) is
        // the reply budget this message must ARRIVE with — the same number
        // as in the executor option below.
        bytes memory message = abi.encode(bytes32(uint256(uint160(sender))), dstAddr, payload, value);
        // Type-3 options, one executor lzReceive option: gas only (17 bytes)
        // or gas + native value delivered into the remote lzReceive (33).
        bytes memory options = value == 0
            ? abi.encodePacked(uint16(3), uint8(1), uint16(17), uint8(1), gas)
            : abi.encodePacked(uint16(3), uint8(1), uint16(33), uint8(1), gas, uint128(value));
        p = MessagingParams(eid, peers[eid], message, options, false);
    }

    /* ---------------------- ILayerZeroReceiver ---------------------- */

    /// Payable on purpose: the executor delivers the sender's prepaid reply
    /// budget as msg.value, straight into this adapter's tank — and since
    /// v7.2 the delivery is refused without it (see the contract header).
    function lzReceive(
        Origin calldata origin,
        bytes32,
        bytes calldata message,
        address,
        bytes calldata
    ) external payable {
        require(msg.sender == address(endpoint), "LZM: not endpoint");
        require(_isPeer(origin.srcEid, origin.sender), "LZM: not a peer");
        (bytes32 srcSender, bytes32 dstAddr, bytes memory payload, uint256 value) = abi.decode(
            message,
            (bytes32, bytes32, bytes, uint256)
        );
        // A message always names its source: receivers authenticate it by
        // comparing it with an address they stored, and an address they
        // never stored is bytes32(0) too.
        require(srcSender != bytes32(0), "LZM: no sender");
        // …and arrives with the reply budget its sender paid the executor
        // to bring. Whoever delivers it with less — anyone can try — is
        // turned away, and the packet waits for a delivery that brings it.
        require(msg.value >= value, "LZM: value");
        // We are an EVM chain, so the local target must downcast; the source
        // sender stays wide — the receiver authenticates it as bytes32.
        require(uint256(dstAddr) >> 160 == 0, "LZM: bad target");
        IOmniReceiver(address(uint160(uint256(dstAddr)))).onOmniMessage(
            labelOf[origin.srcEid],
            srcSender,
            payload
        );
    }

    /// The endpoint asks this before it lets a new (srcEid, sender) path
    /// carry its first packet. Same rule as `lzReceive`: only a SET peer.
    function allowInitializePath(Origin calldata origin) external view returns (bool) {
        return _isPeer(origin.srcEid, origin.sender);
    }

    /// `sender` is the adapter this chain was told to believe for `srcEid`.
    /// An eid with no route has peer bytes32(0): it matches NOTHING — not
    /// even a packet whose sender is bytes32(0) (see the contract header).
    function _isPeer(uint32 srcEid, bytes32 sender) internal view returns (bool) {
        bytes32 peer = peers[srcEid];
        return peer != bytes32(0) && peer == sender;
    }

    /// 0 = unordered delivery; the protocol is order-independent per design
    /// (every message is self-contained and idempotent at the pad/gateway).
    function nextNonce(uint32, bytes32) external pure returns (uint64) {
        return 0;
    }
}
