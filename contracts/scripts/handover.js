/**
 * Hands the admin of every contract on this network to a TimelockController
 * owned by OWNER — see scripts/lib-handover.js for the exact steps.
 *
 *   SPAWN_OWNER=0x<Safe> SPAWN_GUARDIAN=0x<hot key> \
 *     npx hardhat run scripts/handover.js --network base
 *   (then the same on every other network — each chain has its own timelock)
 *
 * On mainnet it is DRY unless SPAWN_MAINNET_CONFIRM is set. An EOA owner is
 * allowed but warned about loudly. SPAWN_TIMELOCK_DELAY overrides the 48h.
 * SPAWN_OPERATOR names a day-to-day operator other than OWNER (e.g. the hot
 * ops key that runs tune-fees.js / keeper-pull.js); default: OWNER.
 */
const { ethers, network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { handover } = require('./lib-handover')

async function main() {
  const profile = getProfile(network.name)
  const [signer] = await ethers.getSigners()
  if (!signer) throw new Error('no deployer key in contracts/.env')
  await handover({
    profile,
    netKey: netKeyOf(network.name),
    signer,
    owner: process.env.SPAWN_OWNER,
    operator: process.env.SPAWN_OPERATOR || undefined,
    guardian: process.env.SPAWN_GUARDIAN,
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
