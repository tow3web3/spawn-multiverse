// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Roles} from "./Roles.sol";

/// @title Omnichain messaging abstraction.
/// @notice SPAWN! contracts never talk to a bridge directly — they talk to an
/// IOmniMessenger. In production this is a thin adapter over LayerZero V2 (or
/// CCIP); for local development LocalOmniMessenger hosts all six "logical
/// chains" on one dev node and delivers messages synchronously. Same
/// contracts, same message flow, swappable transport.
///
/// ADDRESSING IS bytes32 END-TO-END (v5): a destination or sender may live on
/// a 32-byte chain (Solana), so the transport never assumes 20-byte
/// addresses. EVM endpoints ride left-padded; each side downcasts only when
/// it must touch a LOCAL EVM account.
///
/// MESSAGES ARE PAID FOR BY WHOEVER CAUSES THEM (v7). `send` is payable and
/// `returnLegs` says how many reply messages the destination will have to
/// send because of this one: the sender prepays those too, so the reply
/// never rides on charity. `quote` returns exactly what `send` will require
/// for the same arguments.
interface IOmniMessenger {
    function send(uint32 dstChain, bytes32 dstAddr, bytes calldata payload, uint256 returnLegs)
        external
        payable;

    function quote(uint32 dstChain, bytes32 dstAddr, bytes calldata payload, uint256 returnLegs)
        external
        view
        returns (uint256 nativeFee);
}

interface IOmniReceiver {
    function onOmniMessage(uint32 srcChain, bytes32 srcSender, bytes calldata payload) external;
}

/// @notice The simulated transport: every logical chain on one node, messages
/// delivered synchronously. It charges a configurable flat fee per message
/// (0 by default) so the v7 fee rules — user-paid sends, prepaid return legs,
/// sponsored senders — are testable without LayerZero.
contract LocalOmniMessenger is IOmniMessenger, Roles {
    mapping(address => uint32) public chainOf;
    mapping(address => bool) public registered;
    /// Senders whose messages ride free (the pad: its replies were prepaid
    /// by the message that caused them).
    mapping(address => bool) public sponsored;
    /// Flat native fee per message, the outbound one and each prepaid reply.
    uint256 public flatFee;

    event EndpointRegistered(address indexed endpoint, uint32 chain);
    event MessageDelivered(uint32 srcChain, address srcSender, uint32 dstChain, address dstAddr);
    event SponsoredSet(address indexed sender, bool on);
    event FlatFeeSet(uint256 fee);
    event Recovered(address to, uint256 amount);

    // Same split as the production adapter: who may speak is the admin's,
    // what a message costs is the operator's.

    function register(address endpoint, uint32 chain) external onlyAdmin {
        chainOf[endpoint] = chain;
        registered[endpoint] = true;
        emit EndpointRegistered(endpoint, chain);
    }

    function setSponsored(address sender, bool on) external onlyAdmin {
        sponsored[sender] = on;
        emit SponsoredSet(sender, on);
    }

    function setFlatFee(uint256 fee) external onlyOperator {
        flatFee = fee;
        emit FlatFeeSet(fee);
    }

    /// Collected fees have nowhere to go in a simulated network.
    function recover(address payable to) external onlyAdmin {
        uint256 amount = address(this).balance;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "LOM: recover failed");
        emit Recovered(to, amount);
    }

    function quote(uint32, bytes32, bytes calldata, uint256 returnLegs) public view returns (uint256) {
        return flatFee * (1 + returnLegs);
    }

    function send(uint32 dstChain, bytes32 dstAddr, bytes calldata payload, uint256 returnLegs)
        external
        payable
    {
        require(registered[msg.sender], "LOM: unknown sender");
        require(
            msg.value >= quote(dstChain, dstAddr, payload, returnLegs) || sponsored[msg.sender],
            "LOM: fee"
        );
        // The local world is all-EVM, so every destination must downcast.
        require(uint256(dstAddr) >> 160 == 0, "LOM: bad destination");
        address dst = address(uint160(uint256(dstAddr)));
        require(registered[dst] && chainOf[dst] == dstChain, "LOM: bad destination");
        emit MessageDelivered(chainOf[msg.sender], msg.sender, dstChain, dst);
        IOmniReceiver(dst).onOmniMessage(
            chainOf[msg.sender],
            bytes32(uint256(uint160(msg.sender))),
            payload
        );
    }
}
