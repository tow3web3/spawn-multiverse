/**
 * THE HUB SIDE OF SOLANA — label 1, the sixth chain (solana/V7.md §7, §9).
 *
 * Solana is not an EVM chain: its gateway is a program, its ids are 32-byte
 * keys, its "gas" is compute units and the native value the hub attaches to
 * a message toward it is LAMPORTS. So it is not one of the profile's `nets`
 * (every loop over those deploys, configures and reads EVM contracts); it is
 * `profile.solana`, and its state entry is `all.solana`:
 *
 *   { kind: 'solana', label: 1, eid, store, peer, vault?, prepays?, wired? }
 *     store    the gateway's OApp store — what the pad names as gateway 1
 *     peer     what the hub adapter believes for the Solana eid (setRoute)
 *     vault    the gateway's USDC vault, if it is to be a CCTP peer (forever)
 *     prepays  what the SOLANA side prepays into the hub tank — its reply
 *              unit (hub-native wei), trade / open / spawn legs, move legs
 *              per destination — read through the gateway's client
 *              (source: 'client') or given as an input (source: 'input')
 *
 * What it changes on the HUB, in this order (`planSolana`):
 *   operator   adapter.setDestination(1, gas CU, unit LAMPORTS); pad.setSyncCap(1, …) if wanted
 *   delegate   the endpoint config of the Solana pathway on the hub adapter:
 *              the executor's message size (LayerZero's default toward
 *              Solana mainnet is 200 bytes — every hub message is 288–512),
 *              and on mainnet the libraries pinned and our verifier set on
 *              both sides (send: Base's confirmations, receive: Solana's 32)
 *   admin      vault.setPeer(1, 5, vault) on the hub chain's USDC vault (if a
 *              vault is given); adapter.setRoute(1, eid, peer);
 *              pad.setGateway(1, store) — LAST, permanent
 * then the prices, by tune-fees.js on every chain (spokes, then the hub,
 * twice): moveLegs(1) on every EVM gateway, the Solana SYNC in every
 * spawnLegs, requestCap(1, 10) / (1, 12), the hub-bound gas.
 *
 * Two ways in: DIRECT, when the signer is still the hub's admin and the
 * endpoint delegate (the testnet today; mainnet before finish.sh) — every
 * step is sent in order; or THROUGH THE TIMELOCK — the operator steps are
 * sent, the delegate and admin steps become ONE batch scheduled by OWNER and
 * executed after the delay (scripts/timelock-ops.js execute, or the next run
 * of add-solana.sh).
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { ethers } = require('hardhat')
const { SOLANA_BOUNDS, dvnSetFor } = require('../config/profiles')
const { loadState, saveState, b32, same, hasRole, isDevNode, MAINNET_CONFIRM } = require('./lib-net')
const { ENDPOINT_CFG_ABI, ULN_ABI, dvnAddresses, encodeUln, storedUln, ulnEq, CONFIG_TYPE_EXECUTOR, CONFIG_TYPE_ULN, EXEC_TUPLE } = require('./lib-dvn')
const { recordOp, saltOf, batchOf, ensureGas, executeGas, feePerGas } = require('./lib-timelock')

const coder = ethers.AbiCoder.defaultAbiCoder()
const fmt = (wei) => ethers.formatEther(wei)
const SOLANA_DIR = process.env.SPAWN_SOLANA_DIR ?? path.join(__dirname, '..', '..', 'solana')

/* ----------------------------------- ids ----------------------------------- */

/** A 32-byte key, from 0x-hex (64 digits) or base58; lower-case 0x hex. */
function toKey32(x, what = 'key') {
  if (!x) throw new Error(`the Solana ${what} is required`)
  let hex
  if (/^0x[0-9a-fA-F]{64}$/.test(x)) hex = x.toLowerCase()
  else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x)) hex = ethers.toBeHex(ethers.decodeBase58(x), 32)
  else throw new Error(`the Solana ${what} must be 32 bytes — 0x + 64 hex digits, or base58 (got "${x}")`)
  return hex
}
/** A wide id: its top twelve bytes are not all zero (not address-shaped). */
const isWide = (k32) => BigInt(k32) >> 160n !== 0n

/** Checks the Solana ids: 32-byte keys, and WIDE — an address-shaped id on
 * label 1 would make the pad treat Solana as an EVM chain (SpawnPad._move). */
function checkIds({ store, peer, vault }) {
  const out = { store: toKey32(store, 'store'), peer: toKey32(peer, 'peer') }
  if (vault) out.vault = toKey32(vault, 'vault')
  for (const [k, v] of Object.entries(out)) {
    if (!isWide(v)) throw new Error(`the Solana ${k} ${v} is address-shaped (top 12 bytes zero): a Solana key never is — refusing`)
  }
  return out
}

/** The hub-side numbers for label 1, refused when they cannot be right:
 * the gas is compute units (≤ Solana's 1,400,000 per transaction), the unit
 * LAMPORTS (≤ LayerZero's 240,000,000 cap, ≥ a user account's rent) — a
 * figure in wei is refused with the reason. */
function checkSolanaParams(sol) {
  const gas = BigInt(sol.gas)
  const unit = BigInt(sol.unit)
  if (gas > SOLANA_BOUNDS.maxGas || gas < SOLANA_BOUNDS.minGas) {
    throw new Error(`Solana gas ${gas}: it is COMPUTE UNITS, between ${SOLANA_BOUNDS.minGas} and ${SOLANA_BOUNDS.maxGas} (Solana's ceiling per transaction) — 400,000 measured to fit every message`)
  }
  if (unit >= 10n ** 12n) {
    throw new Error(`Solana unit ${unit} looks like WEI: the unit toward Solana is LAMPORTS (9 decimals) — 3,000,000 lamports = 0.003 SOL. Refusing.`)
  }
  if (unit > SOLANA_BOUNDS.maxUnit || unit < SOLANA_BOUNDS.minUnit) {
    throw new Error(`Solana unit ${unit} lamports: must be between ${SOLANA_BOUNDS.minUnit} (a user account's rent) and ${SOLANA_BOUNDS.maxUnit} (LayerZero's cap toward Solana)`)
  }
  return { gas, unit }
}

/** The Solana entry of a state, when one is recorded (and the profile knows Solana). */
const solanaEntry = (profile, all) => (profile.solana && all?.solana?.store ? all.solana : null)

/* --------------------------------- reading --------------------------------- */

/**
 * The gateway, through its own client (solana/app), read-only: the JSON of
 * scripts/solana-read.ts, or { ok: false, error }. Needs solana/node_modules
 * (npm ci in solana/). `readSolana.inject` replaces it (tests).
 */
const readCache = new Map()
function readSolana(profile, opts = {}) {
  if (readSolana.inject) return readSolana.inject(profile, opts)
  const sol = profile.solana
  const key = `${opts.rpc ?? sol.rpc}|${sol.programId}`
  const hit = readCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  const value = readSolanaNow(profile, opts)
  readCache.set(key, { at: Date.now(), value })
  return value
}
function readSolanaNow(profile, opts) {
  const sol = profile.solana
  const tsnode = path.join(SOLANA_DIR, 'node_modules', 'ts-node', 'register')
  if (!fs.existsSync(path.join(SOLANA_DIR, 'node_modules', 'ts-node'))) {
    return { ok: false, error: `cannot read Solana: no ${path.join(SOLANA_DIR, 'node_modules')} (run npm ci in solana/)` }
  }
  const args = ['-r', tsnode, path.join(__dirname, 'solana-read.ts'), '--rpc', opts.rpc ?? sol.rpc, '--program-id', sol.programId]
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 90_000,
    env: {
      ...process.env,
      TS_NODE_PROJECT: path.join(SOLANA_DIR, 'app', 'test', 'tsconfig.json'),
      TS_NODE_TRANSPILE_ONLY: 'true',
      NODE_OPTIONS: '--no-experimental-strip-types',
      SPAWN_SOLANA_DIR: SOLANA_DIR,
    },
  })
  const line = (r.stdout ?? '').trim().split('\n').pop()
  try {
    return JSON.parse(line)
  } catch {
    return { ok: false, error: `the Solana reader failed: ${(r.stderr || r.error?.message || 'no output').slice(0, 300)}` }
  }
}

/** What the SOLANA side prepays into the hub tank, as lib-prices reads a
 * gateway's legs: from the client when it answers and names this store,
 * else the recorded input, else null (unknown). */
function solanaLegs(profile, all, opts = {}) {
  const e = solanaEntry(profile, all)
  if (!e) return null
  let p = null
  if (opts.read !== false && process.env.SPAWN_SOLANA_READ !== '0') {
    const r = readSolana(profile, opts)
    if (r.ok && same(r.store, e.store)) {
      p = { source: 'client', returnUnit: r.returnUnit, tradeLegs: r.tradeLegs, openLegs: r.openLegs, spawnLegs: r.spawnLegs, moveLegs: r.moveLegs }
    }
  }
  if (!p && e.prepays) p = { source: 'input', ...e.prepays }
  if (!p) return null
  return {
    label: 1,
    kind: 'solana',
    source: p.source,
    unit: BigInt(p.returnUnit),
    tradeLegs: Number(p.tradeLegs ?? 1),
    openLegs: Number(p.openLegs ?? 0),
    spawnLegs: Number(p.spawnLegs ?? 0),
    moveLegs: Object.fromEntries(Object.entries(p.moveLegs ?? {}).map(([l, v]) => [Number(l), Number(v)])),
  }
}

/* ---------------------------------- planning --------------------------------- */

/**
 * The hub-side steps still needed for label 1, read from the chain, in the
 * order they must run. Sends nothing.
 * opts: { profile, all, signer (hub network), ids: { store, peer, vault? } }
 * Returns { steps: [{ kind: 'operator' | 'delegate' | 'admin', desc, target, data }], context }
 */
async function planSolana({ profile, all, signer, ids }) {
  const sol = profile.solana
  if (!sol) throw new Error(`the ${profile.name} profile has no Solana entry`)
  const { gas, unit } = checkSolanaParams(sol)
  const hub = all[profile.hub]
  if (!hub?.pad || !hub?.adapter) throw new Error(`${profile.hub}: the hub is not deployed`)
  const adapter = await ethers.getContractAt('LayerZeroOmniMessenger', hub.adapter, signer)
  const pad = await ethers.getContractAt('SpawnPad', hub.pad, signer)
  const endpoint = new ethers.Contract(profile.endpoint, ENDPOINT_CFG_ABI, signer)
  const steps = []
  const step = (kind, desc, contract, fn, args) =>
    steps.push({ kind, desc, target: contract.target, data: contract.interface.encodeFunctionData(fn, args), fn, args })

  // a gateway already named for label 1 must be this store: a gateway is forever
  const gwNow = await pad.gateways(1)
  if (gwNow !== ethers.ZeroHash && !same(gwNow, ids.store)) {
    throw new Error(`the pad already names ${gwNow} as gateway 1 — permanent; it is not ${ids.store}. Stop.`)
  }
  const eidNow = Number(await adapter.eidOf(1))
  if (eidNow !== 0 && eidNow !== sol.eid) throw new Error(`the hub adapter routes label 1 to eid ${eidNow}, not ${sol.eid}`)
  if (eidNow !== 0 && !same(await adapter.peers(sol.eid), ids.peer)) {
    throw new Error(`the hub adapter believes ${await adapter.peers(sol.eid)} for eid ${sol.eid}, not ${ids.peer} (repointRoute is the admin's, through the timelock)`)
  }

  // ── operator: the destination (compute units, lamports) — before anything else ──
  const [g0, u0] = [BigInt(await adapter.gasLimit(1)), BigInt(await adapter.returnUnit(1))]
  if (g0 !== gas || u0 !== unit) {
    step('operator', `hub adapter.setDestination(1, ${gas} compute units, ${unit} LAMPORTS) — what every message toward Solana buys and brings`, adapter, 'setDestination', [1, gas, unit])
  }
  if (sol.syncCap !== undefined && BigInt(await pad.syncCap(1)) !== BigInt(sol.syncCap)) {
    step('operator', `pad.setSyncCap(1, ${fmt(sol.syncCap)} ETH) — launches skip Solana above it`, pad, 'setSyncCap', [1, sol.syncCap])
  }
  // label 1 NEVER gets the EVM per-op gas: a non-zero entry there is undone
  for (const op of [10, 11, 12, 13]) {
    if (BigInt(await adapter.gasForOp(1, op)) !== 0n) {
      step('operator', `hub adapter.setGasForOp(1, op ${op}, 0) — label 1 buys its compute units by setDestination, never the EVM per-op gas`, adapter, 'setGasForOp', [1, op, 0])
    }
  }

  // ── delegate: the endpoint config of the Solana pathway on the hub adapter ──
  const oapp = hub.adapter
  const sendLib = await endpoint.getSendLibrary(oapp, sol.eid)
  const [recvLib, recvIsDefault] = await endpoint.getReceiveLibrary(oapp, sol.eid)
  const sendC = new ethers.Contract(sendLib, ULN_ABI, signer)
  const exec = await sendC.getExecutorConfig(oapp, sol.eid)
  const sendCfg = []
  const recvCfg = []
  let plannedSend
  let plannedRecv
  if (profile.dvn) {
    // mainnet: pin both libraries, and the SAME verifier set as every pathway
    if (await endpoint.isDefaultSendLibrary(oapp, sol.eid)) step('delegate', `pin send library ${profile.hub} -> solana (${sendLib})`, endpoint, 'setSendLibrary', [oapp, sol.eid, sendLib])
    if (recvIsDefault) step('delegate', `pin receive library solana -> ${profile.hub} (${recvLib})`, endpoint, 'setReceiveLibrary', [oapp, sol.eid, recvLib, 0])
    const set = dvnSetFor(profile, profile.hub, 'solana')
    const required = dvnAddresses(profile, profile.hub, set.required)
    const optional = dvnAddresses(profile, profile.hub, set.optional)
    const uln = (confirmations) => ({
      confirmations: BigInt(confirmations), requiredDVNCount: required.length, optionalDVNCount: optional.length,
      optionalDVNThreshold: set.optionalThreshold, requiredDVNs: required, optionalDVNs: optional,
    })
    plannedSend = uln(profile.nets[profile.hub].confirmations)
    plannedRecv = uln(sol.confirmations)
    const curSend = await storedUln(endpoint, oapp, sendLib, sol.eid)
    const curRecv = await storedUln(endpoint, oapp, recvLib, sol.eid)
    if (!curSend || !ulnEq(curSend, plannedSend)) sendCfg.push({ eid: sol.eid, configType: CONFIG_TYPE_ULN, config: encodeUln(plannedSend) })
    if (!curRecv || !ulnEq(curRecv, plannedRecv)) recvCfg.push({ eid: sol.eid, configType: CONFIG_TYPE_ULN, config: encodeUln(plannedRecv) })
  }
  if (Number(exec.maxMessageSize) < sol.maxMessageSize) {
    // keep LayerZero's executor for the pathway; raise the size it admits
    sendCfg.unshift({ eid: sol.eid, configType: CONFIG_TYPE_EXECUTOR, config: coder.encode([EXEC_TUPLE], [[sol.maxMessageSize, exec.executor]]) })
  }
  if (sendCfg.length) {
    step('delegate', `endpoint.setConfig(send ${sendLib}, eid ${sol.eid}): ${sendCfg.map((c) => (c.configType === CONFIG_TYPE_EXECUTOR ? `executor ${exec.executor} max ${sol.maxMessageSize} bytes (now ${exec.maxMessageSize})` : `verifiers, ${plannedSend.confirmations} confirmations`)).join(' + ')}`, endpoint, 'setConfig', [oapp, sendLib, sendCfg])
  }
  if (recvCfg.length) {
    step('delegate', `endpoint.setConfig(receive ${recvLib}, eid ${sol.eid}): verifiers, ${plannedRecv.confirmations} confirmations`, endpoint, 'setConfig', [oapp, recvLib, recvCfg])
  }

  // ── admin: the CCTP peer (if a vault is given), the route, the gateway LAST ──
  if (ids.vault) {
    const vault = await ethers.getContractAt('OmniUSD', hub.localUsd, signer)
    const p = await vault.peers(1)
    if (p.vault === ethers.ZeroHash) {
      step('admin', `${profile.hub} USDC vault.setPeer(1, CCTP domain ${sol.cctpDomain}, ${ids.vault}) — Solana's vault, a CCTP peer FOREVER`, vault, 'setPeer', [1, sol.cctpDomain, ids.vault])
    } else if (!same(p.vault, ids.vault)) {
      throw new Error(`the ${profile.hub} vault already names ${p.vault} as Solana's CCTP peer — permanent; not ${ids.vault}`)
    }
  }
  if (eidNow === 0) step('admin', `hub adapter.setRoute(1, eid ${sol.eid}, ${ids.peer})`, adapter, 'setRoute', [1, sol.eid, ids.peer])
  if (gwNow === ethers.ZeroHash) step('admin', `pad.setGateway(1, ${ids.store}) — PERMANENT: from here every launch reaches Solana`, pad, 'setGateway', [1, ids.store])

  return {
    steps,
    context: { adapter, pad, endpoint, sendLib, recvLib, executor: exec.executor, maxMessageSize: Number(exec.maxMessageSize), gas, unit },
  }
}

/* ---------------------------------- running ---------------------------------- */

/**
 * Plans, and with `send` runs, the hub side of Solana on `netKey` (the hub).
 * opts: { profile, netKey, signer (operator / deployer), owner? (timelock
 *   proposer — the timelock path), ids, prepays?, send?, topUp?, stateFile?, log? }
 * Returns { mode: 'direct' | 'timelock', steps, sent, scheduled?, id?, wired }
 */
async function runSolana(opts) {
  const { profile, netKey, signer, log = console.log } = opts
  if (netKey !== profile.hub) throw new Error(`Solana is wired on the hub (${profile.hub}), not on ${netKey}`)
  const stateFile = opts.stateFile ?? profile.stateFile
  const ids = checkIds(opts.ids)
  const all = loadState(stateFile)
  const sol = profile.solana
  const live = !(await isDevNode(signer.provider))
  if (opts.send && profile.mainnet && live && process.env.SPAWN_MAINNET_CONFIRM !== MAINNET_CONFIRM) {
    throw new Error(`refusing to send mainnet transactions without SPAWN_MAINNET_CONFIRM=${MAINNET_CONFIRM}`)
  }
  if (all.solana?.store && !same(all.solana.store, ids.store)) {
    throw new Error(`the state already records Solana's store ${all.solana.store}, not ${ids.store}`)
  }
  const { steps, context } = await planSolana({ profile, all, signer, ids })
  const hub = all[profile.hub]
  const pad = context.pad
  const isAdmin = await hasRole(pad, 'admin', signer.address) && (await hasRole(context.adapter, 'admin', signer.address))
  const delegate = await context.endpoint.delegates(hub.adapter)
  const mode = isAdmin && same(delegate, signer.address) ? 'direct' : 'timelock'
  log(`Solana (label 1, eid ${sol.eid}) on ${profile.name}/${netKey} — ${mode === 'direct' ? 'DIRECT (the signer is the hub admin and the endpoint delegate)' : `THROUGH THE TIMELOCK ${hub.timelock ?? '(none recorded!)'}`}`)
  log(`  store ${ids.store}  peer ${ids.peer}${ids.vault ? `  vault ${ids.vault}` : '  (no CCTP vault given)'}`)
  log(`  executor toward Solana: ${context.executor}, message size ${context.maxMessageSize} bytes (needs ${sol.maxMessageSize})`)
  if (!steps.length) log('  nothing to do on the hub: label 1 is wired as planned')
  for (const [i, s] of steps.entries()) log(`  ${i + 1}. [${s.kind}] ${s.desc}\n       target ${s.target}\n       data   ${s.data}`)

  // record what was asked (a dry run records nothing)
  const record = () => {
    const fresh = loadState(stateFile)
    fresh.solana = {
      ...(fresh.solana ?? {}), kind: 'solana', label: 1, eid: sol.eid, store: ids.store, peer: ids.peer,
      ...(ids.vault ? { vault: ids.vault } : {}),
      ...(opts.prepays ? { prepays: { ...opts.prepays, recordedAt: new Date().toISOString() } } : {}),
    }
    saveState(stateFile, fresh)
  }
  const out = { mode, steps, sent: [], wired: false }
  if (!opts.send) {
    log(steps.length ? '  DRY RUN — nothing sent (SPAWN_SEND=1, or --send, sends it)' : '')
    out.wired = (await pad.gateways(1)) !== ethers.ZeroHash
    return out
  }
  record()
  const send = async (s) => {
    const rc = await (await signer.sendTransaction({ to: s.target, data: s.data })).wait()
    if (rc.status !== 1) throw new Error(`${s.desc}: reverted`)
    out.sent.push(s.desc)
    log(`  ✓ ${s.desc}`)
  }
  const operator = steps.filter((s) => s.kind === 'operator')
  if (operator.length && !(await hasRole(context.adapter, 'operator', signer.address))) {
    throw new Error(`${signer.address} is not the operator of the hub adapter — the operator steps come first`)
  }
  for (const s of operator) await send(s)
  const rest = steps.filter((s) => s.kind !== 'operator')
  if (mode === 'direct') {
    for (const s of rest) await send(s)
  } else if (rest.length) {
    // the delegate and admin steps: ONE atomic batch on the hub's timelock
    if (!hub.timelock || !hub.handover) throw new Error(`${netKey}: the signer is not the admin, and no hand-over is recorded — who is?`)
    if (!opts.owner) throw new Error('the timelock path needs OWNER (contracts/.env.owner, or impersonated on a fork)')
    if (BigInt(await context.adapter.gasLimit(1)) === 0n) throw new Error('the destination toward Solana has no gas limit on chain: the batch would let the pad SYNC into a closed leg')
    const timelock = await ethers.getContractAt('SpawnTimelock', hub.timelock, opts.owner)
    const calls = rest.map((s) => ({ target: s.target, data: s.data, desc: s.desc, source: 'solana' }))
    const { targets, values, datas } = batchOf(calls)
    const salt = saltOf(`${netKey}/solana`, calls)
    const id = await timelock.hashOperationBatch(targets, values, datas, ethers.ZeroHash, salt)
    out.id = id
    if (await timelock.isOperationDone(id)) {
      log(`  the batch ${id} was executed already`)
    } else if (await timelock.isOperation(id)) {
      log(`  the batch ${id} is scheduled — executable from ${new Date(Number(await timelock.getTimestamp(id)) * 1000).toISOString()}: SPAWN_OPS=execute npx hardhat run scripts/timelock-ops.js --network ${netKey}`)
    } else {
      const delay = await timelock.getMinDelay()
      const fee = await feePerGas(signer.provider)
      const need = ((150_000n + 60_000n * BigInt(calls.length)) + (await executeGas(signer.provider, hub.timelock, calls))) * fee * 2n
      const until = async (what, fn) => {
        for (let i = 0; i < 60; i++) if (await fn().catch(() => false)) return
        throw new Error(`${what}: not visible`)
      }
      await ensureGas({ who: opts.owner, need, payer: signer, topUp: opts.topUp, what: 'scheduling and executing the Solana batch', netKey, until, log })
      await (await timelock.scheduleBatch(targets, values, datas, ethers.ZeroHash, salt, delay)).wait()
      const eta = Number(await timelock.getTimestamp(id))
      recordOp(stateFile, netKey, { id, salt, predecessor: ethers.ZeroHash, calls, delay: Number(delay), eta, scheduledAt: new Date().toISOString(), status: 'scheduled' })
      out.scheduled = true
      log(`  ✓ scheduled as ONE batch (${calls.length} calls) — operation ${id}, executable from ${new Date(eta * 1000).toISOString()}; the guardian or OWNER can cancel it until then`)
    }
  }
  out.wired = (await pad.gateways(1)) !== ethers.ZeroHash
  if (out.wired) {
    const fresh = loadState(stateFile)
    fresh.solana = { ...fresh.solana, wired: true }
    saveState(stateFile, fresh)
  }
  return out
}

/**
 * What the SOLANA side should prepay, from the hub's live quotes — the
 * figures for solana/scripts/wire.ts (set_fee_config, set_open_legs,
 * set_move_legs), all in hub-native wei except the legs:
 *   returnUnit = the hub's DELIVER quote toward Solana + margin
 *   openLegs   = the worst SYNC toward Solana (it carries the unit) + margin, in units
 *   moveLegs   = per destination, its PAYOUT + margin, in units (never under tradeLegs)
 *   spawnLegs  = Σ of the SYNCs a launch reaches + margin, in units
 * Read-only; needs the route toward Solana.
 */
async function solanaSidePrices({ profile, all, signer, marginPct = 25 }) {
  const { WORST_SYNC, SAMPLE_PAYOUT } = require('./lib-prices')
  const { encodeOp } = require('./lib-wire')
  const hub = all[profile.hub]
  const e = solanaEntry(profile, all)
  const adapter = await ethers.getContractAt('LayerZeroOmniMessenger', hub.adapter, signer)
  const pad = await ethers.getContractAt('SpawnPad', hub.pad, signer)
  const m = (x) => (x * BigInt(100 + marginPct)) / 100n
  const ceil = (a, b) => (a === 0n ? 0n : (a - 1n) / b + 1n)
  if ((await adapter.eidOf(1)) === 0n) throw new Error('no route toward Solana yet: nothing to quote')
  const deliver = await adapter.quote(1, e.store, encodeOp('DELIVER', [ethers.ZeroHash, ethers.ZeroHash, 0n, 0n]), 0)
  const sync = await adapter.quote(1, e.store, WORST_SYNC, 1)
  const unit = m(deliver)
  const out = { returnUnit: unit, tradeLegs: 1, openLegs: Number(ceil(m(sync), unit)), moveLegs: {}, spawnSyncs: {} }
  let sum = 0n
  for (const [net, c] of Object.entries(require('../config/profiles').activeNets(profile))) {
    if (!all[net]?.gateway) continue
    if (net === profile.hub) {
      out.moveLegs[c.label] = 1 // toward the hub chain's own gateway: a local call, the way home only
      continue
    }
    if ((await adapter.eidOf(c.label)) === 0n) continue
    const gw = b32(all[net].gateway)
    const payout = await adapter.quote(c.label, gw, SAMPLE_PAYOUT, 1)
    const s = await adapter.quote(c.label, gw, WORST_SYNC, 1)
    const capS = BigInt(await pad.syncCap(c.label))
    out.moveLegs[c.label] = Math.max(1, Number(ceil(m(payout), unit)))
    if (capS === 0n || s <= capS) {
      sum += s
      out.spawnSyncs[net] = s
    }
  }
  sum += sync // the SYNC back to Solana itself
  out.spawnLegs = Number(ceil(m(sum), unit))
  out.quotes = { deliver, sync }
  return out
}

module.exports = { toKey32, isWide, checkIds, checkSolanaParams, solanaEntry, readSolana, solanaLegs, planSolana, runSolana, solanaSidePrices }
