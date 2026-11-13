/**
 * Sets this network's vault deposit cap (operator). The cap is the ceiling
 * on the dollars a vault may hold — the guarded launch's exposure dial.
 * SPAWN_CAP_USDC is in WHOLE units of the universe's dollar (USDC in the
 * core and Ethereum universes, USDT in the BNB universe): it is scaled by
 * the token's own decimals (scripts/lib-ops.js → setCap).
 *
 *   SPAWN_CAP_USDC=25000 npx hardhat run scripts/set-cap.js --network base   # shows current vs wanted
 *   SPAWN_APPLY=1 SPAWN_CAP_USDC=25000 npx hardhat run scripts/set-cap.js --network base
 *   SPAWN_PROFILE=bnb SPAWN_APPLY=1 SPAWN_CAP_USDC=25000 npx hardhat run scripts/set-cap.js --network bnb
 *
 * 0 closes the vault to new deposits (exits stay open). On mainnet, sending
 * also needs SPAWN_MAINNET_CONFIRM. Without the operator key the calldata is
 * printed for whoever holds it.
 */
const { network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { isDevNode, MAINNET_CONFIRM, cliSigner } = require('./lib-net')
const { setCap } = require('./lib-ops')

async function main() {
  const profile = getProfile(network.name)
  if (process.env.SPAWN_CAP_USDC === undefined || !/^\d+$/.test(process.env.SPAWN_CAP_USDC)) {
    throw new Error('SPAWN_CAP_USDC=<whole dollars> is required')
  }
  const signer = await cliSigner()
  const live = !(await isDevNode(signer.provider))
  const confirmed = !profile.mainnet || !live || process.env.SPAWN_MAINNET_CONFIRM === MAINNET_CONFIRM
  if (process.env.SPAWN_APPLY === '1' && !confirmed) console.log('(mainnet: SPAWN_MAINNET_CONFIRM is not set — showing only)')
  await setCap({
    profile,
    netKey: netKeyOf(network.name),
    signer,
    wholeDollars: process.env.SPAWN_CAP_USDC,
    apply: process.env.SPAWN_APPLY === '1' && confirmed,
    live,
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
