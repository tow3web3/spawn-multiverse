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
//!   - a send fits one v0 transaction with an address lookup table;
//!   - v7.2: a token is opened from here (the opener pays the replica's
//!     rent, the SYNC then costs nobody anything); a claim leaves for
//!     another chain at that chain's price and comes home; the real
//!     executor delivers a claim moved HERE to a recipient it never saw;
//!     the vault burns USDC toward a peer vault through Circle's REAL CCTP
//!     V2 programs.
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
fn sent_event(meta: &litesvm::types::TransactionMetadata) -> (u8, u64, u16, bool) {
    use base64::Engine;
    let disc = &solana_sdk::hash::hash(b"event:SentToHub").to_bytes()[..8];
    for l in &meta.logs {
        if let Some(b64) = l.strip_prefix("Program data: ") {
            let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(b64) else { continue };
            // op u8, user 32, native_fee u64, legs u16, sponsored bool
            if raw.len() >= 52 && &raw[..8] == disc {
                return (
                    raw[8],
                    u64::from_le_bytes(raw[41..49].try_into().unwrap()),
                    u16::from_le_bytes(raw[49..51].try_into().unwrap()),
                    raw[51] == 1,
                );
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

/// What a send from here puts on the wire: the op in the envelope, this
/// store as sender, the pad as target, and the reply budget of `legs` legs.
fn enveloped(w: &World, msg: &SpawnMsg, legs: u128) -> Vec<u8> {
    msg_codec::Envelope {
        src_sender: WireAddr(w.ids.store.to_bytes()),
        dst_addr: WireAddr(hub_pad()),
        payload: msg.encode(),
        value: U256::from_u128(RETURN_UNIT * legs),
    }
    .encode()
}

/// "Any fill": the smallest minimum a trade can name (one unit, 0.000001).
const ANY: u64 = 1;

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
    buy_ix_min(w, user, tag, usdc_in, ANY, max_fee)
}

fn buy_ix_min(w: &World, user: &Pubkey, tag: u8, usdc_in: u64, min_tokens_out: u64, max_fee: u64) -> Instruction {
    let t = token_id(tag);
    let mut metas = buy_accounts(w, user, &t);
    metas.extend(send_list(w, user));
    Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::BuyToken {
            params: spawn_gateway::instructions::BuyTokenParams { hub_token: t, usdc_in, min_tokens_out, max_native_fee: max_fee },
        }
        .data(),
        metas,
    )
}

fn sell_ix(w: &World, user: &Pubkey, tag: u8, amount: u64) -> Instruction {
    sell_ix_min(w, user, tag, amount, ANY)
}

fn sell_ix_min(w: &World, user: &Pubkey, tag: u8, amount: u64, min_usdc_out: u64) -> Instruction {
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
            params: spawn_gateway::instructions::SellTokenParams { hub_token: t, amount, min_usdc_out, max_native_fee: 0 },
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
    quote_ix(w, op, name, symbol, meta_uri, with_dev_buy, 0).expect("quote_send")
}

/// What a move to `dst_chain` costs right now (its route account is passed
/// when it exists — as a client would).
fn quote_move(w: &mut World, dst_chain: u32) -> std::result::Result<u64, String> {
    quote_ix(w, msg_codec::OP_MOVE, "", "", "", false, dst_chain)
}

fn quote_ix(
    w: &mut World,
    op: u8,
    name: &str,
    symbol: &str,
    meta_uri: &str,
    with_dev_buy: bool,
    dst_chain: u32,
) -> std::result::Result<u64, String> {
    let route = w.ids.move_route(dst_chain);
    let move_route = if op == msg_codec::OP_MOVE && w.exists(&route) { Some(route) } else { None };
    let mut metas =
        spawn_gateway::accounts::QuoteSend { store: w.ids.store, peer: w.ids.peer, move_route }.to_account_metas(None);
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
                dst_chain,
            },
        }
        .data(),
        metas,
    );
    let ret = w.simulate(ix)?;
    Ok(u64::from_le_bytes(ret[..8].try_into().unwrap()))
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
    execute_naming(w, nonce, msg, 0, value)
}

/// The same, for a message whose ENVELOPE names `named` lamports (what a
/// hub adapter that attached a value would write), executed with `value`.
fn execute_naming(w: &mut World, nonce: u64, msg: &SpawnMsg, named: u64, value: u64) -> TxResult {
    let message = w.wire_with_value(msg, named);
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
    // …for at least a million tokens: the minimum rides the wire, ×1e12
    let ix = buy_ix_min(&w, &user, TOK, 250 * ONE_USDC, 1_000_000 * ONE_TOKEN, 0);
    let meta = w.send(&[ix], &[&u]).expect("buy against the real mainnet stack");
    println!("CU buy_token (first: creates the token account and the user account): {}", meta.compute_units_consumed);
    let (op, fee, legs, sponsored) = sent_event(&meta);
    assert_eq!((op, legs, sponsored), (msg_codec::OP_BUY, 1, false));
    assert_eq!(fee, quoted, "quote_send returns exactly what the send costs");
    println!("fee of a buy (1 reply leg of 0.0002 ETH): {} lamports", fee);
    assert_eq!(w.token_amount(&w.ids.vault), 250 * ONE_USDC);
    assert_eq!(w.token_amount(&ata_of(&user, &USDC)), 750 * ONE_USDC);
    assert_eq!(outbound_nonce(&w), 1);
    let expected = SpawnMsg::Buy {
        hub_token: WireAddr(t),
        buyer: WireAddr::from_pubkey(&user),
        usd_in: U256::from_spl_amount(250 * ONE_USDC),
        min_tokens_out: U256::from_spl_amount(1_000_000 * ONE_TOKEN),
    };
    assert!(packet_carries(&meta, &enveloped(&w, &expected, 1)), "the packet embeds the enveloped BUY, its minimum and its reply budget");
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
    let ix = sell_ix_min(&w, &user, TOK, 400_000 * ONE_TOKEN, 87_500_000);
    let meta = w.send(&[ix], &[&u]).unwrap();
    println!("CU sell_token: {}", meta.compute_units_consumed);
    assert_eq!(w.token_amount(&bag), 600_000 * ONE_TOKEN);
    let expected = SpawnMsg::Sell {
        hub_token: WireAddr(t),
        seller: WireAddr::from_pubkey(&user),
        tokens_in: U256::from_spl_amount(400_000 * ONE_TOKEN),
        min_usd_out: U256::from_spl_amount(87_500_000), // 87.5 dollars, net
    };
    assert!(packet_carries(&meta, &enveloped(&w, &expected, 1)));

    // ---- CLAIM and PULL: pure messages
    let ix = claim_ix(&w, &user, TOK);
    let meta = w.send(&[ix], &[&u]).unwrap();
    println!("CU claim_fees: {}", meta.compute_units_consumed);
    let expected = SpawnMsg::Claim { hub_token: WireAddr(t), claimer: WireAddr::from_pubkey(&user) };
    assert!(packet_carries(&meta, &enveloped(&w, &expected, 1)));
    let quoted = quote(&mut w, msg_codec::OP_PULL_FEES, "", "", "", false);
    let ix = pull_ix(&w, &user, TOK);
    let meta = w.send(&[ix], &[&u]).unwrap();
    println!("CU pull_fees: {}", meta.compute_units_consumed);
    assert_eq!(sent_event(&meta).1, quoted);
    let expected = SpawnMsg::PullFees { hub_token: WireAddr(t) };
    assert!(packet_carries(&meta, &enveloped(&w, &expected, 1)), "op 5 on the wire");

    // ---- SPAWN with a dev buy: 3 SYNC legs + the DELIVER leg, all prepaid
    let (name, symbol, uri) = ("SOLANA BORN", "SOLB", "{\"image\":\"/img/00\"}");
    let quoted = quote(&mut w, msg_codec::OP_SPAWN, name, symbol, uri, true);
    let ix = spawn_ix(&w, &user, name, symbol, uri, 50 * ONE_USDC, 1, 0);
    let meta = w.send(&[ix], &[&u]).unwrap();
    println!("CU spawn_token (dev buy): {}", meta.compute_units_consumed);
    let (op, fee_spawn, legs, _) = sent_event(&meta);
    assert_eq!((op, legs), (msg_codec::OP_SPAWN, SPAWN_LEGS as u16 + 1));
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
    assert!(packet_carries(&meta, &enveloped(&w, &expected, 4)), "the envelope names the four legs it prepaid");
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
    // a trade names its minimum (v7.2): there is no unprotected entry point
    let ix = buy_ix_min(&w, &user, TOK, ONE_USDC, 0, 0);
    refused(&mut w, ix, "ZeroMinimum");
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
            params: spawn_gateway::instructions::BuyTokenParams { hub_token: t, usdc_in: ONE_USDC, min_tokens_out: ANY, max_native_fee: 0 },
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
    // (this user never got a send through: no token account, no user
    // account — the delivery opens the latter out of the tank and parks)
    execute(
        &mut w,
        2,
        &SpawnMsg::Deliver { hub_token: WireAddr(t), to: WireAddr::from_pubkey(&user), tokens: U256::from_u128(10 * E18), refund: U256::from_u128(0) },
        0,
    )
    .expect("a delivery for someone with no account here is parked, not failed");
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
    let ix = sell_ix_min(&w, &user, TOK, 4 * ONE_TOKEN, 0);
    refused(&mut w, ix, "ZeroMinimum");
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
            params: spawn_gateway::instructions::BuyTokenParams { hub_token: t, usdc_in: ONE_USDC, min_tokens_out: ANY, max_native_fee: 0 },
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

/* ============================ protocol v7.2 ============================ */

const TOK2: u8 = 0x5e;

fn open_ix(w: &World, user: &Pubkey, t: [u8; 32], max_fee: u64) -> Instruction {
    let mut metas = spawn_gateway::accounts::OpenToken {
        user: *user,
        store: w.ids.store,
        peer: w.ids.peer,
        gas_tank: w.ids.tank,
        replica: w.ids.replica(&t),
        mint: w.ids.mint(&t),
        system_program: SYSTEM,
    }
    .to_account_metas(None);
    metas.extend(send_list(w, user));
    Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::OpenToken {
            params: spawn_gateway::instructions::TokenMsgParams { hub_token: t, max_native_fee: max_fee },
        }
        .data(),
        metas,
    )
}

fn move_ix(w: &World, user: &Pubkey, dst_chain: u32, to: [u8; 32], units: u64) -> Instruction {
    let mut metas = spawn_gateway::accounts::MoveClaim {
        user: *user,
        store: w.ids.store,
        peer: w.ids.peer,
        gas_tank: w.ids.tank,
        user_account: w.ids.user(user),
        route: w.ids.move_route(dst_chain),
        system_program: SYSTEM,
    }
    .to_account_metas(None);
    metas.extend(send_list(w, user));
    Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::MoveClaim {
            params: spawn_gateway::instructions::MoveClaimParams { dst_chain, to, units, max_native_fee: 0 },
        }
        .data(),
        metas,
    )
}

fn rent_of(w: &World, space: usize) -> u64 {
    w.svm.minimum_balance_for_rent_exemption(space)
}

/// A chain the hub left out of a launch (its SYNC was above the ceiling,
/// failed, or the token is older than the gateway) has no replica: buys are
/// refused at entry. Anyone opens the token from here — OP_OPEN — and pays
/// the whole round trip, the replica's rent included: the SYNC that answers
/// arrives with no lamports and must cost nobody anything.
#[test]
fn a_token_is_opened_from_here_and_its_sync_costs_nobody() {
    let mut w = live();
    enlist_executor(&mut w);
    let t = token_id(TOK2);
    let u = w.new_user();
    let user = u.pubkey();
    w.give_usdc(&user, 100 * ONE_USDC);
    assert_eq!(w.lamports(&w.ids.tank), 0, "the tank is dry on purpose");

    // no replica: nothing can be bought, sold, claimed or pulled
    let ix = buy_ix(&w, &user, TOK2, ONE_USDC, 0);
    assert!(w.send(&[ix], &[&u]).unwrap_err().contains("AccountNotInitialized"));

    // ---- the open: OP_OPEN out, `open_legs` (1) prepaid, the rent left
    // at the two addresses the SYNC will fill
    let quoted = quote(&mut w, msg_codec::OP_OPEN, "", "", "", false);
    let before = w.lamports(&user);
    let ix = open_ix(&w, &user, t, 0);
    let meta = w.send(&[ix], &[&u]).expect("open_token against the real mainnet stack");
    println!("CU open_token: {}", meta.compute_units_consumed);
    let (op, fee, legs, sponsored) = sent_event(&meta);
    assert_eq!((op, legs, sponsored), (msg_codec::OP_OPEN, 1, false));
    assert_eq!(fee, quoted, "quote_send(6) is what an open costs");
    let rent = rent_of(&w, Replica::SIZE) + rent_of(&w, 82);
    println!("fee of an open (1 reply leg): {fee} lamports; rent of the replica it prepays: {rent} lamports");
    assert_eq!(before - w.lamports(&user), fee + rent, "the opener paid the message and the replica's rent");
    let expected = SpawnMsg::Open { hub_token: WireAddr(t) };
    assert!(packet_carries(&meta, &enveloped(&w, &expected, 1)), "op 6 on the wire, with its reply budget");
    assert!(packet_carries(&meta, &msg_codec::lz_receive_options(GAS_TO_HUB, RETURN_UNIT)));
    assert_eq!(w.lamports(&w.ids.replica(&t)), rent_of(&w, Replica::SIZE));
    assert_eq!(w.lamports(&w.ids.mint(&t)), rent_of(&w, 82));
    assert!(!w.exists(&w.ids.replica(&t)), "an open creates nothing: only the hub's SYNC does");

    // two opens in flight: the second finds the rent there and pays only
    // its message (the hub answers both; a gateway ignores a second SYNC)
    let u2 = w.new_user();
    let before = w.lamports(&u2.pubkey());
    let ix = open_ix(&w, &u2.pubkey(), t, 0);
    let fee2 = sent_event(&w.send(&[ix], &[&u2]).unwrap()).1;
    assert_eq!(before - w.lamports(&u2.pubkey()), fee2);

    // ---- the hub answers with an ordinary SYNC: zero value, a dry tank —
    // and LayerZero's real executor delivers it without losing a lamport
    let exec = w.exec.pubkey();
    let exec_before = w.lamports(&exec);
    let msg = SpawnMsg::SyncToken { hub_token: WireAddr(t), name: "LATECOMER".into(), symbol: "LATE".into() };
    let meta = execute(&mut w, 1, &msg, 0).expect("the SYNC of an open needs nobody's lamports");
    println!("CU executor→lz_receive SYNC of an opened token: {}", meta.compute_units_consumed);
    assert_eq!(w.lamports(&exec), exec_before);
    assert_eq!(w.lamports(&w.ids.tank), 0);
    let replica: Replica = w.read(&w.ids.replica(&t));
    assert_eq!((replica.name.as_str(), replica.mint), ("LATECOMER", w.ids.mint(&t)));
    execute(&mut w, 2, &msg, 0).expect("the second open's SYNC is ignored, not failed");

    // the token trades here now
    let ix = buy_ix(&w, &user, TOK2, ONE_USDC, 0);
    w.send(&[ix], &[&u]).expect("a buy of the opened token");

    // ---- refusals, each before a lamport moves
    let refused = |w: &mut World, ix: Instruction, what: &str| {
        let err = w.send(&[ix], &[&u]).unwrap_err();
        assert!(err.contains(what), "expected {what}, got: {err}");
    };
    let ix = open_ix(&w, &user, t, 0);
    refused(&mut w, ix, "AlreadyOpen");
    // a hub token is an EVM address: a wide id names nothing the hub knows
    let mut wide = token_id(0x33);
    wide[0] = 1;
    let ix = open_ix(&w, &user, wide, 0);
    refused(&mut w, ix, "BadTokenId");
    let ix = open_ix(&w, &user, token_id(0x33), 1);
    refused(&mut w, ix, "InsufficientFee");
    assert_eq!(w.lamports(&w.ids.replica(&token_id(0x33))), 0, "a refused open leaves no rent behind");
    // a replica is new exposure: a paused gateway refuses opens
    let admin = w.admin.insecure_clone();
    w.govern(spawn_gateway::instruction::Pause {}.data(), &admin).unwrap();
    let ix = open_ix(&w, &user, token_id(0x33), 0);
    refused(&mut w, ix, "Paused");
    w.unpause();
    // the operator's price: two legs cost more than one
    w.govern(spawn_gateway::instruction::SetOpenLegs { legs: 2 }.data(), &admin).unwrap();
    let dearer = quote(&mut w, msg_codec::OP_OPEN, "", "", "", false);
    assert!(dearer > quoted);
    let ix = open_ix(&w, &user, token_id(0x33), 0);
    let meta = w.send(&[ix], &[&u]).unwrap();
    assert_eq!(sent_event(&meta).2, 2);
    assert!(packet_carries(&meta, &msg_codec::lz_receive_options(GAS_TO_HUB, RETURN_UNIT * 2)));
}

/// A dev buy on a chain the hub left out of the launch is delivered and
/// parked there (the launcher prepaid at that chain's own price, but its
/// SYNC was skipped); the token is opened, and the bag claimed.
#[test]
fn a_bag_parked_behind_a_missing_replica_is_claimed_once_the_token_is_opened() {
    let mut w = live();
    enlist_executor(&mut w);
    let tank = w.ids.tank;
    w.fund(&tank, 1_000_000_000);
    let t = token_id(TOK2);
    let u = w.new_user();
    let user = u.pubkey();
    w.give_usdc(&user, 100 * ONE_USDC);
    // the creator spawned from here (their user account exists)
    let ix = spawn_ix(&w, &user, "LEFT OUT", "OUT", "", 50 * ONE_USDC, 0, 0);
    w.send(&[ix], &[&u]).unwrap();
    // the DELIVER of the dev buy arrives; no SYNC ever does
    let bag = 30_451_115_339_459_940_893_081_251u128;
    execute(
        &mut w,
        1,
        &SpawnMsg::Deliver { hub_token: WireAddr(t), to: WireAddr::from_pubkey(&user), tokens: U256::from_u128(bag), refund: U256::from_u128(0) },
        0,
    )
    .unwrap();
    let ua: UserAccount = w.read(&w.ids.user(&user));
    assert_eq!(ua.parked[0].amount_e18, bag);
    // anyone opens it — here, a stranger
    let stranger = w.new_user();
    let ix = open_ix(&w, &stranger.pubkey(), t, 0);
    w.send(&[ix], &[&stranger]).unwrap();
    let tank_before = w.lamports(&tank);
    execute(&mut w, 2, &SpawnMsg::SyncToken { hub_token: WireAddr(t), name: "LEFT OUT".into(), symbol: "OUT".into() }, 0).unwrap();
    assert_eq!(w.lamports(&tank), tank_before, "the opener's rent, not the tank's");
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
    assert_eq!(w.token_amount(&ata_of(&user, &mint)), 30_451_115_339_459);
}

/// OP_MOVE: a claim this vault cannot pay leaves for a chain whose vault
/// can. The caller's claim is burned, the hub is told to pay (dstChain, to),
/// and the move prepays that destination's own price — never less than a
/// trade's, which pays for the way home.
#[test]
fn a_claim_leaves_for_another_chain_at_that_chains_price_and_can_come_home() {
    let (mut w, u) = world_with_token_and_user(0);
    let user = u.pubkey();
    let admin = w.admin.insecure_clone();
    let to = pad32(&[0xd0; 20]); // an EVM address on the destination
    const BNB: u32 = 4;
    const ARB: u32 = 5;

    // a claim: the hub paid this user 40 dollars the vault did not hold
    execute(&mut w, 2, &SpawnMsg::Payout { to: WireAddr::from_pubkey(&user), usd_out: U256::from_u128(40 * E18) }, 0).unwrap();
    let ua: UserAccount = w.read(&w.ids.user(&user));
    assert_eq!((ua.usd_claim, w.store().claims_total), (40 * ONE_USDC, 40 * ONE_USDC));

    let refused = |w: &mut World, ix: Instruction, signer: &Keypair, what: &str| {
        let err = w.send(&[ix], &[signer]).unwrap_err();
        assert!(err.contains(what), "expected {what}, got: {err}");
    };
    // ---- no price, no route: a destination is closed until the operator
    // prices it — which is also what refuses a chain that does not exist
    let ix = move_ix(&w, &user, BNB, to, 10 * ONE_USDC);
    refused(&mut w, ix, &u, "RouteClosed");
    assert!(quote_move(&mut w, BNB).unwrap_err().contains("RouteClosed"));
    w.set_move_legs(BNB, 6);
    w.set_move_legs(ARB, 1);

    // ---- the move: OP_MOVE out, six legs prepaid, the claim burned
    let quoted = quote_move(&mut w, BNB).unwrap();
    let before = w.lamports(&user);
    let ix = move_ix(&w, &user, BNB, to, 10 * ONE_USDC);
    let meta = w.send(&[ix], &[&u]).expect("move_claim against the real mainnet stack");
    println!("CU move_claim: {}", meta.compute_units_consumed);
    let (op, fee, legs, _) = sent_event(&meta);
    assert_eq!((op, legs), (msg_codec::OP_MOVE, 6));
    assert_eq!(fee, quoted, "quote_send(7, dst) is what the move costs");
    println!("fee of a move (6 reply legs of 0.0002 ETH): {fee} lamports");
    assert_eq!(before - w.lamports(&user), fee, "the mover paid the message and the hub's leg, nothing else");
    let expected = SpawnMsg::Move {
        from: WireAddr::from_pubkey(&user),
        to: WireAddr(to),
        amount: U256::from_spl_amount(10 * ONE_USDC),
        dst_chain: BNB,
    };
    assert!(packet_carries(&meta, &enveloped(&w, &expected, 6)), "op 7 on the wire, with its six legs");
    assert!(packet_carries(&meta, &msg_codec::lz_receive_options(GAS_TO_HUB, RETURN_UNIT * 6)));
    let ua: UserAccount = w.read(&w.ids.user(&user));
    assert_eq!((ua.usd_claim, w.store().claims_total), (30 * ONE_USDC, 30 * ONE_USDC));

    // a route priced under a trade still prepays a trade's leg: the way home
    let admin_kp = admin.insecure_clone();
    w.set_fee_config(GAS_TO_HUB, RETURN_UNIT, 3, SPAWN_LEGS);
    let ix = move_ix(&w, &user, ARB, to, ONE_USDC);
    let meta = w.send(&[ix], &[&u]).unwrap();
    assert_eq!(sent_event(&meta).2, 3, "never fewer legs than a trade");
    w.set_fee_config(GAS_TO_HUB, RETURN_UNIT, 1, SPAWN_LEGS);

    // ---- what it refuses, before anything is burned
    for (dst, what) in [(1u32, "BadDestination"), (0, "BadDestination"), (6, "RouteClosed")] {
        let ix = move_ix(&w, &user, dst, to, ONE_USDC);
        refused(&mut w, ix, &u, what);
    }
    let ix = move_ix(&w, &user, BNB, [0u8; 32], ONE_USDC);
    refused(&mut w, ix, &u, "BadDestination");
    let ix = move_ix(&w, &user, BNB, to, 0);
    refused(&mut w, ix, &u, "ZeroAmount");
    let ix = move_ix(&w, &user, BNB, to, 30 * ONE_USDC);
    refused(&mut w, ix, &u, "ClaimTooSmall"); // 29 are left
    // USDC in a wallet is not a claim: someone with dollars but no claim
    let rich = w.new_user();
    w.give_usdc(&rich.pubkey(), 1_000 * ONE_USDC);
    w.open_user_account(&rich.pubkey());
    let ix = move_ix(&w, &rich.pubkey(), BNB, to, ONE_USDC);
    refused(&mut w, ix, &rich, "ClaimTooSmall");
    // nobody moves someone else's claim
    let mut metas = spawn_gateway::accounts::MoveClaim {
        user: rich.pubkey(),
        store: w.ids.store,
        peer: w.ids.peer,
        gas_tank: w.ids.tank,
        user_account: w.ids.user(&user),
        route: w.ids.move_route(BNB),
        system_program: SYSTEM,
    }
    .to_account_metas(None);
    metas.extend(send_list(&w, &rich.pubkey()));
    let ix = Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::MoveClaim {
            params: spawn_gateway::instructions::MoveClaimParams { dst_chain: BNB, to, units: ONE_USDC, max_native_fee: 0 },
        }
        .data(),
        metas,
    );
    assert!(w.send(&[ix], &[&rich]).is_err());
    // the operator closes the route: moves toward it stop
    w.set_move_legs(BNB, 0);
    let ix = move_ix(&w, &user, BNB, to, ONE_USDC);
    refused(&mut w, ix, &u, "RouteClosed");
    w.set_move_legs(BNB, 6);
    let ua: UserAccount = w.read(&w.ids.user(&user));
    assert_eq!((ua.usd_claim, w.store().claims_total), (29 * ONE_USDC, 29 * ONE_USDC), "a refused move burns nothing");

    // ---- what ONE message can prepay is capped by LayerZero's executor,
    // not by this program: its config toward Base admits 0.05 ETH of value
    // per message (mainnet, read from the fixture). 250 legs of 0.0002 ETH
    // pass, 251 do not — the send is refused whole, nothing is burned. An
    // operator pricing a dear destination (an L1) must stay under it.
    const ETH: u32 = 2;
    w.set_move_legs(ETH, 250);
    let within = quote_move(&mut w, ETH).expect("0.05 ETH of reply budget is admitted");
    println!("fee of a move prepaying 250 legs (0.05 ETH, the executor's cap toward Base): {within} lamports");
    w.set_move_legs(ETH, 251);
    assert!(quote_move(&mut w, ETH).unwrap_err().contains("NativeAmountExceedsCap"));
    let ix = move_ix(&w, &user, ETH, to, ONE_USDC);
    refused(&mut w, ix, &u, "NativeAmountExceedsCap");
    let ua: UserAccount = w.read(&w.ids.user(&user));
    assert_eq!(ua.usd_claim, 29 * ONE_USDC);

    // ---- an exit: the pause does not apply
    w.govern(spawn_gateway::instruction::Pause {}.data(), &admin_kp).unwrap();
    let ix = move_ix(&w, &user, BNB, to, 9 * ONE_USDC);
    w.send(&[ix], &[&u]).expect("a move is never paused");
    w.unpause();

    // ---- the hub could not hand it on (no gateway there, a leg above its
    // ceiling): the claim comes home as an ordinary PAYOUT to `from` — a
    // claim again while the vault is short, USDC once it is not
    execute(&mut w, 3, &SpawnMsg::Payout { to: WireAddr::from_pubkey(&user), usd_out: U256::from_u128(9 * E18) }, 0).unwrap();
    let ua: UserAccount = w.read(&w.ids.user(&user));
    assert_eq!(ua.usd_claim, 29 * ONE_USDC);
    let vault = w.ids.vault;
    w.set_token_amount(&vault, 500 * ONE_USDC);
    w.give_usdc(&user, 0);
    execute(&mut w, 4, &SpawnMsg::Payout { to: WireAddr::from_pubkey(&user), usd_out: U256::from_u128(10 * E18) }, 0).unwrap();
    assert_eq!(w.token_amount(&ata_of(&user, &USDC)), 10 * ONE_USDC);
    assert_eq!(outbound_nonce(&w), 3);
}

/// The other end of a move: `moveClaim` on ANOTHER chain names a recipient
/// here, and the hub forwards it. LayerZero's real executor delivers it,
/// with the zero value every hub message has, to a recipient that never
/// touched this chain: the claim is booked in a user account opened out of
/// the tank. With a dry tank the executor declines (its own balance check)
/// and the packet waits — for a refill, for anyone who opens that account,
/// or for a delivery that brings the rent.
#[test]
fn the_real_executor_delivers_a_moved_claim_to_a_recipient_it_never_saw() {
    let mut w = live();
    enlist_executor(&mut w);
    let tank = w.ids.tank;
    let exec = w.exec.pubkey();
    let rent = rent_of(&w, UserAccount::SIZE);
    w.fund(&tank, 100_000_000);
    let pay = |to: &Pubkey| SpawnMsg::Payout { to: WireAddr::from_pubkey(to), usd_out: U256::from_u128(25 * E18) };

    // ---- a funded tank: delivered, the executor's balance untouched
    let a = Keypair::new().pubkey();
    let (exec_before, tank_before) = (w.lamports(&exec), w.lamports(&tank));
    let meta = execute(&mut w, 1, &pay(&a), 0).expect("PAYOUT to a stranger through the real executor");
    println!("CU executor→lz_receive PAYOUT to a recipient with no account (real clear): {}", meta.compute_units_consumed);
    assert_eq!(w.lamports(&exec), exec_before);
    assert_eq!(tank_before - w.lamports(&tank), rent);
    println!("rent of the user account a moved claim opens, from the tank: {rent} lamports");
    let ua: UserAccount = w.read(&w.ids.user(&a));
    assert_eq!((ua.owner, ua.usd_claim), (a, 25 * ONE_USDC));
    // an off-curve recipient, the all-zero key: the executor resolves and
    // delivers them the same way
    for (n, to) in [(2u64, pda(&[b"vault"], &ATA_PROGRAM)), (3, Pubkey::default()), (4, w.ids.store)] {
        execute(&mut w, n, &pay(&to), 0).unwrap_or_else(|e| panic!("PAYOUT to {to}: {e}"));
        let ua: UserAccount = w.read(&w.ids.user(&to));
        assert_eq!(ua.usd_claim, 25 * ONE_USDC);
    }
    // a recipient who holds USDC is simply paid
    let vault = w.ids.vault;
    w.set_token_amount(&vault, 100 * ONE_USDC);
    let holder = Keypair::new().pubkey();
    w.give_usdc(&holder, 0);
    execute(&mut w, 5, &pay(&holder), 0).unwrap();
    assert_eq!(w.token_amount(&ata_of(&holder, &USDC)), 25 * ONE_USDC);

    // ---- a DRY tank: the executor will not pay the rent — and the packet
    // is not lost
    w.set_lamports(&tank, 0);
    let b = Keypair::new().pubkey();
    let err = execute(&mut w, 6, &pay(&b), 0).unwrap_err();
    assert!(err.contains("InsufficientBalance"), "expected the executor's own balance check, got: {err}");
    assert!(payload_hash_exists(&w, 6), "the message was not consumed");
    // (1) anyone opens the recipient's account: the same packet lands for free
    w.open_user_account(&b);
    let exec_before = w.lamports(&exec);
    execute(&mut w, 6, &pay(&b), 0).expect("the same packet, once the account exists");
    assert_eq!(w.lamports(&exec), exec_before);
    // (2) or the tank is refilled
    let c = Keypair::new().pubkey();
    assert!(execute(&mut w, 7, &pay(&c), 0).is_err());
    w.fund(&tank, 10_000_000);
    execute(&mut w, 7, &pay(&c), 0).expect("the same packet, once the tank is refilled");
    w.set_lamports(&tank, 0);

    // ---- WHAT A VALUE ON THE HUB'S MESSAGE WOULD CHANGE (it has none in
    // v7.2). Bought by the packet's option, the rent is the executor's to
    // spend: delivered with a dry tank, nobody's help needed…
    let d = Keypair::new().pubkey();
    let exec_before = w.lamports(&exec);
    execute(&mut w, 8, &pay(&d), rent).expect("a delivery that brings the rent");
    assert_eq!(exec_before - w.lamports(&exec), rent);
    // …and, named in the envelope, it goes through the tank: the message
    // funds the account it opens and the tank — empty: at the rent floor
    // every account keeps — ends where it started
    let floor = rent_of(&w, 0);
    w.set_lamports(&tank, floor);
    let e = Keypair::new().pubkey();
    let exec_before = w.lamports(&exec);
    execute_naming(&mut w, 9, &pay(&e), rent, rent).expect("a message that names and brings its rent");
    assert_eq!(exec_before - w.lamports(&exec), rent);
    assert_eq!(w.lamports(&tank), floor);
    let ua: UserAccount = w.read(&w.ids.user(&e));
    assert_eq!(ua.usd_claim, 25 * ONE_USDC);
    // a delivery that names a value and brings less is turned away
    let f = Keypair::new().pubkey();
    let err = execute_naming(&mut w, 10, &pay(&f), rent, rent - 1).unwrap_err();
    assert!(err.contains("InsufficientBalance"), "{err}");
    // a tank drained to nothing cannot take less than its own rent floor:
    // the value then stays with whoever delivers, and nothing fails for it
    w.set_lamports(&tank, 0);
    let g = Keypair::new().pubkey();
    w.open_user_account(&g);
    let exec_before = w.lamports(&exec);
    execute_naming(&mut w, 11, &pay(&g), 1_000, 1_000).expect("a value too small for an empty tank is left alone");
    assert_eq!((w.lamports(&exec), w.lamports(&tank)), (exec_before, 0));
}

/* ------------------------------ CCTP (real) --------------------------- */

const CCTP_MT: Pubkey = anchor_lang::solana_program::pubkey!("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
const CCTP_TMM: Pubkey = anchor_lang::solana_program::pubkey!("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");

/// Loads Circle's REAL CCTP V2 programs and mainnet state
/// (tests/fetch-cctp.cjs).
fn load_cctp(w: &mut World) {
    use base64::Engine;
    let file: serde_json::Value = serde_json::from_slice(&fixture("cctp.json")).unwrap();
    for p in file["programs"].as_array().unwrap() {
        let id: Pubkey = p["id"].as_str().unwrap().parse().unwrap();
        w.svm.add_program(id, &fixture(p["file"].as_str().unwrap()));
    }
    for a in file["accounts"].as_array().unwrap() {
        let data = base64::engine::general_purpose::STANDARD.decode(a["data_b64"].as_str().unwrap()).unwrap();
        w.svm
            .set_account(
                a["pubkey"].as_str().unwrap().parse().unwrap(),
                Account {
                    lamports: a["lamports"].as_u64().unwrap(),
                    data,
                    owner: a["owner"].as_str().unwrap().parse().unwrap(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }
}

fn rebalance_ix(w: &World, operator: &Pubkey, label: u32, domain: u32, usdc: u64, event: &Pubkey, tmm: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::Rebalance { label, usdc }.data(),
        spawn_gateway::accounts::Rebalance {
            operator: *operator,
            store: w.ids.store,
            cctp_peer: w.ids.cctp_peer(label),
            vault: w.ids.vault,
            usdc_mint: USDC,
            sender_authority: pda(&[b"sender_authority"], &CCTP_TMM),
            denylist_account: pda(&[b"denylist_account", w.ids.store.as_ref()], &CCTP_TMM),
            message_transmitter: pda(&[b"message_transmitter"], &CCTP_MT),
            token_messenger: pda(&[b"token_messenger"], &CCTP_TMM),
            remote_token_messenger: pda(&[b"remote_token_messenger", domain.to_string().as_bytes()], &CCTP_TMM),
            token_minter: pda(&[b"token_minter"], &CCTP_TMM),
            local_token: pda(&[b"local_token", USDC.as_ref()], &CCTP_TMM),
            message_sent_event_data: *event,
            message_transmitter_program: CCTP_MT,
            token_messenger_minter_program: tmm,
            token_program: TOKEN_PROGRAM,
            system_program: SYSTEM,
            cctp_event_authority: pda(&[b"__event_authority"], &CCTP_TMM),
        }
        .to_account_metas(None),
    )
}

/// The vault's way OUT toward the EVM vaults: `rebalance` burns its USDC
/// through Circle's real CCTP V2 TokenMessengerMinter, for the peer vault
/// the admin named and nothing else — `OmniUSD.rebalance`.
#[test]
fn the_vault_is_levelled_with_a_peer_vault_over_circles_real_cctp() {
    let mut w = live();
    load_cctp(&mut w);
    let admin = w.admin.insecure_clone();
    let operator = w.new_user();
    w.govern(spawn_gateway::instruction::SetOperator { operator: operator.pubkey() }.data(), &admin).unwrap();
    let vault = w.ids.vault;
    w.set_token_amount(&vault, 500 * ONE_USDC);
    const BASE: u32 = 3; // chain label; CCTP domain 6
    let base_vault = pad32(&hex_addr("ada6ceaEA64EA685a3CbA8e8F94A1690B29904C2"));

    // no peer, no way out
    let ev = Keypair::new();
    let ix = rebalance_ix(&w, &operator.pubkey(), BASE, 6, 200 * ONE_USDC, &ev.pubkey(), CCTP_TMM);
    assert!(w.send(&[ix], &[&operator, &ev]).unwrap_err().contains("AccountNotInitialized"));
    let ix = Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::SetCctpPeer { label: BASE, domain: 6, vault: base_vault }.data(),
        spawn_gateway::accounts::SetCctpPeer {
            admin: admin.pubkey(),
            store: w.ids.store,
            cctp_peer: w.ids.cctp_peer(BASE),
            system_program: SYSTEM,
        }
        .to_account_metas(None),
    );
    w.send(&[ix], &[]).unwrap();

    // ---- the burn
    let supply = |w: &World| u64::from_le_bytes(w.svm.get_account(&USDC).unwrap().data[36..44].try_into().unwrap());
    let (supply_before, op_before) = (supply(&w), w.lamports(&operator.pubkey()));
    let ix = rebalance_ix(&w, &operator.pubkey(), BASE, 6, 200 * ONE_USDC, &ev.pubkey(), CCTP_TMM);
    let meta = w.send(&[ix], &[&operator, &ev]).expect("rebalance through Circle's real CCTP V2 programs");
    println!("CU rebalance (CCTP V2 deposit_for_burn): {}", meta.compute_units_consumed);
    assert_eq!(w.token_amount(&vault), 300 * ONE_USDC);
    assert_eq!(supply_before - supply(&w), 200 * ONE_USDC, "the USDC was burned, not moved");
    // Circle's message: owned by the MessageTransmitter, paid by the
    // operator, and it names the peer vault as mint recipient, Base as
    // destination and the amount — nothing the operator chose
    let msg = w.svm.get_account(&ev.pubkey()).expect("Circle's MessageSent account");
    assert_eq!(msg.owner, CCTP_MT);
    println!("rent of Circle's message account, paid by the operator: {} lamports ({} bytes)", op_before - w.lamports(&operator.pubkey()), msg.data.len());
    assert!(op_before - w.lamports(&operator.pubkey()) == msg.lamports);
    let has = |needle: &[u8]| msg.data.windows(needle.len()).any(|x| x == needle);
    assert!(has(&base_vault), "mint recipient = the peer vault");
    assert!(has(w.ids.store.as_ref()), "the store is the depositor");
    let mut amount = [0u8; 32];
    amount[24..].copy_from_slice(&(200 * ONE_USDC).to_be_bytes());
    assert!(has(&amount), "the amount, as CCTP's burn message carries it");
    assert!(has(&[&5u32.to_be_bytes()[..], &6u32.to_be_bytes()[..]].concat()), "source domain 5 (Solana), destination domain 6 (Base)");

    // ---- what it refuses
    let stranger = w.new_user();
    let ev = Keypair::new();
    let ix = rebalance_ix(&w, &stranger.pubkey(), BASE, 6, ONE_USDC, &ev.pubkey(), CCTP_TMM);
    assert!(w.send(&[ix], &[&stranger, &ev]).unwrap_err().contains("NotOperator"));
    let ix = rebalance_ix(&w, &operator.pubkey(), BASE, 6, 301 * ONE_USDC, &ev.pubkey(), CCTP_TMM);
    assert!(w.send(&[ix], &[&operator, &ev]).unwrap_err().contains("VaultShort"));
    let ix = rebalance_ix(&w, &operator.pubkey(), BASE, 6, 0, &ev.pubkey(), CCTP_TMM);
    assert!(w.send(&[ix], &[&operator, &ev]).unwrap_err().contains("ZeroAmount"));
    // the store signs toward Circle's program and no other
    let ix = rebalance_ix(&w, &operator.pubkey(), BASE, 6, ONE_USDC, &ev.pubkey(), TOKEN_PROGRAM);
    assert!(w.send(&[ix], &[&operator, &ev]).unwrap_err().contains("BadCctpProgram"));
    // a label with no peer (Arbitrum was never named)
    let ix = rebalance_ix(&w, &operator.pubkey(), 5, 3, ONE_USDC, &ev.pubkey(), CCTP_TMM);
    assert!(w.send(&[ix], &[&operator, &ev]).is_err());
    // the peer's own domain is the only one Circle will accept for it
    let ix = rebalance_ix(&w, &operator.pubkey(), BASE, 3, ONE_USDC, &ev.pubkey(), CCTP_TMM);
    assert!(w.send(&[ix], &[&operator, &ev]).unwrap_err().contains("InvalidDestinationDomain"));
    assert_eq!(w.token_amount(&vault), 300 * ONE_USDC);

    // a short vault does not stop payouts: they fall back to claims (the
    // operator's power is liveness, not custody)
    let ix = rebalance_ix(&w, &operator.pubkey(), BASE, 6, 300 * ONE_USDC, &ev.pubkey(), CCTP_TMM);
    w.send(&[ix], &[&operator, &ev]).unwrap();
    assert_eq!(w.token_amount(&vault), 0);
}

fn hex_addr(s: &str) -> [u8; 20] {
    let mut out = [0u8; 20];
    for i in 0..20 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}
