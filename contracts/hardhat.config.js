require('@nomicfoundation/hardhat-toolbox')
const fs = require('fs')

/** Testnet deployer key from contracts/.env (gitignored). TESTNET ONLY. */
function deployerAccounts() {
  try {
    const m = fs.readFileSync(`${__dirname}/.env`, 'utf8').match(/DEPLOYER_PK=(0x[0-9a-fA-F]{64})/)
    return m ? [m[1]] : []
  } catch {
    return []
  }
}

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
      allowUnlimitedContractSize: true,
    },
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
  },
  mocha: { timeout: 120_000 },
}
