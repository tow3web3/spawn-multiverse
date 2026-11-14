import { expect } from 'chai'
import { Keypair } from '@solana/web3.js'
import {
  GatewayClient,
  LZ_ENDPOINT,
  StepSender,
  decodeLzReceiveTypesAccounts,
  decodePeerConfig,
  decodeReceiveConfig,
  decodeSendConfig,
  decodeStore,
  equalBytes,
  getLookupTable,
  lzPda,
  runWiring,
  tableAddresses,
} from '../src'
import { World } from './harness'
import { HUB_ADAPTER, HUB_EID, HUB_PAD, ONE, wiredWorld, wiringParams } from './fixtures'

describe('wiring (V7.md §6, steps 2–10) on a fresh local state', () => {
  it('runs every step in order against the real LayerZero programs, and a re-run sends nothing', async () => {
    const { w, admin, params, sent, lines, state } = await wiredWorld()
    console.log('      sent: ' + sent.join(' | '))
    expect(sent[0]).to.match(/^create lookup table/)
    expect(sent.slice(1, 6)).to.deep.equal([
      'init_store',
      'set_peer_config',
      'init_vault',
      'endpoint init_send_library / init_receive_library / init_nonce',
      'uln init_config',
    ])
    expect(sent).to.include('roles / fee config / deposit cap / pause')
    expect(sent.some((s) => s.startsWith('fund tank'))).to.equal(true)

    const store = decodeStore(w.account(w.pdas.store)!.data)
    expect(store.admin.equals(admin.publicKey)).to.equal(true)
    expect(store.endpointProgram.equals(LZ_ENDPOINT)).to.equal(true)
    expect(store.hubEid).to.equal(HUB_EID)
    expect(equalBytes(store.hubPad, HUB_PAD)).to.equal(true)
    expect(store.usdcMint.equals(params.usdcMint)).to.equal(true)
    expect(store.paused).to.equal(true, 'left paused')
    expect(store.depositCap).to.equal(25_000n * ONE)
    expect(store.operator.equals(params.operator!)).to.equal(true)
    expect(store.gasToHub).to.equal(params.fee.gasToHub)
    expect(equalBytes(decodePeerConfig(w.account(w.pdas.peer(HUB_EID))!.data).peerAddress, HUB_ADAPTER)).to.equal(true)
    // the delegate is the admin
    expect(equalBytes(w.account(lzPda.oappRegistry(w.pdas.store))!.data.slice(8, 40), admin.publicKey.toBytes())).to.equal(true)
    // our verifier set on both sides, sorted
    const sc = decodeSendConfig(w.account(lzPda.sendConfig(HUB_EID, w.pdas.store))!.data).uln
    const rc = decodeReceiveConfig(w.account(lzPda.receiveConfig(HUB_EID, w.pdas.store))!.data)
    expect([sc.confirmations, sc.requiredDvnCount, sc.optionalDvnCount, sc.optionalDvnThreshold]).to.deep.equal([32n, 2, 2, 1])
    expect(rc.confirmations).to.equal(10n)
    // the store names the table, and the table holds every static address
    const alt = decodeLzReceiveTypesAccounts(w.account(w.pdas.lzReceiveTypes)!.data).alt
    expect(alt.equals(state.table!)).to.equal(true)
    const table = (await getLookupTable(w.rpc(), alt))!
    console.log(`      lookup table: ${table.state.addresses.length} addresses`)
    expect(w.lamports(w.pdas.gasTank)).to.equal(params.tankLamports)
    expect(lines.join('\n')).to.not.match(/WARNING/)

    // idempotent: a second run reads everything and sends nothing
    const again: string[] = []
    await runWiring(params, w.rpc(), w.sender(admin, again), () => {})
    expect(again).to.deep.equal([])

    // the client loads from what the wiring left: table found through the store
    const client = await GatewayClient.load(w.rpc())
    expect(client.table?.key.equals(alt)).to.equal(true)
    expect(client.path.dvns.length).to.equal(4)
  })

  it('step 10: the admin moves to the new key, which becomes the LayerZero delegate', async () => {
    const { w, admin, params } = await wiredWorld()
    const multisig = Keypair.generate()
    w.svm.airdrop(multisig.publicKey, 1_000_000_000n)
    const sent: string[] = []
    await runWiring({ ...params, newAdmin: multisig.publicKey }, w.rpc(), w.sender(admin, sent), () => {}, {
      only: ['10'],
      newAdminSigner: multisig,
    })
    expect(sent).to.deep.equal(['transfer_admin', 'accept_admin (signed by the new admin)'])
    expect(decodeStore(w.account(w.pdas.store)!.data).admin.equals(multisig.publicKey)).to.equal(true)
    expect(equalBytes(w.account(lzPda.oappRegistry(w.pdas.store))!.data.slice(8, 40), multisig.publicKey.toBytes())).to.equal(true)
  })

  it('dry run: prints the whole plan on a fresh cluster and sends nothing', async () => {
    const w = new World()
    const admin = w.newUser()
    const planned: string[] = []
    const printer: StepSender = {
      dryRun: true,
      send: async (label) => {
        planned.push(label)
      },
    }
    const lines: string[] = []
    await runWiring(wiringParams(admin.publicKey, { newAdmin: Keypair.generate().publicKey }), w.rpc(), printer, (l) => lines.push(l))
    expect(w.account(w.pdas.store)).to.equal(null, 'nothing was sent')
    expect(planned.length).to.be.greaterThan(8)
    expect(planned[planned.length - 1]).to.equal('transfer_admin')
    expect(lines.join('\n')).to.match(/accept_admin must be signed by/)
  })

  it('the table covers every address of a send that is not the user’s or the token’s', async () => {
    const { w, admin, params } = await wiredWorld()
    const want = await tableAddresses({ p: params, rpc: w.rpc(), pdas: w.pdas, sender: w.sender(admin), state: { table: null }, log: () => {} })
    console.log(`      static addresses: ${want.length}`)
    expect(want.length).to.be.lessThan(256)
  })
})
