/**
 * What a REQUEST prepays into the hub tank (v7.2), read from the chains —
 * shared by the deploy (initial ceilings), tune-fees (pricing) and status /
 * the self-check (the rules, verified from on-chain values).
 *
 * Two kinds of message are sent by the hub because a user ASKED for them,
 * each bounded on the pad by its own ceiling, per destination D and per kind
 * of message the hub sends (`requestCap[D][op]`, hub-native wei):
 *   - op 10 (SYNC): the SYNC an `openToken` on chain D asks for, prepaid on D:
 *       open(D)      = D.openLegs × D.adapter.returnUnit(0)
 *   - op 12 (PAYOUT): the PAYOUT a `moveClaim` from chain S toward D asks
 *     for, prepaid on S:
 *       move(S → D)  = max(S.moveLegs[D], S.tradeLegs) × S.adapter.returnUnit(0)
 * (on the hub chain's own gateway the unit is the hub adapter's
 * returnUnit(0), the local fan-out budget: its value stays in the hub tank).
 *
 * THE RULES: the tank is never out of pocket on a request —
 *   requestCap[D][10] ≤ open(D)
 *   requestCap[D][12] ≤ min(move(S → D) for every S with a route to D)
 * and each prepay covers the live quote of the message it asks for (the
 * worst-case SYNC; the PAYOUT) with a margin. A remote gateway with
 * openLegs = 0 would let anyone make the tank pay a SYNC: a hard failure.
 *
 * AND (second round): the pad's skippable messages carry one return leg, so
 * the hub adapter attaches `returnUnit[dst]` to them. For every EVM label on
 * the hub adapter — the hub chain's own gateway included — that unit MUST be
 * 0 (only a chain that charges for accounts, Solana, has one). `hubUnits`
 * reads them; a non-zero EVM unit is a hard failure.
 */
const { ethers } = require('hardhat')
const { activeNets } = require('../config/profiles')
const { encodeOp } = require('./lib-wire')

/** The two kinds of message a request toward a chain makes the hub send. */
const OP_SYNC = 10
const OP_PAYOUT = 12

const GW_ABI = [
  'function openLegs() view returns (uint8)',
  'function tradeLegs() view returns (uint8)',
  'function spawnLegs() view returns (uint8)',
  'function moveLegs(uint32) view returns (uint16)',
]
const ADAPTER_ABI = [
  'function returnUnit(uint32) view returns (uint128)',
  'function eidOf(uint32) view returns (uint32)',
  'function quote(uint32,bytes32,bytes,uint256) view returns (uint256)',
]
const PAD_ABI = [
  'function requestCap(uint32,uint8) view returns (uint256)',
  'function syncCap(uint32) view returns (uint256)',
  'function gateways(uint32) view returns (bytes32)',
]

const b32 = (a) => ethers.zeroPadValue(a, 32)

/** The worst SYNC a gateway can be sent (the longest name and symbol the
 * gateway admits) and a PAYOUT — at the size that matters for their fee. */
const WORST_SYNC = encodeOp('SYNC_TOKEN', [ethers.ZeroHash, 'N'.repeat(64), 'S'.repeat(16)])
const SAMPLE_PAYOUT = encodeOp('PAYOUT', [ethers.ZeroHash, 1n])
/** The pad's skippable messages (a SYNC, a forwarded PAYOUT) pass ONE return
 * leg since the second round: quote them the way the pad does. */
const SKIPPABLE_LEGS = 1

/** The provider of `net`: an override, else its RPC from the profile. */
function providerFor(profile, net, providers) {
  if (providers?.[net]) return providers[net]
  const c = profile.nets[net]
  return new ethers.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true })
}

/** Every deployed chain's legs and reply unit, read from its own chain. */
async function readLegs({ profile, all, providers, only }) {
  const nets = activeNets(profile)
  const deployed = Object.keys(nets).filter((n) => all[n]?.gateway && all[n]?.adapter && (!only || only.includes(n)))
  const labels = deployed.map((n) => nets[n].label)
  const out = {}
  for (const net of deployed) {
    const P = providerFor(profile, net, providers)
    const gw = new ethers.Contract(all[net].gateway, GW_ABI, P)
    const adapter = new ethers.Contract(all[net].adapter, ADAPTER_ABI, P)
    const moveLegs = {}
    for (const l of labels) if (l !== nets[net].label) moveLegs[l] = Number(await gw.moveLegs(l))
    out[net] = {
      label: nets[net].label,
      unit: BigInt(await adapter.returnUnit(0)),
      tradeLegs: Number(await gw.tradeLegs()),
      openLegs: Number(await gw.openLegs()),
      spawnLegs: Number(await gw.spawnLegs()),
      moveLegs,
    }
  }
  return out
}

/** What one move from `src` toward `dstLabel` prepays (0 = route closed). */
function movePrepay(legs, dstLabel) {
  const l = legs.moveLegs[dstLabel] ?? 0
  if (l === 0) return 0n
  return BigInt(Math.max(l, legs.tradeLegs)) * legs.unit
}

/**
 * The hub adapter's `returnUnit` for every EVM label of the deployment (the
 * spokes', and the hub chain's own gateway label): each must be 0. (Label 0
 * is a different thing — what the hub chain's users prepay per leg — and is
 * not in this list.)
 */
async function hubUnits({ profile, all, providers }) {
  const hub = all[profile.hub]
  if (!hub?.adapter) return { rows: [], ok: true }
  const adapter = new ethers.Contract(hub.adapter, ADAPTER_ABI, providerFor(profile, profile.hub, providers))
  const rows = []
  for (const [net, c] of Object.entries(activeNets(profile))) {
    if (c.kind && c.kind !== 'evm') continue // a chain that charges for accounts may have one
    const unit = BigInt(await adapter.returnUnit(c.label))
    rows.push({ net, label: c.label, unit, ok: unit === 0n })
  }
  return { rows, ok: rows.every((r) => r.ok) }
}

/**
 * For every REMOTE chain (a spoke the hub reaches by LayerZero): what a
 * request toward it prepays, per kind, the two ceilings the pad applies, the
 * live quotes, and whether THE RULES hold. Read-only.
 * opts: { profile, all, providers?, legs? (from readLegs), quotes? (false to skip) }
 */
async function requestSolvency(opts) {
  const { profile, all } = opts
  const hub = all[profile.hub]
  const nets = activeNets(profile)
  const legs = opts.legs ?? (await readLegs(opts))
  const HP = providerFor(profile, profile.hub, opts.providers)
  const pad = hub?.pad ? new ethers.Contract(hub.pad, PAD_ABI, HP) : null
  const hubAdapter = hub?.adapter ? new ethers.Contract(hub.adapter, ADAPTER_ABI, HP) : null
  const rows = []
  for (const [dst, d] of Object.entries(legs)) {
    if (dst === profile.hub || nets[dst].role !== 'spoke') continue
    const label = d.label
    const open = BigInt(d.openLegs) * d.unit
    const moves = []
    for (const [src, s] of Object.entries(legs)) {
      if (src === dst) continue
      const prepay = movePrepay(s, label)
      if (prepay > 0n) moves.push({ src, legs: Math.max(s.moveLegs[label], s.tradeLegs), unit: s.unit, prepay })
    }
    const minMove = moves.length ? moves.reduce((a, m) => (m.prepay < a ? m.prepay : a), moves[0].prepay) : undefined
    const capSync = pad ? BigInt(await pad.requestCap(label, OP_SYNC)) : 0n
    const capPayout = pad ? BigInt(await pad.requestCap(label, OP_PAYOUT)) : 0n
    const syncCap = pad ? BigInt(await pad.syncCap(label)) : 0n
    let qSync
    let qPayout
    const routed = hubAdapter && all[dst]?.gateway && (await hubAdapter.eidOf(label)) !== 0n
    if (opts.quotes !== false && routed) {
      try {
        qSync = BigInt(await hubAdapter.quote(label, b32(all[dst].gateway), WORST_SYNC, SKIPPABLE_LEGS))
        qPayout = BigInt(await hubAdapter.quote(label, b32(all[dst].gateway), SAMPLE_PAYOUT, SKIPPABLE_LEGS))
      } catch {
        /* a leg that cannot be quoted: reported below */
      }
    }
    rows.push({
      net: dst,
      label,
      open,
      openLegs: d.openLegs,
      moves,
      minMove,
      capSync,
      capPayout,
      syncCap,
      qSync,
      qPayout,
      // the rules: neither ceiling exceeds what any request of its kind prepaid
      syncOk: capSync <= open,
      payoutOk: minMove === undefined ? true : capPayout <= minMove,
      // a remote gateway that prepays no SYNC for an open: anyone could make
      // the tank pay one
      openOk: d.openLegs >= 1,
      // what is prepaid covers the live price (a ceiling under it closes the
      // chain to that kind of request in effect: refused, not unsafe)
      openCovered: qSync === undefined ? undefined : open >= qSync,
      movesCovered: qPayout === undefined ? undefined : moves.every((m) => m.prepay >= qPayout),
      opensServed: qSync === undefined ? undefined : capSync >= qSync,
      movesServed: qPayout === undefined || minMove === undefined ? undefined : capPayout >= qPayout,
    })
  }
  for (const r of rows) r.capOk = r.syncOk && r.payoutOk
  return { rows, legs, ok: rows.every((r) => r.capOk && r.openOk) }
}

module.exports = {
  readLegs, requestSolvency, hubUnits, movePrepay, providerFor,
  WORST_SYNC, SAMPLE_PAYOUT, SKIPPABLE_LEGS, OP_SYNC, OP_PAYOUT, GW_ABI, ADAPTER_ABI, PAD_ABI,
}
