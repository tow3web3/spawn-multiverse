/**
 * One screen of protocol health, read-only, over every network's RPC.
 * See scripts/lib-ops.js → status.
 *
 *   SPAWN_PROFILE=mainnet npx hardhat run scripts/status.js
 *   SPAWN_PROFILE=testnet npx hardhat run scripts/status.js
 *   SPAWN_INFLIGHT_USDC=500 …    # a CCTP rebalance of 500 USDC is in flight
 *   SPAWN_STRICT=1 …             # warnings also fail (exit 3)
 *
 * Exit code 1 when the GLOBAL BACKING check fails (vault USDC does not cover
 * oUSD supply): that is the alarm to pause on. Wire it to cron + alerting.
 */
const { getProfile } = require('../config/profiles')
const { status } = require('./lib-ops')

async function main() {
  const profile = getProfile()
  const res = await status({
    profile,
    inflightUsdc: process.env.SPAWN_INFLIGHT_USDC ? Number(process.env.SPAWN_INFLIGHT_USDC) : 0,
  })
  if (!res.deployed) process.exit(2)
  if (!res.ok) process.exit(1)
  if (process.env.SPAWN_STRICT === '1' && res.warnings.length) process.exit(3)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
