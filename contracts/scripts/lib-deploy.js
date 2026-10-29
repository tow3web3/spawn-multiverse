const { ethers } = require('hardhat')

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
 * (OmniUSD + SpawnPad) and six spokes (OmniUSD + SpawnGateway each), fully
 * wired. Used by both the test suite and the local deploy script.
 */
async function deployWorld() {
  const messenger = await ethers.deployContract('LocalOmniMessenger')
  await messenger.waitForDeployment()

  const hubUsd = await ethers.deployContract('OmniUSD', [0])
  const pad = await ethers.deployContract('SpawnPad', [messenger.target, hubUsd.target])
  // Price discovery is a pluggable venue: the internal curve locally, a
  // Raydium LaunchLab / Meteora DBC adapter on the production Solana hub.
  const venue = await ethers.deployContract('InternalCurveVenue', [pad.target])
  await (await pad.setVenue(venue.target)).wait()
  await (await hubUsd.setAgent(pad.target)).wait()
  await (await messenger.register(pad.target, 0)).wait()

  const chains = []
  for (const c of CHAINS) {
    const usd = await ethers.deployContract('OmniUSD', [c.label])
    const gateway = await ethers.deployContract('SpawnGateway', [
      messenger.target,
      usd.target,
      c.label,
      pad.target,
    ])
    await (await usd.setAgent(gateway.target)).wait()
    await (await messenger.register(gateway.target, c.label)).wait()
    await (await pad.setGateway(c.label, gateway.target)).wait()
    chains.push({ ...c, usd, gateway })
  }

  return { messenger, hubUsd, pad, venue, chains }
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
  const b32 = (addr) => ethers.zeroPadValue(addr, 32)
  const [funder] = await ethers.getSigners()

  const endpoint = await ethers.deployContract('MockLZEndpointV2', [FEE])

  const hubMessenger = await ethers.deployContract('LayerZeroOmniMessenger', [endpoint.target, EID(0)])
  await (await endpoint.registerAdapter(hubMessenger.target, EID(0))).wait()
  await (await funder.sendTransaction({ to: hubMessenger.target, value: ethers.parseEther('1') })).wait()

  const hubUsd = await ethers.deployContract('OmniUSD', [0])
  const pad = await ethers.deployContract('SpawnPad', [hubMessenger.target, hubUsd.target])
  const venue = await ethers.deployContract('InternalCurveVenue', [pad.target])
  await (await pad.setVenue(venue.target)).wait()
  await (await hubUsd.setAgent(pad.target)).wait()
  await (await hubMessenger.register(pad.target)).wait()

  const chains = []
  for (const c of CHAINS) {
    const messenger = await ethers.deployContract('LayerZeroOmniMessenger', [endpoint.target, EID(c.label)])
    await (await endpoint.registerAdapter(messenger.target, EID(c.label))).wait()
    await (await funder.sendTransaction({ to: messenger.target, value: ethers.parseEther('1') })).wait()

    const usd = await ethers.deployContract('OmniUSD', [c.label])
    const gateway = await ethers.deployContract('SpawnGateway', [
      messenger.target,
      usd.target,
      c.label,
      pad.target,
    ])
    await (await usd.setAgent(gateway.target)).wait()
    await (await messenger.register(gateway.target)).wait()
    await (await pad.setGateway(c.label, gateway.target)).wait()

    // spoke <-> hub routes (spokes never talk to each other; the pad relays)
    await (await messenger.setRoute(0, EID(0), b32(hubMessenger.target))).wait()
    await (await hubMessenger.setRoute(c.label, EID(c.label), b32(messenger.target))).wait()
    chains.push({ ...c, usd, gateway, messenger })
  }

  async function deliverAll() {
    while ((await endpoint.pending()) > 0n) await (await endpoint.deliverAll(32)).wait()
  }

  return { endpoint, hubMessenger, hubUsd, pad, venue, chains, deliverAll }
}

module.exports = { deployWorld, deployWorldAsync, CHAINS }
