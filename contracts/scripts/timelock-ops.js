/**
 * Admin steps through this network's timelock (after the hand-over) — see
 * scripts/lib-timelock.js.
 *
 *   npx hardhat run scripts/timelock-ops.js --network base                      # list
 *   SPAWN_OPS=schedule npx hardhat run scripts/timelock-ops.js --network base   # schedule what is pending
 *   SPAWN_OPS=execute  npx hardhat run scripts/timelock-ops.js --network base   # execute what is ready
 *   SPAWN_OPS=cancel SPAWN_OP_ID=0x… npx hardhat run scripts/timelock-ops.js --network base   # the veto
 *
 * schedule / execute are signed by OWNER (contracts/.env.owner); cancel by
 * the guardian (the deployer hot key) — OWNER may cancel too
 * (SPAWN_CANCEL_AS=owner). SPAWN_TOPUP=1 lets the deployer send OWNER the
 * gas it lacks. On mainnet everything is DRY unless SPAWN_MAINNET_CONFIRM is
 * set. Exit code 3 from `execute` = an operation is still inside its delay.
 */
const { ethers, network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { scheduleOps, executeOps, listOps, cancelOp, actors } = require('./lib-timelock')

async function main() {
  const profile = getProfile(network.name)
  const netKey = netKeyOf(network.name)
  const mode = process.env.SPAWN_OPS ?? 'list'
  if (mode === 'list') return void (await listOps({ profile, netKey, provider: ethers.provider }))
  const { deployer, owner } = await actors(profile, netKey)
  if (!owner) throw new Error(`${netKey}: no hand-over recorded — nothing here answers to a timelock`)
  const topUp = process.env.SPAWN_TOPUP === '1'
  if (mode === 'schedule') {
    await scheduleOps({ profile, netKey, owner, deployer, topUp })
  } else if (mode === 'execute') {
    const res = await executeOps({ profile, netKey, owner, deployer, topUp })
    if (res.waiting.length) process.exitCode = 3
  } else if (mode === 'cancel') {
    if (!process.env.SPAWN_OP_ID) throw new Error('SPAWN_OP_ID=0x… is required')
    const signer = process.env.SPAWN_CANCEL_AS === 'owner' ? owner : deployer
    await cancelOp({ profile, netKey, signer, id: process.env.SPAWN_OP_ID })
  } else {
    throw new Error(`unknown SPAWN_OPS "${mode}" (list | schedule | execute | cancel)`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
