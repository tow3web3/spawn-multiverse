require('@nomicfoundation/hardhat-toolbox')

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
  },
  mocha: { timeout: 120_000 },
}
