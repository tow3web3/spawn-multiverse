// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOmniMessenger, IOmniReceiver} from "./OmniMessenger.sol";
import {OmniUSD} from "./OmniUSD.sol";
import {SpawnToken} from "./SpawnToken.sol";
import {FeeDistributor} from "./FeeDistributor.sol";

/// @title SpawnGateway — one per user-facing chain.
/// @notice The gateway is the local face of the protocol: users spawn, buy and
/// sell here, on their own chain, in their own dollars. Under the hood every
/// action is forwarded to the hub's single global curve, and tokens / payouts
/// come back as omnichain messages.
///
/// Money enters two ways (v7): straight USDC (`buyTokenUsdc`,
/// `spawnTokenUsdc` — one USDC approval to this chain's OmniUSD vault) or
/// oUSD the user already holds (`buyToken`, `spawnToken` — no approval: the
/// gateway is this chain's authorized oUSD agent). Either way the SAME wire
/// message leaves. Money comes back through `OmniUSD.payout`: USDC when the
/// local vault is liquid, an oUSD claim otherwise — never a revert. The
/// gateway only ever moves funds of `msg.sender`.
contract SpawnGateway is IOmniReceiver {
    uint32 public constant HUB_CHAIN = 0;

    uint8 internal constant OP_SPAWN = 1;
    uint8 internal constant OP_BUY = 2;
    uint8 internal constant OP_SELL = 3;
    uint8 internal constant OP_CLAIM = 4;
    uint8 internal constant OP_SYNC_TOKEN = 10;
    uint8 internal constant OP_DELIVER = 11;
    uint8 internal constant OP_PAYOUT = 12;
    uint8 internal constant OP_FEE_DROP = 13;

    IOmniMessenger public immutable messenger;
    OmniUSD public immutable usd; // this chain's instance
    uint32 public immutable chainLabel;
    address public immutable pad;
    address public immutable admin;
    /// This chain's holder-dividend pool; replicas report transfers to it and
    /// the hub drops fee slices into it.
    FeeDistributor public distributor;

    /// hub token address -> native replica on this chain
    mapping(address => SpawnToken) public replicaOf;

    event ReplicaDeployed(address indexed hubToken, address replica, string name, string symbol);

    constructor(IOmniMessenger _messenger, OmniUSD _usd, uint32 _chainLabel, address _pad) {
        // A gateway settles real dollars: wiring it to a ledger-mode oUSD
        // would make every payout revert on the message path.
        require(address(_usd.usdc()) != address(0), "GW: ledger usd");
        messenger = _messenger;
        usd = _usd;
        chainLabel = _chainLabel;
        pad = _pad;
        admin = msg.sender;
    }

    function setDistributor(FeeDistributor d) external {
        require(msg.sender == admin, "GW: not admin");
        require(address(distributor) == address(0), "GW: distributor set");
        distributor = d;
    }

    /* ------------------------- user actions ------------------------- */

    /// WIRE CONVENTION: every account rider in a cross-chain payload is a
    /// `bytes32`, so 32-byte chains (Solana) ride the same messages as EVM
    /// ones. EVM addresses left-pad with zeros on send; a value consumed as
    /// an EVM `address` must have its top 12 bytes zero, checked here.
    function _addr(bytes32 b) internal pure returns (address) {
        require(uint256(b) >> 160 == 0, "GW: bad recipient");
        return address(uint160(uint256(b)));
    }

    function _b32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// Spawn paying the optional dev buy in oUSD already held.
    function spawnToken(
        string calldata name,
        string calldata symbol,
        string calldata metaURI,
        uint256 devBuyUsd,
        uint8 feeMode
    ) external {
        if (devBuyUsd > 0) usd.bridgeBurn(msg.sender, devBuyUsd);
        _sendSpawn(name, symbol, metaURI, devBuyUsd, feeMode);
    }

    /// Spawn paying the optional dev buy in USDC (6 decimals).
    function spawnTokenUsdc(
        string calldata name,
        string calldata symbol,
        string calldata metaURI,
        uint256 devBuyUsdc,
        uint8 feeMode
    ) external {
        uint256 devBuyUsd = devBuyUsdc > 0 ? usd.depositFor(msg.sender, devBuyUsdc) : 0;
        _sendSpawn(name, symbol, metaURI, devBuyUsd, feeMode);
    }

    function _sendSpawn(
        string calldata name,
        string calldata symbol,
        string calldata metaURI,
        uint256 devBuyUsd,
        uint8 feeMode
    ) internal {
        messenger.send(
            HUB_CHAIN,
            _b32(pad),
            // creator rides as bytes32; the hub consumes it as an address
            abi.encode(OP_SPAWN, abi.encode(_b32(msg.sender), name, symbol, metaURI, devBuyUsd, feeMode))
        );
    }

    /// The dev claims their accrued fee share; the pad pays out on THIS chain.
    function claimFees(address hubToken) external {
        // token id + claimer ride as bytes32 (wire convention)
        messenger.send(HUB_CHAIN, _b32(pad), abi.encode(OP_CLAIM, abi.encode(_b32(hubToken), _b32(msg.sender))));
    }

    /// Buy with oUSD already held (18 decimals).
    function buyToken(address hubToken, uint256 usdIn) external {
        require(usdIn > 0, "GW: zero");
        _requireKnown(hubToken);
        usd.bridgeBurn(msg.sender, usdIn);
        _sendBuy(hubToken, usdIn);
    }

    /// Buy with USDC (6 decimals), pulled into this chain's vault.
    function buyTokenUsdc(address hubToken, uint256 usdcIn) external {
        require(usdcIn > 0, "GW: zero");
        _requireKnown(hubToken);
        _sendBuy(hubToken, usd.depositFor(msg.sender, usdcIn));
    }

    /// A BUY for a token id the hub does not know would revert there forever
    /// and strand the buyer's money — refuse it here, where a revert is
    /// atomic. A replica exists on this chain iff the hub spawned the token.
    function _requireKnown(address hubToken) internal view {
        require(address(replicaOf[hubToken]) != address(0), "GW: unknown token");
    }

    function _sendBuy(address hubToken, uint256 usdIn) internal {
        // token id + buyer ride as bytes32 (wire convention)
        messenger.send(HUB_CHAIN, _b32(pad), abi.encode(OP_BUY, abi.encode(_b32(hubToken), _b32(msg.sender), usdIn)));
    }

    function sellToken(address hubToken, uint256 tokens) external {
        require(tokens > 0, "GW: zero");
        SpawnToken rep = replicaOf[hubToken];
        require(address(rep) != address(0), "GW: no replica");
        rep.bridgeBurn(msg.sender, tokens);
        // token id + seller ride as bytes32 (wire convention)
        messenger.send(HUB_CHAIN, _b32(pad), abi.encode(OP_SELL, abi.encode(_b32(hubToken), _b32(msg.sender), tokens)));
    }

    /* -------------------------- messaging -------------------------- */

    function onOmniMessage(uint32 srcChain, bytes32 srcSender, bytes calldata payload) external {
        require(msg.sender == address(messenger), "GW: not messenger");
        require(srcChain == HUB_CHAIN && srcSender == _b32(pad), "GW: not the pad");
        (uint8 op, bytes memory data) = abi.decode(payload, (uint8, bytes));
        if (op == OP_SYNC_TOKEN) {
            (bytes32 hubTokenB, string memory name, string memory symbol) = abi.decode(
                data,
                (bytes32, string, string)
            );
            address hubToken = _addr(hubTokenB);
            SpawnToken rep = new SpawnToken(
                name,
                symbol,
                address(this),
                false,
                0,
                address(0),
                address(distributor)
            );
            replicaOf[hubToken] = rep;
            emit ReplicaDeployed(hubToken, address(rep), name, symbol);
        } else if (op == OP_DELIVER) {
            (bytes32 hubToken, bytes32 to, uint256 tokens, uint256 refund) = abi.decode(
                data,
                (bytes32, bytes32, uint256, uint256)
            );
            replicaOf[_addr(hubToken)].bridgeMint(_addr(to), tokens);
            // refunds settle like every payout: USDC if liquid, else oUSD
            if (refund > 0) usd.payout(_addr(to), refund);
        } else if (op == OP_PAYOUT) {
            (bytes32 to, uint256 usdOut) = abi.decode(data, (bytes32, uint256));
            usd.payout(_addr(to), usdOut);
        } else if (op == OP_FEE_DROP) {
            (bytes32 hubTokenB, uint256 amount) = abi.decode(data, (bytes32, uint256));
            SpawnToken rep = replicaOf[_addr(hubTokenB)];
            require(address(rep) != address(0), "GW: no replica");
            // the hub burned this slice of the holders pot; it re-materializes
            // in the local distributor, keyed by this chain's replica
            usd.bridgeMint(address(distributor), amount);
            distributor.drop(address(rep), amount);
        } else {
            revert("GW: bad op");
        }
    }
}
