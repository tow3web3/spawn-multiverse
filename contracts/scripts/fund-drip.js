/**
 * Tops up the gas-drip wallet (the Netlify function that wets visitors'
 * burners) from the deployer, on every user-facing testnet — Base Sepolia
 * included since v7 made the hub chain a trading chain. Run after bridging:
 *
 *   node scripts/fund-drip.js
 */
const fs = require('fs')
const path = require('path')
const { ethers } = require('ethers')

const SPOKES = [
  { name: 'Base Sepolia    ', rpc: 'https://sepolia.base.org' },
  { name: 'Optimism Sepolia', rpc: 'https://sepolia.optimism.io' },
  { name: 'Arbitrum Sepolia', rpc: 'https://sepolia-rollup.arbitrum.io/rpc' },
  { name: 'Ethereum Sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
  { name: 'BNB Testnet     ', rpc: 'https://bsc-testnet-rpc.publicnode.com' },
]

function keyFrom(file, name) {
  const m = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').match(new RegExp(`${name}=(0x[0-9a-fA-F]{64})`))
  if (!m) throw new Error(`${name} missing in contracts/${file}`)
  return m[1]
}

async function main() {
  const deployerPk = keyFrom('.env', 'DEPLOYER_PK')
  const dripAddr = new ethers.Wallet(keyFrom('.env.drip', 'DRIP_PK')).address
  console.log('drip wallet:', dripAddr)

  for (const s of SPOKES) {
    const provider = new ethers.JsonRpcProvider(s.rpc)
    const wallet = new ethers.Wallet(deployerPk, provider)
    const bal = await provider.getBalance(wallet.address)
    const dripBal = await provider.getBalance(dripAddr)
    if (dripBal >= ethers.parseEther('0.003')) {
      console.log(`${s.name}: drip already funded (${ethers.formatEther(dripBal)})`)
      continue
    }
    // a quarter of what the deployer holds, capped — enough for ~15 visitors
    let amount = bal / 4n
    const cap = ethers.parseEther('0.008')
    if (amount > cap) amount = cap
    if (amount < ethers.parseEther('0.001')) {
      console.log(`${s.name}: deployer too poor to fund the drip (${ethers.formatEther(bal)})`)
      continue
    }
    const tx = await wallet.sendTransaction({ to: dripAddr, value: amount })
    await tx.wait()
    console.log(`${s.name}: drip +${ethers.formatEther(amount)} ETH (${tx.hash})`)
  }
  console.log('FUND_DRIP_DONE')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
