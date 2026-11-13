const { ethers } = require('hardhat')

/** Gateway ids on the pad are wide (v5): EVM addresses ride left-padded. */
const b32 = (addr) => ethers.zeroPadValue(addr, 32)

/** oUSD is 18 decimals, USDC 6 — one USDC unit is SCALE oUSD wei. */
const SCALE = 10n ** 12n
/** Local/test deposit cap per vault: wide open (1B USDC). */
const LOCAL_CAP = 1_000_000_000n * 10n ** 6n
const U = (n) => ethers.parseUnits(String(n), 6)

/**
 * v7 real-money settlement, one chain's dollar stack: a MockUSDC standing in
 * for Circle's USDC, a MockTokenMessenger standing in for CCTP V2, and the
 * USDC-backed OmniUSD vault over both, deposits open.
 */
async function deployDollar(label) {
  const usdc = await ethers.deployContract('MockUSDC')
  const cctp = await ethers.deployContract('MockTokenMessenger')
  const usd = await ethers.deployContract('OmniUSD', [label, usdc.target, cctp.target])
  await (await usd.setDepositCap(LOCAL_CAP)).wait()
  return { usdc, cctp, usd }
}

/** Mints mock USDC to `signer` on `chain` and approves the vault for it —
 * ready for the USDC entry paths (`buyTokenUsdc`, `spawnTokenUsdc`, `wrap`). */
async function fundUsdc(chain, signer, dollars) {
  await (await chain.usdc.mint(signer.address, U(dollars))).wait()
  await (await chain.usdc.connect(signer).approve(chain.usd.target, ethers.MaxUint256)).wait()
}

/** Gives `signer` `dollars` of oUSD on `chain` the only way that exists:
 * real (mock) USDC wrapped through the vault. */
async function fundUsd(chain, signer, dollars) {
  await fundUsdc(chain, signer, dollars)
  await (await chain.usd.connect(signer).wrap(U(dollars))).wait()
}

/** Everything `who` is worth in dollars on `chain`, in oUSD wei: oUSD held
 * plus USDC held. Payouts settle in either, so tests compare this. */
async function worth(chain, who) {
  const addr = who.address ?? who.target ?? who
  return (await chain.usd.balanceOf(addr)) + (await chain.usdc.balanceOf(addr)) * SCALE
}

/** The two sides of the global backing invariant: USDC held by every vault
 * (scaled to 18 decimals) and oUSD supply over ALL instances, hub included. */
async function backing(world) {
  let usdc = 0n
  let supply = await world.hubUsd.totalSupply()
  for (const c of world.chains) {
    usdc += (await c.usdc.balanceOf(c.usd.target)) * SCALE
    supply += await c.usd.totalSupply()
  }
  return { usdc, supply }
}

/** The six user-facing chains. Label 0 is the hub (protocol-only). */
const CHAINS = [
  { label: 1, id: 'solana' },
  { label: 2, id: 'ethereum' },
  { label: 3, id: 'base' },
  { label: 4, id: 'bnb' },
  { label: 5, id: 'arbitrum' },
  { label: 6, id: 'optimism' },
]

/**
 * Deploys the whole multiverse on one node: the local messenger, the hub
 * (ledger-mode OmniUSD + SpawnPad) and six spokes (MockUSDC + USDC-backed
 * OmniUSD vault + SpawnGateway each), fully wired, deposits open. Used by
 * both the test suite and the local deploy script.
 */
async function deployWorld() {
  const messenger = await ethers.deployContract('LocalOmniMessenger')
  await messenger.waitForDeployment()

  const hubUsd = await ethers.deployContract('OmniUSD', [0, ethers.ZeroAddress, ethers.ZeroAddress])
  const pad = await ethers.deployContract('SpawnPad', [messenger.target, hubUsd.target])
  // Price discovery is a pluggable venue: the internal curve locally, a
  // Raydium LaunchLab / Meteora DBC adapter on the production Solana hub.
  const venue = await ethers.deployContract('InternalCurveVenue', [pad.target])
  await (await pad.setVenue(venue.target)).wait()
  await (await hubUsd.setAgent(pad.target)).wait()
  await (await messenger.register(pad.target, 0)).wait()
  // Holder dividends: one FeeDistributor per chain, the hub's wired to the pad.
  const hubDist = await ethers.deployContract('FeeDistributor', [hubUsd.target])
  await (await hubDist.setAgent(pad.target)).wait()
  await (await hubDist.exclude(venue.target)).wait()
  await (await pad.setDistributor(hubDist.target)).wait()

  const chains = []
  for (const c of CHAINS) {
    const { usdc, cctp, usd } = await deployDollar(c.label)
    const gateway = await ethers.deployContract('SpawnGateway', [
      messenger.target,
      usd.target,
      c.label,
      pad.target,
    ])
    await (await usd.setAgent(gateway.target)).wait()
    await (await messenger.register(gateway.target, c.label)).wait()
    await (await pad.setGateway(c.label, b32(gateway.target))).wait()
    const dist = await ethers.deployContract('FeeDistributor', [usd.target])
    await (await dist.setAgent(gateway.target)).wait()
    await (await gateway.setDistributor(dist.target)).wait()
    chains.push({ ...c, usdc, cctp, usd, gateway, dist })
  }

  return { messenger, hubUsd, pad, venue, hubDist, chains }
}

/**
 * Same multiverse, but over the ASYNC transport: one LayerZeroOmniMessenger
 * adapter per chain, peered through a MockLZEndpointV2 that queues packets
 * and only lands them when `deliverAll()` is called — like the real network.
 * This is the wiring that moves to testnet/mainnet: swap the mock endpoint
 * address for the real LayerZero V2 endpoint per chain, keep everything else.
 */
async function deployWorldAsync() {
  const FEE = ethers.parseEther('0.001')
  const EID = (label) => 30_000 + label
  const [funder] = await ethers.getSigners()

  const endpoint = await ethers.deployContract('MockLZEndpointV2', [FEE])

  const hubMessenger = await ethers.deployContract('LayerZeroOmniMessenger', [endpoint.target, EID(0)])
  await (await endpoint.registerAdapter(hubMessenger.target, EID(0))).wait()
  await (await funder.sendTransaction({ to: hubMessenger.target, value: ethers.parseEther('1') })).wait()

  const hubUsd = await ethers.deployContract('OmniUSD', [0, ethers.ZeroAddress, ethers.ZeroAddress])
  const pad = await ethers.deployContract('SpawnPad', [hubMessenger.target, hubUsd.target])
  const venue = await ethers.deployContract('InternalCurveVenue', [pad.target])
  await (await pad.setVenue(venue.target)).wait()
  await (await hubUsd.setAgent(pad.target)).wait()
  await (await hubMessenger.register(pad.target)).wait()
  const hubDist = await ethers.deployContract('FeeDistributor', [hubUsd.target])
  await (await hubDist.setAgent(pad.target)).wait()
  await (await hubDist.exclude(venue.target)).wait()
  await (await pad.setDistributor(hubDist.target)).wait()

  const chains = []
  for (const c of CHAINS) {
    const messenger = await ethers.deployContract('LayerZeroOmniMessenger', [endpoint.target, EID(c.label)])
    await (await endpoint.registerAdapter(messenger.target, EID(c.label))).wait()
    await (await funder.sendTransaction({ to: messenger.target, value: ethers.parseEther('1') })).wait()

    const { usdc, cctp, usd } = await deployDollar(c.label)
    const gateway = await ethers.deployContract('SpawnGateway', [
      messenger.target,
      usd.target,
      c.label,
      pad.target,
    ])
    await (await usd.setAgent(gateway.target)).wait()
    await (await messenger.register(gateway.target)).wait()
    await (await pad.setGateway(c.label, b32(gateway.target))).wait()
    const dist = await ethers.deployContract('FeeDistributor', [usd.target])
    await (await dist.setAgent(gateway.target)).wait()
    await (await gateway.setDistributor(dist.target)).wait()

    // spoke <-> hub routes (spokes never talk to each other; the pad relays)
    await (await messenger.setRoute(0, EID(0), b32(hubMessenger.target))).wait()
    await (await hubMessenger.setRoute(c.label, EID(c.label), b32(messenger.target))).wait()
    chains.push({ ...c, usdc, cctp, usd, gateway, messenger, dist })
  }

  async function deliverAll() {
    while ((await endpoint.pending()) > 0n) await (await endpoint.deliverAll(32)).wait()
  }

  return { endpoint, hubMessenger, hubUsd, pad, venue, hubDist, chains, deliverAll }
}

module.exports = { deployWorld, deployWorldAsync, CHAINS, SCALE, U, fundUsd, fundUsdc, worth, backing }
