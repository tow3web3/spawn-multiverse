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
  // v7 fees: the pad's messages are replies, prepaid by whoever caused them
  await (await messenger.setSponsored(pad.target, true)).wait()
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
    // every chain is a "remote" spoke of the simulated network: a trade
    // prepays 1 reply, a spawn the SYNC to all six chains. The simulated
    // fee is 0 unless a test turns it on (`messenger.setFlatFee`).
    await (await gateway.setLegs(1, CHAINS.length)).wait()
    const dist = await ethers.deployContract('FeeDistributor', [usd.target])
    await (await dist.setAgent(gateway.target)).wait()
    await (await gateway.setDistributor(dist.target)).wait()
    chains.push({ ...c, usdc, cctp, usd, gateway, dist })
  }

  return { messenger, hubUsd, pad, venue, hubDist, chains }
}

/** The chain whose gateway lives on the hub chain itself (Base): its
 * messages never touch LayerZero — the hub adapter loops them back. */
const HUB_LOCAL_LABEL = 3

/** Executor gas bought for `lzReceive`, per destination — the DEPLOY config.
 * The hub's worst case is OP_SPAWN: a full ERC20 deploy, the hub chain's own
 * replica deploy (loopback SYNC), one LayerZero send per remote chain and an
 * optional dev buy — ~1.4M of protocol work plus ~0.2M per real send. A
 * spoke's worst case is OP_SYNC_TOKEN, a replica deploy (~0.72M measured). */
const GAS_TO_HUB = 4_000_000n
const GAS_TO_SPOKE = 2_000_000n
/** The mock endpoint stores whole packets on-chain: ~0.52M gas per send,
 * against ~0.2M for the real one. With five remote chains that alone is
 * 2.6M inside the hub's OP_SPAWN, so the mock world buys more hub gas than a
 * real deployment needs. The mock enforces what was bought, like an executor. */
const MOCK_GAS_TO_HUB = 6_000_000n

/**
 * Same multiverse, but over the ASYNC transport — and in the MAINNET
 * topology: one LayerZeroOmniMessenger adapter per chain, peered through a
 * MockLZEndpointV2 that queues packets and only lands them when
 * `deliverAll()` is called, EXCEPT the hub chain's own gateway (label 3,
 * Base), which shares the hub adapter and reaches the pad by loopback.
 * This is the wiring that moves to testnet/mainnet: swap the mock endpoint
 * address for the real LayerZero V2 endpoint per chain, keep everything else.
 *
 * Fees (v7): the mock endpoint charges `FEE` per message; every spoke
 * prepays `RETURN_UNIT` (≥ FEE) per reply into the hub tank. With
 * `sponsored: true` (default — how testnets run) gateways ride their tank
 * and tests can call them without value; with `sponsored: false` (mainnet)
 * every user call must attach the quoted fee.
 */
async function deployWorldAsync({ sponsored = true } = {}) {
  const FEE = ethers.parseEther('0.001')
  const RETURN_UNIT = ethers.parseEther('0.0012')
  const EID = (label) => 30_000 + label
  const [funder] = await ethers.getSigners()
  const remotes = CHAINS.filter((c) => c.label !== HUB_LOCAL_LABEL).length

  const endpoint = await ethers.deployContract('MockLZEndpointV2', [FEE])

  const hubMessenger = await ethers.deployContract('LayerZeroOmniMessenger', [endpoint.target, EID(0)])
  await (await endpoint.registerAdapter(hubMessenger.target, EID(0))).wait()
  await (await funder.sendTransaction({ to: hubMessenger.target, value: ethers.parseEther('1') })).wait()

  const hubUsd = await ethers.deployContract('OmniUSD', [0, ethers.ZeroAddress, ethers.ZeroAddress])
  const pad = await ethers.deployContract('SpawnPad', [hubMessenger.target, hubUsd.target])
  const venue = await ethers.deployContract('InternalCurveVenue', [pad.target])
  await (await pad.setVenue(venue.target)).wait()
  await (await hubUsd.setAgent(pad.target)).wait()
  await (await hubMessenger.register(pad.target, 0)).wait()
  // the pad's messages are replies: prepaid into this tank, never by the pad
  await (await hubMessenger.setSponsored(pad.target, true)).wait()
  // labels hosted on the hub chain: the hub itself and its own gateway.
  // A local spawn still makes the hub SYNC every remote chain — the local
  // sender prepays that fan-out at RETURN_UNIT per leg, into this tank.
  await (await hubMessenger.setLocal(0, true)).wait()
  await (await hubMessenger.setLocal(HUB_LOCAL_LABEL, true)).wait()
  await (await hubMessenger.setDestination(0, 0, RETURN_UNIT)).wait()
  const hubDist = await ethers.deployContract('FeeDistributor', [hubUsd.target])
  await (await hubDist.setAgent(pad.target)).wait()
  await (await hubDist.exclude(venue.target)).wait()
  await (await pad.setDistributor(hubDist.target)).wait()

  const chains = []
  for (const c of CHAINS) {
    const local = c.label === HUB_LOCAL_LABEL
    let messenger = hubMessenger
    if (!local) {
      messenger = await ethers.deployContract('LayerZeroOmniMessenger', [endpoint.target, EID(c.label)])
      await (await endpoint.registerAdapter(messenger.target, EID(c.label))).wait()
      await (await funder.sendTransaction({ to: messenger.target, value: ethers.parseEther('1') })).wait()
    }

    const { usdc, cctp, usd } = await deployDollar(c.label)
    const gateway = await ethers.deployContract('SpawnGateway', [
      messenger.target,
      usd.target,
      c.label,
      pad.target,
    ])
    await (await usd.setAgent(gateway.target)).wait()
    await (await messenger.register(gateway.target, c.label)).wait()
    if (sponsored) await (await messenger.setSponsored(gateway.target, true)).wait()
    await (await pad.setGateway(c.label, b32(gateway.target))).wait()
    // replies a user prepays: 1 per trade on a remote chain, none at home;
    // a spawn prepays the SYNC to every remote chain wherever it starts
    await (await gateway.setLegs(local ? 0 : 1, remotes)).wait()
    const dist = await ethers.deployContract('FeeDistributor', [usd.target])
    await (await dist.setAgent(gateway.target)).wait()
    await (await gateway.setDistributor(dist.target)).wait()

    if (!local) {
      // spoke <-> hub routes (spokes never talk to each other; the pad relays)
      await (await messenger.setRoute(0, EID(0), b32(hubMessenger.target))).wait()
      await (await hubMessenger.setRoute(c.label, EID(c.label), b32(messenger.target))).wait()
      await (await messenger.setDestination(0, MOCK_GAS_TO_HUB, RETURN_UNIT)).wait()
      // hub -> spoke messages are replies: they carry no further budget
      await (await hubMessenger.setDestination(c.label, GAS_TO_SPOKE, 0)).wait()
    }
    chains.push({ ...c, usdc, cctp, usd, gateway, messenger, dist, local })
  }

  async function deliverAll() {
    while ((await endpoint.pending()) > 0n) await (await endpoint.deliverAll(32)).wait()
  }

  return { endpoint, hubMessenger, hubUsd, pad, venue, hubDist, chains, deliverAll, FEE, RETURN_UNIT }
}

module.exports = {
  deployWorld,
  deployWorldAsync,
  CHAINS,
  HUB_LOCAL_LABEL,
  GAS_TO_HUB,
  GAS_TO_SPOKE,
  MOCK_GAS_TO_HUB,
  SCALE,
  U,
  fundUsd,
  fundUsdc,
  worth,
  backing,
}
