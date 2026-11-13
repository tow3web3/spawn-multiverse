require('@nomicfoundation/hardhat-toolbox')
const fs = require('fs')

/** Deployer key from contracts/.env (gitignored). `name` selects the line:
 * DEPLOYER_PK for testnets; mainnet networks prefer MAINNET_DEPLOYER_PK and
 * fall back to DEPLOYER_PK (the same deployer address on every chain). */
function envKey(name) {
  try {
    const m = fs.readFileSync(`${__dirname}/.env`, 'utf8').match(new RegExp(`^${name}=(0x[0-9a-fA-F]{64})`, 'm'))
    return m ? [m[1]] : []
  } catch {
    return []
  }
}
const deployerAccounts = () => envKey('DEPLOYER_PK')
const mainnetAccounts = () => {
  const k = envKey('MAINNET_DEPLOYER_PK')
  return k.length ? k : envKey('DEPLOYER_PK')
}

/**
 * Mainnet FORK mode, for test-fork/. Hardhat's own EVM (EDR 0.12) cannot
 * execute on a fork of Base / Optimism / Arbitrum ("No known hardfork for
 * execution on historical block…", whatever `chains` history is given), so
 * the fork node is Foundry's `anvil`, started on a private port by
 * scripts/fork-run.js, and hardhat talks to it as the `fork` network:
 *
 *   node scripts/fork-run.js base        # = anvil fork + hardhat test --network fork
 *   node scripts/fork-run.js optimism
 *
 * Read-only against the live chain: every transaction happens in anvil's
 * memory. Port 8546+ (never 8545). FORK_RPC overrides the upstream RPC (it
 * must serve historical state — the official public RPCs below do).
 */
const FORKS = require('./config/forks')
const fork = FORKS[process.env.FORK]
if (process.env.FORK && !fork) throw new Error(`unknown FORK "${process.env.FORK}" (${Object.keys(FORKS).join(' | ')})`)

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
  },
  networks: {
    hardhat: {
      // Spawning stores token metadata (image data URL) on-chain in the local
      // demo, so give blocks plenty of room.
      blockGasLimit: 120_000_000,
      // the 24,576-byte runtime limit is enforced, as on every target chain
      allowUnlimitedContractSize: false,
    },
    // the anvil mainnet fork of FORK=… (see above) — its unlocked dev accounts sign
    ...(fork
      ? {
          fork: {
            url: `http://127.0.0.1:${process.env.FORK_PORT ?? fork.port}`,
            chainId: fork.chainId,
            timeout: 300_000,
          },
        }
      : {}),
    localhost: {
      url: 'http://127.0.0.1:8545',
      timeout: 120_000,
    },
    // Public testnets (free faucet gas). Hub: Base Sepolia.
    baseSepolia: {
      url: 'https://sepolia.base.org',
      chainId: 84532,
      accounts: deployerAccounts(),
    },
    optimismSepolia: {
      url: 'https://sepolia.optimism.io',
      chainId: 11155420,
      accounts: deployerAccounts(),
    },
    arbitrumSepolia: {
      url: 'https://sepolia-rollup.arbitrum.io/rpc',
      chainId: 421614,
      accounts: deployerAccounts(),
    },
    ethereumSepolia: {
      url: 'https://ethereum-sepolia-rpc.publicnode.com',
      chainId: 11155111,
      accounts: deployerAccounts(),
    },
    bnbTestnet: {
      url: 'https://bsc-testnet-rpc.publicnode.com',
      chainId: 97,
      accounts: deployerAccounts(),
    },
    // MAINNETS — real money. scripts/deploy.js is DRY on these unless
    // SPAWN_MAINNET_CONFIRM is set; read docs/RUNBOOK.md first.
    base: {
      url: process.env.RPC_BASE ?? 'https://mainnet.base.org',
      chainId: 8453,
      accounts: mainnetAccounts(),
    },
    optimism: {
      url: process.env.RPC_OPTIMISM ?? 'https://mainnet.optimism.io',
      chainId: 10,
      accounts: mainnetAccounts(),
    },
    arbitrum: {
      url: process.env.RPC_ARBITRUM ?? 'https://arb1.arbitrum.io/rpc',
      chainId: 42161,
      accounts: mainnetAccounts(),
    },
    ethereum: {
      url: process.env.RPC_ETHEREUM ?? 'https://ethereum-rpc.publicnode.com',
      chainId: 1,
      accounts: mainnetAccounts(),
    },
    // BNB Chain — the BNB universe (SPAWN_PROFILE=bnb), settled in BSC USDT
    bnb: {
      url: process.env.RPC_BNB ?? 'https://bsc-rpc.publicnode.com',
      chainId: 56,
      accounts: mainnetAccounts(),
    },
  },
  mocha: { timeout: fork ? 600_000 : 120_000 },
}
