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
/// It also models the parts of the real fee that the fee logic depends on:
/// a flat per-message fee (DVNs + executor floor), an optional per-byte fee
/// (message size), an optional per-destination fee (a dear pathway), and
/// the executor's native-value option — the sender pays `value` on top, and delivery hands exactly that
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

    /// Largest message the executor of a destination will carry (0 = no
    /// limit). The real executor config has one per pathway — LayerZero's
    /// default toward some chains is far below a SYNC — and both `quote` and
    /// `send` revert above it.
    mapping(uint32 => uint256) public maxMessageSize;

    function setMaxMessageSize(uint32 dstEid, uint256 max) external {
        maxMessageSize[dstEid] = max;
    }

    /// Extra fee toward ONE destination (0 unless a test sets it). The real
    /// fee is priced per pathway — an Ethereum L1 leg costs many times an
    /// L2 one, and its gas price can jump tenfold in a block.
    mapping(uint32 => uint256) public dstFee;
    /// A destination whose `send` reverts while its `quote` still answers —
    /// a leg that can be priced and still cannot be used.
    mapping(uint32 => bool) public sendBlocked;

    /// Gas a `quote` burns before it answers (0 unless a test sets it). The
    /// real endpoint's quote walks the send library, every DVN and the
    /// executor's price feed — some 100-200k gas, several calls deep — where
    /// this mock's costs almost nothing. A caller that treats a FAILED quote
    /// as "this leg is closed" must tell a quote that was refused from one
    /// that was starved of gas, and that only shows with a quote that costs
    /// something. (Burnt to within ~50k: see `quote`.)
    uint256 public quoteWork;

    function setDstFee(uint32 dstEid, uint256 fee) external {
        dstFee[dstEid] = fee;
    }

    function setQuoteWork(uint256 gas_) external {
        quoteWork = gas_;
    }

    /// Price of one unit of executor gas (0 unless a test sets it). The real
    /// fee grows with the gas the option buys; with this set, so does the
    /// mock's — which is what makes a per-message gas limit visible in a
    /// quote.
    uint256 public gasPrice;

    function setGasPrice(uint256 weiPerGas) external {
        gasPrice = weiPerGas;
    }

    function setSendBlocked(uint32 dstEid, bool on) external {
        sendBlocked[dstEid] = on;
    }

    function _fee(MessagingParams calldata p)
        internal
        view
        returns (uint256 fee, uint128 gas, uint256 value)
    {
        uint256 max = maxMessageSize[p.dstEid];
        require(max == 0 || p.message.length <= max, "ENDPOINT: message too large");
        uint128 v;
        (gas, v) = _lzReceiveOption(p.options);
        value = v;
        fee = mockFee + dstFee[p.dstEid] + byteFee * p.message.length + gasPrice * gas + value;
    }

    function quote(MessagingParams calldata p, address) external view returns (MessagingFee memory) {
        uint256 work = quoteWork;
        if (work != 0) {
            // burnt as memory growth, 32 KB at a time: a dozen steps instead
            // of thousands (the test node traces every step of a revert)
            uint256 start = gasleft();
            while (start - gasleft() < work) {
                assembly {
                    let p_ := add(mload(0x40), 0x8000)
                    mstore(p_, 0)
                    mstore(0x40, p_)
                }
            }
        }
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
        require(!sendBlocked[p.dstEid], "ENDPOINT: send blocked");
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
        deliverAt(0);
    }

    /// Lands the packet at queue position `at`, ahead of older ones — the
    /// real network promises no order between messages (nextNonce = 0).
    function deliverAt(uint256 at) public {
        require(at < queue.length, "ENDPOINT: empty");
        deliverAtWithGas(at, queue[at].gas);
    }

    /// Same, with a gas limit of the caller's choosing: on the real network
    /// ANYONE may execute a verified packet, with whatever gas they like —
    /// the executor's option is what was paid for, not what must be used.
    function deliverAtWithGas(uint256 at, uint256 gasLimit) public {
        require(at < queue.length, "ENDPOINT: empty");
        _deliver(at, gasLimit, queue[at].value);
    }

    /// Same again for the VALUE: the real endpoint's `lzReceive` is payable
    /// and open to all, so a packet can be delivered with any `msg.value` —
    /// none at all, for instance, whatever its sender paid the executor to
    /// bring. `value` comes out of what this endpoint collected in fees, or
    /// out of what the caller attaches.
    function deliverAtWithValue(uint256 at, uint256 value) public payable {
        require(at < queue.length, "ENDPOINT: empty");
        _deliver(at, queue[at].gas, value);
    }

    function _deliver(uint256 at, uint256 gasLimit, uint256 value) internal {
        Packet memory p = queue[at];
        for (uint256 i = at; i + 1 < queue.length; i++) queue[i] = queue[i + 1];
        queue.pop();
        address dst = address(uint160(uint256(p.receiver)));
        uint256 g = gasleft();
        ILayerZeroReceiver(dst).lzReceive{gas: gasLimit, value: value}(
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

    /// Lands a packet NO adapter here ever sent — what the real endpoint
    /// does with a packet its receive library reports as verified, from any
    /// (srcEid, sender) at all: it asks the receiver whether that path may
    /// be opened (`allowInitializePath`), then calls `lzReceive`. This is
    /// the door a receiver's own peer check has to hold (SPEC F-11).
    function inject(uint32 srcEid, bytes32 sender, address receiver, bytes calldata message)
        external
        payable
    {
        Origin memory o = Origin(srcEid, sender, 1);
        require(ILayerZeroReceiver(receiver).allowInitializePath(o), "ENDPOINT: path not initializable");
        ILayerZeroReceiver(receiver).lzReceive{value: msg.value}(
            o,
            keccak256(abi.encode(srcEid, sender, message)),
            message,
            address(0),
            ""
        );
    }
}
