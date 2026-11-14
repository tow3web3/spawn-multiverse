# Runbook — deploying and operating SPAWN! v7.2

For whoever holds the deployer key on launch day, and whoever is on call
after it. Every command runs from `contracts/`. Nothing here is improvised:
each step is a script that was run end to end against forks of the five real
chains (`npm run rehearse` — §3), and each step ends with a check that must
pass before the next one starts.

**ONE universe, six chains** (owner's decision, 2026-11-14). One hub — the
pad on Base — one market per token, one set of books. Five EVM chains launch
together; Solana (label 1, reserved) joins later through its own program
(`solana/`):

| Chain | Label | Role | Dollar | Vault | Launch cap | Gas |
|---|---|---|---|---|---|---|
| Base | 3 | hub (pad, curve, ledger) + its own gateway (local trades, one tx) | Circle USDC (6 dec.) | `OmniUSD`, CCTP peer of the other USDC vaults | 25,000 USDC | ETH |
| Optimism | 6 | spoke | Circle USDC | `OmniUSD`, CCTP | 25,000 USDC | ETH |
| Arbitrum One | 5 | spoke | Circle USDC | `OmniUSD`, CCTP | 25,000 USDC | ETH |
| Ethereum | 2 | spoke, behind a **launch ceiling** (`syncCap`) | Circle USDC | `OmniUSD`, CCTP | 25,000 USDC | ETH (L1) |
| BNB Chain | 4 | spoke | Binance-Peg USDT (18 dec.) | `OmniUSDLocal`: no CCTP, no peer, no `wrap` | **10,000 USDT** | BNB |

One profile (`config/profiles.js` → `mainnet`), one state file
(`deployments/mainnet.json`), one manifest (`public/onchain/mainnet.json`).
The single-chain `bnb` and `ethereum` universes of v7.1 are retired
([BNB-UNIVERSE.md](BNB-UNIVERSE.md)).

**The hold.** `deployments/HOLD-MAINNET` makes `launch.sh` refuse to run on
mainnet. It stays until v7.2 is final (the contract round in progress), has
passed its tests, the fork rehearsal and a testnet run. Fork rehearsals pass
`SPAWN_IGNORE_HOLD=1` (they send nothing to a live chain).

**What only exists on forks so far:** see [the last section](#what-is-proven-and-what-is-not).

## 0. Before launch day

| Need | Who | Detail |
|---|---|---|
| Gas on the deployer `0x483E931A279B136A2C3fCA6BF5eC2c4239c1B904` | owner | the preflight floors: Base **0.005 ETH** (0.003 of it is the hub gas-tank float), Optimism **0.002**, Arbitrum **0.002**, BNB Chain **0.003 BNB**; Ethereum is priced LIVE: 2 × ~12M gas at the current gas price (0.0046 ETH at 0.19 gwei) — fund **0.02 ETH for the deploy** and launch on a quiet day. `npm run budget` re-estimates all five live |
| Canary money on the deployer | owner | ~5 USDC on Base, Optimism, Arbitrum; **~5 USDT on BNB Chain**; on Ethereum **5 USDC and ~0.02 ETH more** for its round trip (the Ethereum canary checks the live price first and says so if it cannot afford it — §2) |
| OWNER address | owner | a Safe (https://app.safe.global) on **each** chain, or `contracts/.env.owner` — it becomes proposer/executor of every chain's 48h timelock |
| The deployer key | owner | `MAINNET_DEPLOYER_PK=0x…` in `contracts/.env` (falls back to `DEPLOYER_PK`). It stays operator + guardian after the hand-over (a hot key that tunes and pauses, never rewires) |
| Go / no-go | owner | after the fork rehearsal (§3) passes from the commit that will run, and a testnet run (§4) |

## 1. The two commands

The owner pastes these, one after the other, from `contracts/`:

```bash
bash scripts/launch.sh
bash scripts/finish.sh
```

Each stops at the first step that does not end the way this runbook says,
prints the tail of its log and `➜ Écris « fait » à Claude : il lira ce
journal.` Every step is idempotent: after a fix, the SAME command runs
again; finished steps send nothing, a canary that passed is not repeated
(its mark is bound to the gateway it proved: a redeploy never inherits one).

### `launch.sh` — deployed and proven, not open

| # | Step | Ends with |
|---|---|---|
| 0 | read-only preflight on the five chains (`scripts/preflight.js`): chain ids, `EndpointV2.eid()`, Circle USDC (symbol, decimals, `isMinter(TokenMessengerV2.localMinter())`, CCTP domain) on the four USDC chains, BSC USDT (symbol, decimals, supply bound) and NO CCTP plumbing on the BNB vault, the deployer's budget; and every verifier of every pathway quoting it, from its source chain | `✓ every external address re-derived` |
| 1 | deploy: Base, the four spokes, Base again, the four spokes again — every vault opens at the **canary cap** (100 of its own dollar) | each run `✓ … matches the plan` |
| 2 | our verifier set on every pathway (`configure-dvn.js` ×5), then both ends of every pathway cross-checked | `both ends name the configured verifier set` |
| 3 | prices from live quotes (`tune-fees.js`): the four spokes, then Base — twice, so the ceilings settle; then Base's wiring read back | the self-check incl. the request-ceiling rule |
| 4 | canaries, with the deployer's own money (§2): Base, then Optimism, Arbitrum, Ethereum, BNB Chain | `🎉` per chain, or `CANARY NOT AFFORDABLE` for Ethereum |
| 5 | `status.js` | `✓ backing holds` |

What the deploy wires, per chain, in a safe order:

- **Base (hub):** pad + curve + ledger oUSD; the local USDC vault, gateway and
  holder pool (reached by the adapter's loopback); `syncCap` for every chain
  that has one in the profile (Ethereum) — **before** its gateway is known to
  the pad; for each spoke whose own run finished: the route, the executor
  gas toward it, then `pad.setGateway`; the hub gateway's `openLegs = 0` (an
  open there is a local call); `pad.setRequestCap` for every remote chain
  (set to what a request toward it prepays — below); `moveLegs` toward every
  other chain; CCTP peers toward the three other USDC vaults.
- **A spoke:** adapter, vault (`OmniUSD` over USDC, or `OmniUSDLocal` over
  USDT on BNB Chain), gateway, holder pool; its route to Base and the
  hub-bound executor gas; `tradeLegs = 1`, `spawnLegs` (one per remote chain
  with no ceiling, at least); `moveLegs` toward every other deployed chain
  (never under what the pad lets a request toward it cost); CCTP peers
  toward the other USDC vaults — **never** BNB Chain's, and BNB's vault names
  none.
- **Refused, loudly** (deploy, self-check and status): any state in which a
  USDC vault names the USDT vault's label as a CCTP peer (`✗✗ REFUSED`).

### `finish.sh` — handed over and open

1. Any chain whose canary has not passed yet (Ethereum, if launch found it
   unaffordable) is tried once more; if it still cannot, that vault simply
   keeps the canary cap and the script says so.
2. Hand-over on every chain (`handover.js`): a `TimelockController` per
   chain, 48h, OWNER proposer + executor + canceller; every contract's admin
   = that timelock; the LayerZero delegate (who picks the verifiers) = the
   timelock; operator + guardian = the deployer hot key; the deployer
   renounces everything else. OWNER must be proven: its key in
   `contracts/.env.owner`, or one transaction already sent from it on Base.
3. `status`.
4. The **launch caps**, each chain in its own dollar: 25,000 USDC for each
   USDC vault, **10,000 USDT for BNB Chain** — the BNB cap is what bounds
   everyone's exposure to a USDT de-peg, so it is its own setting
   (`launchCap` in the profile, `SPAWN_LAUNCH_CAP_<NET>=` overrides). A chain
   whose canary has not passed stays at the canary cap.
5. `status`.

Then: `➜ Écris « fait » à Claude.` — the site is pointed at the manifest only
after the timelocks have been checked.

## 2. The canaries

**One canary token for the universe.** The Base canary launches it locally
(one transaction; its SYNC fans out to the spokes) and trades through the
slippage-protected `buyTokenUsdcMin` / `sellTokenMin` after PROVING that an
impossible minimum is refused (`GW: min out`). Every spoke's canary REUSES
that token — a round trip on that spoke's own vault and its own verifier
pathway: buy with its dollar, the DELIVER comes back; sell half, the PAYOUT
must come back in its dollar; pull this chain's holder fees, claim them,
unwrap.

- **BNB Chain:** USDT in, USDT out (every amount through 18 decimals), then
  half of the claimed holder fees MOVED to Base with `moveClaim` — it must
  arrive there in USDC, to the wei (the portable claim of v7.2, at the
  cheapest place to prove it).
- **Ethereum:** if the launch skipped it (its SYNC was above the launch
  ceiling — `SyncFailed` on the hub), the canary OPENS the token there first
  (`openToken`, paying the hub's SYNC back). Before anything, it prices the
  whole round trip at the live gas price against what the deployer holds and
  against the 0.02 ETH set aside (`canaryBudget`); if it cannot afford it, it
  prints `✗ CANARY NOT AFFORDABLE on ethereum: …`, sends nothing, exits 4,
  and `launch.sh` goes on with the other chains.
- **Cross-chain slippage protection:** each spoke canary asks its gateway
  whether `buyTokenUsdcMin` covers a cross-chain trade (contract round 2 makes
  it so) and uses it with a 5% tolerance when it does; with round-1 contracts
  it proves the remote `*Min` refuses and trades with the plain functions.
- FAIR GENESIS caps a wallet at $250 across all chains in a token's first
  10 minutes and taxes those buys (up to 29%, paid to the token's holders /
  dev — the deployer): the canaries buy 3 dollars each (2 on Ethereum).

## 3. Fork rehearsal — the two commands against forks of the five chains

```bash
node scripts/fork-rehearsal.js        # or: npm run rehearse
```

About 7 minutes on a laptop (most of it the forks fetching
state from public RPCs). It starts five anvil forks (Base, Optimism,
Arbitrum, Ethereum, BNB Chain — ports 8546–8550, pinned to a recent block),
mints the canary dollars on them (Circle's minter, the BEP20 owner), runs
`bash scripts/launch.sh` then `bash scripts/finish.sh` **exactly as the owner
will** — as the real deployer address, impersonated (no key signs anything)
— with a relay carrying every LayerZero packet between the forks through the
REAL `EndpointV2` of each chain, then asserts the end state from the chains
and measures (§11). Logs, state, manifest and `report.json` go to a temp dir
it prints; the repo's files are not touched.

The one shortcut: a fork has no DVN signatures, so the relay calls
`endpoint.verify` AS the adapter's pinned receive library. Everything after —
the endpoint's `lzReceive`, the adapters, the executor's gas limit and the
native value it delivers — is the real path; a message that needs more gas
than its sender bought fails there as it would on the chain.

By default the rehearsal forces Ethereum's launch ceiling below the live
price (`SPAWN_SYNC_CAP_ETHEREUM=0.0000001`) so that launches skip Ethereum and
its canary must open the token; `SPAWN_SYNC_CAP_ETHEREUM=0.0003 node
scripts/fork-rehearsal.js` rehearses the profile's own value. `FORK_MEASURE=0`
skips the measurements (about 5 minutes then: launch.sh ≈ 3.5, finish.sh ≈ 0.7).
`FORK_RPC_<NET>=https://…` picks another upstream for one chain.

## 4. Testnet run (the same five-chain shape, play money)

```bash
bash scripts/launch.sh testnet
bash scripts/finish.sh testnet
```

Base Sepolia (hub), Optimism Sepolia, Arbitrum Sepolia, and — when the
deployer holds gas there — Ethereum Sepolia (with its launch ceiling) and
BNB testnet (an `OmniUSDLocal` vault over an 18-decimal mock USDT). A chain
where the deployer has no gas is left out of the run (`SPAWN_SKIP`) and can
be added later with `add-chain.sh`. LayerZero's default verifiers, sponsored
gateways, mock dollars anyone can mint, timelocks with no delay.
`deployments/testnet.json` holds the live v7.1 testnet: a generation is
never resumed, so the first run stops and prints the archive line to paste
(`node scripts/archive-state.js testnet _v71_pre72 <net>`), after which v7.2
deploys fresh beside it (its tanks: `scripts/recover-tanks.js`).

## 5. Prices — what `tune-fees.js` sets, and why

Every figure is in Base ETH (hub-native): what users prepay INTO the hub
tank, against what the hub pays to answer them. `tune-fees.js` runs on each
spoke, then on Base (the wrappers run that order twice); 25% margin over the
live quote (`SPAWN_FEE_MARGIN`), 5% tolerance before it sends anything.

| What | Where | Rule |
|---|---|---|
| `returnUnit(hub)` | each spoke adapter | the hub's DELIVER quote toward this chain + margin |
| `spawnLegs` | each gateway | legs × unit ≥ Σ of the SYNC quotes toward every chain a launch from here reaches RIGHT NOW + margin. A chain over its launch ceiling is left out (Ethereum while dear); for the launcher's own chain the ceiling is the larger of `syncCap` and `requestCap` (the pad's rule) |
| `returnUnit(0)` | Base adapter | Σ of the SYNC quotes a local launch sends + margin ÷ its spawnLegs |
| `openLegs` | each spoke gateway | an open from here prepays the worst SYNC toward here + margin. 0 is a HARD failure (the tank would pay every open); the hub's own gateway is 0 (a local call) |
| `moveLegs[D]` | every gateway, toward every other chain | a move toward D prepays the dearer of D's worst SYNC and its PAYOUT + margin (both answer to `requestCap[D]`), never under `tradeLegs` (the way home); toward Base: `tradeLegs`. A destination that cannot be covered within the contract's 4,096 legs is closed (0) |
| `requestCap[D]` | the pad, LAST | the smallest prepay of any open from D or move toward D, read from every chain |
| `syncCap` | the pad | the profile's launch ceiling (Ethereum, `SPAWN_SYNC_CAP_ETHEREUM`); 0 elsewhere |
| hub-bound gas | each spoke adapter | `hubGasFor(profile, remote chains, ceilings)` — the worst admitted spawn, measured (§11), never lowered here |
| per-op gas | every adapter | **seam for contract round 2** (`setGasForOp(label, op, gas)`, assumed name — `scripts/lib-ops.js`, `OP_GAS_SETTER`): set when the adapter has it, else said and skipped |

**The rule the tank lives by** (verified by `status.js` and Base's
self-check from on-chain values on every chain): for every remote chain D,
`requestCap[D] ≤ min(open(D), move(S → D) for every S with a route)` where
`open(D) = D.openLegs × D.returnUnit(0)` and `move(S → D) = max(S.moveLegs[D],
S.tradeLegs) × S.returnUnit(0)` — the tank never fronts more than a request
brought; and each of those prepays covers the live price. `tune-fees.js`
never lowers a prepay below the CURRENT ceiling: the ceiling comes down
first, on Base's run, and the next spoke run follows.

**The Ethereum ceiling.** `syncCap(ethereum)` = 0.0003 ETH (about a dollar):
while an Ethereum SYNC costs more, launches skip Ethereum (`SyncFailed` on
the hub) and a token is opened there later by whoever wants it there
(`openToken` on Ethereum, which prepays the SYNC in Ethereum's units under
`requestCap`), or by anyone paying a `resync` on Base. Measured on the forks
(our verifier set, the fork block's gas): an Ethereum SYNC costs
0.00104 ETH (the worst SYNC, at the fork block's L1 price) — about 3.5× the ceiling, so at that price launches SKIP Ethereum and every token is opened there by whoever wants it (an open from Ethereum prepaid 0.0035 ETH in the rehearsal). Raise it only if the
spokes' `spawnLegs` can carry it: a launch from an L2 prepays at most 32 of
its own legs.

## 6. Status, the backing check and the USDT exposure

```bash
npm run status:mainnet          # read-only, every chain over its RPC
```

Exit 1 = backing fails, a request ceiling exceeds what requests prepay, a
remote gateway prepays no open, or the USDT vault is a CCTP peer. It prints:

- **VAULTS** per chain: dollars held (in that chain's dollar), oUSD claims
  minted there, cap; **BY DOLLAR**: USDC held, USDT held;
- **BACKING**: Σ over every vault of (dollars held × that vault's SCALE —
  1e12 for USDC, 1 for USDT) against Σ of oUSD supply over every instance,
  the hub ledger included. A surplus is value in flight, parked or dust; a
  CCTP rebalance in flight is a deficit of exactly its amount
  (`SPAWN_INFLIGHT_USDC=<n>`);
- **USDT EXPOSURE**: what the BNB vault holds, its share of all the dollars
  backing oUSD, its cap, and what a 10% de-peg would cost today and at the
  cap;
- **REQUESTS**: per remote chain, `requestCap` against the smallest prepay
  and the live price; whether launches reach Ethereum right now;
- tanks, pauses, holder fees waiting, tokens without a replica (a chain
  behind a launch ceiling is EXPECTED to miss tokens — not a warning), roles,
  verifier sets.

## 7. Hand-over and roles

After `finish.sh`, on every chain: **admin** = that chain's 48h timelock
(OWNER schedules, waits in public, executes; the guardian can cancel);
**operator** = the deployer hot key (prices, ceilings, legs, caps, rebalancing
between the USDC vaults, unpause, free `resync`); **guardian** = the same hot
key (pause, veto). The deploy, DVN and tune scripts keep working: what needs
the admin is printed as `target` + `data` for the timelock.

## 8. Incident runbook

**Stop first, understand second.** Pausing blocks only NEW exposure; exits
(`sellToken`, `claimFees`, `pullFees`, `claimPending`, `moveClaim`,
`FeeDistributor.claim`, `unwrap`, every payout) have no switch.

| Action | Who | Call | Effect |
|---|---|---|---|
| Pause the hub | guardian | `SpawnPad.pause()` on Base | buys bounce with a full refund, spawns refused and refunded; sells, claims, opens, moves run |
| Pause a chain's entry | guardian | `SpawnGateway.pause()` | no new buy, spawn or open from that chain |
| Close a vault to deposits | guardian | `pauseDeposits()` on its vault | no new dollars in; or operator `setDepositCap(0)` |
| Close moves toward a chain | operator | `setMoveLegs(label, 0)` on each gateway, or `setRequestCap(label, 0)` on the pad | moves toward it come home |
| Veto a scheduled admin change | guardian or OWNER | `timelock.cancel(id)` | never executes |

**A USDT de-peg** (SPEC §7 "Two dollars"): guardian `pause()` on the BNB
gateway and `pauseDeposits()` on the BNB vault end every USDT inflow; the
operator closes moves toward BNB (`setRequestCap(4, 0)` on the pad) if USDC
is leaving that way. A USDC de-peg: close moves toward the USDC chains from
BNB the same way. Neither is theft and the backing check holds in UNITS
throughout — it says nothing about what a unit is worth.

Triage: (1) `npm run status:mainnet`; exit 1 on backing = pause the pad and
every gateway, then investigate. (2) Replies not arriving: the hub tank is
empty or a destination mispriced — send ETH to the hub adapter, run
`tune-fees.js`, retry the message from layerzeroscan.com (a failed delivery
stays retryable). (3) "No tokens": parked — `pendingDelivery` /
`claimPending`. (4) "oUSD instead of USDC": that vault was short —
rebalance (USDC vaults), or the holder moves the claim to a chain that can
pay (`moveClaim`). (5) A scheduled timelock operation nobody recognises:
cancel it.

**A token without a replica on a chain.** Expected on Ethereum while it is
behind its ceiling: anyone opens it there (`openToken` from Ethereum, the
site offers it) or pays a `resync` on Base. On any other chain it means a
SYNC failed: `SPAWN_TOKEN=missing npx hardhat run scripts/resync.js
--network base` shows them, `SPAWN_APPLY=1` sends them (the hub tank pays;
it names the top-up if short).

**Rebalancing a USDC vault** (operator): `OmniUSD.rebalance(dstLabel,
amount)` on the long chain, then `SRC=base TX=0x… SPAWN_APPLY=1 npx hardhat
run scripts/relay-cctp.js --network optimism`. The BNB vault cannot be
levelled with anything: dollars there leave through trades and moved claims
only.

## 9. Monitoring

`npm run status:mainnet` from cron, alert on exit ≠ 0 (`SPAWN_STRICT=1` also
fails on warnings). `tune-fees.js` on every chain then Base, weekly and after
any gas regime change (an L1 spike moves Ethereum in and out of launches by
itself; the ceilings follow on Base's run). Keepers:
`SPAWN_APPLY=1 SPAWN_PULL_THRESHOLD_USD=25 npx hardhat run
scripts/keeper-pull.js --network optimism` per remote chain.

## 10. Adding a chain to the live universe

```bash
bash scripts/add-chain.sh <network> prepare     # day 0
bash scripts/add-chain.sh <network> finish      # after the 48h delay
```

`prepare`: preflight; the new spoke deployed with its vault CLOSED and its
gateway PAUSED; its side of the verifier set; the operator pre-steps on Base
and every live spoke (the newcomer's executor gas, spawn legs, and the v7.2
wiring: `moveLegs` toward it on every gateway — a move there comes home
until it is wired —, its `requestCap` on the pad); one timelock batch per
chain scheduled by OWNER (route, `pad.setGateway`, CCTP peers — never for a
non-USDC vault —, the hub side of the verifier set). `finish`: OWNER
executes; every chain re-priced — spokes then Base, twice — so that every
gateway prices moves toward the newcomer, the newcomer prices opens and moves,
and the pad's request ceilings follow; the wiring read back; the verifier
sets cross-checked; the canary cap; the canary (it reuses the canary token —
opening it on the newcomer, where it never existed); the newcomer's
hand-over; its own launch cap; status. Solana (label 1) is not an EVM chain
and joins through `solana/`.

`npm run rehearse:add-chain` rehearses it on forks from the LIVE state file
(it needs a deployed `deployments/mainnet.json`).

## 11. Measured on forks of the five chains (2026-11-14, v7.2 first round)

Real EndpointV2 and our verifier set on every pathway; "exec" is what the
executor's gas limit must cover where the message lands (the relay's
`gasUsed` minus the intrinsic cost), max over the rehearsal.

**Where each op lands, against what its sender buys:**

| Op → where | Exec gas | Bought | Margin |
|---|---|---|---|
| SPAWN → hub, worst admitted (64/16/1024 bytes + dev buy), 4 remote chains, ceilings on all four | **4,515,748** | 5,200,000 (`hubGasFor(4,1)` = 5,256,000 after this run) | +15% / +16% |
| … a ceiling on Ethereum only, under it (4 SYNCs + 1 quote) | 4,249,915 | | +22% |
| … Ethereum over its ceiling (3 SYNCs + 1 quote) — the launch configuration | 4,041,216 | | +29% |
| … no ceiling anywhere (4 SYNCs) | 4,170,593 | | |
| SPAWN → hub, typical (short strings, no dev buy) | 2,933,332 | | |
| BUY / SELL / PULL_FEES → hub (each sends one reply) | 587,414 / 538,563 / 606,939 | 5,200,000 | ×8 |
| CLAIM → hub | 491,576 | | |
| OPEN → hub (one quote, one SYNC send) | 546,926 | | |
| MOVE → hub (BNB Chain → Base, forwarded by the loopback) | 118,546 | | |
| SYNC → every spoke (a replica deploy), worst strings | **772,732** | 1,200,000 (Ethereum: 1,000,000) | +55% (+29%) |
| DELIVER → spoke | 159,478 | same | ×7 |
| PAYOUT → spoke (USDC / USDT) | 110,133 / 52,420 | same | ×10 |
| FEE_DROP → spoke | 127,177 | same | ×9 |

⇒ `hubGasFor`: worst spawn ≈ 3.34M + 0.209M per remote chain + 0.089M per
ceiling quote (the mock suite's 4.95M / 4.99M were pessimistic: its send
costs 0.52M, a real one 0.21–0.28M); the profile rounds it to 3.40M + 0.22M
+ 0.10M and adds 20%. The per-op figures above are the `opGas` table in the
profile — used only once the adapter has `setGasForOp` (contract round 2).

**The pad's `SYNC_GAS_FLOOR` (100,000), measured.** A held spawn (no dev
buy, ceilings on all four remote chains: 4 real quotes + 4 real sends, then
only an event) and a held open from Ethereum (1 quote + 1 send) were
delivered under `debug_traceCall` (callTracer) at every gas from far below
to just above the least that delivers them, in 5,000-gas steps:

| | Spawn | Open |
|---|---|---|
| A real send, gas used | 0.21–0.28M remote; 0.77M the hub chain's own replica (loopback) | 0.25M |
| A real quote | 0.12–0.23M (the first one cold) | 0.21M |
| Call depth below the pad | **7** (adapter, endpoint, send library, executor / DVN, fee lib, price feed…) | 7 |
| Least gas that delivers it | 4,292,443 | 543,798 |
| Deliveries traced / starved a send or quote / succeeded while one failed | 829 / 485 / **0** | 79 / 69 / **0** |
| Most gas left behind a STARVED call | **≈ 34,300** (the 0.77M local replica send) | ≈ 9,900 (a quote) |
| Margin under the 100,000 floor | **×2.9** | ×10 |

Every starved run reverted `PAD: gas`; no run skipped a chain by
starvation. The thin end is the hub chain's OWN replica SYNC — a local call
that deploys a contract, 0.77M — not a LayerZero send: what a starved call
leaves grows with the gas it was given, about (depth/64) of it, so a call
needing ~2.3M would reach the floor. The remote sends and quotes (≤ 0.28M)
leave ≤ 10–15k.

**Prices of our verifier set at the fork block (ETH):** worst SYNC from Base
to Optimism 0.000127, Arbitrum 0.000168, BNB Chain 0.000154, **Ethereum
0.00104**. An Ethereum round trip for its canary (open, buy, sell, pull, at
the fork's gas price) cost about 0.0108 ETH; the BNB canary's messages
0.0013 BNB each.

**Deploy and hand-over:** launch.sh ≈ 3.5 min and finish.sh ≈ 0.7 min on the
forks; every one of the 30 messages of the canaries executed.

## What is proven and what is not

**Proven on forks of the five chains (`npm run rehearse`, 2026-11-14):**
the two owner commands end to end as the real deployer (impersonated):
preflight, deploy ×5, the v7.2 wiring, our verifier set on both ends of all
eight pathway directions (pinned libraries, read back, cross-checked), the
prices, every canary — the hub's local one with the `*Min` proof, a round
trip from each of the four spokes on ONE token over the real endpoints (BNB
in USDT with a claim moved to Base in USDC; Ethereum skipped by its launch
ceiling and opened from Ethereum) —, status, the hand-over to a 48h timelock
on every chain (admins, operators, guardians, LayerZero delegates read back),
the per-chain launch caps, the manifest. In process (`test/tooling.test.js`):
the same five-chain, two-dollar shape over the mock endpoint, the request
rule enforced and its violations refused (a ceiling above what requests
prepay, an open that prepays nothing, the USDT vault as a CCTP peer), an
unaffordable Ethereum canary that sends nothing.

**Not proven anywhere yet:**

- DVNs actually signing any packet of ours (the relay calls `verify` as the
  receive library); the executor's own delivery of the value (simulated with
  its exact gas and value);
- anything live on BNB Chain or Ethereum under v7.2; the first `launch.sh` is
  the first live transaction (canary caps, the deployer's own few dollars);
- a CCTP rebalance arriving (`relay-cctp.js` has never run against a real
  burn); LayerZero's retry of a delivery that failed;
- the contract round 2: cross-chain `*Min` (detected and used by the canary
  when present), `setGasForOp` (the seam, assumed name), and its gas figures —
  the rehearsal must be re-run on it (§3) before the hold is lifted;
- prices under stress: the ceilings follow tune-fees runs, not the market —
  between two runs an L1 spike changes what launches reach Ethereum (the pad
  checks live), but not what a request prepays.
