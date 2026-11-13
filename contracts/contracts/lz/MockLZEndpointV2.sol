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
/// executor lands the message seconds later.
///
/// It also models the three parts of the real fee that the adapter's fee
/// logic depends on: a flat per-message fee (DVNs + executor floor), an
/// optional per-byte fee (message size), and the executor's native-value
/// option — the sender pays `value` on top, and delivery hands exactly that
/// `value` to the receiver's payable `lzReceive`. A delivery that reverts
/// leaves the packet queued, like LayerZero's retryable failed messages.
contract MockLZEndpointV2 is ILayerZeroEndpointV2 {
    struct Packet {
        uint32 srcEid;
        bytes32 sender;
        uint32 dstEid;
        bytes32 receiver;
        bytes message;
        uint64 nonce;
        bytes options;
        uint128 gas;
        uint256 value;
    }

    uint256 public immutable mockFee;
    /// Extra fee per message byte (0 unless a test turns it on).
    uint256 public byteFee;
    mapping(address => uint32) public eidOfAdapter;
    /// OApp -> the account it delegated endpoint configuration to.
    mapping(address => address) public delegates;
    Packet[] internal queue;
    uint64 internal lastNonce;

    event PacketQueued(uint32 srcEid, uint32 dstEid, uint64 nonce);
    /// `gasUsed` is what the receiver's lzReceive burned — the number the
    /// sender's executor gas option has to cover.
    event PacketDelivered(uint32 srcEid, uint32 dstEid, uint64 nonce, uint256 gasUsed);

    constructor(uint256 _mockFee) {
        mockFee = _mockFee;
    }

    function registerAdapter(address adapter, uint32 eid) external {
        require(eidOfAdapter[adapter] == 0, "ENDPOINT: registered");
        eidOfAdapter[adapter] = eid;
    }

    function setByteFee(uint256 fee) external {
        byteFee = fee;
    }

    function setDelegate(address delegate) external {
        delegates[msg.sender] = delegate;
    }

    /// Strict type-3 parsing of the one option the adapter builds: an
    /// executor lzReceive option, gas only (22 bytes) or gas + value (38).
    function _lzReceiveOption(bytes calldata o) internal pure returns (uint128 gas, uint128 value) {
        require(o.length == 22 || o.length == 38, "ENDPOINT: bad options");
        require(
            uint16(bytes2(o[0:2])) == 3 && // options type 3
                uint8(o[2]) == 1 && // worker: executor
                uint16(bytes2(o[3:5])) == o.length - 5 && // option size
                uint8(o[5]) == 1, // option type: lzReceive
            "ENDPOINT: bad options"
        );
        gas = uint128(bytes16(o[6:22]));
        if (o.length == 38) value = uint128(bytes16(o[22:38]));
    }

    function _fee(MessagingParams calldata p)
        internal
        view
        returns (uint256 fee, uint128 gas, uint256 value)
    {
        uint128 v;
        (gas, v) = _lzReceiveOption(p.options);
        value = v;
        fee = mockFee + byteFee * p.message.length + value;
    }

    function quote(MessagingParams calldata p, address) external view returns (MessagingFee memory) {
        (uint256 fee, , ) = _fee(p);
        return MessagingFee(fee, 0);
    }

    function send(MessagingParams calldata p, address)
        external
        payable
        returns (MessagingReceipt memory r)
    {
        uint32 srcEid = eidOfAdapter[msg.sender];
        require(srcEid != 0, "ENDPOINT: unknown adapter");
        (uint256 fee, uint128 gas, uint256 value) = _fee(p);
        require(msg.value >= fee, "ENDPOINT: fee");
        lastNonce++;
        queue.push(
            Packet(
                srcEid,
                bytes32(uint256(uint160(msg.sender))),
                p.dstEid,
                p.receiver,
                p.message,
                lastNonce,
                p.options,
                gas,
                value
            )
        );
        emit PacketQueued(srcEid, p.dstEid, lastNonce);
        r.nonce = lastNonce;
        r.guid = keccak256(abi.encode(srcEid, p.dstEid, lastNonce));
        r.fee = MessagingFee(msg.value, 0);
    }

    function pending() external view returns (uint256) {
        return queue.length;
    }

    /// Every packet ever queued — a loopback must leave this untouched.
    function packetsSent() external view returns (uint64) {
        return lastNonce;
    }

    /// Test hook: inspect a queued packet without delivering it — the way to
    /// assert what rides the wire toward a chain that cannot receive locally.
    function peek(uint256 i) external view returns (Packet memory) {
        return queue[i];
    }

    /// Lands the oldest packet on its destination adapter — a separate tx,
    /// like the real executor: with exactly the gas the sender paid for and
    /// the prepaid native value. Too little gas reverts the delivery.
    function deliverNext() public {
        require(queue.length > 0, "ENDPOINT: empty");
        Packet memory p = queue[0];
        for (uint256 i = 0; i + 1 < queue.length; i++) queue[i] = queue[i + 1];
        queue.pop();
        address dst = address(uint160(uint256(p.receiver)));
        uint256 g = gasleft();
        ILayerZeroReceiver(dst).lzReceive{gas: p.gas, value: p.value}(
            Origin(p.srcEid, p.sender, p.nonce),
            keccak256(abi.encode(p.srcEid, p.dstEid, p.nonce)),
            p.message,
            address(0),
            ""
        );
        emit PacketDelivered(p.srcEid, p.dstEid, p.nonce, g - gasleft());
    }

    function deliverAll(uint256 max) external {
        while (queue.length > 0 && max > 0) {
            deliverNext();
            max--;
        }
    }
}
