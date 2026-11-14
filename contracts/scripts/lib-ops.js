/**
 * Day-2 operations — the logic behind tune-fees.js, keeper-pull.js and
 * status.js, as functions so the test suite can drive them.
 *
 * Cross-chain reads go over each network's RPC (config/profiles.js);
 * `providers` ({ net: provider }) overrides them — the tests put every
 * "network" of a simulated deployment on one in-process chain.
 */
const { ethers } = require('hardhat')
const { activeNets, hubGasFor, dollarUnits, dollarScale, dollarOfNet, vaultKind } = require('../config/profiles')
const {
  loadState, b32, same, hasRole, vaultOf, vaultName, nativeOf, dollarOf, distOf, roleKeys, USDC_ABI, ENDPOINT_ABI, writeManifest,
} = require('./lib-net')
const { verifyDvn } = require('./lib-dvn')
const { readLegs, requestSolvency, WORST_SYNC, SAMPLE_PAYOUT } = require('./lib-prices')

const coder = ethers.AbiCoder.defaultAbiCoder()
const fmt = (wei) => ethers.formatEther(wei)

function providerOf(profile, net, providers) {
  if (providers?.[net]) return providers[net]
  const c = profile.nets[net]
  return new ethers.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true })
}

// the replies a hub sends, at the size that matters for their fee
const SAMPLE_DELIVER = coder.encode(
  ['uint8', 'bytes'],
  [11, coder.encode(['bytes32', 'bytes32', 'uint256', 'uint256'], [ethers.ZeroHash, ethers.ZeroHash, 0n, 0n])],
)
const SAMPLE_SYNC = WORST_SYNC

/* -------------------------------- tune-fees -------------------------------- */

const ceilDiv = (a, b) => (a === 0n ? 0n : (a - 1n) / b + 1n)
const maxB = (...xs) => xs.reduce((a, b) => (b > a ? b : a))

/* ───────────── SEAM: per-op executor gas (contract round 2) ─────────────
 * ASSUMED, not in the contracts of this branch: the LayerZero adapter gains
 *   function setGasForOp(uint32 chainLabel, uint8 op, uint128 gas) external onlyOperator
 *   function gasForOp(uint32 chainLabel, uint8 op) external view returns (uint128)
 * where 0 falls back to gasLimit[chainLabel]. Everything that touches it is
 * here: if the adapter's ABI has no `setGasForOp`, tune-fees says so and
 * leaves the one gas limit per destination alone. If round 2 names it
 * differently, change these two constants (and nothing else). */
const OP_GAS_SETTER = 'setGasForOp'
const OP_GAS_GETTER = 'gasForOp'
const opGasSupported = (adapter) => {
  try {
    return !!adapter.interface.getFunction(OP_GAS_SETTER) && !!adapter.interface.getFunction(OP_GAS_GETTER)
  } catch {
    return false
  }
}
/** The per-op gas this adapter should buy: on a spoke, for each hub-bound op
 * (the SPAWN gets the hub-bound limit itself); on the hub, for each op toward
 * `dstNet` — the fork measurements in the profile (`opGas`) with their margin. */
function opGasPlan(profile, netKey, dstNet, spawnGas) {
  const table = profile.opGas
  if (!table) return []
  if (netKey !== profile.hub) {
    return Object.entries(table.toHub).map(([op, g]) => ({ label: 0, op: Number(op), gas: Number(op) === 1 ? spawnGas : BigInt(g) }))
  }
  const own = profile.nets[dstNet]?.opGasToSpoke ?? {}
  return Object.entries({ ...table.toSpoke, ...own }).map(([op, g]) => ({
    label: profile.nets[dstNet].label, op: Number(op), gas: BigInt(g),
  }))
}

/**
 * Re-prices one network from LIVE quotes. Operator-only; without the role
 * (or without `apply`) every change is printed as calldata.
 *
 * On a SPOKE X (every figure is hub-native wei: what X's users prepay into
 * the hub tank per leg):
 *  - `returnUnit(hub)` = the hub's DELIVER quote toward X + margin;
 *  - `spawnLegs` so that legs × unit covers one SYNC to every chain a spawn
 *    from X reaches RIGHT NOW: a chain with a launch ceiling (`syncCap`,
 *    Ethereum) counts only while its SYNC is under it (for X itself, under
 *    the larger of its two ceilings — the pad's own rule);
 *  - `openLegs` so that an open from X prepays the worst SYNC toward X +
 *    margin (never 0 — that is a hard failure);
 *  - `moveLegs[D]` for every other chain D so that a move toward D prepays
 *    the dearer of D's worst SYNC and its PAYOUT + margin (both answer to
 *    the same `requestCap[D]` on the pad) — never under `tradeLegs`, which
 *    pays the way home; a destination that cannot be covered within the
 *    contract's cap is closed (0);
 *  - the hub-bound executor gas (`hubGasFor`: remote chains + ceiling quotes).
 * Nothing here lowers a prepay below the hub's CURRENT `requestCap` toward
 * that chain: the ceiling comes down first, on the hub's run.
 *
 * On the HUB: `returnUnit(0)` = Σ of the SYNC quotes a local spawn sends +
 * margin ÷ its spawnLegs; the hub gateway's `moveLegs` (its openLegs stays
 * 0); the profile's launch ceilings (`syncCap`); and LAST, for every remote
 * chain D, `requestCap[D]` = the smallest prepay of any open from D or move
 * toward D, read from every chain — the rule status.js verifies.
 *
 * opts: { profile, netKey, signer, apply?, marginPct?, tolerancePct?, providers?, stateFile?, log? }
 */
async function tuneFees(opts) {
  const { profile, netKey, signer, log = console.log } = opts
  const marginPct = BigInt(opts.marginPct ?? 25)
  const tolerancePct = BigInt(opts.tolerancePct ?? 5)
  const withMargin = (x) => (x * (100n + marginPct)) / 100n
  const all = loadState(opts.stateFile ?? profile.stateFile)
  const s = all[netKey]
  const hub = all[profile.hub]
  if (!s?.adapter || !hub?.adapter) throw new Error(`${netKey}: not deployed`)
  const nets = activeNets(profile)
  const cfg = profile.nets[netKey]
  const isHub = cfg.role === 'hub'
  const HP = isHub ? signer.provider : providerOf(profile, profile.hub, opts.providers)
  const adapter = await ethers.getContractAt('LayerZeroOmniMessenger', s.adapter, signer)
  const gateway = await ethers.getContractAt('SpawnGateway', s.gateway, signer)
  const hubAdapter = isHub ? adapter : await ethers.getContractAt('LayerZeroOmniMessenger', hub.adapter, HP)
  const pad = await ethers.getContractAt('SpawnPad', hub.pad, isHub ? signer : HP)
  const COIN = nativeOf(profile) // every figure here is hub-native

  // ── live quotes from the hub, for every remote chain it routes to ──
  const remote = []
  for (const [net, c] of Object.entries(nets)) {
    if (c.role !== 'spoke' || !all[net]?.ready) continue
    if ((await hubAdapter.eidOf(c.label)) === 0n) continue
    const gw = b32(all[net].gateway)
    const r = {
      net,
      label: c.label,
      sync: await hubAdapter.quote(c.label, gw, SAMPLE_SYNC, 0),
      payout: await hubAdapter.quote(c.label, gw, SAMPLE_PAYOUT, 0),
      deliver: await hubAdapter.quote(c.label, gw, SAMPLE_DELIVER, 0),
      syncCap: await pad.syncCap(c.label),
      requestCap: await pad.requestCap(c.label),
    }
    // what a request toward this chain must prepay (its SYNC and its PAYOUT
    // answer to one ceiling on the pad)
    r.request = withMargin(maxB(r.sync, r.payout))
    remote.push(r)
  }
  if (!remote.length) {
    log(`tune-fees — ${profile.name}/${netKey}: no wired spoke yet, nothing to price`)
    return { changed: false, quotes: [] }
  }
  const self = remote.find((r) => r.net === netKey)
  if (!isHub && !self) throw new Error(`the hub has no route to ${netKey} yet — re-run the deploy on ${profile.hub} first`)

  /** does a spawn from `from` reach `r` right now? (SpawnPad._spawn's rule) */
  const reaches = (r, from) => {
    if (r.syncCap === 0n) return true
    let ceiling = r.syncCap
    if (r.net === from && r.requestCap > ceiling) ceiling = r.requestCap
    return r.sync <= ceiling
  }
  const reached = remote.filter((r) => reaches(r, netKey))
  const skipped = remote.filter((r) => !reaches(r, netKey))
  const syncSum = reached.reduce((a, r) => a + r.sync, 0n)

  const maxUnit = await adapter.MAX_RETURN_UNIT()
  const curUnit = await adapter.returnUnit(0)
  const tradeLegs = Number(await gateway.tradeLegs())
  const curSpawn = Number(await gateway.spawnLegs())
  const curOpen = Number(await gateway.openLegs())
  const maxSpawn = Number(await gateway.MAX_SPAWN_LEGS())
  const maxOpen = Number(await gateway.MAX_OPEN_LEGS())
  const maxMove = Number(await gateway.MAX_MOVE_LEGS())

  // ── the reply unit and the spawn legs ──
  let target
  let basis
  let spawnTarget = curSpawn
  if (isHub) {
    spawnTarget = Math.max(1, reached.length)
    target = ceilDiv(syncSum * (100n + marginPct), 100n * BigInt(spawnTarget))
    basis = `Σ of ${reached.length} SYNC quote(s) + ${marginPct}% ÷ ${spawnTarget} leg(s)`
  } else {
    target = withMargin(self.deliver)
    basis = `the DELIVER quote + ${marginPct}%`
    // an open prepays at most MAX_OPEN_LEGS units: the unit never falls so
    // low that an open stops covering the CURRENT ceiling toward here
    const floorUnit = ceilDiv(self.requestCap, BigInt(maxOpen))
    if (target < floorUnit) {
      basis += ` — held at the hub's current requestCap ÷ ${maxOpen} until the hub's run lowers it`
      target = floorUnit
    }
  }
  if (target > maxUnit) {
    log(`  ⚠ ${fmt(target)} ${COIN} exceeds the contract cap ${fmt(maxUnit)} — clamped; replies will be under-funded`)
    target = maxUnit
  }
  const diff = curUnit > target ? curUnit - target : target - curUnit
  const unitChanged = curUnit === 0n || diff * 100n > curUnit * tolerancePct
  const unit = unitChanged ? target : curUnit
  if (!isHub && unit > 0n) {
    const need = Number(ceilDiv(syncSum * (100n + marginPct), 100n * unit))
    spawnTarget = Math.max(reached.length, need)
    if (spawnTarget > maxSpawn) {
      log(`  ⚠ a spawn from ${netKey} would need ${spawnTarget} legs, the contract allows ${maxSpawn} — clamped; the hub tank pays the rest`)
      spawnTarget = maxSpawn
    }
    if (spawnTarget < curSpawn && (curSpawn - spawnTarget) * 100 <= curSpawn * Number(tolerancePct)) spawnTarget = curSpawn
  }

  // ── what an open from here prepays: the SYNC toward here ──
  let openTarget = curOpen
  if (isHub) openTarget = 0
  else if (unit > 0n) {
    openTarget = Math.max(Number(ceilDiv(self.request, unit)), Number(ceilDiv(self.requestCap, unit)), 1)
    if (openTarget > maxOpen) {
      log(`  ⚠ an open from ${netKey} would need ${openTarget} legs, the contract allows ${maxOpen} — clamped; the hub refuses an open above what it prepaid`)
      openTarget = maxOpen
    }
  }
  if (!isHub && openTarget < 1) throw new Error(`${netKey}: openLegs would be 0 on a remote gateway — the hub tank would pay every open`)

  // ── what a move from here toward each other chain prepays ──
  const moves = []
  for (const [net, c] of Object.entries(nets)) {
    if (net === netKey || !all[net]?.gateway) continue
    const current = Number(await gateway.moveLegs(c.label))
    const r = remote.find((x) => x.net === net)
    let legs
    if (!r) {
      // the hub chain's own gateway (a local call forwards it), or a chain the
      // hub does not route to yet: a move prepays the way home
      legs = Math.max(1, tradeLegs)
    } else if (unit === 0n) {
      legs = current
    } else {
      legs = Math.max(tradeLegs, 1, Number(ceilDiv(r.request, unit)), Number(ceilDiv(r.requestCap, unit)))
      if (legs > maxMove) {
        log(`  ⚠ a move ${netKey} → ${net} would need ${legs} legs (> ${maxMove}): that route is CLOSED until prices allow it`)
        legs = 0
      }
    }
    moves.push({ net, label: c.label, current, target: legs })
  }

  // ── the hub-bound executor gas (never lowered here) ──
  const gas = await adapter.gasLimit(0)
  let gasTarget = gas
  const ceilings = remote.filter((r) => r.syncCap > 0n).length
  if (!isHub) {
    gasTarget = hubGasFor(profile, remote.length, ceilings)
    if (gasTarget < gas) gasTarget = gas
  }

  log(`tune-fees — ${profile.name}/${netKey} — every figure in hub-chain ${COIN}`)
  for (const r of remote) {
    log(
      `  live quotes hub -> ${r.net}: SYNC ${fmt(r.sync)}, PAYOUT ${fmt(r.payout)}, DELIVER ${fmt(r.deliver)}` +
        (r.syncCap > 0n
          ? ` — launch ceiling ${fmt(r.syncCap)}: ${reaches(r, netKey) ? 'launches from here reach it' : 'SKIPPED by launches from here (opened per token)'}`
          : ''),
    )
  }
  log(`  reply unit ${fmt(curUnit)}  →  ${fmt(target)} (${basis})`)
  log(
    `  spawnLegs ${curSpawn}  →  ${spawnTarget} (Σ SYNC to ${reached.map((r) => r.net).join(', ') || 'nobody'} ${fmt(syncSum)} + ${marginPct}%` +
      `${skipped.length ? `; skipped while over their ceiling: ${skipped.map((r) => r.net).join(', ')}` : ''})`,
  )
  log(`  openLegs ${curOpen}  →  ${openTarget}${isHub ? ' (a local call)' : ` (the worst SYNC toward ${netKey} + ${marginPct}%)`}`)
  for (const m of moves) log(`  moveLegs → ${m.net}: ${m.current}  →  ${m.target}`)
  if (!isHub) log(`  hub-bound executor gas ${gas}  →  ${gasTarget} (${remote.length} remote chain(s), ${ceilings} ceiling quote(s) in a spawn)`)

  // ── the calls, ordered so that no prepay ever dips under a ceiling ──
  const calls = []
  const unitUp = unitChanged && target > curUnit
  const unitCall =
    unitChanged || gasTarget !== gas
      ? { what: `adapter.setDestination(0, ${gasTarget}, ${fmt(unit)})`, on: adapter, fn: 'setDestination', args: [0, gasTarget, unit] }
      : null
  const legsSide = [
    spawnTarget !== curSpawn ? { what: `gateway.setLegs(${tradeLegs}, ${spawnTarget})`, on: gateway, fn: 'setLegs', args: [tradeLegs, spawnTarget] } : null,
    openTarget !== curOpen ? { what: `gateway.setOpenLegs(${openTarget})`, on: gateway, fn: 'setOpenLegs', args: [openTarget] } : null,
    ...moves
      .filter((m) => m.target !== m.current)
      .map((m) => ({ what: `gateway.setMoveLegs(${m.label} = ${m.net}, ${m.target})`, on: gateway, fn: 'setMoveLegs', args: [m.label, m.target] })),
  ].filter(Boolean)
  // unit up: the unit first (every prepay rises), then the legs that shrink
  // with it; unit down: the legs first (they grow), then the unit
  calls.push(...(unitUp ? [unitCall, ...legsSide] : [...legsSide, unitCall]).filter(Boolean))

  // ── the seam: per-op executor gas ──
  if (opGasSupported(adapter)) {
    const plans = isHub ? remote.flatMap((r) => opGasPlan(profile, netKey, r.net)) : opGasPlan(profile, netKey, profile.hub, gasTarget)
    for (const p of plans) {
      if (BigInt(await adapter[OP_GAS_GETTER](p.label, p.op)) !== p.gas) {
        calls.push({ what: `adapter.${OP_GAS_SETTER}(${p.label}, op ${p.op}, ${p.gas})`, on: adapter, fn: OP_GAS_SETTER, args: [p.label, p.op, p.gas] })
      }
    }
  } else {
    log(`  (per-op executor gas: this adapter has no ${OP_GAS_SETTER}() — one gas limit per destination, as before)`)
  }

  // ── the hub: the profile's launch ceilings ──
  if (isHub) {
    for (const r of remote) {
      const want = BigInt(nets[r.net].syncCap ?? 0n)
      if (want !== r.syncCap) calls.push({ what: `pad.setSyncCap(${r.label} = ${r.net}, ${fmt(want)})`, on: pad, fn: 'setSyncCap', args: [r.label, want] })
    }
  }

  const caps = []
  const out = {
    changed: calls.length > 0,
    applied: false,
    current: curUnit,
    target,
    quotes: isHub ? reached.map((r) => ({ net: r.net, what: 'SYNC', fee: r.sync })) : [{ net: netKey, what: 'DELIVER', fee: self.deliver }],
    syncs: reached.map((r) => ({ net: r.net, fee: r.sync })),
    skipped: skipped.map((r) => r.net),
    legs: { current: curSpawn, target: spawnTarget },
    gas: { current: gas, target: gasTarget },
    open: { current: curOpen, target: openTarget },
    moves,
    remote,
    caps,
    blockedAll: [],
  }
  const isOperator = await hasRole(adapter, 'operator', signer.address)
  const run = async (c) => {
    if (opts.apply && isOperator) {
      await (await c.on[c.fn](...c.args)).wait()
      log(`  ${c.what} ✓`)
      out.applied = true
      return
    }
    const b = { what: c.what, target: c.on.target, data: c.on.interface.encodeFunctionData(c.fn, c.args) }
    out.blockedAll.push(b)
    log(opts.apply ? `  ⏳ needs the operator — ${b.what}: target ${b.target} data ${b.data}` : `  would: ${c.what}`)
  }
  for (const c of calls) await run(c)

  // ── the hub, LAST: requestCap[D] = the smallest prepay toward D, read from
  // every chain after this run's own changes ──
  if (isHub) {
    const P = { ...opts.providers, [netKey]: signer.provider }
    const legs = await readLegs({ profile, all, providers: P })
    if (!out.applied && legs[netKey]) {
      // a run that only shows: price the hub gateway as it WOULD be
      legs[netKey] = { ...legs[netKey], unit, openLegs: openTarget, moveLegs: { ...legs[netKey].moveLegs, ...Object.fromEntries(moves.map((m) => [m.label, m.target])) } }
    }
    const solv = await requestSolvency({ profile, all, legs, providers: P, quotes: false })
    const bad = solv.rows.filter((r) => !r.openOk)
    if (bad.length) {
      throw new Error(
        `✗ openLegs = 0 on the REMOTE gateway of ${bad.map((r) => r.net).join(', ')} — the hub tank would pay every open there. ` +
          'Run the deploy / tune-fees on that chain first.',
      )
    }
    for (const r of solv.rows) {
      const q = remote.find((x) => x.net === r.net)
      if (!q) continue // not routed yet: nothing can reach it
      const current = q.requestCap
      const want = r.min
      const lower = want < current
      const raise = want > current && (current === 0n || (want - current) * 100n > current * tolerancePct)
      caps.push({ net: r.net, label: r.label, current, target: lower || raise ? want : current, live: maxB(q.sync, q.payout) })
      log(
        `  requestCap → ${r.net}: ${fmt(current)}  →  ${fmt(lower || raise ? want : current)} (smallest prepay — open ${fmt(r.open)}` +
          (r.moves.length ? `, moves ${r.moves.map((m) => `${m.src} ${fmt(m.prepay)}`).join(', ')}` : '') +
          `; the live price ${fmt(maxB(q.sync, q.payout))})`,
      )
      if (want < maxB(q.sync, q.payout)) {
        log(`  ⚠ ${r.net}: what requests prepay is under the live price — opens and moves toward it are REFUSED until the spokes are re-priced`)
      }
      if (!(lower || raise)) continue
      out.changed = true
      await run({ what: `pad.setRequestCap(${r.label} = ${r.net}, ${fmt(want)})`, on: pad, fn: 'setRequestCap', args: [r.label, want] })
    }
  }
  if (opts.apply && !isOperator && out.blockedAll.length) {
    out.blocked = out.blockedAll.find((b) => same(b.target, adapter.target))
    out.blockedLegs = out.blockedAll.find((b) => same(b.target, gateway.target))
  }
  if (!out.changed) log(`  ✓ within ${tolerancePct}% — left as is`)
  else if (!opts.apply) log('  (not applied — SPAWN_APPLY=1 sends it)')
  return out
}

/* ------------------------------- keeper-pull ------------------------------- */

/**
 * Pulls this chain's holder fees home when what is waiting on the hub
 * reaches `thresholdUsd`. Holder fees are accrue-then-pull: left alone, a
 * chain's slice only grows, and a large un-pulled slice is an invitation to
 * buy just before a pull lands and sell just after. A keeper that pulls at a
 * modest threshold keeps every drop small. The caller pays each round trip.
 * opts: { profile, netKey, signer, apply?, thresholdUsd?, maxTokens?, providers?, stateFile?, log? }
 */
async function keeperPull(opts) {
  const { profile, netKey, signer, log = console.log } = opts
  const threshold = ethers.parseEther(String(opts.thresholdUsd ?? 25))
  const all = loadState(opts.stateFile ?? profile.stateFile)
  const s = all[netKey]
  const hub = all[profile.hub]
  if (!s?.gateway || !hub?.pad) throw new Error(`${netKey}: not deployed`)
  const cfg = profile.nets[netKey]
  const pad = await ethers.getContractAt('SpawnPad', hub.pad, providerOf(profile, profile.hub, opts.providers))
  const gateway = await ethers.getContractAt('SpawnGateway', s.gateway, signer)
  const out = []
  log(`keeper-pull — ${profile.name}/${netKey} — threshold $${ethers.formatEther(threshold)}`)
  if (await pad.autoDrop(cfg.label)) {
    log('  this chain is served inline by the hub (autoDrop) — nothing to pull')
    return out
  }
  const labels = []
  for (let i = 0n, n = await pad.chainsLength(); i < n; i++) labels.push(await pad.chainLabels(i))
  const total = Number(await pad.tokensLength())
  const from = Math.max(0, total - (opts.maxTokens ?? 500))
  for (let i = total - 1; i >= from; i--) {
    const token = await pad.allTokens(i)
    const f = await pad.feesOf(token)
    if (Number(f.mode) > 1) continue // dev / burn modes have no holder pot
    let due = await pad.pendingDrop(token, cfg.label)
    const pot = f.holders - f.holdersPaid
    const mine = await pad.supplyByChain(token, cfg.label)
    if (pot > 0n && mine > 0n) {
      // a pull also splits whatever was not split yet: estimate this chain's share
      let circ = 0n
      for (const l of labels) circ += await pad.supplyByChain(token, l)
      if (circ > 0n) due += (pot * mine) / circ
    }
    if (due < threshold) continue
    if ((await gateway.replicaOf(token)) === ethers.ZeroAddress) continue
    const fee = await gateway.quotePull()
    const item = { token, due, fee, pulled: false }
    out.push(item)
    if (!opts.apply) {
      log(`  ${token}: $${ethers.formatEther(due)} waiting — would pull (fee ${fmt(fee)} ${nativeOf(profile, netKey)})`)
      continue
    }
    await (await gateway.pullFees(token, { value: fee })).wait()
    item.pulled = true
    log(`  ${token}: $${ethers.formatEther(due)} pulled (fee ${fmt(fee)} ${nativeOf(profile, netKey)}) ✓`)
  }
  if (!out.length) log('  nothing at or above the threshold')
  return out
}

/* ---------------------------------- status ---------------------------------- */

/**
 * One screen: vaults per dollar and the GLOBAL backing check, the BNB (USDT)
 * exposure, request ceilings against what requests prepay, tanks, pending
 * holder fees, pauses, roles, verifier sets. Read-only.
 *
 * THE BACKING CHECK (two dollars, one set of books — SPEC §7 V0):
 *   Σ over every vault of (dollar tokens held × that vault's SCALE)
 *     = Σ over every instance of oUSD.totalSupply(), the hub ledger included
 * modulo value in flight. USDC counts ×1e12, USDT (18 decimals) ×1. Value
 * in flight between chains shows as a SURPLUS (dollars already in a vault,
 * not yet in the books) — except a CCTP rebalance, a temporary DEFICIT of
 * exactly the amount in flight (`inflightUsdc`, whole USDC).
 *
 * `ok` is false when the backing check fails, when a request ceiling exceeds
 * what a request toward that chain prepays, when a remote gateway's
 * openLegs is 0, or when the USDT vault is somebody's CCTP peer.
 * opts: { profile, providers?, stateFile?, inflightUsdc?, maxTokens?, log? }
 */
async function status(opts) {
  const { profile, log = console.log } = opts
  const all = loadState(opts.stateFile ?? profile.stateFile)
  const nets = activeNets(profile)
  const hub = all[profile.hub]
  const warnings = []
  const warn = (w) => {
    warnings.push(w)
    log(`  ⚠ ${w}`)
  }
  log(`SPAWN! status — ${profile.name} — ${new Date().toISOString()}`)
  if (!hub?.pad) {
    log('  nothing deployed')
    return { ok: false, deployed: false, warnings }
  }
  const P = (net) => providerOf(profile, net, opts.providers)
  const at = (name, addr, net) => ethers.getContractAt(name, addr, P(net))
  const pad = await at('SpawnPad', hub.pad, profile.hub)
  const hubUsd = await at('OmniUSD', hub.usd, profile.hub)
  const deployed = Object.keys(nets).filter((n) => all[n]?.gateway)

  // ── vaults, per dollar, and the global backing check ──
  log('\nVAULTS (dollars held ↔ oUSD claims on this chain)')
  let held = 0n // Σ dollars × SCALE, 18 decimals
  const ledger = await hubUsd.totalSupply()
  let supply = ledger
  const byDollar = {} // symbol → { held18, claims, chains }
  const vaults = {}
  for (const net of deployed) {
    const vaultAddr = vaultOf(profile, net, all[net])
    const vault = await at(vaultName(profile, net), vaultAddr, net)
    const d = dollarOfNet(profile, net)
    const SCALE = dollarScale(profile, net)
    const token = new ethers.Contract(await vault.usdc(), USDC_ABI, P(net))
    const bal = await token.balanceOf(vaultAddr)
    const claims = await vault.totalSupply()
    const cap = await vault.depositCap()
    const closed = await vault.depositsPaused()
    const onChainScale = await vault.SCALE()
    if (onChainScale !== SCALE) warn(`${net}: the vault's SCALE (${onChainScale}) is not 10^(18 − ${d.decimals}) — the profile and the chain disagree`)
    held += bal * SCALE
    supply += claims
    const b = (byDollar[d.symbol] ??= { held18: 0n, claims: 0n, chains: [] })
    b.held18 += bal * SCALE
    b.claims += claims
    b.chains.push(net)
    vaults[net] = { dollar: d.symbol, decimals: d.decimals, kind: vaultKind(profile, net), held: bal, held18: bal * SCALE, claims, cap }
    log(
      `  ${net.padEnd(16)} ${ethers.formatUnits(bal, d.decimals).padStart(14)} ${d.symbol.padEnd(4)} | oUSD here ${ethers.formatEther(claims).padStart(12)} | ` +
        `cap ${ethers.formatUnits(cap, d.decimals)} ${d.symbol}${closed ? ' | DEPOSITS PAUSED' : cap === 0n ? ' | deposits closed' : ''}` +
        `${vaultKind(profile, net) === 'local' ? ' | no CCTP: never levelled' : ''}`,
    )
    if (claims > bal * SCALE) {
      warn(
        `${net}: vault is locally short — some oUSD here cannot be unwrapped until ` +
          (vaultKind(profile, net) === 'local' ? 'dollars come back in, or the holder moves the claim (moveClaim)' : 'a rebalance, or a moveClaim'),
      )
    }
  }
  log(`  hub ledger (books of the curve and fee pots): ${ethers.formatEther(ledger)} oUSD`)
  log('\nBY DOLLAR (18-decimal dollars: USDC × 1e12, USDT × 1)')
  for (const [sym, b] of Object.entries(byDollar)) {
    log(`  ${sym.padEnd(5)} held ${ethers.formatEther(b.held18).padStart(14)} on ${b.chains.join(', ')} | claims there ${ethers.formatEther(b.claims)}`)
  }
  const inflight = BigInt(opts.inflightUsdc ?? 0) * 10n ** 18n
  const backed = held + inflight >= supply
  log(
    `\nBACKING  Σ vault dollars ${ethers.formatEther(held)}  vs  Σ oUSD supply ${ethers.formatEther(supply)} (hub ledger included)  →  ` +
      (backed
        ? `✓ covered (surplus ${ethers.formatEther(held + inflight - supply)} — value in flight, parked or dust)`
        : `✗ DEFICIT ${ethers.formatEther(supply - held - inflight)} — PAUSE AND INVESTIGATE`),
  )

  // ── the USDT exposure, in plain figures ──
  let bnb
  const local = deployed.filter((n) => vaultKind(profile, n) === 'local')
  if (local.length) {
    log('\nUSDT EXPOSURE (what a USDT de-peg can cost every holder — bounded by the BNB vault cap)')
    for (const net of local) {
      const v = vaults[net]
      const share = held > 0n ? Number((v.held18 * 10_000n) / held) / 100 : 0
      bnb = { net, held: v.held, held18: v.held18, cap: v.cap, claims: v.claims, sharePct: share }
      log(
        `  ${net}: ${ethers.formatUnits(v.held, v.decimals)} ${v.dollar} held = ${share}% of all the dollars backing oUSD; ` +
          `cap ${ethers.formatUnits(v.cap, v.decimals)} ${v.dollar}; claims minted there ${ethers.formatEther(v.claims)} oUSD`,
      )
      log(`  a 10% USDT de-peg would cost the universe ≈ $${Number(ethers.formatEther(v.held18 / 10n)).toFixed(2)} today, at most ≈ $${Number(ethers.formatUnits(v.cap / 10n, v.decimals)).toFixed(2)} at the cap`)
    }
  }

  // ── the USDT vault is never anybody's CCTP peer ──
  let peersOk = true
  for (const net of deployed) {
    if (vaultKind(profile, net) !== 'cctp') continue
    const vault = await at('OmniUSD', vaultOf(profile, net, all[net]), net)
    for (const n of local) {
      const p = await vault.peers(nets[n].label)
      if (p.vault !== ethers.ZeroHash) {
        peersOk = false
        warn(`✗✗ ${net}'s vault names ${n} (the USDT vault, no CCTP) as a CCTP PEER (${p.vault}) — a rebalance there burns USDC for good. Tell the owner.`)
      }
    }
  }

  // ── request ceilings vs what requests prepay (v7.2) ──
  log('\nREQUESTS (opens from / moves toward each chain): the hub tank never fronts more than a request prepaid')
  let requests
  try {
    requests = await requestSolvency({ profile, all, providers: opts.providers })
    for (const r of requests.rows) {
      const live = r.need === undefined ? 'unpriced' : fmt(r.need)
      log(
        `  ${r.net.padEnd(16)} requestCap ${fmt(r.cap)} ≤ smallest prepay ${fmt(r.min)} ${r.capOk ? '✓' : '✗'}` +
          ` | live price ${live}${r.covered === false ? ' (a prepay is UNDER it: some requests are refused)' : ''}` +
          `${r.syncCap > 0n ? ` | launch ceiling ${fmt(r.syncCap)}${r.qSync !== undefined ? (r.qSync > r.syncCap ? ' — launches SKIP it now' : ' — launches reach it now') : ''}` : ''}`,
      )
      if (!r.capOk) warn(`✗ ${r.net}: requestCap ${fmt(r.cap)} exceeds what a request toward it prepays (${fmt(r.min)}) — the tank pays the difference. Run tune-fees on ${profile.hub}.`)
      if (!r.openOk) warn(`✗ ${r.net}: openLegs = 0 on a REMOTE gateway — the hub tank pays every open there. Run tune-fees on ${r.net}.`)
      if (r.cap === 0n) warn(`${r.net}: requestCap is 0 — closed to opens and incoming moves until tune-fees prices it`)
      else if (r.open_for_requests === false) warn(`${r.net}: requestCap is under the live price — opens and moves toward it are refused right now`)
    }
    if (!requests.rows.length) log('  (no remote chain yet)')
  } catch (e) {
    warn(`request ceilings could not be read (${e.shortMessage ?? e.message})`)
  }
  const requestsOk = !requests || requests.ok

  // ── tanks ──
  log('\nGAS TANKS (adapters)')
  for (const net of deployed) {
    const bal = await P(net).getBalance(all[net].adapter)
    const isHub = net === profile.hub
    log(`  ${net.padEnd(16)} ${fmt(bal)} ${nativeOf(profile, net)} ${isHub ? '(pays every reply — refilled by prepaid budgets)' : ''}`)
    const floor = isHub && profile.tank.mode === 'fixed' ? profile.tank.hub / 3n : 0n
    if (isHub && bal < floor) warn(`hub tank is low (${fmt(bal)}): replies will stall when it empties — top it up and run tune-fees`)
  }

  // ── pauses ──
  log('\nPAUSES')
  const padPaused = await pad.paused()
  log(`  pad: ${padPaused ? 'PAUSED (buys bounce, spawns refused; sells and claims run)' : 'running'}`)
  if (padPaused) warn('the pad is paused')
  for (const net of deployed) {
    const gw = await at('SpawnGateway', all[net].gateway, net)
    const p = await gw.paused()
    log(`  ${net} gateway: ${p ? 'PAUSED (no new buys or spawns; exits open)' : 'running'}`)
    if (p) warn(`${net} gateway is paused`)
  }

  // ── pending holder fees ──
  log('\nHOLDER FEES WAITING ON THE HUB (pulled by keeper-pull.js or any holder)')
  const total = Number(await pad.tokensLength())
  const from = Math.max(0, total - (opts.maxTokens ?? 200))
  const waiting = {}
  for (let i = total - 1; i >= from; i--) {
    const token = await pad.allTokens(i)
    for (const net of deployed) {
      const d = await pad.pendingDrop(token, nets[net].label)
      if (d > 0n) waiting[net] = (waiting[net] ?? 0n) + d
    }
  }
  for (const net of deployed) log(`  ${net.padEnd(16)} $${ethers.formatEther(waiting[net] ?? 0n)}`)
  log(`  (${total} token(s)${from > 0 ? `, last ${total - from} scanned` : ''})`)

  // ── tokens without a replica (a SYNC that failed, was skipped by a launch
  // ceiling, or is still in flight) ──
  log('\nTOKENS WITHOUT A REPLICA (skipped by a launch ceiling, failed, or in flight — openToken there, or scripts/resync.js)')
  const missing = await missingReplicas({ ...opts, all, nets, deployed })
  if (!missing.length) log('  none')
  for (const m of missing) {
    log(`  ${m.token} ${m.symbol.padEnd(8)} no replica on ${m.net}${m.fresh ? ' (spawned < 10 min ago: may still be in flight)' : ''}`)
  }
  // a chain with a launch ceiling is EXPECTED to miss tokens: opened per token
  const stale = missing.filter((m) => !m.fresh && nets[m.net].syncCap === undefined)
  if (stale.length) warn(`${stale.length} token/chain pair(s) have no replica — run scripts/resync.js on ${profile.hub}`)

  // ── roles ──
  log('\nROLES')
  for (const net of deployed) {
    const seen = new Map()
    for (const [key, name] of roleKeys(profile, net)) {
      const c = await at(name, all[net][key], net)
      const sig = `${await c.admin()}|${await c.operator()}|${await c.guardian()}`
      seen.set(sig, [...(seen.get(sig) ?? []), key])
    }
    for (const [sig, keys] of seen) {
      const [admin, operator, guardian] = sig.split('|')
      // only the timelock this deployment recorded counts: "has code" proves
      // nothing (any contract, or a key with a delegation, has code)
      const isTimelock = !!all[net].timelock && same(admin, all[net].timelock)
      log(`  ${net} [${keys.join(', ')}]`)
      log(`     admin ${admin}${isTimelock ? ' (the timelock)' : ' (NOT the recorded timelock — no enforced delay)'}`)
      log(`     operator ${operator} · guardian ${guardian}`)
      if (profile.mainnet && !isTimelock) warn(`${net}: admin of ${keys.join(', ')} is not the timelock — run handover.js`)
    }
    if (seen.size > 1) warn(`${net}: contracts do not all answer to the same roles`)
    const endpoint = new ethers.Contract(profile.endpoint, ENDPOINT_ABI, P(net))
    try {
      const delegate = await endpoint.delegates(all[net].adapter)
      const admin = await (await at('LayerZeroOmniMessenger', all[net].adapter, net)).admin()
      if (!same(delegate, admin)) warn(`${net}: the LayerZero delegate (${delegate}) is not the adapter's admin`)
    } catch {
      /* a mock endpoint without delegates() */
    }
  }

  // ── verifier sets ──
  let dvn
  if (profile.dvn) {
    log('\nLAYERZERO VERIFIER SETS (both ends of every pathway)')
    dvn = await verifyDvn({ profile, stateFile: opts.stateFile, providers: opts.providers, log })
    if (!dvn.rows.length) log('  (no deployed pathway)')
    if (!dvn.ok) warn('a pathway is not on the configured verifier set')
  }

  const ok = backed && requestsOk && peersOk
  log(
    `\n${ok ? '✓' : '✗'} backing ${backed ? 'holds' : 'FAILS'}` +
      `${requestsOk ? '' : ' — a REQUEST CEILING is above what requests prepay'}${peersOk ? '' : ' — THE USDT VAULT IS A CCTP PEER'}` +
      ` — ${warnings.length} warning(s)`,
  )
  return { ok, backed, deployed: true, held, supply, ledger, byDollar, vaults, bnb, requests, peersOk, warnings, dvn, waiting, missing }
}

/* ------------------------- missing replicas, resync ------------------------- */

/**
 * Every (token, chain) pair of the last `maxTokens` tokens whose gateway has
 * NO replica. State, not logs: public RPCs cap `eth_getLogs` to a few
 * hundred blocks, and "is there a replica" is the fact that matters anyway —
 * whether the SYNC failed at spawn (SyncFailed), was lost, or the chain was
 * wired after the token was launched (never synced: resync backfills it).
 */
async function missingReplicas(opts) {
  const { profile } = opts
  const all = opts.all ?? loadState(opts.stateFile ?? profile.stateFile)
  const nets = opts.nets ?? activeNets(profile)
  const deployed = opts.deployed ?? Object.keys(nets).filter((n) => all[n]?.gateway)
  const hub = all[profile.hub]
  if (!hub?.pad) return []
  const P = (net) => providerOf(profile, net, opts.providers)
  const pad = await ethers.getContractAt('SpawnPad', hub.pad, P(profile.hub))
  const gws = {}
  for (const net of deployed) gws[net] = await ethers.getContractAt('SpawnGateway', all[net].gateway, P(net))
  // only chains the pad actually SYNCs: a deployed spoke the hub has not
  // wired yet (inside its timelock delay) is not "missing" anything
  const wired = []
  for (const net of deployed) {
    if ((await pad.gateways(nets[net].label)) !== ethers.ZeroHash) wired.push(net)
  }
  const total = Number(await pad.tokensLength())
  const from = Math.max(0, total - (opts.maxTokens ?? 200))
  // the CHAIN's clock: a fork that travelled in time, or a quiet devnet,
  // does not share this machine's
  const now = Number((await P(profile.hub).getBlock('latest')).timestamp)
  const out = []
  for (let i = total - 1; i >= from; i--) {
    const token = await pad.allTokens(i)
    const reps = await Promise.all(wired.map((net) => gws[net].replicaOf(token)))
    if (reps.every((r) => r !== ethers.ZeroAddress)) continue
    const meta = await pad.metas(token)
    reps.forEach((r, k) => {
      if (r !== ethers.ZeroAddress) return
      out.push({
        token, symbol: meta.symbol, net: wired[k], label: nets[wired[k]].label,
        fresh: now - Number(meta.spawnedAt) < 600,
      })
    })
  }
  return out
}

/**
 * Sends a token's SYNC to one chain again (operator only; the hub tank pays
 * the message). For a leg whose SYNC failed at spawn or was lost, and to
 * backfill tokens launched before a chain was wired. A gateway ignores a
 * SYNC for a replica it already has; whatever reached that chain before its
 * replica (a dev-buy DELIVER, a FEE_DROP) is parked there until this lands.
 * opts: { profile, netKey (the hub), signer, token ('0x…' | 'missing'), chain? (net key), apply?, providers?, stateFile?, maxTokens?, log? }
 */
async function resync(opts) {
  const { profile, netKey, signer, log = console.log } = opts
  if (netKey !== profile.hub) throw new Error(`resync is sent on the hub (${profile.hub}), not on ${netKey}`)
  const all = loadState(opts.stateFile ?? profile.stateFile)
  const hub = all[profile.hub]
  if (!hub?.pad) throw new Error(`${profile.hub}: not deployed`)
  const nets = activeNets(profile)
  const pad = await ethers.getContractAt('SpawnPad', hub.pad, signer)
  const adapter = await ethers.getContractAt('LayerZeroOmniMessenger', hub.adapter, signer)
  let pairs
  if (opts.token === 'missing') {
    pairs = (await missingReplicas({ ...opts, all, nets })).filter((m) => !opts.chain || m.net === opts.chain)
  } else {
    if (!ethers.isAddress(opts.token)) throw new Error('SPAWN_TOKEN must be a token address, or "missing"')
    if (!opts.chain || !nets[opts.chain]) throw new Error(`SPAWN_CHAIN must be one of ${Object.keys(nets).join(', ')}`)
    pairs = [{ token: ethers.getAddress(opts.token), net: opts.chain, label: nets[opts.chain].label, symbol: '' }]
  }
  log(`resync — ${profile.name}/${netKey} — ${pairs.length} token/chain pair(s)`)
  const out = []
  if (!pairs.length) {
    log('  nothing to resync')
    return out
  }
  const isOperator = await hasRole(pad, 'operator', signer.address)
  let tank = await signer.provider.getBalance(hub.adapter)
  for (const p of pairs) {
    const meta = await pad.metas(p.token)
    const gw = await pad.gateways(p.label)
    if (meta.spawnedAt === 0n || gw === ethers.ZeroHash) {
      log(`  ${p.token} → ${p.net}: the pad does not know this token or has no gateway for that chain — skipped`)
      continue
    }
    const payload = coder.encode(
      ['uint8', 'bytes'],
      [10, coder.encode(['bytes32', 'string', 'string'], [b32(p.token), meta.name, meta.symbol])],
    )
    let fee
    try {
      fee = await adapter.quote(p.label, gw, payload, 0)
    } catch (e) {
      // the leg still refuses the send: resync would revert like the SYNC did
      log(`  ${p.token} ${meta.symbol} → ${p.net}: the leg still cannot be quoted (${e.shortMessage ?? e.message}) — repair it first`)
      out.push({ ...p, sent: false, error: 'leg' })
      continue
    }
    const item = { ...p, fee, sent: false }
    out.push(item)
    const data = pad.interface.encodeFunctionData('resync', [p.token, p.label])
    if (!isOperator) {
      log(`  ⏳ ${p.token} ${meta.symbol} → ${p.net} needs the operator: target ${pad.target} data ${data}`)
      continue
    }
    if (!opts.apply) {
      log(`  ${p.token} ${meta.symbol} → ${p.net}: would resync (the hub tank pays ${fmt(fee)} ${nativeOf(profile)})`)
      continue
    }
    if (tank < fee) {
      log(`  ⚠ ${p.token} → ${p.net}: the hub tank (${fmt(tank)}) cannot pay ${fmt(fee)} — top it up first`)
      item.error = 'tank'
      tank = 0n // every later pair is short too; sum the whole shortfall
      continue
    }
    await (await pad.resync(p.token, p.label)).wait()
    tank -= fee
    item.sent = true
    log(`  ${p.token} ${meta.symbol} → ${p.net}: resync sent (${fmt(fee)} ${nativeOf(profile)} from the hub tank) ✓`)
  }
  const short = out.filter((o) => o.error === 'tank')
  if (short.length) {
    const need = short.reduce((a, o) => a + o.fee, 0n)
    log(
      `  ➜ ${short.length} resync(s) wait for gas: send ≥ ${fmt((need * 11n) / 10n)} ${nativeOf(profile)} to the hub adapter ` +
        `${hub.adapter} (its gas tank), then run this again`,
    )
  }
  return out
}

/* --------------------------------- set-cap --------------------------------- */

/**
 * Sets one network's vault deposit cap (operator) — the guarded launch's
 * exposure dial. `wholeDollars` is in WHOLE units of the universe's dollar;
 * it is scaled by the token's own decimals here. 0 closes the vault to new
 * deposits (exits stay open). Without the role, or without `apply`, the
 * calldata is printed. `wholeDollars` is in units of THIS CHAIN's dollar
 * (USDT on BNB Chain).
 * opts: { profile, netKey, signer, wholeDollars, apply?, live?, stateFile?, log? }
 */
async function setCap(opts) {
  const { profile, netKey, signer, log = console.log } = opts
  const cfg = profile.nets[netKey]
  if (!cfg) throw new Error(`${netKey} is not a network of the ${profile.name} profile`)
  const DEC = dollarOfNet(profile, netKey).decimals
  const SYM = dollarOf(profile, netKey)
  const want = dollarUnits(profile, opts.wholeDollars, netKey)
  const state = loadState(opts.stateFile ?? profile.stateFile)[netKey]
  const vaultAddr = vaultOf(profile, netKey, state)
  if (!vaultAddr) throw new Error(`${netKey}: no vault deployed in ${opts.stateFile ?? profile.stateFile}`)
  const vault = await ethers.getContractAt(vaultName(profile, netKey), vaultAddr, signer)
  const [cap, held] = await Promise.all([vault.depositCap(), vault.liquidity()])
  const usdc = (v) => ethers.formatUnits(v, DEC)
  log(`set-cap — ${profile.name}/${netKey} — vault ${vaultAddr}`)
  log(`  holds ${usdc(held)} ${SYM} · cap ${usdc(cap)} → wanted ${usdc(want)}`)
  if (cap === want) {
    log('  ✓ already set')
    return { changed: false, cap }
  }
  const mine = await hasRole(vault, 'operator', signer.address)
  if (!opts.apply || !mine) {
    if (!mine) log(`  the operator is ${await vault.operator()} — not this key. Calldata for it:`)
    else log('  (not applied — SPAWN_APPLY=1 sends it)')
    const data = vault.interface.encodeFunctionData('setDepositCap', [want])
    log(`    target ${vaultAddr}\n    data   ${data}`)
    return { changed: true, applied: false, blocked: mine ? undefined : { target: vaultAddr, data } }
  }
  await (await vault.setDepositCap(want)).wait()
  // a lagging public RPC may still serve the old cap: wait until it is visible
  let now = await vault.depositCap()
  for (let i = 0; now !== want && opts.live && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    now = await vault.depositCap()
  }
  if (now !== want) throw new Error(`cap reads back ${usdc(now)}, wanted ${usdc(want)}`)
  log(`  setDepositCap(${usdc(want)} ${SYM}) ✓`)
  // the site reads the cap from the manifest: keep it true to the chain
  if (opts.manifest !== false) {
    try {
      await writeManifest({
        profile, netKey, signer, log,
        stateFile: opts.stateFile ?? profile.stateFile,
        manifestFile: opts.manifestFile ?? profile.manifestFile,
        providers: opts.providers,
      })
    } catch (e) {
      log(`  ⚠ manifest not refreshed (${e.shortMessage ?? e.message}) — the next deploy run rewrites it`)
    }
  }
  return { changed: true, applied: true, cap: want }
}

module.exports = {
  tuneFees, keeperPull, status, missingReplicas, resync, setCap, SAMPLE_DELIVER, SAMPLE_SYNC, SAMPLE_PAYOUT, distOf,
  OP_GAS_SETTER, OP_GAS_GETTER, opGasSupported,
}
