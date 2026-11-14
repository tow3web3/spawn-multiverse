/**
 * SOLANA (label 1), THE HUB SIDE, on a fork of the hub chain — with
 * placeholder Solana ids (the program has never been deployed):
 *
 *   node scripts/fork-run.js baseSepolia test-fork/solana.fork.test.js   # the LIVE testnet hub, DIRECT (the deployer is its admin)
 *   node scripts/fork-run.js base test-fork/solana.fork.test.js          # a fresh mainnet-shaped hub, THROUGH THE 48h TIMELOCK
 *
 * What it proves, through the REAL EndpointV2 of the hub chain:
 *  - the wiring (scripts/lib-solana.js — the very code add-solana.sh runs):
 *    the destination in compute units and lamports, the executor's message
 *    size toward the Solana eid, on mainnet our verifier set on both sides,
 *    the route, the gateway — refusing an address-shaped id and a unit in wei;
 *  - a launch's fan-out sends a SYNC toward the Solana eid whose executor
 *    option carries 400,000 of gas and 3,000,000 of value, the envelope naming
 *    the store and the same value;
 *  - a moveClaim toward label 1 is forwarded for a 32-byte key and comes home
 *    for a padded EVM address;
 *  - tune-fees prices Solana from REAL quotes toward that eid, and the
 *    request ceilings never exceed what a request prepays;
 *  - the self-check and status: a unit only on label 1, a wide gateway only
 *    there, and the books said OPEN while Solana cannot be read.
 * What it cannot show: anything ON Solana (a delivery, an account opened, a
 * DVN signing) — the devnet run is the first time.
 */
const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ethers, network } = require('hardhat')
const { time } = require('@nomicfoundation/hardhat-network-helpers')
const { PROFILES } = require('../config/profiles')
const { deployNet, loadState, b32, selfCheck } = require('../scripts/lib-net')
const { handover } = require('../scripts/lib-handover')
const { configureDvn, ULN_ABI, ENDPOINT_CFG_ABI, dvnAddresses } = require('../scripts/lib-dvn')
const { tuneFees, status } = require('../scripts/lib-ops')
const { executeOps } = require('../scripts/lib-timelock')
const { requestSolvency, hubUnits, WORST_SYNC } = require('../scripts/lib-prices')
const lib = require('../scripts/lib-solana')
const { decodePacket, decodeOptions } = require('../scripts/lib-fork')
const { decodeEnvelope } = require('../scripts/lib-wire')
const h = require('./helpers')

const NET = process.env.FORK
const run = (NET === 'base' || NET === 'baseSepolia') && network.name === 'fork' ? describe : describe.skip
const E = (n) => ethers.parseEther(String(n))

run(`Solana (label 1) — the hub side on a ${NET} fork`, function () {
  this.timeout(1_800_000)
  const MAINNET = NET === 'base'
  // placeholder ids: 32-byte keys whose top bytes are not zero, as a Solana key's are
  const STORE = ethers.id('spawn/fork/solana/store')
  const PEER = STORE
  const VAULT = ethers.id('spawn/fork/solana/vault')
  // what the Solana side would prepay (V7.md §6 step 8; recorded as an INPUT:
  // the program is not deployed, so its client cannot be read)
  const PREPAYS = { returnUnit: '350000000000000', tradeLegs: 1, openLegs: 2, spawnLegs: 12, moveLegs: { 2: 40, 3: 2, 4: 2, 5: 2, 6: 2 } }
  let profile, signer, owner, hub, adapter, pad, endpoint, gw, sol
  const report = {}
  const state = () => loadState(profile.stateFile)

  before(async () => {
    lib.readSolana.inject = () => ({ ok: false, error: 'no store on the cluster (placeholder ids: the program is not deployed)' })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-solana-fork-'))
    if (MAINNET) {
      // a fresh mainnet-shaped hub (Base + its own gateway), handed over to a
      // 48h timelock — the way Solana joins after finish.sh
      profile = h.forkProfile({ off: ['optimism', 'arbitrum', 'ethereum', 'bnb'] })
      const [deployer, ownerW] = await ethers.getSigners()
      signer = deployer
      owner = ownerW
      expect((await deployNet({ profile, netKey: 'base', signer, dry: false, log: h.quiet })).check.ok).to.equal(true)
      await handover({ profile, netKey: 'base', signer, owner: owner.address, operator: signer.address, guardian: signer.address, log: h.quiet })
    } else {
      // the LIVE testnet hub, its state as recorded, the deployer impersonated
      const t = PROFILES.testnet
      profile = { ...t, stateFile: path.join(dir, 'testnet.json'), manifestFile: path.join(dir, 'manifest.json') }
      fs.copyFileSync(path.join(__dirname, '..', 'deployments', 'testnet.json'), profile.stateFile)
      const p0 = await ethers.getContractAt('SpawnPad', state().baseSepolia.pad)
      signer = await h.impersonate(await p0.admin())
    }
    sol = profile.solana
    hub = state()[profile.hub]
    adapter = await ethers.getContractAt('LayerZeroOmniMessenger', hub.adapter, signer)
    pad = await ethers.getContractAt('SpawnPad', hub.pad, signer)
    endpoint = new ethers.Contract(profile.endpoint, ENDPOINT_CFG_ABI, ethers.provider)
    gw = await ethers.getContractAt('SpawnGateway', hub.gateway, signer)
    expect(await pad.gateways(1)).to.equal(ethers.ZeroHash) // Solana is not wired yet
  })
  after(() => {
    lib.readSolana.inject = undefined
    console.log(`\n    ── Solana on the ${NET} hub ──`)
    for (const [k, v] of Object.entries(report)) console.log(`    ${k}: ${typeof v === 'bigint' ? `${v} (${ethers.formatEther(v)} ETH)` : JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))}`)
  })

  it('refuses what cannot be right: an address-shaped id, a unit typed in wei, gas that is not compute units', async () => {
    expect(() => lib.checkIds({ store: b32(signer.address), peer: PEER })).to.throw(/address-shaped/)
    expect(() => lib.checkIds({ store: '0x1234', peer: PEER })).to.throw(/32 bytes/)
    expect(lib.checkIds({ store: 'GF11J7y5MhHFVDKJhcMFBYwVD2QirCDF2bJi9U2dUzKB', peer: PEER }).store).to.equal('0xe27570e3d9d6dca198b299fae076f3dc69a86c1f543637ed0c21d61d1661aefa')
    expect(() => lib.checkSolanaParams({ gas: 400_000n, unit: E('0.003') })).to.throw(/looks like WEI/)
    expect(() => lib.checkSolanaParams({ gas: 400_000n, unit: 300_000_000n })).to.throw(/LayerZero's cap/)
    expect(() => lib.checkSolanaParams({ gas: 5_200_000n, unit: 3_000_000n })).to.throw(/COMPUTE UNITS/)
    expect(lib.checkSolanaParams({ gas: 400_000n, unit: 3_000_000n })).to.deep.equal({ gas: 400_000n, unit: 3_000_000n })
  })

  it(`plans, then wires label 1 ${MAINNET ? 'through the 48h timelock' : 'directly (the deployer is the admin)'} — the gateway last; label 1 never gets the EVM per-op gas`, async () => {
    const ids = { store: STORE, peer: PEER, ...(MAINNET ? { vault: VAULT } : {}) }
    const dry = await lib.runSolana({ profile, netKey: profile.hub, signer, owner, ids, prepays: PREPAYS, log: h.quiet })
    expect(dry.sent).to.deep.equal([])
    const descs = dry.steps.map((s) => s.desc)
    expect(descs[0]).to.match(/setDestination\(1, 400000 compute units, 3000000 LAMPORTS\)/)
    expect(descs[descs.length - 1]).to.match(/pad\.setGateway\(1, /)
    expect(descs.findIndex((d) => /setRoute/.test(d))).to.be.lt(descs.length - 1)
    expect(descs.some((d) => /setGasForOp/.test(d))).to.equal(false)
    report.plan = descs
    expect(dry.mode).to.equal(MAINNET ? 'timelock' : 'direct')

    const res = await lib.runSolana({ profile, netKey: profile.hub, signer, owner, ids, prepays: PREPAYS, send: true, topUp: true, log: h.quiet })
    if (MAINNET) {
      expect(res.scheduled).to.equal(true)
      expect(res.wired).to.equal(false)
      expect(await pad.gateways(1)).to.equal(ethers.ZeroHash) // nothing before the delay
      expect(await adapter.gasLimit(1)).to.equal(400_000n) // the operator's part is already on chain
      await time.increase(48 * 3600 + 60)
      const ex = await executeOps({ profile, netKey: profile.hub, owner, deployer: signer, topUp: true, log: h.quiet })
      expect(ex.executed.length).to.equal(1)
      const again = await lib.runSolana({ profile, netKey: profile.hub, signer, owner, ids, prepays: PREPAYS, send: true, log: h.quiet })
      expect(again.steps).to.deep.equal([])
      expect(again.wired).to.equal(true)
    } else {
      expect(res.wired).to.equal(true)
    }
    expect(await adapter.gasLimit(1)).to.equal(400_000n)
    expect(await adapter.returnUnit(1)).to.equal(3_000_000n)
    expect(await adapter.eidOf(1)).to.equal(BigInt(sol.eid))
    expect(await adapter.peers(sol.eid)).to.equal(PEER)
    expect(await pad.gateways(1)).to.equal(STORE)
    for (const op of [10, 11, 12, 13]) expect(await adapter.gasForOp(1, op)).to.equal(0n)
    // the executor's message size toward the Solana eid
    const sendLib = await endpoint.getSendLibrary(hub.adapter, sol.eid)
    const [recvLib] = await endpoint.getReceiveLibrary(hub.adapter, sol.eid)
    const exec = await new ethers.Contract(sendLib, ULN_ABI, ethers.provider).getExecutorConfig(hub.adapter, sol.eid)
    expect(exec.maxMessageSize).to.be.gte(10_000n)
    report.executor = { executor: exec.executor, maxMessageSize: exec.maxMessageSize }
    if (MAINNET) {
      // our verifier set on both sides, and the CCTP peer in the same batch
      const s = await new ethers.Contract(sendLib, ULN_ABI, ethers.provider).getUlnConfig(hub.adapter, sol.eid)
      const r = await new ethers.Contract(recvLib, ULN_ABI, ethers.provider).getUlnConfig(hub.adapter, sol.eid)
      expect([...s.requiredDVNs]).to.deep.equal(dvnAddresses(profile, 'base', profile.dvn.required))
      expect([...s.optionalDVNs]).to.deep.equal(dvnAddresses(profile, 'base', profile.dvn.optional))
      expect([...r.requiredDVNs]).to.deep.equal(dvnAddresses(profile, 'base', profile.dvn.required))
      expect(s.confirmations).to.equal(10n)
      expect(r.confirmations).to.equal(32n)
      expect(await endpoint.isDefaultSendLibrary(hub.adapter, sol.eid)).to.equal(false)
      const v = await ethers.getContractAt('OmniUSD', hub.localUsd)
      expect((await v.peers(1)).vault).to.equal(VAULT)
      expect((await v.peers(1)).domain).to.equal(5n)
    }
  })

  it('prices from REAL quotes toward the Solana eid: tune-fees counts Solana; both request ceilings stay within what a request prepays', async () => {
    const providers = { [profile.hub]: ethers.provider }
    // what a SYNC toward Solana costs, with and without the lamports it brings — the endpoint's own quote
    const q1 = await adapter.quote(1, STORE, WORST_SYNC, 1)
    const q0 = await adapter.quote(1, STORE, WORST_SYNC, 0)
    expect(q1).to.be.gt(q0) // LayerZero charges for delivering the lamports
    report.solanaSyncQuote = q1
    report.lamportsPremium = q1 - q0
    const before = await gw.quoteSpawn('SOLANA TOO', 'SOL2', '{}', false)
    for (let i = 0; i < 2; i++) await tuneFees({ profile, netKey: profile.hub, signer, apply: true, providers, log: h.quiet })
    const after = await gw.quoteSpawn('SOLANA TOO', 'SOL2', '{}', false)
    report.launchFromHub = { before, after }
    expect(after).to.be.gt(before) // a launch now prepays Solana's SYNC too
    expect(await gw.moveLegs(1)).to.be.gt(0n)
    const solv = await requestSolvency({ profile, all: state(), providers })
    const row = solv.rows.find((r) => r.net === 'solana')
    expect(row.capOk).to.equal(true)
    expect(row.capSync).to.equal(BigInt(PREPAYS.openLegs) * BigInt(PREPAYS.returnUnit)) // what an open from Solana prepays
    expect(row.capPayout).to.be.gt(0n)
    expect(row.capPayout).to.be.lte(row.minMove)
    expect(row.movesServed).to.equal(true) // the hub chain's move price covers the live PAYOUT toward Solana
    report.requestCaps = { sync: row.capSync, payout: row.capPayout, qSync: row.qSync, qPayout: row.qPayout, opensServed: row.opensServed }
    for (const r of solv.rows) expect(r.capOk, r.net).to.equal(true)
    const units = await hubUnits({ profile, all: state(), providers })
    expect(units.ok).to.equal(true)
    expect(units.rows.find((u) => u.net === 'solana').unit).to.equal(3_000_000n)
    const chk = await selfCheck({ profile, netKey: profile.hub, provider: ethers.provider, providers, log: h.quiet })
    expect(chk.hard.map((r) => r.what), 'hub self-check').to.deep.equal([])
  })

  it('a launch from the hub chain sends a SYNC toward the Solana eid: 400,000 gas and 3,000,000 of value in the executor option, the store and the same value in the envelope', async () => {
    const fee = await gw.quoteSpawn('SOLANA FANOUT', 'SOLF', '{}', false)
    const rc = await (await gw.spawnToken('SOLANA FANOUT', 'SOLF', '{}', 0, 0, { value: fee })).wait()
    const packets = h.packetsSent(profile, rc)
    const toSol = packets.map((p) => ({ ...decodePacket(p.encodedPayload), opt: decodeOptions(p.options) })).filter((p) => p.dstEid === sol.eid)
    expect(toSol.length).to.equal(1)
    const p = toSol[0]
    expect(p.opt.gas).to.equal(400_000n)
    expect(p.opt.value).to.equal(3_000_000n)
    const env = decodeEnvelope(p.message)
    expect(env.dst).to.equal(STORE)
    expect(env.value).to.equal(3_000_000n)
    expect(env.op).to.equal(10)
    // what the pad paid for it is the endpoint's quote of that very packet
    const routed = h.eventsOf(adapter, rc, 'Routed').filter((e) => Number(e.args.dstEid) === sol.eid)
    expect(routed.length).to.equal(1)
    report.syncToSolanaPaid = routed[0].args.nativeFee
    report.fanOut = packets.length
  })

  it('moveClaim toward label 1: forwarded for a 32-byte key, home for a padded EVM address', async () => {
    const vault = await ethers.getContractAt('OmniUSD', hub.localUsd, signer)
    const usdc = new ethers.Contract(await vault.usdc(), ['function approve(address,uint256) returns (bool)', 'function mint(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], signer)
    // what the mover holds in this chain's dollars, 18 decimals: USDC and claims
    const dollars = async () => (await usdc.balanceOf(signer.address)) * 10n ** 12n + (await vault.balanceOf(signer.address))
    if (MAINNET) await h.mintUsdc(profile.nets.base, signer.address, 10_000_000n)
    else await (await usdc.mint(signer.address, 10_000_000n)).wait()
    await (await usdc.approve(vault.target, 10_000_000n)).wait()
    await (await vault.wrap(4_000_000n)).wait()
    const fee = await gw.quoteMove(1)
    const KEY = ethers.id('spawn/fork/solana/recipient')
    const moved = async (to) => {
      const before = await dollars()
      const rc = await (await gw.moveClaim(1, to, E(1), { value: fee })).wait()
      const ev = h.eventsOf(pad, rc, 'Moved')
      expect(ev.length).to.equal(1)
      return { ev: ev[0].args, rc, delta: before - (await dollars()) }
    }
    const fwd = await moved(KEY)
    expect(fwd.ev.forwarded).to.equal(true)
    expect(fwd.delta).to.equal(E(1)) // the claim left
    const pk = h.packetsSent(profile, fwd.rc).map((p) => ({ ...decodePacket(p.encodedPayload), opt: decodeOptions(p.options) }))
    expect(pk.length).to.equal(1)
    expect(pk[0].dstEid).to.equal(sol.eid)
    expect(pk[0].opt.value).to.equal(3_000_000n) // a moved PAYOUT brings the lamports too
    expect(decodeEnvelope(pk[0].message).op).to.equal(12)
    const home = await moved(b32(signer.address))
    expect(home.ev.forwarded).to.equal(false)
    expect(home.delta).to.equal(0n) // it came home whole (paid in USDC by the vault), in the same transaction (the hub chain's loopback)
    expect(h.packetsSent(profile, home.rc).length).to.equal(0)
  })

  it('status: Solana is in the books — and, unread here, the books are said OPEN, by how much', async () => {
    const providers = { [profile.hub]: ethers.provider }
    process.env.SPAWN_STATUS_ALLOW_UNREAD_SOLANA = ''
    const st = await status({ profile, providers, log: h.quiet })
    expect(st.solana.read).to.equal(false)
    expect(st.solana.wired).to.equal(true)
    expect(st.ok).to.equal(false)
    expect(st.warnings.some((w) => w.includes('SOLANA NOT READ'))).to.equal(true)
    report.booksOpenBy = st.solana.mustHold
    // read (a stand-in reading of the client): the vault and its claims join the equality
    lib.readSolana.inject = () => ({ ok: true, store: STORE, vaultUsdc: '5000000', claimsTotal: '1000000', poolTotal: '0', usdDustE18: '0', returnUnit: PREPAYS.returnUnit, tradeLegs: 1, openLegs: 2, spawnLegs: 12, moveLegs: PREPAYS.moveLegs })
    const st2 = await status({ profile, providers, log: h.quiet })
    expect(st2.solana.read).to.equal(true)
    expect(st2.held - st.held).to.equal(E(5))
    expect(st2.supply - st.supply).to.equal(E(1))
    lib.readSolana.inject = () => ({ ok: false, error: 'placeholder' })
  })
})
