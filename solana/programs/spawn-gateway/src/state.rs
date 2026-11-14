use anchor_lang::prelude::*;

use crate::error::GatewayError;

/// The OApp's one global account (PDA, seeds = [STORE_SEED]). Its key IS the
/// OApp's "address" on Solana — the hub routes to it as bytes32, exactly like
/// an EVM gateway address (`pad.setGateway(1, <store key>)`), and it is the
/// LayerZero peer the hub adapter names for eid 30168.
#[account]
#[derive(InitSpace)]
pub struct Store {
    /* ---- roles (Roles.sol) ---- */
    /// Topology and custody: peer, vault, sponsoring, the other roles, the
    /// LayerZero delegate. Two-step transfer. Meant to be a multisig.
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    /// Tuning: fee settings, deposit cap, unpause. Cannot move funds out.
    pub operator: Pubkey,
    /// Can only pause.
    pub guardian: Pubkey,
    pub bump: u8,
    /// Blocks NEW exposure only (spawn, buy, open). Never sells, claims,
    /// redemptions or a claim moving out. A store is BORN paused: nothing
    /// goes out before the operator says the wiring is complete.
    pub paused: bool,
    /// Sends ride the tank instead of the user (testnets only).
    pub sponsored: bool,

    /* ---- LayerZero ---- */
    /// The LayerZero EndpointV2 program — or `Pubkey::default()`, the
    /// explicit TEST SENTINEL under which every endpoint CPI (register,
    /// clear) is skipped so LiteSVM can exercise the message handlers.
    /// `init_store` refuses anything else that isn't the real endpoint id.
    pub endpoint_program: Pubkey,
    /// The hub's LayerZero eid (Base: 30184; Base Sepolia: 40245).
    pub hub_eid: u32,
    /// The hub PAD's wide identity (its EVM address left-padded): the
    /// envelope-level sender we accept and the target we address. The LZ
    /// peer (the hub ADAPTER) is a different hop and lives in PeerConfig.
    pub hub_pad: [u8; 32],

    /* ---- money ---- */
    /// The backing dollar (Circle USDC, 6 decimals) and this chain's vault.
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,
    /// Ceiling on the vault's USDC balance, enforced on every deposit.
    /// Starts at 0: deposits are closed until the operator opens them.
    pub deposit_cap: u64,
    /// Σ of every user's `usd_claim` — dollars owed that could not be paid
    /// on the spot (a short vault, a frozen or missing token account).
    pub claims_total: u64,
    /// Holder fees dropped on this chain and not yet paid out (or turned
    /// into a claim). `vault balance ≥ claims_total + pool_total` is this
    /// chain's share of the global backing invariant when it is liquid.
    pub pool_total: u64,
    /// Sub-micro-dollar remainders of hub payouts (18-decimal wei below
    /// one USDC unit): never paid, never owed — a surplus, counted so the
    /// books close to the wei.
    pub usd_dust_e18: u128,

    /* ---- fee model (v7: users pay their messages and the replies) ---- */
    /// Executor gas bought on the hub for each message (lzReceive gas).
    pub gas_to_hub: u128,
    /// Hub-chain native (wei) forwarded into the hub adapter's tank per
    /// reply this message causes — the reply budget.
    pub return_unit: u128,
    /// Replies caused by a buy / sell / claim / pull (1), and by a spawn's
    /// SYNC fan-out (the number of remote chains the hub must reach).
    pub trade_legs: u8,
    pub spawn_legs: u8,
    /// Replies prepaid by `open_token` (v7.2): the SYNC the hub sends back
    /// here. Its own count — a SYNC can cost more than the DELIVER a trade
    /// leg is priced on — and 1 from birth, never 0 by default: an open
    /// that prepaid nothing would be the hub tank's to pay.
    pub open_legs: u8,
}

impl Store {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    pub fn require_admin(&self, who: &Pubkey) -> Result<()> {
        require!(*who == self.admin, GatewayError::NotAdmin);
        Ok(())
    }

    pub fn require_operator(&self, who: &Pubkey) -> Result<()> {
        require!(*who == self.operator || *who == self.admin, GatewayError::NotOperator);
        Ok(())
    }

    pub fn require_guardian(&self, who: &Pubkey) -> Result<()> {
        require!(
            *who == self.guardian || *who == self.operator || *who == self.admin,
            GatewayError::NotGuardian
        );
        Ok(())
    }
}

/// Executor prerequisite: tells it how to call lz_receive_types.
/// (PDA, seeds = [LZ_RECEIVE_TYPES_SEED, store]).
#[account]
#[derive(InitSpace)]
pub struct LzReceiveTypesAccounts {
    pub store: Pubkey,
    pub alt: Pubkey,
    pub bump: u8,
}

impl LzReceiveTypesAccounts {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}

/// What a claim moved to ONE destination chain prepays (v7.2) — the PAYOUT
/// the hub carries there, in this chain's reply units
/// (PDA, seeds = [MOVE_ROUTE_SEED, dst_chain_be]). No account, or 0 legs:
/// the route is closed. `SpawnGateway.moveLegs[dst]`.
#[account]
#[derive(InitSpace)]
pub struct MoveRoute {
    pub dst_chain: u32,
    pub legs: u16,
    pub bump: u8,
}

impl MoveRoute {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}

/// Another chain's vault this one may send USDC to over Circle CCTP
/// (PDA, seeds = [CCTP_PEER_SEED, label_be]). Written ONCE per label and
/// never re-aimed — `OmniUSD.setPeer`: a peer is a way out of the vault.
#[account]
#[derive(InitSpace)]
pub struct CctpPeer {
    /// SPAWN! chain label of the peer's chain.
    pub label: u32,
    /// Its Circle CCTP domain (Base 6, Arbitrum 3, Optimism 2, Ethereum 0).
    pub domain: u32,
    /// The peer vault as CCTP's mint recipient: an EVM `OmniUSD` address,
    /// left-padded.
    pub vault: [u8; 32],
    pub bump: u8,
}

impl CctpPeer {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}

/// Per-remote-chain peer (PDA, seeds = [PEER_SEED, store, eid_be]).
/// `peer_address` is the 32-byte remote sender we accept and send to — for
/// the hub leg, the hub's LayerZeroOmniMessenger adapter, left-padded.
#[account]
#[derive(InitSpace)]
pub struct PeerConfig {
    pub peer_address: [u8; 32],
    pub bump: u8,
}

impl PeerConfig {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}

/// Replica registry entry (PDA, seeds = [REPLICA_SEED, hub_token]) — the
/// Solana analog of SpawnGateway.replicaOf plus that token's holder-fee
/// pool (FeeDistributor). Maps the 32-byte wire token id (the EVM hub
/// token, left-padded) to its local SPL mint. Created on OP_SYNC_TOKEN.
#[account]
#[derive(InitSpace)]
pub struct Replica {
    pub hub_token: [u8; 32],
    pub mint: Pubkey,
    pub bump: u8,
    #[max_len(64)]
    pub name: String,
    #[max_len(16)]
    pub symbol: String,
    /// 18-decimal wei delivered by the hub and not yet minted (always below
    /// one SPL unit = 1e12 wei). Carried into the next delivery, so the
    /// hub's `supplyByChain[1]` never runs ahead of this mint by a full unit.
    pub dust_carry: u64,
    /* ---- holder-fee pool (stake to earn) ---- */
    pub staked_total: u64,
    /// USDC units earned per staked replica unit, × ACC_PRECISION.
    pub acc_per_share: u128,
    /// Fees dropped while fewer than MIN_STAKED units were staked.
    pub pending_fees: u64,
}

impl Replica {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    /// Books a holder-fee drop: into the stream when enough is staked,
    /// otherwise into `pending_fees` (folded as soon as stakers reach
    /// MIN_STAKED — the FeeDistributor rule, for the same overflow reason).
    pub fn fold(&mut self, drop: u64) {
        self.pending_fees = self.pending_fees.saturating_add(drop);
        if self.pending_fees == 0 || self.staked_total < crate::MIN_STAKED {
            return;
        }
        let add = (self.pending_fees as u128) * crate::ACC_PRECISION / (self.staked_total as u128);
        self.acc_per_share = self.acc_per_share.saturating_add(add);
        self.pending_fees = 0;
    }

    /// Splits a hub amount into whole SPL units and the new carry.
    pub fn take_units(&mut self, amount_e18: u128) -> Result<u64> {
        let total = amount_e18
            .checked_add(self.dust_carry as u128)
            .ok_or(GatewayError::AmountOverflow)?;
        let units = u64::try_from(total / crate::EVM_TO_SPL_DIVISOR)
            .map_err(|_| GatewayError::AmountOverflow)?;
        self.dust_carry = (total % crate::EVM_TO_SPL_DIVISOR) as u64;
        Ok(units)
    }
}

/// A delivery that could not be minted when it arrived.
#[derive(Clone, AnchorSerialize, AnchorDeserialize, InitSpace)]
pub struct Parked {
    pub hub_token: [u8; 32],
    /// 18-decimal hub units, exact — converted when it is claimed.
    pub amount_e18: u128,
}

/// One per Solana user (PDA, seeds = [USER_SEED, owner]), created — and its
/// rent paid — by the user's first action here. It is where a hub reply
/// lands when it cannot be settled on the spot, so `lz_receive` never needs
/// lamports for a new account: hub messages cannot carry any.
#[account]
#[derive(InitSpace)]
pub struct UserAccount {
    pub owner: Pubkey,
    pub bump: u8,
    /// USDC units owed (a short vault, a frozen or missing token account).
    pub usd_claim: u64,
    #[max_len(4)]
    pub parked: Vec<Parked>,
}

impl UserAccount {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    pub fn park(&mut self, hub_token: [u8; 32], amount_e18: u128) -> Result<()> {
        if let Some(p) = self.parked.iter_mut().find(|p| p.hub_token == hub_token) {
            p.amount_e18 = p.amount_e18.checked_add(amount_e18).ok_or(GatewayError::AmountOverflow)?;
            return Ok(());
        }
        require!(self.parked.len() < crate::MAX_PARKED, GatewayError::ParkingFull);
        self.parked.push(Parked { hub_token, amount_e18 });
        Ok(())
    }
}

/// A holder's stake in one replica's fee pool
/// (PDA, seeds = [POSITION_SEED, hub_token, owner]).
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub hub_token: [u8; 32],
    pub bump: u8,
    pub staked: u64,
    pub reward_debt: u128,
    /// USDC units earned and not yet claimed.
    pub owed: u64,
}

impl Position {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    /// Moves what the position earned since its last touch into `owed`.
    pub fn settle(&mut self, acc_per_share: u128) {
        let accrued = (self.staked as u128) * acc_per_share / crate::ACC_PRECISION;
        let earned = accrued.saturating_sub(self.reward_debt);
        self.owed = self.owed.saturating_add(earned as u64);
    }

    pub fn rebase(&mut self, acc_per_share: u128) {
        self.reward_debt = (self.staked as u128) * acc_per_share / crate::ACC_PRECISION;
    }
}
