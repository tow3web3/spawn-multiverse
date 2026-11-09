/**
 * Deploys SPAWN! to public testnets over the REAL LayerZero V2 endpoints.
 *
 *   npx hardhat run scripts/deploy-testnet.js --network baseSepolia      # hub
 *   npx hardhat run scripts/deploy-testnet.js --network optimismSepolia  # spoke
 *   npx hardhat run scripts/deploy-testnet.js --network arbitrumSepolia  # spoke
 *   npx hardhat run scripts/deploy-testnet.js --network baseSepolia      # again: wires new spokes
 *
 * Resumable: every deployed address lands in deployments/testnet.json
 * immediately; a re-run skips what exists and only does what's missing.
 * Faucet gas is precious — nothing is deployed twice.
 */
const fs = require('fs')
const path = require('path')
const { ethers, network } = require('hardhat')

// LayerZero V2 EndpointV2 — same address on these testnets (verified on-chain).
const ENDPOINT = '0x6EDCE65403992e310A62460808c4b910D972f10f'

// Our chain labels (see lib-deploy CHAINS): 5 = arbitrum, 6 = optimism.
const NETS = {
  baseSepolia: { eid: 40245, role: 'hub' },
  optimismSepolia: { eid: 40232, role: 'spoke', label: 6, id: 'optimism' },
  arbitrumSepolia: { eid: 40231, role: 'spoke', label: 5, id: 'arbitrum' },
}

const FILE = path.join(__dirname, '..', 'deployments', 'testnet.json')
const b32 = (addr) => ethers.zeroPadValue(addr, 32)
// LZ type-3 options: pay the executor for 500k gas of lzReceive on the
// destination (replica deploys during SYNC_TOKEN are the heavy case).
const OPTIONS = ethers.solidityPacked(
  ['uint16', 'uint8', 'uint16', 'uint8', 'uint128'],
  [3, 1, 17, 1, 500_000n],
)

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    return {}
  }
}
function save(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2))
}

/** The adapter pays real LayerZero fees from its own balance — keep a tank
 * filled, sized to whatever the deployer can spare on this network. */
async function topUpTank(adapter, deployer) {
  const tankBal = await ethers.provider.getBalance(adapter)
  if (tankBal >= ethers.parseEther('0.002')) return
  const mine = await ethers.provider.getBalance(deployer.address)
  // keep a reserve for future wiring txs; send a third of the rest
  const spare = mine > ethers.parseEther('0.00005') ? (mine - ethers.parseEther('0.00003')) / 3n : 0n
  const amount = spare > ethers.parseEther('0.005') ? ethers.parseEther('0.005') : spare
  if (amount <= 0n) {
    console.log('  (gas tank left empty — deployer balance too low)')
    return
  }
  await (await deployer.sendTransaction({ to: adapter, value: amount })).wait()
  console.log(`  gas tank +${ethers.formatEther(amount)} ETH`)
}

async function deployOnce(state, key, name, args) {
  if (state[key]) {
    console.log(`  ${key.padEnd(8)} = ${state[key]} (déjà déployé)`)
    return ethers.getContractAt(name, state[key])
  }
  const c = await ethers.deployContract(name, args)
  await c.waitForDeployment()
  state[key] = c.target
  const all = load()
  all[network.name] = state
  save(all)
  console.log(`  ${key.padEnd(8)} = ${c.target} ✦ deployed`)
  return c
}

async function main() {
  const cfg = NETS[network.name]
  if (!cfg) throw new Error(`réseau inconnu: ${network.name}`)
  const [deployer] = await ethers.getSigners()
  if (!deployer) throw new Error('DEPLOYER_PK manquant dans contracts/.env')
  const bal0 = await ethers.provider.getBalance(deployer.address)
  console.log(`${network.name} — deployer ${deployer.address} — ${ethers.formatEther(bal0)} ETH`)

  const all = load()
  const state = all[network.name] ?? {}
  all[network.name] = state

  if (cfg.role === 'hub') {
    const adapter = await deployOnce(state, 'adapter', 'LayerZeroOmniMessenger', [ENDPOINT, cfg.eid])
    const usd = await deployOnce(state, 'usd', 'OmniUSD', [0])
    const pad = await deployOnce(state, 'pad', 'SpawnPad', [adapter.target, usd.target])
    const venue = await deployOnce(state, 'venue', 'InternalCurveVenue', [pad.target])

    if ((await pad.venue()) === ethers.ZeroAddress) {
      await (await pad.setVenue(venue.target)).wait()
      console.log('  pad.setVenue ✓')
    }
    if ((await usd.agent()) === ethers.ZeroAddress) {
      await (await usd.setAgent(pad.target)).wait()
      console.log('  usd.setAgent ✓')
    }
    if (!(await adapter.senders(pad.target))) {
      await (await adapter.register(pad.target)).wait()
      console.log('  adapter.register(pad) ✓')
    }
    if ((await adapter.defaultOptions()) === '0x') {
      await (await adapter.setOptions(OPTIONS)).wait()
      console.log('  adapter.setOptions ✓')
    }
    await topUpTank(adapter.target, deployer)

    // Wire every spoke that exists in the manifest but isn't routed yet.
    for (const [net, c] of Object.entries(NETS)) {
      if (c.role !== 'spoke' || !all[net]?.adapter || !all[net]?.gateway) continue
      if ((await adapter.eidOf(c.label)) === 0n) {
        await (await adapter.setRoute(c.label, c.eid, b32(all[net].adapter))).wait()
        console.log(`  route hub -> ${net} ✓`)
      }
      if ((await pad.gateways(c.label)) === ethers.ZeroAddress) {
        await (await pad.setGateway(c.label, all[net].gateway)).wait()
        console.log(`  pad.setGateway(${c.label}, ${net}) ✓`)
      }
    }
  } else {
    const hub = all.baseSepolia
    if (!hub?.pad || !hub?.adapter) throw new Error('déploie d’abord le hub (baseSepolia)')
    const adapter = await deployOnce(state, 'adapter', 'LayerZeroOmniMessenger', [ENDPOINT, cfg.eid])
    const usd = await deployOnce(state, 'usd', 'OmniUSD', [cfg.label])
    const gateway = await deployOnce(state, 'gateway', 'SpawnGateway', [
      adapter.target,
      usd.target,
      cfg.label,
      hub.pad,
    ])

    if ((await usd.agent()) === ethers.ZeroAddress) {
      await (await usd.setAgent(gateway.target)).wait()
      console.log('  usd.setAgent ✓')
    }
    if (!(await adapter.senders(gateway.target))) {
      await (await adapter.register(gateway.target)).wait()
      console.log('  adapter.register(gateway) ✓')
    }
    if ((await adapter.defaultOptions()) === '0x') {
      await (await adapter.setOptions(OPTIONS)).wait()
      console.log('  adapter.setOptions ✓')
    }
    if ((await adapter.eidOf(0)) === 0n) {
      await (await adapter.setRoute(0, NETS.baseSepolia.eid, b32(hub.adapter))).wait()
      console.log('  route spoke -> hub ✓')
    }
    await topUpTank(adapter.target, deployer)
    console.log('  ➜ relance le script sur baseSepolia pour câbler hub -> spoke')
  }

  const bal1 = await ethers.provider.getBalance(deployer.address)
  console.log(`coût: ${ethers.formatEther(bal0 - bal1)} ETH — reste ${ethers.formatEther(bal1)} ETH`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
