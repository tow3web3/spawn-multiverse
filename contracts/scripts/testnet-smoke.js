/**
 * First real cross-chain smoke test, over live LayerZero V2 testnets.
 * Run on a SPOKE network once it is deployed and wired:
 *
 *   npx hardhat run scripts/testnet-smoke.js --network optimismSepolia
 *
 * It spawns a token from this spoke, waits for LayerZero to land OP_SPAWN
 * on the Base Sepolia hub and for the replica to sync back, then exercises
 * the v7 real-money paths end to end with (mock) USDC:
 *   - `buyTokenUsdc` for $260 inside the FAIR GENESIS window — the $250 cap
 *     clamps it, and the $10 REFUND leg must come home as USDC;
 *   - sells half the bag — the PAYOUT leg must come home as USDC.
 * Expect minutes, not seconds.
 */
const fs = require('fs')
const path = require('path')
const { ethers, network } = require('hardhat')

const FILE = path.join(__dirname, '..', 'deployments', 'testnet.json')
const HUB_RPC = 'https://sepolia.base.org'
const E = (n) => ethers.parseEther(String(n))
const U = (n) => ethers.parseUnits(String(n), 6)
const SCALE = 10n ** 12n // one USDC unit in oUSD wei
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(what, fn, tries = 90, everyMs = 10_000) {
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
  if (!spoke.usdc) throw new Error(`${network.name} is a pre-v7 deployment (no USDC vault) — redeploy v7 first`)

  const [dev] = await ethers.getSigners()
  const usd = await ethers.getContractAt('OmniUSD', spoke.usd)
  const usdc = await ethers.getContractAt('MockUSDC', spoke.usdc)
  const gw = await ethers.getContractAt('SpawnGateway', spoke.gateway)
  const hubProvider = new ethers.JsonRpcProvider(HUB_RPC)
  const padAbi = (await ethers.getContractFactory('SpawnPad')).interface
  const pad = new ethers.Contract(hub.pad, padAbi, hubProvider)

  // sanity: both adapters need fee money for LayerZero
  const hubTank = await hubProvider.getBalance(hub.adapter)
  const spokeTank = await ethers.provider.getBalance(spoke.adapter)
  console.log(`gas tanks — hub: ${ethers.formatEther(hubTank)} ETH, ${network.name}: ${ethers.formatEther(spokeTank)} ETH`)
  if (hubTank === 0n || spokeTank === 0n) throw new Error('a gas tank is empty — fund the adapters first (deploy-testnet tops them up)')

  // v7: money is (mock) USDC paid straight into this chain's vault
  if ((await usdc.balanceOf(dev.address)) < U(300)) {
    await (await usdc.mint(dev.address, U(1_000))).wait()
    console.log('✓ mock USDC minted')
  }
  if ((await usdc.allowance(dev.address, spoke.usd)) < U(1_000)) {
    await (await usdc.approve(spoke.usd, ethers.MaxUint256)).wait()
    console.log('✓ vault approved for USDC')
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

  console.log('buying $260 of USDC cross-chain (FAIR GENESIS caps a wallet at $250)…')
  const usdcBefore = await usdc.balanceOf(dev.address)
  await (await gw.buyTokenUsdc(token, U(260))).wait()
  const repC = await ethers.getContractAt('SpawnToken', rep)
  const bal = await waitFor('token delivery', async () => {
    const b = await repC.balanceOf(dev.address)
    return b > 0n ? b : undefined
  })
  console.log(`✓ delivered: ${ethers.formatEther(bal)} OMNI on ${network.name}`)

  // refund leg: tokens and refund ride the same OP_DELIVER, so it is in
  const spent = usdcBefore - (await usdc.balanceOf(dev.address))
  const capped = (await pad.genesisSpent(token, ethers.zeroPadValue(dev.address, 32))) === E(250)
  if (capped) {
    if (spent !== U(250)) {
      throw new Error(`refund leg did not come home as USDC: net spend ${ethers.formatUnits(spent, 6)}, expected 250`)
    }
    console.log('✓ FAIR GENESIS clamp refunded $10 — as USDC, straight from the vault')
  } else {
    if (spent !== U(260)) {
      throw new Error(`unexpected net spend ${ethers.formatUnits(spent, 6)} (window closed, expected 260)`)
    }
    console.log('(the genesis window had already closed on the hub — no refund leg this run)')
  }

  console.log('selling half the bag…')
  const usdcMid = await usdc.balanceOf(dev.address)
  const claimBefore = await usd.balanceOf(dev.address)
  await (await gw.sellToken(token, bal / 2n)).wait()
  const back = await waitFor('USDC payout', async () => {
    const b = await usdc.balanceOf(dev.address)
    return b > usdcMid ? b - usdcMid : undefined
  })
  console.log(`✓ payout arrived as USDC: $${ethers.formatUnits(back, 6)}`)
  // only sub-USDC dust may have been minted as oUSD; a real oUSD claim here
  // would mean the vault was short
  if ((await usd.balanceOf(dev.address)) - claimBefore >= SCALE) {
    throw new Error('payout fell back to an oUSD claim — the vault should be liquid')
  }

  console.log('hub spot price:', ethers.formatEther(await pad.spotPrice(token)))
  console.log('🎉 CROSS-CHAIN SPAWN + USDC BUY + USDC PAYOUT OVER LIVE LAYERZERO — DONE')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
