import { expect } from 'chai'
import { AddressLookupTableProgram, Keypair, PublicKey } from '@solana/web3.js'
import {
  CCTP_DOMAIN,
  CHAIN_LABEL,
  GatewayClient,
  LZ_ENDPOINT,
  StepSender,
  decodeCctpPeer,
  decodeLzReceiveTypesAccounts,
  decodeMoveRoute,
  decodePeerConfig,
  decodeReceiveConfig,
  decodeReceiveLibraryConfig,
  decodeSendConfig,
  decodeSendLibraryConfig,
  decodeStore,
  equalBytes,
  getLookupTable,
  initStoreIx,
  lzPda,
  runWiring,
  setReceiveTableIx,
  tableAddresses,
} from '../src'
import { cctpPeers as parseCctpPeers, moveLegs as parseMoveLegs } from '../../scripts/wire'
import { World } from './harness'
import { BASE_VAULT, HUB_ADAPTER, HUB_EID, HUB_PAD, MOVE_LEGS, ONE, wiredWorld, wiringParams } from './fixtures'

describe('wiring (V7.md §6, steps 2–10) on a fresh local state', () => {
  it('runs every step in order against the real LayerZero programs, and a re-run sends nothing', async () => {
    const { w, admin, params, sent, lines, state } = await wiredWorld()
    console.log('      sent: ' + sent.join(' | '))
    expect(sent[0]).to.match(/^create lookup table/)
    expect(sent.slice(1, 5)).to.deep.equal([
      'init_store',
      'set_peer_config',
      'init_vault',
      'endpoint init_send_library / init_receive_library / init_nonce',
    ])
    expect(sent[5]).to.match(/^endpoint set_send_library \/ set_receive_library \(pin /)
    expect(sent[6]).to.equal('uln init_config')
    expect(sent).to.include('freeze lookup table')
    expect(sent).to.include('roles / fee config / deposit cap / legs / paused')
    expect(sent).to.include('set_cctp_peer × 1')
    expect(sent.some((s) => s.startsWith('fund tank'))).to.equal(true)
    expect(sent.some((s) => s.startsWith('set_receive_table'))).to.equal(false, 'init_store recorded the table itself')

    const store = decodeStore(w.account(w.pdas.store)!.data)
    expect(store.admin.equals(admin.publicKey)).to.equal(true)
    expect(store.endpointProgram.equals(LZ_ENDPOINT)).to.equal(true)
    expect(store.hubEid).to.equal(HUB_EID)
    expect(equalBytes(store.hubPad, HUB_PAD)).to.equal(true)
    expect(store.usdcMint.equals(params.usdcMint)).to.equal(true)
    expect(store.paused).to.equal(true, 'left paused (a store is born paused)')
    expect(store.openLegs).to.equal(1, 'an open prepays one leg unless the operator says otherwise')
    // v7.2: every priced destination has its route; the others have none
    for (const m of MOVE_LEGS) {
      const r = decodeMoveRoute(w.account(w.pdas.moveRoute(m.dstChain))!.data)
      expect([r.dstChain, r.legs]).to.deep.equal([m.dstChain, m.legs])
    }
    expect(w.account(w.pdas.moveRoute(CHAIN_LABEL.optimism))).to.equal(null, 'not priced = closed')
    const peer = decodeCctpPeer(w.account(w.pdas.cctpPeer(CHAIN_LABEL.base))!.data)
    expect([peer.label, peer.domain, equalBytes(peer.vault, BASE_VAULT)]).to.deep.equal([CHAIN_LABEL.base, CCTP_DOMAIN.base, true])
    // both libraries are PINNED to the ULN the endpoint's defaults name:
    // the gateway no longer follows a change of default
    const uln = decodeSendLibraryConfig(w.account(lzPda.defaultSendLibraryConfig(HUB_EID))!.data).messageLib
    expect(uln.equals(PublicKey.default)).to.equal(false)
    expect(decodeSendLibraryConfig(w.account(lzPda.sendLibraryConfig(w.pdas.store, HUB_EID))!.data).messageLib.equals(uln)).to.equal(true)
    expect(decodeReceiveLibraryConfig(w.account(lzPda.receiveLibraryConfig(w.pdas.store, HUB_EID))!.data).messageLib.equals(uln)).to.equal(true)
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
    // …and is FROZEN: the key that created it can no longer extend it, or
    // close it and stall every delivery
    expect(table.state.authority).to.equal(undefined)
    for (const ix of [
      AddressLookupTableProgram.extendLookupTable({ lookupTable: alt, authority: admin.publicKey, payer: admin.publicKey, addresses: [Keypair.generate().publicKey] }),
      AddressLookupTableProgram.deactivateLookupTable({ lookupTable: alt, authority: admin.publicKey }),
    ]) {
      expect(() => w.send(admin, [ix])).to.throw()
    }
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
    expect(planned.length).to.be.greaterThan(10)
    expect(planned[planned.length - 1]).to.equal('transfer_admin')
    expect(planned.some((l) => /set_send_library/.test(l))).to.equal(true)
    expect(planned.some((l) => /set_cctp_peer/.test(l))).to.equal(true)
    expect(lines.join('\n')).to.match(/accept_admin must be signed by/)
  })

  it('the table covers every address of a send that is not the user’s or the token’s', async () => {
    const { w, admin, params } = await wiredWorld()
    const want = await tableAddresses({ p: params, rpc: w.rpc(), pdas: w.pdas, sender: w.sender(admin), state: { table: null }, log: () => {} })
    console.log(`      static addresses: ${want.length}`)
    expect(want.length).to.be.lessThan(256)
  })

  it('a store that names no table (or an old one) is re-pointed with set_receive_table; unpausing is the last word of step 8', async () => {
    const w = new World()
    const admin = w.newUser(100_000_000_000n)
    const params = wiringParams(admin.publicKey, { leavePaused: false, freezeTable: false })
    // someone initialised the store by hand, with no table
    w.send(admin, [initStoreIx(w.pdas, admin.publicKey, { admin: admin.publicKey, endpoint: LZ_ENDPOINT, hubEid: HUB_EID, hubPad: HUB_PAD }, null)])
    expect(decodeStore(w.account(w.pdas.store)!.data).paused).to.equal(true, 'born paused')
    expect(decodeLzReceiveTypesAccounts(w.account(w.pdas.lzReceiveTypes)!.data).alt.equals(PublicKey.default)).to.equal(true)
    const sent: string[] = []
    const state = await runWiring(params, w.rpc(), w.sender(admin, sent), () => {})
    expect(sent.some((s) => s.startsWith('create lookup table'))).to.equal(true)
    expect(sent.some((s) => s.startsWith('set_receive_table'))).to.equal(true)
    expect(sent).to.not.include('init_store')
    expect(sent).to.not.include('freeze lookup table')
    expect(decodeLzReceiveTypesAccounts(w.account(w.pdas.lzReceiveTypes)!.data).alt.equals(state.table!)).to.equal(true)
    expect(sent).to.include('roles / fee config / deposit cap / legs / unpaused')
    expect(decodeStore(w.account(w.pdas.store)!.data).paused).to.equal(false)
    // not frozen: its creator still owns it — and the wiring says what that means
    expect((await getLookupTable(w.rpc(), state.table!))!.state.authority!.equals(admin.publicKey)).to.equal(true)

    // a new table replaces it (a changed verifier set, a closed table): only the admin
    const other = Keypair.generate().publicKey
    w.svm.setAccount(other, { lamports: 10_000_000, data: w.account(state.table!)!.data, owner: w.account(state.table!)!.owner, executable: false })
    const stranger = w.newUser()
    expect(() => w.send(stranger, [setReceiveTableIx(w.pdas, stranger.publicKey, other)])).to.throw(/NotAdmin/)
    expect(() => w.send(admin, [setReceiveTableIx(w.pdas, admin.publicKey, w.pdas.vault)])).to.throw(/BadLookupTable/)
    const again: string[] = []
    await runWiring({ ...params, table: other }, w.rpc(), w.sender(admin, again), () => {}, { only: ['2a', '2b'] })
    expect(again).to.deep.equal([`set_receive_table ${other.toBase58()}`])
    expect(decodeLzReceiveTypesAccounts(w.account(w.pdas.lzReceiveTypes)!.data).alt.equals(other)).to.equal(true)
  })

  it('a CCTP peer is named once: the wiring refuses to re-aim it', async () => {
    const { w, admin, params } = await wiredWorld()
    const other = [{ label: CHAIN_LABEL.base, domain: CCTP_DOMAIN.base, vault: new Uint8Array(32).fill(9) }]
    let err = ''
    await runWiring({ ...params, cctpPeers: other }, w.rpc(), w.sender(admin), () => {}, { only: ['8b'] }).catch((e) => (err = String(e)))
    expect(err).to.match(/never re-aimed/)
  })

  it('scripts/wire.ts reads the v7.2 settings: a price list of moves, the CCTP peers', () => {
    expect(parseMoveLegs('bnb:6,base:1,2:40')).to.deep.equal([
      { dstChain: CHAIN_LABEL.bnb, legs: 6 },
      { dstChain: CHAIN_LABEL.base, legs: 1 },
      { dstChain: CHAIN_LABEL.ethereum, legs: 40 },
    ])
    expect(parseMoveLegs(undefined)).to.deep.equal([])
    expect(() => parseMoveLegs('bnb')).to.throw(/chain:legs/)
    expect(() => parseMoveLegs('mars:1')).to.throw(/unknown chain/)
    const [p] = parseCctpPeers('base:0x' + 'c3'.repeat(20))
    expect([p.label, p.domain, equalBytes(p.vault, BASE_VAULT)]).to.deep.equal([CHAIN_LABEL.base, CCTP_DOMAIN.base, true])
    // BNB's vault holds USDT: Circle has nothing to burn or mint there
    expect(() => parseCctpPeers('bnb:0x' + 'c3'.repeat(20))).to.throw(/no Circle USDC vault/)
    expect(() => parseCctpPeers('solana:0x' + 'c3'.repeat(20))).to.throw(/no Circle USDC vault/)
  })
})
