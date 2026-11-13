# Runbook — deploying and operating SPAWN! v7.1

For whoever holds the deployer key on deploy day, and whoever is on call
after it. Every command runs from `contracts/`. Nothing here is improvised:
each step is a script that was run against forks of the real chains
(`test-fork/`, `scripts/fork-rehearsal.js`, `scripts/fork-universe.js`), and
each step ends with a check that must pass before the next one starts.

**Three separate universes, three state files, three manifests** (one
profile each in `config/profiles.js`; a token launched in one never exists
in another):

| Universe | Profile | Chains | Settled in | State / manifest |
|---|---|---|---|---|
| **core** | `mainnet` | Base (hub + local gateway), Optimism, Arbitrum One | USDC (6 dec.), CCTP between vaults | `deployments/mainnet.json` → `public/onchain/mainnet.json` |
| **bnb** | `bnb` | BNB Chain alone (hub + local gateway, label 4) | BSC USDT (18 dec., `OmniUSDLocal`) | `deployments/mainnet-bnb.json` → `public/onchain/mainnet-bnb.json` |
| **ethereum** | `ethereum` | Ethereum alone (hub + local gateway, label 2) | USDC (6 dec., `OmniUSDLocal`) | `deployments/mainnet-ethereum.json` → `public/onchain/mainnet-ethereum.json` |

Ethereum is **not** a leg of the core hub and must not become one: every
launch on every chain would pay an Ethereum SYNC forever ([what that
costs](MAINNET-ADDRESSES.md#what-an-ethereum-leg-costs--measured-2026-11-13));
the core profile's `ethereum` entry is rehearsal-only and the deploy refuses
it on a live network. The single-chain universes send and receive **nothing**
through LayerZero: no route, no verifier set, no gas tank, every quote 0;
their adapter is the fixed v7.1 `LayerZeroOmniMessenger` used as a loopback.

**v7.1 redeploy note.** The first mainnet deployment (v7.0, core universe)
was **retired** after finding F-11 ([SPEC §3](SPEC.md)): the adapter took a
packet with an all-zero sender from an eid it had never been configured for
as a hub message. v7.1 fixes it (an unset peer matches nothing) and adds the
slippage-protected entrypoints (`buyTokenUsdcMin`, `buyTokenMin`,
`sellTokenMin`), `pad.resync` and the `SyncFailed` event. The v7.0 contracts
are closed on chain (gateways paused, caps 0, exits open) and their state is
`deployments/mainnet-v7_0.retired.json`; the tooling **never resumes an older
generation** (`transport` must read `v7.1`): the core is deployed fresh, and
what the hot key left in v7.0 comes back with
[`scripts/recover-retired.sh`](#v70-leftovers).

**What only exists on a fork so far:** see [the last section](#what-is-proven-and-what-is-not).

## 0. Before deploy day

| Need | Who | Detail |
|---|---|---|
| Gas on the deployer `0x483E931A279B136A2C3fCA6BF5eC2c4239c1B904` | owner | **core:** Base **0.005 ETH**, Optimism **0.002**, Arbitrum **0.002** (the preflight floors; measured 2026-11-13: Base ~0.0032 of which 0.003 is the hub gas-tank float, a spoke < 0.0003). **bnb:** **0.003 BNB** floor — 22.4M gas ≈ 0.0011 BNB at the live 0.05 gwei, 0.022 at 1 gwei. **ethereum:** the floor is **0.004 ETH**, but an L1 is priced live: the preflight asks for 2 × 20.3M gas at the current price (0.0033 ETH at 0.08 gwei, 0.04 at 1 gwei, 1.2 at 30 gwei) — fund **0.02 ETH** and launch on a quiet day. `npm run budget`, `budget:bnb`, `budget:ethereum` re-estimate live |
| OWNER address | owner | a Safe (https://app.safe.global) on **each** chain — it becomes proposer/executor of that chain's timelock and the operator. A plain key is accepted with a loud warning; do not do that for real money |
| GUARDIAN address | owner | a separate hot key: it can pause and can veto a scheduled timelock operation, nothing else |
| The deployer key | owner | `MAINNET_DEPLOYER_PK=0x…` in `contracts/.env` (falls back to `DEPLOYER_PK`) |
| A few dollars on the deployer for the canary trades (each canary buys 3) | owner | **core:** ~5 USDC on Base and on each spoke (today: 18.8 / 8.3 / 8.6 — enough). **bnb:** ~5 USDT on BNB Chain (today: 5.07 — enough). **ethereum:** ~5 USDC on Ethereum (today: **0** — to send) |
| Go / no-go | owner | after the testnet dress rehearsal (§1) and the fork rehearsal (§2) |

## 1. Testnet dress rehearsal (same contracts, MockUSDC)

A generation never continues an older one (`transport` in the state file
must read `v7.1`; the scripts refuse to resume anything else), so the three
live testnet entries (v7.0, handed over to their timelocks) are archived
first, and v7.1 deploys fresh beside them. Their gas tanks answer to the
testnet timelocks, not to the deployer: `recover-tanks.js` prints the
`schedule` / `execute` calldata for OWNER (the testnet timelocks have no
delay) instead of draining them itself.

```bash
# archive the v7.0 entries (the one-liner); the old tanks come back through the timelocks
node scripts/archive-state.js testnet _v70_pre71 baseSepolia optimismSepolia arbitrumSepolia
npx hardhat run scripts/recover-tanks.js --network baseSepolia        # calldata for OWNER when the admin is a timelock
npx hardhat run scripts/recover-tanks.js --network optimismSepolia
npx hardhat run scripts/recover-tanks.js --network arbitrumSepolia

# deploy: hub, spokes, hub again (wires them), spokes again (refreshes spawnLegs)
npx hardhat run scripts/deploy-testnet.js --network baseSepolia
npx hardhat run scripts/deploy-testnet.js --network optimismSepolia
npx hardhat run scripts/deploy-testnet.js --network arbitrumSepolia
npx hardhat run scripts/deploy-testnet.js --network baseSepolia
npx hardhat run scripts/deploy-testnet.js --network optimismSepolia
npx hardhat run scripts/deploy-testnet.js --network arbitrumSepolia

# smoke: local trading on the hub chain, then a full cross-chain round trip
npx hardhat run scripts/testnet-smoke.js --network baseSepolia
npx hardhat run scripts/testnet-smoke.js --network optimismSepolia
npm run status:testnet
```

Each deploy run ends with a self-check ("everything on chain matches the
plan") and re-running any of them must send 0 transactions. The OP Sepolia
public RPC sometimes answers `0x` for a contract deployed seconds ago: just
re-run, the script resumes. Testnets run with **sponsored** gateways (the
adapters' tanks pay). To rehearse the mainnet fee model, deploy with
`SPAWN_SPONSORED=0`: the smoke then attaches the quoted fee to every call —
**this is the only live proof that the executor delivers the prepaid reply
budget into the hub tank**, so do it at least once.

Do not start `scripts/watch-legs.js` during a migration: it deploys and
publishes the site by itself.

## 2. Fork rehearsal (the mainnet commands, against a fork of Base)

```bash
npm test                 # 215 tests: protocol, tooling (three universes, resync, *Min), contract sizes
npm run preflight        # read-only, LIVE: every external address re-derived on each chain of the core
npm run preflight:bnb    # … the BNB universe (USDT facts, budget in BNB, user gas at live price)
npm run preflight:ethereum
npm run test:fork        # Base (9) + Optimism (7) forks: real endpoint, USDC, CCTP
npm run rehearse         # the core commands of §3–§6 below, end to end, on a Base fork
npm run rehearse:bnb     # launch.sh bnb + finish.sh bnb against a fork of BNB Chain, as the real deployer (~5 min)
npm run rehearse:ethereum
npm run dvn:survey       # the configured verifier set still matches LayerZero's registry and quotes
npm run rehearse:add-chain   # §10 only: add-chain.sh against forks of the LIVE core (4 chains, ~15 min)
```

Needs Foundry's `anvil` (the fork node; hardhat's own EVM cannot execute on
a fork of these chains). Everything above must pass on the day, from the
commit that will be deployed, for the universe being launched. `npm run
preflight*` reports an unfunded deployer without failing; anything else it
flags is a stop. The BNB and Ethereum forks need an upstream RPC that serves
state a few thousand blocks back (`config/forks.js` lists the ones that do;
`FORK_RPC=` overrides); a run pins its block, so anvil's disk cache makes the
second run at the same block (`FORK_BLOCK=`) nearly free of upstream calls.

## 3. Mainnet deploy

**The short way — one universe, two lines.** §3–§5 are wrapped in one
resumable script, and §6 in a second one. The owner pastes the first line,
says "fait", Claude reads the journal (`deployments/logs/`), then gives the
second line:

```bash
# (a) the CORE universe — Base + Optimism + Arbitrum, USDC
bash scripts/launch.sh                   # preflight → deploy → DVNs → fees → canary (Base local, then Optimism) → status
bash scripts/finish.sh                   # canary from Arbitrum → hand-over → status → launch caps → status

# (b) the BNB universe — BNB Chain alone, USDT
bash scripts/launch.sh bnb               # preflight → deploy → local canary (slippage-protected) → status
bash scripts/finish.sh bnb               # hand-over → status → launch cap (25,000 USDT) → status

# (c) the Ethereum universe — Ethereum alone, USDC
bash scripts/launch.sh ethereum
bash scripts/finish.sh ethereum
```

(`launch-mainnet.sh` / `finish-mainnet.sh` are the same scripts for the core
universe; `SPAWN_LAUNCH_PROFILE=<universe>` works too; `testnet` rehearses
the sequence on the public testnets.) OWNER is the wallet whose key is in
`contracts/.env.owner` (or `SPAWN_FINISH_OWNER=0x…` for a Safe); the deployer
hot key stays **operator + guardian**.

What the wrappers guarantee: every step is idempotent and resumes (fix the
cause, paste the same line again); a canary that passed is never repeated
(`deployments/.canary-<profile>-<net>.ok`); `launch.sh` opens the vaults with
a **canary cap** (100 of the universe's dollar, `SPAWN_CANARY_CAP_USDC`) so
the canary trades are the only exposure until the hand-over; the canary on
a hub chain goes through the **slippage-protected** entrypoints
(`buyTokenUsdcMin` / `sellTokenMin`, minimum = the client-side curve quote
less 1%) after **proving** that a minimum no trade can meet is refused
(`"GW: min out"`, nothing moves); `finish.sh` refuses an OWNER that has never
sent a transaction on the hub chain unless its key is on this machine (an
address nobody can sign for would freeze the admin for good), then raises
the caps with `scripts/set-cap.js` (25,000 of the dollar,
`SPAWN_LAUNCH_CAP_USDC`) and refreshes the manifest. Funds needed: §0.

**Single-chain universes, what is different.** One `deploy.js` run (hub and
local gateway at once); no `configure-dvn.js`, no `tune-fees.js`, no
cross-chain canary; the preflight checks the dollar (`USDT` / 18 decimals /
total supply within 1–100 B for BNB; Circle's `isMinter` for Ethereum) and
prints what a launch, a buy and a sell cost a user at the live gas price
(no messaging fee: 2.2M / 0.41M / 0.25–0.29M gas). `status` shows the one
vault in the dollar's decimals and no tank. The manifest carries
`"universe"` and `"dollar": { "symbol", "decimals" }`, and `depositCap` in
the dollar's own smallest units (`100000000000000000000` is 100 USDT).

<a id="v70-leftovers"></a>
**v7.0 leftovers (core only).** `bash scripts/recover-retired.sh` lists,
read-only, what the hot key left in the retired deployment: a canary bag of
~190k CANARY on each chain (worth about a dollar each), 0.38 oUSD on
Optimism, and the Base adapter's tank (0.0035 ETH). `… apply` (with
`SPAWN_RECOVER_CONFIRM=I_WANT_THE_V70_LEFTOVERS_BACK`) sells the Base bag
locally and unwraps the oUSD; the spoke bags are not worth a cross-chain
round trip. The tank answers to the retired Base timelock: the script prints
the `schedule` / `execute` calldata OWNER pastes (48h apart). Nothing is lost
by waiting; none of it blocks the v7.1 launch.

The rest of this section is what the core wrappers run, step by step.

Every mainnet command is a **dry run** — preflight and plan, zero
transactions — unless `SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY`
is set. Run each one dry first and read the plan.

```bash
export OK=SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY

# 3.1 hub
npx hardhat run scripts/deploy.js --network base             # dry: read the preflight + plan
env $OK npx hardhat run scripts/deploy.js --network base
# 3.2 spokes
env $OK npx hardhat run scripts/deploy.js --network optimism
env $OK npx hardhat run scripts/deploy.js --network arbitrum
# 3.3 hub again: routes, options, pad.setGateway, CCTP peers
env $OK npx hardhat run scripts/deploy.js --network base
# 3.4 spokes again: spawnLegs = 2, CCTP peers toward each other
env $OK npx hardhat run scripts/deploy.js --network optimism
env $OK npx hardhat run scripts/deploy.js --network arbitrum
```

**After each run, verify:**

- the preflight printed seven `✓` — chain id, `endpoint.eid()`, USDC
  `symbol`/`decimals`, USDC `isMinter(CCTP minter)`, CCTP domain, deployer
  budget. A single `✗` aborts before any transaction: do not override it,
  find out why;
- the run ended with `self-check … ✓ everything on chain matches the plan`;
- after 3.4, re-running all three sends **0 tx**.

Order is enforced by the script, not by you: a spoke refuses to deploy
before the hub; the hub only wires a spoke whose own run finished
(`ready` in `deployments/mainnet.json`); a holder pool exists before its
gateway is wired; an adapter destination exists before the pad learns a
gateway. Interrupted? Re-run the same command.

To leave every vault closed until the hand-over is done, add
`SPAWN_OPEN_DEPOSITS=0` to the deploy runs; the operator opens them later
with `OmniUSD.setDepositCap` (25,000 USDC per vault is the launch cap).

## 4. Verifier set (DVNs) and fees

```bash
env $OK npx hardhat run scripts/configure-dvn.js --network base
env $OK npx hardhat run scripts/configure-dvn.js --network optimism
env $OK npx hardhat run scripts/configure-dvn.js --network arbitrum
SPAWN_VERIFY=1 npx hardhat run scripts/configure-dvn.js --network base    # cross-chain, read-only

env $OK SPAWN_APPLY=1 npx hardhat run scripts/tune-fees.js --network base
env $OK SPAWN_APPLY=1 npx hardhat run scripts/tune-fees.js --network optimism
env $OK SPAWN_APPLY=1 npx hardhat run scripts/tune-fees.js --network arbitrum
```

The set is `required: LayerZero Labs + Google`, `optional: 1 of Horizen,
Twinstake` (config/profiles.js; fee table in MAINNET-ADDRESSES.md).
`configure-dvn.js` pins the send and receive libraries, sets the executor
and ULN config on the source and the ULN config on the destination, refuses
any DVN that will not quote the pathway, and reads everything back.

**Verify:** `SPAWN_VERIFY=1` prints one `✓` per pathway direction (4 with
two spokes) and exits 0 — both ends name the same set. **A mismatch means
messages on that pathway stall: do not open deposits.** Then `tune-fees.js`
shows a reply budget around 0.00016–0.00021 ETH (was 0.0002 at deploy); a
quote near 0.0006 means the DVN set is still LayerZero's default.

## 5. Canary

```bash
env $OK SMOKE_BUY_USDC=3 npx hardhat run scripts/smoke.js --network base       # local: every step one tx
env $OK SMOKE_BUY_USDC=3 npx hardhat run scripts/smoke.js --network optimism   # cross-chain: minutes
npm run status:mainnet
```

The deployer spends about 3 USDC per run of its own money (most comes back
on the sell). **Verify:** both end with 🎉; the Optimism run shows the hub
tank no lower than it started ("reply budgets in, reply fees out"); `status`
reports `✓ backing holds`. The cross-chain canary is the **first live proof
on mainnet** of executor value delivery and of the DVN set actually signing:
if a step waits forever, look the transaction up on
https://layerzeroscan.com before doing anything else.

## 6. Hand-over

```bash
export OWNER=0x…   GUARDIAN=0x…
env $OK SPAWN_OWNER=$OWNER SPAWN_GUARDIAN=$GUARDIAN npx hardhat run scripts/handover.js --network base
env $OK SPAWN_OWNER=$OWNER SPAWN_GUARDIAN=$GUARDIAN npx hardhat run scripts/handover.js --network optimism
env $OK SPAWN_OWNER=$OWNER SPAWN_GUARDIAN=$GUARDIAN npx hardhat run scripts/handover.js --network arbitrum
npm run status:mainnet
```

Per chain it: names OWNER operator and GUARDIAN guardian on every contract;
deploys a `TimelockController` with no delay; has every contract nominate
it; accepts them all in one batch; raises its own delay to 48h; makes OWNER
proposer + executor + canceller and GUARDIAN canceller; renounces every
deployer role; and reads it all back. It is resumable.

**Verify:** each run ends `✓ hand-over complete … the deployer holds
nothing`; `status` shows `admin … (the timelock)` on every network and no
warning. From here:

- **admin** actions (a new gateway, a peer vault, a route, sponsoring, tank
  recovery, the DVN set) are scheduled by OWNER on that chain's timelock and
  wait 48h in public. The deploy and DVN scripts no longer send them: they
  print `target` + `data` to paste into the Safe as
  `timelock.schedule(target, 0, data, 0x0, salt, 172800)` and later
  `timelock.execute(…)`;
- **operator** actions (reply budgets, legs, deposit caps, rebalancing,
  unpause) are OWNER's directly — `tune-fees.js` prints the calldata when
  the signer is not the operator;
- the deployer key is only a gas payer. Re-running `deploy.js` is harmless.

## 7. Go live

1. `SPAWN_VERIFY=1 … configure-dvn.js` and `npm run status:mainnet` clean.
2. Publish the frontend with the universe's manifest, written by the deploy
   script and refreshed by `set-cap.js`: `public/onchain/mainnet.json`
   (core), `mainnet-bnb.json`, `mainnet-ethereum.json` — the testnet shape
   plus `"network": "mainnet"`, `"universe"`, `"dollar": { "symbol",
   "decimals" }`, a per-chain `depositCap` in the dollar's smallest units,
   `local: true` on the hub chain's gateway, no `gasDrip`; a spoke is listed
   only once the hub has wired it.
3. Start the monitors (§9).

## 8. Incident runbook

**Stop first, understand second.** Pausing blocks only NEW exposure; no user
is ever locked in.

| Action | Who | Call | Effect |
|---|---|---|---|
| Pause the hub | guardian (or operator/admin) | `SpawnPad.pause()` on Base | buys bounce with a full refund, spawns are refused and refunded; sells and claims keep running |
| Pause a chain's entry | guardian | `SpawnGateway.pause()` | no new buy or spawn from that chain |
| Close a vault to deposits | guardian | `OmniUSD.pauseDeposits()` | no new USDC in; or operator `setDepositCap(0)` |
| Veto a scheduled admin change | guardian or OWNER | `timelock.cancel(id)` | the operation never executes |

**What stays open, always:** `sellToken`, `claimFees`, `pullFees`,
`claimPending`, `FeeDistributor.claim`, `OmniUSD.unwrap`, and every payout
on the message path. There is no switch for exits.

**Unpause:** operator only — `unpause()` on the pad / gateway,
`unpauseDeposits()` on a vault. The guardian cannot.

Triage, in this order:

1. `npm run status:mainnet`. Exit code 1 = **backing fails** (vault USDC <
   oUSD supply): pause the pad and every gateway at once, then investigate.
   A CCTP rebalance in flight is a legitimate temporary deficit of exactly
   its amount: `SPAWN_INFLIGHT_USDC=<n>`.
2. Replies not arriving: the hub tank is empty or a destination is
   mispriced. Messages are not lost — LayerZero keeps a failed delivery
   retryable. Send ETH to the hub adapter (anyone can), run `tune-fees.js`,
   then retry the message from layerzeroscan.com.
3. A user "did not get tokens": a delivery that could not settle is parked,
   not lost — `SpawnGateway.pendingDelivery(hubToken, user)` then
   `claimPending(hubToken)`.
4. A user "got oUSD instead of USDC": that vault was short. Rebalance
   (below); their oUSD unwraps 1:1 once liquidity is back.
5. A scheduled timelock operation nobody recognises: cancel it, then find
   out which key proposed it.

**Rebalancing a vault** (operator; USDC can only go to another vault of the
deployment): `OmniUSD.rebalance(dstLabel, amount)` on the long chain, then

```bash
SRC=base TX=0x<rebalance tx> SPAWN_APPLY=1 npx hardhat run scripts/relay-cctp.js --network optimism
```

It waits for Circle's attestation (Standard Transfer: source finality,
~15–20 min from an L2) and presents it on the destination. Anyone can relay.
If Circle ever enables a minimum fee, `rebalance` reverts (it hard-codes
`maxFee = 0` so the peer receives exactly what was burned): that is a safe
failure and needs a contract decision, not a workaround.

### A token without a replica on a chain (v7.1)

Since v7.1 a SYNC that cannot be sent (an unfunded or misconfigured leg, a
starved executor) **no longer undoes the launch**: the hub emits
`SyncFailed(token, chain)` and the token is born without a replica there.
`status.js` lists every such (token, chain) pair under **TOKENS WITHOUT A
REPLICA** (state-based — `gateway.replicaOf(token) == 0` on a chain the pad
SYNCs — so it also catches a lost message and the tokens launched before a
chain was added); a pair younger than ten minutes may still be in flight,
an older one is a warning. Repair, on the hub, by the operator (the hub tank
pays the message; a gateway ignores a SYNC for a replica it already has):

```bash
SPAWN_TOKEN=missing npx hardhat run scripts/resync.js --network base                 # show every pair, nothing sent
SPAWN_TOKEN=missing SPAWN_APPLY=1 npx hardhat run scripts/resync.js --network base   # send them all
SPAWN_TOKEN=0x… SPAWN_CHAIN=optimism SPAWN_APPLY=1 npx hardhat run scripts/resync.js --network base
```

If the leg still cannot be quoted the script says so and sends nothing —
repair the leg first (`deploy.js` re-run, `tune-fees.js`). If the hub tank
cannot pay, it sends what it can and prints the exact top-up to send to the
hub adapter, then run it again. Whatever reached the chain before its
replica (a dev-buy DELIVER, a FEE_DROP) is parked there and settles when the
replica lands.

## 9. Monitoring

`npm run status:mainnet` from cron every few minutes, alert on exit code ≠ 0
(`SPAWN_STRICT=1` also fails on warnings). It reads, over each chain's RPC:

| Watch | Alarm |
|---|---|
| **Global backing** — Σ vault USDC × 1e12 vs Σ oUSD supply (hub ledger included) | deficit → exit 1 → pause. A surplus is normal (value in flight, parked, dust) |
| Hub gas tank | below 0.001 ETH (a third of the 0.003 float): top up + `tune-fees.js`. It should drift UP — every reply is prepaid |
| Per-vault liquidity vs local oUSD | "locally short" → rebalance |
| Pauses | anything paused that nobody paused |
| Holder fees waiting on the hub, per chain | growing → run `keeper-pull.js` |
| Roles | an admin that is not the recorded timelock; contracts on one chain answering to different keys; a LayerZero delegate that is not the adapter's admin |
| Verifier sets | a pathway whose two ends disagree, or not the configured set |

Keepers (any funded key, per remote chain):
`SPAWN_APPLY=1 SPAWN_PULL_THRESHOLD_USD=25 npx hardhat run scripts/keeper-pull.js --network optimism`
— holder fees are accrue-then-pull, and a large un-pulled slice invites a
buy-just-before / sell-just-after capture. Pulling at a modest threshold
keeps every drop small.

`tune-fees.js` weekly and after any gas regime change: reply budgets are an
estimate of a moving price.

## 10. Adding a chain to the live deployment

After the hand-over every topology step is the timelocks': the hub's route
to the newcomer, `pad.setGateway`, the CCTP peers on every vault, the hub
side of the verifier set. OWNER schedules them, they wait **48h in public**,
OWNER executes. Nobody can shorten that — it is the same delay that protects
users from a hostile admin. One wrapper runs the whole thing, in two
commands 48h apart:

```bash
bash scripts/add-chain.sh ethereum prepare     # day 0
bash scripts/add-chain.sh ethereum finish      # day 2 (refuses, with the time left, if run early)
```

**Before `prepare`** — in `config/profiles.js` the chain needs its eid,
label, native USDC, CCTP domain, confirmations and its address for every
verifier of its pathway (a chain that lacks one of the default verifiers
gets its own set under `dvn.pathways`, used on BOTH ends of that pathway);
`MAINNET-ADDRESSES.md` gets the evidence; `npm run dvn:survey` must still
print the configured set as live on every chain; and the fork rehearsal must
pass from the commit that will run: `npm run rehearse:add-chain` (anvil
forks of every chain, from the LIVE deployed state, the wrapper itself, 48h
of time travel).

**What `prepare` does**

| Step | Who signs | Effect while waiting |
|---|---|---|
| Preflight of every chain, the new one included | nobody (read-only) | — |
| Deploy the new spoke, vault **closed**, gateway **paused** | deployer (its admin, for now) | invisible: not in the site's manifest until the hub has wired it |
| Its side of the verifier set | deployer | — |
| Operator pre-steps on the hub and every live spoke: the newcomer's gas limit on the hub adapter, one more spawn leg everywhere | deployer (operator) | spawns prepay one leg more than they use; the hub tank keeps the difference |
| ONE batch per chain on its timelock: hub = verifier set of the new pathway, CCTP peer, `setRoute`, `pad.setGateway` (in that order, atomic); each spoke = its CCTP peer | OWNER (`contracts/.env.owner`), topped up with gas by the deployer if it has none | nothing — a scheduled operation changes no state |

The batch is refused while an operator pre-step is missing: the pad must
never learn a gateway whose destination has no gas limit (every spawn would
revert). `SPAWN_OPS=list npx hardhat run scripts/timelock-ops.js --network base`
shows the operations and their ETA at any time.

**The veto.** Until `finish` executes it, the guardian (the deployer hot
key) or OWNER can drop a scheduled batch — nothing in it will ever run:

```bash
SPAWN_OPS=cancel SPAWN_OP_ID=0x… npx hardhat run scripts/timelock-ops.js --network base
```

The new spoke then simply stays deployed, closed and paused: it costs
nothing and nobody can reach it. Scheduling again starts a fresh 48h.

**What `finish` does** (after the delay)

1. OWNER executes the hub batch. **This is the point of no return:**
   `pad.setGateway` is permanent — there is no `removeGateway` — and from
   this transaction on EVERY launch SYNCs the new chain, forever.
2. At once: `tune-fees.js` on the hub (a local launch now prepays the SUM of
   the SYNC quotes + 25%), then OWNER executes the spokes' batches, then
   `tune-fees.js` on every spoke — its reply budget, its `spawnLegs` (padded
   so that legs × unit covers the whole fan-out: a dearer destination costs
   several of a spoke's own legs) and its hub-bound executor gas
   (`hubGasFor`: +0.27M per remote chain).
3. Every chain's wiring is read back; the verifier sets of every pathway are
   cross-checked, both ends.
4. The new vault opens at the canary cap, the gateway is unpaused, a full
   round trip from the new chain with the deployer's own 3 USDC, then its
   hand-over to OWNER's timelock, the launch cap, `status`.

Between the hub batch and the re-pricing (seconds to a minute) a launch
under-prepays the new SYNC and the hub tank covers it; the wrapper re-prices
the hub first for that reason. If it stops there, run it again — it resumes.

**Gas the wallets need** (mainnet, at 2026-11-13 gas prices):

| Wallet | Chain | For | About |
|---|---|---|---|
| deployer | the new chain | deploy + DVN + hand-over (the preflight asks 2 × that gas at the live gas price) + the canary's messages | Ethereum at 0.11 gwei: 0.0026 + ≈0.009 → fund **0.015 ETH**. It **scales with L1 gas** (≈0.2 ETH at 5 gwei) |
| deployer | the new chain | 3 USDC for the canary | 3 USDC |
| deployer | hub + each live spoke | pre-steps, re-pricing, OWNER top-ups | < 0.0003 ETH each (it already holds more) |
| OWNER | hub + each live spoke | schedule + execute one batch | sent by the deployer automatically (`SPAWN_TOPUP=1`, a few 1e-5 ETH) |

**What a chain costs after it is added** — see MAINNET-ADDRESSES.md →
"What an Ethereum leg costs". The cost of a destination is paid by every
launch from every chain, at that destination's gas price. An L1 leg ties the
price of every launch to L1 gas, permanently.

**Rehearsing on testnets.** The testnet deployment is handed over too (same
OWNER, timelocks with no delay), so
`SPAWN_LAUNCH_PROFILE=testnet bash scripts/add-chain.sh ethereumSepolia prepare`
then `… finish` runs the same sequence live. It needs faucet gas for the
deployer on the new testnet (≈0.02 ETH on Ethereum Sepolia) — nothing else.

## Measured on mainnet forks (2026-11-13)

| What | Gas |
|---|---|
| Hub deploy (35 tx) + wiring 2 spokes | 17.0M + 0.6M |
| Spoke deploy (23 tx) | 9.1M |
| `configure-dvn.js`, per pathway | 0.56M |
| `handover.js` on the hub | 2.5M |
| Hub `lzReceive`: SPAWN from a spoke, typical / worst admitted — 2 remote spokes | 2.40M / 3.63M |
| … 3 remote spokes | 2.67M / 3.88M |
| Hub `lzReceive`: BUY from a spoke, incl. the DELIVER reply | 0.71M |
| Spoke `lzReceive`: SYNC (worst strings) / DELIVER + refund / PAYOUT / FEE_DROP | 0.78M / 0.21M / 0.07M / 0.14M |
| Local spawn + dev buy + 2 real SYNCs on Base (one user tx) | 2.83M |
| `buyTokenUsdc` on a spoke (user tx, incl. the endpoint send) | 0.52M |

Configured limits: `gasToHub` 4.6M, `gasToSpoke` 1.2M.

**v7.1 bytecode, 2026-11-13** (`npm run rehearse` on a Base fork; `npm run
rehearse:bnb` / `rehearse:ethereum` running the two wrappers against forks
of BNB Chain and Ethereum as the real deployer, impersonated):

| What | Gas |
|---|---|
| Core hub deploy on Base (35 tx, before wiring) | 17.62M |
| Single-chain hub deploy: BNB Chain (33 tx) / Ethereum (33 tx) | 17.12M / 17.13M |
| Its local canary (spawn, `*Min` proof, buy, sell, claim, unwrap) | 2.94M / 3.00M |
| Its hand-over + launch cap (18 tx) | 2.27M |
| A user's launch on a single-chain universe (one tx, replica included) | 2.21M |
| A user's `buyTokenUsdcMin` there: USDT (18 dec.) / USDC (6 dec.) | 0.414M / 0.424M |
| A user's `sellTokenMin` there, paid out in the dollar | 0.249M / 0.289M |

`actionGas` in `config/profiles.js` (2.5M / 0.45M / 0.30M) is what the
preflight prices at the live gas; the fork suite fails if the measurement
drifts over it or more than 50% under it. At BSC's 0.05 gwei a launch is
0.0001 BNB; on Ethereum at 0.08 gwei 0.0002 ETH, at 30 gwei 0.075 ETH.

| Message price (ETH) | LayerZero default set | Our set |
|---|---|---|
| A reply hub → Optimism | 0.000629 | 0.000127 |
| A buy from Optimism (send + 0.0002 reply budget) | 0.000898 | 0.000396 |

## What is proven and what is not

Proven against the real contracts on forks of Base and Optimism: the
preflight; the deploy script end to end and its idempotence; local trading
in real USDC with exact backing; real `endpoint.send` at the quoted fee,
with and without the executor value option; our DVN set accepted, pinned and
read back, per side; `rebalance` producing Circle's burn event for exactly
the peer vault; the timelock hand-over and a timelocked DVN change;
inbound messages (delivered by impersonating the endpoint) paying real USDC.

Adding a chain (§10), proven on forks of all four chains starting from the
LIVE deployed state (`npm run rehearse:add-chain`, 2026-11-13): the wrapper
itself, both phases; the batches scheduled on the real timelocks by OWNER
(impersonated — no real key signs on a fork) and refused before the delay;
after 48h of time travel the live pad wired to the new spoke, every pathway's
verifier set equal on both ends, the newcomer handed over; a Base launch
SYNCing three chains and fully prepaid; Base and Optimism trading untouched;
the worst spawn (3.88M gas with three remote chains) inside the 4.6M
hub-bound limit. Not proven there: any packet actually crossing to or from
the new chain — its canary is the first time.

**v7.1 and the single-chain universes (2026-11-13), on forks:** the core
runbook end to end on a Base fork with the v7.1 bytecode (`npm run
rehearse`), the Base (9) and Optimism (7) fork suites green; `bash
scripts/launch.sh bnb` then `bash scripts/finish.sh bnb` — the exact lines
the owner pastes — run against an anvil fork of BNB Chain (real USDT, real
EndpointV2, the real deployer address impersonated), and the same for
`ethereum` (real USDC, minted on the fork by Circle's minter); after them
`test-fork/universe.fork.test.js` read **zero `PacketSent`** from the
endpoint, backing exact to the wei, every admin the owner's 48h timelock,
the hot key operator + guardian and refused as admin, the cap 25,000 in the
dollar's units, the manifest the site codes against, and a stranger's
launch / refused impossible minimum / protected buy / protected sell. The
fork caught one bug in the wrappers before the owner could (a `local`
expansion in `launch.sh`'s canary step). In process (`test/tooling.test.js`,
215 in the suite): both universe shapes deployed by the real scripts over a
mock endpoint with an 18- and a 6-decimal dollar, canary, hand-over, caps,
status; a leg whose SYNC fails shown by `status` and repaired by `resync`;
the tokens launched before a chain was added backfilled the same way; a
remote gateway at `tradeLegs = 0` failing the self-check hard.

**Not proven anywhere yet — the testnet rehearsal and the mainnet canary are
the first time:**

- anything at all on BNB Chain or Ethereum beyond read-only calls and forks:
  the first `launch.sh bnb` / `launch.sh ethereum` is the first live
  transaction of each universe (the canary is capped at 100 dollars and buys
  3 of the deployer's own);

- a packet actually crossing between two chains under OUR verifier set (the
  DVNs signing, the two ends agreeing);
- the executor really delivering the prepaid reply budget as `msg.value`
  into the hub adapter (the endpoint accepts and prices the option; delivery
  was simulated);
- a CCTP rebalance arriving: the attestation fetch and `receiveMessage`
  (`relay-cctp.js` has never run against a real burn);
- LayerZero's retry of a delivery that failed for an empty tank;
- anything on Arbitrum One or Ethereum beyond read-only calls (same code as
  Optimism, different chain).
