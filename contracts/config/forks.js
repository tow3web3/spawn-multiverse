/** Upstream RPC, chain id and local anvil port of each forkable mainnet —
 * shared by hardhat.config.js (the `fork` network) and scripts/fork-run.js. */
module.exports = {
  base: { url: 'https://mainnet.base.org', chainId: 8453, port: 8546 },
  optimism: { url: 'https://mainnet.optimism.io', chainId: 10, port: 8547 },
  arbitrum: { url: 'https://arb1.arbitrum.io/rpc', chainId: 42161, port: 8548 },
  ethereum: { url: 'https://ethereum-rpc.publicnode.com', chainId: 1, port: 8549 },
}
