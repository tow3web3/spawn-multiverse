/**
 * Deploys SPAWN! to public testnets over the REAL LayerZero V2 endpoints.
 *
 *   npx hardhat run scripts/deploy-testnet.js --network baseSepolia      # hub
 *   npx hardhat run scripts/deploy-testnet.js --network optimismSepolia  # spoke
 *   npx hardhat run scripts/deploy-testnet.js --network arbitrumSepolia  # spoke
 *   npx hardhat run scripts/deploy-testnet.js --network baseSepolia      # again: wires new spokes
 *   (then once more on each spoke when the set of spokes changed: it
 *    refreshes how many SYNC replies a spawn prepays)
 *
 * Resumable: every deployed address lands in deployments/testnet.json
 * immediately; a re-run skips what exists and only does what's missing.
 * Faucet gas is precious — nothing is deployed twice.
 *
 * Money (v7): testnets run the MAINNET settlement contract — a USDC-backed
 * OmniUSD vault per user-facing chain, a ledger-mode OmniUSD on the hub —
 * over a MockUSDC anyone can mint. No CCTP on testnets (tokenMessenger = 0).
 * A mainnet deploy passes Circle's real USDC + TokenMessengerV2 instead and
 * never deploys MockUSDC.
 *
 * Transport (v7): the hub chain (Base) has its own gateway, reached by the
 * hub adapter's loopback — no LayerZero message. Every message is paid by
 * whoever causes it, replies included (`RETURN_UNIT` per reply, delivered
 * into the hub adapter's tank by the executor). On testnets gateways are
 * SPONSORED — their adapter's tank pays, so visitors need no fee logic —
 * which is a config value here, not a code branch:
 *
 *   SPAWN_SPONSORED=0     run a testnet the mainnet way (users attach fees)
 *   SPAWN_RETURN_UNIT=…   reply budget per leg, in ETH (default 0.00005)
 *
 * State from before v7 cannot be continued (the messenger interface
 * changed): archive that network's entry first. Its gas tank is not lost —
 * `adapter.recover(to)` drains it.
 */
const fs = require('fs')
const path = require('path')
const { ethers, network } = require('hardhat')
const { GAS_TO_HUB, GAS_TO_SPOKE } = require('./lib-deploy')

// LayerZero V2 EndpointV2 — same address on these testnets (verified on-chain).
const ENDPOINT = '0x6EDCE65403992e310A62460808c4b910D972f10f'

// Our chain labels (see lib-deploy CHAINS): 2 = ethereum, 3 = base,
// 4 = bnb, 5 = arbitrum, 6 = optimism. (1 = solana is not an EVM leg.)
// The hub chain is ALSO a user-facing chain: Base, label 3, by loopback.
const NETS = {
  baseSepolia: {
    eid: 40245, role: 'hub', label: 3, id: 'base',
    chainId: 84532, rpc: 'https://sepolia.base.org',
  },
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

// Fee config (see the header). A hub reply costs ~0.00005 ETH on these
// testnets, so that is what each message prepays per reply leg.
const SPONSORED = process.env.SPAWN_SPONSORED !== '0'
const RETURN_UNIT = ethers.parseEther(process.env.SPAWN_RETURN_UNIT ?? '0.00005')

const FILE = path.join(__dirname, '..', 'deployments', 'testnet.json')
const b32 = (addr) => ethers.zeroPadValue(addr, 32)

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

/** How many remote spokes exist in the state file — what a spawn must
 * prepay in SYNC replies. A spoke counts from the moment its gateway is
 * deployed (slightly early: the hub only SYNCs it once wired), so a spawn
 * never underpays; other gateways catch up on their next run. */
function remoteSpokes(all) {
  return Object.entries(NETS).filter(([net, c]) => c.role === 'spoke' && all[net]?.gateway).length
}

/** The transport adapter of this network — or a clear refusal when the
 * state file holds a pre-v7 one. Judged from the state file, not an RPC
 * probe: lagging nodes lie about fresh code, the file does not. */
async function deployAdapter(state, cfg) {
  if (state.adapter && state.transport !== 'v7') {
    throw new Error(
      `${network.name}: pre-v7 deployment in the state — archive this network's entry before deploying v7 ` +
        `(the old gas tank is recoverable: adapter.recover(to) on ${state.adapter})`,
    )
  }
  const adapter = await deployOnce(state, 'adapter', 'LayerZeroOmniMessenger', [ENDPOINT, cfg.eid])
  if (state.transport !== 'v7') {
    state.transport = 'v7'
    const all = load()
    all[network.name] = state
    save(all)
  }
  return adapter
}

/** One chain's dollar stack + gateway + holder pool, wired to `adapter`. */
async function deployUserSide(state, cfg, adapter, padAddr, keys) {
  const usdc = await deployOnce(state, 'usdc', 'MockUSDC', [])
  const usd = await deployOnce(state, keys.usd, 'OmniUSD', [
    cfg.label,
    usdc.target,
    ethers.ZeroAddress, // no CCTP on testnets
  ])
  const gateway = await deployOnce(state, 'gateway', 'SpawnGateway', [
    adapter.target,
    usd.target,
    cfg.label,
    padAddr,
  ])
  if ((await usd.agent()) === ethers.ZeroAddress) {
    await (await usd.setAgent(gateway.target)).wait()
    console.log(`  ${keys.usd}.setAgent ✓`)
  }
  if ((await usd.depositCap()) === 0n) {
    await (await usd.setDepositCap(TESTNET_CAP)).wait()
    console.log(`  ${keys.usd}.setDepositCap ✓ (deposits open)`)
  }
  if (!(await adapter.senders(gateway.target))) {
    await (await adapter.register(gateway.target, cfg.label)).wait()
    console.log('  adapter.register(gateway) ✓')
  }
  if ((await adapter.sponsored(gateway.target)) !== SPONSORED) {
    await (await adapter.setSponsored(gateway.target, SPONSORED)).wait()
    console.log(`  gateway sponsored = ${SPONSORED} ✓`)
  }
  const dist = await deployOnce(state, keys.dist, 'FeeDistributor', [usd.target])
  if ((await dist.agent()) === ethers.ZeroAddress) {
    await (await dist.setAgent(gateway.target)).wait()
    console.log(`  ${keys.dist}.setAgent(gateway) ✓`)
  }
  if ((await gateway.distributor()) === ethers.ZeroAddress) {
    await (await gateway.setDistributor(dist.target)).wait()
    console.log('  gateway.setDistributor ✓')
  }
  return { usdc, usd, gateway, dist }
}

async function setDestination(adapter, label, gas, unit, what) {
  if ((await adapter.gasLimit(label)) !== gas || (await adapter.returnUnit(label)) !== unit) {
    await (await adapter.setDestination(label, gas, unit)).wait()
    console.log(`  ${what} ✓ (gas ${gas}, reply budget ${ethers.formatEther(unit)} ETH/leg)`)
  }
}

async function setLegs(gateway, trade, spawn) {
  if (Number(await gateway.tradeLegs()) !== trade || Number(await gateway.spawnLegs()) !== spawn) {
    await (await gateway.setLegs(trade, spawn)).wait()
    console.log(`  gateway.setLegs(trade ${trade}, spawn ${spawn}) ✓`)
  }
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
    const adapter = await deployAdapter(state, cfg)
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
      await (await adapter.register(pad.target, 0)).wait()
      console.log('  adapter.register(pad) ✓')
    }
    // the pad's messages are replies, prepaid into this tank — always sponsored
    if (!(await adapter.sponsored(pad.target))) {
      await (await adapter.setSponsored(pad.target, true)).wait()
      console.log('  pad sponsored ✓')
    }
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

    // The hub chain's own user side: vault + gateway + holder pool, label
    // 3, reached by loopback. Labels 0 (the pad) and 3 both live here.
    for (const label of [0, cfg.label]) {
      if (!(await adapter.isLocal(label))) {
        await (await adapter.setLocal(label, true)).wait()
        console.log(`  adapter.setLocal(${label}) ✓`)
      }
    }
    // a locally-initiated spawn prepays the hub's remote SYNC fan-out
    await setDestination(adapter, 0, 0n, RETURN_UNIT, 'local fan-out budget')
    const local = await deployUserSide(state, cfg, adapter, pad.target, { usd: 'localUsd', dist: 'localDist' })
    if ((await pad.gateways(cfg.label)) === ethers.ZeroHash) {
      await (await pad.setGateway(cfg.label, b32(local.gateway.target))).wait()
      console.log(`  pad.setGateway(${cfg.label}, ${network.name} — local) ✓`)
    }
    await topUpTank(adapter.target, deployer)

    // Wire every spoke that exists in the manifest but isn't routed yet.
    for (const [net, c] of Object.entries(NETS)) {
      if (c.role !== 'spoke' || !all[net]?.adapter || !all[net]?.gateway) continue
      if ((await adapter.eidOf(c.label)) === 0n) {
        await (await adapter.setRoute(c.label, c.eid, b32(all[net].adapter))).wait()
        console.log(`  route hub -> ${net} ✓`)
      }
      // BEFORE the pad learns the gateway: from that moment every spawn
      // SYNCs this chain, and a send without a gas limit reverts.
      // Hub -> spoke messages are replies: they carry no further budget.
      await setDestination(adapter, c.label, GAS_TO_SPOKE, 0n, `options hub -> ${net}`)
      if ((await pad.gateways(c.label)) === ethers.ZeroHash) {
        // gateway ids are wide (v5): EVM gateways ride left-padded
        await (await pad.setGateway(c.label, b32(all[net].gateway))).wait()
        console.log(`  pad.setGateway(${c.label}, ${net}) ✓`)
      }
    }
    // at home a trade's reply is a free local call; a spawn SYNCs every spoke
    await setLegs(local.gateway, 0, remoteSpokes(load()))
  } else {
    const hub = all.baseSepolia
    if (!hub?.pad || !hub?.adapter) throw new Error('déploie d’abord le hub (baseSepolia)')
    if (hub.transport !== 'v7') throw new Error('le hub (baseSepolia) est pré-v7 — redéploie-le d’abord')
    const adapter = await deployAdapter(state, cfg)
    const side = await deployUserSide(state, cfg, adapter, hub.pad, { usd: 'usd', dist: 'dist' })

    if ((await adapter.eidOf(0)) === 0n) {
      await (await adapter.setRoute(0, NETS.baseSepolia.eid, b32(hub.adapter))).wait()
      console.log('  route spoke -> hub ✓')
    }
    await setDestination(adapter, 0, GAS_TO_HUB, RETURN_UNIT, 'options spoke -> hub')
    // a trade prepays its one reply; a spawn the SYNC to every spoke
    await setLegs(side.gateway, 1, remoteSpokes(load()))
    await topUpTank(adapter.target, deployer)
    console.log('  ➜ relance le script sur baseSepolia pour câbler hub -> spoke')
    console.log('  ➜ puis sur chaque AUTRE spoke déjà déployé (rafraîchit spawnLegs)')
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
  // v7: the hub chain is a user-facing chain too — trades there are local
  // (one transaction, no LayerZero message, no messaging fee)
  if (hub.gateway) {
    const cfg = NETS.baseSepolia
    chains.push({
      label: cfg.label, id: cfg.id,
      gateway: hub.gateway, usd: hub.localUsd, usdc: hub.usdc,
      chainId: cfg.chainId, rpc: cfg.rpc,
      local: true,
    })
  }
  for (const [net, cfg] of Object.entries(NETS)) {
    if (cfg.role !== 'spoke' || !all[net]?.gateway) continue
    chains.push({
      label: cfg.label, id: cfg.id,
      gateway: all[net].gateway, usd: all[net].usd,
      // v7: the (mock) USDC users pay with
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
    // v7 fees: when false, every gateway call must attach its `quote*` fee
    sponsored: SPONSORED,
    chains,
    deployedAt: Date.now(),
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2))
  console.log(`manifest frontend: public/onchain/testnet.json (${chains.length} chain(s))`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
