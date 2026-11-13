/**
 * Sends a token's SYNC to a chain again (operator; the hub tank pays).
 * See scripts/lib-ops.js → resync.
 *
 * Since v7.1 a SYNC that cannot be sent at spawn no longer undoes the launch:
 * the pad logs `SyncFailed` and the token is born WITHOUT a replica on that
 * chain. `status.js` lists those ("TOKENS WITHOUT A REPLICA"); this repairs
 * them once the leg works again — and backfills tokens launched before a
 * chain was wired.
 *
 *   # what would be sent, and what it costs the hub tank (nothing is sent)
 *   SPAWN_TOKEN=missing npx hardhat run scripts/resync.js --network base
 *   # every missing (token, chain) pair
 *   SPAWN_APPLY=1 SPAWN_TOKEN=missing npx hardhat run scripts/resync.js --network base
 *   # one token to one chain
 *   SPAWN_APPLY=1 SPAWN_TOKEN=0x… SPAWN_CHAIN=optimism npx hardhat run scripts/resync.js --network base
 *
 * Always run on the HUB network. On mainnet, sending also needs
 * SPAWN_MAINNET_CONFIRM. Without the operator key the calldata is printed.
 */
const { network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { resync } = require('./lib-ops')
const { MAINNET_CONFIRM, isDevNode, cliSigner } = require('./lib-net')

async function main() {
  const profile = getProfile(network.name)
  const signer = await cliSigner()
  const dev = await isDevNode(signer.provider)
  const confirmed = !profile.mainnet || dev || process.env.SPAWN_MAINNET_CONFIRM === MAINNET_CONFIRM
  if (process.env.SPAWN_APPLY === '1' && !confirmed) console.log('(mainnet: SPAWN_MAINNET_CONFIRM is not set — showing only)')
  if (!process.env.SPAWN_TOKEN) throw new Error('SPAWN_TOKEN=<token address | missing> is required')
  const out = await resync({
    profile,
    netKey: netKeyOf(network.name),
    signer,
    token: process.env.SPAWN_TOKEN,
    chain: process.env.SPAWN_CHAIN || undefined,
    apply: process.env.SPAWN_APPLY === '1' && confirmed,
  })
  const sent = out.filter((o) => o.sent).length
  console.log(`✓ resync: ${sent} sent, ${out.length - sent} not sent`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
