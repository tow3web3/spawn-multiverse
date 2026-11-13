/**
 * Sets this network's vault deposit cap (operator). The cap is the ceiling
 * on the USDC a vault may hold — the guarded launch's exposure dial.
 *
 *   SPAWN_CAP_USDC=25000 npx hardhat run scripts/set-cap.js --network base   # shows current vs wanted
 *   SPAWN_APPLY=1 SPAWN_CAP_USDC=25000 npx hardhat run scripts/set-cap.js --network base
 *
 * 0 closes the vault to new deposits (exits stay open). On mainnet, sending
 * also needs SPAWN_MAINNET_CONFIRM. Without the operator key the calldata is
 * printed for whoever holds it.
 */
const { ethers, network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { loadState, same, isDevNode, MAINNET_CONFIRM } = require('./lib-net')

async function main() {
  const profile = getProfile(network.name)
  const netKey = netKeyOf(network.name)
  const cfg = profile.nets[netKey]
  if (!cfg) throw new Error(`${netKey} is not a network of the ${profile.name} profile`)
  if (process.env.SPAWN_CAP_USDC === undefined || !/^\d+$/.test(process.env.SPAWN_CAP_USDC)) {
    throw new Error('SPAWN_CAP_USDC=<whole USDC> is required')
  }
  const want = BigInt(process.env.SPAWN_CAP_USDC) * 10n ** 6n
  const [signer] = await ethers.getSigners()
  const state = loadState(profile.stateFile)[netKey]
  const vaultAddr = cfg.role === 'hub' ? state?.localUsd : state?.usd
  if (!vaultAddr) throw new Error(`${netKey}: no vault deployed in ${profile.stateFile}`)
  const vault = await ethers.getContractAt('OmniUSD', vaultAddr, signer)

  const [cap, held, operator, admin] = await Promise.all([vault.depositCap(), vault.liquidity(), vault.operator(), vault.admin()])
  const usdc = (v) => ethers.formatUnits(v, 6)
  console.log(`set-cap — ${profile.name}/${netKey} — vault ${vaultAddr}`)
  console.log(`  holds ${usdc(held)} USDC · cap ${usdc(cap)} → wanted ${usdc(want)}`)
  if (cap === want) return console.log('  ✓ already set')

  const mine = same(operator, signer.address) || same(admin, signer.address)
  const live = !(await isDevNode(signer.provider))
  const confirmed = !profile.mainnet || !live || process.env.SPAWN_MAINNET_CONFIRM === MAINNET_CONFIRM
  if (process.env.SPAWN_APPLY !== '1' || !confirmed || !mine) {
    if (!mine) console.log(`  the operator is ${operator} — not this key. Calldata for it:`)
    else if (!confirmed) console.log('  (mainnet: SPAWN_MAINNET_CONFIRM is not set — showing only)')
    else console.log('  (SPAWN_APPLY=1 to send)')
    console.log(`    target ${vaultAddr}\n    data   ${vault.interface.encodeFunctionData('setDepositCap', [want])}`)
    return
  }
  await (await vault.setDepositCap(want)).wait()
  const now = await vault.depositCap()
  if (now !== want) throw new Error(`cap reads back ${usdc(now)}, wanted ${usdc(want)}`)
  console.log(`  setDepositCap(${usdc(want)} USDC) ✓`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
