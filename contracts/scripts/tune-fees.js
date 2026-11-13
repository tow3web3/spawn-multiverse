/**
 * Re-prices the reply budget of this network from live LayerZero quotes
 * (operator). See scripts/lib-ops.js → tuneFees.
 *
 *   npx hardhat run scripts/tune-fees.js --network optimism             # shows current vs target
 *   SPAWN_APPLY=1 npx hardhat run scripts/tune-fees.js --network optimism   # sets it
 *   SPAWN_FEE_MARGIN=40 …                                               # margin over the live quote, % (default 25)
 *
 * Run it on every network right after configure-dvn.js (the quotes drop
 * ~5x), and whenever status.js shows the hub tank shrinking. After the
 * hand-over the operator is OWNER: without that key the calldata is printed
 * for the Safe. On mainnet, sending also needs SPAWN_MAINNET_CONFIRM.
 */
const { ethers, network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { tuneFees } = require('./lib-ops')
const { MAINNET_CONFIRM, isDevNode } = require('./lib-net')

async function main() {
  const profile = getProfile(network.name)
  const [signer] = await ethers.getSigners()
  const dev = await isDevNode(signer.provider)
  const confirmed = !profile.mainnet || dev || process.env.SPAWN_MAINNET_CONFIRM === MAINNET_CONFIRM
  if (process.env.SPAWN_APPLY === '1' && !confirmed) console.log('(mainnet: SPAWN_MAINNET_CONFIRM is not set — showing only)')
  await tuneFees({
    profile,
    netKey: netKeyOf(network.name),
    signer,
    apply: process.env.SPAWN_APPLY === '1' && confirmed,
    marginPct: process.env.SPAWN_FEE_MARGIN ? Number(process.env.SPAWN_FEE_MARGIN) : undefined,
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
