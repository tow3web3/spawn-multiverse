/**
 * What a REQUEST prepays into the hub tank (v7.2), read from the chains —
 * shared by the deploy (initial ceilings), tune-fees (pricing) and status /
 * the self-check (the rule, verified from on-chain values).
 *
 * Two kinds of message are sent by the hub because a user ASKED for them,
 * and the pad bounds each by `requestCap[dst]` (hub-native wei):
 *   - the SYNC an `openToken` on chain D asks for, prepaid on D:
 *       open(D)      = D.openLegs × D.adapter.returnUnit(0)
 *   - the PAYOUT a `moveClaim` from chain S toward D asks for, prepaid on S:
 *       move(S → D)  = max(S.moveLegs[D], S.tradeLegs) × S.adapter.returnUnit(0)
 * (on the hub chain's own gateway the unit is the hub adapter's
 * returnUnit(0), the local fan-out budget: its value stays in the hub tank).
 *
 * THE RULE: the tank is never out of pocket on a request —
 *   requestCap[D] ≤ min(open(D), move(S → D) for every S with a route to D)
 * and each of those prepays covers the live quote of the message it asks for
 * (the worst-case SYNC, the PAYOUT) with a margin. A remote gateway with
 * openLegs = 0 would let anyone make the tank pay a SYNC: a hard failure.
 */
const { ethers } = require('hardhat')
const { activeNets } = require('../config/profiles')

const coder = ethers.AbiCoder.defaultAbiCoder()

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
  'function requestCap(uint32) view returns (uint256)',
  'function syncCap(uint32) view returns (uint256)',
  'function gateways(uint32) view returns (bytes32)',
]

const b32 = (a) => ethers.zeroPadValue(a, 32)

/** The worst SYNC a gateway can be sent (the longest name and symbol the
 * gateway admits) and a PAYOUT — at the size that matters for their fee. */
const WORST_SYNC = coder.encode(
  ['uint8', 'bytes'],
  [10, coder.encode(['bytes32', 'string', 'string'], [ethers.ZeroHash, 'N'.repeat(64), 'S'.repeat(16)])],
)
const SAMPLE_PAYOUT = coder.encode(['uint8', 'bytes'], [12, coder.encode(['bytes32', 'uint256'], [ethers.ZeroHash, 1n])])

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
 * For every REMOTE chain (a spoke the hub reaches by LayerZero): what a
 * request toward it prepays, the ceiling the pad applies, the live quotes,
 * and whether THE RULE holds. Read-only.
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
    const prepays = [open, ...moves.map((m) => m.prepay)]
    const min = prepays.reduce((a, b) => (b < a ? b : a), prepays[0])
    const cap = pad ? BigInt(await pad.requestCap(label)) : 0n
    const syncCap = pad ? BigInt(await pad.syncCap(label)) : 0n
    let qSync
    let qPayout
    const routed = hubAdapter && all[dst]?.gateway && (await hubAdapter.eidOf(label)) !== 0n
    if (opts.quotes !== false && routed) {
      try {
        qSync = BigInt(await hubAdapter.quote(label, b32(all[dst].gateway), WORST_SYNC, 0))
        qPayout = BigInt(await hubAdapter.quote(label, b32(all[dst].gateway), SAMPLE_PAYOUT, 0))
      } catch {
        /* a leg that cannot be quoted: reported below */
      }
    }
    const need = qSync === undefined ? undefined : qSync > qPayout ? qSync : qPayout
    rows.push({
      net: dst,
      label,
      open,
      openLegs: d.openLegs,
      moves,
      min,
      cap,
      syncCap,
      qSync,
      qPayout,
      need,
      // the rule: the ceiling never exceeds what any request toward it prepaid
      capOk: cap <= min,
      // a remote gateway that prepays no SYNC for an open: anyone could make
      // the tank pay one
      openOk: d.openLegs >= 1,
      // what is prepaid covers the live price (a cap under it closes the chain
      // to opens and moves in effect: refused, not unsafe)
      covered: need === undefined ? undefined : prepays.every((p) => p >= need),
      open_for_requests: need === undefined ? undefined : cap >= need,
    })
  }
  return { rows, legs, ok: rows.every((r) => r.capOk && r.openOk) }
}

module.exports = { readLegs, requestSolvency, movePrepay, providerFor, WORST_SYNC, SAMPLE_PAYOUT, GW_ABI, ADAPTER_ABI, PAD_ABI }
