//! LiteSVM tests of the v7 receive path, the user instructions and the
//! roles — in the SENTINEL world: the store is initialized with the test
//! sentinel endpoint (default pubkey), so the endpoint CPIs (register,
//! clear) are skipped and `lz_receive` can be driven directly with any hub
//! message. The dollar is Circle's REAL USDC mint account (mainnet fixture).
//!
//! What these tests prove: every hub→Solana op and what it does when it
//! cannot be settled on the spot (parking, claims), with NO lamports taken
//! from the `lz_receive` payer; the holder-fee pool's arithmetic; the
//! decimal bridge to the wei; authentication; roles and pause.
//!
//! What they leave to test_live_endpoint.rs: the real endpoint (clear),
//! the real executor's lamport check, and the whole send path.

mod common;

use {
    anchor_lang::{InstructionData, ToAccountMetas},
    common::*,
    oapp::LzReceiveParams,
    solana_sdk::{
        instruction::{AccountMeta, Instruction},
        pubkey::Pubkey,
        signature::{Keypair, Signer},
    },
    spawn_gateway::{
        msg_codec::{Envelope, SpawnMsg, U256, WireAddr},
        state::{Position, Replica, UserAccount},
    },
};

fn setup() -> World {
    let mut w = base_world();
    let ix = init_store_ix(&w, Pubkey::default(), vec![]);
    w.send(&[ix], &[]).unwrap();
    wire_store(&mut w);
    w
}

/// Delivers `message` bytes through lz_receive, signed by the executor
/// stand-in as `payer` (the admin pays the transaction fee).
fn deliver_raw(w: &mut World, sender: [u8; 32], src_eid: u32, message: Vec<u8>, rest: Vec<AccountMeta>) -> TxResult {
    let params = LzReceiveParams { src_eid, sender, nonce: 1, guid: [0u8; 32], message, extra_data: vec![] };
    let mut metas = spawn_gateway::accounts::LzReceive { payer: w.exec.pubkey(), store: w.ids.store, peer: w.ids.peer }
        .to_account_metas(None);
    metas.extend(rest);
    let ix = Instruction::new_with_bytes(w.ids.program, &spawn_gateway::instruction::LzReceive { params }.data(), metas);
    let exec = w.exec.insecure_clone();
    w.send(&[ix], &[&exec])
}

fn lz_receive(w: &mut World, msg: &SpawnMsg, rest: Vec<AccountMeta>) -> TxResult {
    let message = w.wire(msg);
    deliver_raw(w, hub_peer(), HUB_EID, message, rest)
}

const TOK: u8 = 0x8b;

fn sync(w: &mut World, tag: u8) -> TxResult {
    let t = token_id(tag);
    let accounts = w.sync_accounts(&t);
    lz_receive(w, &SpawnMsg::SyncToken { hub_token: WireAddr(t), name: "OMNI TEST".into(), symbol: "OMNI".into() }, accounts)
}

fn deliver(w: &mut World, tag: u8, to: &Pubkey, tokens_e18: u128, refund_e18: u128) -> TxResult {
    let t = token_id(tag);
    let accounts = w.deliver_accounts(&t, to);
    lz_receive(
        w,
        &SpawnMsg::Deliver {
            hub_token: WireAddr(t),
            to: WireAddr::from_pubkey(to),
            tokens: U256::from_u128(tokens_e18),
            refund: U256::from_u128(refund_e18),
        },
        accounts,
    )
}

fn payout(w: &mut World, to: &Pubkey, usd_e18: u128) -> TxResult {
    let accounts = w.payout_accounts(to);
    lz_receive(w, &SpawnMsg::Payout { to: WireAddr::from_pubkey(to), usd_out: U256::from_u128(usd_e18) }, accounts)
}

fn fee_drop(w: &mut World, tag: u8, usd_e18: u128) -> TxResult {
    let t = token_id(tag);
    let accounts = w.fee_drop_accounts(&t);
    lz_receive(w, &SpawnMsg::FeeDrop { hub_token: WireAddr(t), amount: U256::from_u128(usd_e18) }, accounts)
}

/// A user who has done what any first action here does: their user account
/// and their USDC token account exist.
fn user_with_accounts(w: &mut World) -> Keypair {
    let u = w.new_user();
    w.open_user_account(&u.pubkey());
    w.give_usdc(&u.pubkey(), 0);
    u
}

fn replica_ata(w: &mut World, tag: u8, owner: &Pubkey) -> Pubkey {
    let mint = w.ids.mint(&token_id(tag));
    let ata = ata_of(owner, &mint);
    w.plant_token_account(ata, &mint, owner, 0);
    ata
}

/* ------------------------------- SYNC ------------------------------- */

#[test]
fn sync_creates_the_replica_out_of_the_tank_not_the_executor() {
    let mut w = setup();
    let tank = w.ids.tank;
    w.fund(&tank, 1_000_000_000);
    let (exec_before, tank_before) = (w.lamports(&w.exec.pubkey()), w.lamports(&tank));

    let meta = sync(&mut w, TOK).unwrap();
    println!("CU sync_token: {}", meta.compute_units_consumed);

    let t = token_id(TOK);
    let replica: Replica = w.read(&w.ids.replica(&t));
    assert_eq!(replica.hub_token, t);
    assert_eq!(replica.mint, w.ids.mint(&t));
    assert_eq!((replica.name.as_str(), replica.symbol.as_str()), ("OMNI TEST", "OMNI"));
    // the SPL mint: authority = the store, 6 decimals, NO freeze authority
    let mint = w.svm.get_account(&w.ids.mint(&t)).unwrap();
    assert_eq!(mint.owner, TOKEN_PROGRAM);
    assert_eq!(&mint.data[0..4], &1u32.to_le_bytes());
    assert_eq!(&mint.data[4..36], w.ids.store.as_ref());
    assert_eq!(mint.data[44], 6);
    assert_eq!(&mint.data[46..50], &0u32.to_le_bytes(), "no freeze authority");

    // the hub's messages carry no lamports: the executor must not lose one
    assert_eq!(w.lamports(&w.exec.pubkey()), exec_before, "the executor paid rent");
    let rent = tank_before - w.lamports(&tank);
    println!("rent of one replica (entry + mint), from the tank: {} lamports", rent);
    assert!(rent > 0 && rent < 5_000_000);

    // a replica is forever: a second SYNC changes nothing and costs nothing
    let tank_mid = w.lamports(&tank);
    let accounts = w.sync_accounts(&t);
    lz_receive(&mut w, &SpawnMsg::SyncToken { hub_token: WireAddr(t), name: "EVIL".into(), symbol: "X".into() }, accounts)
        .unwrap();
    let replica: Replica = w.read(&w.ids.replica(&t));
    assert_eq!(replica.name, "OMNI TEST");
    assert_eq!(w.lamports(&tank), tank_mid);
}

#[test]
fn sync_with_a_dry_tank_charges_the_payer_and_prefunded_addresses_do_not_block_it() {
    let mut w = setup();
    let t = token_id(TOK);
    // griefing: someone pre-funds both PDAs so a plain create_account fails
    w.set_lamports(&w.ids.replica(&t), 1_000);
    w.set_lamports(&w.ids.mint(&t), 5_000_000);

    let exec_before = w.lamports(&w.exec.pubkey());
    assert_eq!(w.lamports(&w.ids.tank), 0);
    sync(&mut w, TOK).unwrap();
    // no tank → the transaction's payer funded the rent. LayerZero's
    // executor refuses that (see test_live_endpoint); a user may accept it.
    assert!(w.lamports(&w.exec.pubkey()) < exec_before);
    let replica: Replica = w.read(&w.ids.replica(&t));
    assert_eq!(replica.mint, w.ids.mint(&t));
}

/* ------------------------------ DELIVER ----------------------------- */

#[test]
fn deliver_mints_to_the_wei_with_a_carry_and_refunds_in_usdc() {
    let mut w = setup();
    w.fund(&w.ids.tank.clone(), 1_000_000_000);
    sync(&mut w, TOK).unwrap();
    let u = user_with_accounts(&mut w);
    let ata = replica_ata(&mut w, TOK, &u.pubkey());
    let vault = w.ids.vault;
    w.set_token_amount(&vault, 100 * ONE_USDC);
    let exec_before = w.lamports(&w.exec.pubkey());

    // 1.5 units, twice: 1 minted + 0.5 carried, then 2 minted + 0 carried
    let meta = deliver(&mut w, TOK, &u.pubkey(), 3 * E12 / 2, 0).unwrap();
    println!("CU deliver (mint): {}", meta.compute_units_consumed);
    assert_eq!(w.token_amount(&ata), 1);
    let replica: Replica = w.read(&w.ids.replica(&token_id(TOK)));
    assert_eq!(replica.dust_carry as u128, E12 / 2);
    deliver(&mut w, TOK, &u.pubkey(), 3 * E12 / 2, 0).unwrap();
    assert_eq!(w.token_amount(&ata), 3, "Σ minted × 1e12 == Σ delivered");
    let replica: Replica = w.read(&w.ids.replica(&token_id(TOK)));
    assert_eq!(replica.dust_carry, 0);

    // a real-sized bag and a $5.000000999999 refund: USDC straight from the
    // vault; the sub-micro-dollar tail is counted, never owed
    let bag = 884_495_291_384_607_698_648_615u128;
    let meta = deliver(&mut w, TOK, &u.pubkey(), bag, 5 * E18 + 999_999_999_999).unwrap();
    println!("CU deliver (mint + USDC refund): {}", meta.compute_units_consumed);
    assert_eq!(w.token_amount(&ata), 3 + 884_495_291_384);
    assert_eq!(w.token_amount(&ata_of(&u.pubkey(), &USDC)), 5 * ONE_USDC);
    assert_eq!(w.token_amount(&vault), 95 * ONE_USDC);
    assert_eq!(w.store().usd_dust_e18, 999_999_999_999);
    assert_eq!(w.store().claims_total, 0);

    // a bounce: no tokens, the whole spend comes home (FAIR GENESIS block 0,
    // a paused hub) — the replica is not even looked at
    deliver(&mut w, 0x77, &u.pubkey(), 0, 3 * E18).unwrap();
    assert_eq!(w.token_amount(&ata_of(&u.pubkey(), &USDC)), 8 * ONE_USDC);

    assert_eq!(w.lamports(&w.exec.pubkey()), exec_before, "a delivery cost the executor lamports");
}

#[test]
fn a_delivery_that_beats_its_sync_is_parked_and_claimed_later() {
    let mut w = setup();
    w.fund(&w.ids.tank.clone(), 1_000_000_000);
    let u = user_with_accounts(&mut w);
    let t = token_id(TOK);
    let exec_before = w.lamports(&w.exec.pubkey());

    // DELIVER first: no replica, no mint, no token account — nothing fails
    let bag = 1_000_000 * E18 + 7; // 7 wei of dust ride along
    let meta = deliver(&mut w, TOK, &u.pubkey(), bag, 0).unwrap();
    println!("CU deliver (parked): {}", meta.compute_units_consumed);
    let ua: UserAccount = w.read(&w.ids.user(&u.pubkey()));
    assert_eq!(ua.parked.len(), 1);
    assert_eq!((ua.parked[0].hub_token, ua.parked[0].amount_e18), (t, bag));
    assert_eq!(w.lamports(&w.exec.pubkey()), exec_before);

    // claiming before the SYNC cannot work — the replica does not exist
    let claim_ix = |w: &World| {
        let mint = w.ids.mint(&t);
        Instruction::new_with_bytes(
            w.ids.program,
            &spawn_gateway::instruction::ClaimParked { hub_token: t }.data(),
            spawn_gateway::accounts::ClaimParked {
                user: u.pubkey(),
                store: w.ids.store,
                user_account: w.ids.user(&u.pubkey()),
                replica: w.ids.replica(&t),
                mint,
                user_token: ata_of(&u.pubkey(), &mint),
                token_program: TOKEN_PROGRAM,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
        )
    };
    let ix = claim_ix(&w);
    assert!(w.send(&[ix], &[&u]).is_err());

    // a second delivery of the same token adds to the same slot
    deliver(&mut w, TOK, &u.pubkey(), 5 * E12 - 7, 0).unwrap();
    let ua: UserAccount = w.read(&w.ids.user(&u.pubkey()));
    assert_eq!((ua.parked.len(), ua.parked[0].amount_e18), (1, bag + 5 * E12 - 7));

    // the SYNC lands; the user claims — and funds their own token account
    sync(&mut w, TOK).unwrap();
    let ix = claim_ix(&w);
    w.send(&[ix], &[&u]).unwrap();
    let ata = ata_of(&u.pubkey(), &w.ids.mint(&t));
    assert_eq!(w.token_amount(&ata), 1_000_000 * ONE_TOKEN + 5);
    let ua: UserAccount = w.read(&w.ids.user(&u.pubkey()));
    assert!(ua.parked.is_empty());
    let replica: Replica = w.read(&w.ids.replica(&t));
    assert_eq!(replica.dust_carry, 0);
    // nothing left to claim
    let ix = claim_ix(&w);
    assert!(w.send(&[ix], &[&u]).unwrap_err().contains("NothingParked"));
}

#[test]
fn a_delivery_to_a_missing_or_frozen_token_account_is_parked_too() {
    let mut w = setup();
    w.fund(&w.ids.tank.clone(), 1_000_000_000);
    sync(&mut w, TOK).unwrap();
    let u = user_with_accounts(&mut w);
    // no token account at all (the user closed it after buying)
    deliver(&mut w, TOK, &u.pubkey(), 10 * E18, 0).unwrap();
    // a token account that cannot be minted into
    let ata = replica_ata(&mut w, TOK, &u.pubkey());
    w.freeze(&ata);
    deliver(&mut w, TOK, &u.pubkey(), 10 * E18, 0).unwrap();
    let ua: UserAccount = w.read(&w.ids.user(&u.pubkey()));
    assert_eq!(ua.parked[0].amount_e18, 20 * E18);
    assert_eq!(w.token_amount(&ata), 0);

    // with no user account there is nowhere to park: the message fails and
    // stays executable — anyone can open the account and run it again
    let stranger = w.new_user();
    let err = deliver(&mut w, TOK, &stranger.pubkey(), 10 * E18, 0).unwrap_err();
    assert!(err.contains("NoUserAccount"), "{err}");
    w.open_user_account(&stranger.pubkey());
    deliver(&mut w, TOK, &stranger.pubkey(), 10 * E18, 0).unwrap();
}

#[test]
fn parking_is_bounded_and_says_so() {
    let mut w = setup();
    let u = user_with_accounts(&mut w);
    for tag in 1..=4u8 {
        deliver(&mut w, tag, &u.pubkey(), E18, 0).unwrap();
    }
    let err = deliver(&mut w, 5, &u.pubkey(), E18, 0).unwrap_err();
    assert!(err.contains("ParkingFull"), "{err}");
    // a token already parked still accumulates
    deliver(&mut w, 3, &u.pubkey(), E18, 0).unwrap();
}

/* ------------------------------ PAYOUT ------------------------------ */

#[test]
fn a_payout_is_usdc_when_it_can_be_and_a_claim_when_it_cannot() {
    let mut w = setup();
    let u = user_with_accounts(&mut w);
    let usdc_ata = ata_of(&u.pubkey(), &USDC);
    let vault = w.ids.vault;
    let exec_before = w.lamports(&w.exec.pubkey());

    // liquid vault → USDC
    w.set_token_amount(&vault, 50 * ONE_USDC);
    let meta = payout(&mut w, &u.pubkey(), 20 * E18).unwrap();
    println!("CU payout (USDC): {}", meta.compute_units_consumed);
    assert_eq!((w.token_amount(&usdc_ata), w.token_amount(&vault)), (20 * ONE_USDC, 30 * ONE_USDC));

    // short vault → the WHOLE payout is a claim (OmniUSD.payout is all-or-nothing)
    let meta = payout(&mut w, &u.pubkey(), 40 * E18).unwrap();
    println!("CU payout (claim): {}", meta.compute_units_consumed);
    assert_eq!((w.token_amount(&usdc_ata), w.token_amount(&vault)), (20 * ONE_USDC, 30 * ONE_USDC));
    let ua: UserAccount = w.read(&w.ids.user(&u.pubkey()));
    assert_eq!(ua.usd_claim, 40 * ONE_USDC);
    assert_eq!(w.store().claims_total, 40 * ONE_USDC);

    // Circle froze the recipient's account → a claim, not a stuck message
    w.freeze(&usdc_ata);
    payout(&mut w, &u.pubkey(), 5 * E18).unwrap();
    let ua: UserAccount = w.read(&w.ids.user(&u.pubkey()));
    assert_eq!(ua.usd_claim, 45 * ONE_USDC);
    assert_eq!(w.token_amount(&vault), 30 * ONE_USDC);

    // Circle froze the VAULT → still not a failure
    w.give_usdc(&u.pubkey(), 20 * ONE_USDC); // thawed again
    w.freeze(&vault);
    payout(&mut w, &u.pubkey(), ONE_USDC as u128 * E12).unwrap();
    let ua: UserAccount = w.read(&w.ids.user(&u.pubkey()));
    assert_eq!(ua.usd_claim, 46 * ONE_USDC);

    // a dust-only payout (under one USDC unit) moves nothing and owes nothing
    payout(&mut w, &u.pubkey(), 999_999).unwrap();
    assert_eq!(w.store().usd_dust_e18, 999_999);
    assert_eq!(w.store().claims_total, 46 * ONE_USDC);
    assert_eq!(w.lamports(&w.exec.pubkey()), exec_before);

    // liquidity comes back (a rebalance, new buyers): the claim redeems
    w.plant_token_account(vault, &USDC, &w.ids.store.clone(), 30 * ONE_USDC);
    let redeem = |w: &World, units: u64| {
        Instruction::new_with_bytes(
            w.ids.program,
            &spawn_gateway::instruction::RedeemClaim { units }.data(),
            spawn_gateway::accounts::RedeemClaim {
                user: u.pubkey(),
                store: w.ids.store,
                user_account: w.ids.user(&u.pubkey()),
                usdc_mint: USDC,
                vault: w.ids.vault,
                user_usdc: ata_of(&u.pubkey(), &USDC),
                token_program: TOKEN_PROGRAM,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
        )
    };
    let ix = redeem(&w, 46 * ONE_USDC);
    assert!(w.send(&[ix], &[&u]).unwrap_err().contains("VaultShort"));
    let ix = redeem(&w, 30 * ONE_USDC);
    w.send(&[ix], &[&u]).unwrap();
    assert_eq!(w.token_amount(&usdc_ata), 50 * ONE_USDC);
    let ua: UserAccount = w.read(&w.ids.user(&u.pubkey()));
    assert_eq!(ua.usd_claim, 16 * ONE_USDC);
    assert_eq!(w.store().claims_total, 16 * ONE_USDC);
    let ix = redeem(&w, 17 * ONE_USDC);
    assert!(w.send(&[ix], &[&u]).unwrap_err().contains("NothingToRedeem"));
}

/* ------------------------- FEE_DROP and the pool --------------------- */

struct Staker {
    kp: Keypair,
    ata: Pubkey,
}

fn staker(w: &mut World, tag: u8, tokens: u64) -> Staker {
    let kp = user_with_accounts(w);
    let ata = replica_ata(w, tag, &kp.pubkey());
    deliver(w, tag, &kp.pubkey(), tokens as u128 * E18, 0).unwrap();
    Staker { kp, ata }
}

fn stake_ix(w: &World, tag: u8, who: &Pubkey, units: u64, unstake: bool) -> Instruction {
    let t = token_id(tag);
    let mint = w.ids.mint(&t);
    if unstake {
        Instruction::new_with_bytes(
            w.ids.program,
            &spawn_gateway::instruction::Unstake { hub_token: t, units }.data(),
            spawn_gateway::accounts::Unstake {
                user: *who,
                store: w.ids.store,
                replica: w.ids.replica(&t),
                mint,
                escrow: w.ids.escrow(&t),
                position: w.ids.position(&t, who),
                user_token: ata_of(who, &mint),
                token_program: TOKEN_PROGRAM,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
        )
    } else {
        Instruction::new_with_bytes(
            w.ids.program,
            &spawn_gateway::instruction::Stake { hub_token: t, units }.data(),
            spawn_gateway::accounts::Stake {
                user: *who,
                store: w.ids.store,
                replica: w.ids.replica(&t),
                mint,
                escrow: w.ids.escrow(&t),
                position: w.ids.position(&t, who),
                user_token: ata_of(who, &mint),
                token_program: TOKEN_PROGRAM,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
        )
    }
}

fn claim_rewards_ix(w: &World, tag: u8, who: &Pubkey) -> Instruction {
    let t = token_id(tag);
    Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::ClaimRewards { hub_token: t }.data(),
        spawn_gateway::accounts::ClaimRewards {
            user: *who,
            store: w.ids.store,
            replica: w.ids.replica(&t),
            position: w.ids.position(&t, who),
            user_account: w.ids.user(who),
            usdc_mint: USDC,
            vault: w.ids.vault,
            user_usdc: ata_of(who, &USDC),
            token_program: TOKEN_PROGRAM,
            associated_token_program: ATA_PROGRAM,
            system_program: SYSTEM,
        }
        .to_account_metas(None),
    )
}

#[test]
fn holder_fees_go_to_stakers_pro_rata_and_only_from_the_moment_they_stake() {
    let mut w = setup();
    w.fund(&w.ids.tank.clone(), 1_000_000_000);
    sync(&mut w, TOK).unwrap();
    let vault = w.ids.vault;
    w.set_token_amount(&vault, 1_000 * ONE_USDC);
    let a = staker(&mut w, TOK, 3_000);
    let b = staker(&mut w, TOK, 3_000);

    // a drop with nobody staked waits — it is not lost and not given away
    let meta = fee_drop(&mut w, TOK, 10 * E18 + 5).unwrap();
    println!("CU fee_drop: {}", meta.compute_units_consumed);
    let r: Replica = w.read(&w.ids.replica(&token_id(TOK)));
    assert_eq!((r.pending_fees, r.acc_per_share, r.staked_total), (10 * ONE_USDC, 0, 0));
    assert_eq!(w.store().pool_total, 10 * ONE_USDC);
    assert_eq!(w.store().usd_dust_e18, 5);

    // 500 tokens staked is under the floor (1,000): still waiting
    let ix = stake_ix(&w, TOK, &a.kp.pubkey(), 500 * ONE_TOKEN, false);
    let meta = w.send(&[ix], &[&a.kp]).unwrap();
    println!("CU stake (first, creates escrow + position): {}", meta.compute_units_consumed);
    let r: Replica = w.read(&w.ids.replica(&token_id(TOK)));
    assert_eq!((r.pending_fees, r.acc_per_share), (10 * ONE_USDC, 0));
    // A reaches 2,000: the waiting drop folds in — all of it A's
    let ix = stake_ix(&w, TOK, &a.kp.pubkey(), 1_500 * ONE_TOKEN, false);
    w.send(&[ix], &[&a.kp]).unwrap();
    let r: Replica = w.read(&w.ids.replica(&token_id(TOK)));
    assert_eq!((r.pending_fees, r.staked_total), (0, 2_000 * ONE_TOKEN));
    assert_eq!(w.token_amount(&a.ata), 1_000 * ONE_TOKEN);
    assert_eq!(w.token_amount(&w.ids.escrow(&token_id(TOK))), 2_000 * ONE_TOKEN);

    // B stakes 2,000 AFTER that drop: none of it is B's
    let ix = stake_ix(&w, TOK, &b.kp.pubkey(), 2_000 * ONE_TOKEN, false);
    w.send(&[ix], &[&b.kp]).unwrap();
    // a second drop: 10 USDC over 4,000 staked → 5 each
    fee_drop(&mut w, TOK, 10 * E18).unwrap();

    let ix = claim_rewards_ix(&w, TOK, &a.kp.pubkey());
    let meta = w.send(&[ix], &[&a.kp]).unwrap();
    println!("CU claim_rewards: {}", meta.compute_units_consumed);
    assert_eq!(w.token_amount(&ata_of(&a.kp.pubkey(), &USDC)), 15 * ONE_USDC);
    let ix = claim_rewards_ix(&w, TOK, &b.kp.pubkey());
    w.send(&[ix], &[&b.kp]).unwrap();
    assert_eq!(w.token_amount(&ata_of(&b.kp.pubkey(), &USDC)), 5 * ONE_USDC);
    assert_eq!(w.store().pool_total, 0);
    assert_eq!(w.token_amount(&vault), 980 * ONE_USDC);
    // nothing twice
    let ix = claim_rewards_ix(&w, TOK, &a.kp.pubkey());
    assert!(w.send(&[ix], &[&a.kp]).unwrap_err().contains("NothingToRedeem"));

    // B leaves: later drops are A's alone; what B earned stays B's
    fee_drop(&mut w, TOK, 4 * E18).unwrap(); // 2 each
    let ix = stake_ix(&w, TOK, &b.kp.pubkey(), 2_000 * ONE_TOKEN, true);
    let meta = w.send(&[ix], &[&b.kp]).unwrap();
    println!("CU unstake: {}", meta.compute_units_consumed);
    assert_eq!(w.token_amount(&b.ata), 3_000 * ONE_TOKEN);
    fee_drop(&mut w, TOK, 6 * E18).unwrap(); // all A's
    let pos: Position = w.read(&w.ids.position(&token_id(TOK), &b.kp.pubkey()));
    assert_eq!((pos.staked, pos.owed), (0, 2 * ONE_USDC));
    let ix = stake_ix(&w, TOK, &b.kp.pubkey(), 1, true);
    assert!(w.send(&[ix], &[&b.kp]).unwrap_err().contains("NotEnoughStaked"));

    // a short vault turns earned fees into a claim instead of failing
    w.set_token_amount(&vault, ONE_USDC);
    let ix = claim_rewards_ix(&w, TOK, &a.kp.pubkey());
    w.send(&[ix], &[&a.kp]).unwrap();
    let ua: UserAccount = w.read(&w.ids.user(&a.kp.pubkey()));
    assert_eq!(ua.usd_claim, 8 * ONE_USDC);
    let s = w.store();
    assert_eq!((s.pool_total, s.claims_total), (2 * ONE_USDC, 8 * ONE_USDC));
}

#[test]
fn a_fee_drop_for_a_token_that_is_not_here_fails_and_stays_retryable() {
    let mut w = setup();
    let err = fee_drop(&mut w, TOK, 10 * E18).unwrap_err();
    assert!(err.contains("NoReplica"), "{err}");
    assert_eq!(w.store().pool_total, 0);
}

/* ------------------------------- auth -------------------------------- */

#[test]
fn only_the_hub_pad_through_the_hub_adapter_is_heard() {
    let mut w = setup();
    let u = user_with_accounts(&mut w);
    let vault = w.ids.vault;
    w.set_token_amount(&vault, 100 * ONE_USDC);
    let msg = SpawnMsg::Payout { to: WireAddr::from_pubkey(&u.pubkey()), usd_out: U256::from_u128(50 * E18) };
    let good = w.wire(&msg);
    let accounts = w.payout_accounts(&u.pubkey());

    // not the hub adapter
    let mut evil = hub_peer();
    evil[31] ^= 1;
    assert!(deliver_raw(&mut w, evil, HUB_EID, good.clone(), accounts.clone()).unwrap_err().contains("NotPeer"));
    // the hub adapter, but the envelope names another protocol sender
    let forged = Envelope { src_sender: WireAddr([7; 32]), dst_addr: WireAddr(w.ids.store.to_bytes()), payload: msg.encode() }
        .encode();
    assert!(deliver_raw(&mut w, hub_peer(), HUB_EID, forged, accounts.clone()).unwrap_err().contains("NotPeer"));
    // addressed to someone else
    let stray = Envelope { src_sender: WireAddr(hub_pad()), dst_addr: WireAddr([9; 32]), payload: msg.encode() }.encode();
    assert!(deliver_raw(&mut w, hub_peer(), HUB_EID, stray, accounts.clone()).unwrap_err().contains("NotPeer"));
    // a recipient account that is not the wire's recipient
    let other = user_with_accounts(&mut w);
    let wrong = w.payout_accounts(&other.pubkey());
    assert!(deliver_raw(&mut w, hub_peer(), HUB_EID, good.clone(), wrong).unwrap_err().contains("RecipientMismatch"));
    // a spoke→hub op can never arrive at a spoke
    let buy = SpawnMsg::Buy { hub_token: WireAddr(token_id(1)), buyer: WireAddr([1; 32]), usd_in: U256::from_u128(1) };
    let bytes = w.wire(&buy);
    assert!(deliver_raw(&mut w, hub_peer(), HUB_EID, bytes, accounts.clone()).unwrap_err().contains("UnknownOp"));
    // garbage
    assert!(deliver_raw(&mut w, hub_peer(), HUB_EID, vec![1, 2, 3], accounts.clone()).is_err());

    assert_eq!(w.token_amount(&vault), 100 * ONE_USDC, "nothing left the vault");
    deliver_raw(&mut w, hub_peer(), HUB_EID, good, accounts).unwrap();
    assert_eq!(w.token_amount(&vault), 50 * ONE_USDC);
}

/* --------------------------- roles and pause ------------------------- */

#[test]
fn three_keys_admin_operator_guardian() {
    let mut w = setup();
    let (operator, guardian, nominee, nobody) = (w.new_user(), w.new_user(), w.new_user(), w.new_user());
    let admin = w.admin.insecure_clone();
    use spawn_gateway::instruction as ix;
    let fee = |unit: u128, trade: u8, spawn: u8| {
        ix::SetFeeConfig {
            params: spawn_gateway::instructions::FeeConfigParams {
                gas_to_hub: 4_600_000,
                return_unit: unit,
                trade_legs: trade,
                spawn_legs: spawn,
            },
        }
        .data()
    };

    // nobody is anybody
    assert!(w.govern(ix::Pause {}.data(), &nobody).unwrap_err().contains("NotGuardian"));
    assert!(w.govern(ix::SetDepositCap { cap: 1 }.data(), &nobody).unwrap_err().contains("NotOperator"));
    assert!(w.govern(ix::SetOperator { operator: nobody.pubkey() }.data(), &nobody).unwrap_err().contains("NotAdmin"));

    w.govern(ix::SetOperator { operator: operator.pubkey() }.data(), &admin).unwrap();
    w.govern(ix::SetGuardian { guardian: guardian.pubkey() }.data(), &admin).unwrap();

    // the guardian can only pause
    w.govern(ix::Pause {}.data(), &guardian).unwrap();
    assert!(w.store().paused);
    assert!(w.govern(ix::Unpause {}.data(), &guardian).unwrap_err().contains("NotOperator"));
    assert!(w.govern(ix::SetDepositCap { cap: 1 }.data(), &guardian).unwrap_err().contains("NotOperator"));

    // the operator tunes within bounds and unpauses — nothing more
    w.govern(ix::Unpause {}.data(), &operator).unwrap();
    assert!(!w.store().paused);
    w.govern(ix::SetDepositCap { cap: 25_000 * ONE_USDC }.data(), &operator).unwrap();
    w.govern(fee(200_000_000_000_000, 1, 3), &operator).unwrap();
    let s = w.store();
    assert_eq!((s.deposit_cap, s.gas_to_hub, s.return_unit, s.trade_legs, s.spawn_legs), (25_000 * ONE_USDC, 4_600_000, 200_000_000_000_000, 1, 3));
    assert!(w.govern(fee(50_000_000_000_000_001, 1, 3), &operator).unwrap_err().contains("OutOfBounds"));
    assert!(w.govern(fee(1, 5, 3), &operator).unwrap_err().contains("OutOfBounds"));
    assert!(w.govern(fee(1, 1, 33), &operator).unwrap_err().contains("OutOfBounds"));
    assert!(w.govern(ix::SetSponsored { on: true }.data(), &operator).unwrap_err().contains("NotAdmin"));
    assert!(w.govern(ix::SetGuardian { guardian: operator.pubkey() }.data(), &operator).unwrap_err().contains("NotAdmin"));
    assert!(w.govern(ix::TransferAdmin { nominee: operator.pubkey() }.data(), &operator).unwrap_err().contains("NotAdmin"));
    // the peer — who may forge payouts — is the admin's alone
    let peer_ix = |who: &Pubkey, w: &World| {
        Instruction::new_with_bytes(
            w.ids.program,
            &ix::SetPeerConfig {
                params: spawn_gateway::instructions::SetPeerConfigParams { remote_eid: HUB_EID, peer_address: [6; 32] },
            }
            .data(),
            spawn_gateway::accounts::SetPeerConfig { admin: *who, peer: w.ids.peer, store: w.ids.store, system_program: SYSTEM }
                .to_account_metas(None),
        )
    };
    let i = peer_ix(&operator.pubkey(), &w);
    assert!(w.send(&[i], &[&operator]).unwrap_err().contains("NotAdmin"));

    // two-step admin: nothing moves until the nominee accepts
    w.govern(ix::TransferAdmin { nominee: nominee.pubkey() }.data(), &admin).unwrap();
    assert_eq!(w.store().admin, admin.pubkey());
    assert!(w.govern(ix::AcceptAdmin {}.data(), &nobody).unwrap_err().contains("NotNominee"));
    w.govern(ix::AcceptAdmin {}.data(), &nominee).unwrap();
    let s = w.store();
    assert_eq!((s.admin, s.pending_admin), (nominee.pubkey(), Pubkey::default()));
    assert!(w.govern(ix::SetSponsored { on: true }.data(), &admin).unwrap_err().contains("NotAdmin"));
    w.govern(ix::SetSponsored { on: true }.data(), &nominee).unwrap();
    // the admin may act as operator and guardian
    w.govern(ix::Pause {}.data(), &nominee).unwrap();
    w.govern(ix::Unpause {}.data(), &nominee).unwrap();

    // a paused gateway still RECEIVES: exits and replies are never blocked
    w.govern(ix::Pause {}.data(), &guardian).unwrap();
    let u = user_with_accounts(&mut w);
    let vault = w.ids.vault;
    w.set_token_amount(&vault, 10 * ONE_USDC);
    payout(&mut w, &u.pubkey(), 10 * E18).unwrap();
    assert_eq!(w.token_amount(&ata_of(&u.pubkey(), &USDC)), 10 * ONE_USDC);
}

#[test]
fn the_vault_is_named_once_and_only_over_a_six_decimal_mint() {
    let mut w = setup();
    let s = w.store();
    assert_eq!((s.usdc_mint, s.vault), (USDC, w.ids.vault));
    assert_eq!(s.deposit_cap, 0, "deposits start closed");
    let vault = w.svm.get_account(&w.ids.vault).unwrap();
    assert_eq!(vault.owner, TOKEN_PROGRAM);
    assert_eq!(&vault.data[0..32], USDC.as_ref());
    assert_eq!(&vault.data[32..64], w.ids.store.as_ref(), "the store PDA is the vault's authority");
    // a second init_vault cannot re-aim it
    let ix = Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::InitVault {}.data(),
        spawn_gateway::accounts::InitVault {
            admin: w.admin.pubkey(),
            store: w.ids.store,
            usdc_mint: USDC,
            vault: w.ids.vault,
            system_program: SYSTEM,
            token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None),
    );
    assert!(w.send(&[ix], &[]).is_err());
}
