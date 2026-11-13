/**
 * Closes or opens this network's ENTRY: its gateway's pause switch.
 *
 *   SPAWN_GATE=pause   npx hardhat run scripts/gate.js --network ethereum   # guardian (or operator)
 *   SPAWN_GATE=unpause npx hardhat run scripts/gate.js --network ethereum   # operator
 *   npx hardhat run scripts/gate.js --network ethereum                      # shows the state
 *
 * A paused gateway takes no new buy and no new spawn; sells, claims, pulls
 * and unwraps stay open, and messages from the hub are still handled. A
 * spoke that joins a live deployment is kept paused for the timelock delay:
 * until the hub has wired it, anything a user sent from it would be a
 * message the hub rejects. On mainnet, sending needs SPAWN_MAINNET_CONFIRM.
 */
const { ethers, network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { loadState, hasRole, isDevNode, MAINNET_CONFIRM, cliSigner } = require('./lib-net')

async function main() {
  const profile = getProfile(network.name)
  const netKey = netKeyOf(network.name)
  const want = process.env.SPAWN_GATE
  const state = loadState(profile.stateFile)[netKey]
  if (!state?.gateway) throw new Error(`${netKey}: no gateway deployed in ${profile.stateFile}`)
  const signer = await cliSigner()
  const gateway = await ethers.getContractAt('SpawnGateway', state.gateway, signer)
  const paused = await gateway.paused()
  console.log(`gate — ${profile.name}/${netKey} — gateway ${state.gateway} is ${paused ? 'PAUSED' : 'open'}`)
  if (!want) return
  if (want !== 'pause' && want !== 'unpause') throw new Error('SPAWN_GATE must be pause or unpause')
  if (paused === (want === 'pause')) return console.log(`  ✓ already ${paused ? 'paused' : 'open'}`)
  const live = !(await isDevNode(signer.provider))
  if (profile.mainnet && live && process.env.SPAWN_MAINNET_CONFIRM !== MAINNET_CONFIRM) {
    return console.log(`  would: gateway.${want}() (mainnet: SPAWN_MAINNET_CONFIRM is not set)`)
  }
  const role = want === 'pause' ? 'guardian' : 'operator'
  if (!(await hasRole(gateway, role, signer.address))) {
    console.log(`  ⏳ needs the ${role}: target ${state.gateway} data ${gateway.interface.encodeFunctionData(want)}`)
    process.exitCode = 1
    return
  }
  await (await gateway[want]()).wait()
  // a lagging node may still serve the old flag: wait until the change is visible
  for (let i = 0; i < 60; i++) {
    if ((await gateway.paused()) === (want === 'pause')) return console.log(`  gateway.${want}() ✓`)
    if (live) await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`gateway.${want}() was mined but is not visible on this RPC yet — run it again`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
