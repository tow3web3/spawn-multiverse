//! Integration tests against the REAL LayerZero V2 stack of Solana MAINNET,
//! loaded locally into LiteSVM: the endpoint, ULN, executor and price feed
//! binaries, every DVN program of the default Solana→Base pathway, and
//! their live state accounts (fetched by `solana/tests/fetch-fixtures.sh`
//! — run it once before `cargo test`), plus Circle's real USDC mint.
//!
//! What this file PROVES without a single mainnet write:
//!   - `init_store` registers the OApp with the real endpoint; an admin
//!     hand-over moves the LayerZero delegate in the same instruction;
//!   - every send (spawn, buy, sell, claim, pull) is PAID BY THE USER: the
//!     real ULN, executor, price feed and DVNs quote it, the user's own
//!     lamports pay it, the tank is untouched; the packet carries our
//!     codec's bytes verbatim and the executor option carries the reply
//!     budget (`return_unit × legs` of hub-chain native) — priced by the
//!     real executor; `quote_send` returns exactly what a send then costs;
//!   - the entry checks refuse before any money moves;
//!   - the REAL EXECUTOR delivers hub messages through `lz_receive` and the
//!     real endpoint's `clear` with `value = 0` — what the immutable hub
//!     always sends — for all four inbound ops, using the account lists
//!     `lz_receive_types_v2` returns; and refuses a delivery that would
//!     spend its lamports (a SYNC with a dry tank), which then stays
//!     executable;
//!   - a send fits one v0 transaction with an address lookup table.
//!
//! What only a live chain can still prove: the deploy itself, the real
//! DVNs signing a packet both ways, and the executor's off-chain half.

mod common;

use {
    anchor_lang::{AnchorDeserialize, AnchorSerialize, InstructionData, ToAccountMetas},
    common::*,
    oapp::{
        common::AddressLocator,
        lz_receive_types_v2::{Instruction as LzInstruction, LzReceiveTypesV2Accounts, LzReceiveTypesV2Result},
        LzReceiveParams,
    },
    solana_sdk::{
        account::Account,
        address_lookup_table::{
            state::{AddressLookupTable, LookupTableMeta},
            AddressLookupTableAccount,
        },
        compute_budget::ComputeBudgetInstruction,
        instruction::{AccountMeta, Instruction},
        keccak,
        message::{v0, VersionedMessage},
        pubkey::Pubkey,
        signature::{Keypair, Signer},
        transaction::VersionedTransaction,
    },
    spawn_gateway::{
        msg_codec::{self, SpawnMsg, U256, WireAddr},
        state::{Replica, UserAccount},
    },
    std::borrow::Cow,
};

const GAS_TO_HUB: u128 = 4_600_000;
/// One reply leg: 0.0002 ETH (the hub's own initial `returnUnit`).
const RETURN_UNIT: u128 = 200_000_000_000_000;
const SPAWN_LEGS: u8 = 3;
const TOK: u8 = 0x8b;

/* ------------------------------- the world ---------------------------- */

fn live() -> World {
    let mut w = base_world();
    let programs: Vec<serde_json::Value> = serde_json::from_slice(&fixture("programs.json")).unwrap();
    for p in &programs {
        let id: Pubkey = p["id"].as_str().unwrap().parse().unwrap();
        w.svm.add_program(id, &fixture(p["file"].as_str().unwrap()));
    }
    let accounts = fixture_accounts();
    let (mut uln_settings, mut default_send_cfg) = (Vec::new(), Vec::new());
    for a in &accounts {
        match a.name.as_str() {
            "uln_settings" => uln_settings = a.data.clone(),
            "default_send_config" => default_send_cfg = a.data.clone(),
            "usdc_mint" => continue, // already loaded
            _ => {}
        }
        w.svm
            .set_account(
                a.pubkey,
                Account { lamports: a.lamports, data: a.data.clone(), owner: a.owner, executable: false, rent_epoch: 0 },
            )
            .unwrap();
    }

    // UlnSettings: disc(8) eid(4) endpoint(32) endpoint_program(32) bump(1)
    // admin(32), then Option<Treasury>{ admin: Option<Pubkey>,
    // native_receiver, fee_bps, lz: Option }
    let treasury = {
        let d = &uln_settings;
        let mut off = 8 + 4 + 32 + 32 + 1 + 32;
        if d[off] == 1 {
            off += 1;
            if d[off] == 1 {
                off += 33
            } else {
                off += 1
            }
            Some(Pubkey::new_from_array(d[off..off + 32].try_into().unwrap()))
        } else {
            None
        }
    };
    // SendConfig: disc(8) bump(1) UlnConfig{confirmations u64, counts u8×3,
    // required_dvns Vec<Pubkey>, optional_dvns Vec<Pubkey>} ExecutorConfig{
    // max_message_size u32, executor Pubkey}
    let (dvn_cfgs, executor_cfg) = {
        let d = &default_send_cfg;
        let mut off = 8 + 1 + 8 + 3;
        let read = |off: &mut usize| {
            let n = u32::from_le_bytes(d[*off..*off + 4].try_into().unwrap()) as usize;
            *off += 4;
            let v: Vec<Pubkey> =
                (0..n).map(|i| Pubkey::new_from_array(d[*off + i * 32..*off + (i + 1) * 32].try_into().unwrap())).collect();
            *off += n * 32;
            v
        };
        let mut all = read(&mut off);
        all.extend(read(&mut off));
        off += 4; // max_message_size
        (all, Pubkey::new_from_array(d[off..off + 32].try_into().unwrap()))
    };
    assert!(dvn_cfgs.len() >= 2, "the mainnet default pathway names several DVNs");
    let dvns: Vec<(Pubkey, Pubkey)> = dvn_cfgs
        .iter()
        .map(|cfg| (accounts.iter().find(|a| a.pubkey == *cfg).expect("dvn config fixture").owner, *cfg))
        .collect();

    let store = w.ids.store;
    let oapp_registry = pda(&[b"OApp", store.as_ref()], &ENDPOINT);
    let ep_event = pda(&[b"__event_authority"], &ENDPOINT);
    let nonce = pda(&[b"Nonce", store.as_ref(), &HUB_EID.to_be_bytes(), &hub_peer()], &ENDPOINT);

    // ---- init_store with the REAL endpoint: register_oapp CPI runs live
    let ix = init_store_ix(
        &w,
        ENDPOINT,
        vec![
            AccountMeta::new_readonly(ENDPOINT, false),
            AccountMeta::new(w.admin.pubkey(), true),
            AccountMeta::new_readonly(store, false),
            AccountMeta::new(oapp_registry, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(ep_event, false),
            AccountMeta::new_readonly(ENDPOINT, false),
        ],
    );
    w.send(&[ix], &[]).expect("init_store + register_oapp against the real mainnet endpoint");
    wire_store(&mut w);

    // ---- the delegate's wiring dance, straight against the real endpoint
    let slc = pda(&[b"SendLibraryConfig", store.as_ref(), &HUB_EID.to_be_bytes()], &ENDPOINT);
    let rlc = pda(&[b"ReceiveLibraryConfig", store.as_ref(), &HUB_EID.to_be_bytes()], &ENDPOINT);
    let pending = pda(&[b"PendingNonce", store.as_ref(), &HUB_EID.to_be_bytes(), &hub_peer()], &ENDPOINT);
    for (name, extra, tail) in [
        ("init_send_library", vec![AccountMeta::new(slc, false)], vec![]),
        ("init_receive_library", vec![AccountMeta::new(rlc, false)], vec![]),
        ("init_nonce", vec![AccountMeta::new(nonce, false), AccountMeta::new(pending, false)], hub_peer().to_vec()),
    ] {
        let mut data = anchor_sighash(name).to_vec();
        data.extend_from_slice(&store.to_bytes());
        data.extend_from_slice(&HUB_EID.to_le_bytes());
        data.extend_from_slice(&tail);
        let mut metas = vec![AccountMeta::new(w.admin.pubkey(), true), AccountMeta::new_readonly(oapp_registry, false)];
        metas.extend(extra);
        metas.push(AccountMeta::new_readonly(SYSTEM, false));
        w.send(&[Instruction::new_with_bytes(ENDPOINT, &data, metas)], &[]).unwrap_or_else(|e| panic!("{name}: {e}"));
    }

    // ---- the operator's settings: mainnet-shaped
    w.set_fee_config(GAS_TO_HUB, RETURN_UNIT, 1, SPAWN_LEGS);
    w.set_deposit_cap(25_000 * ONE_USDC);
    w.lz = Some(Lz { nonce, oapp_registry, dvns, executor_cfg, treasury });
    w
}

/// The endpoint-send account list in the exact order send_to_hub.rs
/// documents, with `payer` at index 13 — for the pathway's default DVNs.
fn send_list(w: &World, payer: &Pubkey) -> Vec<AccountMeta> {
    let dvns = w.lz.as_ref().unwrap().dvns.clone();
    send_list_with(w, payer, &dvns)
}

/// …or for a DVN set of our own: (program, config account), in the order
/// the OApp's send config names them (required first, then optional).
fn send_list_with(w: &World, payer: &Pubkey, dvns: &[(Pubkey, Pubkey)]) -> Vec<AccountMeta> {
    let lz = w.lz.as_ref().unwrap();
    let store = w.ids.store;
    let eid = HUB_EID.to_be_bytes();
    let msglib = pda(&[b"MessageLib"], &ULN);
    let price_feed = pda(&[b"PriceFeed"], &PRICEFEED);
    let mut v = vec![
        AccountMeta::new_readonly(ENDPOINT, false),
        AccountMeta::new_readonly(store, false),
        AccountMeta::new_readonly(ULN, false),
        AccountMeta::new_readonly(pda(&[b"SendLibraryConfig", store.as_ref(), &eid], &ENDPOINT), false),
        AccountMeta::new_readonly(pda(&[b"SendLibraryConfig", &eid], &ENDPOINT), false),
        AccountMeta::new_readonly(pda(&[b"MessageLib", msglib.as_ref()], &ENDPOINT), false), // MUST stay read-only
        AccountMeta::new_readonly(pda(&[b"Endpoint"], &ENDPOINT), false),
        AccountMeta::new(lz.nonce, false),
        AccountMeta::new_readonly(pda(&[b"__event_authority"], &ENDPOINT), false),
        AccountMeta::new_readonly(ENDPOINT, false),
        AccountMeta::new_readonly(msglib, false), // uln settings (ULN_SEED == MessageLib)
        AccountMeta::new_readonly(pda(&[b"SendConfig", &eid, store.as_ref()], &ULN), false),
        AccountMeta::new_readonly(pda(&[b"SendConfig", &eid], &ULN), false),
        AccountMeta::new(*payer, true),
        match lz.treasury {
            Some(t) => AccountMeta::new(t, false),
            None => AccountMeta::new_readonly(ULN, false), // Anchor's None placeholder
        },
        AccountMeta::new_readonly(SYSTEM, false),
        AccountMeta::new_readonly(pda(&[b"__event_authority"], &ULN), false),
        AccountMeta::new_readonly(ULN, false),
        // executor quad
        AccountMeta::new_readonly(EXECUTOR, false),
        AccountMeta::new(lz.executor_cfg, false),
        AccountMeta::new_readonly(PRICEFEED, false),
        AccountMeta::new_readonly(price_feed, false),
    ];
    for (program, cfg) in dvns {
        v.push(AccountMeta::new_readonly(*program, false));
        v.push(AccountMeta::new(*cfg, false));
        v.push(AccountMeta::new_readonly(PRICEFEED, false));
        v.push(AccountMeta::new_readonly(price_feed, false));
    }
    v
}

fn outbound_nonce(w: &World) -> u64 {
    let data = w.svm.get_account(&w.lz.as_ref().unwrap().nonce).unwrap().data;
    u64::from_le_bytes(data[9..17].try_into().unwrap())
}

/// The `SentToHub` event of a send: (op, native_fee, legs, sponsored).
fn sent_event(meta: &litesvm::types::TransactionMetadata) -> (u8, u64, u8, bool) {
    use base64::Engine;
    let disc = &solana_sdk::hash::hash(b"event:SentToHub").to_bytes()[..8];
    for l in &meta.logs {
        if let Some(b64) = l.strip_prefix("Program data: ") {
            let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(b64) else { continue };
            if raw.len() >= 51 && &raw[..8] == disc {
                return (raw[8], u64::from_le_bytes(raw[41..49].try_into().unwrap()), raw[49], raw[50] == 1);
            }
        }
    }
    panic!("no SentToHub event in:\n{}", meta.logs.join("\n"));
}

/// The emitted packet must carry `bytes` verbatim. The endpoint's
/// PacketSentEvent rides an event-CPI (an inner instruction), so scan every
/// inner instruction's data.
fn packet_carries(meta: &litesvm::types::TransactionMetadata, bytes: &[u8]) -> bool {
    meta.inner_instructions.iter().flatten().any(|ix| ix.instruction.data.windows(bytes.len()).any(|w| w == bytes))
}

fn enveloped(w: &World, msg: &SpawnMsg) -> Vec<u8> {
    msg_codec::Envelope {
        src_sender: WireAddr(w.ids.store.to_bytes()),
        dst_addr: WireAddr(hub_pad()),
        payload: msg.encode(),
    }
    .encode()
}

/* --------------------------- send instructions ------------------------ */

fn spawn_ix(w: &World, user: &Pubkey, name: &str, symbol: &str, meta_uri: &str, dev_buy: u64, fee_mode: u8, max_fee: u64) -> Instruction {
    let mut metas = spawn_gateway::accounts::SpawnToken {
        user: *user,
        store: w.ids.store,
        peer: w.ids.peer,
        gas_tank: w.ids.tank,
        user_account: w.ids.user(user),
        usdc_mint: USDC,
        user_usdc: ata_of(user, &USDC),
        vault: w.ids.vault,
        token_program: TOKEN_PROGRAM,
        associated_token_program: ATA_PROGRAM,
        system_program: SYSTEM,
    }
    .to_account_metas(None);
    metas.extend(send_list(w, user));
    Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::SpawnToken {
            params: spawn_gateway::instructions::SpawnTokenParams {
                name: name.into(),
                symbol: symbol.into(),
                meta_uri: meta_uri.into(),
                dev_buy_usdc: dev_buy,
                fee_mode,
                max_native_fee: max_fee,
            },
        }
        .data(),
        metas,
    )
}

fn buy_accounts(w: &World, user: &Pubkey, t: &[u8; 32]) -> Vec<AccountMeta> {
    let mint = w.ids.mint(t);
    spawn_gateway::accounts::BuyToken {
        user: *user,
        store: w.ids.store,
        peer: w.ids.peer,
        gas_tank: w.ids.tank,
        replica: w.ids.replica(t),
        mint,
        user_token: ata_of(user, &mint),
        user_account: w.ids.user(user),
        usdc_mint: USDC,
        user_usdc: ata_of(user, &USDC),
        vault: w.ids.vault,
        token_program: TOKEN_PROGRAM,
        associated_token_program: ATA_PROGRAM,
        system_program: SYSTEM,
    }
    .to_account_metas(None)
}

fn buy_ix(w: &World, user: &Pubkey, tag: u8, usdc_in: u64, max_fee: u64) -> Instruction {
    let t = token_id(tag);
    let mut metas = buy_accounts(w, user, &t);
    metas.extend(send_list(w, user));
    Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::BuyToken {
            params: spawn_gateway::instructions::BuyTokenParams { hub_token: t, usdc_in, max_native_fee: max_fee },
        }
        .data(),
        metas,
    )
}

fn sell_ix(w: &World, user: &Pubkey, tag: u8, amount: u64) -> Instruction {
    let t = token_id(tag);
    let mint = w.ids.mint(&t);
    let mut metas = spawn_gateway::accounts::SellToken {
        user: *user,
        store: w.ids.store,
        peer: w.ids.peer,
        gas_tank: w.ids.tank,
        replica: w.ids.replica(&t),
        mint,
        user_token: ata_of(user, &mint),
        user_account: w.ids.user(user),
        usdc_mint: USDC,
        user_usdc: ata_of(user, &USDC),
        token_program: TOKEN_PROGRAM,
        associated_token_program: ATA_PROGRAM,
        system_program: SYSTEM,
    }
    .to_account_metas(None);
    metas.extend(send_list(w, user));
    Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::SellToken {
            params: spawn_gateway::instructions::SellTokenParams { hub_token: t, amount, max_native_fee: 0 },
        }
        .data(),
        metas,
    )
}

fn claim_ix(w: &World, user: &Pubkey, tag: u8) -> Instruction {
    let t = token_id(tag);
    let mut metas = spawn_gateway::accounts::ClaimFees {
        user: *user,
        store: w.ids.store,
        peer: w.ids.peer,
        gas_tank: w.ids.tank,
        replica: w.ids.replica(&t),
        user_account: w.ids.user(user),
        usdc_mint: USDC,
        user_usdc: ata_of(user, &USDC),
        token_program: TOKEN_PROGRAM,
        associated_token_program: ATA_PROGRAM,
        system_program: SYSTEM,
    }
    .to_account_metas(None);
    metas.extend(send_list(w, user));
    Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::ClaimFees {
            params: spawn_gateway::instructions::TokenMsgParams { hub_token: t, max_native_fee: 0 },
        }
        .data(),
        metas,
    )
}

fn pull_ix(w: &World, user: &Pubkey, tag: u8) -> Instruction {
    let t = token_id(tag);
    let mut metas = spawn_gateway::accounts::PullFees {
        user: *user,
        store: w.ids.store,
        peer: w.ids.peer,
        gas_tank: w.ids.tank,
        replica: w.ids.replica(&t),
        system_program: SYSTEM,
    }
    .to_account_metas(None);
    metas.extend(send_list(w, user));
    Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::PullFees {
            params: spawn_gateway::instructions::TokenMsgParams { hub_token: t, max_native_fee: 0 },
        }
        .data(),
        metas,
    )
}

fn quote(w: &mut World, op: u8, name: &str, symbol: &str, meta_uri: &str, with_dev_buy: bool) -> u64 {
    let mut metas =
        spawn_gateway::accounts::QuoteSend { store: w.ids.store, peer: w.ids.peer }.to_account_metas(None);
    // the same list as a send; nothing in it needs to sign for a quote
    let admin = w.admin.pubkey();
    metas.extend(send_list(w, &admin));
    let ix = Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::QuoteSend {
            params: spawn_gateway::instructions::QuoteSendParams {
                op,
                name: name.into(),
                symbol: symbol.into(),
                meta_uri: meta_uri.into(),
                with_dev_buy,
            },
        }
        .data(),
        metas,
    );
    let ret = w.simulate(ix).expect("quote_send");
    u64::from_le_bytes(ret[..8].try_into().unwrap())
}

/* ------------------------ the hub's side of the wire ------------------ */

/// Plants a VERIFIED inbound packet in the real endpoint's state — what the
/// DVNs' verification and the ULN's commit leave behind: the payload hash
/// account, and an inbound nonce that covers it.
fn plant_verified(w: &mut World, nonce: u64, guid: [u8; 32], message: &[u8]) {
    let store = w.ids.store;
    let (ph, bump) = Pubkey::find_program_address(
        &[b"PayloadHash", store.as_ref(), &HUB_EID.to_be_bytes(), &hub_peer(), &nonce.to_be_bytes()],
        &ENDPOINT,
    );
    let mut data = account_disc("PayloadHash").to_vec();
    data.extend_from_slice(&keccak::hashv(&[&guid, message]).to_bytes());
    data.push(bump);
    w.svm
        .set_account(ph, Account { lamports: 1_200_000, data, owner: ENDPOINT, executable: false, rent_epoch: 0 })
        .unwrap();
    let nonce_acc = w.lz.as_ref().unwrap().nonce;
    let mut acc = w.svm.get_account(&nonce_acc).unwrap();
    let inbound = u64::from_le_bytes(acc.data[17..25].try_into().unwrap());
    if inbound < nonce {
        acc.data[17..25].copy_from_slice(&nonce.to_le_bytes());
        w.svm.set_account(nonce_acc, acc).unwrap();
    }
}

fn payload_hash_exists(w: &World, nonce: u64) -> bool {
    let ph = pda(
        &[b"PayloadHash", w.ids.store.as_ref(), &HUB_EID.to_be_bytes(), &hub_peer(), &nonce.to_be_bytes()],
        &ENDPOINT,
    );
    w.lamports(&ph) > 0
}

/// Lets the test's `exec` key act as a LayerZero executor: swaps it into
/// the real ExecutorConfig's `executors` list (the only edit made to
/// mainnet state — the executor program itself is the real binary).
fn enlist_executor(w: &mut World) {
    let cfg = w.lz.as_ref().unwrap().executor_cfg;
    let mut acc = w.svm.get_account(&cfg).unwrap();
    let d = &mut acc.data;
    // disc(8) bump(1) owner(32) acl{allow Vec, deny Vec} admins Vec executors Vec
    let mut off = 8 + 1 + 32;
    for _ in 0..3 {
        let n = u32::from_le_bytes(d[off..off + 4].try_into().unwrap()) as usize;
        off += 4 + n * 32;
    }
    let n = u32::from_le_bytes(d[off..off + 4].try_into().unwrap()) as usize;
    assert!(n >= 1, "the mainnet executor config lists no executor");
    d[off + 4..off + 36].copy_from_slice(w.exec.pubkey().as_ref());
    w.svm.set_account(cfg, acc).unwrap();
}

/// Asks the program — as LayerZero's executor does, off-chain — which
/// accounts `lz_receive` needs for this packet, and resolves them.
fn resolve_lz_receive(w: &mut World, params: &LzReceiveParams) -> Vec<AccountMeta> {
    // 1. the versioning handshake
    let ix = Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::LzReceiveTypesInfo { params: params.clone() }.data(),
        spawn_gateway::accounts::LzReceiveTypesInfo { store: w.ids.store, lz_receive_types_accounts: w.ids.types_acc }
            .to_account_metas(None),
    );
    let ret = w.simulate(ix).expect("lz_receive_types_info");
    let (version, info) = <(u8, LzReceiveTypesV2Accounts)>::deserialize(&mut &ret[..]).unwrap();
    assert_eq!(version, 2);
    assert_eq!(info.accounts, vec![w.ids.store]);
    // 2. the account list
    let ix = Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::LzReceiveTypesV2 { params: params.clone() }.data(),
        info.accounts.iter().map(|k| AccountMeta::new_readonly(*k, false)).collect(),
    );
    let ret = w.simulate(ix).expect("lz_receive_types_v2");
    let result = LzReceiveTypesV2Result::deserialize(&mut &ret[..]).unwrap();
    assert!(result.alts.is_empty());
    assert_eq!(result.instructions.len(), 1);
    let LzInstruction::LzReceive { accounts } = &result.instructions[0] else { panic!("not an lz_receive") };
    accounts
        .iter()
        .map(|a| match &a.pubkey {
            AddressLocator::Payer => AccountMeta::new(w.exec.pubkey(), true),
            AddressLocator::Address(k) if a.is_writable => AccountMeta::new(*k, false),
            AddressLocator::Address(k) => AccountMeta::new_readonly(*k, false),
            _ => panic!("unexpected locator"),
        })
        .collect()
}

/// Borsh of the executor's `ExecuteParams { receiver, lz_receive, value,
/// compute_units }`.
fn execute_params(receiver: &Pubkey, lz_receive: &LzReceiveParams, value: u64, compute_units: u64) -> Vec<u8> {
    let mut data = receiver.to_bytes().to_vec();
    lz_receive.serialize(&mut data).unwrap();
    data.extend_from_slice(&value.to_le_bytes());
    data.extend_from_slice(&compute_units.to_le_bytes());
    data
}

/// Delivers a hub message the way mainnet does: the REAL executor program's
/// `execute` → our `lz_receive` → the real endpoint's `clear`, with the
/// `value` the packet's options bought (the hub always buys 0).
fn execute(w: &mut World, nonce: u64, msg: &SpawnMsg, value: u64) -> TxResult {
    let message = w.wire(msg);
    let guid = keccak::hashv(&[b"guid", &nonce.to_be_bytes()]).to_bytes();
    if !payload_hash_exists(w, nonce) {
        plant_verified(w, nonce, guid, &message);
    }
    let params = LzReceiveParams { src_eid: HUB_EID, sender: hub_peer(), nonce, guid, message, extra_data: vec![] };
    let lz_accounts = resolve_lz_receive(w, &params);

    let mut data = anchor_sighash("execute").to_vec();
    data.extend_from_slice(&execute_params(&w.ids.store, &params, value, 400_000));
    let mut metas = vec![
        AccountMeta::new(w.exec.pubkey(), true),
        AccountMeta::new_readonly(w.lz.as_ref().unwrap().executor_cfg, false),
        AccountMeta::new_readonly(ENDPOINT, false),
        AccountMeta::new_readonly(pda(&[b"__event_authority"], &ENDPOINT), false),
        // #[event_cpi]
        AccountMeta::new_readonly(pda(&[b"__event_authority"], &EXECUTOR), false),
        AccountMeta::new_readonly(EXECUTOR, false),
        // remaining: the receiver program, then lz_receive's accounts
        AccountMeta::new_readonly(w.ids.program, false),
    ];
    metas.extend(lz_accounts);
    let exec = w.exec.insecure_clone();
    w.send(&[Instruction::new_with_bytes(EXECUTOR, &data, metas)], &[&exec])
}

fn sync_msg(tag: u8) -> SpawnMsg {
    SpawnMsg::SyncToken { hub_token: WireAddr(token_id(tag)), name: "CANARY".into(), symbol: "CANARY".into() }
}

/// A token that exists here, and a user who holds USDC.
fn world_with_token_and_user(usdc: u64) -> (World, Keypair) {
    let mut w = live();
    enlist_executor(&mut w);
    let tank = w.ids.tank;
    w.fund(&tank, 1_000_000_000);
    execute(&mut w, 1, &sync_msg(TOK), 0).expect("SYNC through the real executor");
    let u = w.new_user();
    w.give_usdc(&u.pubkey(), usdc);
    (w, u)
}

/* --------------------------------- tests ------------------------------ */

#[test]
fn registers_with_the_real_endpoint_and_a_new_admin_becomes_the_delegate() {
    let mut w = live();
    let registry = w.lz.as_ref().unwrap().oapp_registry;
    let acc = w.svm.get_account(&registry).expect("OAppRegistry created");
    assert_eq!(acc.owner, ENDPOINT);
    // OAppRegistry: disc(8) + delegate(32) + bump
    assert_eq!(&acc.data[8..40], w.admin.pubkey().as_ref(), "the admin is the LayerZero delegate");
    assert_eq!(outbound_nonce(&w), 0);

    // admin hand-over: the nominee accepts and is the delegate at once — the
    // old admin keeps no say over the DVN set
    let nominee = w.new_user();
    let admin = w.admin.insecure_clone();
    w.govern(spawn_gateway::instruction::TransferAdmin { nominee: nominee.pubkey() }.data(), &admin).unwrap();
    let mut metas =
        spawn_gateway::accounts::Govern { authority: nominee.pubkey(), store: w.ids.store }.to_account_metas(None);
    metas.extend([
        AccountMeta::new_readonly(ENDPOINT, false),
        AccountMeta::new_readonly(w.ids.store, false),
        AccountMeta::new(registry, false),
        AccountMeta::new_readonly(pda(&[b"__event_authority"], &ENDPOINT), false),
        AccountMeta::new_readonly(ENDPOINT, false),
    ]);
    let ix = Instruction::new_with_bytes(w.ids.program, &spawn_gateway::instruction::AcceptAdmin {}.data(), metas);
    w.send(&[ix], &[&nominee]).expect("accept_admin + set_delegate on the real endpoint");
    assert_eq!(w.store().admin, nominee.pubkey());
    let acc = w.svm.get_account(&registry).unwrap();
    assert_eq!(&acc.data[8..40], nominee.pubkey().as_ref(), "the delegate moved with the admin");
}

#[test]
fn users_pay_for_their_messages_and_for_the_replies() {
    let (mut w, u) = world_with_token_and_user(1_000 * ONE_USDC);
    let user = u.pubkey();
    let t = token_id(TOK);
    let tank_before = w.lamports(&w.ids.tank);

    // ---- BUY: USDC into the vault, OP_BUY out, the user pays the fee
    let quoted = quote(&mut w, msg_codec::OP_BUY, "", "", "", false);
    let ix = buy_ix(&w, &user, TOK, 250 * ONE_USDC, 0);
    let meta = w.send(&[ix], &[&u]).expect("buy against the real mainnet stack");
    println!("CU buy_token (first: creates the token account and the user account): {}", meta.compute_units_consumed);
    let (op, fee, legs, sponsored) = sent_event(&meta);
    assert_eq!((op, legs, sponsored), (msg_codec::OP_BUY, 1, false));
    assert_eq!(fee, quoted, "quote_send returns exactly what the send costs");
    println!("fee of a buy (1 reply leg of 0.0002 ETH): {} lamports", fee);
    assert_eq!(w.token_amount(&w.ids.vault), 250 * ONE_USDC);
    assert_eq!(w.token_amount(&ata_of(&user, &USDC)), 750 * ONE_USDC);
    assert_eq!(outbound_nonce(&w), 1);
    let expected = SpawnMsg::Buy { hub_token: WireAddr(t), buyer: WireAddr::from_pubkey(&user), usd_in: U256::from_spl_amount(250 * ONE_USDC) };
    assert!(packet_carries(&meta, &enveloped(&w, &expected)), "the packet embeds the enveloped BUY");
    // the executor option the packet rides on: gas for the hub + the reply budget
    assert!(packet_carries(&meta, &msg_codec::lz_receive_options(GAS_TO_HUB, RETURN_UNIT)));
    // the buyer's own accounts now exist — the DELIVER will need no rent
    assert!(w.exists(&ata_of(&user, &w.ids.mint(&t))));
    let ua: UserAccount = w.read(&w.ids.user(&user));
    assert_eq!(ua.owner, user);

    // a second buy creates nothing: the user's lamports drop by the fee, exactly
    let before = w.lamports(&user);
    let ix = buy_ix(&w, &user, TOK, ONE_USDC, 0);
    let meta = w.send(&[ix], &[&u]).unwrap();
    println!("CU buy_token: {}", meta.compute_units_consumed);
    let (_, fee2, _, _) = sent_event(&meta);
    assert_eq!(before - w.lamports(&user), fee2, "the user paid the LayerZero fee, to the lamport");

    // ---- SELL: the replicas burn, OP_SELL out (the bag: straight from the hub)
    execute(
        &mut w,
        2,
        &SpawnMsg::Deliver { hub_token: WireAddr(t), to: WireAddr::from_pubkey(&user), tokens: U256::from_u128(1_000_000 * E18), refund: U256::from_u128(0) },
        0,
    )
    .unwrap();
    let bag = ata_of(&user, &w.ids.mint(&t));
    assert_eq!(w.token_amount(&bag), 1_000_000 * ONE_TOKEN);
    let ix = sell_ix(&w, &user, TOK, 400_000 * ONE_TOKEN);
    let meta = w.send(&[ix], &[&u]).unwrap();
    println!("CU sell_token: {}", meta.compute_units_consumed);
    assert_eq!(w.token_amount(&bag), 600_000 * ONE_TOKEN);
    let expected = SpawnMsg::Sell { hub_token: WireAddr(t), seller: WireAddr::from_pubkey(&user), tokens_in: U256::from_spl_amount(400_000 * ONE_TOKEN) };
    assert!(packet_carries(&meta, &enveloped(&w, &expected)));

    // ---- CLAIM and PULL: pure messages
    let ix = claim_ix(&w, &user, TOK);
    let meta = w.send(&[ix], &[&u]).unwrap();
    println!("CU claim_fees: {}", meta.compute_units_consumed);
    let expected = SpawnMsg::Claim { hub_token: WireAddr(t), claimer: WireAddr::from_pubkey(&user) };
    assert!(packet_carries(&meta, &enveloped(&w, &expected)));
    let quoted = quote(&mut w, msg_codec::OP_PULL_FEES, "", "", "", false);
    let ix = pull_ix(&w, &user, TOK);
    let meta = w.send(&[ix], &[&u]).unwrap();
    println!("CU pull_fees: {}", meta.compute_units_consumed);
    assert_eq!(sent_event(&meta).1, quoted);
    let expected = SpawnMsg::PullFees { hub_token: WireAddr(t) };
    assert!(packet_carries(&meta, &enveloped(&w, &expected)), "op 5 on the wire");

    // ---- SPAWN with a dev buy: 3 SYNC legs + the DELIVER leg, all prepaid
    let (name, symbol, uri) = ("SOLANA BORN", "SOLB", "{\"image\":\"/img/00\"}");
    let quoted = quote(&mut w, msg_codec::OP_SPAWN, name, symbol, uri, true);
    let ix = spawn_ix(&w, &user, name, symbol, uri, 50 * ONE_USDC, 1, 0);
    let meta = w.send(&[ix], &[&u]).unwrap();
    println!("CU spawn_token (dev buy): {}", meta.compute_units_consumed);
    let (op, fee_spawn, legs, _) = sent_event(&meta);
    assert_eq!((op, legs), (msg_codec::OP_SPAWN, SPAWN_LEGS + 1));
    assert_eq!(fee_spawn, quoted);
    println!("fee of a spawn with a dev buy (4 reply legs): {} lamports", fee_spawn);
    assert!(fee_spawn > fee, "four reply legs cost more than one");
    assert!(packet_carries(&meta, &msg_codec::lz_receive_options(GAS_TO_HUB, RETURN_UNIT * 4)));
    let expected = SpawnMsg::Spawn {
        creator: WireAddr::from_pubkey(&user),
        name: name.into(),
        symbol: symbol.into(),
        meta_uri: uri.into(),
        dev_buy_usd: U256::from_spl_amount(50 * ONE_USDC),
        fee_mode: 1,
    };
    assert!(packet_carries(&meta, &enveloped(&w, &expected)));
    assert_eq!(w.token_amount(&w.ids.vault), 301 * ONE_USDC);
    assert_eq!(outbound_nonce(&w), 6);

    // nobody but the users paid: the tank is exactly where it was
    assert_eq!(w.lamports(&w.ids.tank), tank_before);

    // what the reply budget costs: the same buy with no reply leg
    w.set_fee_config(GAS_TO_HUB, 0, 1, SPAWN_LEGS);
    let bare = quote(&mut w, msg_codec::OP_BUY, "", "", "", false);
    println!("fee of a buy with NO reply budget: {} lamports (the budget costs {})", bare, fee - bare);
    assert!(bare < fee, "the real executor prices the forwarded value");
}

#[test]
fn a_sponsored_store_pays_from_the_tank_and_an_empty_tank_stops_it() {
    let (mut w, u) = world_with_token_and_user(100 * ONE_USDC);
    let admin = w.admin.insecure_clone();
    w.govern(spawn_gateway::instruction::SetSponsored { on: true }.data(), &admin).unwrap();
    // first buy creates the user's accounts; measure on the second
    let ix = buy_ix(&w, &u.pubkey(), TOK, ONE_USDC, 0);
    w.send(&[ix], &[&u]).unwrap();
    let (user_before, tank_before) = (w.lamports(&u.pubkey()), w.lamports(&w.ids.tank));
    let ix = buy_ix(&w, &u.pubkey(), TOK, ONE_USDC, 0);
    let meta = w.send(&[ix], &[&u]).unwrap();
    let (_, fee, _, sponsored) = sent_event(&meta);
    assert!(sponsored && fee > 0);
    assert_eq!(w.lamports(&u.pubkey()), user_before, "a sponsored user pays nothing");
    assert_eq!(tank_before - w.lamports(&w.ids.tank), fee);

    let tank = w.ids.tank;
    w.set_lamports(&tank, 900_000);
    let ix = buy_ix(&w, &u.pubkey(), TOK, ONE_USDC, 0);
    let err = w.send(&[ix], &[&u]).unwrap_err();
    assert!(err.contains("TankTooPoor"), "{err}");
}

#[test]
fn entry_checks_refuse_before_any_money_moves() {
    let (mut w, u) = world_with_token_and_user(1_000 * ONE_USDC);
    let user = u.pubkey();
    let vault = w.ids.vault;
    let refused = |w: &mut World, ix: Instruction, what: &str| {
        let err = w.send(&[ix], &[&u]).unwrap_err();
        assert!(err.contains(what), "expected {what}, got: {err}");
    };

    // what the hub would refuse or choke on
    let ix = spawn_ix(&w, &user, "X", "X", "", 0, 4, 0);
    refused(&mut w, ix, "BadFeeMode");
    let ix = spawn_ix(&w, &user, &"N".repeat(65), "X", "", 0, 0, 0);
    refused(&mut w, ix, "StringTooLong");
    let ix = spawn_ix(&w, &user, "X", &"S".repeat(17), "", 0, 0, 0);
    refused(&mut w, ix, "StringTooLong");
    // (a 1025-byte metaURI cannot even be sent: it does not fit a transaction)
    // an unknown token: its replica does not exist here
    let ix = buy_ix(&w, &user, 0x44, ONE_USDC, 0);
    refused(&mut w, ix, "AccountNotInitialized");
    let ix = buy_ix(&w, &user, TOK, 0, 0);
    refused(&mut w, ix, "ZeroAmount");
    // the caller's ceiling on the fee
    let ix = buy_ix(&w, &user, TOK, ONE_USDC, 1);
    refused(&mut w, ix, "InsufficientFee");
    // the deposit cap
    w.set_deposit_cap(10 * ONE_USDC);
    let ix = buy_ix(&w, &user, TOK, 11 * ONE_USDC, 0);
    refused(&mut w, ix, "DepositCap");
    let ix = spawn_ix(&w, &user, "X", "X", "", 11 * ONE_USDC, 0, 0);
    refused(&mut w, ix, "DepositCap");
    // a fee payer that is not the user
    let other = w.new_user();
    let t = token_id(TOK);
    let mut metas = buy_accounts(&w, &user, &t);
    metas.extend(send_list(&w, &other.pubkey()));
    let ix = Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::BuyToken {
            params: spawn_gateway::instructions::BuyTokenParams { hub_token: t, usdc_in: ONE_USDC, max_native_fee: 0 },
        }
        .data(),
        metas,
    );
    let err = w.send(&[ix], &[&u, &other]).unwrap_err();
    assert!(err.contains("BadFeePayer"), "{err}");

    // paused: no new exposure…
    let admin = w.admin.insecure_clone();
    w.govern(spawn_gateway::instruction::Pause {}.data(), &admin).unwrap();
    let ix = buy_ix(&w, &user, TOK, ONE_USDC, 0);
    refused(&mut w, ix, "Paused");
    let ix = spawn_ix(&w, &user, "X", "X", "", 0, 0, 0);
    refused(&mut w, ix, "Paused");
    assert_eq!(w.token_amount(&vault), 0, "nothing reached the vault");
    assert_eq!(w.token_amount(&ata_of(&user, &USDC)), 1_000 * ONE_USDC);
    assert_eq!(outbound_nonce(&w), 0, "nothing was sent");

    // …but every exit stays open: sell, claim, pull
    execute(
        &mut w,
        2,
        &SpawnMsg::Deliver { hub_token: WireAddr(t), to: WireAddr::from_pubkey(&user), tokens: U256::from_u128(10 * E18), refund: U256::from_u128(0) },
        0,
    )
    .unwrap_err(); // the user never opened a token account: nowhere to park yet
    w.open_user_account(&user);
    execute(
        &mut w,
        2,
        &SpawnMsg::Deliver { hub_token: WireAddr(t), to: WireAddr::from_pubkey(&user), tokens: U256::from_u128(10 * E18), refund: U256::from_u128(0) },
        0,
    )
    .expect("the same packet, executable again once there is somewhere to park");
    let mint = w.ids.mint(&t);
    let i = Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::ClaimParked { hub_token: t }.data(),
        spawn_gateway::accounts::ClaimParked {
            user,
            store: w.ids.store,
            user_account: w.ids.user(&user),
            replica: w.ids.replica(&t),
            mint,
            user_token: ata_of(&user, &mint),
            token_program: TOKEN_PROGRAM,
            associated_token_program: ATA_PROGRAM,
            system_program: SYSTEM,
        }
        .to_account_metas(None),
    );
    w.send(&[i], &[&u]).unwrap();
    for ix in [sell_ix(&w, &user, TOK, 4 * ONE_TOKEN), claim_ix(&w, &user, TOK), pull_ix(&w, &user, TOK)] {
        w.send(&[ix], &[&u]).expect("exits are never paused");
    }
    assert_eq!(outbound_nonce(&w), 3);
}

#[test]
fn the_real_executor_delivers_every_hub_message_with_zero_value() {
    let mut w = live();
    enlist_executor(&mut w);
    let tank = w.ids.tank;
    let t = token_id(TOK);
    let exec = w.exec.pubkey();

    // ---- SYNC with a DRY tank: lz_receive would have to spend the
    // executor's SOL on rent. The hub's options buy value = 0, so the real
    // executor refuses — and the packet stays verified, executable later.
    let err = execute(&mut w, 1, &sync_msg(TOK), 0).unwrap_err();
    assert!(err.contains("InsufficientBalance"), "expected the executor's own balance check, got: {err}");
    assert!(err.contains(&format!("Program {EXECUTOR} failed")), "the refusal must come from the executor program");
    assert!(payload_hash_exists(&w, 1), "the message was not consumed");
    assert!(!w.exists(&w.ids.replica(&t)));

    // ---- the tank is topped up (anyone can): the same packet goes through
    w.fund(&tank, 100_000_000);
    let before = w.lamports(&exec);
    let meta = execute(&mut w, 1, &sync_msg(TOK), 0).expect("SYNC, rent from the tank");
    println!("CU executor→lz_receive SYNC (real clear): {}", meta.compute_units_consumed);
    assert_eq!(w.lamports(&exec), before, "the executor's balance is untouched");
    let replica: Replica = w.read(&w.ids.replica(&t));
    assert_eq!(replica.name, "CANARY");
    assert!(!payload_hash_exists(&w, 1), "clear() consumed the packet");
    // replay: the endpoint has nothing left to clear
    assert!(execute_again(&mut w, 1, &sync_msg(TOK)).is_err());

    // ---- a user who bought here: their accounts exist (they paid for them)
    let u = w.new_user();
    let user = u.pubkey();
    w.give_usdc(&user, 300 * ONE_USDC);
    let ix = buy_ix(&w, &user, TOK, 260 * ONE_USDC, 0);
    w.send(&[ix], &[&u]).unwrap();

    // ---- DELIVER (a FAIR GENESIS-clamped buy: a bag + a $10 refund)
    let before = w.lamports(&exec);
    let meta = execute(
        &mut w,
        2,
        &SpawnMsg::Deliver {
            hub_token: WireAddr(t),
            to: WireAddr::from_pubkey(&user),
            tokens: U256::from_u128(30_451_115_339_459_940_893_081_251),
            refund: U256::from_u128(10 * E18),
        },
        0,
    )
    .expect("DELIVER through the real executor");
    println!("CU executor→lz_receive DELIVER + refund (real clear): {}", meta.compute_units_consumed);
    assert_eq!(w.token_amount(&ata_of(&user, &w.ids.mint(&t))), 30_451_115_339_459);
    assert_eq!(w.token_amount(&ata_of(&user, &USDC)), 50 * ONE_USDC);
    assert_eq!(w.token_amount(&w.ids.vault), 250 * ONE_USDC);

    // ---- PAYOUT (a sell)
    let meta = execute(&mut w, 3, &SpawnMsg::Payout { to: WireAddr::from_pubkey(&user), usd_out: U256::from_u128(87_997_407 * E12) }, 0)
        .expect("PAYOUT through the real executor");
    println!("CU executor→lz_receive PAYOUT (real clear): {}", meta.compute_units_consumed);
    assert_eq!(w.token_amount(&ata_of(&user, &USDC)), 50 * ONE_USDC + 87_997_407);

    // ---- FEE_DROP (the reply to a pull)
    let meta = execute(&mut w, 4, &SpawnMsg::FeeDrop { hub_token: WireAddr(t), amount: U256::from_u128(37_819_431 * E12) }, 0)
        .expect("FEE_DROP through the real executor");
    println!("CU executor→lz_receive FEE_DROP (real clear): {}", meta.compute_units_consumed);
    assert_eq!(w.store().pool_total, 37_819_431);

    // ---- out of order: nonce 6 before nonce 5 — delivery is unordered
    execute(&mut w, 6, &SpawnMsg::Payout { to: WireAddr::from_pubkey(&user), usd_out: U256::from_u128(E18) }, 0).unwrap();
    execute(&mut w, 5, &SpawnMsg::Payout { to: WireAddr::from_pubkey(&user), usd_out: U256::from_u128(E18) }, 0).unwrap();

    // across every delivery the executor spent nothing but its own fees
    assert_eq!(w.lamports(&exec), before, "a hub message cost the executor lamports");

    // ---- backing, as far as this chain can see it: the vault covers what
    // this chain owes on the spot
    let s = w.store();
    assert!(w.token_amount(&w.ids.vault) >= s.claims_total + s.pool_total);
}

/// Re-submits a packet whose payload hash is gone (no re-planting).
fn execute_again(w: &mut World, nonce: u64, msg: &SpawnMsg) -> TxResult {
    let message = w.wire(msg);
    let guid = keccak::hashv(&[b"guid", &nonce.to_be_bytes()]).to_bytes();
    let params = LzReceiveParams { src_eid: HUB_EID, sender: hub_peer(), nonce, guid, message, extra_data: vec![] };
    let lz_accounts = resolve_lz_receive(w, &params);
    let mut metas = spawn_gateway::accounts::LzReceive { payer: w.exec.pubkey(), store: w.ids.store, peer: w.ids.peer }
        .to_account_metas(None);
    metas.extend(lz_accounts.into_iter().skip(3));
    let ix = Instruction::new_with_bytes(w.ids.program, &spawn_gateway::instruction::LzReceive { params }.data(), metas);
    let exec = w.exec.insecure_clone();
    w.send(&[ix], &[&exec])
}

#[test]
fn a_dry_tank_sync_can_be_executed_by_anyone_willing_to_pay_the_rent() {
    let mut w = live();
    let t = token_id(TOK);
    // no tank, no executor: a user runs the verified packet themselves
    let msg = sync_msg(TOK);
    let message = w.wire(&msg);
    let guid = [7u8; 32];
    plant_verified(&mut w, 1, guid, &message);
    let params = LzReceiveParams { src_eid: HUB_EID, sender: hub_peer(), nonce: 1, guid, message, extra_data: vec![] };
    let u = w.new_user();
    let mut accounts = resolve_lz_receive(&mut w, &params);
    accounts[0] = AccountMeta::new(u.pubkey(), true); // the payer is the user
    let before = w.lamports(&u.pubkey());
    let ix = Instruction::new_with_bytes(w.ids.program, &spawn_gateway::instruction::LzReceive { params }.data(), accounts);
    w.send(&[ix], &[&u]).expect("permissionless execution of a verified packet");
    let replica: Replica = w.read(&w.ids.replica(&t));
    assert_eq!(replica.symbol, "CANARY");
    assert!(before - w.lamports(&u.pubkey()) > 3_000_000, "the user funded the replica's rent");
}

#[test]
fn a_send_fits_one_v0_transaction_with_a_lookup_table() {
    let (mut w, u) = world_with_token_and_user(100 * ONE_USDC);
    let user = u.pubkey();
    let ix = buy_ix(&w, &user, TOK, 5 * ONE_USDC, 0);
    let budget = ComputeBudgetInstruction::set_compute_unit_limit(600_000);

    // a legacy transaction cannot carry it
    let legacy = solana_sdk::message::Message::new(&[budget.clone(), ix.clone()], Some(&user));
    let legacy_len = 1 + 64 + legacy.serialize().len();
    println!("buy_token as a legacy transaction: {} bytes (limit 1232), {} accounts", legacy_len, legacy.account_keys.len());
    assert!(legacy_len > 1232, "if this fits, the lookup table is no longer needed");

    // the static part — everything that is not this user's — goes in a table
    let static_keys: Vec<Pubkey> = ix
        .accounts
        .iter()
        .map(|m| m.pubkey)
        .filter(|k| {
            *k != user
                && *k != ata_of(&user, &USDC)
                && *k != ata_of(&user, &w.ids.mint(&token_id(TOK)))
                && *k != w.ids.user(&user)
        })
        .fold(Vec::new(), |mut v, k| {
            if !v.contains(&k) {
                v.push(k)
            }
            v
        });
    let table = Pubkey::new_unique();
    let state = AddressLookupTable {
        meta: LookupTableMeta { deactivation_slot: u64::MAX, last_extended_slot: 0, last_extended_slot_start_index: 0, authority: None, _padding: 0 },
        addresses: Cow::Owned(static_keys.clone()),
    };
    w.svm
        .set_account(
            table,
            Account {
                lamports: 10_000_000,
                data: state.serialize_for_tests().unwrap(),
                owner: solana_sdk::address_lookup_table::program::id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    w.svm.warp_to_slot(100);

    let blockhash = w.svm.latest_blockhash();
    let msg = v0::Message::try_compile(
        &user,
        &[budget, ix],
        &[AddressLookupTableAccount { key: table, addresses: static_keys }],
        blockhash,
    )
    .unwrap();
    let tx = VersionedTransaction::try_new(VersionedMessage::V0(msg), &[&u]).unwrap();
    let len = 1 + 64 + tx.message.serialize().len();
    println!("buy_token as a v0 transaction with a lookup table: {} bytes", len);
    assert!(len <= 1232, "a buy must fit one transaction: {len} bytes");
    let meta = w.svm.send_transaction(tx).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n"))).expect("the v0 buy");
    println!("CU buy_token (v0, first): {}", meta.compute_units_consumed);
    assert_eq!(w.token_amount(&w.ids.vault), 5 * ONE_USDC);
}

/* ------------------------- our own verifier set ----------------------- */

/// The DVN config account of one of OUR verifiers (fixture label), and the
/// program that owns it.
fn our_dvn(name: &str) -> (Pubkey, Pubkey) {
    let a = fixture_accounts()
        .into_iter()
        .find(|a| a.dvn.as_deref().map(|d| d.ends_with(&format!("|{name}"))).unwrap_or(false))
        .unwrap_or_else(|| panic!("no fixture for DVN {name}"));
    (a.owner, a.pubkey)
}

fn borsh_uln_config(confirmations: u64, required: &[Pubkey], optional: &[Pubkey], threshold: u8) -> Vec<u8> {
    let mut d = confirmations.to_le_bytes().to_vec();
    d.extend_from_slice(&[required.len() as u8, optional.len() as u8, threshold]);
    for list in [required, optional] {
        d.extend_from_slice(&(list.len() as u32).to_le_bytes());
        for k in list {
            d.extend_from_slice(k.as_ref());
        }
    }
    d
}

/// The EVM side runs its own verifier set — LayerZero Labs + Google
/// required, 1 of Horizen / Twinstake optional (contracts/config/
/// profiles.js). Both ends of a pathway must name the SAME set, so the
/// Solana OApp must be able to set it too. The delegate (the admin) does it
/// straight on the real endpoint and ULN; the send then pays those four
/// verifiers instead of the pathway's default set.
#[test]
fn the_delegate_sets_our_own_verifier_set_and_sends_ride_it() {
    let (mut w, u) = world_with_token_and_user(100 * ONE_USDC);
    let user = u.pubkey();
    let store = w.ids.store;
    let eid = HUB_EID.to_be_bytes();
    let msglib = pda(&[b"MessageLib"], &ULN);
    let msglib_info = pda(&[b"MessageLib", msglib.as_ref()], &ENDPOINT);
    let send_cfg = pda(&[b"SendConfig", &eid, store.as_ref()], &ULN);
    let recv_cfg = pda(&[b"ReceiveConfig", &eid, store.as_ref()], &ULN);
    let registry = w.lz.as_ref().unwrap().oapp_registry;

    // what the default set costs
    let ix = buy_ix(&w, &user, TOK, ONE_USDC, 0);
    let default_fee = sent_event(&w.send(&[ix], &[&u]).unwrap()).1;

    // sorted, as the ULN demands
    let mut required = vec![our_dvn("LayerZero Labs"), our_dvn("Google")];
    let mut optional = vec![our_dvn("Horizen"), our_dvn("Twinstake")];
    required.sort_by_key(|d| d.1);
    optional.sort_by_key(|d| d.1);
    let keys = |v: &[(Pubkey, Pubkey)]| v.iter().map(|d| d.1).collect::<Vec<_>>();

    let endpoint_head = |signer: &Pubkey| {
        vec![
            AccountMeta::new_readonly(*signer, true),
            AccountMeta::new_readonly(registry, false),
            AccountMeta::new_readonly(msglib_info, false),
            AccountMeta::new_readonly(msglib, false),
            AccountMeta::new_readonly(ULN, false),
        ]
    };
    // 1. init_config: the OApp's own send/receive config accounts on the ULN
    let mut data = anchor_sighash("init_config").to_vec();
    data.extend_from_slice(store.as_ref());
    data.extend_from_slice(&HUB_EID.to_le_bytes());
    let mut metas = endpoint_head(&w.admin.pubkey());
    metas.extend([
        AccountMeta::new(w.admin.pubkey(), true),
        AccountMeta::new_readonly(msglib, false),
        AccountMeta::new(send_cfg, false),
        AccountMeta::new(recv_cfg, false),
        AccountMeta::new_readonly(SYSTEM, false),
    ]);
    w.send(&[Instruction::new_with_bytes(ENDPOINT, &data, metas)], &[]).expect("endpoint.init_config");

    // 2. set_config: the send side (type 2) and the receive side (type 3)
    let set_config = |w: &mut World, signer: &Keypair, config_type: u32, config: Vec<u8>| {
        let mut data = anchor_sighash("set_config").to_vec();
        data.extend_from_slice(store.as_ref());
        data.extend_from_slice(&HUB_EID.to_le_bytes());
        data.extend_from_slice(&config_type.to_le_bytes());
        data.extend_from_slice(&(config.len() as u32).to_le_bytes());
        data.extend_from_slice(&config);
        let mut metas = endpoint_head(&signer.pubkey());
        metas.extend([
            AccountMeta::new_readonly(msglib, false),
            AccountMeta::new(send_cfg, false),
            AccountMeta::new(recv_cfg, false),
            AccountMeta::new_readonly(pda(&[b"SendConfig", &eid], &ULN), false),
            AccountMeta::new_readonly(pda(&[b"ReceiveConfig", &eid], &ULN), false),
            AccountMeta::new_readonly(pda(&[b"__event_authority"], &ULN), false),
            AccountMeta::new_readonly(ULN, false),
        ]);
        w.send(&[Instruction::new_with_bytes(ENDPOINT, &data, metas)], &[signer])
    };
    let cfg = borsh_uln_config(32, &keys(&required), &keys(&optional), 1);
    // nobody but the delegate can touch the verifier set
    let stranger = w.new_user();
    assert!(set_config(&mut w, &stranger, 2, cfg.clone()).is_err());
    let admin = w.admin.insecure_clone();
    set_config(&mut w, &admin, 2, cfg.clone()).expect("send ULN config");
    set_config(&mut w, &admin, 3, cfg.clone()).expect("receive ULN config");

    // read back: the OApp's send config names exactly our set
    let d = w.svm.get_account(&send_cfg).unwrap().data;
    assert_eq!(&d[9..17], &32u64.to_le_bytes(), "confirmations");
    assert_eq!((d[17], d[18], d[19]), (2, 2, 1), "2 required, 2 optional, threshold 1");
    assert_eq!(&d[24..56], required[0].1.as_ref());

    // 3. a send now rides our four verifiers, in the config's order
    let mut dvns = required.clone();
    dvns.extend(optional.clone());
    let t = token_id(TOK);
    let mut metas = buy_accounts(&w, &user, &t);
    metas.extend(send_list_with(&w, &user, &dvns));
    let ix = Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::BuyToken {
            params: spawn_gateway::instructions::BuyTokenParams { hub_token: t, usdc_in: ONE_USDC, max_native_fee: 0 },
        }
        .data(),
        metas,
    );
    let meta = w.send(&[ix], &[&u]).expect("a buy over our own verifier set");
    let fee = sent_event(&meta).1;
    println!("fee of a buy over the DEFAULT set: {default_fee} lamports; over OUR set: {fee} lamports");
    println!("CU buy_token over our set: {}", meta.compute_units_consumed);
    assert!(fee < default_fee, "our set must not cost more than the default one");
    // the default list no longer matches the OApp's config
    let ix = buy_ix(&w, &user, TOK, ONE_USDC, 0);
    assert!(w.send(&[ix], &[&u]).is_err(), "the default DVN list must be refused once ours is set");

    // What the whole wiring locks in rent — the deployment plan's number.
    // Mainnet's rate on 2026-11-13 (`solana rent -u mainnet-beta`):
    // (128 + bytes) × 5,080 lamports.
    let hub = hub_peer();
    let named = [
        ("store", w.ids.store),
        ("lz_receive_types", w.ids.types_acc),
        ("peer (hub)", w.ids.peer),
        ("vault (USDC token account)", w.ids.vault),
        ("gas tank (0 bytes, its floor)", w.ids.tank),
        ("endpoint: oapp registry", registry),
        ("endpoint: nonce", pda(&[b"Nonce", store.as_ref(), &eid, &hub], &ENDPOINT)),
        ("endpoint: pending nonce", pda(&[b"PendingNonce", store.as_ref(), &eid, &hub], &ENDPOINT)),
        ("endpoint: send library config", pda(&[b"SendLibraryConfig", store.as_ref(), &eid], &ENDPOINT)),
        ("endpoint: receive library config", pda(&[b"ReceiveLibraryConfig", store.as_ref(), &eid], &ENDPOINT)),
        ("uln: send config", send_cfg),
        ("uln: receive config", recv_cfg),
    ];
    let mut total = 0u64;
    for (name, key) in named {
        let len = w.svm.get_account(&key).map(|a| a.data.len()).unwrap_or(0) as u64;
        let rent = (128 + len) * 5_080;
        total += rent;
        println!("wiring rent — {name}: {len} bytes → {rent} lamports");
    }
    let alt = (128 + 56 + 32 * 32) * 5_080u64;
    println!("wiring rent — lookup table (32 addresses): {alt} lamports");
    println!("wiring rent — TOTAL at mainnet rates: {} lamports", total + alt);
}

/* --------------------- what fits a Solana transaction ------------------ */

/// The v0 size of the transaction that executes one hub message, with a
/// lookup table holding everything that is not specific to the packet, its
/// token or its recipient — what an OApp's own table (`init_store`'s `alt`)
/// would hold.
fn executor_tx_size(w: &mut World, nonce: u64, msg: &SpawnMsg) -> (usize, usize) {
    let message = w.wire(msg);
    let wire_len = message.len();
    let guid = [3u8; 32];
    let params = LzReceiveParams { src_eid: HUB_EID, sender: hub_peer(), nonce, guid, message, extra_data: vec![] };
    let lz_accounts = resolve_lz_receive(w, &params);
    let mut data = anchor_sighash("execute").to_vec();
    data.extend_from_slice(&execute_params(&w.ids.store, &params, 0, 400_000));
    let lz = w.lz.as_ref().unwrap();
    let mut metas = vec![
        AccountMeta::new(w.exec.pubkey(), true),
        AccountMeta::new_readonly(lz.executor_cfg, false),
        AccountMeta::new_readonly(ENDPOINT, false),
        AccountMeta::new_readonly(pda(&[b"__event_authority"], &ENDPOINT), false),
        AccountMeta::new_readonly(pda(&[b"__event_authority"], &EXECUTOR), false),
        AccountMeta::new_readonly(EXECUTOR, false),
        AccountMeta::new_readonly(w.ids.program, false),
    ];
    metas.extend(lz_accounts);
    let ix = Instruction::new_with_bytes(EXECUTOR, &data, metas);
    let static_keys = vec![
        lz.executor_cfg,
        ENDPOINT,
        pda(&[b"__event_authority"], &ENDPOINT),
        pda(&[b"__event_authority"], &EXECUTOR),
        w.ids.program,
        w.ids.store,
        w.ids.peer,
        lz.oapp_registry,
        lz.nonce,
        pda(&[b"Endpoint"], &ENDPOINT),
        USDC,
        w.ids.vault,
        w.ids.tank,
        SYSTEM,
        TOKEN_PROGRAM,
    ];
    let msg = v0::Message::try_compile(
        &w.exec.pubkey(),
        &[ComputeBudgetInstruction::set_compute_unit_limit(400_000), ix],
        &[AddressLookupTableAccount { key: Pubkey::new_unique(), addresses: static_keys }],
        w.svm.latest_blockhash(),
    )
    .unwrap();
    (wire_len, 1 + 64 + VersionedMessage::V0(msg).serialize().len())
}

/// The hub's messages are abi-encoded twice over (envelope + op + tuple):
/// 288 to 480 bytes on the wire. LayerZero's DEFAULT executor config for
/// Base→Solana admits 200 (read from Base mainnet, 2026-11-13) — so the hub
/// adapter's executor config for eid 30168 must be raised by its delegate —
/// and the real ceiling is Solana's 1232-byte transaction. This measures it.
#[test]
fn every_hub_message_fits_one_executor_transaction() {
    let mut w = live();
    let u = w.new_user();
    let t = token_id(TOK);
    let worst_sync = SpawnMsg::SyncToken { hub_token: WireAddr(t), name: "N".repeat(64), symbol: "S".repeat(16) };
    let cases: Vec<(&str, SpawnMsg)> = vec![
        ("SYNC (64/16-byte strings)", worst_sync),
        ("SYNC (CANARY)", sync_msg(TOK)),
        ("DELIVER", SpawnMsg::Deliver { hub_token: WireAddr(t), to: WireAddr::from_pubkey(&u.pubkey()), tokens: U256::from_u128(E18), refund: U256::from_u128(E18) }),
        ("PAYOUT", SpawnMsg::Payout { to: WireAddr::from_pubkey(&u.pubkey()), usd_out: U256::from_u128(E18) }),
        ("FEE_DROP", SpawnMsg::FeeDrop { hub_token: WireAddr(t), amount: U256::from_u128(E18) }),
    ];
    for (i, (name, msg)) in cases.iter().enumerate() {
        let (wire, tx) = executor_tx_size(&mut w, 10 + i as u64, msg);
        println!("{name}: {wire} bytes on the wire → a {tx}-byte executor transaction (limit 1232)");
        assert!(wire > 200, "{name} is under LayerZero's default 200-byte cap — the hub-side step would be moot");
        assert!(tx <= 1232, "{name} cannot be delivered in one Solana transaction: {tx} bytes");
    }
    // the Solana side's own cap on what it SENDS toward the hub
    let cfg = fixture_accounts().into_iter().find(|a| a.name == "default_send_config").unwrap().data;
    let mut off = 8 + 1 + 8 + 3;
    for _ in 0..2 {
        off += 4 + 32 * u32::from_le_bytes(cfg[off..off + 4].try_into().unwrap()) as usize;
    }
    let max = u32::from_le_bytes(cfg[off..off + 4].try_into().unwrap());
    println!("Solana→Base default max message size: {max} bytes");
    assert!(max >= 2_000, "the largest spawn this chain can physically send must be admitted");
}
