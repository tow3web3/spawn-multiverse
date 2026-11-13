/**
 * Pulls this chain's holder fees home when enough is waiting on the hub.
 * See scripts/lib-ops.js → keeperPull for why a keeper matters.
 *
 *   npx hardhat run scripts/keeper-pull.js --network optimism              # lists what it would pull
 *   SPAWN_APPLY=1 npx hardhat run scripts/keeper-pull.js --network optimism   # pulls (the signer pays each round trip)
 *   SPAWN_PULL_THRESHOLD_USD=10 …                                          # default 25
 *
 * Anyone can run it with any funded key — a pull only ever moves a chain's
 * own slice into that chain's holder pool. Run it from cron on each remote
 * chain. On mainnet, sending also needs SPAWN_MAINNET_CONFIRM.
 */
const { ethers, network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { keeperPull } = require('./lib-ops')
const { MAINNET_CONFIRM, isDevNode } = require('./lib-net')

async function main() {
  const profile = getProfile(network.name)
  const [signer] = await ethers.getSigners()
  const dev = await isDevNode(signer.provider)
  const confirmed = !profile.mainnet || dev || process.env.SPAWN_MAINNET_CONFIRM === MAINNET_CONFIRM
  await keeperPull({
    profile,
    netKey: netKeyOf(network.name),
    signer,
    apply: process.env.SPAWN_APPLY === '1' && confirmed,
    thresholdUsd: process.env.SPAWN_PULL_THRESHOLD_USD ? Number(process.env.SPAWN_PULL_THRESHOLD_USD) : undefined,
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
