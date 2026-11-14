/**
 * Smoke test of a LIVE deployment, v7.2 paths end to end — the testnet dress
 * rehearsal and the mainnet CANARY are the same script.
 *
 *   npx hardhat run scripts/smoke.js --network baseSepolia       # the hub chain (local trading) — launches the canary token
 *   npx hardhat run scripts/smoke.js --network optimismSepolia   # a remote chain — reuses it
 *
 *   # mainnet canary — a few REAL dollars from the signer's own wallet
 *   SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY SMOKE_BUY_USDC=3 \
 *     npx hardhat run scripts/smoke.js --network base
 *
 * ONE canary token for the universe: the HUB chain's canary launches it in
 * one local transaction (its SYNC fans out to every spoke); every spoke's
 * canary then REUSES it — a round trip from that spoke, on its own vault and
 * its own verifier pathway:
 *   - if the launch skipped this chain (Ethereum above its launch ceiling),
 *     or the chain joined later, the canary OPENS the token here first
 *     (`openToken`, it pays the hub's SYNC back);
 *   - buys with this chain's dollar (USDC — or USDT on BNB Chain, every
 *     amount through the token's own decimals), sells half, the PAYOUT must
 *     come home in that dollar;
 *   - pulls this chain's holder fees home, claims them from the local pool;
 *   - on BNB Chain, MOVES half of that claim to the hub chain, where it must
 *     arrive in USDC (`moveClaim` — the portable claim of v7.2);
 *   - unwraps what is left.
 * Expect minutes, not seconds.
 *
 * SLIPPAGE: every trade goes through `buyTokenUsdcMin` / `sellTokenMin` with
 * a real minimum computed from the curve (1% tolerance at home, 5% across
 * chains — the minimum rides the wire and the hub enforces it). The
 * protection is PROVED first: on the hub chain an impossible minimum reverts
 * the whole call ("GW: min out", simulated, free); from a spoke a real $1
 * order with an impossible minimum must be REFUSED by the hub (Refused,
 * reason 6) and its dollars must come home whole.
 *
 * BUDGET: a chain with a `canaryBudget` in the profile (Ethereum) first
 * prices a round trip at the LIVE gas price against what the deployer holds
 * there. If it cannot afford it, it says so plainly, sends nothing and exits
 * with code 4 — launch.sh goes on with the other chains, and that chain's
 * vault stays at the canary cap until its canary passes.
 *
 * Fees: when the gateway is not sponsored (always on mainnet) the script
 * attaches the exact `quote*` fee to every call, like a user would.
 */
const { network } = require('hardhat')
const { getProfile, netKeyOf, dollarOfNet } = require('../config/profiles')
const { MAINNET_CONFIRM, isDevNode, cliSigner } = require('./lib-net')
const { smoke } = require('./lib-smoke')

async function main() {
  const profile = getProfile(network.name)
  const net = netKeyOf(network.name)
  // the deployer key — or, on a fork only, the address it impersonates
  const signer = await cliSigner()
  if (profile.mainnet && !(await isDevNode(signer.provider)) && process.env.SPAWN_MAINNET_CONFIRM !== MAINNET_CONFIRM) {
    throw new Error(`mainnet canary: real ${dollarOfNet(profile, net).symbol} and real fees — set SPAWN_MAINNET_CONFIRM=${MAINNET_CONFIRM}`)
  }
  const res = await smoke({
    profile,
    netKey: net,
    signer,
    buy: profile.mockUsdc ? undefined : process.env.SMOKE_BUY_USDC ? Number(process.env.SMOKE_BUY_USDC) : undefined,
    pollMs: process.env.SMOKE_POLL_MS ? Number(process.env.SMOKE_POLL_MS) : undefined,
  })
  if (res.skipped) process.exit(4)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
