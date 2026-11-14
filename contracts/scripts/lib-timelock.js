/**
 * Admin operations THROUGH THE TIMELOCK, after the hand-over.
 *
 * Once a network is handed over (scripts/lib-handover.js) its contracts'
 * admin is a TimelockController, OWNER its only proposer/executor. Every
 * topology or custody step — a new route, a new gateway on the pad, a CCTP
 * peer, the DVN set of a new pathway — is then something `deploy.js` and
 * `configure-dvn.js` can only PRINT. This file turns that printout into a
 * scheduled operation and, after the delay, an executed one:
 *
 *   collect   the admin-only steps the current plan still needs (nothing sent)
 *   schedule  ONE atomic batch per network, deterministic salt, recorded in
 *             the state file with its id and ETA
 *   execute   once the delay has passed
 *   list / cancel
 *
 * Rules it keeps (learned the hard way on public RPCs, see lib-handover.js):
 *  - an operation that exists is never scheduled again, one that is done is
 *    left alone — every step looks at the chain first, so a run interrupted
 *    anywhere resumes;
 *  - every step that depends on the previous one waits until it is VISIBLE
 *    on this RPC;
 *  - the batch is refused while a step the deployer/operator can still send
 *    is pending: the operator pre-steps (a destination's gas limit) must be
 *    ON CHAIN before the batch that makes the pad use that destination is
 *    even scheduled;
 *  - DRY on mainnet unless SPAWN_MAINNET_CONFIRM, like every other script.
 *
 * OWNER usually holds no gas: the need is computed, and either printed as an
 * exact top-up or (topUp) sent from the deployer.
 */
const fs = require('fs')
const path = require('path')
const { ethers } = require('hardhat')
const { deployNet, loadState, saveState, same, isDevNode, MAINNET_CONFIRM } = require('./lib-net')
const { configureDvn } = require('./lib-dvn')

const fmt = (wei) => ethers.formatEther(wei)
const coder = ethers.AbiCoder.defaultAbiCoder()
const quietLog = () => {}

/** What a rollup charges on top of execution gas for posting the calldata —
 * invisible to eth_estimateGas, small, and covered by a flat allowance. */
const L1_DATA_ALLOWANCE = ethers.parseEther('0.00005')

function makeUntil(live) {
  return async (what, fn) => {
    for (let i = 0; i < 60; i++) {
      if (await fn().catch(() => false)) return
      if (live) await new Promise((r) => setTimeout(r, 2000))
    }
    throw new Error(`${what}: still not visible on this RPC after 2 minutes — run it again, it resumes`)
  }
}

const isDry = (profile, live, opts) =>
  opts.dry ?? (process.env.SPAWN_DRY === '1' || (profile.mainnet && live && process.env.SPAWN_MAINNET_CONFIRM !== MAINNET_CONFIRM))

/* --------------------------------- collect --------------------------------- */

/**
 * The admin-only steps `netKey` still needs, as the timelock's calls, in the
 * order they must execute: the DVN set of any new pathway FIRST (so the pad
 * never sends on a pathway whose two ends disagree), then the deploy
 * script's own admin steps in its order (setRoute before setGateway).
 * Sends nothing. `signer` is the deployer/operator.
 * Returns { calls, pending, operatorBlocked }: `pending` are steps `signer`
 * could send right now and has not; `operatorBlocked` are operator steps it
 * may not send.
 */
async function collectAdminSteps({ profile, netKey, signer, stateFile, providers, log = quietLog }) {
  const ctx = await deployNet({
    profile, netKey, signer, dry: true, stateFile, providers, manifest: false, log, preflight: false,
  })
  if (ctx.preflight && !ctx.preflight.ok) {
    throw new Error(`${netKey}: preflight failed (${ctx.preflight.failed.map((f) => f.what).join('; ')}) — nothing collected`)
  }
  const admin = ctx.blocked.filter((b) => b.role === 'admin').map((b) => ({ target: b.target, data: b.data, desc: b.desc, source: 'deploy' }))
  const operatorBlocked = ctx.blocked.filter((b) => b.role !== 'admin')
  const dvn = []
  if (profile.dvn) {
    // only when the timelock really is the adapter's LayerZero delegate: on
    // a network not handed over yet the DVN set is the deployer's to send
    const state = loadState(stateFile ?? profile.stateFile)[netKey]
    const endpoint = new ethers.Contract(profile.endpoint, ['function delegates(address) view returns (address)'], signer.provider)
    const delegate = await endpoint.delegates(state.adapter)
    if (state.timelock && same(delegate, state.timelock)) {
      const res = await configureDvn({ profile, netKey, signer, stateFile, collect: true, log })
      for (const b of res.blocked) dvn.push({ target: b.target, data: b.data, desc: b.desc, source: 'dvn' })
    }
  }
  return { calls: [...dvn, ...admin], pending: ctx.plan, operatorBlocked }
}

const batchOf = (calls) => ({
  targets: calls.map((c) => c.target),
  values: calls.map(() => 0),
  datas: calls.map((c) => c.data),
})

/** Deterministic: the same calls on the same network are the same operation. */
function saltOf(netKey, calls) {
  const { targets, datas } = batchOf(calls)
  return ethers.id(`spawn/ops/${netKey}/${ethers.keccak256(coder.encode(['address[]', 'bytes[]'], [targets, datas]))}`)
}

/* ----------------------------------- gas ----------------------------------- */

async function feePerGas(provider) {
  const fee = await provider.getFeeData()
  return fee.maxFeePerGas ?? fee.gasPrice ?? 0n
}

/** Gas the batch will burn when the timelock executes it: each call
 * estimated FROM the timelock (it is their admin), plus the timelock's own
 * overhead. A call that cannot be estimated alone (it depends on an earlier
 * one in the batch) is counted generously. */
async function executeGas(provider, timelock, calls) {
  let gas = 120_000n + 30_000n * BigInt(calls.length)
  for (const c of calls) {
    try {
      gas += await provider.estimateGas({ from: timelock, to: c.target, data: c.data })
    } catch {
      gas += 400_000n
    }
  }
  return gas
}

/**
 * Makes sure `who` can pay `need`. Short → the exact top-up is printed and
 * the run stops; with `topUp` the deployer sends it (a plain transfer).
 */
async function ensureGas({ who, need, payer, topUp, what, netKey, until, log }) {
  const provider = who.provider
  const bal = await provider.getBalance(who.address)
  if (bal >= need) return { toppedUp: 0n }
  const short = need - bal
  const hint =
    `OWNER ${who.address} holds ${fmt(bal)} ETH on ${netKey}; ${what} needs about ${fmt(need)} ETH. ` +
    `Send ${fmt(short)} ETH to it on ${netKey} (from the deployer)`
  if (!topUp || !payer) throw new Error(`${hint}, or re-run with SPAWN_TOPUP=1 to let the deployer do it.`)
  const payerBal = await provider.getBalance(payer.address)
  if (payerBal < short * 2n) {
    throw new Error(`${hint} — the deployer ${payer.address} only holds ${fmt(payerBal)} ETH there: fund it first.`)
  }
  await (await payer.sendTransaction({ to: who.address, value: short })).wait()
  await until('the gas top-up of OWNER', async () => (await provider.getBalance(who.address)) >= need)
  log(`  OWNER topped up with ${fmt(short)} ETH from the deployer ✓`)
  return { toppedUp: short }
}

/* ---------------------------------- state ---------------------------------- */

function recordOp(stateFile, netKey, op) {
  const all = loadState(stateFile)
  const s = all[netKey]
  s.ops = (s.ops ?? []).filter((o) => o.id !== op.id)
  s.ops.push(op)
  saveState(stateFile, all)
}

async function attach(profile, netKey, stateFile, signer) {
  const state = loadState(stateFile)[netKey]
  if (!state?.adapter) throw new Error(`${netKey}: nothing deployed in ${stateFile}`)
  if (!state.timelock || !state.handover) {
    throw new Error(
      `${netKey}: not handed over — its admin is still the deployer, whose steps deploy.js sends directly (no timelock involved)`,
    )
  }
  const timelock = await ethers.getContractAt('SpawnTimelock', state.timelock, signer)
  return { state, timelock }
}

/* --------------------------------- schedule --------------------------------- */

/**
 * Schedules every admin step `netKey` still needs as ONE timelock batch.
 * opts: { profile, netKey, owner, deployer, stateFile?, providers?, dry?, topUp?, log? }
 *   owner    — signer holding the timelock's PROPOSER role
 *   deployer — the operator: used to COLLECT the plan, and to top OWNER up
 */
async function scheduleOps(opts) {
  const { profile, netKey, owner, deployer, log = console.log } = opts
  const stateFile = opts.stateFile ?? profile.stateFile
  const provider = owner.provider
  const live = !(await isDevNode(provider))
  const dry = isDry(profile, live, opts)
  const until = makeUntil(live)
  const { state, timelock } = await attach(profile, netKey, stateFile, owner)
  log(`timelock schedule — ${profile.name}/${netKey} — timelock ${state.timelock} — OWNER ${owner.address}${dry ? ' — DRY RUN' : ''}`)

  const { calls, pending, operatorBlocked } = await collectAdminSteps({
    profile, netKey, signer: deployer, stateFile, providers: opts.providers,
  })
  if (pending.length) {
    throw new Error(
      `${netKey}: ${pending.length} step(s) the deployer/operator must send BEFORE the admin batch is scheduled — ` +
        `run deploy.js on ${netKey} first:\n  - ${pending.join('\n  - ')}`,
    )
  }
  if (operatorBlocked.length) {
    throw new Error(
      `${netKey}: ${operatorBlocked.length} operator step(s) pending that ${deployer.address} may not send — the operator must:\n  - ` +
        operatorBlocked.map((b) => `${b.desc} (target ${b.target} data ${b.data})`).join('\n  - '),
    )
  }
  if (!calls.length) {
    log('  nothing to schedule: no admin step is pending on this network')
    return { scheduled: false, calls: [], dry }
  }

  const { targets, values, datas } = batchOf(calls)
  const salt = saltOf(netKey, calls)
  const id = await timelock.hashOperationBatch(targets, values, datas, ethers.ZeroHash, salt)
  const delay = await timelock.getMinDelay()
  log(`  ${calls.length} call(s), one atomic batch, in this order:`)
  for (const [i, c] of calls.entries()) log(`    ${i + 1}. ${c.desc}`)
  log(`  operation ${id} — delay ${delay}s (${(Number(delay) / 3600).toFixed(1)}h)`)

  if (await timelock.isOperationDone(id)) {
    throw new Error(
      `this exact batch (${id}) was ALREADY executed, yet its steps still read as needed — stop and investigate before scheduling anything`,
    )
  }
  const exists = await timelock.isOperation(id)
  if (dry) {
    log(exists ? '  (already scheduled)' : '  would: timelock.scheduleBatch(…) from OWNER')
    return { scheduled: false, dry: true, id, calls, exists }
  }
  let toppedUp = 0n
  if (!exists) {
    if (!(await timelock.hasRole(await timelock.PROPOSER_ROLE(), owner.address))) {
      throw new Error(`${owner.address} is not a proposer of the timelock ${state.timelock} — wrong OWNER key`)
    }
    const fee = await feePerGas(provider)
    let schedGas = 150_000n + 60_000n * BigInt(calls.length)
    try {
      schedGas = await timelock.scheduleBatch.estimateGas(targets, values, datas, ethers.ZeroHash, salt, delay)
    } catch {
      /* an RPC that refuses to estimate from an empty account: keep the upper bound */
    }
    const execGas = await executeGas(provider, state.timelock, calls)
    // both legs now, twice over: OWNER should not need a second top-up in 48h
    const need = (schedGas + execGas) * fee * 2n + (live ? L1_DATA_ALLOWANCE : 0n)
    ;({ toppedUp } = await ensureGas({
      who: owner, need, payer: deployer, topUp: opts.topUp, netKey, until, log,
      what: `scheduling and later executing this batch (${schedGas + execGas} gas at ${ethers.formatUnits(fee, 'gwei')} gwei, ×2)`,
    }))
    await (await timelock.scheduleBatch(targets, values, datas, ethers.ZeroHash, salt, delay)).wait()
    await until('the scheduled batch', () => timelock.isOperation(id))
    log('  timelock.scheduleBatch ✓')
  } else {
    log('  (already scheduled — not scheduled again)')
  }
  const eta = Number(await timelock.getTimestamp(id))
  recordOp(stateFile, netKey, {
    id, salt, predecessor: ethers.ZeroHash, calls, delay: Number(delay), eta,
    scheduledAt: new Date().toISOString(), status: 'scheduled',
  })
  log(`  ✓ scheduled — executable from ${new Date(eta * 1000).toISOString()} (the guardian or OWNER can cancel it until then)`)
  return { scheduled: !exists, id, eta, calls, toppedUp }
}

/* ---------------------------------- execute ---------------------------------- */

/**
 * Executes every recorded operation of `netKey` that is ready; reports the
 * ones still waiting. opts as scheduleOps (deployer only for the top-up).
 */
async function executeOps(opts) {
  const { profile, netKey, owner, deployer, log = console.log } = opts
  const stateFile = opts.stateFile ?? profile.stateFile
  const provider = owner.provider
  const live = !(await isDevNode(provider))
  const dry = isDry(profile, live, opts)
  const until = makeUntil(live)
  const { state, timelock } = await attach(profile, netKey, stateFile, owner)
  const out = { executed: [], waiting: [], missing: [], dry }
  const ops = (state.ops ?? []).filter((o) => o.status === 'scheduled')
  log(`timelock execute — ${profile.name}/${netKey} — timelock ${state.timelock}${dry ? ' — DRY RUN' : ''}`)
  if (!ops.length) {
    log('  no scheduled operation recorded for this network')
    return out
  }
  const now = Number((await provider.getBlock('latest')).timestamp)
  for (const op of ops) {
    const { targets, values, datas } = batchOf(op.calls)
    // the id binds what was scheduled: a state file that drifted is refused
    const id = await timelock.hashOperationBatch(targets, values, datas, op.predecessor, op.salt)
    if (!same(id, op.id)) throw new Error(`recorded operation ${op.id} does not hash to its own id (${id}) — the state file was altered`)
    const mark = (status, extra = {}) => recordOp(stateFile, netKey, { ...op, status, ...extra })
    if (await timelock.isOperationDone(id)) {
      mark('executed')
      out.executed.push({ id, already: true })
      log(`  ${id}: already executed ✓`)
      continue
    }
    if (!(await timelock.isOperation(id))) {
      mark('missing')
      out.missing.push({ id })
      log(`  ⚠ ${id}: not on the timelock any more — it was cancelled (veto). Re-run the schedule if it is still wanted.`)
      continue
    }
    if (!(await timelock.isOperationReady(id))) {
      const eta = Number(await timelock.getTimestamp(id))
      out.waiting.push({ id, eta, seconds: Math.max(0, eta - now) })
      log(`  ⏳ ${id}: executable from ${new Date(eta * 1000).toISOString()} — ${((eta - now) / 3600).toFixed(1)}h to go`)
      continue
    }
    log(`  ${id}: ready — ${op.calls.length} call(s)`)
    for (const [i, c] of op.calls.entries()) log(`    ${i + 1}. ${c.desc}`)
    if (dry) {
      log('  would: timelock.executeBatch(…) from OWNER')
      continue
    }
    if (!(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), owner.address))) {
      throw new Error(`${owner.address} is not an executor of the timelock ${state.timelock} — wrong OWNER key`)
    }
    const fee = await feePerGas(provider)
    let gas = await executeGas(provider, state.timelock, op.calls)
    try {
      gas = await timelock.executeBatch.estimateGas(targets, values, datas, op.predecessor, op.salt)
    } catch {
      /* keep the per-call estimate */
    }
    const need = gas * fee * 2n + (live ? L1_DATA_ALLOWANCE : 0n)
    await ensureGas({
      who: owner, need, payer: deployer, topUp: opts.topUp, netKey, until, log,
      what: `executing this batch (${gas} gas at ${ethers.formatUnits(fee, 'gwei')} gwei, ×2)`,
    })
    await (await timelock.executeBatch(targets, values, datas, op.predecessor, op.salt)).wait()
    await until('the executed batch', () => timelock.isOperationDone(id))
    mark('executed', { executedAt: new Date().toISOString() })
    out.executed.push({ id })
    log('  timelock.executeBatch ✓')
  }
  return out
}

/* -------------------------------- list / cancel -------------------------------- */

async function listOps({ profile, netKey, provider, stateFile, log = console.log }) {
  const file = stateFile ?? profile.stateFile
  const state = loadState(file)[netKey]
  const rows = []
  log(`timelock operations — ${profile.name}/${netKey} — timelock ${state?.timelock ?? '(none)'}`)
  if (!state?.timelock || !(state.ops ?? []).length) {
    log('  none recorded')
    return rows
  }
  const timelock = await ethers.getContractAt('SpawnTimelock', state.timelock, provider)
  const now = Number((await provider.getBlock('latest')).timestamp)
  for (const op of state.ops) {
    const [exists, ready, done] = await Promise.all([
      timelock.isOperation(op.id), timelock.isOperationReady(op.id), timelock.isOperationDone(op.id),
    ])
    const eta = exists && !done ? Number(await timelock.getTimestamp(op.id)) : op.eta
    const chain = done ? 'executed' : ready ? 'READY' : exists ? `waiting ${((eta - now) / 3600).toFixed(1)}h` : 'not on the timelock (cancelled)'
    rows.push({ id: op.id, chain, eta, calls: op.calls.length })
    log(`  ${op.id} — ${chain} — ${op.calls.length} call(s), scheduled ${op.scheduledAt}`)
    for (const [i, c] of op.calls.entries()) log(`    ${i + 1}. ${c.desc}`)
  }
  return rows
}

/** The veto: OWNER or the guardian (both hold CANCELLER) drops a scheduled
 * operation. Nothing in it ever executes. */
async function cancelOp({ profile, netKey, signer, id, stateFile, dry, log = console.log }) {
  const file = stateFile ?? profile.stateFile
  const live = !(await isDevNode(signer.provider))
  const until = makeUntil(live)
  const { state, timelock } = await attach(profile, netKey, file, signer)
  const op = (state.ops ?? []).find((o) => same(o.id, id))
  log(`timelock cancel — ${profile.name}/${netKey} — operation ${id}`)
  if (!(await timelock.isOperationPending(id))) {
    log('  not pending on the timelock (executed, cancelled or never scheduled) — nothing to cancel')
    return { cancelled: false }
  }
  if (isDry(profile, live, { dry })) {
    log('  would: timelock.cancel(id)')
    return { cancelled: false, dry: true }
  }
  if (!(await timelock.hasRole(await timelock.CANCELLER_ROLE(), signer.address))) {
    throw new Error(`${signer.address} holds no CANCELLER role on ${state.timelock}`)
  }
  await (await timelock.cancel(id)).wait()
  await until('the cancellation', async () => !(await timelock.isOperation(id)))
  if (op) recordOp(file, netKey, { ...op, status: 'cancelled', cancelledAt: new Date().toISOString() })
  log('  timelock.cancel ✓ — nothing in that batch will ever execute')
  return { cancelled: true }
}

/* ---------------------------------- actors ---------------------------------- */

/** The address behind contracts/.env.owner, derived from its key. The key
 * itself never leaves this function's caller. */
function readOwnerKey() {
  const file = path.join(__dirname, '..', '.env.owner')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error('contracts/.env.owner not found — the OWNER key that proposes and executes on the timelocks')
  }
  const m = text.match(/^OWNER_PK=(0x[0-9a-fA-F]{64})/m)
  if (!m) throw new Error('contracts/.env.owner has no OWNER_PK line')
  return m[1]
}

/**
 * Who signs what in the CLIs: the deployer (hardhat's signer — the
 * operator) and OWNER (the key in contracts/.env.owner).
 * On a DEVELOPMENT node (an anvil fork) the real OWNER key is never used —
 * a transaction it signs for a fork is valid on the real chain — the
 * recorded owner is impersonated instead; SPAWN_FORK_AS=0x… impersonates the
 * operator too (a rehearsal against forked live state — lib-net cliSigner).
 */
async function actors(profile, netKey, stateFile) {
  const provider = ethers.provider
  const [first] = await ethers.getSigners()
  const state = loadState(stateFile ?? profile.stateFile)[netKey] ?? {}
  if (await isDevNode(provider)) {
    const fund = async (addr) => {
      await provider.send('hardhat_setBalance', [addr, '0x8AC7230489E80000']) // 10 ETH, fork only
      return ethers.getImpersonatedSigner(addr)
    }
    const owner = state.handover?.owner ? await fund(state.handover.owner) : null
    const deployer = process.env.SPAWN_FORK_AS ? await fund(ethers.getAddress(process.env.SPAWN_FORK_AS)) : first
    return { deployer, owner, impersonated: true }
  }
  if (!first) throw new Error('no deployer key: DEPLOYER_PK (or MAINNET_DEPLOYER_PK) missing in contracts/.env')
  const owner = new ethers.Wallet(readOwnerKey(), provider)
  if (state.handover?.owner && !same(owner.address, state.handover.owner)) {
    throw new Error(`contracts/.env.owner is ${owner.address}; this network was handed over to ${state.handover.owner}`)
  }
  return { deployer: first, owner, impersonated: false }
}

module.exports = { collectAdminSteps, scheduleOps, executeOps, listOps, cancelOp, actors, saltOf, batchOf, recordOp, ensureGas, executeGas, feePerGas }
