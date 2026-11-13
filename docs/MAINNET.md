# Road to mainnet

The testnet beta proved the concept over real public chains and live LayerZero:
one token, one global supply, one price, traded cross-chain by anyone. Mainnet
is a different sport — real money, irreversible mistakes, regulators. This is
the honest path, in order. Nothing here is optional; the order is the point.

## Phase 0 — finish the testnet (in progress)

| Item | Owner | Status |
|---|---|---|
| Hub + Optimism + Arbitrum legs live, visitor flow end-to-end | done | ✅ |
| Ethereum Sepolia + BNB testnet legs (auto-deploy armed, waiting on faucet fuel) | user: 2 faucet claims | ⏳ |
| Real wallet support (MetaMask/injected) next to the burner | Claude | ✅ |
| Holder fee distribution (per-chain dividend pools, local claims) | Claude | ✅ v3 deployed |
| Solana leg (Rust/Anchor program against the LayerZero Solana endpoint) | Claude, multi-day | ⏳ |

## Phase 1 — make the protocol mainnet-shaped (code, free)

The testnet cut corners that mainnet cannot. Protocol v7 (details and proofs
in [SPEC.md](SPEC.md)) closed the ones that are contract code, and a fourth
chantier built and proved the tooling that deploys and operates it
([RUNBOOK.md](RUNBOOK.md)). **v7.0 was deployed on mainnet (Base + Optimism
+ Arbitrum) and retired the same day** after finding F-11 (SPEC §3): it is
closed on chain (gateways paused, caps 0, exits open; state in
`contracts/deployments/mainnet-v7_0.retired.json`). **v7.1** fixes F-11,
adds slippage-protected local trades and `resync`, and is deployed fresh —
as **three separate universes**: the core (Base hub + Optimism + Arbitrum,
USDC), BNB Chain alone (USDT, 18 decimals), Ethereum alone (USDC); Ethereum
is deliberately not a leg of the core (an L1 SYNC on every launch, forever —
[the cost table](MAINNET-ADDRESSES.md#what-an-ethereum-leg-costs--measured-2026-11-13)).
What is proven only on forks of the real chains, and what is not proven at
all until a live run, is listed at the end of the runbook.

| Corner | Status | What exists now |
|---|---|---|
| **Real settlement money** | ✅ code (v7 M1) | `OmniUSD` is a 1:1 USDC vault on every user-facing chain, a pure ledger on the hub; no faucet. Payouts never revert (USDC, or an oUSD claim when a vault is short). Vault-to-vault rebalancing through Circle CCTP V2. Testnets run the same contract over a mock USDC |
| **Users pay for messages** | ✅ code (v7 M2) | every action attaches its quoted LayerZero fee, replies included; the hub tank funds itself from prepaid reply budgets. The hub chain (Base) trades locally with no LayerZero message at all |
| **Keys stop being an EOA** | ✅ code (v7 M3) + script (M4) — not run live | three roles on every contract: admin (two-step, a 48 h `TimelockController` owned by a Safe), operator (prices, limits, unpause), guardian (pause, and the timelock's canceller). `scripts/handover.js` performs the hand-over per chain and reads it back; run on a Base mainnet fork, after which a DVN change was only executable through the timelock after the delay. **Still to do at deploy time:** the owner creates the Safe(s) and names a guardian key |
| **Circuit breakers** | ✅ pause · ⏳ rate limits | the guardian can stop NEW exposure (spawns, buys, deposits) on the pad, each gateway and each vault; exits (sell, claim, pull, unwrap) have no switch. Deposit caps per vault. Not built: per-token / global message rate limits |
| **No free rides on the hub tank** | ✅ code (v7 M3) | holder fees accrue on the hub and are pulled to a chain by a user-paid message; every remote message the hub sends is prepaid |
| **A message never strands a user's value** | ✅ code (v7 M3) | the hub refuses with a refund instead of reverting; a gateway parks what it cannot settle yet. Four real stranding bugs found and fixed on the way (SPEC §12, F-7 to F-10) |
| **LayerZero DVN set** | ✅ chosen + script (M4) — not set live | required LayerZero Labs + Google, optional 1 of Horizen / Twinstake (fee table and addresses in [MAINNET-ADDRESSES.md](MAINNET-ADDRESSES.md)). `scripts/configure-dvn.js` pins both libraries, configures both directions, reads back, and verifies both ends of every pathway cross-chain. On forks of Base and Optimism the real libraries accepted it and a reply fell from 0.000629 to 0.000127 ETH |
| **Price discovery on indexed rails** | ⏳ not started | the internal curve works, but mainnet visibility (Axiom, Dexscreener, bots) comes from launching the hub curve on already-indexed venues — Raydium LaunchLab / Meteora DBC on a Solana hub. The `ICurveVenue` interface exists for this swap, and the pad now survives a venue that refuses a trade |
| **Test depth** | ⏳ partial | **215 hardhat tests** incl. exact-equality invariants (global USDC backing, pad solvency through random trades, hub tank never dips), the deploy/ops tooling end to end for the three universes (18- and 6-decimal dollars, canary with the `*Min` refusal, hand-over, caps, a failed SYNC seen and repaired), and a contract-size guard; **16 mainnet-fork tests** (`npm run test:fork`) against the real EndpointV2, real USDC and real CCTP V2 on Base and Optimism; a full CLI rehearsal of the core on a Base fork (`npm run rehearse`); the two owner wrappers run end to end against forks of **BNB Chain** (real USDT) and **Ethereum** (real USDC) as the real deployer, with zero LayerZero packets (`npm run rehearse:bnb`, `rehearse:ethereum`, 7 assertions each). Still needed: Foundry fuzz + invariant suites, failure injection, a fork run on Arbitrum, and everything only a live network can show (RUNBOOK, last section) |
| **Frontend** | ⏳ next chantier | the site still speaks v6: it needs USDC approvals, quoted fees, the pull-and-claim flow for holder fees, parked-delivery claims, and a MAINNET mode without faucet or burner |
| **Deploy tooling** | ✅ (M4, v7.1 universes) | one profile-driven, resumable, idempotent deploy for testnets and the three mainnet universes; a preflight that re-derives every external address from the live chain (the dollar's symbol / decimals / supply, Circle's minter where USDC, the deployer's budget at the live gas price) and refuses to deploy otherwise; dry by default on mainnet; a self-check that reads every wired value back (hard failure on a remote gateway at `tradeLegs = 0`); hand-over, DVN, fee-tuning, holder-fee keeper, CCTP relay, `resync`, `set-cap` and status scripts; **two lines per universe for the owner** — `bash scripts/launch.sh <universe>` then `bash scripts/finish.sh <universe>` ([RUNBOOK.md](RUNBOOK.md) §3); the manifest tells the site the universe and its dollar |
| **Indexing** | ⏳ not started | the frontend's raw `eth_getLogs` scanning does not scale to mainnet. A proper indexer (subgraph or small backend) + paid RPC endpoints |
| **Solana leg** | ⏳ not on devnet | must adopt the v7 fee model and op 5 before it can be a mainnet leg (solana/NOTES.md) |

## Phase 2 — security (external, costs real money)

| Step | Cost (order of magnitude) | Notes |
|---|---|---|
| Internal review freeze + spec doc | free | ✅ done — [SPEC.md](SPEC.md) (message catalog, invariants, trust model, findings) |
| Audit contest (Code4rena / Sherlock / Cantina) | $15k–40k | wide coverage, finds the weird stuff |
| Solo auditor or boutique firm pass | $10k–50k | deep pass on bridge + curve math |
| Public bug bounty (Immunefi) | % of TVL at risk | live before meaningful funds arrive |

A bridge-and-launchpad protocol holds user money on six chains. Shipping it
unaudited is how projects end up as post-mortems. **No mainnet deploy before
at least one serious external review.**

## Phase 3 — legal (user + a lawyer, before launch)

- The EU's MiCA regime covers token launchpads and fee-collecting crypto
  services. A French resident operating one needs real legal advice (PSAN/MiCA
  qualification, entity structure, tax on protocol fees).
- Terms of service, risk disclosures, and a decision on geo-blocking.
- This phase runs in parallel with Phase 2 — a lawyer consult is cheap
  compared to discovering the answer afterwards.

## Phase 4 — launch ops

- Mainnet deploy gas, per universe, on the deployer
  `0x483E931A279B136A2C3fCA6BF5eC2c4239c1B904`: **core** (Base hub +
  Optimism + Arbitrum) **0.005 + 0.002 + 0.002 ETH** (measured ~0.0034 ETH
  in all at 2026-11-13 gas prices, 0.003 of it the hub's gas-tank float);
  **bnb** **0.003 BNB** (22.4M gas ≈ 0.0011 BNB at 0.05 gwei); **ethereum**
  priced live — **0.02 ETH** is comfortable under 0.5 gwei (the deploy is
  17.1M gas + 2.3M hand-over; at 30 gwei it would be 0.6 ETH: wait for a
  quiet day). Plus ~5 of the universe's dollar on each chain for the canary
  (today only Ethereum has none: 0 ETH, 0 USDC). `npm run budget`,
  `budget:bnb`, `budget:ethereum`.
- The hub tank funds itself from prepaid reply budgets; spokes need none.
  Monitoring: `scripts/status.js` from cron — global backing, tanks, pauses,
  roles, verifier sets (exit code 1 when backing fails).
- Domain, X account, docs site, litepaper (drafts live in this repo).
- Staged rollout: caps on curve size for the first weeks, bounty live,
  multisig signers confirmed, incident runbook written.

## Who does what, summarized

**Claude (free, already underway):** wallet support, holder distribution,
Solana leg, USDC/CCTP + venue adapters, hardening + test depth, specs and
docs, deploy tooling, monitoring.

**User (the parts no one can do for you):** the two testnet faucet claims,
audit budget decision (~$25k–90k all-in for a serious pass), a MiCA lawyer
consult, domain + X account, mainnet gas money, and the go/no-go calls.

**External:** auditors, lawyer.
