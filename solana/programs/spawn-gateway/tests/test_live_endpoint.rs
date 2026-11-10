//! Integration tests against the REAL LayerZero V2 devnet stack, loaded
//! locally into LiteSVM: the endpoint, ULN, executor, price feed and DVN
//! program binaries plus their devnet state accounts (fetched by
//! `solana/tests/fetch-fixtures.sh` — run it once before `cargo test`).
//!
//! What this file PROVES without a single devnet write:
//!   - `init_store`'s register_oapp CPI succeeds against the real endpoint
//!     and leaves the OAppRegistry PDA with our admin as delegate;
//!   - the delegate can run the real wiring dance (init_send_library,
//!     init_receive_library, init_nonce) exactly as the devnet deploy will;
//!   - the self-quoting send path works end-to-end for all four ops: the
//!     real ULN + executor + DVN + price feed quote a NONZERO fee from the
//!     dumped devnet configs, the gas tank reimburses the payer, the
//!     endpoint accepts the packet (outbound nonce increments) and the
//!     emitted packet carries our codec's bytes verbatim.
//!
//! What only devnet can still prove: the funded program deploy, and the
//! live DVN/executor actually DELIVERING (they only watch the real chain).

use {
    anchor_lang::{AnchorSerialize, InstructionData, ToAccountMetas},
    litesvm::LiteSVM,
    solana_sdk::{
        account::Account,
        hash::hash as sha256,
        instruction::{AccountMeta, Instruction},
        message::{Message, VersionedMessage},
        pubkey::Pubkey,
        signature::{Keypair, Signer},
        transaction::VersionedTransaction,
    },
    spawn_gateway::msg_codec::{Envelope, SpawnMsg, U256, WireAddr},
    std::path::Path,
};

const TOKEN_PROGRAM: Pubkey =
    anchor_lang::solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM: Pubkey = anchor_lang::solana_program::pubkey!("11111111111111111111111111111111");

const ENDPOINT: Pubkey =
    anchor_lang::solana_program::pubkey!("76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6");
const ULN: Pubkey =
    anchor_lang::solana_program::pubkey!("7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH");
const EXECUTOR: Pubkey =
    anchor_lang::solana_program::pubkey!("6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn");
const PRICEFEED: Pubkey =
    anchor_lang::solana_program::pubkey!("8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP");
const DVN: Pubkey =
    anchor_lang::solana_program::pubkey!("HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW");

const HUB_EID: u32 = 40245; // Base Sepolia
/// The live Base Sepolia LayerZeroOmniMessenger adapter (reused v2→v4).
const HUB_ADAPTER: [u8; 20] = [
    0x59, 0xB8, 0x88, 0xbE, 0xB9, 0xa9, 0xC0, 0x47, 0xe4, 0xa6, 0x03, 0xef, 0x52, 0x28, 0x1c,
    0xBC, 0x0f, 0x04, 0x61, 0x00,
];

fn hub_peer() -> [u8; 32] {
    let mut p = [0u8; 32];
    p[12..].copy_from_slice(&HUB_ADAPTER);
    p
}

/// The hub pad's wide identity: an arbitrary EVM-shaped word for the test.
const HUB_PAD: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xc3, 0x63, 0x0f, 0xa4, 0x9b, 0x56, 0x40, 0x31, 0x66,
    0x9a, 0x0c, 0x14, 0x75, 0x09, 0x62, 0x0a, 0xe2, 0xfb, 0x1c, 0x77,
];

/// What the wire must carry (v5): the op payload inside the inter-transport
/// envelope — the store as protocol sender, the hub pad as target.
fn enveloped(store: &Pubkey, inner: Vec<u8>) -> Vec<u8> {
    Envelope {
        src_sender: WireAddr(store.to_bytes()),
        dst_addr: WireAddr(HUB_PAD),
        payload: inner,
    }
    .encode()
}

/// Type-3 options paying the executor for 4M gas of lzReceive — bit-for-bit
/// the OPTIONS constant of the EVM deploy script.
fn options_4m() -> Vec<u8> {
    let mut o = vec![0x00, 0x03, 0x01, 0x00, 0x11, 0x01];
    o.extend_from_slice(&4_000_000u128.to_be_bytes());
    o
}

fn fixture(name: &str) -> Vec<u8> {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/fixtures/{name}"));
    std::fs::read(&p).unwrap_or_else(|_| {
        panic!("missing fixture {p:?} — run solana/tests/fetch-fixtures.sh first")
    })
}

fn anchor_sighash(name: &str) -> [u8; 8] {
    sha256(format!("global:{name}").as_bytes()).to_bytes()[..8].try_into().unwrap()
}

struct Live {
    svm: LiteSVM,
    payer: Keypair,
    program: Pubkey,
    store: Pubkey,
    peer: Pubkey,
    usd_mint: Pubkey,
    gas_tank: Pubkey,
    nonce: Pubkey,
    /// from the dumped devnet default SendConfig
    required_dvns: Vec<Pubkey>,
    executor_cfg: Pubkey,
    treasury: Option<Pubkey>,
}

impl Live {
    fn send_tx(&mut self, ix: Instruction) -> std::result::Result<litesvm::types::TransactionMetadata, String> {
        let blockhash = self.svm.latest_blockhash();
        // the quote+send cascade through 5 real programs runs well past the
        // 200k default — the devnet client sets the same budget
        let budget =
            solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(1_400_000);
        let msg =
            Message::new_with_blockhash(&[budget, ix], Some(&self.payer.pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&self.payer])
            .map_err(|e| e.to_string())?;
        let r = self
            .svm
            .send_transaction(tx)
            .map_err(|e| format!("{:?}\nlogs:\n{}", e.err, e.meta.logs.join("\n")));
        self.svm.expire_blockhash();
        r
    }

    fn pda(&self, seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(seeds, program).0
    }

    /// The endpoint-send account list in the exact order send_to_hub.rs
    /// documents, with the writability each hop requires.
    fn send_list(&self) -> Vec<AccountMeta> {
        let slc = self.pda(
            &[b"SendLibraryConfig", &self.store.to_bytes(), &HUB_EID.to_be_bytes()],
            &ENDPOINT,
        );
        let dslc = self.pda(&[b"SendLibraryConfig", &HUB_EID.to_be_bytes()], &ENDPOINT);
        let msglib = self.pda(&[b"MessageLib"], &ULN);
        let sli = self.pda(&[b"MessageLib", &msglib.to_bytes()], &ENDPOINT);
        let endpoint_settings = self.pda(&[b"Endpoint"], &ENDPOINT);
        let ep_event = self.pda(&[b"__event_authority"], &ENDPOINT);
        let send_cfg =
            self.pda(&[b"SendConfig", &HUB_EID.to_be_bytes(), &self.store.to_bytes()], &ULN);
        let default_send_cfg = self.pda(&[b"SendConfig", &HUB_EID.to_be_bytes()], &ULN);
        let uln_event = self.pda(&[b"__event_authority"], &ULN);
        let price_feed = self.pda(&[b"PriceFeed"], &PRICEFEED);

        let mut v = vec![
            AccountMeta::new_readonly(ENDPOINT, false),
            AccountMeta::new_readonly(self.store, false),
            AccountMeta::new_readonly(ULN, false),
            AccountMeta::new_readonly(slc, false),
            AccountMeta::new_readonly(dslc, false),
            AccountMeta::new_readonly(sli, false), // MUST stay read-only
            AccountMeta::new_readonly(endpoint_settings, false),
            AccountMeta::new(self.nonce, false),
            AccountMeta::new_readonly(ep_event, false),
            AccountMeta::new_readonly(ENDPOINT, false),
            AccountMeta::new_readonly(msglib, false), // uln settings (ULN_SEED == MessageLib)
            AccountMeta::new_readonly(send_cfg, false),
            AccountMeta::new_readonly(default_send_cfg, false),
            AccountMeta::new(self.payer.pubkey(), true),
            match self.treasury {
                Some(t) => AccountMeta::new(t, false),
                None => AccountMeta::new_readonly(ULN, false), // Anchor's None placeholder
            },
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(uln_event, false),
            AccountMeta::new_readonly(ULN, false),
            // executor quad
            AccountMeta::new_readonly(EXECUTOR, false),
            AccountMeta::new(self.executor_cfg, false),
            AccountMeta::new_readonly(PRICEFEED, false),
            AccountMeta::new_readonly(price_feed, false),
        ];
        for dvn_cfg in &self.required_dvns {
            v.push(AccountMeta::new_readonly(DVN, false));
            v.push(AccountMeta::new(*dvn_cfg, false));
            v.push(AccountMeta::new_readonly(PRICEFEED, false));
            v.push(AccountMeta::new_readonly(price_feed, false));
        }
        v
    }

    fn outbound_nonce(&self) -> u64 {
        let data = self.svm.get_account(&self.nonce).unwrap().data;
        u64::from_le_bytes(data[9..17].try_into().unwrap())
    }

    /// Synthetic SPL token account (165 bytes) holding `amount` of `mint`.
    fn plant_token_account(&mut self, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Pubkey {
        let addr = Pubkey::new_unique();
        let mut data = vec![0u8; 165];
        data[0..32].copy_from_slice(&mint.to_bytes());
        data[32..64].copy_from_slice(&owner.to_bytes());
        data[64..72].copy_from_slice(&amount.to_le_bytes());
        data[108] = 1; // state = Initialized
        self.svm
            .set_account(
                addr,
                Account {
                    lamports: 10_000_000,
                    data,
                    owner: TOKEN_PROGRAM,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        addr
    }

    /// Bumps an SPL mint's supply so synthetic balances can be burned.
    fn raise_mint_supply(&mut self, mint: &Pubkey, amount: u64) {
        let mut acc = self.svm.get_account(mint).unwrap();
        let cur = u64::from_le_bytes(acc.data[36..44].try_into().unwrap());
        acc.data[36..44].copy_from_slice(&(cur + amount).to_le_bytes());
        self.svm.set_account(*mint, acc).unwrap();
    }
}

fn setup_live() -> Live {
    let program = spawn_gateway::id();
    let payer = Keypair::new();
    let mut svm = LiteSVM::new();
    svm.add_program(program, include_bytes!("../../../target/deploy/spawn_gateway.so"));
    svm.add_program(ENDPOINT, &fixture("endpoint.so"));
    svm.add_program(ULN, &fixture("uln.so"));
    svm.add_program(EXECUTOR, &fixture("executor.so"));
    svm.add_program(PRICEFEED, &fixture("pricefeed.so"));
    svm.add_program(DVN, &fixture("dvn.so"));

    // devnet state snapshots
    let accounts: Vec<serde_json::Value> =
        serde_json::from_slice(&fixture("accounts.json")).unwrap();
    let mut uln_settings_data = Vec::new();
    let mut default_send_cfg_data = Vec::new();
    for a in &accounts {
        let pubkey: Pubkey = a["pubkey"].as_str().unwrap().parse().unwrap();
        let owner: Pubkey = a["owner"].as_str().unwrap().parse().unwrap();
        use base64::Engine;
        let data =
            base64::engine::general_purpose::STANDARD.decode(a["data_b64"].as_str().unwrap()).unwrap();
        match a["name"].as_str().unwrap() {
            "uln_settings" => uln_settings_data = data.clone(),
            "default_send_config" => default_send_cfg_data = data.clone(),
            _ => {}
        }
        svm.set_account(
            pubkey,
            Account { lamports: a["lamports"].as_u64().unwrap(), data, owner, executable: false, rent_epoch: 0 },
        )
        .unwrap();
    }

    // UlnSettings: disc(8) eid(4) endpoint(32) endpoint_program(32) bump(1)
    // admin(32), then Option<Treasury>{ admin: Option<Pubkey>,
    // native_receiver, fee_bps, lz: Option }
    let treasury = {
        let d = &uln_settings_data;
        let mut off = 8 + 4 + 32 + 32 + 1 + 32;
        if d[off] == 1 {
            off += 1;
            if d[off] == 1 { off += 33 } else { off += 1 } // treasury.admin
            Some(Pubkey::new_from_array(d[off..off + 32].try_into().unwrap()))
        } else {
            None
        }
    };

    // SendConfig: disc(8) bump(1) UlnConfig{confirmations u64, counts u8×3,
    // required_dvns Vec<Pubkey>, optional_dvns Vec<Pubkey>} ExecutorConfig{
    // max_message_size u32, executor Pubkey}
    let (required_dvns, executor_cfg) = {
        let d = &default_send_cfg_data;
        let mut off = 8 + 1 + 8 + 3;
        let n = u32::from_le_bytes(d[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        let required: Vec<Pubkey> = (0..n)
            .map(|i| Pubkey::new_from_array(d[off + i * 32..off + (i + 1) * 32].try_into().unwrap()))
            .collect();
        off += n * 32;
        let n_opt = u32::from_le_bytes(d[off..off + 4].try_into().unwrap()) as usize;
        off += 4 + n_opt * 32 + 4; // optional dvns + max_message_size
        let executor = Pubkey::new_from_array(d[off..off + 32].try_into().unwrap());
        (required, executor)
    };

    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

    let (store, _) = Pubkey::find_program_address(&[b"Store"], &program);
    let (types_acc, _) = Pubkey::find_program_address(&[b"LzReceiveTypes", store.as_ref()], &program);
    let (peer, _) =
        Pubkey::find_program_address(&[b"Peer", store.as_ref(), &HUB_EID.to_be_bytes()], &program);
    let (usd_mint, _) = Pubkey::find_program_address(&[b"UsdMint"], &program);
    let (gas_tank, _) = Pubkey::find_program_address(&[b"GasTank"], &program);
    let oapp_registry = Pubkey::find_program_address(&[b"OApp", store.as_ref()], &ENDPOINT).0;
    let ep_event = Pubkey::find_program_address(&[b"__event_authority"], &ENDPOINT).0;
    let nonce = Pubkey::find_program_address(
        &[b"Nonce", store.as_ref(), &HUB_EID.to_be_bytes(), &hub_peer()],
        &ENDPOINT,
    )
    .0;

    let mut w = Live {
        svm,
        payer,
        program,
        store,
        peer,
        usd_mint,
        gas_tank,
        nonce,
        required_dvns,
        executor_cfg,
        treasury,
    };

    // ---- init_store with the REAL endpoint: register_oapp CPI runs live
    let mut metas = spawn_gateway::accounts::InitStore {
        payer: w.payer.pubkey(),
        store,
        lz_receive_types_accounts: types_acc,
        alt: None,
        system_program: SYSTEM,
    }
    .to_account_metas(None);
    metas.extend([
        AccountMeta::new_readonly(ENDPOINT, false),
        AccountMeta::new(w.payer.pubkey(), true),
        AccountMeta::new_readonly(store, false),
        AccountMeta::new(oapp_registry, false),
        AccountMeta::new_readonly(SYSTEM, false),
        AccountMeta::new_readonly(ep_event, false),
        AccountMeta::new_readonly(ENDPOINT, false),
    ]);
    w.send_tx(Instruction::new_with_bytes(
        program,
        &spawn_gateway::instruction::InitStore {
            params: spawn_gateway::instructions::InitStoreParams {
                admin: w.payer.pubkey(),
                endpoint: ENDPOINT,
                hub_eid: HUB_EID,
                hub_pad: HUB_PAD,
            },
        }
        .data(),
        metas,
    ))
    .expect("init_store + register_oapp against the real endpoint");

    // ---- peer + enforced options + oUSD mint
    for config in [
        spawn_gateway::instructions::PeerConfigParam::PeerAddress(hub_peer()),
        spawn_gateway::instructions::PeerConfigParam::EnforcedOptions {
            send: options_4m(),
            send_and_call: options_4m(),
        },
    ] {
        w.send_tx(Instruction::new_with_bytes(
            program,
            &spawn_gateway::instruction::SetPeerConfig {
                params: spawn_gateway::instructions::SetPeerConfigParams {
                    remote_eid: HUB_EID,
                    config,
                },
            }
            .data(),
            spawn_gateway::accounts::SetPeerConfig {
                admin: w.payer.pubkey(),
                peer,
                store,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
        ))
        .unwrap();
    }
    w.send_tx(Instruction::new_with_bytes(
        program,
        &spawn_gateway::instruction::InitUsdMint {}.data(),
        spawn_gateway::accounts::InitUsdMint {
            admin: w.payer.pubkey(),
            store,
            usd_mint,
            system_program: SYSTEM,
            token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None),
    ))
    .unwrap();

    // ---- the delegate's wiring dance, straight against the real endpoint
    let slc = w.pda(
        &[b"SendLibraryConfig", &store.to_bytes(), &HUB_EID.to_be_bytes()],
        &ENDPOINT,
    );
    let rlc = w.pda(
        &[b"ReceiveLibraryConfig", &store.to_bytes(), &HUB_EID.to_be_bytes()],
        &ENDPOINT,
    );
    let pending = w.pda(
        &[b"PendingNonce", &store.to_bytes(), &HUB_EID.to_be_bytes(), &hub_peer()],
        &ENDPOINT,
    );

    let mut data = anchor_sighash("init_send_library").to_vec();
    data.extend_from_slice(&store.to_bytes());
    data.extend_from_slice(&HUB_EID.to_le_bytes());
    w.send_tx(Instruction::new_with_bytes(
        ENDPOINT,
        &data,
        vec![
            AccountMeta::new(w.payer.pubkey(), true),
            AccountMeta::new_readonly(oapp_registry, false),
            AccountMeta::new(slc, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
    ))
    .expect("init_send_library");

    let mut data = anchor_sighash("init_receive_library").to_vec();
    data.extend_from_slice(&store.to_bytes());
    data.extend_from_slice(&HUB_EID.to_le_bytes());
    w.send_tx(Instruction::new_with_bytes(
        ENDPOINT,
        &data,
        vec![
            AccountMeta::new(w.payer.pubkey(), true),
            AccountMeta::new_readonly(oapp_registry, false),
            AccountMeta::new(rlc, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
    ))
    .expect("init_receive_library");

    let mut data = anchor_sighash("init_nonce").to_vec();
    data.extend_from_slice(&store.to_bytes());
    data.extend_from_slice(&HUB_EID.to_le_bytes());
    data.extend_from_slice(&hub_peer());
    w.send_tx(Instruction::new_with_bytes(
        ENDPOINT,
        &data,
        vec![
            AccountMeta::new(w.payer.pubkey(), true),
            AccountMeta::new_readonly(oapp_registry, false),
            AccountMeta::new(w.nonce, false),
            AccountMeta::new(pending, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
    ))
    .expect("init_nonce");

    // ---- fund the gas tank (anyone can: plain transfer / airdrop)
    w.svm.airdrop(&gas_tank, 10_000_000_000).unwrap();
    w
}

/// Runs one outbound op and returns (quoted-fee-paid-by-tank, tx metadata).
fn run_send(
    w: &mut Live,
    data: Vec<u8>,
    business: Vec<AccountMeta>,
) -> (u64, litesvm::types::TransactionMetadata) {
    let mut metas = business;
    metas.extend(w.send_list());
    let tank_before = w.svm.get_account(&w.gas_tank).unwrap().lamports;
    let meta = w
        .send_tx(Instruction::new_with_bytes(w.program, &data, metas))
        .expect("send op against the real endpoint stack");
    let tank_after = w.svm.get_account(&w.gas_tank).unwrap().lamports;
    (tank_before - tank_after, meta)
}

/// The emitted packet must carry our codec's bytes verbatim. The endpoint's
/// PacketSentEvent rides an event-CPI (an inner instruction), so scan every
/// inner instruction's data for the exact message bytes.
fn assert_packet_carries(meta: &litesvm::types::TransactionMetadata, message: &[u8]) {
    let found = meta.inner_instructions.iter().flatten().any(|ix| {
        ix.instruction.data.windows(message.len()).any(|wnd| wnd == message)
    });
    assert!(found, "emitted packet does not embed the encoded message");
}

#[test]
fn registers_against_real_endpoint() {
    let w = setup_live();
    let oapp_registry =
        Pubkey::find_program_address(&[b"OApp", w.store.as_ref()], &ENDPOINT).0;
    let acc = w.svm.get_account(&oapp_registry).expect("OAppRegistry created");
    assert_eq!(acc.owner, ENDPOINT);
    // OAppRegistry: disc(8) + delegate(32) + bump
    assert_eq!(&acc.data[8..40], w.payer.pubkey().to_bytes().as_slice(), "delegate");
    // the wiring dance left the outbound nonce account live at zero
    assert_eq!(w.outbound_nonce(), 0);
}

#[test]
fn spawn_quotes_pays_and_emits() {
    let mut w = setup_live();
    let user_usd = w.plant_token_account(&w.usd_mint.clone(), &w.payer.pubkey(), 50_000_000);
    w.raise_mint_supply(&w.usd_mint.clone(), 50_000_000);

    let params = spawn_gateway::instructions::SpawnTokenParams {
        name: "OMNI SOL".into(),
        symbol: "OSOL".into(),
        meta_uri: "{\"leg\":\"solana\"}".into(),
        dev_buy_usd: 5_000_000, // $5
        fee_mode: 1,
    };
    let data = spawn_gateway::instruction::SpawnToken { params: params.clone() }.data();
    let business = spawn_gateway::accounts::SpawnToken {
        user: w.payer.pubkey(),
        store: w.store,
        peer: w.peer,
        gas_tank: w.gas_tank,
        usd_mint: w.usd_mint,
        user_usd,
        token_program: TOKEN_PROGRAM,
        system_program: SYSTEM,
    }
    .to_account_metas(None);
    let (fee, meta) = run_send(&mut w, data, business);

    assert!(fee > 0, "real devnet configs must quote a nonzero fee");
    assert_eq!(w.outbound_nonce(), 1);
    let expected = SpawnMsg::Spawn {
        creator: WireAddr::from_pubkey(&w.payer.pubkey()),
        name: "OMNI SOL".into(),
        symbol: "OSOL".into(),
        meta_uri: "{\"leg\":\"solana\"}".into(),
        dev_buy_usd: U256::from_spl_amount(5_000_000),
        fee_mode: 1,
    }
    .encode();
    let expected = enveloped(&w.store, expected);
    assert_packet_carries(&meta, &expected);
    // the $5 dev buy burned
    let bal = u64::from_le_bytes(
        w.svm.get_account(&user_usd).unwrap().data[64..72].try_into().unwrap(),
    );
    assert_eq!(bal, 45_000_000);
}

#[test]
fn buy_sell_claim_round_the_nonce() {
    let mut w = setup_live();
    let hub_token = [0x8bu8; 32];

    // --- buy: burn oUSD, ship OP_BUY
    let user_usd = w.plant_token_account(&w.usd_mint.clone(), &w.payer.pubkey(), 9_000_000);
    w.raise_mint_supply(&w.usd_mint.clone(), 9_000_000);
    let data = spawn_gateway::instruction::BuyToken {
        params: spawn_gateway::instructions::BuyTokenParams { hub_token, usd_in: 5_000_000 },
    }
    .data();
    let business = spawn_gateway::accounts::BuyToken {
        user: w.payer.pubkey(),
        store: w.store,
        peer: w.peer,
        gas_tank: w.gas_tank,
        usd_mint: w.usd_mint,
        user_usd,
        token_program: TOKEN_PROGRAM,
        system_program: SYSTEM,
    }
    .to_account_metas(None);
    let (fee, meta) = run_send(&mut w, data, business);
    assert!(fee > 0);
    assert_eq!(w.outbound_nonce(), 1);
    let expected = SpawnMsg::Buy {
        hub_token: WireAddr(hub_token),
        buyer: WireAddr::from_pubkey(&w.payer.pubkey()),
        usd_in: U256::from_spl_amount(5_000_000),
    }
    .encode();
    let expected = enveloped(&w.store, expected);
    assert_packet_carries(&meta, &expected);

    // --- sell: plant a synced replica + bag, burn it, ship OP_SELL
    let (replica_pda, replica_bump) =
        Pubkey::find_program_address(&[b"Replica", &hub_token], &w.program);
    let (mint_pda, _) = Pubkey::find_program_address(&[b"Mint", &hub_token], &w.program);
    // SPL mint: COption tag(4) + authority(32) + supply u64 @36 + decimals @44 + initialized @45
    let mut mint_data = vec![0u8; 82];
    mint_data[0..4].copy_from_slice(&1u32.to_le_bytes());
    mint_data[4..36].copy_from_slice(&w.store.to_bytes());
    mint_data[36..44].copy_from_slice(&800_000_000_000u64.to_le_bytes());
    mint_data[44] = 6;
    mint_data[45] = 1;
    w.svm
        .set_account(
            mint_pda,
            Account { lamports: 10_000_000, data: mint_data, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 },
        )
        .unwrap();
    let replica = spawn_gateway::state::Replica {
        hub_token,
        mint: mint_pda,
        name: "OMNI SOL".into(),
        symbol: "OSOL".into(),
        bump: replica_bump,
    };
    let mut replica_data = Vec::new();
    use anchor_lang::Discriminator;
    replica_data.extend_from_slice(spawn_gateway::state::Replica::DISCRIMINATOR);
    replica.serialize(&mut replica_data).unwrap();
    replica_data.resize(spawn_gateway::state::Replica::SIZE, 0);
    w.svm
        .set_account(
            replica_pda,
            Account { lamports: 10_000_000, data: replica_data, owner: w.program, executable: false, rent_epoch: 0 },
        )
        .unwrap();
    let user_token = w.plant_token_account(&mint_pda, &w.payer.pubkey(), 800_000_000_000);

    let data = spawn_gateway::instruction::SellToken {
        params: spawn_gateway::instructions::SellTokenParams { hub_token, amount: 123_456_789 },
    }
    .data();
    let business = spawn_gateway::accounts::SellToken {
        user: w.payer.pubkey(),
        store: w.store,
        peer: w.peer,
        gas_tank: w.gas_tank,
        replica: replica_pda,
        mint: mint_pda,
        user_token,
        token_program: TOKEN_PROGRAM,
        system_program: SYSTEM,
    }
    .to_account_metas(None);
    let (fee, meta) = run_send(&mut w, data, business);
    assert!(fee > 0);
    assert_eq!(w.outbound_nonce(), 2);
    let expected = SpawnMsg::Sell {
        hub_token: WireAddr(hub_token),
        seller: WireAddr::from_pubkey(&w.payer.pubkey()),
        tokens_in: U256::from_spl_amount(123_456_789),
    }
    .encode();
    let expected = enveloped(&w.store, expected);
    assert_packet_carries(&meta, &expected);

    // --- claim: pure message
    let data = spawn_gateway::instruction::ClaimFees {
        params: spawn_gateway::instructions::ClaimFeesParams { hub_token },
    }
    .data();
    let business = spawn_gateway::accounts::ClaimFees {
        user: w.payer.pubkey(),
        store: w.store,
        peer: w.peer,
        gas_tank: w.gas_tank,
        system_program: SYSTEM,
    }
    .to_account_metas(None);
    let (fee, meta) = run_send(&mut w, data, business);
    assert!(fee > 0);
    assert_eq!(w.outbound_nonce(), 3);
    let expected = SpawnMsg::Claim {
        hub_token: WireAddr(hub_token),
        claimer: WireAddr::from_pubkey(&w.payer.pubkey()),
    }
    .encode();
    let expected = enveloped(&w.store, expected);
    assert_packet_carries(&meta, &expected);
}

#[test]
fn empty_tank_blocks_the_send() {
    let mut w = setup_live();
    // drain the tank below any plausible quote
    let tank = w.gas_tank;
    let mut acc = w.svm.get_account(&tank).unwrap();
    acc.lamports = 1;
    w.svm.set_account(tank, acc).unwrap();

    let data = spawn_gateway::instruction::ClaimFees {
        params: spawn_gateway::instructions::ClaimFeesParams { hub_token: [9u8; 32] },
    }
    .data();
    let mut metas = spawn_gateway::accounts::ClaimFees {
        user: w.payer.pubkey(),
        store: w.store,
        peer: w.peer,
        gas_tank: w.gas_tank,
        system_program: SYSTEM,
    }
    .to_account_metas(None);
    metas.extend(w.send_list());
    let err = w
        .send_tx(Instruction::new_with_bytes(w.program, &data, metas))
        .unwrap_err();
    assert!(err.contains("TankTooPoor") || err.contains("Error"), "unexpected: {err}");
}
