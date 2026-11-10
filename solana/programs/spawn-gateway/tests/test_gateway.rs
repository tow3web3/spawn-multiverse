//! LiteSVM integration tests for the phase-2a receive path.
//!
//! The store is initialized with the TEST SENTINEL endpoint (default pubkey),
//! so the endpoint CPIs (register_oapp, clear) are skipped and the
//! remaining_accounts of lz_receive start directly at the op accounts. What
//! these tests therefore PROVE: peer gating, codec-driven dispatch, replica
//! mint creation, the decimal bridge, ATA creation and minting for DELIVER /
//! PAYOUT / FEE_DROP, and the v4 recipient rule (the bytes32 wire rider IS
//! the recipient's pubkey, exactly). What they DEFER to devnet
//! (phase 2b): the real clear()/register CPIs and executor-driven account
//! resolution.

use {
    anchor_lang::{AnchorDeserialize, InstructionData, ToAccountMetas},
    litesvm::LiteSVM,
    oapp::LzReceiveParams,
    solana_sdk::{
        instruction::{AccountMeta, Instruction},
        message::{Message, VersionedMessage},
        pubkey::Pubkey,
        signature::{Keypair, Signer},
        transaction::VersionedTransaction,
    },
    spawn_gateway::msg_codec::{Envelope, SpawnMsg, U256, WireAddr},
};

const TOKEN_PROGRAM: Pubkey = anchor_lang::solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM: Pubkey = anchor_lang::solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM: Pubkey = anchor_lang::solana_program::pubkey!("11111111111111111111111111111111");

const HUB_EID: u32 = 40245;
/// The hub pad's wide identity (an EVM address left-padded), as the store
/// learns it at init and the envelope carries it.
const HUB_PAD: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xc3, 0x63, 0x0f, 0xa4, 0x9b, 0x56, 0x40, 0x31, 0x66,
    0x9a, 0x0c, 0x14, 0x75, 0x09, 0x62, 0x0a, 0xe2, 0xfb, 0x1c, 0x77,
];
// Deliberately a WIDE token id (every byte set): the Solana side treats wire
// token ids as opaque 32-byte seeds and must not impose any padding rule.
const HUB_TOKEN: [u8; 32] = [0x8b; 32];
const HUB_PEER_LAST20: [u8; 20] = [0x59; 20];

fn peer_bytes32() -> [u8; 32] {
    let mut p = [0u8; 32];
    p[12..].copy_from_slice(&HUB_PEER_LAST20);
    p
}

fn ata_of(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()],
        &ATA_PROGRAM,
    )
    .0
}

struct World {
    svm: LiteSVM,
    payer: Keypair,
    program: Pubkey,
    store: Pubkey,
    peer: Pubkey,
    usd_mint: Pubkey,
}

impl World {
    fn send(&mut self, ix: Instruction) -> std::result::Result<(), String> {
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(&[ix], Some(&self.payer.pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&self.payer])
            .map_err(|e| e.to_string())?;
        let r = self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err));
        self.svm.expire_blockhash();
        r
    }

    fn lz_receive(
        &mut self,
        msg: &SpawnMsg,
        rest: Vec<AccountMeta>,
    ) -> std::result::Result<(), String> {
        let params = LzReceiveParams {
            src_eid: HUB_EID,
            sender: peer_bytes32(),
            nonce: 1,
            guid: [0u8; 32],
            // wrapped in the v5 inter-transport envelope, as the hub adapter sends it
            message: Envelope {
                src_sender: WireAddr(HUB_PAD),
                dst_addr: WireAddr(self.store.to_bytes()),
                payload: msg.encode(),
            }
            .encode(),
            extra_data: vec![],
        };
        let mut metas = spawn_gateway::accounts::LzReceive {
            payer: self.payer.pubkey(),
            store: self.store,
            peer: self.peer,
        }
        .to_account_metas(None);
        metas.extend(rest);
        self.send(Instruction::new_with_bytes(
            self.program,
            &spawn_gateway::instruction::LzReceive { params }.data(),
            metas,
        ))
    }

    fn token_amount(&self, account: &Pubkey) -> u64 {
        let data = self.svm.get_account(account).unwrap().data;
        u64::from_le_bytes(data[64..72].try_into().unwrap())
    }
}

fn setup() -> World {
    let program = spawn_gateway::id();
    let payer = Keypair::new();
    let mut svm = LiteSVM::new();
    svm.add_program(program, include_bytes!("../../../target/deploy/spawn_gateway.so"));
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

    let (store, _) = Pubkey::find_program_address(&[b"Store"], &program);
    let (types_acc, _) =
        Pubkey::find_program_address(&[b"LzReceiveTypes", store.as_ref()], &program);
    let (peer, _) = Pubkey::find_program_address(
        &[b"Peer", store.as_ref(), &HUB_EID.to_be_bytes()],
        &program,
    );
    let (usd_mint, _) = Pubkey::find_program_address(&[b"UsdMint"], &program);

    let mut w = World { svm, payer, program, store, peer, usd_mint };

    // init_store under the test sentinel (endpoint = default → no CPIs)
    w.send(Instruction::new_with_bytes(
        program,
        &spawn_gateway::instruction::InitStore {
            params: spawn_gateway::instructions::InitStoreParams {
                admin: w.payer.pubkey(),
                endpoint: Pubkey::default(),
                hub_eid: HUB_EID,
                hub_pad: HUB_PAD,
            },
        }
        .data(),
        spawn_gateway::accounts::InitStore {
            payer: w.payer.pubkey(),
            store,
            lz_receive_types_accounts: types_acc,
            alt: None,
            system_program: SYSTEM,
        }
        .to_account_metas(None),
    ))
    .unwrap();

    // hub peer
    w.send(Instruction::new_with_bytes(
        program,
        &spawn_gateway::instruction::SetPeerConfig {
            params: spawn_gateway::instructions::SetPeerConfigParams {
                remote_eid: HUB_EID,
                config: spawn_gateway::instructions::PeerConfigParam::PeerAddress(peer_bytes32()),
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

    // oUSD stand-in mint
    w.send(Instruction::new_with_bytes(
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
    w
}

fn replica_pdas(program: &Pubkey) -> (Pubkey, Pubkey) {
    let (replica, _) = Pubkey::find_program_address(&[b"Replica", &HUB_TOKEN], program);
    let (mint, _) = Pubkey::find_program_address(&[b"Mint", &HUB_TOKEN], program);
    (replica, mint)
}

fn sync_token(w: &mut World) -> (Pubkey, Pubkey) {
    let (replica, mint) = replica_pdas(&w.program);
    w.lz_receive(
        &SpawnMsg::SyncToken {
            hub_token: WireAddr(HUB_TOKEN),
            name: "OMNI TEST".into(),
            symbol: "OMNI".into(),
        },
        vec![
            AccountMeta::new(replica, false),
            AccountMeta::new(mint, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
    )
    .unwrap();
    (replica, mint)
}

/// A keypair recipient plus the bytes32 wire rider that names it (protocol
/// v4: the rider IS the pubkey).
fn recipient_and_wire() -> (Keypair, WireAddr) {
    let kp = Keypair::new();
    let to = WireAddr::from_pubkey(&kp.pubkey());
    (kp, to)
}

#[test]
fn sync_token_creates_replica_and_mint() {
    let mut w = setup();
    let (replica, mint) = sync_token(&mut w);

    let rep_data = w.svm.get_account(&replica).unwrap();
    assert_eq!(rep_data.owner, w.program);
    let rep = spawn_gateway::state::Replica::deserialize(&mut &rep_data.data[8..]).unwrap();
    assert_eq!(rep.hub_token, HUB_TOKEN);
    assert_eq!(rep.mint, mint);
    assert_eq!(rep.name, "OMNI TEST");
    assert_eq!(rep.symbol, "OMNI");

    let mint_data = w.svm.get_account(&mint).unwrap();
    assert_eq!(mint_data.owner, TOKEN_PROGRAM);
    assert_eq!(mint_data.data[44], 6, "decimals");
    // COption tag (4 bytes) then the mint authority = store PDA
    assert_eq!(&mint_data.data[4..36], w.store.to_bytes().as_slice(), "authority");

    // replaying the same sync is a harmless no-op
    let again = sync_token(&mut w);
    assert_eq!(again, (replica, mint));
}

#[test]
fn deliver_mints_scaled_tokens_and_refund() {
    let mut w = setup();
    let (replica, mint) = sync_token(&mut w);
    let (recipient, to) = recipient_and_wire();
    let ata = ata_of(&recipient.pubkey(), &mint);
    let usd_ata = ata_of(&recipient.pubkey(), &w.usd_mint);

    w.lz_receive(
        &SpawnMsg::Deliver {
            hub_token: WireAddr(HUB_TOKEN),
            to,
            tokens: U256::from_u128(884_495_291_384_607_698_648_615), // 884,495.29… ×1e18
            refund: U256::from_u128(2_000_000_000_000_000_000),       // $2 ×1e18
        },
        vec![
            AccountMeta::new_readonly(replica, false),
            AccountMeta::new(mint, false),
            AccountMeta::new_readonly(recipient.pubkey(), false),
            AccountMeta::new(ata, false),
            AccountMeta::new(w.usd_mint, false),
            AccountMeta::new(usd_ata, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
        ],
    )
    .unwrap();

    assert_eq!(w.token_amount(&ata), 884_495_291_384); // floored to 6 decimals
    assert_eq!(w.token_amount(&usd_ata), 2_000_000);
}

#[test]
fn payout_mints_usd() {
    let mut w = setup();
    sync_token(&mut w);
    let (recipient, to) = recipient_and_wire();
    let usd_ata = ata_of(&recipient.pubkey(), &w.usd_mint);

    w.lz_receive(
        &SpawnMsg::Payout { to, usd_out: U256::from_u128(5_123_456_789_012_345_678) },
        vec![
            AccountMeta::new_readonly(recipient.pubkey(), false),
            AccountMeta::new(w.usd_mint, false),
            AccountMeta::new(usd_ata, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
        ],
    )
    .unwrap();
    assert_eq!(w.token_amount(&usd_ata), 5_123_456);
}

#[test]
fn fee_drop_parks_in_store_vault() {
    let mut w = setup();
    let (replica, _) = sync_token(&mut w);
    let vault = ata_of(&w.store, &w.usd_mint);

    w.lz_receive(
        &SpawnMsg::FeeDrop {
            hub_token: WireAddr(HUB_TOKEN),
            amount: U256::from_u128(1_000_000_000_000_000_000),
        },
        vec![
            AccountMeta::new_readonly(replica, false),
            AccountMeta::new(w.usd_mint, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
        ],
    )
    .unwrap();
    assert_eq!(w.token_amount(&vault), 1_000_000);
}

#[test]
fn rejects_wrong_sender_and_wrong_recipient() {
    let mut w = setup();
    let (replica, mint) = sync_token(&mut w);

    // sender that is not the configured hub peer → peer constraint fails
    let params = LzReceiveParams {
        src_eid: HUB_EID,
        sender: [0xAA; 32],
        nonce: 2,
        guid: [0u8; 32],
        message: SpawnMsg::SyncToken {
            hub_token: WireAddr([1; 32]),
            name: "X".into(),
            symbol: "X".into(),
        }
        .encode(),
        extra_data: vec![],
    };
    let metas = spawn_gateway::accounts::LzReceive {
        payer: w.payer.pubkey(),
        store: w.store,
        peer: w.peer,
    }
    .to_account_metas(None);
    let err = w
        .send(Instruction::new_with_bytes(
            w.program,
            &spawn_gateway::instruction::LzReceive { params }.data(),
            metas,
        ))
        .unwrap_err();
    assert!(err.contains("Error"), "unexpected: {err}");

    // recipient account that does not match the wire rider → refused
    let (recipient, _) = recipient_and_wire();
    let ata = ata_of(&recipient.pubkey(), &mint);
    let usd_ata = ata_of(&recipient.pubkey(), &w.usd_mint);
    let err = w
        .lz_receive(
            &SpawnMsg::Deliver {
                hub_token: WireAddr(HUB_TOKEN),
                to: WireAddr([0xBB; 32]),
                tokens: U256::from_u128(1_000_000_000_000),
                refund: U256::from_u128(0),
            },
            vec![
                AccountMeta::new_readonly(replica, false),
                AccountMeta::new(mint, false),
                AccountMeta::new_readonly(recipient.pubkey(), false),
                AccountMeta::new(ata, false),
                AccountMeta::new(w.usd_mint, false),
                AccountMeta::new(usd_ata, false),
                AccountMeta::new_readonly(SYSTEM, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                AccountMeta::new_readonly(ATA_PROGRAM, false),
            ],
        )
        .unwrap_err();
    assert!(err.contains("Error"), "unexpected: {err}");
}
