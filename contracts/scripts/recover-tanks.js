/**
 * Drains the gas tanks of RETIRED adapters of this network back to the
 * deployer. Every adapter since v5 exposes `recover(address payable)` to its
 * admin; older ones do not and are skipped.
 *
 *   npx hardhat run scripts/recover-tanks.js --network baseSepolia
 *     — every ARCHIVED entry of the profile's state file whose key starts
 *       with this network's name (`baseSepolia_v70_pre71`, …), never the live one
 *
 *   SPAWN_STATE_FILE=deployments/mainnet-v7_0.retired.json SPAWN_RETIRED=1 \
 *     npx hardhat run scripts/recover-tanks.js --network base
 *     — a RETIRED deployment: its plain entries (`base`, `optimism`, …) too
 *
 * SPAWN_DRY=1 only lists what it would recover. On mainnet a send needs
 * SPAWN_MAINNET_CONFIRM. When the adapter's admin is a timelock (a
 * handed-over deployment), this key cannot recover: the OWNER must schedule
 * `recover(to)` on that timelock, wait its delay, then execute — both
 * calldatas are printed, ready to paste, with the delay.
 */
const { ethers, network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { loadState, isDevNode, MAINNET_CONFIRM, cliSigner } = require('./lib-net')

const ABI = ['function recover(address payable to)', 'function admin() view returns (address)']
const TIMELOCK_ABI = [
  'function getMinDelay() view returns (uint256)',
  'function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)',
  'function execute(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) payable',
  'function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) view returns (bytes32)',
  'function isOperationPending(bytes32) view returns (bool)',
  'function isOperationReady(bytes32) view returns (bool)',
  'function isOperationDone(bytes32) view returns (bool)',
]

async function main() {
  const profile = getProfile(network.name)
  const NET = netKeyOf(network.name)
  const signer = await cliSigner()
  const dry = process.env.SPAWN_DRY === '1'
  const live = profile.mainnet && !(await isDevNode(ethers.provider))
  if (live && !dry && process.env.SPAWN_MAINNET_CONFIRM !== MAINNET_CONFIRM) {
    console.log('mainnet: listing only (SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY sends)')
  }
  const canSend = !dry && (!live || process.env.SPAWN_MAINNET_CONFIRM === MAINNET_CONFIRM)
  const to = ethers.getAddress(process.env.SPAWN_RECOVER_TO ?? signer.address)
  const all = loadState(profile.stateFile)
  const liveAdapter = process.env.SPAWN_RETIRED === '1' ? null : all[NET]?.adapter?.toLowerCase()
  const seen = new Set()
  let total = 0n
  let waiting = 0n
  console.log(`recover-tanks — ${profile.name}/${NET} — ${profile.stateFile} — to ${to}`)
  for (const [key, entry] of Object.entries(all)) {
    const archived = key.startsWith(`${NET}_`)
    const retired = process.env.SPAWN_RETIRED === '1' && key === NET
    if ((!archived && !retired) || !entry?.adapter) continue
    const addr = entry.adapter
    if (seen.has(addr.toLowerCase()) || addr.toLowerCase() === liveAdapter) continue
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
    const data = adapter.interface.encodeFunctionData('recover', [to])
    if (admin && admin.toLowerCase() === signer.address.toLowerCase()) {
      if (!canSend) {
        console.log(`${key}: ${addr} — would recover ${ethers.formatEther(bal)}`)
        total += bal
        continue
      }
      try {
        await (await adapter.recover(to)).wait()
        console.log(`${key}: ${addr} — recovered ${ethers.formatEther(bal)} ✓`)
        total += bal
      } catch (e) {
        console.log(`${key}: ${addr} holds ${ethers.formatEther(bal)} — no recover() on this version (${e.shortMessage ?? e.message})`)
      }
      continue
    }
    // a handed-over adapter: the recorded timelock is the admin — OWNER's job
    if (admin && entry.timelock && admin.toLowerCase() === entry.timelock.toLowerCase()) {
      const tl = new ethers.Contract(entry.timelock, TIMELOCK_ABI, ethers.provider)
      const delay = await tl.getMinDelay()
      const salt = ethers.id(`spawn/recover-tank/${addr.toLowerCase()}/${to.toLowerCase()}`)
      const id = await tl.hashOperation(addr, 0, data, ethers.ZeroHash, salt)
      const state = (await tl.isOperationDone(id))
        ? 'done'
        : (await tl.isOperationReady(id))
          ? 'READY — execute now'
          : (await tl.isOperationPending(id))
            ? 'scheduled — inside its delay'
            : 'not scheduled'
      console.log(`${key}: ${addr} holds ${ethers.formatEther(bal)} — admin is the timelock ${entry.timelock} (${state})`)
      console.log(`   OWNER schedules (then waits ${Number(delay) / 3600}h), on ${entry.timelock}:`)
      console.log(`     data ${tl.interface.encodeFunctionData('schedule', [addr, 0, data, ethers.ZeroHash, salt, delay])}`)
      console.log('   OWNER executes, same contract:')
      console.log(`     data ${tl.interface.encodeFunctionData('execute', [addr, 0, data, ethers.ZeroHash, salt])}`)
      waiting += bal
      continue
    }
    console.log(`${key}: ${addr} holds ${ethers.formatEther(bal)} — not recoverable by this key (admin ${admin ?? 'unknown'})`)
  }
  console.log(`${canSend ? 'recovered' : 'recoverable'}: ${ethers.formatEther(total)} on ${NET}${waiting ? ` · ${ethers.formatEther(waiting)} behind a timelock (calldata above)` : ''}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
