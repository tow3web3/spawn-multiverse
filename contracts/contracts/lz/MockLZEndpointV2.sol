// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    ILayerZeroEndpointV2,
    ILayerZeroReceiver,
    MessagingParams,
    MessagingFee,
    MessagingReceipt,
    Origin
} from "./ILayerZeroV2.sol";

/// @title MockLZEndpointV2 — an async LayerZero endpoint for local tests.
/// @notice The point of this mock is the thing LocalOmniMessenger can't do:
/// ASYNCHRONY. `send` only queues a packet; nothing happens on the
/// destination until someone calls `deliverNext` / `deliverAll` in a later
/// transaction — exactly like the real network, where DVNs verify and an
/// executor lands the message seconds later. It also charges a nonzero
/// native fee so the adapter's quote-and-pay gas tank is actually exercised.
contract MockLZEndpointV2 is ILayerZeroEndpointV2 {
    struct Packet {
        uint32 srcEid;
        bytes32 sender;
        uint32 dstEid;
        bytes32 receiver;
        bytes message;
        uint64 nonce;
    }

    uint256 public immutable mockFee;
    mapping(address => uint32) public eidOfAdapter;
    Packet[] internal queue;
    uint64 internal lastNonce;

    event PacketQueued(uint32 srcEid, uint32 dstEid, uint64 nonce);
    event PacketDelivered(uint32 srcEid, uint32 dstEid, uint64 nonce);

    constructor(uint256 _mockFee) {
        mockFee = _mockFee;
    }

    function registerAdapter(address adapter, uint32 eid) external {
        require(eidOfAdapter[adapter] == 0, "ENDPOINT: registered");
        eidOfAdapter[adapter] = eid;
    }

    function quote(MessagingParams calldata, address) external view returns (MessagingFee memory) {
        return MessagingFee(mockFee, 0);
    }

    function send(MessagingParams calldata p, address)
        external
        payable
        returns (MessagingReceipt memory r)
    {
        uint32 srcEid = eidOfAdapter[msg.sender];
        require(srcEid != 0, "ENDPOINT: unknown adapter");
        require(msg.value >= mockFee, "ENDPOINT: fee");
        lastNonce++;
        queue.push(
            Packet(srcEid, bytes32(uint256(uint160(msg.sender))), p.dstEid, p.receiver, p.message, lastNonce)
        );
        emit PacketQueued(srcEid, p.dstEid, lastNonce);
        r.nonce = lastNonce;
        r.guid = keccak256(abi.encode(srcEid, p.dstEid, lastNonce));
        r.fee = MessagingFee(msg.value, 0);
    }

    function pending() external view returns (uint256) {
        return queue.length;
    }

    /// Test hook: inspect a queued packet without delivering it — the way to
    /// assert what rides the wire toward a chain that cannot receive locally.
    function peek(uint256 i) external view returns (Packet memory) {
        return queue[i];
    }

    /// Lands the oldest packet on its destination adapter — a separate tx,
    /// like the real executor.
    function deliverNext() public {
        require(queue.length > 0, "ENDPOINT: empty");
        Packet memory p = queue[0];
        for (uint256 i = 0; i + 1 < queue.length; i++) queue[i] = queue[i + 1];
        queue.pop();
        address dst = address(uint160(uint256(p.receiver)));
        ILayerZeroReceiver(dst).lzReceive(
            Origin(p.srcEid, p.sender, p.nonce),
            keccak256(abi.encode(p.srcEid, p.dstEid, p.nonce)),
            p.message,
            address(0),
            ""
        );
        emit PacketDelivered(p.srcEid, p.dstEid, p.nonce);
    }

    function deliverAll(uint256 max) external {
        while (queue.length > 0 && max > 0) {
            deliverNext();
            max--;
        }
    }
}
