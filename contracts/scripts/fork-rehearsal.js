/**
 * THE MAINNET REHEARSAL — the two lines the owner will paste, run end to end
 * against private anvil forks of the FIVE chains at once, with LayerZero
 * packets carried between the forks through each chain's REAL EndpointV2:
 *
 *   node scripts/fork-rehearsal.js            (from contracts/ — ~25–40 min)
 *   npm run rehearse                          (the same)
 *
 * It runs, exactly as the owner will:
 *   bash scripts/launch.sh     preflight-free (forks), deploy ×5, wiring, the
 *                              verifier set on every pathway, prices, every
 *                              canary (hub local; a round trip from each
 *                              spoke reusing ONE token; BNB in USDT with a
 *                              claim moved to Base; Ethereum opened from
 *                              Ethereum), status
 *   bash scripts/finish.sh     hand-over to a 48h timelock on every chain,
 *                              status, launch caps (25,000 USDC ×4, 10,000
 *                              USDT), status
 * then asserts the end state from the chains themselves (roles, delegates,
 * caps, CCTP peers — never the USDT vault —, the manifest the site codes
 * against, every relayed message delivered), and finally MEASURES on the
 * same forks (FORK_MEASURE=0 skips it):
 *   - what every op really costs where it lands (DELIVER / PAYOUT / FEE_DROP /
 *     SYNC on the spokes; BUY, SELL, CLAIM, PULL_FEES, OPEN, MOVE and the
 *     worst-case SPAWN on the hub), against the executor gas they buy;
 *   - hubGasFor: the worst admitted spawn with four remote chains and a
 *     launch ceiling on none / one / all of them, one REAL quote per ceiling;
 *   - the pad's SYNC_GAS_FLOOR margin: a real send and a real quote, their
 *     call depth, and — by sweeping the gas of a held spawn and a held open
 *     with callTracer — the most gas ever left behind a STARVED call, against
 *     the 100,000 floor.
 *
 * Who signs: the REAL deployer address is impersonated on every fork (no key
 * signs anything — a transaction signed for a fork is valid on the chain);
 * OWNER is a fresh address that "sent a transaction" on the Base fork.
 * Dollars for the canaries are minted on the forks by Circle's own minter
 * and by the BEP20 owner. The Ethereum launch ceiling is forced below the
 * live price (SPAWN_SYNC_CAP_ETHEREUM, default here 0.0000001) so launches
 * SKIP Ethereum and its canary must OPEN the token — set it to 0.0003 to
 * rehearse the profile's own value instead.
 *
 * The one shortcut: a fork cannot get DVN signatures, so the relay calls
 * `endpoint.verify` AS the receive library (scripts/lib-fork.js). Everything
 * after that — the endpoint, the adapters, the executor's gas and value — is
 * the real path.
 *
 * State, manifest, logs, marks and the report go to a temp dir: the repo's
 * deployments/ and public/onchain/ are not touched, and nothing is sent to a
 * live chain. Ports 8546–8550, never 8545.
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ethers } = require('ethers')
const { rpc, sendAs, startForks, Relay, EXECUTOR, EP_IFACE, OP_NAMES } = require('./lib-fork')

const NETS = ['base', 'optimism', 'arbitrum', 'ethereum', 'bnb']
const cwd = path.join(__dirname, '..')
const DEPLOYER = ethers.getAddress(process.env.SPAWN_DEPLOYER ?? '0x483E931A279B136A2C3fCA6BF5eC2c4239c1B904')
const OWNER = ethers.getAddress(ethers.dataSlice(ethers.id('spawn/fork/owner'), 12))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-rehearsal-'))
const t0 = Date.now()
const mins = () => `${((Date.now() - t0) / 60000).toFixed(1)} min`

// the profile, read AFTER the env below is set (RPC_<NET> → the forks)
let PROFILES
const abi = (name) => {
  const find = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) {
        const r = find(p)
        if (r) return r
      } else if (f.name === `${name}.json`) return p
    }
    return null
  }
  return JSON.parse(fs.readFileSync(find(path.join(cwd, 'artifacts', 'contracts')), 'utf8')).abi
}

function runAsync(title, cmd, args, env) {
  console.log(`\n━━━ ${title} — ${mins()} ━━━`)
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env, stdio: 'inherit' })
    p.on('exit', (code) => resolve(code))
  })
}

async function main() {
  console.log(`rehearsal of the five-chain launch — state in ${dir}`)
  const compiled = await runAsync('compile', 'npx', ['hardhat', 'compile', '--quiet'], process.env)
  if (compiled !== 0) throw new Error('compile failed')

  console.log('\n━━━ forks ━━━')
  const forks = await startForks(NETS, { probe: DEPLOYER })
  const url = forks.urls
  const env = {
    ...process.env,
    SPAWN_PROFILE: 'mainnet',
    SPAWN_FORK_REHEARSAL: '1', // the wrappers run every CLI on --network fork
    SPAWN_FORK_AS: DEPLOYER, // …acting as the real deployer, impersonated
    SPAWN_DEPLOYER: DEPLOYER,
    SPAWN_FINISH_OWNER: OWNER,
    SPAWN_IGNORE_HOLD: '1', // deployments/HOLD-MAINNET stays; a fork sends nothing live
    SPAWN_STATE_FILE: path.join(dir, 'mainnet.json'),
    SPAWN_MANIFEST_FILE: path.join(dir, 'manifest.json'),
    SPAWN_LOG_DIR: path.join(dir, 'logs'),
    SPAWN_MARK_DIR: dir,
    SPAWN_RETRY_SLEEP: '2',
    SMOKE_POLL_MS: '500',
    SPAWN_SYNC_CAP_ETHEREUM: process.env.SPAWN_SYNC_CAP_ETHEREUM ?? '0.0000001',
    ...Object.fromEntries(NETS.map((n) => [`RPC_${n.toUpperCase()}`, url[n]])),
  }
  for (const k of ['SPAWN_LAUNCH_PROFILE', 'SPAWN_SKIP', 'SPAWN_ENABLE', 'SPAWN_DEPOSIT_CAP_USDC']) delete env[k]
  Object.assign(process.env, env)
  PROFILES = require('../config/profiles').PROFILES
  const profile = PROFILES.mainnet
  const endpoint = profile.endpoint

  // ── the deployer, as the owner will have funded it: a few dollars per chain ──
  const ERC20 = new ethers.Interface([
    'function balanceOf(address) view returns (uint256)',
    'function mint(address,uint256) returns (bool)',
    'function mint(uint256) returns (bool)',
    'function transfer(address,uint256) returns (bool)',
    'function getOwner() view returns (address)',
    'function localMinter() view returns (address)',
  ])
  const call = async (net, to, data) => rpc(url[net], 'eth_call', [{ to, data }, 'latest'])
  for (const net of NETS) {
    const c = profile.nets[net]
    const dec = (c.dollar ?? profile.dollar).decimals
    const amount = ethers.parseUnits(net === 'ethereum' ? '5' : '20', dec)
    if (c.tokenMessenger) {
      const [minter] = ERC20.decodeFunctionResult('localMinter', await call(net, c.tokenMessenger, ERC20.encodeFunctionData('localMinter')))
      const rc = await sendAs(url[net], minter, { to: c.usdc, data: ERC20.encodeFunctionData('mint(address,uint256)', [DEPLOYER, amount]), gas: ethers.toQuantity(300_000) })
      if (rc.status !== '0x1') throw new Error(`could not mint USDC on the ${net} fork`)
    } else {
      const [owner] = ERC20.decodeFunctionResult('getOwner', await call(net, c.usdc, ERC20.encodeFunctionData('getOwner')))
      await sendAs(url[net], owner, { to: c.usdc, data: ERC20.encodeFunctionData('mint(uint256)', [amount]), gas: ethers.toQuantity(300_000) })
      const rc = await sendAs(url[net], owner, { to: c.usdc, data: ERC20.encodeFunctionData('transfer', [DEPLOYER, amount]), gas: ethers.toQuantity(300_000) })
      if (rc.status !== '0x1') throw new Error(`could not fund USDT on the ${net} fork`)
    }
    console.log(`  (fork only) ${ethers.formatUnits(amount, dec)} ${(c.dollar ?? profile.dollar).symbol} to the deployer on ${net}`)
  }
  // OWNER proves control the way finish.sh asks: one transaction on the hub chain
  await sendAs(url.base, OWNER, { to: OWNER, value: '0x0', gas: ethers.toQuantity(21_000) })

  // ── the relay: every PacketSent on any fork lands on its destination fork ──
  const relay = new Relay({
    chains: Object.fromEntries(NETS.map((n) => [n, { url: url[n], eid: profile.nets[n].eid }])),
    endpoint,
  })
  await relay.start()
  const report = { dir, forkBlocks: forks.blocks, deployer: DEPLOYER, owner: OWNER, ethSyncCap: env.SPAWN_SYNC_CAP_ETHEREUM }
  try {
    const launch = await runAsync('bash scripts/launch.sh', 'bash', ['scripts/launch.sh'], env)
    report.launchMin = mins()
    if (launch !== 0) throw new Error(`launch.sh failed (exit ${launch}) — logs in ${env.SPAWN_LOG_DIR}`)
    const finish = await runAsync('bash scripts/finish.sh', 'bash', ['scripts/finish.sh'], env)
    report.finishMin = mins()
    if (finish !== 0) throw new Error(`finish.sh failed (exit ${finish}) — logs in ${env.SPAWN_LOG_DIR}`)
    await relay.idle()

    console.log(`\n━━━ the end state, read from the five forks — ${mins()} ━━━`)
    report.checks = await checkEndState({ profile, url, relay })
    report.canaryDeliveries = relay.records.slice()

    if (process.env.FORK_MEASURE !== '0') {
      console.log(`\n━━━ measurements — ${mins()} ━━━`)
      report.measure = await measure({ profile, url, relay, abi })
    }
    report.totalMin = mins()
    report.relayErrors = relay.errors
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
    printSummary(report)
    console.log(`\n✓ rehearsal complete in ${mins()}: launch.sh and finish.sh ran end to end on forks of ${NETS.join(', ')}`)
    console.log(`  report: ${path.join(dir, 'report.json')}`)
  } finally {
    await relay.stop()
    forks.stop()
  }
}

/* --------------------------------- checks --------------------------------- */

async function checkEndState({ profile, url, relay }) {
  const state = JSON.parse(fs.readFileSync(process.env.SPAWN_STATE_FILE, 'utf8'))
  const manifest = JSON.parse(fs.readFileSync(process.env.SPAWN_MANIFEST_FILE, 'utf8'))
  const { launchCapOf, dollarUnits, vaultKind } = require('../config/profiles')
  const R = new ethers.Interface([
    'function admin() view returns (address)', 'function operator() view returns (address)', 'function guardian() view returns (address)',
    'function depositCap() view returns (uint256)', 'function peers(uint32) view returns (uint32 domain, bytes32 vault)',
    'function delegates(address) view returns (address)',
  ])
  const read = async (net, to, fn, args = []) => R.decodeFunctionResult(fn, await rpc(url[net], 'eth_call', [{ to, data: R.encodeFunctionData(fn, args) }, 'latest']))
  const fails = []
  const ok = (cond, what) => {
    console.log(`  ${cond ? '✓' : '✗'} ${what}`)
    if (!cond) fails.push(what)
  }
  for (const net of NETS) {
    const s = state[net]
    const hubSide = net === profile.hub
    const keys = hubSide ? ['adapter', 'usd', 'pad', 'localUsd', 'gateway', 'localDist'] : ['adapter', 'usd', 'gateway', 'dist']
    let roles = true
    for (const k of keys) {
      const [a] = await read(net, s[k], 'admin')
      const [o] = await read(net, s[k], 'operator')
      const [g] = await read(net, s[k], 'guardian')
      roles &&= a.toLowerCase() === s.timelock.toLowerCase() && o === DEPLOYER && g === DEPLOYER
    }
    ok(roles, `${net}: every contract's admin is its 48h timelock; operator and guardian are the hot key`)
    const [delegate] = await read(net, profile.endpoint, 'delegates', [s.adapter])
    ok(delegate.toLowerCase() === s.timelock.toLowerCase(), `${net}: the LayerZero delegate (who picks the verifiers) is the timelock`)
    const vault = hubSide ? s.localUsd : s.usd
    const [cap] = await read(net, vault, 'depositCap')
    const want = dollarUnits(profile, launchCapOf(profile, net), net)
    ok(cap === want, `${net}: launch cap ${launchCapOf(profile, net)} ${(profile.nets[net].dollar ?? profile.dollar).symbol} (on chain ${cap})`)
    if (vaultKind(profile, net) === 'cctp') {
      const [, bnbPeer] = await read(net, vault, 'peers', [profile.nets.bnb.label])
      ok(bnbPeer === ethers.ZeroHash, `${net}: the USDT vault is NOT a CCTP peer`)
      for (const other of NETS) {
        if (other === net || vaultKind(profile, other) !== 'cctp') continue
        const [, v] = await read(net, vault, 'peers', [profile.nets[other].label])
        const ov = other === profile.hub ? state[other].localUsd : state[other].usd
        if (v !== ethers.zeroPadValue(ov, 32)) ok(false, `${net}: CCTP peer ${other} is its vault`)
      }
    }
    ok(fs.existsSync(path.join(process.env.SPAWN_MARK_DIR, `.canary-mainnet-${net}.ok`)), `${net}: canary passed (mark bound to its gateway)`)
  }
  ok(manifest.network === 'mainnet' && manifest.generation === 'v7.2', 'manifest: network mainnet, generation v7.2')
  ok(manifest.hubMessenger?.toLowerCase() === state.base.adapter.toLowerCase(), 'manifest: hubMessenger = the hub adapter')
  ok(JSON.stringify(manifest.chains.map((c) => c.id).sort()) === JSON.stringify(['arbitrum', 'base', 'bnb', 'ethereum', 'optimism']), 'manifest: the five chains')
  const bnb = manifest.chains.find((c) => c.id === 'bnb')
  ok(bnb?.vault === 'local' && bnb?.dollar?.symbol === 'USDT' && bnb?.dollar?.decimals === 18, 'manifest: BNB Chain — vault "local", dollar USDT / 18')
  ok(manifest.chains.filter((c) => c.id !== 'bnb').every((c) => c.vault === 'cctp' && !c.dollar), 'manifest: the four others — vault "cctp", the top-level USDC')
  ok(manifest.dollar?.symbol === 'USDC' && manifest.dollar?.decimals === 6, 'manifest: top-level dollar USDC / 6')
  const bad = relay.records.filter((r) => !r.ok)
  ok(bad.length === 0, `every relayed message executed (${relay.records.length} delivered${bad.length ? `, ${bad.length} reverted: ${bad.map((b) => `${b.op} ${b.src}→${b.dst}`).join(', ')}` : ''})`)
  ok(relay.errors.length === 0, `the relay met no error${relay.errors.length ? `: ${relay.errors.slice(0, 3).join(' | ')}` : ''}`)
  if (fails.length) throw new Error(`${fails.length} end-state check(s) failed: ${fails.join('; ')}`)
  return { ok: true }
}

/* ------------------------------- measurements ------------------------------- */

async function measure({ profile, url, relay, abi }) {
  const state = JSON.parse(fs.readFileSync(process.env.SPAWN_STATE_FILE, 'utf8'))
  const { hubGasFor } = require('../config/profiles')
  const coder = ethers.AbiCoder.defaultAbiCoder()
  const GW = new ethers.Interface(abi('SpawnGateway'))
  const PAD = new ethers.Interface(abi('SpawnPad'))
  const LZM = new ethers.Interface(abi('LayerZeroOmniMessenger'))
  const ERC = new ethers.Interface(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'])
  const hub = state.base
  const label = (n) => profile.nets[n].label
  const callR = async (net, iface, to, fn, args = []) =>
    iface.decodeFunctionResult(fn, await rpc(url[net], 'eth_call', [{ to, data: iface.encodeFunctionData(fn, args) }, 'latest']))
  const tx = async (net, to, iface, fn, args, value = 0n, gas = 3_000_000) => {
    const rc = await sendAs(url[net], DEPLOYER, { to, data: iface.encodeFunctionData(fn, args), value: ethers.toQuantity(value), gas: ethers.toQuantity(gas) })
    if (rc.status !== '0x1') throw new Error(`${fn} on ${net} reverted`)
    return rc
  }
  const out = {}

  // ── 1. the live quotes of our verifier set: the worst SYNC toward each spoke ──
  const WORST_SYNC = coder.encode(['uint8', 'bytes'], [10, coder.encode(['bytes32', 'string', 'string'], [ethers.ZeroHash, 'N'.repeat(64), 'S'.repeat(16)])])
  out.syncQuotes = {}
  for (const n of NETS.filter((x) => x !== 'base')) {
    const [q] = await callR('base', LZM, hub.adapter, 'quote', [label(n), ethers.zeroPadValue(state[n].gateway, 32), WORST_SYNC, 0])
    out.syncQuotes[n] = q
    console.log(`  worst SYNC hub → ${n}: ${ethers.formatEther(q)} ETH`)
  }

  // ── 2. hubGasFor: the worst admitted spawn from Optimism, four remote chains ──
  const setCaps = async (caps) => {
    for (const n of ['optimism', 'arbitrum', 'ethereum', 'bnb']) {
      await tx('base', hub.pad, PAD, 'setSyncCap', [label(n), caps[n] ?? 0n])
    }
  }
  const restore = { ethereum: ethers.parseEther(process.env.SPAWN_SYNC_CAP_ETHEREUM) }
  const op = state.optimism
  await tx('optimism', profile.nets.optimism.usdc, ERC, 'approve', [op.usd, ethers.MaxUint256])
  let n = 0
  const spawnFromOp = async ({ worst, devBuy }) => {
    n += 1
    const name = worst ? `${'N'.repeat(62)}${String(n).padStart(2, '0')}` : `GAS ${n}`
    const sym = worst ? 'S'.repeat(16) : 'GAS'
    const meta = worst ? 'm'.repeat(1024) : '{}'
    const [fee] = await callR('optimism', GW, op.gateway, 'quoteSpawn', [name, sym, meta, devBuy])
    const before = relay.records.length
    if (devBuy) await tx('optimism', op.gateway, GW, 'spawnTokenUsdc', [name, sym, meta, 1_000_000n, 1], fee, 1_500_000)
    else await tx('optimism', op.gateway, GW, 'spawnToken', [name, sym, meta, 0, 1], fee, 1_500_000)
    // the SPAWN lands on the hub
    for (let i = 0; i < 300; i++) {
      const r = relay.records.slice(before).find((x) => x.op === 'SPAWN')
      if (r) {
        await relay.idle()
        return r
      }
      await new Promise((res) => setTimeout(res, 300))
    }
    throw new Error('the measurement SPAWN did not land')
  }
  const BIG = ethers.parseEther('1')
  relay.generous = 15_000_000n // measure what it costs, not whether the limit holds (compared below)
  const variants = {}
  await setCaps({ ethereum: restore.ethereum }) // as launched: Ethereum over its ceiling
  variants.A_ethSkipped = await spawnFromOp({ worst: true, devBuy: true })
  await setCaps({ ethereum: BIG })
  variants.B_ethCeilingUnder = await spawnFromOp({ worst: true, devBuy: true })
  await setCaps({ optimism: BIG, arbitrum: BIG, ethereum: BIG, bnb: BIG })
  variants.C_fourCeilings = await spawnFromOp({ worst: true, devBuy: true })
  await setCaps({})
  variants.D_noCeiling = await spawnFromOp({ worst: true, devBuy: true })
  variants.E_typical = await spawnFromOp({ worst: false, devBuy: false })
  relay.generous = 0n
  out.spawn = Object.fromEntries(Object.entries(variants).map(([k, r]) => [k, { exec: r.exec, bought: r.bought }]))
  const g = (k) => BigInt(variants[k].exec)
  const perSend = g('B_ethCeilingUnder') - g('A_ethSkipped')
  const perQuote = (g('C_fourCeilings') - g('B_ethCeilingUnder')) / 3n
  const base = g('D_noCeiling') - 4n * perSend
  out.hubGas = {
    perRemoteChain: perSend,
    perCeilingQuote: perQuote,
    base,
    worst: g('C_fourCeilings'),
    configured: variants.A_ethSkipped.bought,
    formula4x1: hubGasFor(profile, 4, 1),
    formula4x4: hubGasFor(profile, 4, 4),
  }
  for (const [k, r] of Object.entries(variants)) console.log(`  SPAWN from Optimism, ${k}: ${r.exec} gas (the spoke buys ${r.bought})`)
  console.log(`  ⇒ per remote chain ≈ ${perSend}, per ceiling quote ≈ ${perQuote}, the rest ≈ ${base}`)

  // ── 3. a dev claim from Optimism (CLAIM on the hub, PAYOUT on Optimism) ──
  const canary = await (async () => {
    const [len] = await callR('base', PAD, hub.pad, 'tokensLength')
    for (let i = Number(len) - 1; i >= 0; i--) {
      const [t] = await callR('base', PAD, hub.pad, 'allTokens', [i])
      const m = await callR('base', PAD, hub.pad, 'metas', [t])
      if (m[1] === 'CANARY') return t
    }
  })()
  const [claimFee] = await callR('optimism', GW, op.gateway, 'quoteClaim')
  await tx('optimism', op.gateway, GW, 'claimFees', [canary], claimFee)
  await relay.idle()
  await relay.idle()

  // ── 4. SYNC_GAS_FLOOR: a real send, a real quote, their depth — and the most
  // gas a STARVED call ever leaves behind (callTracer over a gas sweep) ──
  await setCaps({ optimism: BIG, arbitrum: BIG, ethereum: BIG, bnb: BIG }) // four quotes + four sends, then only an event
  relay.hold = (item) => item.op === 1 && item.dst === 'base'
  await spawnFromOp({ worst: true, devBuy: false }).catch(() => {})
  await waitHeld(relay, 1)
  const heldSpawn = relay.held.shift()
  out.floorSpawn = await floorSweep({ relay, url, item: heldSpawn, PAD, hub, endpoint: profile.endpoint, expectSends: 4, label: 'spawn, no dev buy, four ceilings under' })
  relay.hold = null
  await relay.execute(heldSpawn)
  await relay.idle()

  // an OPEN from Ethereum of a token the launch skipped there (variant A)
  await setCaps({ ethereum: restore.ethereum })
  const skippedToken = await (async () => {
    const [len] = await callR('base', PAD, hub.pad, 'tokensLength')
    for (let i = Number(len) - 1; i >= 0; i--) {
      const [t] = await callR('base', PAD, hub.pad, 'allTokens', [i])
      const [rep] = await callR('ethereum', GW, state.ethereum.gateway, 'replicaOf', [t])
      if (rep === ethers.ZeroAddress) return t
    }
  })()
  if (skippedToken) {
    relay.hold = (item) => item.op === 6 && item.dst === 'base'
    const [openFee] = await callR('ethereum', GW, state.ethereum.gateway, 'quoteOpen')
    await tx('ethereum', state.ethereum.gateway, GW, 'openToken', [skippedToken], openFee)
    await waitHeld(relay, 1)
    const heldOpen = relay.held.shift()
    out.floorOpen = await floorSweep({ relay, url, item: heldOpen, PAD, hub, endpoint: profile.endpoint, expectSends: 1, label: 'open from Ethereum' })
    relay.hold = null
    await relay.execute(heldOpen)
    await relay.idle()
  }
  await setCaps({ ethereum: restore.ethereum })

  // ── 5. every op where it lands, from every delivery of the rehearsal ──
  const byOp = {}
  for (const r of relay.records) {
    if (!r.ok) continue
    const k = `${r.op} → ${r.dst}`
    const e = (byOp[k] ??= { n: 0, min: Infinity, max: 0, bought: r.bought })
    const x = Number(r.exec)
    e.n += 1
    e.min = Math.min(e.min, x)
    e.max = Math.max(e.max, x)
  }
  out.ops = byOp
  console.log('  every op where it lands (exec gas, min–max over the rehearsal; what the sender bought):')
  for (const [k, e] of Object.entries(byOp).sort()) console.log(`    ${k.padEnd(22)} ${String(e.min).padStart(9)} – ${String(e.max).padStart(9)}  (n=${e.n}, bought ${e.bought})`)
  return out
}

async function waitHeld(relay, count, ms = 120_000) {
  const t = Date.now()
  while (relay.held.length < count) {
    if (Date.now() - t > ms) throw new Error('the measurement packet was never held')
    await new Promise((r) => setTimeout(r, 300))
  }
}

/** Flattens a callTracer tree with depths. */
function flatten(frame, depth = 0, out = [], parent = null) {
  const f = { ...frame, depth, parent, gas: BigInt(frame.gas ?? 0), gasUsed: BigInt(frame.gasUsed ?? 0) }
  out.push(f)
  for (const c of frame.calls ?? []) flatten(c, depth + 1, out, f)
  return out
}

/**
 * For a verified, NOT executed packet on the hub: the trace of a well-fed
 * delivery (each real send / quote the pad makes: gas used, call depth),
 * the least gas that delivers it, and a sweep of the gas below that — every
 * outcome classified. A starved send or quote must revert the whole delivery
 * ("PAD: gas"); a delivery that succeeds while a send or quote failed is a
 * HOLE. For every starved run, the gas the pad held after the failed call
 * (≈ child.gas/63 + child.gas − child.gasUsed) is compared with the floor.
 */
async function floorSweep({ relay, url, item, PAD, hub, endpoint, expectSends, label }) {
  const data = relay.lzReceiveData(item)
  const base = 21_000n + 4n * BigInt(ethers.getBytes(data).reduce((a, b) => a + (b === 0 ? 1 : 4), 0))
  const callTx = (gas) => ({ from: EXECUTOR, to: endpoint, data, value: ethers.toQuantity(item.value), gas: ethers.toQuantity(base + gas) })
  const trace = (gas) => rpc(url.base, 'debug_traceCall', [callTx(gas), 'latest', { tracer: 'callTracer', tracerConfig: { withLog: true } }], 300_000)
  const syncFailedTopic = PAD.getEvent('SyncFailed').topicHash
  const padAddr = hub.pad.toLowerCase()
  const adapterAddr = hub.adapter.toLowerCase()
  const LZM_SEND = ethers.id('send(uint32,bytes32,bytes,uint256)').slice(0, 10)
  const LZM_QUOTE = ethers.id('quote(uint32,bytes32,bytes,uint256)').slice(0, 10)

  const analyse = (t) => {
    const frames = flatten(t)
    const pad = frames.find((f) => f.to?.toLowerCase() === padAddr)
    const children = frames.filter((f) => f.parent === pad && f.to?.toLowerCase() === adapterAddr)
    const sends = children.filter((f) => f.input?.startsWith(LZM_SEND))
    const quotes = children.filter((f) => f.input?.startsWith(LZM_QUOTE))
    const deepest = (f) => {
      let d = 0
      const walk = (x) => {
        d = Math.max(d, x.depth - f.depth)
        for (const c of frames.filter((y) => y.parent === x)) walk(c)
      }
      walk(f)
      return d
    }
    const logs = []
    const collect = (fr) => {
      for (const l of fr.logs ?? []) logs.push(l)
      for (const c of fr.calls ?? []) collect(c)
    }
    collect(t)
    const syncFailed = logs.filter((l) => l.topics?.[0] === syncFailedTopic).length
    return { frames, pad, sends, quotes, deepest, syncFailed, reverted: !!t.error, error: t.error, reason: t.revertReason }
  }

  // a well-fed delivery
  const fed = analyse(await trace(15_000_000n))
  if (fed.reverted) throw new Error(`the held ${label} reverts even with 15M gas: ${fed.error} ${fed.reason ?? ''}`)
  const sendGas = fed.sends.map((f) => Number(f.gasUsed))
  const quoteGas = fed.quotes.map((f) => Number(f.gasUsed))
  const depth = Math.max(...[...fed.sends, ...fed.quotes].map((f) => fed.deepest(f)))
  console.log(`  ${label}: ${fed.sends.length} real send(s) ${sendGas.join(', ')} gas; ${fed.quotes.length} real quote(s) ${quoteGas.join(', ')} gas; call depth below the pad ${depth}`)
  if (fed.sends.length < expectSends) throw new Error(`expected ${expectSends} sends in the well-fed ${label}, saw ${fed.sends.length}`)

  // the least gas that delivers it (eth_call: success = no revert)
  const succeeds = async (gas) => {
    try {
      await rpc(url.base, 'eth_call', [callTx(gas), 'latest'])
      return true
    } catch {
      return false
    }
  }
  let lo = 100_000n
  let hi = 15_000_000n
  while (hi - lo > 1_000n) {
    const mid = (lo + hi) / 2n
    if (await succeeds(mid)) hi = mid
    else lo = mid
  }
  const gMin = hi
  console.log(`  ${label}: least gas that delivers it ≈ ${gMin}`)

  // the sweep
  const span = BigInt(Math.max(...sendGas, ...quoteGas, 200_000)) * BigInt(expectSends + fed.quotes.length + 1)
  const step = BigInt(process.env.FORK_SWEEP_STEP ?? '5000')
  let starved = 0
  let holes = 0
  let maxLeft = 0n
  let maxLeftAt
  let runs = 0
  const from = gMin - span > 200_000n ? gMin - span : 200_000n
  for (let gas = from; gas <= gMin + 50_000n; gas += step) {
    runs += 1
    const a = analyse(await trace(gas))
    const failedKids = [...a.sends, ...a.quotes].filter((f) => f.error)
    if (!a.reverted) {
      if (failedKids.length || a.syncFailed) {
        holes += 1
        console.log(`  ✗ HOLE at ${gas} gas: the delivery succeeded with ${failedKids.length} failed send/quote, ${a.syncFailed} SyncFailed`)
      }
      continue
    }
    if (!failedKids.length) continue // ran out of gas elsewhere: whole delivery reverts — fine
    starved += 1
    const last = failedKids[failedKids.length - 1]
    const left = last.gas / 63n + (last.gas - last.gasUsed)
    if (left > maxLeft) {
      maxLeft = left
      maxLeftAt = { gas: String(gas), call: last.input.startsWith(LZM_SEND) ? 'send' : 'quote', childGas: String(last.gas), childUsed: String(last.gasUsed), reason: a.reason ?? a.error }
    }
  }
  const margin = maxLeft > 0n ? Number(100_000n * 1000n / maxLeft) / 1000 : Infinity
  console.log(
    `  ${label}: ${runs} deliveries traced from ${from} to ${gMin + 50_000n} gas, step ${step}: ${starved} starved a send/quote ` +
      `(all reverted), ${holes} hole(s). Most gas left behind a starved call ≈ ${maxLeft} — the floor is 100,000: margin ×${margin}`,
  )
  return { sendGas, quoteGas, depth, gMin: String(gMin), runs, starved, holes, maxLeft: String(maxLeft), maxLeftAt, margin, analytical: { sixtyFourthsBound: String((BigInt(Math.max(...sendGas)) * BigInt(depth)) / 64n) } }
}

function printSummary(r) {
  console.log('\n━━━ summary ━━━')
  console.log(`  launch.sh done at ${r.launchMin}, finish.sh at ${r.finishMin}, total ${r.totalMin}`)
  if (!r.measure) return
  const m = r.measure
  console.log(`  hub gas: worst spawn ${m.hubGas.worst} (four ceilings); per remote chain ${m.hubGas.perRemoteChain}; per ceiling quote ${m.hubGas.perCeilingQuote}; hubGasFor(4,1) = ${m.hubGas.formula4x1}, (4,4) = ${m.hubGas.formula4x4}`)
  for (const k of ['floorSpawn', 'floorOpen']) {
    const f = m[k]
    if (f) console.log(`  floor (${k}): send ${f.sendGas.join('/')} quote ${f.quoteGas.join('/')} depth ${f.depth}; max left after starvation ${f.maxLeft} → margin ×${f.margin}; holes ${f.holes}`)
  }
}

main().catch((e) => {
  console.error(`\n✗ ${e.message ?? e}`)
  console.error(`  state and logs: ${dir}`)
  process.exit(1)
})
