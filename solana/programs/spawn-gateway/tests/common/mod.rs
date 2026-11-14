//! Shared plumbing of the integration tests: PDAs, synthetic token
//! accounts, and the two worlds the program is exercised in —
//!
//!  - the SENTINEL world (`World::sentinel`): the store is initialized with
//!    the test-sentinel endpoint, so `lz_receive` can be driven directly and
//!    every handler and user instruction tested in isolation;
//!  - the LIVE world (`World::live`): the REAL LayerZero V2 programs and
//!    state of Solana MAINNET, dumped by `solana/tests/fetch-fixtures.sh`
//!    and loaded into LiteSVM — endpoint, ULN, executor, price feed, every
//!    DVN of the default Solana→Base pathway — plus Circle's real USDC mint.
#![allow(dead_code)]

use {
    anchor_lang::{InstructionData, ToAccountMetas},
    litesvm::{types::TransactionMetadata, LiteSVM},
    solana_sdk::{
        account::Account,
        compute_budget::ComputeBudgetInstruction,
        hash::hash as sha256,
        instruction::{AccountMeta, Instruction},
        message::{Message, VersionedMessage},
        pubkey::Pubkey,
        signature::{Keypair, Signer},
        transaction::VersionedTransaction,
    },
    spawn_gateway::msg_codec::{Envelope, SpawnMsg, WireAddr, U256},
    std::path::Path,
};

pub const TOKEN_PROGRAM: Pubkey =
    anchor_lang::solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM: Pubkey =
    anchor_lang::solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM: Pubkey = anchor_lang::solana_program::pubkey!("11111111111111111111111111111111");

pub const ENDPOINT: Pubkey =
    anchor_lang::solana_program::pubkey!("76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6");
pub const ULN: Pubkey =
    anchor_lang::solana_program::pubkey!("7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH");
pub const EXECUTOR: Pubkey =
    anchor_lang::solana_program::pubkey!("6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn");
pub const PRICEFEED: Pubkey =
    anchor_lang::solana_program::pubkey!("8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP");
/// Circle's native USDC on Solana mainnet — the real mint account is loaded
/// from the fixtures in both worlds.
pub const USDC: Pubkey =
    anchor_lang::solana_program::pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// Base mainnet — the live hub.
pub const HUB_EID: u32 = 30184;
/// The live hub adapter and pad on Base (contracts/deployments/mainnet.json).
pub const HUB_ADAPTER: [u8; 20] = hex20("c030EB69fba66A8A123f7EB1450cA3249654Ce34");
pub const HUB_PAD_EVM: [u8; 20] = hex20("C2f3855ECcB6bD2261831743Ece9752ec9E53811");

const fn hexval(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("bad hex"),
    }
}
const fn hex20(s: &str) -> [u8; 20] {
    let b = s.as_bytes();
    let mut out = [0u8; 20];
    let mut i = 0;
    while i < 20 {
        out[i] = hexval(b[2 * i]) * 16 + hexval(b[2 * i + 1]);
        i += 1;
    }
    out
}

pub fn pad32(a: &[u8; 20]) -> [u8; 32] {
    let mut p = [0u8; 32];
    p[12..].copy_from_slice(a);
    p
}
pub fn hub_peer() -> [u8; 32] {
    pad32(&HUB_ADAPTER)
}
pub fn hub_pad() -> [u8; 32] {
    pad32(&HUB_PAD_EVM)
}

pub const ONE_USDC: u64 = 1_000_000;
pub const ONE_TOKEN: u64 = 1_000_000;
pub const E12: u128 = 1_000_000_000_000;
pub const E18: u128 = 1_000_000_000_000_000_000;

pub fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

pub fn ata_of(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    pda(&[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()], &ATA_PROGRAM)
}

pub fn anchor_sighash(name: &str) -> [u8; 8] {
    sha256(format!("global:{name}").as_bytes()).to_bytes()[..8].try_into().unwrap()
}

pub fn account_disc(name: &str) -> [u8; 8] {
    sha256(format!("account:{name}").as_bytes()).to_bytes()[..8].try_into().unwrap()
}

pub fn fixture(name: &str) -> Vec<u8> {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/fixtures/mainnet/{name}"));
    std::fs::read(&p)
        .unwrap_or_else(|_| panic!("missing fixture {p:?} — run solana/tests/fetch-fixtures.sh first"))
}

pub struct FixtureAccount {
    pub name: String,
    pub dvn: Option<String>,
    pub pubkey: Pubkey,
    pub owner: Pubkey,
    pub lamports: u64,
    pub data: Vec<u8>,
}

pub fn fixture_accounts() -> Vec<FixtureAccount> {
    use base64::Engine;
    let raw: Vec<serde_json::Value> = serde_json::from_slice(&fixture("accounts.json")).unwrap();
    raw.iter()
        .map(|a| FixtureAccount {
            name: a["name"].as_str().unwrap().to_string(),
            dvn: a["dvn"].as_str().map(|s| s.to_string()),
            pubkey: a["pubkey"].as_str().unwrap().parse().unwrap(),
            owner: a["owner"].as_str().unwrap().parse().unwrap(),
            lamports: a["lamports"].as_u64().unwrap(),
            data: base64::engine::general_purpose::STANDARD
                .decode(a["data_b64"].as_str().unwrap())
                .unwrap(),
        })
        .collect()
}

/// A hub token id: an EVM address left-padded, as the hub always sends it.
pub fn token_id(tag: u8) -> [u8; 32] {
    let mut t = [0u8; 32];
    t[12..].copy_from_slice(&[tag; 20]);
    t
}

pub struct Ids {
    pub program: Pubkey,
    pub store: Pubkey,
    pub types_acc: Pubkey,
    pub peer: Pubkey,
    pub vault: Pubkey,
    pub tank: Pubkey,
}

impl Ids {
    pub fn new() -> Self {
        let program = spawn_gateway::id();
        let store = pda(&[b"Store"], &program);
        Self {
            program,
            store,
            types_acc: pda(&[b"LzReceiveTypes", store.as_ref()], &program),
            peer: pda(&[b"Peer", store.as_ref(), &HUB_EID.to_be_bytes()], &program),
            vault: pda(&[b"Vault"], &program),
            tank: pda(&[b"GasTank"], &program),
        }
    }
    pub fn replica(&self, hub_token: &[u8; 32]) -> Pubkey {
        pda(&[b"Replica", hub_token], &self.program)
    }
    pub fn mint(&self, hub_token: &[u8; 32]) -> Pubkey {
        pda(&[b"Mint", hub_token], &self.program)
    }
    pub fn escrow(&self, hub_token: &[u8; 32]) -> Pubkey {
        pda(&[b"Escrow", hub_token], &self.program)
    }
    pub fn user(&self, owner: &Pubkey) -> Pubkey {
        pda(&[b"User", owner.as_ref()], &self.program)
    }
    pub fn position(&self, hub_token: &[u8; 32], owner: &Pubkey) -> Pubkey {
        pda(&[b"Pos", hub_token, owner.as_ref()], &self.program)
    }
    pub fn move_route(&self, dst_chain: u32) -> Pubkey {
        pda(&[b"Move", &dst_chain.to_be_bytes()], &self.program)
    }
    pub fn cctp_peer(&self, label: u32) -> Pubkey {
        pda(&[b"CctpPeer", &label.to_be_bytes()], &self.program)
    }
}

/// What the live world knows about the real LayerZero stack it loaded.
pub struct Lz {
    pub nonce: Pubkey,
    pub oapp_registry: Pubkey,
    /// (dvn program, dvn config account) of the default Solana→Base pathway
    pub dvns: Vec<(Pubkey, Pubkey)>,
    pub executor_cfg: Pubkey,
    pub treasury: Option<Pubkey>,
}

pub struct World {
    pub svm: LiteSVM,
    /// admin of the store, and the fee payer of every test transaction
    pub admin: Keypair,
    /// the signer `lz_receive` sees as its payer (LayerZero's executor)
    pub exec: Keypair,
    pub ids: Ids,
    pub lz: Option<Lz>,
}

pub type TxResult = std::result::Result<TransactionMetadata, String>;

impl World {
    /// Sends `ixs` paid by the admin, with a compute budget large enough for
    /// the LayerZero cascade. Extra signers are appended.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        let blockhash = self.svm.latest_blockhash();
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(1_400_000)];
        all.extend_from_slice(ixs);
        let msg = Message::new_with_blockhash(&all, Some(&self.admin.pubkey()), &blockhash);
        let mut keys: Vec<&Keypair> = vec![&self.admin];
        for s in signers {
            if s.pubkey() != self.admin.pubkey() {
                keys.push(s);
            }
        }
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &keys).map_err(|e| e.to_string())?;
        let r = self
            .svm
            .send_transaction(tx)
            .map_err(|e| format!("{:?}\nlogs:\n{}", e.err, e.meta.logs.join("\n")));
        self.svm.expire_blockhash();
        r
    }

    /// Simulates one instruction and returns its Anchor return value bytes.
    pub fn simulate(&mut self, ix: Instruction) -> std::result::Result<Vec<u8>, String> {
        let blockhash = self.svm.latest_blockhash();
        let all = vec![ComputeBudgetInstruction::set_compute_unit_limit(1_400_000), ix];
        let msg = Message::new_with_blockhash(&all, Some(&self.admin.pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&self.admin])
            .map_err(|e| e.to_string())?;
        let r = self
            .svm
            .simulate_transaction(tx)
            .map_err(|e| format!("{:?}\nlogs:\n{}", e.err, e.meta.logs.join("\n")))?;
        Ok(r.meta.return_data.data)
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
    }

    pub fn token_amount(&self, account: &Pubkey) -> u64 {
        match self.svm.get_account(account) {
            Some(a) if a.data.len() >= 72 => u64::from_le_bytes(a.data[64..72].try_into().unwrap()),
            _ => 0,
        }
    }

    pub fn store(&self) -> spawn_gateway::state::Store {
        self.read(&self.ids.store)
    }

    pub fn read<T: anchor_lang::AccountDeserialize>(&self, key: &Pubkey) -> T {
        let acc = self.svm.get_account(key).unwrap_or_else(|| panic!("account {key} missing"));
        T::try_deserialize(&mut &acc.data[..]).unwrap()
    }

    pub fn exists(&self, key: &Pubkey) -> bool {
        self.svm.get_account(key).map(|a| a.lamports > 0 && !a.data.is_empty()).unwrap_or(false)
    }

    /// A synthetic SPL token account at `addr` (165 bytes).
    pub fn plant_token_account(&mut self, addr: Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64) {
        let mut data = vec![0u8; 165];
        data[0..32].copy_from_slice(&mint.to_bytes());
        data[32..64].copy_from_slice(&owner.to_bytes());
        data[64..72].copy_from_slice(&amount.to_le_bytes());
        data[108] = 1; // state = Initialized
        self.svm
            .set_account(
                addr,
                Account { lamports: 2_039_280, data, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 },
            )
            .unwrap();
    }

    /// The user's USDC associated token account, holding `amount`.
    pub fn give_usdc(&mut self, owner: &Pubkey, amount: u64) -> Pubkey {
        let ata = ata_of(owner, &USDC);
        self.plant_token_account(ata, &USDC, owner, amount);
        ata
    }

    pub fn set_token_amount(&mut self, account: &Pubkey, amount: u64) {
        let mut acc = self.svm.get_account(account).unwrap();
        acc.data[64..72].copy_from_slice(&amount.to_le_bytes());
        self.svm.set_account(*account, acc).unwrap();
    }

    /// Circle freezes a token account: state byte 2.
    pub fn freeze(&mut self, account: &Pubkey) {
        let mut acc = self.svm.get_account(account).unwrap();
        acc.data[108] = 2;
        self.svm.set_account(*account, acc).unwrap();
    }

    pub fn fund(&mut self, key: &Pubkey, lamports: u64) {
        self.svm.airdrop(key, lamports).unwrap();
    }

    pub fn set_lamports(&mut self, key: &Pubkey, lamports: u64) {
        let mut acc = self.svm.get_account(key).unwrap_or(Account {
            lamports: 0,
            data: vec![],
            owner: SYSTEM,
            executable: false,
            rent_epoch: 0,
        });
        acc.lamports = lamports;
        self.svm.set_account(*key, acc).unwrap();
    }

    pub fn new_user(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 5_000_000_000).unwrap();
        k
    }

    /* ---- governance shortcuts ---- */

    pub fn govern(&mut self, data: Vec<u8>, who: &Keypair) -> TxResult {
        let ix = Instruction::new_with_bytes(
            self.ids.program,
            &data,
            spawn_gateway::accounts::Govern { authority: who.pubkey(), store: self.ids.store }.to_account_metas(None),
        );
        self.send(&[ix], &[who])
    }

    pub fn set_fee_config(&mut self, gas_to_hub: u128, return_unit: u128, trade_legs: u8, spawn_legs: u8) {
        let admin = self.admin.insecure_clone();
        self.govern(
            spawn_gateway::instruction::SetFeeConfig {
                params: spawn_gateway::instructions::FeeConfigParams { gas_to_hub, return_unit, trade_legs, spawn_legs },
            }
            .data(),
            &admin,
        )
        .unwrap();
    }

    pub fn set_deposit_cap(&mut self, cap: u64) {
        let admin = self.admin.insecure_clone();
        self.govern(spawn_gateway::instruction::SetDepositCap { cap }.data(), &admin).unwrap();
    }

    pub fn unpause(&mut self) {
        let admin = self.admin.insecure_clone();
        self.govern(spawn_gateway::instruction::Unpause {}.data(), &admin).unwrap();
    }

    pub fn set_move_legs_ix(&self, who: &Pubkey, dst_chain: u32, legs: u16) -> Instruction {
        Instruction::new_with_bytes(
            self.ids.program,
            &spawn_gateway::instruction::SetMoveLegs { dst_chain, legs }.data(),
            spawn_gateway::accounts::SetMoveLegs {
                authority: *who,
                store: self.ids.store,
                route: self.ids.move_route(dst_chain),
                system_program: SYSTEM,
            }
            .to_account_metas(None),
        )
    }

    /// The operator's price for moves toward `dst_chain` (0 closes it).
    pub fn set_move_legs(&mut self, dst_chain: u32, legs: u16) {
        let ix = self.set_move_legs_ix(&self.admin.pubkey(), dst_chain, legs);
        self.send(&[ix], &[]).unwrap();
    }

    pub fn open_user_account(&mut self, owner: &Pubkey) {
        let ix = Instruction::new_with_bytes(
            self.ids.program,
            &spawn_gateway::instruction::OpenUserAccount {}.data(),
            spawn_gateway::accounts::OpenUserAccount {
                payer: self.admin.pubkey(),
                owner: *owner,
                user_account: self.ids.user(owner),
                system_program: SYSTEM,
            }
            .to_account_metas(None),
        );
        self.send(&[ix], &[]).unwrap();
    }

    /* ---- the wire ---- */

    /// A hub message as the hub adapter sends it: the op inside the
    /// envelope, the pad as protocol sender, this store as target — and no
    /// value: the pad prepays no reply.
    pub fn wire(&self, msg: &SpawnMsg) -> Vec<u8> {
        self.wire_with_value(msg, 0)
    }

    /// The same, had the hub adapter asked the executor to deliver `value`
    /// lamports with it (what v7.2's hub never does).
    pub fn wire_with_value(&self, msg: &SpawnMsg, value: u64) -> Vec<u8> {
        Envelope {
            src_sender: WireAddr(hub_pad()),
            dst_addr: WireAddr(self.ids.store.to_bytes()),
            payload: msg.encode(),
            value: U256::from_u128(value as u128),
        }
        .encode()
    }

    /* ---- op account lists, exactly as lz_receive.rs documents them ---- */

    /// The two accounts every hub message gets: the tank, the system program.
    fn common_accounts(&self) -> Vec<AccountMeta> {
        vec![AccountMeta::new(self.ids.tank, false), AccountMeta::new_readonly(SYSTEM, false)]
    }

    pub fn sync_accounts(&self, hub_token: &[u8; 32]) -> Vec<AccountMeta> {
        let mut v = self.common_accounts();
        v.extend([
            AccountMeta::new(self.ids.replica(hub_token), false),
            AccountMeta::new(self.ids.mint(hub_token), false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ]);
        v
    }

    pub fn deliver_accounts(&self, hub_token: &[u8; 32], to: &Pubkey) -> Vec<AccountMeta> {
        let mint = self.ids.mint(hub_token);
        let mut v = self.common_accounts();
        v.extend([
            AccountMeta::new(self.ids.replica(hub_token), false),
            AccountMeta::new(mint, false),
            AccountMeta::new_readonly(*to, false),
            AccountMeta::new(ata_of(to, &mint), false),
            AccountMeta::new(self.ids.user(to), false),
            AccountMeta::new_readonly(USDC, false),
            AccountMeta::new(self.ids.vault, false),
            AccountMeta::new(ata_of(to, &USDC), false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ]);
        v
    }

    pub fn payout_accounts(&self, to: &Pubkey) -> Vec<AccountMeta> {
        let mut v = self.common_accounts();
        v.extend([
            AccountMeta::new_readonly(*to, false),
            AccountMeta::new(self.ids.user(to), false),
            AccountMeta::new_readonly(USDC, false),
            AccountMeta::new(self.ids.vault, false),
            AccountMeta::new(ata_of(to, &USDC), false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ]);
        v
    }

    pub fn fee_drop_accounts(&self, hub_token: &[u8; 32]) -> Vec<AccountMeta> {
        let mut v = self.common_accounts();
        v.push(AccountMeta::new(self.ids.replica(hub_token), false));
        v
    }
}

/// Loads the program and Circle's real USDC mint; funds the admin.
pub fn base_world() -> World {
    let ids = Ids::new();
    let admin = Keypair::new();
    let exec = Keypair::new();
    let mut svm = LiteSVM::new();
    svm.add_program(ids.program, include_bytes!("../../../../target/deploy/spawn_gateway.so"));
    svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
    svm.airdrop(&exec.pubkey(), 1_000_000_000).unwrap();
    let usdc = fixture_accounts().into_iter().find(|a| a.name == "usdc_mint").expect("usdc_mint fixture");
    assert_eq!(usdc.pubkey, USDC);
    assert_eq!(usdc.owner, TOKEN_PROGRAM, "USDC is a classic SPL Token mint");
    assert_eq!(usdc.data[44], 6, "USDC has 6 decimals");
    svm.set_account(
        USDC,
        Account { lamports: usdc.lamports, data: usdc.data, owner: usdc.owner, executable: false, rent_epoch: 0 },
    )
    .unwrap();
    World { svm, admin, exec, ids, lz: None }
}

/// peer + vault — what both worlds do right after `init_store` — and the
/// operator's unpause: a store is born paused.
pub fn wire_store(w: &mut World) {
    assert!(w.store().paused, "a store must be born paused");
    let ix = Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::SetPeerConfig {
            params: spawn_gateway::instructions::SetPeerConfigParams { remote_eid: HUB_EID, peer_address: hub_peer() },
        }
        .data(),
        spawn_gateway::accounts::SetPeerConfig {
            admin: w.admin.pubkey(),
            peer: w.ids.peer,
            store: w.ids.store,
            system_program: SYSTEM,
        }
        .to_account_metas(None),
    );
    w.send(&[ix], &[]).unwrap();
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
    w.send(&[ix], &[]).expect("init_vault over the real USDC mint");
    w.unpause();
}

pub fn init_store_ix(w: &World, endpoint: Pubkey, extra: Vec<AccountMeta>) -> Instruction {
    let mut metas = spawn_gateway::accounts::InitStore {
        payer: w.admin.pubkey(),
        store: w.ids.store,
        lz_receive_types_accounts: w.ids.types_acc,
        alt: None,
        system_program: SYSTEM,
    }
    .to_account_metas(None);
    metas.extend(extra);
    Instruction::new_with_bytes(
        w.ids.program,
        &spawn_gateway::instruction::InitStore {
            params: spawn_gateway::instructions::InitStoreParams {
                admin: w.admin.pubkey(),
                endpoint,
                hub_eid: HUB_EID,
                hub_pad: hub_pad(),
            },
        }
        .data(),
        metas,
    )
}
