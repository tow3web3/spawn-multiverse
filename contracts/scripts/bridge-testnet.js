/**
 * Splits the deployer's Sepolia L1 ETH to the three L2 testnets through the
 * OFFICIAL native bridges — addresses verified against each chain's docs:
 *
 *   OP Sepolia   L1StandardBridge 0xFBb0621E0B23b5478B630BD55a5f21f67730B0F1 (superchain-registry)
 *   Base Sepolia L1StandardBridge 0xfd0Bf71F60660E2f608ed56e1659C450eB113120 (docs.base.org)
 *   Arb Sepolia  Delayed Inbox    0xaAe29B0366299461418F5324a79Afc425BE5ae21 (docs.arbitrum.io)
 *
 * OP-stack bridges credit a plain ETH transfer from an EOA to the same
 * address on L2; Arbitrum needs Inbox.depositEth(). Before moving anything
 * the script checks each target has code AND answers its expected view call.
 *
 *   node scripts/bridge-testnet.js            # bridge (keeps an L1 gas buffer)
 *   node scripts/bridge-testnet.js --check    # verify targets only, move nothing
 */
const fs = require('fs')
const path = require('path')
const { ethers } = require('ethers')

const L1_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
const L2 = [
  { name: 'Optimism Sepolia', rpc: 'https://sepolia.optimism.io', bridge: '0xFBb0621E0B23b5478B630BD55a5f21f67730B0F1', kind: 'opstack' },
  { name: 'Base Sepolia    ', rpc: 'https://sepolia.base.org', bridge: '0xfd0Bf71F60660E2f608ed56e1659C450eB113120', kind: 'opstack' },
  { name: 'Arbitrum Sepolia', rpc: 'https://sepolia-rollup.arbitrum.io/rpc', bridge: '0xaAe29B0366299461418F5324a79Afc425BE5ae21', kind: 'arbitrum' },
]
const OPSTACK_ABI = [
  'function MESSENGER() view returns (address)',
  'function depositETH(uint32 minGasLimit, bytes extraData) payable',
]
const INBOX_ABI = ['function bridge() view returns (address)', 'function depositEth() payable returns (uint256)']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function deployerKey() {
  const m = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').match(/DEPLOYER_PK=(0x[0-9a-fA-F]{64})/)
  if (!m) throw new Error('DEPLOYER_PK missing in contracts/.env')
  return m[1]
}

async function main() {
  const checkOnly = process.argv.includes('--check')
  const l1 = new ethers.JsonRpcProvider(L1_RPC)
  const wallet = new ethers.Wallet(deployerKey(), l1)
  console.log('deployer:', wallet.address)

  // 1. safety: every bridge target must have code and answer its view call
  for (const t of L2) {
    const code = await l1.getCode(t.bridge)
    if (code === '0x') throw new Error(`${t.name}: NO CODE at ${t.bridge} — refusing to send`)
    if (t.kind === 'opstack') {
      const msgr = await new ethers.Contract(t.bridge, OPSTACK_ABI, l1).MESSENGER()
      console.log(`✓ ${t.name} L1StandardBridge ok (messenger ${msgr.slice(0, 10)}…)`)
    } else {
      const br = await new ethers.Contract(t.bridge, INBOX_ABI, l1).bridge()
      console.log(`✓ ${t.name} Inbox ok (bridge ${br.slice(0, 10)}…)`)
    }
  }
  if (checkOnly) return console.log('check-only mode — nothing sent')

  // 2. split the balance, keeping an L1 gas buffer
  const bal = await l1.getBalance(wallet.address)
  console.log('L1 balance:', ethers.formatEther(bal), 'ETH')
  const fee = await l1.getFeeData()
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits('10', 'gwei')
  const buffer = gasPrice * 300_000n * 3n * 2n // 3 txs, 2x margin
  if (bal <= buffer + ethers.parseEther('0.015')) {
    throw new Error(`balance too low to split usefully (buffer ${ethers.formatEther(buffer)})`)
  }
  const share = (bal - buffer) / 3n
  console.log(`bridging ${ethers.formatEther(share)} ETH to each L2 (gas buffer ${ethers.formatEther(buffer)})`)

  const l2Before = []
  for (const t of L2) l2Before.push(await new ethers.JsonRpcProvider(t.rpc).getBalance(wallet.address))

  // Each leg stands alone: a congested portal must not block the others.
  const sent = []
  for (const t of L2) {
    try {
      let tx
      if (t.kind === 'opstack') {
        const bridge = new ethers.Contract(t.bridge, OPSTACK_ABI, wallet)
        // OP-stack portals meter deposits: under load the required burn
        // explodes, so size the limit from a live estimate.
        const est = await bridge.depositETH.estimateGas(200_000, '0x', { value: share })
        const gasLimit = (est * 3n) / 2n
        console.log(`  ${t.name}: estimateGas ${est} → limit ${gasLimit}`)
        tx = await bridge.depositETH(200_000, '0x', { value: share, gasLimit })
      } else {
        const inbox = new ethers.Contract(t.bridge, INBOX_ABI, wallet)
        tx = await inbox.depositEth({ value: share })
      }
      console.log(`→ ${t.name}: L1 tx ${tx.hash}`)
      await tx.wait()
      sent.push(t)
    } catch (e) {
      console.log(`✗ ${t.name}: deposit failed — ${String(e?.shortMessage ?? e).slice(0, 120)}`)
    }
  }
  if (sent.length === 0) throw new Error('no deposit went through')
  console.log(`${sent.length}/3 deposits confirmed — waiting for L2 credit (minutes)…`)

  // 3. wait for the funds to land on each successfully-deposited L2
  for (const t of sent) {
    const i = L2.indexOf(t)
    const p = new ethers.JsonRpcProvider(t.rpc)
    let credited = false
    for (let k = 0; k < 90; k++) {
      const b = await p.getBalance(wallet.address).catch(() => null)
      if (b !== null && b > l2Before[i]) {
        console.log(`✓ ${t.name}: ${ethers.formatEther(b)} ETH on L2`)
        credited = true
        break
      }
      await sleep(20_000)
    }
    if (!credited) console.log(`✗ ${t.name}: not credited after 30 min — check the deposit tx manually`)
  }
  console.log('BRIDGE_DONE')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
