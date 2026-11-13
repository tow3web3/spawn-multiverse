// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Roles — the three keys every SPAWN! contract answers to.
/// @notice Powers are split by what they can do to user funds:
///
///  - ADMIN decides topology and custody (who is a gateway, a peer vault, a
///    route, an agent). Every such power, in hostile hands, can forge value
///    or drain a vault — so the admin is meant to be a TimelockController:
///    slow and public. Two-step transfer: a typo cannot orphan a contract.
///  - OPERATOR tunes prices and limits and can unpause. Nothing it can do
///    moves funds out of the protocol; the admin may always act in its place.
///  - GUARDIAN can only pause — a hot key for a fast stop. The operator and
///    the admin can pause too.
///
/// A fresh contract has the deployer as admin and no operator or guardian.
abstract contract Roles {
    address public admin;
    address public pendingAdmin;
    address public operator;
    address public guardian;

    event AdminTransferStarted(address indexed admin, address indexed nominee);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event OperatorSet(address indexed operator);
    event GuardianSet(address indexed guardian);

    constructor() {
        admin = msg.sender;
        emit AdminTransferred(address(0), msg.sender);
    }

    modifier onlyAdmin() {
        _onlyAdmin();
        _;
    }

    modifier onlyOperator() {
        _onlyOperator();
        _;
    }

    modifier onlyGuardian() {
        _onlyGuardian();
        _;
    }

    function _onlyAdmin() internal view {
        require(msg.sender == admin, "ROLES: not admin");
    }

    function _onlyOperator() internal view {
        require(msg.sender == operator || msg.sender == admin, "ROLES: not operator");
    }

    function _onlyGuardian() internal view {
        require(
            msg.sender == guardian || msg.sender == operator || msg.sender == admin,
            "ROLES: not guardian"
        );
    }

    /// Names the next admin; nothing changes until the nominee accepts.
    /// Naming address(0) cancels a pending transfer.
    function transferAdmin(address nominee) external onlyAdmin {
        pendingAdmin = nominee;
        emit AdminTransferStarted(admin, nominee);
    }

    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "ROLES: not nominee");
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
        _onAdminChanged(msg.sender);
    }

    function setOperator(address operator_) external onlyAdmin {
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setGuardian(address guardian_) external onlyAdmin {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// Hook for contracts that mirror the admin somewhere else (the LayerZero
    /// adapter re-points its endpoint delegate).
    function _onAdminChanged(address newAdmin) internal virtual {}
}
