/**
 * The testnet dress rehearsal — `smoke.js` with the testnet profile, kept as
 * the familiar entry point. See scripts/smoke.js for what it does.
 *
 *   npx hardhat run scripts/testnet-smoke.js --network optimismSepolia   # a remote chain
 *   npx hardhat run scripts/testnet-smoke.js --network baseSepolia       # the hub chain (local trading)
 */
process.env.SPAWN_PROFILE = process.env.SPAWN_PROFILE ?? 'testnet'
require('./smoke')
