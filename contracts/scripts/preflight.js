/**
 * READ-ONLY: runs the deploy preflight on every network of the mainnet
 * universe, over each chain's RPC — the same checks `deploy.js` makes before
 * it will send anything (scripts/lib-net.js → preflight):
 *   chain id · LayerZero endpoint.eid() · that chain's dollar: symbol /
 *   decimals · USDC chains: USDC.isMinter(CCTP minter) + CCTP domain · BNB
 *   Chain: USDT supply sanity bound, and no CCTP plumbing on its vault ·
 *   deployer balance vs budget
 * and, for the verifier set of every pathway (hub ↔ each spoke, both
 * directions): each configured DVN's own `getFee` on the source chain must
 * answer — a DVN that will not quote a pathway would make every send on it
 * revert (`configure-dvn.js` refuses it too).
 *
 *   npx hardhat run scripts/preflight.js
 *   SPAWN_DEPLOYER=0x… …                    # another deployer address
 *
 * Exit code 1 if an address check or a DVN quote fails; an unfunded deployer
 * alone is reported, not fatal (exit 0) — it is the one thing expected
 * before funding.
 */
const { ethers } = require('hardhat')
const { PROFILES, activeNets, dvnSetFor } = require('../config/profiles')
const { preflight } = require('./lib-net')

const DEPLOYER = process.env.SPAWN_DEPLOYER ?? '0x483E931A279B136A2C3fCA6BF5eC2c4239c1B904'
const DVN_ABI = ['function getFee(uint32,uint64,address,bytes) view returns (uint256)']
// any address works as the quoting sender; a DVN with an allowlist fails here
const SENDER = '0x000000000000000000000000000000000000dEaD'

async function main() {
  const name = process.env.SPAWN_PROFILE ?? 'mainnet'
  const profile = PROFILES[name]
  if (!profile || !profile.mainnet) throw new Error(`SPAWN_PROFILE must be the mainnet universe, got "${name}"`)
  let bad = 0
  let unfunded = 0
  const nets = activeNets(profile)
  const providers = {}
  for (const [netKey, cfg] of Object.entries(nets)) {
    const provider = new ethers.JsonRpcProvider(cfg.rpc, undefined, { staticNetwork: false })
    providers[netKey] = provider
    const res = await preflight({
      profile, netKey, cfg, state: {}, log: console.log,
      signer: { provider, address: ethers.getAddress(DEPLOYER) },
    })
    for (const f of res.failed) {
      if (f.what.startsWith('deployer balance')) unfunded += 1
      else bad += 1
    }
    console.log('')
  }

  if (profile.dvn) {
    console.log('verifier set — every DVN must quote every pathway, from its source chain')
    for (const [spoke, c] of Object.entries(nets)) {
      if (c.role !== 'spoke') continue
      for (const [src, dst] of [[profile.hub, spoke], [spoke, profile.hub]]) {
        const set = dvnSetFor(profile, src, dst)
        const cells = []
        for (const dvnName of [...set.required, ...set.optional]) {
          const addr = profile.dvn.addresses[dvnName]?.[src]
          let ok = false
          let fee
          try {
            if (!addr || ethers.getAddress(addr) !== addr) throw new Error('bad or non-checksummed address')
            fee = await new ethers.Contract(addr, DVN_ABI, providers[src]).getFee(nets[dst].eid, BigInt(nets[src].confirmations), SENDER, '0x')
            ok = true
          } catch {
            /* refused, or no such contract */
          }
          if (!ok) bad += 1
          cells.push(`${ok ? '✓' : '✗'} ${dvnName} ${ok ? ethers.formatEther(fee) : `(${addr ?? 'no address'}) does not quote`}`)
        }
        console.log(`  ${src} -> ${dst}: ${cells.join(' · ')}`)
      }
    }
    console.log('')
  }

  if (bad) {
    console.error(`✗ ${bad} check(s) FAILED — do not deploy`)
    process.exit(1)
  }
  console.log(`✓ every external address re-derived from the live chains${unfunded ? ` — deployer not funded yet on ${unfunded} network(s)` : ''}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
