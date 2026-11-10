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

The testnet cuts corners that mainnet cannot:

- **Real settlement money.** OmniUSD is a faucet-minted mock. Mainnet settles
  in real USDC, moved by Circle CCTP (the OmniUSD/CCTP slot in the design).
  No mock, no faucet, no agent mint.
- **Price discovery on indexed rails.** The internal curve works, but mainnet
  visibility (Axiom, Dexscreener, bots) comes from launching the hub curve on
  already-indexed venues — Raydium LaunchLab / Meteora DBC on a Solana hub.
  The `ICurveVenue` interface exists precisely for this swap.
- **Keys stop being an EOA.** Every admin function moves behind a multisig
  (Safe) + timelock. The deployer EOA owning the pad is a testnet convenience
  and a mainnet rug-vector.
- **Circuit breakers.** Pause switch, per-token and global rate limits on
  bridge messages, invariant checks (Σ replica supplies ≡ hub accounting).
- **Test depth.** Unit tests are not audit-grade. Needed: Foundry fuzz +
  invariant suites, fork tests against real LayerZero endpoints, failure
  injection (lost messages, reorgs, gas spikes).
- **Indexing.** The frontend's raw `eth_getLogs` scanning does not scale to
  mainnet. A proper indexer (subgraph or small backend) + paid RPC endpoints.

## Phase 2 — security (external, costs real money)

| Step | Cost (order of magnitude) | Notes |
|---|---|---|
| Internal review freeze + spec doc | free | Claude writes the spec auditors need |
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
