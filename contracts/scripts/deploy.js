/**
 * Deploys / resumes / re-wires SPAWN! on one network of a profile.
 *
 *   # testnets (MockUSDC, sponsored gateways) — same as deploy-testnet.js
 *   npx hardhat run scripts/deploy.js --network baseSepolia        # hub
 *   npx hardhat run scripts/deploy.js --network optimismSepolia    # spoke
 *   npx hardhat run scripts/deploy.js --network baseSepolia        # again: wires the spokes
 *   (then once more on each spoke when the set of spokes changed: it
 *    refreshes how many SYNC replies a spawn prepays)
 *
 *   # mainnet — DRY by default: preflight + plan, zero transactions
 *   npx hardhat run scripts/deploy.js --network base
 *   # the real thing (see docs/RUNBOOK.md — do not improvise)
 *   SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY \
 *     npx hardhat run scripts/deploy.js --network base
 *
 * The profile is inferred from the network name (config/profiles.js);
 * SPAWN_PROFILE forces it. SPAWN_DRY=1 makes any run a dry run.
 * Everything else — what is deployed, the preflight, the wiring order, the
 * self-check — lives in scripts/lib-net.js.
 */
const { ethers, network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { deployNet } = require('./lib-net')

async function main() {
  const net = netKeyOf(network.name)
  const profile = getProfile(network.name)
  if (!profile.nets[net]) {
    throw new Error(
      `network "${net}" is not part of the ${profile.name} profile ` +
        `(${Object.keys(profile.nets).join(', ')})`,
    )
  }
  const [signer] = await ethers.getSigners()
  if (!signer) throw new Error('no deployer key: DEPLOYER_PK (or MAINNET_DEPLOYER_PK) missing in contracts/.env')
  await deployNet({ profile, netKey: net, signer })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
