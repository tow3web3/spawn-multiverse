// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOmniMessenger, IOmniReceiver} from "./OmniMessenger.sol";
import {OmniUSD} from "./OmniUSD.sol";
import {SpawnToken} from "./SpawnToken.sol";

/// @title SpawnGateway — one per user-facing chain.
/// @notice The gateway is the local face of the protocol: users spawn, buy and
/// sell here, on their own chain, in their own OmniUSD. Under the hood every
/// action is forwarded to the hub's single global curve, and tokens / payouts
/// come back as omnichain messages. Users never need approvals: the gateway is
/// this chain's authorized agent for OmniUSD and the controller of each token
/// replica, and it only ever moves funds of `msg.sender`.
contract SpawnGateway is IOmniReceiver {
    uint32 public constant HUB_CHAIN = 0;

    uint8 internal constant OP_SPAWN = 1;
    uint8 internal constant OP_BUY = 2;
    uint8 internal constant OP_SELL = 3;
    uint8 internal constant OP_CLAIM = 4;
    uint8 internal constant OP_SYNC_TOKEN = 10;
    uint8 internal constant OP_DELIVER = 11;
    uint8 internal constant OP_PAYOUT = 12;

    IOmniMessenger public immutable messenger;
    OmniUSD public immutable usd; // this chain's instance
    uint32 public immutable chainLabel;
    address public immutable pad;

    /// hub token address -> native replica on this chain
    mapping(address => SpawnToken) public replicaOf;

    event ReplicaDeployed(address indexed hubToken, address replica, string name, string symbol);

    constructor(IOmniMessenger _messenger, OmniUSD _usd, uint32 _chainLabel, address _pad) {
        messenger = _messenger;
        usd = _usd;
        chainLabel = _chainLabel;
        pad = _pad;
    }

    /* ------------------------- user actions ------------------------- */

    function spawnToken(
        string calldata name,
        string calldata symbol,
        string calldata metaURI,
        uint256 devBuyUsd,
        uint8 feeMode
    ) external {
        if (devBuyUsd > 0) usd.bridgeBurn(msg.sender, devBuyUsd);
        messenger.send(
            HUB_CHAIN,
            pad,
            abi.encode(OP_SPAWN, abi.encode(msg.sender, name, symbol, metaURI, devBuyUsd, feeMode))
        );
    }

    /// The dev claims their accrued fee share; the pad pays out on THIS chain.
    function claimFees(address hubToken) external {
        messenger.send(HUB_CHAIN, pad, abi.encode(OP_CLAIM, abi.encode(hubToken, msg.sender)));
    }

    function buyToken(address hubToken, uint256 usdIn) external {
        require(usdIn > 0, "GW: zero");
        usd.bridgeBurn(msg.sender, usdIn);
        messenger.send(HUB_CHAIN, pad, abi.encode(OP_BUY, abi.encode(hubToken, msg.sender, usdIn)));
    }

    function sellToken(address hubToken, uint256 tokens) external {
        require(tokens > 0, "GW: zero");
        SpawnToken rep = replicaOf[hubToken];
        require(address(rep) != address(0), "GW: no replica");
        rep.bridgeBurn(msg.sender, tokens);
        messenger.send(HUB_CHAIN, pad, abi.encode(OP_SELL, abi.encode(hubToken, msg.sender, tokens)));
    }

    /* -------------------------- messaging -------------------------- */

    function onOmniMessage(uint32 srcChain, address srcSender, bytes calldata payload) external {
        require(msg.sender == address(messenger), "GW: not messenger");
        require(srcChain == HUB_CHAIN && srcSender == pad, "GW: not the pad");
        (uint8 op, bytes memory data) = abi.decode(payload, (uint8, bytes));
        if (op == OP_SYNC_TOKEN) {
            (address hubToken, string memory name, string memory symbol) = abi.decode(
                data,
                (address, string, string)
            );
            SpawnToken rep = new SpawnToken(name, symbol, address(this), false, 0, address(0));
            replicaOf[hubToken] = rep;
            emit ReplicaDeployed(hubToken, address(rep), name, symbol);
        } else if (op == OP_DELIVER) {
            (address hubToken, address to, uint256 tokens, uint256 refund) = abi.decode(
                data,
                (address, address, uint256, uint256)
            );
            replicaOf[hubToken].bridgeMint(to, tokens);
            if (refund > 0) usd.bridgeMint(to, refund);
        } else if (op == OP_PAYOUT) {
            (address to, uint256 usdOut) = abi.decode(data, (address, uint256));
            usd.bridgeMint(to, usdOut);
        } else {
            revert("GW: bad op");
        }
    }
}
