// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Omnichain messaging abstraction.
/// @notice SPAWN! contracts never talk to a bridge directly — they talk to an
/// IOmniMessenger. In production this is a thin adapter over LayerZero V2 (or
/// CCIP); for local development LocalOmniMessenger hosts all six "logical
/// chains" on one dev node and delivers messages synchronously. Same
/// contracts, same message flow, swappable transport.
interface IOmniMessenger {
    function send(uint32 dstChain, address dstAddr, bytes calldata payload) external;
}

interface IOmniReceiver {
    function onOmniMessage(uint32 srcChain, address srcSender, bytes calldata payload) external;
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

    function send(uint32 dstChain, address dstAddr, bytes calldata payload) external {
        require(registered[msg.sender], "LOM: unknown sender");
        require(registered[dstAddr] && chainOf[dstAddr] == dstChain, "LOM: bad destination");
        emit MessageDelivered(chainOf[msg.sender], msg.sender, dstChain, dstAddr);
        IOmniReceiver(dstAddr).onOmniMessage(chainOf[msg.sender], msg.sender, payload);
    }
}
