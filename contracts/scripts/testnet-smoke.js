/**
 * First real cross-chain smoke test, over live LayerZero V2 testnets.
 * Run on a SPOKE network once it is deployed and wired:
 *
 *   npx hardhat run scripts/testnet-smoke.js --network optimismSepolia
 *
 * It spawns a token from this spoke, waits for LayerZero to land OP_SPAWN
 * on the Base Sepolia hub, waits for the replica to sync back, then buys $5
 * cross-chain and waits for delivery. Expect minutes, not seconds.
 */
const fs = require('fs')
const path = require('path')
const { ethers, network } = require('hardhat')

const FILE = path.join(__dirname, '..', 'deployments', 'testnet.json')
const HUB_RPC = 'https://sepolia.base.org'
const E = (n) => ethers.parseEther(String(n))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(what, fn, tries = 36, everyMs = 10_000) {
  for (let i = 0; i < tries; i++) {
    const v = await fn().catch(() => undefined)
    if (v) return v
    if (i % 6 === 0) console.log(`  … waiting for ${what} (${(i * everyMs) / 1000}s)`)
    await sleep(everyMs)
  }
  throw new Error(`${what} not observed after ${(tries * everyMs) / 60000} min — check gas tanks and LayerZero scan`)
}

async function main() {
  const all = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const spoke = all[network.name]
  const hub = all.baseSepolia
  if (!spoke?.gateway) throw new Error(`spoke not deployed on ${network.name}`)
  if (!hub?.pad) throw new Error('hub not deployed on baseSepolia')

  const [dev] = await ethers.getSigners()
  const usd = await ethers.getContractAt('OmniUSD', spoke.usd)
  const gw = await ethers.getContractAt('SpawnGateway', spoke.gateway)
  const hubProvider = new ethers.JsonRpcProvider(HUB_RPC)
  const padAbi = (await ethers.getContractFactory('SpawnPad')).interface
  const pad = new ethers.Contract(hub.pad, padAbi, hubProvider)

  // sanity: both adapters need fee money for LayerZero
  const hubTank = await hubProvider.getBalance(hub.adapter)
  const spokeTank = await ethers.provider.getBalance(spoke.adapter)
  console.log(`gas tanks — hub: ${ethers.formatEther(hubTank)} ETH, ${network.name}: ${ethers.formatEther(spokeTank)} ETH`)
  if (hubTank === 0n || spokeTank === 0n) throw new Error('a gas tank is empty — fund the adapters first (deploy-testnet tops them up)')

  if ((await usd.balanceOf(dev.address)) < E(50)) {
    await (await usd.faucet(dev.address, E(100))).wait()
    console.log('✓ oUSD faucet')
  }

  const before = await pad.tokensLength()
  console.log(`spawning OMNI TEST ($OMNI) from ${network.name}…`)
  await (await gw.spawnToken('OMNI TEST', 'OMNI', '{"smoke":true}', 0, 1)).wait()

  const token = await waitFor('OP_SPAWN on the hub', async () => {
    const len = await pad.tokensLength()
    return len > before ? await pad.allTokens(len - 1n) : undefined
  })
  console.log('✓ token live on the hub:', token)

  const rep = await waitFor(`replica on ${network.name}`, async () => {
    const r = await gw.replicaOf(token)
    return r !== ethers.ZeroAddress ? r : undefined
  })
  console.log('✓ replica deployed:', rep)

  console.log('buying $5 cross-chain…')
  await (await gw.buyToken(token, E(5))).wait()
  const repC = await ethers.getContractAt('SpawnToken', rep)
  const bal = await waitFor('token delivery', async () => {
    const b = await repC.balanceOf(dev.address)
    return b > 0n ? b : undefined
  })
  console.log(`✓ delivered: ${ethers.formatEther(bal)} OMNI on ${network.name}`)
  console.log('hub spot price:', ethers.formatEther(await pad.spotPrice(token)))
  console.log('🎉 FIRST CROSS-CHAIN SPAWN + TRADE OVER LIVE LAYERZERO — DONE')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
