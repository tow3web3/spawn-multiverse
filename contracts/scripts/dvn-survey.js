/**
 * READ-ONLY survey of LayerZero verifiers (DVNs) for the mainnet pathways —
 * the data behind `config/profiles.js` → mainnet.dvn. Sends nothing.
 *
 *   node scripts/dvn-survey.js                      # the fee table
 *   node scripts/dvn-survey.js --emit "LayerZero Labs,Google,Horizen,Twinstake"
 *                                                    # + the `addresses` block for the config
 *   DVN_METADATA_FILE=dvns.json node scripts/dvn-survey.js   # offline registry copy
 *
 * For every DVN that LayerZero's registry lists as live (v2, not deprecated,
 * not lzRead-only) on ALL launch chains, it calls that DVN's own
 * `getFee(dstEid, confirmations, sender, options)` on every pathway
 * (hub ↔ each spoke, both directions). A DVN that fails to quote on ANY
 * pathway is marked unusable: `configure-dvn.js` would refuse it too.
 */
const fs = require('fs')
const { ethers } = require('ethers')
const { PROFILES } = require('../config/profiles')

const REGISTRY = 'https://metadata.layerzero-api.com/v1/metadata/dvns'
const profile = PROFILES.mainnet
const nets = profile.nets // survey every configured net, enabled or not
const HUB = profile.hub

const EP_ABI = ['function getSendLibrary(address,uint32) view returns (address)']
const ULN_ABI = [
  'function getUlnConfig(address,uint32) view returns ((uint64 confirmations,uint8 requiredDVNCount,uint8 optionalDVNCount,uint8 optionalDVNThreshold,address[] requiredDVNs,address[] optionalDVNs))',
]
const DVN_ABI = ['function getFee(uint32,uint64,address,bytes) view returns (uint256)']
// any address works as the quoting sender; DVNs with an allowlist fail here
const SENDER = '0x000000000000000000000000000000000000dEaD'

async function loadRegistry() {
  if (process.env.DVN_METADATA_FILE) return JSON.parse(fs.readFileSync(process.env.DVN_METADATA_FILE, 'utf8'))
  const res = await fetch(REGISTRY)
  if (!res.ok) throw new Error(`registry fetch failed: ${res.status}`)
  return res.json()
}

async function main() {
  const reg = await loadRegistry()
  const netKeys = Object.keys(nets)
  // name -> net -> address (live v2 DVNs only)
  const byName = {}
  for (const net of netKeys) {
    const entry = reg[net]
    if (!entry?.dvns) throw new Error(`registry has no "${net}" entry`)
    for (const [addr, v] of Object.entries(entry.dvns)) {
      if (v.deprecated || v.lzReadCompatible || v.version !== 2) continue
      ;(byName[v.canonicalName] ??= {})[net] = ethers.getAddress(addr)
    }
  }
  const everywhere = Object.keys(byName).filter((n) => netKeys.every((k) => byName[n][k])).sort()

  const providers = Object.fromEntries(
    netKeys.map((k) => [k, new ethers.JsonRpcProvider(nets[k].rpc, nets[k].chainId, { staticNetwork: true })]),
  )
  const pathways = []
  for (const k of netKeys) {
    if (k === HUB) continue
    pathways.push([k, HUB], [HUB, k])
  }

  // LayerZero's default config per pathway (what an unconfigured OApp rides)
  const nameOf = (net, addr) =>
    Object.entries(byName).find(([, m]) => m[net]?.toLowerCase() === addr.toLowerCase())?.[0] ??
    reg[net].dvns[addr.toLowerCase()]?.canonicalName ??
    addr
  const defaults = {}
  for (const [a, b] of pathways) {
    const ep = new ethers.Contract(profile.endpoint, EP_ABI, providers[a])
    const lib = await ep.getSendLibrary(SENDER, nets[b].eid)
    const cfg = await new ethers.Contract(lib, ULN_ABI, providers[a]).getUlnConfig(SENDER, nets[b].eid)
    defaults[`${a}>${b}`] = {
      confirmations: Number(cfg.confirmations),
      required: [...cfg.requiredDVNs].map((d) => nameOf(a, d)),
      optional: [...cfg.optionalDVNs].map((d) => nameOf(a, d)),
      threshold: Number(cfg.optionalDVNThreshold),
    }
  }

  // every candidate's own quote, per pathway
  const rows = []
  for (const name of everywhere) {
    const fees = {}
    let usable = true
    await Promise.all(
      pathways.map(async ([a, b]) => {
        try {
          const dvn = new ethers.Contract(byName[name][a], DVN_ABI, providers[a])
          fees[`${a}>${b}`] = await dvn.getFee(nets[b].eid, defaults[`${a}>${b}`].confirmations, SENDER, '0x')
        } catch {
          fees[`${a}>${b}`] = null
          usable = false
        }
      }),
    )
    rows.push({ name, fees, usable })
  }

  const short = (k) => k.replace('optimism', 'op').replace('arbitrum', 'arb').replace('ethereum', 'eth')
  const cols = pathways.map(([a, b]) => `${a}>${b}`)
  console.log(`LayerZero DVN survey — ${new Date().toISOString()} — fees in ETH, sender ${SENDER}\n`)
  console.log('DEFAULT CONFIG PER PATHWAY (what an unconfigured adapter rides):')
  for (const c of cols) {
    const d = defaults[c]
    console.log(
      `  ${short(c).padEnd(10)} confirmations ${String(d.confirmations).padEnd(3)} required: ${d.required.join(' + ')}` +
        (d.optional.length ? ` | optional ${d.threshold}-of: ${d.optional.join(', ')}` : ''),
    )
  }
  console.log(`\nDVNs LIVE ON ALL OF ${netKeys.join(', ')} (${everywhere.length}):`)
  console.log(['DVN'.padEnd(40), ...cols.map((c) => short(c).padStart(11)), 'usable'].join(' '))
  const sum = (r) => cols.reduce((a, c) => a + (r.fees[c] ?? 0n), 0n)
  rows.sort((x, y) => (x.usable === y.usable ? (sum(x) < sum(y) ? -1 : 1) : x.usable ? -1 : 1))
  for (const r of rows) {
    console.log(
      [
        r.name.padEnd(40),
        ...cols.map((c) => (r.fees[c] === null ? 'FAIL' : Number(ethers.formatEther(r.fees[c])).toFixed(8)).padStart(11)),
        r.usable ? 'yes' : 'NO',
      ].join(' '),
    )
  }

  // the configured set, held against the registry: every address must be
  // the registry's address for that name on that chain, and must have quoted
  if (profile.dvn) {
    console.log('\nCONFIGURED SET (config/profiles.js → mainnet.dvn) vs the registry:')
    let bad = 0
    for (const name of [...profile.dvn.required, ...(profile.dvn.optional ?? [])]) {
      const row = rows.find((r) => r.name === name)
      for (const net of netKeys) {
        const mine = profile.dvn.addresses[name]?.[net]
        const theirs = byName[name]?.[net]
        const ok = mine && theirs && mine.toLowerCase() === theirs.toLowerCase() && row?.usable
        if (!ok) bad += 1
        console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(16)} ${net.padEnd(9)} ${mine ?? '(missing)'}${ok ? '' : ` — registry: ${theirs ?? 'not listed'}${row?.usable ? '' : ', not quotable everywhere'}`}`)
      }
    }
    if (bad) {
      console.error(`\n${bad} configured DVN address(es) do not match the registry — fix config/profiles.js`)
      process.exitCode = 1
    }
  }

  const emitAt = process.argv.indexOf('--emit')
  if (emitAt > 0) {
    const names = process.argv[emitAt + 1].split(',').map((s) => s.trim())
    const out = {}
    for (const n of names) {
      const row = rows.find((r) => r.name === n)
      if (!row) throw new Error(`"${n}" is not live on every chain`)
      if (!row.usable) throw new Error(`"${n}" could not be fee-quoted on every pathway`)
      out[n] = byName[n]
    }
    console.log('\naddresses block for config/profiles.js (from the registry, checksummed):')
    console.log(JSON.stringify(out, null, 2))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
