/**
 * Smoke test of a LIVE deployment, v7 paths end to end — the testnet dress
 * rehearsal and the mainnet CANARY are the same script.
 *
 *   npx hardhat run scripts/smoke.js --network optimismSepolia   # a remote chain (testnet)
 *   npx hardhat run scripts/smoke.js --network baseSepolia       # the hub chain (local trading)
 *
 *   # mainnet canary — a few REAL dollars from the signer's own wallet
 *   SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY SMOKE_BUY_USDC=3 \
 *     npx hardhat run scripts/smoke.js --network base
 *
 * On a REMOTE chain it spawns a token from this spoke, waits for LayerZero
 * to land OP_SPAWN on the hub and for the replica to sync back, then:
 *   - buys with USDC (`buyTokenUsdc`). On testnets $260 inside the FAIR
 *     GENESIS window: the $250 cap clamps it and the $10 REFUND leg must
 *     come home as USDC. On mainnet SMOKE_BUY_USDC (default 3);
 *   - sells half the bag — the PAYOUT leg must come home as USDC;
 *   - pulls this chain's share of the holder fees home (`pullFees`: the hub
 *     books it and waits to be asked), claims it from the local pool and
 *     unwraps it to USDC.
 * Expect minutes, not seconds.
 *
 * On the HUB chain the same sequence runs through the loopback: every step
 * settles inside its own transaction, with no LayerZero message — only the
 * spawn's SYNC fan-out to the remote chains leaves the hub.
 *
 * Fees: when the gateway is not sponsored (always on mainnet) the script
 * attaches the exact `quote*` fee to every call, like a user would.
 * Money: testnets mint MockUSDC; on mainnet the signer must already hold
 * the universe's dollar (USDC — or USDT in the BNB universe: every amount
 * goes through the token's own decimals), and the approval is for exactly
 * what the run spends.
 *
 * SLIPPAGE (v7.1): on a LOCAL gateway (the hub chain, and the only chain of
 * a single-chain universe) the trades go through `buyTokenUsdcMin` /
 * `sellTokenMin` with a real minimum computed from the curve — and the
 * script first PROVES the protection: the same buy with a minimum no trade
 * can meet must revert "GW: min out" and move nothing. On a remote gateway
 * the reply is asynchronous, so the plain entrypoints are used (a `*Min`
 * call there always reverts — also checked).
 */
const { network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { MAINNET_CONFIRM, isDevNode, cliSigner, dollarOf } = require('./lib-net')
const { smoke } = require('./lib-smoke')

async function main() {
  const profile = getProfile(network.name)
  // the deployer key — or, on a fork only, the address it impersonates
  const signer = await cliSigner()
  if (profile.mainnet && !(await isDevNode(signer.provider)) && process.env.SPAWN_MAINNET_CONFIRM !== MAINNET_CONFIRM) {
    throw new Error(`mainnet canary: real ${dollarOf(profile)} and real fees — set SPAWN_MAINNET_CONFIRM=${MAINNET_CONFIRM}`)
  }
  await smoke({
    profile,
    netKey: netKeyOf(network.name),
    signer,
    buy: profile.mockUsdc ? undefined : Number(process.env.SMOKE_BUY_USDC ?? 3),
    pollMs: process.env.SMOKE_POLL_MS ? Number(process.env.SMOKE_POLL_MS) : undefined,
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
