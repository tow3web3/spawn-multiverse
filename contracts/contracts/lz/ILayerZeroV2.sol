// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal vendored slice of the LayerZero V2 protocol interfaces — exactly
/// the real EndpointV2 signatures, so `LayerZeroOmniMessenger` compiles
/// unchanged against the production endpoint on mainnet/testnet. Locally the
/// endpoint is `MockLZEndpointV2`, which queues packets and delivers them in
/// separate transactions (async, like the real network).

struct MessagingParams {
    uint32 dstEid;
    bytes32 receiver;
    bytes message;
    bytes options;
    bool payInLzToken;
}

struct MessagingFee {
    uint256 nativeFee;
    uint256 lzTokenFee;
}

struct MessagingReceipt {
    bytes32 guid;
    uint64 nonce;
    MessagingFee fee;
}

struct Origin {
    uint32 srcEid;
    bytes32 sender;
    uint64 nonce;
}

interface ILayerZeroEndpointV2 {
    function quote(MessagingParams calldata params, address sender)
        external
        view
        returns (MessagingFee memory);

    function send(MessagingParams calldata params, address refundAddress)
        external
        payable
        returns (MessagingReceipt memory);

    /// Called BY an OApp: names the account allowed to configure it on the
    /// endpoint (`setConfig` — DVN set, executor, libraries) on its behalf.
    function setDelegate(address delegate) external;
}

interface ILayerZeroReceiver {
    function lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) external payable;

    function allowInitializePath(Origin calldata origin) external view returns (bool);

    function nextNonce(uint32 eid, bytes32 sender) external view returns (uint64);
}
