/**
 * The hub side of Solana (label 1) — one network, the HUB. See
 * scripts/lib-solana.js for what it sends and why; scripts/add-solana.sh is
 * the wrapper (it also re-prices every chain afterwards).
 *
 *   SOLANA_STORE=… SOLANA_PEER=… npx hardhat run scripts/add-solana.js --network baseSepolia   # the plan, nothing sent
 *   … SPAWN_SEND=1 …                                                                           # send it
 *
 * Inputs (env):
 *   SOLANA_STORE    the gateway's OApp store — 32-byte hex or base58 (the pad's gateway 1)
 *   SOLANA_PEER     what the hub adapter believes for the Solana eid (usually the store)
 *   SOLANA_VAULT    optional: the gateway's USDC vault, named as a CCTP peer of the
 *                   hub chain's vault — FOREVER (the other USDC chains: their own runs)
 *   SOLANA_PREPAYS  optional: what the Solana side prepays — a JSON file or inline JSON
 *                   { returnUnit (hub wei), tradeLegs, openLegs, spawnLegs, moveLegs: {label: legs} };
 *                   without it the tooling reads them through the gateway's client
 *                   (solana/app, needs solana/node_modules) and says when it cannot
 *   SPAWN_SEND=1    send (default: print the plan); on mainnet also SPAWN_MAINNET_CONFIRM
 *   SPAWN_TOPUP=1   the timelock path: the deployer gives OWNER the gas it lacks
 *
 * DIRECT when the signer is the hub's admin and the LayerZero delegate;
 * otherwise the operator steps are sent and the rest is ONE timelock batch,
 * scheduled by OWNER (contracts/.env.owner; impersonated on a fork) — then
 * `SPAWN_OPS=execute npx hardhat run scripts/timelock-ops.js --network <hub>`
 * after the delay (add-solana.sh does it on its next run).
 * After the wiring it prints what the SOLANA side should prepay (for
 * solana/scripts/wire.ts), from the hub's live quotes.
 */
const fs = require('fs')
const { ethers, network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { cliSigner, loadState } = require('./lib-net')
const { actors } = require('./lib-timelock')
const { runSolana, solanaSidePrices } = require('./lib-solana')

function prepaysInput() {
  const v = process.env.SOLANA_PREPAYS
  if (!v) return undefined
  const text = fs.existsSync(v) ? fs.readFileSync(v, 'utf8') : v
  const p = JSON.parse(text)
  for (const k of ['returnUnit', 'openLegs']) if (p[k] === undefined) throw new Error(`SOLANA_PREPAYS needs ${k}`)
  return { ...p, returnUnit: String(p.returnUnit) }
}

async function main() {
  const profile = getProfile(network.name)
  const netKey = netKeyOf(network.name)
  const signer = await cliSigner()
  let owner
  const hub = loadState(profile.stateFile)[profile.hub]
  if (hub?.handover) {
    try {
      ;({ owner } = await actors(profile, netKey))
    } catch (e) {
      // the plan needs no OWNER; sending the timelock batch does
      if (process.env.SPAWN_SEND === '1') throw e
    }
  }
  const res = await runSolana({
    profile,
    netKey,
    signer,
    owner,
    ids: { store: process.env.SOLANA_STORE, peer: process.env.SOLANA_PEER ?? process.env.SOLANA_STORE, vault: process.env.SOLANA_VAULT || undefined },
    prepays: prepaysInput(),
    send: process.env.SPAWN_SEND === '1',
    topUp: process.env.SPAWN_TOPUP === '1',
  })
  if (res.wired) {
    console.log('  ✓ Solana is wired on the hub (pad.gateways(1) is set)')
    const all = loadState(profile.stateFile)
    try {
      const p = await solanaSidePrices({ profile, all, signer })
      console.log('\nwhat the SOLANA side should prepay (solana/scripts/wire.ts: set_fee_config, set_open_legs, set_move_legs), from the hub\'s live quotes + 25%:')
      console.log(`  return_unit ${p.returnUnit} wei (${ethers.formatEther(p.returnUnit)} ETH) — the hub's DELIVER toward Solana ${ethers.formatEther(p.quotes.deliver)} ETH`)
      console.log(`  open_legs ${p.openLegs} — the worst SYNC toward Solana, its lamports included: ${ethers.formatEther(p.quotes.sync)} ETH`)
      console.log(`  spawn_legs ${p.spawnLegs} — the SYNCs a launch from Solana sends (${Object.keys(p.spawnSyncs).join(', ')}, and Solana's own)`)
      console.log(`  move_legs ${JSON.stringify(p.moveLegs)} (label → legs; under LayerZero's 0.05 ETH cap per message from Solana)`)
    } catch (e) {
      console.log(`  (the Solana side's prices could not be computed: ${e.shortMessage ?? e.message})`)
    }
  } else if (res.mode === 'timelock' && res.id) {
    console.log(`  ⏳ the batch ${res.id} must be executed after its delay — then run this again`)
    process.exitCode = 3
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
