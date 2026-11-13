// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ITokenMessengerV2} from "./cctp/ITokenMessengerV2.sol";
import {Roles} from "./Roles.sol";

/// @title OmniUSD — the omnichain settlement dollar, 1:1 backed by USDC.
/// @notice One instance lives on each logical chain. Value moves across chains
/// by burn-on-source / mint-on-destination, driven by the protocol agent of
/// each chain (the SpawnPad on the hub, the SpawnGateway on a spoke).
///
/// Two modes, fixed at construction:
///  - BACKED (`usdc != 0`, every user-facing chain): this contract is also the
///    chain's USDC vault. oUSD only comes into existence against USDC paid in
///    here, or against value that arrived by protocol message.
///  - LEDGER (`usdc == 0`, the hub): a pure accounting unit. The hub holds no
///    dollars — it holds the books (curve reserves, fee pots) for dollars
///    that sit in the spokes' vaults.
///
/// GLOBAL BACKING INVARIANT (modulo value in flight between chains):
///   Σ over backed instances of USDC held × SCALE
///     == Σ over ALL instances (hub ledger included) of oUSD totalSupply.
/// Every function below preserves it: USDC in ⇄ oUSD minted (or carried by
/// message), USDC out ⇄ oUSD burned (or consumed from a message).
///
/// A vault can be locally short (dollars entered on chain A, a seller cashes
/// out on chain B). A payout then mints oUSD instead — a claim redeemable as
/// soon as liquidity returns — and the operator rebalances vault-to-vault
/// with Circle CCTP. There is NO function that sends USDC anywhere but to a
/// user redeeming their own oUSD, a protocol payout, or a configured peer
/// vault.
///
/// WHO CAN DO WHAT (see Roles):
///  - ADMIN names the agent (once) and the peer vaults (once per label). A
///    peer can never be re-aimed, but a NEW label can always be named — and
///    a label whose "peer vault" is an attacker's address is a way out of
///    the vault. That is why the admin must be a timelock: naming a peer is
///    then public for days before `rebalance` can use it.
///  - OPERATOR sets the deposit cap, reopens deposits and rebalances — to
///    existing peers only. It can move liquidity between protocol vaults
///    (a liveness power), never out of them.
///  - GUARDIAN can close deposits. Nobody can close exits: `unwrap` and
///    `payout` have no switch.
///
/// Every function that moves USDC is `nonReentrant`. USDC has no transfer
/// hooks today; the guard is there so an upgrade of the token could never
/// turn the vault's balance-delta accounting against it.
contract OmniUSD is ERC20, ReentrancyGuard, Roles {
    using SafeERC20 for IERC20;

    /// USDC has 6 decimals, oUSD 18.
    uint256 public constant SCALE = 1e12;
    /// CCTP V2 Standard Transfer: attested at source-chain finality.
    uint32 public constant CCTP_FINALITY_STANDARD = 2000;

    uint32 public immutable chainLabel;
    /// The backing asset; address(0) puts this instance in ledger mode.
    IERC20 public immutable usdc;
    /// Circle's TokenMessengerV2 on this chain; address(0) = no rebalancing.
    ITokenMessengerV2 public immutable tokenMessenger;

    address public agent;
    /// Ceiling on the vault's USDC balance, enforced on every deposit. Starts
    /// at 0: deposits are closed until the operator opens them (guarded launch).
    uint256 public depositCap;
    /// The guardian's stop for NEW money (`wrap`, `depositFor`). Exits
    /// (`unwrap`, `payout`) ignore it.
    bool public depositsPaused;

    struct Peer {
        uint32 domain; // CCTP domain of the peer's chain
        bytes32 vault; // the peer OmniUSD instance over there
    }
    /// chain label -> the only place `rebalance` can send USDC for that chain.
    mapping(uint32 => Peer) public peers;

    event Wrapped(address indexed account, uint256 usdcIn, uint256 minted);
    event Unwrapped(address indexed account, uint256 usdcOut);
    event Deposited(address indexed from, uint256 usdcIn, uint256 amount);
    /// `minted` is the part of a payout that could not leave as USDC: the
    /// sub-SCALE dust when paid, or the whole amount when the vault was short
    /// or the transfer was refused.
    event PaidOut(address indexed to, uint256 usdcOut, uint256 minted);
    event DepositCapSet(uint256 cap);
    event AgentSet(address agent);
    event DepositsPaused(address by);
    event DepositsUnpaused(address by);
    event PeerSet(uint32 indexed label, uint32 domain, bytes32 vault);
    event Rebalanced(uint32 indexed label, uint32 domain, bytes32 vault, uint256 usdcOut);

    modifier onlyAgent() {
        require(msg.sender == agent, "oUSD: not agent");
        _;
    }

    modifier backed() {
        require(address(usdc) != address(0), "oUSD: ledger only");
        _;
    }

    constructor(uint32 _chainLabel, address _usdc, address _tokenMessenger) ERC20("OmniUSD", "oUSD") {
        if (_usdc == address(0)) {
            require(_tokenMessenger == address(0), "oUSD: ledger has no CCTP");
        } else {
            require(IERC20Metadata(_usdc).decimals() == 6, "oUSD: usdc decimals");
        }
        chainLabel = _chainLabel;
        usdc = IERC20(_usdc);
        tokenMessenger = ITokenMessengerV2(_tokenMessenger);
    }

    /* ------------------------ admin & operator ------------------------ */

    function setAgent(address a) external onlyAdmin {
        require(agent == address(0), "oUSD: agent set");
        agent = a;
        emit AgentSet(a);
    }

    function setDepositCap(uint256 cap) external onlyOperator backed {
        depositCap = cap;
        emit DepositCapSet(cap);
    }

    function pauseDeposits() external onlyGuardian backed {
        depositsPaused = true;
        emit DepositsPaused(msg.sender);
    }

    function unpauseDeposits() external onlyOperator backed {
        depositsPaused = false;
        emit DepositsUnpaused(msg.sender);
    }

    /// Names the peer vault for a chain — once. A peer can never be changed,
    /// so a rebalance route, once published, is fixed for good. (New labels
    /// can still be added — by the admin only; see the contract header.)
    function setPeer(uint32 label, uint32 cctpDomain, bytes32 peerVault) external onlyAdmin backed {
        require(label != chainLabel && peerVault != bytes32(0), "oUSD: bad peer");
        require(peers[label].vault == bytes32(0), "oUSD: peer set");
        peers[label] = Peer(cctpDomain, peerVault);
        emit PeerSet(label, cctpDomain, peerVault);
    }

    /// Moves vault liquidity to the peer vault of `dstLabel` with CCTP V2
    /// (Standard Transfer, zero fee, anyone may relay the attestation). The
    /// USDC is in flight until minted to the peer; it can land nowhere else.
    function rebalance(uint32 dstLabel, uint256 usdc6) external onlyOperator backed nonReentrant {
        require(address(tokenMessenger) != address(0), "oUSD: no CCTP");
        Peer memory p = peers[dstLabel];
        require(p.vault != bytes32(0), "oUSD: no peer");
        usdc.forceApprove(address(tokenMessenger), usdc6);
        tokenMessenger.depositForBurn(
            usdc6,
            p.domain,
            p.vault,
            address(usdc),
            bytes32(0),
            0,
            CCTP_FINALITY_STANDARD
        );
        emit Rebalanced(dstLabel, p.domain, p.vault, usdc6);
    }

    /* ------------------------------ users ------------------------------ */

    /// USDC in, oUSD out, 1:1.
    function wrap(uint256 usdc6) external backed nonReentrant returns (uint256 amount18) {
        amount18 = _pull(msg.sender, usdc6);
        _mint(msg.sender, amount18);
        emit Wrapped(msg.sender, amount18 / SCALE, amount18);
    }

    /// oUSD in, USDC out, 1:1. Only whole USDC units burn — sub-SCALE dust
    /// stays with the caller. Reverts when this chain's vault is short; the
    /// oUSD stays a valid claim until liquidity is rebalanced in.
    function unwrap(uint256 amount18) external backed nonReentrant returns (uint256 usdc6) {
        usdc6 = amount18 / SCALE;
        require(usdc6 > 0, "oUSD: dust");
        require(usdc.balanceOf(address(this)) >= usdc6, "oUSD: vault short");
        _burn(msg.sender, usdc6 * SCALE);
        usdc.safeTransfer(msg.sender, usdc6);
        emit Unwrapped(msg.sender, usdc6);
    }

    /// USDC this vault can pay out right now.
    function liquidity() external view returns (uint256) {
        return address(usdc) == address(0) ? 0 : usdc.balanceOf(address(this));
    }

    /* ------------------------------ agent ------------------------------ */

    /// Takes `usdc6` from `from` WITHOUT minting oUSD: the value is about to
    /// ride a protocol message (≡ wrap + bridgeBurn in one step). Returns the
    /// 18-decimal amount the message must carry.
    function depositFor(address from, uint256 usdc6)
        external
        onlyAgent
        backed
        nonReentrant
        returns (uint256 amount18)
    {
        amount18 = _pull(from, usdc6);
        emit Deposited(from, amount18 / SCALE, amount18);
    }

    /// Settles value that arrived by protocol message. NEVER reverts for a
    /// real recipient: it runs on the message path, where a revert would
    /// strand the payout. Pays USDC when the vault has it and USDC accepts the
    /// transfer (Circle can blacklist a recipient); otherwise mints the whole
    /// amount as oUSD, redeemable later. Sub-SCALE dust is always minted so
    /// conservation is exact to the wei.
    function payout(address to, uint256 amount18) external onlyAgent backed nonReentrant {
        uint256 usdc6 = amount18 / SCALE;
        uint256 minted = amount18;
        if (usdc6 > 0 && _trySendUsdc(to, usdc6)) {
            minted = amount18 - usdc6 * SCALE;
        } else {
            usdc6 = 0;
        }
        if (minted > 0) _mint(to, minted);
        emit PaidOut(to, usdc6, minted);
    }

    function bridgeMint(address to, uint256 amount) external onlyAgent {
        _mint(to, amount);
    }

    function bridgeBurn(address from, uint256 amount) external onlyAgent {
        _burn(from, amount);
    }

    /* ---------------------------- internals ---------------------------- */

    /// Pulls USDC into the vault under the deposit cap and returns the oUSD
    /// value of what ACTUALLY arrived (balance delta, not the request).
    function _pull(address from, uint256 usdc6) private returns (uint256 amount18) {
        require(usdc6 > 0, "oUSD: zero");
        require(!depositsPaused, "oUSD: deposits paused");
        uint256 before = usdc.balanceOf(address(this));
        require(before + usdc6 <= depositCap, "oUSD: deposit cap");
        usdc.safeTransferFrom(from, address(this), usdc6);
        amount18 = (usdc.balanceOf(address(this)) - before) * SCALE;
    }

    /// A USDC transfer that reports failure instead of reverting.
    function _trySendUsdc(address to, uint256 usdc6) private returns (bool) {
        if (usdc.balanceOf(address(this)) < usdc6) return false;
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20.transfer, (to, usdc6)));
        if (!ok) return false;
        return ret.length == 0 || (ret.length == 32 && uint256(bytes32(ret)) == 1);
    }
}
