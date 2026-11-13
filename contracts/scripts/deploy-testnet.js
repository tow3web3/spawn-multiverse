/**
 * Deploys SPAWN! to public testnets over the REAL LayerZero V2 endpoints.
 * Kept as the familiar entry point; it is `deploy.js` with the testnet
 * profile (config/profiles.js) — the same code path a mainnet deploy runs.
 *
 *   npx hardhat run scripts/deploy-testnet.js --network baseSepolia      # hub
 *   npx hardhat run scripts/deploy-testnet.js --network optimismSepolia  # spoke
 *   npx hardhat run scripts/deploy-testnet.js --network arbitrumSepolia  # spoke
 *   npx hardhat run scripts/deploy-testnet.js --network baseSepolia      # again: wires new spokes
 *   (then once more on each spoke when the set of spokes changed)
 *
 * Testnets run the MAINNET contracts over a MockUSDC anyone can mint, with
 * gateways SPONSORED (their adapter's tank pays) and the deployer as
 * operator and guardian — config values, not code branches:
 *
 *   SPAWN_SPONSORED=0     run a testnet the mainnet way (users attach fees)
 *   SPAWN_RETURN_UNIT=…   reply budget per leg, in ETH (default 0.00005)
 *   SPAWN_OPERATOR / SPAWN_GUARDIAN   role holders (default: the deployer)
 *
 * State from before v7 cannot be continued (the messenger interface
 * changed). Archive it and get the old gas tanks back first:
 *
 *   node scripts/archive-state.js testnet _v6_pre7 baseSepolia optimismSepolia arbitrumSepolia
 *   npx hardhat run scripts/recover-tanks.js --network baseSepolia   # and each spoke
 */
process.env.SPAWN_PROFILE = process.env.SPAWN_PROFILE ?? 'testnet'
require('./deploy')
