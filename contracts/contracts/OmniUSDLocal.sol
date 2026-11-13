// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Roles} from "./Roles.sol";

/// @title OmniUSDLocal — the settlement dollar of a SINGLE-CHAIN universe,
/// 1:1 backed by one local dollar token of any decimals from 6 to 18.
/// @notice This is `OmniUSD` for a universe that lives on one chain and
/// settles in a dollar Circle does not issue there (BNB Chain: BSC-USD /
/// USDT, 18 decimals). It is the vault of that chain's gateway and nothing
/// else: the hub's books stay in a ledger-mode `OmniUSD`, exactly as on the
/// USDC universe, and every other contract is reused unchanged.
///
/// It keeps `OmniUSD`'s external surface wherever the gateway, the fee
/// distributor, the scripts and the frontend touch it — same selectors, same
/// events, same revert strings — so a `SpawnGateway` compiled against the
/// `OmniUSD` type runs against this contract as is. Three things differ:
///
///  1. SCALE is derived from the token's decimals (`10 ** (18 - decimals)`:
///     1e12 for a 6-decimal dollar, 1 for an 18-decimal one) instead of being
///     the constant 1e12. With SCALE == 1 there is no sub-unit dust at all.
///  2. There is NO CCTP, no peer and no `rebalance`: a single-chain universe
///     has nowhere to move liquidity to. The surface is absent, not disabled —
///     this contract has NO function that sends the dollar token anywhere but
///     to a user redeeming their own oUSD or to a protocol payout.
///  3. There is no ledger mode: this contract is always a vault.
///
/// The getter is still called `usdc()` — read it as "the dollar token". It
/// is the name the immutable gateway calls.
///
/// BACKING INVARIANT (single chain — nothing is ever in flight):
///   dollar tokens held here × SCALE
///     == oUSD totalSupply here + oUSD totalSupply of the hub ledger.
/// Every function below preserves it: tokens in ⇄ oUSD minted (or carried by
/// message), tokens out ⇄ oUSD burned (or consumed from a message).
///
/// WHO CAN DO WHAT (see Roles):
///  - ADMIN names the agent, once. That is its only power here.
///  - OPERATOR sets the deposit cap and reopens deposits.
///  - GUARDIAN can close deposits. Nobody can close exits: `unwrap` and
///    `payout` have no switch.
///
/// The backing token must be a plain ERC-20 whose balances only move by
/// transfer (no rebasing). A fee-on-transfer token is tolerated — deposits
/// credit what actually arrived — but the vault assumes nothing beyond the
/// ERC-20 minimum: return values are optional, a refused transfer is a
/// claim, never a stuck payout. Every function that moves the token is
/// `nonReentrant`.
contract OmniUSDLocal is ERC20, ReentrancyGuard, Roles {
    using SafeERC20 for IERC20;

    /// oUSD has 18 decimals; one unit of the dollar token is SCALE oUSD wei.
    uint256 public immutable SCALE;
    /// The smallest deposit that may ride a protocol message, in oUSD wei.
    /// On the USDC universe every such amount is at least 1e12 — one USDC
    /// unit — and the gateway imposes the same floor on its oUSD-denominated
    /// paths (`MIN_AMOUNT`). An 18-decimal dollar could go below it; the
    /// immutable gateway cannot be taught the floor, so the vault holds it.
    uint256 public constant MIN_DEPOSIT = 1e12;

    uint32 public immutable chainLabel;
    /// The backing asset — "the dollar token" (BSC-USD on BNB Chain).
    IERC20 public immutable usdc;

    address public agent;
    /// Ceiling on the vault's token balance, in TOKEN units, enforced on every
    /// deposit. Starts at 0: deposits are closed until the operator opens
    /// them (guarded launch).
    uint256 public depositCap;
    /// The guardian's stop for NEW money (`wrap`, `depositFor`). Exits
    /// (`unwrap`, `payout`) ignore it.
    bool public depositsPaused;

    event Wrapped(address indexed account, uint256 usdcIn, uint256 minted);
    event Unwrapped(address indexed account, uint256 usdcOut);
    event Deposited(address indexed from, uint256 usdcIn, uint256 amount);
    /// `minted` is the part of a payout that could not leave as tokens: the
    /// sub-SCALE dust when paid (always 0 when SCALE == 1), or the whole
    /// amount when the vault was short or the transfer was refused.
    event PaidOut(address indexed to, uint256 usdcOut, uint256 minted);
    event DepositCapSet(uint256 cap);
    event AgentSet(address agent);
    event DepositsPaused(address by);
    event DepositsUnpaused(address by);

    modifier onlyAgent() {
        require(msg.sender == agent, "oUSD: not agent");
        _;
    }

    constructor(uint32 _chainLabel, address _token) ERC20("OmniUSD", "oUSD") {
        require(_token != address(0), "oUSD: no token");
        uint8 d = IERC20Metadata(_token).decimals();
        require(d >= 6 && d <= 18, "oUSD: token decimals");
        SCALE = 10 ** (18 - d);
        chainLabel = _chainLabel;
        usdc = IERC20(_token);
    }

    /* ------------------------ admin & operator ------------------------ */

    function setAgent(address a) external onlyAdmin {
        require(agent == address(0), "oUSD: agent set");
        agent = a;
        emit AgentSet(a);
    }

    function setDepositCap(uint256 cap) external onlyOperator {
        depositCap = cap;
        emit DepositCapSet(cap);
    }

    function pauseDeposits() external onlyGuardian {
        depositsPaused = true;
        emit DepositsPaused(msg.sender);
    }

    function unpauseDeposits() external onlyOperator {
        depositsPaused = false;
        emit DepositsUnpaused(msg.sender);
    }

    /* ------------------------------ users ------------------------------ */

    /// Dollar tokens in, oUSD out, 1:1.
    function wrap(uint256 units) external nonReentrant returns (uint256 amount18) {
        amount18 = _pull(msg.sender, units);
        _mint(msg.sender, amount18);
        emit Wrapped(msg.sender, amount18 / SCALE, amount18);
    }

    /// oUSD in, dollar tokens out, 1:1. Only whole token units burn —
    /// sub-SCALE dust stays with the caller (there is none when SCALE == 1).
    /// Reverts when the vault is short; the oUSD stays a valid claim.
    function unwrap(uint256 amount18) external nonReentrant returns (uint256 units) {
        units = amount18 / SCALE;
        require(units > 0, "oUSD: dust");
        require(usdc.balanceOf(address(this)) >= units, "oUSD: vault short");
        _burn(msg.sender, units * SCALE);
        usdc.safeTransfer(msg.sender, units);
        emit Unwrapped(msg.sender, units);
    }

    /// Dollar tokens this vault can pay out right now.
    function liquidity() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /* ------------------------------ agent ------------------------------ */

    /// Takes `units` from `from` WITHOUT minting oUSD: the value is about to
    /// ride a protocol message (≡ wrap + bridgeBurn in one step). Returns the
    /// 18-decimal amount the message must carry.
    function depositFor(address from, uint256 units)
        external
        onlyAgent
        nonReentrant
        returns (uint256 amount18)
    {
        amount18 = _pull(from, units);
        require(amount18 >= MIN_DEPOSIT, "oUSD: dust");
        emit Deposited(from, amount18 / SCALE, amount18);
    }

    /// Settles value that arrived by protocol message. NEVER reverts for a
    /// real recipient: it runs on the message path, where a revert would
    /// undo (or, cross-chain, strand) the payout. Pays tokens when the vault
    /// has them and the token accepts the transfer (an issuer can freeze a
    /// recipient); otherwise mints the whole amount as oUSD, redeemable
    /// later. Sub-SCALE dust is always minted so conservation is exact to
    /// the wei.
    function payout(address to, uint256 amount18) external onlyAgent nonReentrant {
        uint256 units = amount18 / SCALE;
        uint256 minted = amount18;
        if (units > 0 && _trySend(to, units)) {
            minted = amount18 - units * SCALE;
        } else {
            units = 0;
        }
        if (minted > 0) _mint(to, minted);
        emit PaidOut(to, units, minted);
    }

    function bridgeMint(address to, uint256 amount) external onlyAgent {
        _mint(to, amount);
    }

    function bridgeBurn(address from, uint256 amount) external onlyAgent {
        _burn(from, amount);
    }

    /* ---------------------------- internals ---------------------------- */

    /// Pulls dollar tokens into the vault under the deposit cap and returns
    /// the oUSD value of what ACTUALLY arrived (balance delta, not the
    /// request).
    function _pull(address from, uint256 units) private returns (uint256 amount18) {
        require(units > 0, "oUSD: zero");
        require(!depositsPaused, "oUSD: deposits paused");
        uint256 before = usdc.balanceOf(address(this));
        require(before + units <= depositCap, "oUSD: deposit cap");
        usdc.safeTransferFrom(from, address(this), units);
        amount18 = (usdc.balanceOf(address(this)) - before) * SCALE;
    }

    /// A token transfer that reports failure instead of reverting.
    function _trySend(address to, uint256 units) private returns (bool) {
        if (usdc.balanceOf(address(this)) < units) return false;
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20.transfer, (to, units)));
        if (!ok) return false;
        return ret.length == 0 || (ret.length == 32 && uint256(bytes32(ret)) == 1);
    }
}
