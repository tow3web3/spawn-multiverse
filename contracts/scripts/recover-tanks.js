/**
 * Drains the gas tanks of ARCHIVED adapters of this network back to the
 * deployer. Every adapter since v5 exposes `recover(address payable)` to its
 * admin; older ones do not and are skipped.
 *
 *   npx hardhat run scripts/recover-tanks.js --network baseSepolia
 *
 * It looks at every archived entry of the state file whose key starts with
 * this network's name (`baseSepolia_v6_pre7`, `baseSepolia_v5_prefair`, …),
 * never at the live entry. SPAWN_DRY=1 only lists what it would recover.
 */
const { ethers, network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { loadState } = require('./lib-net')

const ABI = ['function recover(address payable to)', 'function admin() view returns (address)']

async function main() {
  const profile = getProfile(network.name)
  const NET = netKeyOf(network.name)
  const [signer] = await ethers.getSigners()
  const all = loadState(profile.stateFile)
  const live = all[NET]?.adapter?.toLowerCase()
  const seen = new Set()
  let total = 0n
  for (const [key, entry] of Object.entries(all)) {
    if (!key.startsWith(`${NET}_`) || !entry?.adapter) continue
    const addr = entry.adapter
    if (seen.has(addr.toLowerCase()) || addr.toLowerCase() === live) continue
    seen.add(addr.toLowerCase())
    const bal = await ethers.provider.getBalance(addr)
    if (bal === 0n) {
      console.log(`${key}: ${addr} — empty`)
      continue
    }
    const adapter = new ethers.Contract(addr, ABI, signer)
    let admin
    try {
      admin = await adapter.admin()
    } catch {
      admin = null
    }
    if (!admin || admin.toLowerCase() !== signer.address.toLowerCase()) {
      console.log(`${key}: ${addr} holds ${ethers.formatEther(bal)} — not recoverable by this key (admin ${admin ?? 'unknown'})`)
      continue
    }
    if (process.env.SPAWN_DRY === '1') {
      console.log(`${key}: ${addr} — would recover ${ethers.formatEther(bal)}`)
      total += bal
      continue
    }
    try {
      await (await adapter.recover(signer.address)).wait()
      console.log(`${key}: ${addr} — recovered ${ethers.formatEther(bal)} ✓`)
      total += bal
    } catch (e) {
      console.log(`${key}: ${addr} holds ${ethers.formatEther(bal)} — no recover() on this version (${e.shortMessage ?? e.message})`)
    }
  }
  console.log(`${process.env.SPAWN_DRY === '1' ? 'recoverable' : 'recovered'}: ${ethers.formatEther(total)} on ${NET}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
