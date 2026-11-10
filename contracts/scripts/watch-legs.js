/**
 * Leg watcher: polls the deployer balance on the not-yet-deployed testnet
 * legs (Ethereum Sepolia, BNB Testnet). The moment faucet money lands on
 * one, it deploys that spoke, rewires the hub, tops up the visitor gas
 * drip, rebuilds the site and pushes it live. Exits when every leg is
 * live, or after 24h.
 *
 *   node scripts/watch-legs.js
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { ethers } = require('ethers')

const ROOT = path.join(__dirname, '..', '..')
const CONTRACTS = path.join(__dirname, '..')
const FILE = path.join(CONTRACTS, 'deployments', 'testnet.json')
const DEPLOYER = '0x483E931A279B136A2C3fCA6BF5eC2c4239c1B904'
const LEGS = [
  { net: 'ethereumSepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', min: '0.002', unit: 'ETH' },
  { net: 'bnbTestnet', rpc: 'https://bsc-testnet-rpc.publicnode.com', min: '0.005', unit: 'tBNB' },
]

const sh = (cmd, cwd = CONTRACTS) => {
  console.log(`\n$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd })
}
const live = (net) => {
  try {
    return !!JSON.parse(fs.readFileSync(FILE, 'utf8'))[net]?.gateway
  } catch {
    return false
  }
}

async function main() {
  const t0 = Date.now()
  while (Date.now() - t0 < 24 * 3600_000) {
    let deployed = false
    for (const leg of LEGS) {
      if (live(leg.net)) continue
      const bal = await new ethers.JsonRpcProvider(leg.rpc).getBalance(DEPLOYER).catch(() => 0n)
      console.log(`${new Date().toISOString()} ${leg.net}: ${ethers.formatEther(bal)} ${leg.unit}`)
      if (bal < ethers.parseEther(leg.min)) continue
      console.log(`💰 fuel detected on ${leg.net} — deploying the leg`)
      try {
        sh(`npx hardhat run scripts/deploy-testnet.js --network ${leg.net}`)
        deployed = true
      } catch (e) {
        console.error(`deploy failed on ${leg.net} — will retry next tick:`, String(e).slice(0, 200))
      }
    }
    if (deployed) {
      // wire hub -> new spoke(s), fund the visitor drip, ship the site
      sh('npx hardhat run scripts/deploy-testnet.js --network baseSepolia')
      sh('node scripts/fund-drip.js')
      sh('VITE_PUBLIC_DEMO=1 npm run build', ROOT)
      sh('npx netlify deploy --prod --no-build', ROOT)
      console.log('LEG_CASCADE_DONE')
    }
    if (LEGS.every((l) => live(l.net))) return console.log('ALL_LEGS_LIVE')
    await new Promise((r) => setTimeout(r, 300_000))
  }
  console.log('WATCH_TIMEOUT after 24h')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
