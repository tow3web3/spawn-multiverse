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

module.exports = { deployWorld, CHAINS }
