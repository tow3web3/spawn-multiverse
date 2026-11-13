/**
 * Day-2 operations — the logic behind tune-fees.js, keeper-pull.js and
 * status.js, as functions so the test suite can drive them.
 *
 * Cross-chain reads go over each network's RPC (config/profiles.js);
 * `providers` ({ net: provider }) overrides them — the tests put every
 * "network" of a simulated deployment on one in-process chain.
 */
const { ethers } = require('hardhat')
const { activeNets, hubGasFor } = require('../config/profiles')
const { loadState, b32, same, hasRole, vaultOf, distOf, roleKeys, USDC_ABI, ENDPOINT_ABI } = require('./lib-net')
const { verifyDvn } = require('./lib-dvn')

const coder = ethers.AbiCoder.defaultAbiCoder()
const fmt = (wei) => ethers.formatEther(wei)
const SCALE = 10n ** 12n

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
const SAMPLE_SYNC = coder.encode(
  ['uint8', 'bytes'],
  [10, coder.encode(['bytes32', 'string', 'string'], [ethers.ZeroHash, 'N'.repeat(64), 'S'.repeat(16)])],
)

/* -------------------------------- tune-fees -------------------------------- */

/**
 * Re-prices one network's reply budgets from LIVE quotes.
 *  - on a SPOKE: `returnUnit(hub)` = what the hub pays to answer this chain
 *    (a DELIVER) + margin — what every trade from here prepays per leg. Then
 *    `spawnLegs`, so that legs × unit covers what a spawn from here makes
 *    the hub pay: one SYNC to EVERY remote chain (never fewer legs than
 *    chains). A dearer destination — an L1 — costs several of this chain's
 *    legs, which is why the count alone under-funds the hub tank. And the
 *    hub-bound executor gas, which must grow with the number of chains the
 *    hub SYNCs on a spawn (config/profiles.js → hubGasFor).
 *  - on the HUB: `returnUnit(0)` = (Σ of the SYNC quotes to every remote
 *    chain + margin) ÷ the local gateway's spawnLegs — a locally-initiated
 *    spawn prepays exactly the fan-out, not (dearest × chains).
 * Set too low the hub tank drains and replies stall (retryable); too high
 * users overpay into the tank. Operator-only; without the role (or without
 * `apply`) the changes are printed as calldata.
 * opts: { profile, netKey, signer, apply?, marginPct?, tolerancePct?, providers?, stateFile?, log? }
 */
async function tuneFees(opts) {
  const { profile, netKey, signer, log = console.log } = opts
  const marginPct = BigInt(opts.marginPct ?? 25)
  const tolerancePct = BigInt(opts.tolerancePct ?? 5)
  const all = loadState(opts.stateFile ?? profile.stateFile)
  const s = all[netKey]
  const hub = all[profile.hub]
  if (!s?.adapter || !hub?.adapter) throw new Error(`${netKey}: not deployed`)
  const nets = activeNets(profile)
  const cfg = profile.nets[netKey]
  const adapter = await ethers.getContractAt('LayerZeroOmniMessenger', s.adapter, signer)
  const gateway = await ethers.getContractAt('SpawnGateway', s.gateway, signer)
  const hubAdapter =
    netKey === profile.hub
      ? adapter
      : await ethers.getContractAt('LayerZeroOmniMessenger', hub.adapter, providerOf(profile, profile.hub, opts.providers))
  const ceilDiv = (a, b) => (a === 0n ? 0n : (a - 1n) / b + 1n)

  // what the hub pays to SYNC each remote chain it has a route to
  const syncs = []
  for (const [net, c] of Object.entries(nets)) {
    if (c.role !== 'spoke' || !all[net]?.ready) continue
    if ((await hubAdapter.eidOf(c.label)) === 0n) continue
    syncs.push({ net, what: 'SYNC', fee: await hubAdapter.quote(c.label, b32(all[net].gateway), SAMPLE_SYNC, 0) })
  }
  const syncSum = syncs.reduce((a, q) => a + q.fee, 0n)

  const quotes = []
  let target
  let basis
  let legsNow = Number(await gateway.spawnLegs())
  let legsTarget = legsNow
  const tradeLegs = Number(await gateway.tradeLegs())
  const gas = await adapter.gasLimit(0)
  let gasTarget = gas
  if (cfg.role === 'hub') {
    quotes.push(...syncs)
    if (!quotes.length) {
      log(`tune-fees — ${netKey}: no wired spoke yet, nothing to price`)
      return { changed: false, quotes }
    }
    const legs = BigInt(Math.max(1, legsNow))
    target = ceilDiv(syncSum * (100n + marginPct), 100n * legs)
    basis = `Σ of ${quotes.length} SYNC quote(s) + ${marginPct}% ÷ ${legs} leg(s)`
  } else {
    if ((await hubAdapter.eidOf(cfg.label)) === 0n) {
      throw new Error(`the hub has no route to ${netKey} yet — re-run the deploy on ${profile.hub} first`)
    }
    quotes.push({ net: netKey, what: 'DELIVER', fee: await hubAdapter.quote(cfg.label, b32(s.gateway), SAMPLE_DELIVER, 0) })
    target = (quotes[0].fee * (100n + marginPct)) / 100n
    basis = `the DELIVER quote + ${marginPct}%`
    gasTarget = hubGasFor(profile, syncs.length)
    if (gasTarget < gas) gasTarget = gas // never lowered here: a spawn out of gas on the hub is a stuck message
  }
  const cap = await adapter.MAX_RETURN_UNIT()
  if (target > cap) {
    log(`  ⚠ ${fmt(target)} ETH exceeds the contract cap ${fmt(cap)} — clamped; replies will be under-funded`)
    target = cap
  }
  const current = await adapter.returnUnit(0)
  const diff = current > target ? current - target : target - current
  const unitChanged = current === 0n || diff * 100n > current * tolerancePct
  // the unit that will be on chain after this run: legs are sized against it
  const unit = unitChanged ? target : current
  if (cfg.role !== 'hub' && unit > 0n) {
    const maxLegs = Number(await gateway.MAX_SPAWN_LEGS())
    const need = Number(ceilDiv(syncSum * (100n + marginPct), 100n * unit))
    legsTarget = Math.max(syncs.length, need)
    if (legsTarget > maxLegs) {
      log(`  ⚠ a spawn from ${netKey} would need ${legsTarget} legs, the contract allows ${maxLegs} — clamped; the hub tank pays the rest`)
      legsTarget = maxLegs
    }
    // tolerance: a couple of percent of drift is not worth a transaction, and
    // legs are never lowered below one per chain
    if (legsTarget < legsNow && (legsNow - legsTarget) * 100 <= legsNow * Number(tolerancePct)) legsTarget = legsNow
  }
  const legsChanged = legsTarget !== legsNow
  const gasChanged = gasTarget !== gas
  const changed = unitChanged || legsChanged || gasChanged

  log(`tune-fees — ${profile.name}/${netKey} — reply budget per leg (hub-chain native)`)
  for (const q of quotes) log(`  live quote hub -> ${q.net} (${q.what}): ${fmt(q.fee)} ETH`)
  log(`  current ${fmt(current)} ETH  →  target ${fmt(target)} ETH (${basis})`)
  if (cfg.role !== 'hub') {
    for (const q of syncs) log(`  a spawn from here makes the hub SYNC ${q.net}: ${fmt(q.fee)} ETH`)
    log(`  spawnLegs ${legsNow}  →  ${legsTarget} (Σ SYNC ${fmt(syncSum)} ETH + ${marginPct}% ÷ ${fmt(unit)} ETH/leg, at least one per chain)`)
    log(`  hub-bound executor gas ${gas}  →  ${gasTarget} (${syncs.length} remote chain(s) on a spawn)`)
  }
  if (!changed) {
    log(`  ✓ within ${tolerancePct}% — left as is`)
    return { changed: false, current, target, quotes, syncs, legs: { current: legsNow, target: legsTarget }, gas: { current: gas, target: gasTarget } }
  }
  const out = {
    changed: true, applied: false, current, target, quotes, syncs,
    legs: { current: legsNow, target: legsTarget }, gas: { current: gas, target: gasTarget },
  }
  if (!opts.apply) {
    log('  (not applied — SPAWN_APPLY=1 sends it)')
    return out
  }
  const destArgs = [0, gasTarget, unit]
  const legsArgs = [tradeLegs, legsTarget]
  const isOperator = await hasRole(adapter, 'operator', signer.address)
  if (!isOperator) {
    if (unitChanged || gasChanged) {
      const data = adapter.interface.encodeFunctionData('setDestination', destArgs)
      log(`  ⏳ needs the operator: target ${adapter.target} data ${data}`)
      out.blocked = { target: adapter.target, data }
    }
    if (legsChanged) {
      const data = gateway.interface.encodeFunctionData('setLegs', legsArgs)
      log(`  ⏳ needs the operator: target ${gateway.target} data ${data}`)
      out.blockedLegs = { target: gateway.target, data }
    }
    return out
  }
  // Order matters when the budget GROWS: the unit (and gas) first, the legs
  // after — at no point does a spawn prepay less than before.
  if (unitChanged || gasChanged) {
    await (await adapter.setDestination(...destArgs)).wait()
    log(`  adapter.setDestination(0, ${gasTarget}, ${fmt(unit)} ETH) ✓`)
  }
  if (legsChanged) {
    await (await gateway.setLegs(...legsArgs)).wait()
    log(`  gateway.setLegs(${tradeLegs}, ${legsTarget}) ✓`)
  }
  out.applied = true
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
      log(`  ${token}: $${ethers.formatEther(due)} waiting — would pull (fee ${fmt(fee)} ETH)`)
      continue
    }
    await (await gateway.pullFees(token, { value: fee })).wait()
    item.pulled = true
    log(`  ${token}: $${ethers.formatEther(due)} pulled (fee ${fmt(fee)} ETH) ✓`)
  }
  if (!out.length) log('  nothing at or above the threshold')
  return out
}

/* ---------------------------------- status ---------------------------------- */

/**
 * One screen: tanks, vaults vs oUSD supply and the GLOBAL backing check,
 * pending holder fees, pauses, roles, verifier sets. Read-only.
 * `ok` is false when the backing check fails: Σ vault USDC × 1e12 must cover
 * Σ oUSD supply over every instance (hub ledger included). Value in flight
 * between chains shows as a SURPLUS (dollars already in a vault, not yet in
 * the books) — except a CCTP rebalance, which is a temporary DEFICIT of
 * exactly the amount in flight (`inflightUsdc` allows for it).
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

  // ── vaults and the global backing check ──
  log('\nVAULTS (USDC held ↔ oUSD claims on this chain)')
  let held = 0n
  let supply = await hubUsd.totalSupply()
  for (const net of deployed) {
    const vaultAddr = vaultOf(profile, net, all[net])
    const vault = await at('OmniUSD', vaultAddr, net)
    const usdc = new ethers.Contract(await vault.usdc(), USDC_ABI, P(net))
    const bal = await usdc.balanceOf(vaultAddr)
    const claims = await vault.totalSupply()
    const cap = await vault.depositCap()
    const closed = await vault.depositsPaused()
    held += bal * SCALE
    supply += claims
    log(
      `  ${net.padEnd(16)} ${ethers.formatUnits(bal, 6).padStart(14)} USDC | oUSD here ${ethers.formatEther(claims).padStart(12)} | ` +
        `cap ${ethers.formatUnits(cap, 6)}${closed ? ' | DEPOSITS PAUSED' : cap === 0n ? ' | deposits closed' : ''}`,
    )
    if (claims > bal * SCALE) warn(`${net}: vault is locally short — some oUSD here cannot be unwrapped until a rebalance`)
  }
  log(`  hub ledger (books of the curve and fee pots): ${ethers.formatEther(await hubUsd.totalSupply())} oUSD`)
  const inflight = BigInt(opts.inflightUsdc ?? 0) * 10n ** 6n * SCALE
  const backed = held + inflight >= supply
  log(
    `\nBACKING  Σ vault USDC ${ethers.formatEther(held)}  vs  Σ oUSD supply ${ethers.formatEther(supply)}  →  ` +
      (backed
        ? `✓ covered (surplus ${ethers.formatEther(held + inflight - supply)} — value in flight, parked or dust)`
        : `✗ DEFICIT ${ethers.formatEther(supply - held - inflight)} — PAUSE AND INVESTIGATE`),
  )

  // ── tanks ──
  log('\nGAS TANKS (adapters)')
  for (const net of deployed) {
    const bal = await P(net).getBalance(all[net].adapter)
    const isHub = net === profile.hub
    log(`  ${net.padEnd(16)} ${fmt(bal)} ${isHub ? '(pays every reply — refilled by prepaid budgets)' : ''}`)
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

  log(`\n${backed ? '✓' : '✗'} backing ${backed ? 'holds' : 'FAILS'} — ${warnings.length} warning(s)`)
  return { ok: backed, deployed: true, held, supply, warnings, dvn, waiting }
}

module.exports = { tuneFees, keeperPull, status, SAMPLE_DELIVER, SAMPLE_SYNC, distOf }
