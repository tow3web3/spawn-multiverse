/**
 * Deploys a local SPAWN! world (protocol v7.2) to the local node, seeds the
 * demo tokens with real trades, and writes the deployment manifest where the
 * frontend can fetch it (public/onchain/deployment.json).
 *
 *   npx hardhat node                 # terminal 1
 *   npm run deploy:local             # terminal 2
 *
 * ONE universe, the five EVM chains mainnet opens with, on one node behind
 * the synchronous LocalOmniMessenger (a message and its replies land in the
 * sender's own transaction):
 *
 *   label 3  base      the hub chain's own gateway   USDC (6 dec)   OmniUSD
 *   label 6  optimism                                USDC (6 dec)   OmniUSD
 *   label 5  arbitrum                                USDC (6 dec)   OmniUSD
 *   label 2  ethereum                                USDC (6 dec)   OmniUSD
 *   label 4  bnb                                     USDT (18 dec)  OmniUSDLocal (no wrap)
 *
 * What the world is built to show (the v7.2 paths a user meets):
 *  - every message is PAID: the messenger charges a flat fee per message, so
 *    every gateway call attaches its quote, opens and moves included;
 *  - opens and moves are priced (`openLegs`, `moveLegs`, `requestCap`);
 *  - PICKL never reached Ethereum: its SYNC was skipped at launch by a
 *    ceiling (`syncCap`), so it has no replica there and can be OPENED from
 *    Ethereum;
 *  - the BNB vault is SHORT: dollars entered on the USDC chains and a demo
 *    wallet sold its BNB bag after a pump, so it holds an oUSD claim on BNB
 *    that the BNB vault cannot pay — a claim to MOVE to another chain.
 *
 * The demo wallet is Hardhat's account #19 (its key is printed at the end):
 * load it as the site's burner to find the claim waiting in the portfolio.
 */
const fs = require('fs')
const path = require('path')
const { ethers } = require('hardhat')
const { deployDistributor, setV72Legs } = require('./lib-deploy')

const E = (n) => ethers.parseEther(String(n))
const b32 = (addr) => ethers.zeroPadValue(addr, 32)
const rand = (lo, hi) => lo + Math.random() * (hi - lo)
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

/** Label 3 is the hub chain's own gateway. */
const HOME = 3
const LAYOUT = [
  { label: 3, id: 'base', dollar: 'USDC' },
  { label: 6, id: 'optimism', dollar: 'USDC' },
  { label: 5, id: 'arbitrum', dollar: 'USDC' },
  { label: 2, id: 'ethereum', dollar: 'USDC' },
  { label: 4, id: 'bnb', dollar: 'USDT' },
]
const ETHEREUM = 2
const BNB = 4
/** What the simulated network charges per message (native wei). */
const FLAT_FEE = E('0.00002')
/** Hardhat's account #19 — the demo wallet the scenario leaves a claim with. */
const DEMO_INDEX = 19
const DEMO_MNEMONIC = 'test test test test test test test test test test test junk'

async function main() {
  const signers = await ethers.getSigners()
  const traders = signers.slice(5, 13)
  const demo = signers[DEMO_INDEX]

  console.log('Deploying one universe on five chains…')
  const messenger = await ethers.deployContract('LocalOmniMessenger')
  await messenger.waitForDeployment()
  await (await messenger.setFlatFee(FLAT_FEE)).wait()
  const hubUsd = await ethers.deployContract('OmniUSD', [0, ethers.ZeroAddress, ethers.ZeroAddress])
  const pad = await ethers.deployContract('SpawnPad', [messenger.target, hubUsd.target])
  const venue = await ethers.deployContract('InternalCurveVenue', [pad.target])
  await (await pad.setVenue(venue.target)).wait()
  await (await hubUsd.setAgent(pad.target)).wait()
  await (await messenger.register(pad.target, 0)).wait()
  // the pad's messages are replies, prepaid by whoever caused them
  await (await messenger.setSponsored(pad.target, true)).wait()

  const labels = LAYOUT.map((c) => c.label)
  const remotes = labels.filter((l) => l !== HOME).length
  const chains = []
  for (const c of LAYOUT) {
    const local = c.label === HOME
    let dollar, usd, decimals
    if (c.dollar === 'USDT') {
      decimals = 18
      dollar = await ethers.deployContract('MockDollar', ['Tether USD', 'USDT', decimals])
      // the BNB vault: same surface as OmniUSD, no CCTP, no wrap
      usd = await ethers.deployContract('OmniUSDLocal', [c.label, dollar.target])
    } else {
      decimals = 6
      dollar = await ethers.deployContract('MockUSDC')
      const cctp = await ethers.deployContract('MockTokenMessenger')
      usd = await ethers.deployContract('OmniUSD', [c.label, dollar.target, cctp.target])
    }
    const T = (n) => ethers.parseUnits(Number(n).toFixed(Math.min(decimals, 6)), decimals)
    // a local world: deposits wide open
    await (await usd.setDepositCap(T(1_000_000_000))).wait()
    const gateway = await ethers.deployContract('SpawnGateway', [messenger.target, usd.target, c.label, pad.target])
    await (await usd.setAgent(gateway.target)).wait()
    await (await messenger.register(gateway.target, c.label)).wait()
    // the holder pool exists before the pad learns the gateway
    const dist = await deployDistributor(usd, gateway)
    await (await pad.setGateway(c.label, b32(gateway.target))).wait()
    // every delivery is a free synchronous call here: holder slices ship at once
    await (await pad.setAutoDrop(c.label, true)).wait()
    // the mainnet legs: no reply to prepay at home, one elsewhere; a spawn
    // prepays the SYNC to every remote chain
    await (await gateway.setLegs(local ? 0 : 1, remotes)).wait()
    // v7.2: an open prepays its SYNC (nothing at home), a move one leg to any
    // other chain; the hub hands on a request that costs at most one message
    await setV72Legs(gateway, { local, labels, self: c.label })
    await (await pad.setRequestCap(c.label, FLAT_FEE)).wait()
    chains.push({ ...c, kind: c.dollar, local, dollar, usd, gateway, dist, decimals, T })
    console.log(`  ${c.id.padEnd(9)}: gateway ${gateway.target} · ${c.dollar} (${decimals} dec)`)
  }
  const at = (label) => chains.find((c) => c.label === label)
  const usdcChains = chains.filter((c) => c.kind === 'USDC')

  async function fund(c, who, dollars) {
    await (await c.dollar.mint(who.address, c.T(dollars))).wait()
    await (await c.dollar.connect(who).approve(c.usd.target, ethers.MaxUint256)).wait()
  }
  // the trading crowd holds dollars on every chain (the demo wallet too)
  for (const c of chains) {
    for (const t of [...traders, demo]) await fund(c, t, c.kind === 'USDT' ? 5_000 : 50_000)
  }

  async function replica(c, token) {
    return ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
  }

  async function buy(token, usd, { on, who } = {}) {
    const c = on ?? pick(usdcChains)
    const trader = who ?? pick(traders)
    const units = c.T(usd.toFixed(2))
    if ((await c.dollar.balanceOf(trader.address)) < units) await fund(c, trader, 100_000)
    const fee = await c.gateway.quoteBuy()
    await (await c.gateway.connect(trader).buyTokenUsdc(token, units, { value: fee })).wait()
  }

  async function sellSome(token, { not = [] } = {}) {
    // a trader with a bag on a USDC chain sells a slice of it
    for (let i = 0; i < 8; i++) {
      const c = pick(usdcChains.filter((x) => !not.includes(x.label)))
      const trader = pick(traders)
      if ((await c.gateway.replicaOf(token)) === ethers.ZeroAddress) continue
      const bal = await (await replica(c, token)).balanceOf(trader.address)
      if (bal > E(1000)) {
        const slice = (bal * BigInt(Math.floor(rand(10, 60)))) / 100n
        const fee = await c.gateway.quoteSell()
        await (await c.gateway.connect(trader).sellToken(token, slice, { value: fee })).wait()
        return
      }
    }
  }

  async function spawnSeed(def) {
    const c = def.from ? at(def.from) : pick(usdcChains.filter((x) => !(def.skip ?? []).includes(x.label)))
    const creator = pick(traders)
    const metaURI = JSON.stringify({ face: def.face })
    const fee = await c.gateway.quoteSpawn(def.name, def.sym, metaURI, false)
    const rc = await (
      await c.gateway.connect(creator).spawnTokenUsdc(def.name, def.sym, metaURI, 0, def.mode ?? 0, { value: fee })
    ).wait()
    const token = await pad.allTokens((await pad.tokensLength()) - 1n)
    const failed = rc.logs
      .map((l) => {
        try {
          return pad.interface.parseLog(l)
        } catch {
          return null
        }
      })
      .filter((e) => e?.name === 'SyncFailed')
      .map((e) => LAYOUT.find((x) => x.label === Number(e.args.chain))?.id)
    console.log(`  spawned ${def.sym.padEnd(6)} ${token}${failed.length ? ` — no replica on ${failed.join(', ')}` : ''}`)

    // hop the FAIR GENESIS window (v6) so the pit seeds at steady-state fees
    await ethers.provider.send('evm_increaseTime', [601])
    await ethers.provider.send('evm_mine', [])

    const not = def.skip ?? []
    const where = () => pick(usdcChains.filter((x) => !not.includes(x.label)))
    for (let i = 0; i < def.buys; i++) {
      await buy(token, rand(...def.size), { on: where() })
      if (def.sellEvery && i > 3 && i % def.sellEvery === 0) await sellSome(token, { not })
    }
    if (def.whale) await buy(token, def.whale, { on: where() })
    for (let i = 0; i < (def.poolBuys ?? 0); i++) await buy(token, rand(100, 900), { on: where() })
    for (let i = 0; i < (def.dumps ?? 0); i++) await sellSome(token, { not })
    return token
  }

  console.log('Seeding the pit with real trades…')
  const seeds = [
    { name: 'GLOOP SUPREME', sym: 'GLOOP', mode: 0, face: 'frog', buys: 30, size: [60, 600], sellEvery: 7 },
    // ROT gets whale-pumped through ascension, then trades on the omnipool
    { name: 'BRAINROT 3000', sym: 'ROT', mode: 3, face: 'brain', buys: 24, size: [200, 900], sellEvery: 9, whale: 16_000, poolBuys: 8 },
    { name: 'SIR BORKS', sym: 'BORK', mode: 1, face: 'bork', buys: 22, size: [50, 450], sellEvery: 6 },
    // PICKL launches while Ethereum is "too dear" for the fan-out: its SYNC
    // there is skipped (SyncFailed), so Ethereum has no PICKL until someone
    // there opens it
    { name: 'COSMIC PICKLE', sym: 'PICKL', mode: 2, face: 'pickle', buys: 10, size: [30, 250], sellEvery: 5, skip: [ETHEREUM], dear: ETHEREUM },
    // MOCHI pumps then takes a beating
    { name: 'MOCHI MAYHEM', sym: 'MOCHI', mode: 0, face: 'mochi', buys: 18, size: [60, 400], dumps: 5 },
    { name: 'ALIEN INTERN', sym: 'INTRN', mode: 1, face: 'alien', buys: 4, size: [20, 120] },
  ]
  const tokens = {}
  for (const def of seeds) {
    // a ceiling of 1 wei on one chain's SYNC: above it, the launch skips
    // that chain and goes on (v7.2 `syncCap`); lifted right after
    if (def.dear) await (await pad.setSyncCap(def.dear, 1)).wait()
    tokens[def.sym] = await spawnSeed(def)
    if (def.dear) await (await pad.setSyncCap(def.dear, 0)).wait()
  }

  // A SHORT VAULT. Dollars enter where buyers are and leave where sellers
  // are: the crowd bought on the USDC chains, so the BNB vault only holds
  // what was bought on BNB. A few holders there, then the demo wallet: it
  // bought GLOOP on BNB, the crowd pumped it on Base, and its sale on BNB
  // pays more than that vault holds — so it is paid as an oUSD claim on BNB.
  console.log('Leaving the BNB vault short…')
  const bnb = at(BNB)
  for (let i = 0; i < 3; i++) await buy(tokens.GLOOP, rand(40, 80), { on: bnb })
  await buy(tokens.GLOOP, 400, { on: bnb, who: demo })
  for (let i = 0; i < 8; i++) await buy(tokens.GLOOP, rand(1500, 2500), { on: at(HOME) })
  const bag = await (await replica(bnb, tokens.GLOOP)).balanceOf(demo.address)
  await (await bnb.gateway.connect(demo).sellToken(tokens.GLOOP, bag, { value: await bnb.gateway.quoteSell() })).wait()
  const claim = await bnb.usd.balanceOf(demo.address)
  const held = await bnb.usd.liquidity()
  console.log(
    `  demo wallet ${demo.address}: an oUSD claim of $${Number(ethers.formatEther(claim)).toFixed(2)} on BNB,` +
      ` whose vault holds $${Number(ethers.formatUnits(held, bnb.decimals)).toFixed(2)} of USDT`,
  )

  // Manifest for the frontend — the v7.2 shape the tooling writes.
  const manifest = {
    generation: 'v7.2',
    chainId: 31337,
    rpc: 'http://127.0.0.1:8545',
    messenger: messenger.target,
    hubMessenger: messenger.target,
    pad: pad.target,
    venue: venue.target,
    hubUsd: hubUsd.target,
    dollar: { symbol: 'USDC', decimals: 6 },
    fromBlock: 0,
    chains: chains.map((c) => ({
      label: c.label,
      id: c.id,
      gateway: c.gateway.target,
      usd: c.usd.target,
      usdc: c.dollar.target,
      dist: c.dist.target,
      vault: c.kind === 'USDT' ? 'local' : 'cctp',
      ...(c.kind === 'USDT' ? { dollar: { symbol: 'USDT', decimals: 18 } } : {}),
      ...(c.local ? { local: true } : {}),
      chainId: 31337,
      rpc: 'http://127.0.0.1:8545',
    })),
    deployedAt: Date.now(),
  }
  const outDir = path.join(__dirname, '..', '..', 'public', 'onchain')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'deployment.json'), JSON.stringify(manifest, null, 2))
  const demoKey = ethers.HDNodeWallet.fromPhrase(DEMO_MNEMONIC, undefined, `m/44'/60'/0'/0/${DEMO_INDEX}`).privateKey
  console.log('Manifest written to public/onchain/deployment.json')
  console.log(`Done — ${seeds.length} tokens live on ${chains.length} chains.`)
  console.log(`Demo wallet (holds the BNB claim): ${demo.address}`)
  console.log(`  load it as the site's burner: localStorage.setItem('spawn.burner.pk', '${demoKey}')`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
