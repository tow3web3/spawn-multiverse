/**
 * Deploys the SPAWN! multiverse to the local node, seeds the demo creatures
 * with real trades, and writes the deployment manifest where the frontend
 * can fetch it (public/onchain/deployment.json).
 *
 *   npx hardhat node                 # terminal 1
 *   npm run deploy:local             # terminal 2
 */
const fs = require('fs')
const path = require('path')
const { ethers } = require('hardhat')
const { deployWorld, CHAINS } = require('./lib-deploy')

const E = (n) => ethers.parseEther(String(n))
const rand = (lo, hi) => lo + Math.random() * (hi - lo)
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

async function main() {
  const signers = await ethers.getSigners()
  const traders = signers.slice(5, 13)

  console.log('Deploying the multiverse…')
  const world = await deployWorld()
  console.log('  messenger :', world.messenger.target)
  console.log('  pad (hub) :', world.pad.target)
  for (const c of world.chains) console.log(`  ${c.id.padEnd(9)}: gateway ${c.gateway.target}`)

  // Fund the trading crowd on every chain.
  for (const c of world.chains) {
    for (const t of traders) await (await c.usd.faucet(t.address, E(50_000))).wait()
  }

  const replicaCache = new Map() // `${chainId}:${token}` -> contract

  async function replica(chain, token) {
    const key = `${chain.id}:${token}`
    if (!replicaCache.has(key)) {
      replicaCache.set(key, await ethers.getContractAt('SpawnToken', await chain.gateway.replicaOf(token)))
    }
    return replicaCache.get(key)
  }

  async function buy(token, usd) {
    const chain = pick(world.chains)
    const trader = pick(traders)
    await (await chain.gateway.connect(trader).buyToken(token, E(usd.toFixed(2)))).wait()
  }

  async function sellSome(token) {
    // find a trader with a bag somewhere and sell a slice of it
    for (let i = 0; i < 6; i++) {
      const chain = pick(world.chains)
      const trader = pick(traders)
      const rep = await replica(chain, token)
      const bal = await rep.balanceOf(trader.address)
      if (bal > E(1000)) {
        const slice = (bal * BigInt(Math.floor(rand(10, 60)))) / 100n
        await (await chain.gateway.connect(trader).sellToken(token, slice)).wait()
        return
      }
    }
  }

  async function spawnSeed(def) {
    const chain = pick(world.chains)
    const creator = pick(traders)
    const metaURI = JSON.stringify({ face: def.face })
    await (await chain.gateway.connect(creator).spawnToken(def.name, def.sym, metaURI, 0, def.mode ?? 0)).wait()
    const token = await world.pad.allTokens((await world.pad.tokensLength()) - 1n)
    console.log(`  spawned ${def.sym.padEnd(6)} ${token}`)

    // hop the FAIR GENESIS window (v6) so the pit seeds at steady-state fees
    await ethers.provider.send('evm_increaseTime', [601])
    await ethers.provider.send('evm_mine', [])

    for (let i = 0; i < def.buys; i++) {
      await buy(token, rand(...def.size))
      if (def.sellEvery && i > 3 && i % def.sellEvery === 0) await sellSome(token)
    }
    if (def.whale) await buy(token, def.whale)
    for (let i = 0; i < (def.poolBuys ?? 0); i++) await buy(token, rand(100, 900))
    for (let i = 0; i < (def.dumps ?? 0); i++) await sellSome(token)
    return token
  }

  console.log('Seeding the pit with real trades…')
  const seeds = [
    { name: 'GLOOP SUPREME', sym: 'GLOOP', mode: 0, face: 'frog', buys: 36, size: [60, 600], sellEvery: 7 },
    // ROT gets whale-pumped through ascension, then trades on the omnipool
    { name: 'BRAINROT 3000', sym: 'ROT', mode: 3, face: 'brain', buys: 24, size: [200, 900], sellEvery: 9, whale: 16_000, poolBuys: 8 },
    { name: 'SIR BORKS', sym: 'BORK', mode: 1, face: 'bork', buys: 22, size: [50, 450], sellEvery: 6 },
    { name: 'COSMIC PICKLE', sym: 'PICKL', mode: 2, face: 'pickle', buys: 10, size: [30, 250], sellEvery: 5 },
    // MOCHI pumps then takes a beating
    { name: 'MOCHI MAYHEM', sym: 'MOCHI', mode: 0, face: 'mochi', buys: 18, size: [60, 400], dumps: 5 },
    { name: 'ALIEN INTERN', sym: 'INTRN', mode: 1, face: 'alien', buys: 4, size: [20, 120] },
  ]
  for (const def of seeds) await spawnSeed(def)

  // Manifest for the frontend.
  const manifest = {
    chainId: 31337,
    rpc: 'http://127.0.0.1:8545',
    messenger: world.messenger.target,
    pad: world.pad.target,
    venue: world.venue.target,
    hubUsd: world.hubUsd.target,
    fromBlock: 0,
    chains: world.chains.map((c) => ({
      label: c.label,
      id: c.id,
      gateway: c.gateway.target,
      usd: c.usd.target,
      chainId: 31337,
      rpc: 'http://127.0.0.1:8545',
    })),
    deployedAt: Date.now(),
  }
  const outDir = path.join(__dirname, '..', '..', 'public', 'onchain')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'deployment.json'), JSON.stringify(manifest, null, 2))
  console.log('Manifest written to public/onchain/deployment.json')
  console.log(`Done — ${seeds.length} creatures live on-chain across ${CHAINS.length} chains.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
