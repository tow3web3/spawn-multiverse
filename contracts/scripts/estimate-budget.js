/**
 * READ-ONLY: what a mainnet deployment costs the deployer at today's gas
 * prices, per network — execution gas measured on mainnet forks, plus the
 * L1 data fee the fork cannot show (OP-stack GasPriceOracle / Arbitrum
 * ArbGasInfo), plus the hub's gas-tank float.
 *
 *   SPAWN_PROFILE=mainnet npx hardhat run scripts/estimate-budget.js
 *
 * Gas measured 2026-11-13 by test-fork/ (deploy + wiring, configure-dvn,
 * handover.js); re-measure after any contract change.
 */
const { ethers, artifacts } = require('hardhat')
const { PROFILES, activeNets } = require('../config/profiles')

// execution gas, from the fork suites (rounded up)
const GAS = {
  hub: { deploy: 17_700_000n, dvnPerPathway: 570_000n, handover: 2_600_000n },
  spoke: { deploy: 9_200_000n, dvnPerPathway: 570_000n, handover: 2_300_000n },
}
const CONTRACTS = {
  hub: ['LayerZeroOmniMessenger', 'OmniUSD', 'OmniUSD', 'SpawnPad', 'InternalCurveVenue', 'SpawnGateway', 'FeeDistributor', 'SpawnTimelock'],
  spoke: ['LayerZeroOmniMessenger', 'OmniUSD', 'SpawnGateway', 'FeeDistributor', 'SpawnTimelock'],
}
const TXS = { hub: 70, spoke: 50 } // wiring / config / hand-over calls, ~200 bytes each

const OP_ORACLE = '0x420000000000000000000000000000000000000F'
const ARB_GAS_INFO = '0x000000000000000000000000000000000000006C'

async function main() {
  const profile = PROFILES.mainnet
  const nets = activeNets(profile)
  const spokes = Object.values(nets).filter((c) => c.role === 'spoke').length
  console.log(`mainnet deploy budget — ${new Date().toISOString()} — ${Object.keys(nets).join(', ')}\n`)
  let total = 0n
  for (const [net, c] of Object.entries(nets)) {
    const provider = new ethers.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true })
    const role = c.role
    const pathways = role === 'hub' ? BigInt(spokes) : 1n
    const gas = GAS[role].deploy + GAS[role].dvnPerPathway * pathways + GAS[role].handover
    const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n
    const exec = gas * gasPrice
    let bytes = TXS[role] * 200
    for (const name of CONTRACTS[role]) bytes += ((await artifacts.readArtifact(name)).bytecode.length - 2) / 2
    let l1 = 0n
    let l1How = 'none (L1)'
    try {
      if (c.opStack) {
        const oracle = new ethers.Contract(OP_ORACLE, ['function getL1FeeUpperBound(uint256) view returns (uint256)'], provider)
        l1 = await oracle.getL1FeeUpperBound(bytes)
        l1How = 'GasPriceOracle.getL1FeeUpperBound'
      } else if (c.chainId === 42161) {
        const info = new ethers.Contract(ARB_GAS_INFO, ['function getPricesInWei() view returns (uint256,uint256,uint256,uint256,uint256,uint256)'], provider)
        l1 = (await info.getPricesInWei())[1] * BigInt(bytes)
        l1How = 'ArbGasInfo per-L1-calldata-byte'
      }
    } catch (e) {
      l1How = `unavailable (${e.shortMessage ?? e.message})`
    }
    const tank = profile.tank[role] ?? 0n
    const estimate = exec + l1 + tank
    const floor = c.budget ?? profile.budget[role]
    // 3x on what moves with gas prices; the tank float is a fixed amount
    const padded = (exec + l1) * 3n + tank
    const fund = padded > floor ? padded : floor
    total += fund
    console.log(`${net} (${role})`)
    console.log(`  gas price ${ethers.formatUnits(gasPrice, 'gwei')} gwei × ${gas} gas = ${ethers.formatEther(exec)} ETH`)
    console.log(`  L1 data for ~${bytes} bytes: ${ethers.formatEther(l1)} ETH (${l1How})`)
    console.log(`  gas-tank float: ${ethers.formatEther(tank)} ETH`)
    console.log(`  estimate ${ethers.formatEther(estimate)} ETH → fund the deployer with ${ethers.formatEther(fund)} ETH (3x on gas, preflight floor ${ethers.formatEther(floor)})\n`)
  }
  console.log(`total across networks: ${ethers.formatEther(total)} ETH`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
