// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title SpawnTimelock — the `admin` of every SPAWN! contract on mainnet.
/// @notice OpenZeppelin's TimelockController, unmodified. Every topology or
/// custody change (a new gateway, a new peer vault, a re-pointed route, a
/// new agent) has to be scheduled here and sit in public for `minDelay`
/// before it can execute — the window in which users can exit.
///
/// Bootstrap: deploy with `minDelay = 0` and the deployer as proposer,
/// executor and bootstrap admin, so the two-step `acceptAdmin` of each
/// contract can be executed at once; then raise the delay (through the
/// timelock itself), hand proposer / executor / canceller to the owner's
/// Safe and renounce every deployer role.
contract SpawnTimelock is TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address bootstrapAdmin
    ) TimelockController(minDelay, proposers, executors, bootstrapAdmin) {}
}
