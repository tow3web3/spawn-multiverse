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
 *
 * Money (v7): testnets run the MAINNET settlement contract — a USDC-backed
 * OmniUSD vault per spoke, a ledger-mode OmniUSD on the hub — over a
 * MockUSDC anyone can mint. No CCTP on testnets (tokenMessenger = 0). A
 * mainnet deploy passes Circle's real USDC + TokenMessengerV2 instead and
 * never deploys MockUSDC.
 */
const fs = require('fs')
const path = require('path')
const { ethers, network } = require('hardhat')

// LayerZero V2 EndpointV2 — same address on these testnets (verified on-chain).
const ENDPOINT = '0x6EDCE65403992e310A62460808c4b910D972f10f'

// Our chain labels (see lib-deploy CHAINS): 2 = ethereum, 4 = bnb,
// 5 = arbitrum, 6 = optimism. (1 = solana is not an EVM leg.)
const NETS = {
  baseSepolia: { eid: 40245, role: 'hub', chainId: 84532, rpc: 'https://sepolia.base.org' },
  optimismSepolia: {
    eid: 40232, role: 'spoke', label: 6, id: 'optimism',
    chainId: 11155420, rpc: 'https://sepolia.optimism.io',
  },
  arbitrumSepolia: {
    eid: 40231, role: 'spoke', label: 5, id: 'arbitrum',
    chainId: 421614, rpc: 'https://sepolia-rollup.arbitrum.io/rpc',
  },
  ethereumSepolia: {
    eid: 40161, role: 'spoke', label: 2, id: 'ethereum',
    chainId: 11155111, rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
  },
  bnbTestnet: {
    eid: 40102, role: 'spoke', label: 4, id: 'bnb',
    chainId: 97, rpc: 'https://bsc-testnet-rpc.publicnode.com',
  },
}

// Testnet vault deposit cap: wide open — it is play money (1B mock USDC).
const TESTNET_CAP = 1_000_000_000n * 10n ** 6n

const FILE = path.join(__dirname, '..', 'deployments', 'testnet.json')
const b32 = (addr) => ethers.zeroPadValue(addr, 32)
// LZ type-3 options: pay the executor for 4M gas of lzReceive on the
// destination — hub-side _spawn deploys a full ERC20, 500k was not enough
// (first live OP_SPAWN failed in executor simulation until raised to 4M).
const OPTIONS = ethers.solidityPacked(
  ['uint16', 'uint8', 'uint16', 'uint8', 'uint128'],
  [3, 1, 17, 1, 4_000_000n],
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
    // the hub holds no dollars, only the books: ledger-mode oUSD (v7)
    const usd = await deployOnce(state, 'usd', 'OmniUSD', [0, ethers.ZeroAddress, ethers.ZeroAddress])
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
    // v3 holder distribution: a v2 pad has no distributor slot — probe first
    // so re-runs against a live v2 hub stay no-ops instead of crashing.
    const v3 = await pad.distributor().then(() => true).catch(() => false)
    if (v3) {
      const dist = await deployOnce(state, 'dist', 'FeeDistributor', [usd.target])
      if ((await dist.agent()) === ethers.ZeroAddress) {
        await (await dist.setAgent(pad.target)).wait()
        await (await dist.exclude(venue.target)).wait()
        console.log('  dist.setAgent(pad) ✓')
      }
      if ((await pad.distributor()) === ethers.ZeroAddress) {
        await (await pad.setDistributor(dist.target)).wait()
        console.log('  pad.setDistributor ✓')
      }
    } else {
      console.log('  (v2 pad — holder distribution not wired)')
    }
    await topUpTank(adapter.target, deployer)

    // Wire every spoke that exists in the manifest but isn't routed yet.
    for (const [net, c] of Object.entries(NETS)) {
      if (c.role !== 'spoke' || !all[net]?.adapter || !all[net]?.gateway) continue
      if ((await adapter.eidOf(c.label)) === 0n) {
        await (await adapter.setRoute(c.label, c.eid, b32(all[net].adapter))).wait()
        console.log(`  route hub -> ${net} ✓`)
      }
      if ((await pad.gateways(c.label)) === ethers.ZeroHash) {
        // gateway ids are wide (v5): EVM gateways ride left-padded
        await (await pad.setGateway(c.label, b32(all[net].gateway))).wait()
        console.log(`  pad.setGateway(${c.label}, ${net}) ✓`)
      }
    }
  } else {
    const hub = all.baseSepolia
    if (!hub?.pad || !hub?.adapter) throw new Error('déploie d’abord le hub (baseSepolia)')
    const adapter = await deployOnce(state, 'adapter', 'LayerZeroOmniMessenger', [ENDPOINT, cfg.eid])
    // v7 real-money settlement. A v7 spoke always records `usdc` before
    // `usd`; a `usd` without `usdc` is a pre-v7 faucet dollar — judged from
    // the state file, not an RPC probe (lagging nodes lie about fresh code).
    const legacyUsd = Boolean(state.usd) && !state.usdc
    if (legacyUsd && !state.gateway) {
      throw new Error(`${network.name}: pre-v7 oUSD in the state — archive this network's entry before deploying v7`)
    }
    const usdc = legacyUsd ? null : await deployOnce(state, 'usdc', 'MockUSDC', [])
    const usd = await deployOnce(state, 'usd', 'OmniUSD', [
      cfg.label,
      usdc ? usdc.target : ethers.ZeroAddress,
      ethers.ZeroAddress, // no CCTP on testnets
    ])
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
    if (legacyUsd) {
      console.log('  (pre-v7 oUSD — faucet money, no vault)')
    } else if ((await usd.depositCap()) === 0n) {
      await (await usd.setDepositCap(TESTNET_CAP)).wait()
      console.log('  usd.setDepositCap ✓ (deposits open)')
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
    // v3 holder distribution (see the hub branch for the v2 probe rationale)
    const v3 = await gateway.distributor().then(() => true).catch(() => false)
    if (v3) {
      const dist = await deployOnce(state, 'dist', 'FeeDistributor', [usd.target])
      if ((await dist.agent()) === ethers.ZeroAddress) {
        await (await dist.setAgent(gateway.target)).wait()
        console.log('  dist.setAgent(gateway) ✓')
      }
      if ((await gateway.distributor()) === ethers.ZeroAddress) {
        await (await gateway.setDistributor(dist.target)).wait()
        console.log('  gateway.setDistributor ✓')
      }
    } else {
      console.log('  (v2 gateway — holder distribution not wired)')
    }
    await topUpTank(adapter.target, deployer)
    console.log('  ➜ relance le script sur baseSepolia pour câbler hub -> spoke')
  }

  const bal1 = await ethers.provider.getBalance(deployer.address)
  console.log(`coût: ${ethers.formatEther(bal0 - bal1)} ETH — reste ${ethers.formatEther(bal1)} ETH`)

  await writeFrontendManifest(load())
}

/** Publishes public/onchain/testnet.json so the site's TESTNET mode can
 * talk to whatever is deployed so far. Re-run on any network to refresh. */
async function writeFrontendManifest(all) {
  const hub = all.baseSepolia
  if (!hub?.pad) return
  const outPath = path.join(__dirname, '..', '..', 'public', 'onchain', 'testnet.json')
  let fromBlock
  try {
    fromBlock = JSON.parse(fs.readFileSync(outPath, 'utf8')).fromBlock
  } catch {
    /* first write */
  }
  if (!fromBlock) {
    const hubProvider = new ethers.JsonRpcProvider(NETS.baseSepolia.rpc)
    fromBlock = Math.max(0, Number(await hubProvider.getBlockNumber()) - 300)
  }
  const chains = []
  for (const [net, cfg] of Object.entries(NETS)) {
    if (cfg.role !== 'spoke' || !all[net]?.gateway) continue
    chains.push({
      label: cfg.label, id: cfg.id,
      gateway: all[net].gateway, usd: all[net].usd,
      // v7: the (mock) USDC users pay with; absent on a pre-v7 deployment
      usdc: all[net].usdc,
      chainId: cfg.chainId, rpc: cfg.rpc,
    })
  }
  const manifest = {
    chainId: NETS.baseSepolia.chainId,
    rpc: NETS.baseSepolia.rpc,
    pad: hub.pad,
    venue: hub.venue,
    hubUsd: hub.usd,
    fromBlock,
    gasDrip: '/.netlify/functions/gas-drip',
    chains,
    deployedAt: Date.now(),
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2))
  console.log(`manifest frontend: public/onchain/testnet.json (${chains.length} spoke(s))`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
