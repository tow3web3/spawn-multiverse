// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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
interface IOmniMessenger {
    function send(uint32 dstChain, bytes32 dstAddr, bytes calldata payload) external;
}

interface IOmniReceiver {
    function onOmniMessage(uint32 srcChain, bytes32 srcSender, bytes calldata payload) external;
}

contract LocalOmniMessenger is IOmniMessenger {
    address public immutable admin;
    mapping(address => uint32) public chainOf;
    mapping(address => bool) public registered;

    event EndpointRegistered(address indexed endpoint, uint32 chain);
    event MessageDelivered(uint32 srcChain, address srcSender, uint32 dstChain, address dstAddr);

    constructor() {
        admin = msg.sender;
    }

    function register(address endpoint, uint32 chain) external {
        require(msg.sender == admin, "LOM: not admin");
        chainOf[endpoint] = chain;
        registered[endpoint] = true;
        emit EndpointRegistered(endpoint, chain);
    }

    function send(uint32 dstChain, bytes32 dstAddr, bytes calldata payload) external {
        require(registered[msg.sender], "LOM: unknown sender");
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
