//! LiteSVM tests of the v7.2 receive path, the user instructions and the
//! roles — in the SENTINEL world: the store is initialized with the test
//! sentinel endpoint (default pubkey), so the endpoint CPIs (register,
//! clear) are skipped and `lz_receive` can be driven directly with any hub
//! message. The dollar is Circle's REAL USDC mint account (mainnet fixture).
//!
//! What these tests prove: every hub→Solana op and what it does when it
//! cannot be settled on the spot (parking, claims), with NO lamports taken
//! from the `lz_receive` payer; a PAYOUT for ANY 32-byte recipient (v7.2: a
//! claim moved here names one its sender chose); the holder-fee pool's
//! arithmetic; the decimal bridge to the wei; authentication; roles and
//! pause.
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

    // a recipient with no user account at all (never the case for a
    // delivery the hub sends in answer to a buy — the buyer opened one —
    // but nothing may hang on that): the account is opened on the spot,
    // out of the tank, and the bag parked in it
    let stranger = w.new_user();
    let (exec_before, tank_before) = (w.lamports(&w.exec.pubkey()), w.lamports(&w.ids.tank));
    deliver(&mut w, TOK, &stranger.pubkey(), 10 * E18, 0).unwrap();
    let ua: UserAccount = w.read(&w.ids.user(&stranger.pubkey()));
    assert_eq!((ua.owner, ua.parked[0].amount_e18), (stranger.pubkey(), 10 * E18));
    assert_eq!(w.lamports(&w.exec.pubkey()), exec_before, "the executor paid for it");
    assert!(w.lamports(&w.ids.tank) < tank_before, "the tank did not");
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

/// v7.2: `moveClaim` on another chain names ANY 32-byte recipient here, and
/// the hub forwards it. A PAYOUT must settle for every one of them — a
/// failed PAYOUT is value in a message nobody can ever deliver.
#[test]
fn a_payout_settles_for_any_32_byte_recipient() {
    let mut w = setup();
    let tank = w.ids.tank;
    w.fund(&tank, 1_000_000_000);
    let vault = w.ids.vault;
    let someone = Keypair::new().pubkey(); // never seen here, no lamports, no account of any kind
    let other_user = w.ids.user(&Keypair::new().pubkey());
    let recipients: Vec<(&str, Pubkey)> = vec![
        ("a key never seen here", someone),
        ("an off-curve address (another program's PDA)", pda(&[b"treasury"], &ATA_PROGRAM)),
        ("the all-zero key (the system program)", Pubkey::default()),
        ("the all-ones key", Pubkey::new_from_array([0xff; 32])),
        ("the token program", TOKEN_PROGRAM),
        ("this program", w.ids.program),
        ("the store", w.ids.store),
        ("the vault (a token account)", vault),
        ("the tank", tank),
        ("the USDC mint", USDC),
        ("a sysvar", solana_sdk::sysvar::rent::id()),
        ("someone else's user account address", other_user),
        ("the executor that delivers it", w.exec.pubkey()),
    ];
    let (exec_before, tank_before) = (w.lamports(&w.exec.pubkey()), w.lamports(&tank));

    // an empty vault: every payout is booked as a claim, in a user account
    // opened on the spot out of the tank
    let mut total = 0u64;
    for (i, (what, to)) in recipients.iter().enumerate() {
        let units = (i as u64 + 1) * ONE_USDC;
        let meta = payout(&mut w, to, units as u128 * E12 + 7).unwrap_or_else(|e| panic!("PAYOUT to {what} failed: {e}"));
        if i == 0 {
            println!("CU payout (claim, opens the recipient's user account): {}", meta.compute_units_consumed);
        }
        let ua: UserAccount = w.read(&w.ids.user(to));
        assert_eq!((ua.owner, ua.usd_claim), (*to, units), "{what}");
        total += units;
    }
    assert_eq!(w.store().claims_total, total);
    assert_eq!(w.lamports(&w.exec.pubkey()), exec_before, "a payout cost the executor lamports");
    let rent = (tank_before - w.lamports(&tank)) / recipients.len() as u64;
    println!("rent of a user account opened by a payout, from the tank: {rent} lamports");
    assert_eq!(w.lamports(&tank), tank_before - rent * recipients.len() as u64);

    // a second payout to each adds to the same claim and opens nothing
    let tank_mid = w.lamports(&tank);
    for (_, to) in &recipients {
        payout(&mut w, to, ONE_USDC as u128 * E12).unwrap();
    }
    assert_eq!(w.lamports(&tank), tank_mid);
    assert_eq!(w.store().claims_total, total + recipients.len() as u64 * ONE_USDC);

    // a liquid vault changes nothing for a recipient with no USDC account…
    w.set_token_amount(&vault, 1_000 * ONE_USDC);
    payout(&mut w, &someone, 5 * E18).unwrap();
    let ua: UserAccount = w.read(&w.ids.user(&someone));
    assert_eq!(ua.usd_claim, 7 * ONE_USDC);
    assert_eq!(w.token_amount(&vault), 1_000 * ONE_USDC);
    // …and pays one who has it, without opening anything for them
    let holder = Keypair::new().pubkey();
    w.give_usdc(&holder, 0);
    payout(&mut w, &holder, 5 * E18).unwrap();
    assert_eq!(w.token_amount(&ata_of(&holder, &USDC)), 5 * ONE_USDC);
    assert!(!w.exists(&w.ids.user(&holder)));
    // a token account at the right address that is NOT theirs (its owner
    // field was re-assigned) is not paid into: a claim instead
    let moved = Keypair::new().pubkey();
    w.plant_token_account(ata_of(&moved, &USDC), &USDC, &holder, 0);
    payout(&mut w, &moved, 5 * E18).unwrap();
    assert_eq!(w.token_amount(&ata_of(&moved, &USDC)), 0);
    let ua: UserAccount = w.read(&w.ids.user(&moved));
    assert_eq!(ua.usd_claim, 5 * ONE_USDC);
}

/// What a claim booked for a stranger is worth: its owner redeems it like
/// any other, and their later actions find the account already there.
#[test]
fn a_claim_booked_for_a_stranger_is_theirs_to_redeem() {
    let mut w = setup();
    let tank = w.ids.tank;
    w.fund(&tank, 1_000_000_000);
    let u = Keypair::new();
    payout(&mut w, &u.pubkey(), 12 * E18).unwrap();
    // nobody but its owner
    let thief = w.new_user();
    let redeem = |w: &World, who: &Pubkey, account_of: &Pubkey| {
        Instruction::new_with_bytes(
            w.ids.program,
            &spawn_gateway::instruction::RedeemClaim { units: 12 * ONE_USDC }.data(),
            spawn_gateway::accounts::RedeemClaim {
                user: *who,
                store: w.ids.store,
                user_account: w.ids.user(account_of),
                usdc_mint: USDC,
                vault: w.ids.vault,
                user_usdc: ata_of(who, &USDC),
                token_program: TOKEN_PROGRAM,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
        )
    };
    let ix = redeem(&w, &thief.pubkey(), &u.pubkey());
    assert!(w.send(&[ix], &[&thief]).is_err());
    // the vault is funded again; the owner — who needs SOL of their own for
    // their token account, like anyone receiving USDC — takes it
    let vault = w.ids.vault;
    w.set_token_amount(&vault, 100 * ONE_USDC);
    w.fund(&u.pubkey(), 100_000_000);
    let ix = redeem(&w, &u.pubkey(), &u.pubkey());
    w.send(&[ix], &[&u]).unwrap();
    assert_eq!(w.token_amount(&ata_of(&u.pubkey(), &USDC)), 12 * ONE_USDC);
    assert_eq!(w.store().claims_total, 0);
    // and `open_user_account` on an account a payout opened is a no-op
    w.open_user_account(&u.pubkey());
    let ua: UserAccount = w.read(&w.ids.user(&u.pubkey()));
    assert_eq!((ua.owner, ua.usd_claim), (u.pubkey(), 0));
}

/// With a dry tank the rent of a stranger's account falls on whoever
/// executes the message: a volunteer may accept it (here), LayerZero's
/// executor will not (test_live_endpoint) — the packet then waits, it is
/// never lost. Anyone can also open the account first, for 0 lamports of
/// the executor's.
#[test]
fn a_dry_tank_never_strands_a_payout() {
    let mut w = setup();
    assert_eq!(w.lamports(&w.ids.tank), 0);
    let a = Keypair::new().pubkey();
    let exec_before = w.lamports(&w.exec.pubkey());
    payout(&mut w, &a, 3 * E18).unwrap();
    assert!(w.lamports(&w.exec.pubkey()) < exec_before, "the payer funded the account");
    let ua: UserAccount = w.read(&w.ids.user(&a));
    assert_eq!(ua.usd_claim, 3 * ONE_USDC);

    // the other way round: someone opens the account, the delivery is free
    let b = Keypair::new().pubkey();
    w.open_user_account(&b);
    let exec_before = w.lamports(&w.exec.pubkey());
    payout(&mut w, &b, 3 * E18).unwrap();
    assert_eq!(w.lamports(&w.exec.pubkey()), exec_before);

    // a pre-funded address (griefing, or a tip) does not block the opening
    let c = Keypair::new().pubkey();
    w.set_lamports(&w.ids.user(&c), 1_000_000);
    payout(&mut w, &c, 3 * E18).unwrap();
    let ua: UserAccount = w.read(&w.ids.user(&c));
    assert_eq!((ua.owner, ua.usd_claim), (c, 3 * ONE_USDC));
}

/// The envelope's last word (v7.2) is what the executor was asked to
/// deliver with the message: nothing on a reply, one `returnUnit` of
/// lamports on a message that may have to create an account here. The
/// delivery must bring it — exactly as the hub adapter requires of
/// deliveries from here — and what the message does not need goes to the
/// tank.
#[test]
fn what_a_message_brings_is_taken_and_what_it_does_not_need_goes_to_the_tank() {
    let mut w = setup();
    let u = user_with_accounts(&mut w);
    let vault = w.ids.vault;
    w.set_token_amount(&vault, 10 * ONE_USDC);
    let floor = w.svm.minimum_balance_for_rent_exemption(0);
    let tank = w.ids.tank;
    w.set_lamports(&tank, floor);
    let msg = SpawnMsg::Payout { to: WireAddr::from_pubkey(&u.pubkey()), usd_out: U256::from_u128(E18) };
    let (exec_before, tank_before) = (w.lamports(&w.exec.pubkey()), w.lamports(&tank));
    let bytes = w.wire_with_value(&msg, 3_000_000);
    let accounts = w.payout_accounts(&u.pubkey());
    deliver_raw(&mut w, hub_peer(), HUB_EID, bytes, accounts).unwrap();
    // this recipient has everything: the whole value is the tank's
    assert_eq!(exec_before - w.lamports(&w.exec.pubkey()), 3_000_000);
    assert_eq!(w.lamports(&tank) - tank_before, 3_000_000);
    assert_eq!(w.token_amount(&ata_of(&u.pubkey(), &USDC)), ONE_USDC);
    // a payer that cannot bring it is turned away; nothing moved
    let poor = Keypair::new();
    w.fund(&poor.pubkey(), 1_000_000);
    let bytes = w.wire_with_value(&msg, 3_000_000);
    let params = LzReceiveParams { src_eid: HUB_EID, sender: hub_peer(), nonce: 2, guid: [0u8; 32], message: bytes, extra_data: vec![] };
    let mut metas = spawn_gateway::accounts::LzReceive { payer: poor.pubkey(), store: w.ids.store, peer: w.ids.peer }
        .to_account_metas(None);
    metas.extend(w.payout_accounts(&u.pubkey()));
    let ix = Instruction::new_with_bytes(w.ids.program, &spawn_gateway::instruction::LzReceive { params }.data(), metas);
    assert!(w.send(&[ix], &[&poor]).is_err());
    assert_eq!(w.token_amount(&ata_of(&u.pubkey(), &USDC)), ONE_USDC);
}

/// WHO PAYS FOR WHAT A MESSAGE CREATES (v7.2, final): the lamports the
/// message brought, then the tank, then — only then — whoever executes it.
/// The cases a hub operator can produce by setting `returnUnit` for this
/// chain right, too high, too low, or not at all.
#[test]
fn an_account_is_funded_by_the_message_then_the_tank_then_the_caller() {
    let mut w = setup();
    let tank = w.ids.tank;
    let exec = w.exec.pubkey();
    let floor = w.svm.minimum_balance_for_rent_exemption(0);
    let rent_user = w.svm.minimum_balance_for_rent_exemption(UserAccount::SIZE);
    let rent_replica = w.svm.minimum_balance_for_rent_exemption(Replica::SIZE) + w.svm.minimum_balance_for_rent_exemption(82);
    let unit = w.hub_unit();
    assert!(unit > rent_replica && rent_replica > rent_user, "the unit is sized on the dearer of the two");
    assert_eq!(unit, 4_100_000, "at this cluster's rent (6,960 lamports a byte); 3,000,000 at mainnet's 5,080");
    let sync = |tag: u8| SpawnMsg::SyncToken { hub_token: WireAddr(token_id(tag)), name: "N".into(), symbol: "S".into() };
    let pay = |to: &Pubkey| SpawnMsg::Payout { to: WireAddr::from_pubkey(to), usd_out: U256::from_u128(E18) };
    // delivers `msg` naming `value`; returns (what the executor paid, what the tank gained or lost)
    let run = |w: &mut World, msg: &SpawnMsg, value: u64, accounts: Vec<AccountMeta>| -> (i128, i128) {
        let (e0, t0) = (w.lamports(&exec) as i128, w.lamports(&tank) as i128);
        let bytes = w.wire_with_value(msg, value);
        deliver_raw(w, hub_peer(), HUB_EID, bytes, accounts).unwrap_or_else(|e| panic!("{e}"));
        (e0 - w.lamports(&exec) as i128, w.lamports(&tank) as i128 - t0)
    };

    // ---- the unit as it should be, and a tank that holds its own rent
    // floor and not a lamport more: the message funds what it creates and
    // the tank is not needed
    w.set_lamports(&tank, floor);
    let accounts = w.sync_accounts(&token_id(1));
    let (paid, tank_delta) = run(&mut w, &sync(1), unit, accounts);
    let replica: Replica = w.read(&w.ids.replica(&token_id(1)));
    assert_eq!(replica.symbol, "S");
    assert_eq!(paid, unit as i128, "the delivery cost its executor what the packet bought, to the lamport");
    assert_eq!(tank_delta, (unit - rent_replica) as i128, "the rest is the tank's");

    // a moved claim for a stranger: the same unit covers the smaller rent
    let a = Keypair::new().pubkey();
    let accounts = w.payout_accounts(&a);
    let (paid, tank_delta) = run(&mut w, &pay(&a), unit, accounts);
    assert_eq!((paid, tank_delta), (unit as i128, (unit - rent_user) as i128));
    let ua: UserAccount = w.read(&w.ids.user(&a));
    assert_eq!((ua.owner, ua.usd_claim), (a, ONE_USDC));
    // a second SYNC of the same token creates nothing: all of it is the tank's
    let accounts = w.sync_accounts(&token_id(1));
    assert_eq!(run(&mut w, &sync(1), unit, accounts), (unit as i128, unit as i128));

    // ---- the unit set TOO LOW (here: a third of a replica's rent): the
    // tank makes up the difference for as long as it can…
    let low = rent_replica / 3;
    w.set_lamports(&tank, floor + rent_replica);
    let accounts = w.sync_accounts(&token_id(2));
    let (paid, tank_delta) = run(&mut w, &sync(2), low, accounts);
    assert_eq!(paid, low as i128, "the executor still pays no more than the packet bought");
    assert_eq!(tank_delta, low as i128 - rent_replica as i128, "the tank paid the shortfall");
    // …and when it cannot, the rent falls on whoever executes: a volunteer
    // here; LayerZero's executor declines (test_live_endpoint) and the
    // packet waits — it is never lost
    w.set_lamports(&tank, floor);
    let accounts = w.sync_accounts(&token_id(3));
    let (paid, _) = run(&mut w, &sync(3), low, accounts);
    assert_eq!(paid, (low + rent_replica) as i128, "what it named, and the rent on top");

    // ---- the unit NOT SET (0), as on an EVM label: the tank, as before
    w.set_lamports(&tank, floor + rent_user);
    let b = Keypair::new().pubkey();
    let accounts = w.payout_accounts(&b);
    assert_eq!(run(&mut w, &pay(&b), 0, accounts), (0, -(rent_user as i128)));

    // ---- a tank drained to nothing cannot take less than its own rent
    // floor: a small remainder then stays with whoever delivers, and
    // nothing fails for it
    w.set_lamports(&tank, 0);
    let c = Keypair::new().pubkey();
    let accounts = w.payout_accounts(&c);
    let (paid, tank_delta) = run(&mut w, &pay(&c), rent_user + 1_000, accounts);
    assert_eq!((paid, tank_delta), (rent_user as i128, 0));
    assert_eq!(w.lamports(&tank), 0);
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
    let forged = Envelope {
        src_sender: WireAddr([7; 32]),
        dst_addr: WireAddr(w.ids.store.to_bytes()),
        payload: msg.encode(),
        value: U256::from_u128(0),
    }
    .encode();
    assert!(deliver_raw(&mut w, hub_peer(), HUB_EID, forged, accounts.clone()).unwrap_err().contains("NotPeer"));
    // addressed to someone else
    let stray =
        Envelope { src_sender: WireAddr(hub_pad()), dst_addr: WireAddr([9; 32]), payload: msg.encode(), value: U256::from_u128(0) }
            .encode();
    assert!(deliver_raw(&mut w, hub_peer(), HUB_EID, stray, accounts.clone()).unwrap_err().contains("NotPeer"));
    // a recipient account that is not the wire's recipient
    let other = user_with_accounts(&mut w);
    let wrong = w.payout_accounts(&other.pubkey());
    assert!(deliver_raw(&mut w, hub_peer(), HUB_EID, good.clone(), wrong).unwrap_err().contains("RecipientMismatch"));
    // a spoke→hub op can never arrive at a spoke
    let buy = SpawnMsg::Buy {
        hub_token: WireAddr(token_id(1)),
        buyer: WireAddr([1; 32]),
        usd_in: U256::from_u128(1),
        min_tokens_out: U256::from_u128(1),
        deadline: U256::from_u128(1_794_635_400),
    };
    let bytes = w.wire(&buy);
    assert!(deliver_raw(&mut w, hub_peer(), HUB_EID, bytes, accounts.clone()).unwrap_err().contains("UnknownOp"));
    // …nor the two v7.2 ones
    for msg in [
        SpawnMsg::Open { hub_token: WireAddr(token_id(1)) },
        SpawnMsg::Move { from: WireAddr([1; 32]), to: WireAddr([2; 32]), amount: U256::from_u128(1), dst_chain: 1 },
    ] {
        let bytes = w.wire(&msg);
        assert!(deliver_raw(&mut w, hub_peer(), HUB_EID, bytes, accounts.clone()).unwrap_err().contains("UnknownOp"));
    }
    // the pre-v7.2 envelope (three fields) is not half-read: it is refused
    let old = {
        let mut e = good.clone();
        // drop the value word and re-aim the payload offset, as v7.1 wrote it
        e.drain(96..128);
        e[95] = 0x60;
        e
    };
    assert!(deliver_raw(&mut w, hub_peer(), HUB_EID, old, accounts.clone()).unwrap_err().contains("BadPayload"));
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
    assert!(!w.store().paused, "setup() unpaused the store it found paused");
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
    // (128 spawn legs since the last round of v7.2: a launch that reaches an L1)
    w.govern(fee(1, 1, 128), &operator).unwrap();
    assert!(w.govern(fee(1, 1, 129), &operator).unwrap_err().contains("OutOfBounds"));
    w.govern(fee(200_000_000_000_000, 1, 3), &operator).unwrap();
    // executor gas is bounded like the EVM adapters': what a slip would
    // over-charge goes to LayerZero's executor and cannot be given back
    let gas = |gas_to_hub: u128| {
        ix::SetFeeConfig {
            params: spawn_gateway::instructions::FeeConfigParams { gas_to_hub, return_unit: 1, trade_legs: 1, spawn_legs: 3 },
        }
        .data()
    };
    assert!(w.govern(gas(15_000_001), &operator).unwrap_err().contains("OutOfBounds"));
    assert!(w.govern(gas(0), &operator).unwrap_err().contains("OutOfBounds"));
    w.govern(gas(15_000_000), &operator).unwrap();
    w.govern(fee(200_000_000_000_000, 1, 3), &operator).unwrap();

    // how long an order lives: an hour from birth, the operator's between
    // two minutes and a day — there is always a deadline
    assert_eq!(w.store().order_ttl, 3_600);
    assert!(w.govern(ix::SetOrderTtl { ttl: 1_800 }.data(), &nobody).unwrap_err().contains("NotOperator"));
    assert!(w.govern(ix::SetOrderTtl { ttl: 1_800 }.data(), &guardian).unwrap_err().contains("NotOperator"));
    for bad in [0u32, 119, 86_401, u32::MAX] {
        assert!(w.govern(ix::SetOrderTtl { ttl: bad }.data(), &operator).unwrap_err().contains("BadOrderTtl"), "{bad}");
    }
    for ok in [120u32, 86_400, 1_800] {
        w.govern(ix::SetOrderTtl { ttl: ok }.data(), &operator).unwrap();
        assert_eq!(w.store().order_ttl, ok);
    }
    assert!(w.govern(ix::SetSponsored { on: true }.data(), &operator).unwrap_err().contains("NotAdmin"));
    assert!(w.govern(ix::SetGuardian { guardian: operator.pubkey() }.data(), &operator).unwrap_err().contains("NotAdmin"));
    assert!(w.govern(ix::TransferAdmin { nominee: operator.pubkey() }.data(), &operator).unwrap_err().contains("NotAdmin"));
    // v7.2's prices are the operator's too, each within its bound
    assert!(w.govern(ix::SetOpenLegs { legs: 2 }.data(), &nobody).unwrap_err().contains("NotOperator"));
    assert!(w.govern(ix::SetOpenLegs { legs: 2 }.data(), &guardian).unwrap_err().contains("NotOperator"));
    assert_eq!(w.store().open_legs, 1, "an open prepays one leg from birth");
    w.govern(ix::SetOpenLegs { legs: 2 }.data(), &operator).unwrap();
    assert_eq!(w.store().open_legs, 2);
    assert!(w.govern(ix::SetOpenLegs { legs: 9 }.data(), &operator).unwrap_err().contains("OutOfBounds"));
    let i = w.set_move_legs_ix(&nobody.pubkey(), 4, 3);
    assert!(w.send(&[i], &[&nobody]).unwrap_err().contains("NotOperator"));
    let i = w.set_move_legs_ix(&guardian.pubkey(), 4, 3);
    assert!(w.send(&[i], &[&guardian]).unwrap_err().contains("NotOperator"));
    let i = w.set_move_legs_ix(&operator.pubkey(), 4, 3);
    w.send(&[i], &[&operator]).unwrap();
    let route: spawn_gateway::state::MoveRoute = w.read(&w.ids.move_route(4));
    assert_eq!((route.dst_chain, route.legs), (4, 3));
    let i = w.set_move_legs_ix(&operator.pubkey(), 4, 4097);
    assert!(w.send(&[i], &[&operator]).unwrap_err().contains("OutOfBounds"));
    for bad in [0u32, 1] {
        let i = w.set_move_legs_ix(&operator.pubkey(), bad, 3);
        assert!(w.send(&[i], &[&operator]).unwrap_err().contains("BadDestination"));
    }
    let i = w.set_move_legs_ix(&operator.pubkey(), 4, 0); // closes the route
    w.send(&[i], &[&operator]).unwrap();
    let route: spawn_gateway::state::MoveRoute = w.read(&w.ids.move_route(4));
    assert_eq!(route.legs, 0);

    // a CCTP peer is a way out of the vault: the admin's, once per label
    let peer_ix = |who: &Pubkey, w: &World, label: u32, vault: [u8; 32]| {
        Instruction::new_with_bytes(
            w.ids.program,
            &ix::SetCctpPeer { label, domain: 6, vault }.data(),
            spawn_gateway::accounts::SetCctpPeer {
                admin: *who,
                store: w.ids.store,
                cctp_peer: w.ids.cctp_peer(label),
                system_program: SYSTEM,
            }
            .to_account_metas(None),
        )
    };
    let base_vault = pad32(&[0xba; 20]);
    let i = peer_ix(&operator.pubkey(), &w, 3, base_vault);
    assert!(w.send(&[i], &[&operator]).unwrap_err().contains("NotAdmin"));
    let i = peer_ix(&admin.pubkey(), &w, 1, base_vault);
    assert!(w.send(&[i], &[]).unwrap_err().contains("BadCctpPeer"), "this chain is not its own peer");
    let i = peer_ix(&admin.pubkey(), &w, 3, [0u8; 32]);
    assert!(w.send(&[i], &[]).unwrap_err().contains("BadCctpPeer"));
    let i = peer_ix(&admin.pubkey(), &w, 3, base_vault);
    w.send(&[i], &[]).unwrap();
    let peer: spawn_gateway::state::CctpPeer = w.read(&w.ids.cctp_peer(3));
    assert_eq!((peer.label, peer.domain, peer.vault), (3, 6, base_vault));
    let i = peer_ix(&admin.pubkey(), &w, 3, pad32(&[0xee; 20]));
    assert!(w.send(&[i], &[]).is_err(), "a peer is never re-aimed");
    let peer: spawn_gateway::state::CctpPeer = w.read(&w.ids.cctp_peer(3));
    assert_eq!(peer.vault, base_vault);

    // the executor's lookup table: named, replaced or cleared by the admin
    let table = Pubkey::new_unique();
    w.svm
        .set_account(
            table,
            solana_sdk::account::Account {
                lamports: 10_000_000,
                data: vec![0u8; 56],
                owner: solana_sdk::address_lookup_table::program::id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let table_ix = |who: &Pubkey, w: &World, alt: Option<Pubkey>| {
        Instruction::new_with_bytes(
            w.ids.program,
            &ix::SetReceiveTable {}.data(),
            spawn_gateway::accounts::SetReceiveTable {
                admin: *who,
                store: w.ids.store,
                lz_receive_types_accounts: w.ids.types_acc,
                alt,
            }
            .to_account_metas(None),
        )
    };
    let i = table_ix(&operator.pubkey(), &w, Some(table));
    assert!(w.send(&[i], &[&operator]).unwrap_err().contains("NotAdmin"));
    let i = table_ix(&admin.pubkey(), &w, Some(w.ids.vault));
    assert!(w.send(&[i], &[]).unwrap_err().contains("BadLookupTable"), "only a lookup table");
    let i = table_ix(&admin.pubkey(), &w, Some(table));
    w.send(&[i], &[]).unwrap();
    let t: spawn_gateway::state::LzReceiveTypesAccounts = w.read(&w.ids.types_acc);
    assert_eq!(t.alt, table);
    let i = table_ix(&admin.pubkey(), &w, None);
    w.send(&[i], &[]).unwrap();
    let t: spawn_gateway::state::LzReceiveTypesAccounts = w.read(&w.ids.types_acc);
    assert_eq!(t.alt, Pubkey::default());

    // the peer — who may forge payouts — is the admin's alone
    let hub_peer_ix = |who: &Pubkey, w: &World| {
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
    let i = hub_peer_ix(&operator.pubkey(), &w);
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
