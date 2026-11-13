/**
 * READ-ONLY: runs the deploy preflight on every network of the mainnet
 * profile, over each chain's RPC — the same checks `deploy.js` makes before
 * it will send anything (scripts/lib-net.js → preflight):
 *   chain id · LayerZero endpoint.eid() · USDC symbol / decimals ·
 *   USDC.isMinter(CCTP minter) · CCTP domain · deployer balance vs budget
 *
 *   npx hardhat run scripts/preflight.js                 # the launch chains
 *   SPAWN_ENABLE=ethereum npx hardhat run scripts/preflight.js
 *   SPAWN_DEPLOYER=0x… …                                 # another deployer address
 *
 * Exit code 1 if an address check fails; an unfunded deployer alone is
 * reported, not fatal (exit 0) — it is the one thing expected before funding.
 */
const { ethers } = require('hardhat')
const { PROFILES, activeNets } = require('../config/profiles')
const { preflight } = require('./lib-net')

const DEPLOYER = process.env.SPAWN_DEPLOYER ?? '0x483E931A279B136A2C3fCA6BF5eC2c4239c1B904'

async function main() {
  const profile = PROFILES.mainnet
  let bad = 0
  let unfunded = 0
  for (const [netKey, cfg] of Object.entries(activeNets(profile))) {
    const provider = new ethers.JsonRpcProvider(cfg.rpc, undefined, { staticNetwork: false })
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
  if (bad) {
    console.error(`✗ ${bad} address check(s) FAILED — do not deploy`)
    process.exit(1)
  }
  console.log(`✓ every external address re-derived from the live chains${unfunded ? ` — deployer not funded yet on ${unfunded} network(s)` : ''}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
