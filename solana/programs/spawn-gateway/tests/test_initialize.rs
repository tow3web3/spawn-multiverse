use {
    anchor_lang::{
        prelude::Pubkey, solana_program::instruction::Instruction, AnchorDeserialize,
        InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer]).unwrap();
    svm.send_transaction(tx).unwrap();
    // two identical txs would share a signature — give the next one a fresh hash
    svm.expire_blockhash();
}

#[test]
fn test_initialize_and_ping() {
    let program_id = spawn_gateway::id();
    let payer = Keypair::new();
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!("../../../target/deploy/spawn_gateway.so");
    svm.add_program(program_id, bytes).unwrap();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    let (config, _) = Pubkey::find_program_address(&[b"config"], &program_id);

    // initialize: store admin + hub routing (Base Sepolia eid, dummy pad addr)
    let mut hub_address = [0u8; 32];
    hub_address[12..].copy_from_slice(&[0x11; 20]);
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            program_id,
            &spawn_gateway::instruction::Initialize { hub_eid: 40245, hub_address }.data(),
            spawn_gateway::accounts::Initialize {
                admin: payer.pubkey(),
                config,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
        ),
    );

    // ping twice: counter must advance
    for _ in 0..2 {
        send(
            &mut svm,
            &payer,
            Instruction::new_with_bytes(
                program_id,
                &spawn_gateway::instruction::Ping {}.data(),
                spawn_gateway::accounts::Ping { by: payer.pubkey(), config }
                    .to_account_metas(None),
            ),
        );
    }

    let data = svm.get_account(&config).unwrap().data;
    let cfg = spawn_gateway::state::Config::deserialize(&mut &data[8..]).unwrap();
    assert_eq!(cfg.admin, payer.pubkey());
    assert_eq!(cfg.hub_eid, 40245);
    assert_eq!(cfg.hub_address, hub_address);
    assert_eq!(cfg.pings, 2);
}
