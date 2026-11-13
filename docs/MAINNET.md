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

The testnet cut corners that mainnet cannot. Protocol v7 (branch
`mainnet-v7`, three chantiers; details and proofs in [SPEC.md](SPEC.md))
closed the ones that are contract code. **None of v7 is deployed anywhere
yet** — the live testnet still runs v6.

| Corner | Status | What exists now |
|---|---|---|
| **Real settlement money** | ✅ code (v7 M1) | `OmniUSD` is a 1:1 USDC vault on every user-facing chain, a pure ledger on the hub; no faucet. Payouts never revert (USDC, or an oUSD claim when a vault is short). Vault-to-vault rebalancing through Circle CCTP V2. Testnets run the same contract over a mock USDC |
| **Users pay for messages** | ✅ code (v7 M2) | every action attaches its quoted LayerZero fee, replies included; the hub tank funds itself from prepaid reply budgets. The hub chain (Base) trades locally with no LayerZero message at all |
| **Keys stop being an EOA** | ✅ code (v7 M3) — hand-over not run yet | three roles on every contract: admin (two-step, meant to be a 48–72 h `TimelockController` owned by a Safe), operator (prices, limits, unpause), guardian (pause). The hand-over to a real OpenZeppelin timelock is proved by test. **Still to do at deploy time:** create the Safe, run the hand-over, give the timelock's canceller role to an independent key |
| **Circuit breakers** | ✅ pause · ⏳ rate limits | the guardian can stop NEW exposure (spawns, buys, deposits) on the pad, each gateway and each vault; exits (sell, claim, pull, unwrap) have no switch. Deposit caps per vault. Not built: per-token / global message rate limits |
| **No free rides on the hub tank** | ✅ code (v7 M3) | holder fees accrue on the hub and are pulled to a chain by a user-paid message; every remote message the hub sends is prepaid |
| **A message never strands a user's value** | ✅ code (v7 M3) | the hub refuses with a refund instead of reverting; a gateway parks what it cannot settle yet. Four real stranding bugs found and fixed on the way (SPEC §12, F-7 to F-10) |
| **LayerZero DVN set** | ⏳ deploy-time | adapters name the admin as delegate, so the set CAN be chosen; it must be, per pathway and on both sides (the default set costs ~5× more per message — MAINNET-ADDRESSES.md) |
| **Price discovery on indexed rails** | ⏳ not started | the internal curve works, but mainnet visibility (Axiom, Dexscreener, bots) comes from launching the hub curve on already-indexed venues — Raydium LaunchLab / Meteora DBC on a Solana hub. The `ICurveVenue` interface exists for this swap, and the pad now survives a venue that refuses a trade |
| **Test depth** | ⏳ partial | 106 hardhat tests incl. exact-equality invariants (global USDC backing, pad solvency through random trades, hub tank never dips). Still needed: Foundry fuzz + invariant suites, fork tests against the real LayerZero endpoints and Circle contracts, failure injection |
| **Frontend** | ⏳ next chantier | the site still speaks v6: it needs USDC approvals, quoted fees, the pull-and-claim flow for holder fees, parked-delivery claims, and a MAINNET mode without faucet or burner |
| **Deploy tooling** | ⏳ next chantier | mainnet network config with on-chain-verified external addresses, the timelock hand-over script, DVN configuration, a fee-tuning routine for reply budgets |
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

- Mainnet deploy gas across the EVM legs + Solana: a few hundred dollars.
- LayerZero fee tanks funded with real ETH/BNB/SOL; monitoring + alerts on
  tank levels, message failures, invariant drift.
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
