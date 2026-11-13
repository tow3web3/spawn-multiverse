/**
 * Sets (or verifies) the LayerZero verifier set of this network's adapter —
 * see scripts/lib-dvn.js for what is configured and why.
 *
 *   npx hardhat run scripts/configure-dvn.js --network base       # hub: every spoke pathway
 *   npx hardhat run scripts/configure-dvn.js --network optimism   # spoke: its hub pathway
 *   SPAWN_VERIFY=1 npx hardhat run scripts/configure-dvn.js --network base
 *       # read-only, CROSS-CHAIN: both ends of every pathway must name the
 *       # same set (exit code 1 otherwise). Run it after configuring every
 *       # network and before opening deposits.
 *
 * On mainnet it is DRY unless SPAWN_MAINNET_CONFIRM is set, like the deploy.
 * The set lives in config/profiles.js (mainnet.dvn); `node
 * scripts/dvn-survey.js` prints the fee table it was chosen from. After the
 * hand-over the delegate is the timelock: the calldata is printed instead.
 */
const { ethers, network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { configureDvn, verifyDvn } = require('./lib-dvn')
const { MAINNET_CONFIRM, isDevNode, cliSigner } = require('./lib-net')

async function main() {
  const profile = getProfile(network.name)
  if (!profile.dvn) throw new Error(`the ${profile.name} profile rides LayerZero's default DVN set — nothing to configure`)
  if (process.env.SPAWN_VERIFY === '1') {
    console.log(`DVN cross-chain verification — ${profile.name}`)
    const res = await verifyDvn({ profile })
    if (!res.rows.length) console.log('  (no deployed pathway to verify yet)')
    if (!res.ok) throw new Error('DVN configuration is NOT consistent — do not open deposits')
    console.log('  ✓ every pathway: both ends name the configured verifier set')
    return
  }
  const signer = await cliSigner()
  const dev = await isDevNode(signer.provider)
  const dry = process.env.SPAWN_DRY === '1' || (profile.mainnet && !dev && process.env.SPAWN_MAINNET_CONFIRM !== MAINNET_CONFIRM)
  const res = await configureDvn({ profile, netKey: netKeyOf(network.name), signer, dry })
  if (res.blocked.length) console.log(`⏳ ${res.blocked.length} call(s) to schedule through the timelock (target + data above)`)
  if (!dry && !res.blocked.length) console.log(`✓ ${netKeyOf(network.name)}: verifier set configured and read back (${res.txs} tx(s))`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
