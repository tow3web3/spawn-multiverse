/**
 * READ-ONLY: what deploying THE universe costs its deployer at today's gas
 * prices, per network — the life-cycle gas measured on mainnet forks
 * (LIFE_GAS in scripts/lib-net.js: deploy + wiring, verifier set, hand-over),
 * plus the L1 data fee a rollup's fork cannot show (OP-stack GasPriceOracle /
 * Arbitrum ArbGasInfo), plus the hub's gas-tank float where there is one.
 * On an L1 (Ethereum, BNB Chain) the gas term is the whole story, so it is
 * also shown at a few other gas prices — and so is what a user pays there.
 *
 *   npx hardhat run scripts/estimate-budget.js     # Base, Optimism, Arbitrum, Ethereum (ETH), BNB Chain (BNB)
 *
 * Gas figures: re-measure after any contract change (npm run rehearse
 * prints what the forks used).
 */
const { ethers, artifacts } = require('hardhat')
const { PROFILES, activeNets } = require('../config/profiles')
const { deployBudget, vaultName, nativeOf } = require('./lib-net')

const TXS = { hub: 70, spoke: 50 } // wiring / config / hand-over calls, ~200 bytes each
const OP_ORACLE = '0x420000000000000000000000000000000000000F'
const ARB_GAS_INFO = '0x000000000000000000000000000000000000006C'

async function main() {
  const name = process.env.SPAWN_PROFILE ?? 'mainnet'
  const profile = PROFILES[name]
  if (!profile?.mainnet) throw new Error(`SPAWN_PROFILE must be the mainnet universe, got "${name}"`)
  const nets = activeNets(profile)
  console.log(`${profile.name} universe — deploy budget — ${new Date().toISOString()} — ${Object.keys(nets).join(', ')}\n`)
  const totals = {}
  for (const [net, c] of Object.entries(nets)) {
    const coin = nativeOf(profile, net)
    const vault = vaultName(profile, net)
    const CONTRACTS = {
      hub: ['LayerZeroOmniMessenger', 'OmniUSD', vault, 'SpawnPad', 'InternalCurveVenue', 'SpawnGateway', 'FeeDistributor', 'SpawnTimelock'],
      spoke: ['LayerZeroOmniMessenger', vault, 'SpawnGateway', 'FeeDistributor', 'SpawnTimelock'],
    }
    const provider = new ethers.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true })
    const role = c.role
    const b = await deployBudget({ profile, cfg: c, signer: { provider } })
    const exec = b.gas * b.gasPrice
    let bytes = TXS[role] * 200
    for (const n of CONTRACTS[role]) bytes += ((await artifacts.readArtifact(n)).bytecode.length - 2) / 2
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
    const tank = profile.tank?.mode === 'fixed' ? (profile.tank[role] ?? 0n) : 0n
    const estimate = exec + l1 + tank
    // 3x on what moves with gas prices; the tank float is a fixed amount
    const padded = (exec + l1) * 3n + tank
    const fund = padded > b.floor ? padded : b.floor
    totals[coin] = (totals[coin] ?? 0n) + fund
    console.log(`${net} (${role})`)
    console.log(`  gas price ${ethers.formatUnits(b.gasPrice, 'gwei')} gwei × ${b.gas} gas = ${ethers.formatEther(exec)} ${coin}`)
    console.log(`  L1 data for ~${bytes} bytes: ${ethers.formatEther(l1)} ${coin} (${l1How})`)
    if (tank) console.log(`  gas-tank float: ${ethers.formatEther(tank)} ${coin}`)
    else console.log('  gas tank: none needed (users pay each send in full)')
    console.log(
      `  estimate ${ethers.formatEther(estimate)} ${coin} → fund the deployer with ${ethers.formatEther(fund)} ${coin} ` +
        `(3x on gas, preflight floor ${ethers.formatEther(b.floor)})`,
    )
    if (!c.opStack && c.chainId !== 42161) {
      // an L1: the same deploy at other gas prices, and what a user pays
      const rows = [1n, 5n, 30n].map((g) => `${g} gwei → ${ethers.formatEther(b.gas * g * 10n ** 9n * 2n)} ${coin}`)
      console.log(`  the same deploy (×2 margin) at ${rows.join(', ')}`)
    }
    console.log('')
  }
  console.log(`total across networks: ${Object.entries(totals).map(([c, v]) => `${ethers.formatEther(v)} ${c}`).join(' + ')}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
