/** Upstream RPC, chain id and local anvil port of each forkable mainnet —
 * shared by hardhat.config.js (the `fork` network), scripts/fork-run.js and
 * scripts/lib-fork.js (the five-chain rehearsal, scripts/fork-rehearsal.js).
 *
 * `url` is the default upstream, `alt` the fallbacks scripts/lib-fork.js
 * probes when it does not answer. An anvil fork pins ITS block and asks the
 * upstream for every account and storage slot it has not seen yet, at that
 * block, for as long as the rehearsal runs — a public node that only serves
 * the last few minutes of state (BSC publicnode: "Archive requests require a
 * personal token") breaks the deploy halfway. Probed 2026-11-13: Blast's
 * public endpoints and dRPC (Ethereum) serve state thousands of blocks back;
 * BSC dataseed, 1rpc, meowrpc, ankr, blockpi, llamarpc do not (or need a key).
 * FORK_RPC_<NET>=https://… overrides the choice (FORK_RPC for fork-run.js). */
module.exports = {
  base: { url: 'https://mainnet.base.org', chainId: 8453, port: 8546 },
  optimism: { url: 'https://mainnet.optimism.io', chainId: 10, port: 8547 },
  arbitrum: { url: 'https://arb1.arbitrum.io/rpc', chainId: 42161, port: 8548 },
  ethereum: {
    url: 'https://eth-mainnet.public.blastapi.io',
    alt: ['https://eth.drpc.org', 'https://ethereum-rpc.publicnode.com'],
    chainId: 1,
    port: 8549,
  },
  // the TESTNET hub, for the Solana rehearsal (scripts/add-solana.sh testnet)
  baseSepolia: { url: 'https://sepolia.base.org', chainId: 84532, port: 8551 },
  bnb: {
    url: 'https://bsc-mainnet.public.blastapi.io',
    alt: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'],
    chainId: 56,
    port: 8550,
  },
}
