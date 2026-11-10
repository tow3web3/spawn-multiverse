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
/// Fees: LayerZero charges a native fee per message. The adapter is a gas
/// tank — fund it with native currency (ops task) and it quotes + pays per
/// send, so users and protocol contracts never need to attach value.
contract LayerZeroOmniMessenger is IOmniMessenger, ILayerZeroReceiver {
    ILayerZeroEndpointV2 public immutable endpoint;
    uint32 public immutable localEid;
    address public immutable admin;

    /// Local protocol contracts allowed to send through this adapter.
    mapping(address => bool) public senders;
    /// SPAWN! chain label -> remote LayerZero eid (and back).
    mapping(uint32 => uint32) public eidOf;
    mapping(uint32 => uint32) public labelOf;
    /// Remote eid -> the peer adapter over there.
    mapping(uint32 => bytes32) public peers;
    /// Executor options attached to every send (gas limit on the remote side).
    bytes public defaultOptions;

    event Routed(uint32 indexed dstChain, uint32 indexed dstEid, bytes32 guid, uint256 nativeFee);

    modifier onlyAdmin() {
        require(msg.sender == admin, "LZM: not admin");
        _;
    }

    constructor(ILayerZeroEndpointV2 _endpoint, uint32 _localEid) {
        endpoint = _endpoint;
        localEid = _localEid;
        admin = msg.sender;
    }

    /// The gas tank: anyone may top the adapter up with native currency.
    receive() external payable {}

    /// Tank recovery: lets the admin drain the gas tank when this adapter is
    /// retired (an incompatible upgrade must never strand testnet ETH again).
    function recover(address payable to) external onlyAdmin {
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "LZM: recover failed");
    }

    function register(address sender_) external onlyAdmin {
        senders[sender_] = true;
    }

    function setRoute(uint32 chainLabel, uint32 eid, bytes32 peer) external onlyAdmin {
        require(eid != 0 && peer != bytes32(0), "LZM: bad route");
        eidOf[chainLabel] = eid;
        labelOf[eid] = chainLabel;
        peers[eid] = peer;
    }

    function setOptions(bytes calldata options) external onlyAdmin {
        defaultOptions = options;
    }

    /* ----------------------- IOmniMessenger ----------------------- */

    function send(uint32 dstChain, bytes32 dstAddr, bytes calldata payload) external {
        require(senders[msg.sender], "LZM: unknown sender");
        uint32 eid = eidOf[dstChain];
        require(eid != 0 && peers[eid] != bytes32(0), "LZM: no route");

        // The inter-adapter envelope is bytes32-addressed (v5): a Solana
        // destination or sender does not fit in 20 bytes. Local senders are
        // EVM contracts, so they ride left-padded.
        bytes memory message = abi.encode(
            bytes32(uint256(uint160(msg.sender))),
            dstAddr,
            payload
        );
        MessagingParams memory p = MessagingParams(eid, peers[eid], message, defaultOptions, false);
        uint256 fee = endpoint.quote(p, address(this)).nativeFee;
        require(address(this).balance >= fee, "LZM: gas tank empty");
        bytes32 guid = endpoint.send{value: fee}(p, address(this)).guid;
        emit Routed(dstChain, eid, guid, fee);
    }

    /* ---------------------- ILayerZeroReceiver ---------------------- */

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
