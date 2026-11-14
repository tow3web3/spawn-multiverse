// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Origin} from "../lz/ILayerZeroV2.sol";

/// @title PacketSink — TEST ONLY. The far end of a pathway to a chain these
/// tests have no program on (a non-EVM chain): it takes whatever the mock
/// endpoint delivers and remembers how many packets came and with how much
/// native value — which is the point: a message that makes that chain
/// create an account must ARRIVE with what the account costs. Never deploy
/// outside tests.
contract PacketSink {
    uint256 public packets;
    uint256 public lastValue;

    function lzReceive(Origin calldata, bytes32, bytes calldata, address, bytes calldata) external payable {
        packets++;
        lastValue = msg.value;
    }
}
