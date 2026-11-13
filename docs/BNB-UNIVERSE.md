# The BNB universe

A second, **separate** SPAWN! — one chain (BNB Chain), its own hub, its own
tokens, settled in BSC USDT. It is option (e) of
[SATELLITE-DOLLARS.md](SATELLITE-DOLLARS.md): BNB Chain has no Circle USDC
and no CCTP, so it cannot join the Base / Optimism / Arbitrum universe
without putting a second dollar under existing users' USDC claims. This
design never does: the two universes share code and a website, and nothing
else — no contract, no vault, no ledger, no message.

Status: the vault contract and its tests exist (this chantier). Nothing is
deployed. One decision is open — which existing messenger carries the
universe (§3). The deploy profile, the BSC fork suite and the frontend work
are listed at the end.

## 1. What it is, and what it is not

**It is** the same product on BNB Chain: launch a token, a bonding curve,
FAIR GENESIS, the four fee modes, holder fees, ascension — with every action
settled in **one transaction**, no LayerZero message and no messaging fee.

**It is not** the same market:

- A token launched here is **not** the Base-universe token of the same name.
  Different contract, different curve, different price. "One token, one
  price" holds inside each universe, not across them.
- There is **no cross-chain** in this universe. One chain, one gateway.
- It settles in **BSC USDT** (`0x55d398326f99059fF775485246999027B3197955`,
  18 decimals), not USDC. That token is a Binance-custodied peg, not an
  issuer-native dollar: a user's dollars here are worth what Binance's peg
  is worth. If it breaks, this universe breaks — and only this one.
- A dollar cannot move between the universes through SPAWN!. A user who
  wants to go from one to the other sells, bridges by their own means, buys.

What the user must be told, in the UI, before their first transaction: this
is a separate market; it is settled in Binance-pegged USDT; the contracts
are unaudited; deposits are capped.

## 2. The contract set

| Contract | On BNB Chain | Code |
|---|---|---|
| a messenger (§3) | carries hub ⇄ gateway calls inside the chain | reused |
| `OmniUSD(0, 0, 0)` | the hub's ledger (curve reserves, fee pots) | reused |
| `SpawnPad` | the hub | reused |
| `InternalCurveVenue` | the curve | reused |
| `SpawnGateway` (label 4) | the only gateway | reused |
| `SpawnToken` | hub token + its one replica | reused |
| `FeeDistributor` | the holder pool | reused |
| `SpawnTimelock` | admin of everything, 48h | reused |
| **`OmniUSDLocal(4, USDT)`** | **the vault** | **new** |

`chainLabels = [4]`: a spawn SYNCs exactly one gateway, in the same
transaction. With `tradeLegs = 0` and `spawnLegs = 0` every `quote*` returns
0 and no call needs `msg.value`.

The reused contracts are compiled from the same sources as the live USDC
universe. This chantier added files only; no existing file changed.

## 3. The transport — decided: the fixed v7.1 adapter, loopback only

**Decision (v7.1, 2026-11-13): (a) `LayerZeroOmniMessenger`**, constructed
against BSC's EndpointV2 (`0x1a44…728c`, eid 30102), with labels 0 and 4
marked local and **no route ever set** — the same bytecode as the core
universe. The reason (b) was recommended below no longer exists: the hole it
avoided was finding **F-11**, fixed in v7.1 (`_isPeer` matches a SET peer
only — an unset peer matches nothing, not even an all-zero sender), proved
by `test/v71.test.js` and `test/layerzero.test.js`; it is also what retired
the v7.0 mainnet deployment. With (a) the three universes run one adapter
bytecode, and the single-chain ones are rehearsed by the same scripts as the
core (`scripts/fork-universe.js`: the two wrappers against a fork of BNB
Chain with the real endpoint — zero `PacketSent`). The §3 analysis is kept
as the record of why the choice was open; (b) stays in `OmniMessenger.sol` as
the devnet transport.

The two candidates, as they were weighed:

**(a) `LayerZeroOmniMessenger`, loopback only** — the production adapter,
constructed against BSC's EndpointV2 (`0x1a44…728c`, eid 30102), with labels
0 and 4 marked local and no route ever set. This is what was planned.

**(b) `LocalOmniMessenger`** — the same-chain messenger in
`OmniMessenger.sol` (until now the transport of the local devnet and of most
of the test suite). It has no LayerZero side at all: a message can only be
sent by a registered contract on this chain, and its source label and sender
are taken from `msg.sender`.

**What spoke for (b) before v7.1.** While testing what can reach the vault
from outside the chain, the v7.0 adapter turned out to accept one thing it
should not (fixed since — F-11):

> `lzReceive` checks `peers[origin.srcEid] == origin.sender`. For a chain
> with no peer configured, `peers[eid]` is `bytes32(0)` — so a packet whose
> sender is all zeros **passes**, is handed on with `labelOf[eid]`, which is
> also unset, i.e. `0`, **the hub's label**, and with the `srcSender` written
> in the message body. The gateway authenticates a hub message by exactly
> those two values. A forged `PAYOUT` delivered this way empties the vault
> (reproduced: `KNOWN EXPOSURE` test). `allowInitializePath` returns `true`
> for the same packet. LayerZero's own OApp base rejects this case
> (`NoPeer`); the adapter does not.

No user can do this: LayerZero itself has to deliver a packet with an
all-zero sender, which takes either a source chain where an OApp can have
the zero address, or control of the receive library / verifier set that
applies to a chain the adapter was never configured for — LayerZero's
defaults, which the endpoint's owner can change. But it means the vault's
safety would rest on LayerZero's default configuration for every chain in
the world, on a universe that sends and receives nothing through LayerZero.
With (b) that dependency does not exist: there is no `lzReceive`, no
endpoint, no peer, no route, no delegate, no tank.

(b) is also stricter towards the admin. On the adapter a hostile admin can,
after the timelock, point a route at a peer of its own and forge hub
messages. On `LocalOmniMessenger` even a registered impostor is refused,
because the gateway and the pad each accept one `msg.sender`-derived address
(tested).

One care with (b): its only tunable is a flat fee per message
(`setFlatFee`, operator). It must stay 0 — a fee would be demanded on every
call including sells — so **name no operator on the messenger**: the setter
then answers only to the time-locked admin.

**The same adapter bytecode is live on the USDC universe**, where it cannot
be swapped. That is outside this chantier; it is reported to whoever owns
the mainnet risk register.

## 4. `OmniUSDLocal` against `OmniUSD` — every difference

The vault is `OmniUSD` with the CCTP surface and the ledger mode taken out
and the scale derived from the token. After stripping comments and applying
the one mechanical rename (`usdc6` → `units`, `_trySendUsdc` → `_trySend`):
**98 code lines identical, 54 removed, 17 added** (152 → 115 lines; runtime
8,474 → 6,768 bytes).

| | `OmniUSD` (live) | `OmniUSDLocal` |
|---|---|---|
| Backing token | 6 decimals only (constructor rejects the rest) | any token of **6 to 18 decimals** |
| `SCALE` | `constant 1e12` | `immutable 10 ** (18 - decimals)` — 1 for BSC USDT. Same getter, same selector |
| Dust | sub-1e12 remainders stay as oUSD | same rule; with `SCALE == 1` there is no remainder, ever |
| Ledger mode (`usdc == 0`) | yes (the hub instance) | **none** — always a vault; the `backed` modifier is gone because it is always true. The hub ledger is a plain `OmniUSD(0,0,0)` |
| CCTP | `tokenMessenger`, `peers`, `setPeer`, `rebalance`, `CCTP_FINALITY_STANDARD`, events `PeerSet` / `Rebalanced` | **absent** (not disabled). The contract has no function that sends the token anywhere but to a redeeming user or a protocol payout |
| Admin power | names the agent (once) and peers | names the agent (once) — nothing else |
| `depositFor` | `require(amount18 >= MIN_DEPOSIT)`, `MIN_DEPOSIT = 1e12` — since v7.1 the same floor on both vaults (one USDC unit) | `require(amount18 >= MIN_DEPOSIT)` with `MIN_DEPOSIT = 1e12`: at 18 decimals that is 1e-6 USDT, the smallest amount the message path can carry |
| Constructor | `(label, usdc, tokenMessenger)` | `(label, token)`; rejects a zero token and decimals outside 6…18 |
| Everything else | — | identical: `wrap`, `unwrap`, `payout` (never reverts: token if liquid and accepted, else the whole amount as a claim; dust minted), balance-delta deposits, the cap, the deposit pause, `nonReentrant`, Roles, the events, the revert strings, the ERC-20 name and symbol (`OmniUSD` / `oUSD`) |

The getter is still called `usdc()`: the immutable gateway calls it by that
name. Read it as "the dollar token".

**Why the `MIN_DEPOSIT` floor.** On the USDC universe no amount smaller
than 1e12 oUSD wei can reach the hub: one USDC unit is 1e12, and the gateway
puts the same floor (`MIN_AMOUNT`) on its oUSD paths. An 18-decimal dollar
can express less, and the immutable gateway only checks `> 0` on the dollar
path. The hub copes with dust (the venue refuses, the pad bounces it home),
but there is no reason to hand it inputs it has never been handed live, so
the vault restores the floor where a deposit is about to ride a message.
`wrap` has no floor. At 6 decimals the floor is exactly one token unit —
no behaviour change. Side effect worth having: a client that wrongly sends
6-decimal amounts to this 18-decimal vault is refused (`oUSD: dust`) instead
of trading a millionth of a cent.

**Units.** `depositCap` and every dollar-path argument (`wrap`,
`buyTokenUsdc`, `spawnTokenUsdc`) are in **token units — 18 decimals here**.
The mainnet tooling multiplies caps by `10 ** 6`; on this universe that
would set a cap of 0.000000025 USDT (a safe failure, but a failure).

### ABI compatibility — proved by test

The gateway and the distributor are compiled against the `OmniUSD` type and
pointed at this contract. The tests check, from the compiled artifacts and
the sources:

- every `OmniUSD` function except the five CCTP ones exists here with the
  same selector, outputs and mutability, and the only function added is
  `MIN_DEPOSIT`;
- every `OmniUSD` event except the two CCTP ones exists with the same topic
  and indexing;
- the calls the live contracts actually make on the type — read out of
  `SpawnGateway.sol` (`usdc`, `bridgeBurn`, `bridgeMint`, `depositFor`,
  `payout`) and `FeeDistributor.sol` (`transfer`) — resolve to the same
  selectors and argument types;
- the real `SpawnGateway` accepts the vault at construction, and then every
  one of those calls is executed by the whole-universe tests.

## 5. BSC USDT — what the chain says

Read-only calls on BNB Chain mainnet (chain id 56), 2026-11-13:

- `name()` "Tether USD", `symbol()` "USDT" (explorers label it BSC-USD),
  `decimals()` 18, supply 9.18B.
- Not a proxy: 4,413 bytes of runtime, no EIP-1967 implementation slot, no
  upgrade selector.
- Selectors present: `transfer`, `transferFrom`, `approve`,
  `increaseAllowance`, **`mint(uint256)`**, `burn(uint256)`,
  `transferOwnership`, `renounceOwnership`. Not found: a pause, a blacklist
  or freeze, a fee parameter, `permit`.
- `owner()` is `0xF68a4b64162906efF0fF6aE34E2bB1Cd42FEf62d` — **a plain key
  (no code)**, nonce 2,191. That key can mint any amount.
- `transfer` returns `true` (a 32-byte 1), also for a zero amount; a
  transfer to the zero address reverts.

So it behaves as a standard ERC-20 for everything the vault does: no fee, no
freeze, standard return value — and, not being upgradeable, it cannot grow
one. (This is a scan of the bytecode for known selectors, not a review of
the source: a function under a name not searched for would not show.) The
vault does not rely on any of it: it tolerates a missing return value, a
refused transfer and a fee, which is tested with mocks. What it cannot
defend against is the peg itself: the supply is whatever one key says it is,
and the backing is Binance's word.

## 6. Deploy and wiring order

The order cannot leave a state in which a launch or a trade breaks. It is
`lib-net.js`'s order for a hub and its local gateway, with the vault swapped
and the remote parts removed.

1. The messenger; `OmniUSD(0, 0, 0)`; `SpawnPad(messenger, ledger)`;
   `InternalCurveVenue(pad)`.
2. `pad.setVenue(venue)` · `ledger.setAgent(pad)` ·
   `messenger.register(pad, 0)` · `messenger.setSponsored(pad, true)`.
3. Adapter only, transport (a): `setLocal(0, true)` · `setLocal(4, true)` ·
   `setDestination(0, 0, 0)`. Transport (b) has nothing to set.
4. `OmniUSDLocal(4, USDT)` · `SpawnGateway(messenger, vault, 4, pad)` ·
   `vault.setAgent(gateway)` · `messenger.register(gateway, 4)`.
5. `FeeDistributor(vault)` · `dist.setAgent(gateway)` ·
   `dist.sealExclusions()` · `gateway.setDistributor(dist)` — the pool
   exists **before** the pad learns the gateway (a SYNC without a pool
   reverts).
6. `pad.setGateway(4, gateway)` · `pad.setAutoDrop(4, true)` ·
   `gateway.setLegs(0, 0)`.
7. Operator and guardian on ledger, pad, vault, gateway, pool — and on the
   messenger only for transport (a); on (b) **no operator** (§3).
8. `vault.setDepositCap(<cap in 18-decimal units>)` — **last**, and small
   for the canary: until then nothing can be deposited.

Never: a route on the adapter (there is no remote), `pad.setGateway` for any
other label, `pad.setAutoDrop` on a label that is not local.

Measured on the in-process chain with transport (a): 15.2M gas of
deployments + 0.83M of wiring in 16 transactions (transport (b) is smaller;
the timelock hand-over adds about 2.5M). A launch costs 1.74M gas (2.09M
with a dev buy, 2.91M with the largest strings the gateway admits), a buy
0.28–0.38M, a sell 0.25M, a holder claim 0.09M, an unwrap 0.06M, a dev
claim 0.15M. BSC's gas price was 0.05 gwei on 2026-11-13: the whole
deployment is under 0.001 BNB.

## 7. Roles and hand-over

Same pattern as the USDC universe:

- **admin** = a `SpawnTimelock` (48h) on BNB Chain whose only proposer and
  executor is OWNER. Here the admin can do less than on the USDC universe:
  the vault has no peer to name. It still owns topology (registering a
  contract on the messenger, a second gateway label on the pad) — slow and
  public.
- **operator** = the hot key: deposit cap, reopening deposits, unpause.
- **guardian** = the hot key: pause (pad, gateway, vault deposits), veto on
  the timelock.

`lib-handover.js` works on this set as is once the profile lists the
role-bearing contracts (messenger, ledger, pad, vault, gateway, pool). With
transport (b) the hand-over has no LayerZero delegate to check.

## 8. The frontend manifest

Proposed `public/onchain/mainnet-bnb.json` — the shape of `mainnet.json`,
one chain, two extra fields:

```json
{
  "network": "mainnet",
  "universe": "bnb",
  "dollar": { "symbol": "USDT", "decimals": 18 },
  "chainId": 56,
  "rpc": "https://bsc-rpc.publicnode.com",
  "pad": "0x…", "venue": "0x…", "hubUsd": "0x…",
  "fromBlock": 0,
  "sponsored": false,
  "chains": [
    {
      "label": 4, "id": "bnb", "chainId": 56, "rpc": "https://bsc-rpc.publicnode.com",
      "gateway": "0x…", "usd": "0x…", "usdc": "0x55d398326f99059fF775485246999027B3197955",
      "dist": "0x…", "local": true, "depositCap": "<18-decimal units>"
    }
  ]
}
```

The per-chain field stays `usdc` — "the dollar token" — so the provider's
plumbing does not change. What the frontend must do:

- take the dollar's **decimals and symbol from the manifest** wherever it
  assumes 6 and "USDC" (amount parsing and formatting on the dollar paths,
  the exact-amount approval, the wallet pill, the banner's caps, the mint
  button on testnets, the logo — a USDT mark);
- treat the universes as two markets: a universe switch, separate token
  lists and portfolios, and copy that never says "same token" across them;
- show the universe's own risk notice (Binance-pegged USDT, separate market).

## 9. What the tooling chantier added (v7.1, 2026-11-13)

- the `bnb` profile (`config/profiles.js`): one net, role hub, label 4,
  chain id 56, eid 30102, `usdc: 0x55d3…7955` (the name "usdc" stays the name
  of *the dollar token* everywhere), `dollar: { symbol: 'USDT', decimals: 18,
  minSupply, maxSupply }`, `vault: 'OmniUSDLocal'`, legs 0/0, no tank, no
  CCTP, no DVN set, `native: 'BNB'`, `deployments/mainnet-bnb.json` and
  `public/onchain/mainnet-bnb.json`; the `ethereum` profile is the same shape
  over USDC;
- `deployUserSide` deploys `OmniUSDLocal(label, token)` when the profile says
  so, skips the CCTP peers, and scales the cap by the token's decimals
  (`dollarUnits`); the self-check reads `SCALE` back; the manifest carries
  `universe`, `dollar` and `depositCap` in the token's own units — read from
  the vault, so `set-cap.js` moves it too;
- the preflight: chain id, `endpoint.eid()`, `symbol()` / `decimals()`
  against the profile, `totalSupply()` inside 1–100 B USDT (a look-alike has
  the name, not the float), the deployer's budget in BNB, and what a launch,
  a buy and a sell cost a user at the live gas price; no CCTP checks. (The
  non-proxy check was not added: BSC USDT *is* behind a proxy
  (`BEP20UpgradeableProxy`), which is the peg risk of §11.1, not a lie about
  the address.);
- `status.js`, `set-cap.js`, `smoke.js`, `estimate-budget.js` read the
  decimals; status shows no tank, no peers, no pathways here;
- the fork rehearsal `npm run rehearse:bnb` (`scripts/fork-universe.js`):
  the two wrappers the owner pastes, against an anvil fork of BNB Chain with
  the real USDT and the real EndpointV2, as the real deployer (impersonated);
  then `test-fork/universe.fork.test.js` — §10;
- `bash scripts/launch.sh bnb` (canary cap 100 USDT, local canary through
  `buyTokenUsdcMin` / `sellTokenMin` after proving the refusal of an
  impossible minimum) and `bash scripts/finish.sh bnb` (hand-over, launch cap
  25,000 USDT) — RUNBOOK §3.

## 10. Proof so far

`contracts/test/bnb-universe.test.js`, 33 tests, all on the real contracts
(the only mocks are the dollar tokens and, for transport (a), the LayerZero
endpoint the adapter is constructed against):

- the vault alone at 18, 8 and 6 decimals — round trips and dust, the
  decimals range, the cap, the deposit pause, roles, every payout path
  (liquid; short vault → claim → redeemed; a frozen recipient; a zero
  amount; sub-unit dust), the message-path floor, a fee-on-transfer dollar,
  a dollar whose `transfer` returns nothing, a token that re-enters, size;
- ABI compatibility (§4);
- the whole universe: launch with a dev buy, buys, a sell, holder fees
  dropped inline then claimed and unwrapped, the dev claim, the oUSD entry
  path, block 0, the FAIR GENESIS clamp and tax, burn mode, the three
  pauses, a frozen seller, pull-mode holder fees — each action one
  transaction, **zero packets** through the endpoint, every quote 0, the
  messenger's balance 0;
- the backing invariant (`USDT held × SCALE == oUSD supply of the vault +
  of the hub ledger`) and token-supply conservation after **every** step of
  a long mixed scenario and of randomized sequences at 18, 6 and 8
  decimals, ending with everyone exiting in full;
- the transport (§3): what each messenger lets in from outside, and the
  whole universe again over `LocalOmniMessenger`.

Full suite at the time: 156 passing (the 123 that existed + 33). With v7.1
and the tooling: **215**.

**Tooling and fork proof (2026-11-13, v7.1):**

- `test/tooling.test.js`: the `bnb` profile deployed in process by the real
  scripts over a mock endpoint and an 18-decimal `MockDollar` — re-run sends
  0 tx; cap 100 USDT = `100e18`; `SCALE == 1`; manifest with `universe`,
  `dollar`, `depositCap` in USDT units and one `local: true` chain; the
  canary with the `*Min` refusal; a cap overrun refused at the vault;
  hand-over (operator = guardian = the hot key), caps to 25,000, status clean,
  `endpoint.packetsSent() == 0` from the first deploy to the end;
- `npm run rehearse:bnb`: `launch.sh bnb` then `finish.sh bnb` against an
  anvil fork of BNB Chain (block 133411149, upstream Blast; the deployer
  `0x483E…1B904` impersonated, holding its real 5.07 USDT): preflight ✓,
  deploy **17,121,230 gas** in 33 tx, canary **2,943,361 gas** (spawn,
  refusal of an impossible minimum, $3 buy with minimum 371,664 CANARY,
  sell of half with minimum $1.03, payout in USDT, holder fees claimed and
  unwrapped to USDT), hand-over + cap **2,266,262 gas**; then the assertions:
  **zero `PacketSent`** from `0x1a44…728c` since the fork began, `USDT held
  × 1 == oUSD supply` to the wei, every admin the 48h timelock, the hot key
  refused as admin, cap `25000e18`, the manifest, and a stranger's launch
  (2,208,720 gas), refused impossible minimum, protected buy (413,596 gas,
  $10 → 1,767,533 CANARY) and protected sell (248,728 gas) — 7 passing.

## 11. What is not safe yet

1. **The peg.** One key can mint BSC USDT; the backing is Binance's. Nothing
   on-chain protects a holder of this universe from that. It is the reason
   the universe is separate.
2. ~~The transport, if (a) is kept~~ — **closed by v7.1 (F-11)**: an unset
   peer matches nothing; (a) is the decision (§3).
3. **The vault is new custody code and unaudited** — small (115 code lines,
   98 shared with the live vault), but it will hold the dollars.
4. **Sandwiching — half closed.** v7.1 gives the local path a minimum-out
   argument: `buyTokenUsdcMin` / `buyTokenMin` / `sellTokenMin` revert with
   `"GW: min out"` unless at least the minimum reaches the caller in the
   same transaction (the cross-chain path still has none: the wire format is
   immutable). The tooling's canary uses them with a client-side curve quote
   less 1% (`scripts/lib-smoke.js` → `quoteBuy` / `quoteSell`) and proves
   the refusal first; **the frontend must do the same on every local trade**
   (sibling chantier). The plain entrypoints still exist for the genesis
   window, where a clamped buy is the design, not a sandwich. A
   MEV-protected RPC remains a good idea on BSC.
5. ~~Decimals in everything around the contracts~~ — **the tooling reads
   them** (§9): profile `dollar.decimals`, `dollarUnits` / `dollarScale`,
   the manifest's `dollar`. The frontend is the sibling chantier.
6. **Proven on a fork, not live.** The two wrappers ran end to end against
   an anvil fork of BNB Chain with the real USDT and the real EndpointV2
   (§10) — a fork cannot show BSC's real block times, its RPCs' lag, or an
   MEV searcher. The first `bash scripts/launch.sh bnb` is the first live
   transaction of this universe; its canary is capped at 100 USDT and buys 3.
7. ~~`LocalOmniMessenger` has never held mainnet traffic~~ — moot: (a) is
   the decision; (b) stays the devnet transport.
