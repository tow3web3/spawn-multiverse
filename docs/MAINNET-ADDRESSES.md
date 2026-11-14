# Mainnet external addresses

**Status (2026-11-13): VERIFIED on the live chains by the deploy preflight,
and exercised on mainnet forks.** A wrong address here is lost money, so no
address is trusted because it is written down: `scripts/deploy.js` refuses
to send a single transaction until its preflight has re-derived every one of
them from the chain it is about to deploy on (`scripts/lib-net.js` →
`preflight`):

| Check | Proves |
|---|---|
| `chainId` | the RPC is the chain the config says |
| `endpoint.eid()` equals the configured eid | this is LayerZero's EndpointV2 for that chain |
| USDC `symbol() == "USDC"`, `decimals() == 6` | an ERC20 that looks like USDC |
| USDC `isMinter(TokenMessengerV2.localMinter()) == true` | it is the **Circle-native** token, not a bridged `USDC.e` / `USDbC` look-alike (those do not list Circle's CCTP minter) — and the CCTP address is the one that mints it |
| `TokenMessengerV2.localMessageTransmitter().localDomain()` equals the configured domain | the CCTP contracts are Circle's for this chain |

How each row below earned its status:

- **preflight (live)** — `npx hardhat run scripts/preflight.js`, read-only
  against the public RPC of each chain, 2026-11-13: every address check
  passed on Base, Optimism, Arbitrum One and Ethereum.
- **fork** — additionally USED by the real deploy script and the fork tests
  on an anvil fork of that chain (`npm run test:fork`): USDC pulled, paid
  out and burned; CCTP `depositForBurn` called; the endpoint quoted, sent
  and configured. Base and Optimism only.
- The fork tests also prove the preflight REFUSES a lie: a wrong token
  (WETH), a wrong CCTP domain, a wrong eid and a wrong chain id each abort
  the deploy before any transaction.

Two independent read-only passes that preceded the tooling are kept at the
end of this file; one of them caught a wrong Ethereum USDC address quoted
from memory (it failed the EIP-55 checksum). Never type these from memory.

Scope (2026-11-14): the five EVM chains of THE universe — Base (hub),
Optimism, Arbitrum One and Ethereum, which have Circle's native USDC **and**
CCTP V2 (their vaults level each other), and BNB Chain, which has neither:
its spoke settles in Binance-Peg USDT through `OmniUSDLocal` (no CCTP, never
a CCTP peer). The single-chain BNB and Ethereum universes of v7.1 are
retired ([BNB-UNIVERSE.md](BNB-UNIVERSE.md)). Re-checked 2026-11-14:
`npx hardhat run scripts/preflight.js` passed every address check on all
five chains, and every verifier of every pathway quoted it.

## BNB Chain — the USDT spoke (label 4; verified 2026-11-14)

| Address | What | How it is checked |
|---|---|---|
| `0x55d398326f99059fF775485246999027B3197955` | **BSC USDT** ("Tether USD" / `USDT`, **18 decimals**), Binance-Peg BEP20 behind a `BEP20UpgradeableProxy`; owner `0xF68a4b64162906efF0fF6aE34E2bB1Cd42FEf62d` (`getOwner()`), which can `mint` | preflight (live): `symbol() == "USDT"`, `decimals() == 18`, `totalSupply()` inside 1–100 B whole USDT (9.18 B on 2026-11-14); **fork**: deposited, paid out, claimed and unwrapped by the canary of the five-chain rehearsal (`npm run rehearse`) |
| `0x1a44076050125825900e736c501f859c50fE728c` | LayerZero EndpointV2 on BNB Chain, **eid 30102** | preflight (live): `eid() == 30102`; **fork**: real sends and receives in the rehearsal (relay: verify as the receive library, then the endpoint's own `lzReceive`) |
| chain id **56** | | preflight (live) |

No CCTP, no Circle check: the deploy, the self-check and `status.js` refuse
any state in which a USDC vault names label 4 as a CCTP peer. The peg is
Binance's — one key can mint this dollar — which is why the BNB vault's
launch cap (10,000 USDT) is its own setting: it bounds every holder's
exposure to a USDT de-peg (SPEC §7).

## Ethereum — a USDC spoke behind a launch ceiling (label 2; verified 2026-11-14)

| Address | What | How it is checked |
|---|---|---|
| `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | Circle-native **USDC** on Ethereum (6 decimals) | preflight (live): `symbol`, `decimals`, `isMinter(TokenMessengerV2.localMinter())`; **fork**: minted by Circle's minter (impersonated) and used by the Ethereum canary (open, buy, sell, pull, unwrap) |
| `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | Circle `TokenMessengerV2` — the Ethereum vault is a CCTP peer of the three other USDC vaults (domain 0) | preflight (live) |
| `0x1a44076050125825900e736c501f859c50fE728c` | LayerZero EndpointV2 on Ethereum, **eid 30101** | preflight (live); **fork**: real sends and receives in the rehearsal |
| chain id **1** | | preflight (live) |

Ethereum is a spoke of the one universe since 2026-11-14, with a launch
ceiling (`SpawnPad.syncCap`, 0.0003 ETH by default): while its SYNC costs
more, launches skip it and a token is opened there per token (`openToken`).
Deployer today: **0 ETH, 0 USDC** on Ethereum — fund ~0.02 ETH for the
deploy, and 5 USDC + ~0.02 ETH for its canary.

## Native USDC

Source: <https://developers.circle.com/stablecoins/usdc-contract-addresses>

| Chain | Address | Status | Notes |
|---|---|---|---|
| Ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | VERIFIED — preflight (live) + fork (rehearsal) | a spoke behind a launch ceiling |
| OP Mainnet | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | VERIFIED — preflight (live) + fork | pulled into the vault, paid out to users on the fork |
| Arbitrum One | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | VERIFIED — preflight (live) + fork (rehearsal) | the canary's round trip on the five-chain rehearsal |
| Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | VERIFIED — preflight (live) + fork | full local trading and a CCTP burn on the fork |

Beware of look-alikes: each of these chains also has a *bridged* USDC
(`USDC.e` / `USDbC`) with the same symbol and decimals. `symbol()` and
`decimals()` alone do not tell them apart — the address must match Circle's
table, and CCTP's `TokenMinterV2` must recognize it as a burnable local
token. (An Ethereum USDC address quoted from memory earlier in this project
was wrong in its last 12 bytes; never type these from memory.)

## Circle CCTP V2

Source: <https://developers.circle.com/cctp/evm-smart-contracts>
(same address on all four chains, per that page)

| Contract | Address | Status | Evidence |
|---|---|---|---|
| TokenMessengerV2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | VERIFIED — preflight (live, 4 chains) + fork (Base) | on the Base fork `OmniUSD.rebalance` called its 7-argument `depositForBurn` and Circle's `DepositForBurn` event named exactly the peer vault, its domain, the amount, `maxFee = 0`, threshold 2000 |
| MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | VERIFIED — preflight (live, 4 chains) | `localDomain()` returned the domain below on each chain. `receiveMessage` (the relay, `scripts/relay-cctp.js`) has never been called by this project |
| TokenMinterV2 | `0xfd78EE919681417d192449715b2594ab58f5D002` | VERIFIED — preflight (live, 4 chains) | never configured: the preflight derives it (`TokenMessengerV2.localMinter()`) and requires USDC to list it as a minter |

| Chain | CCTP domain | Status |
|---|---|---|
| Ethereum | 0 | VERIFIED — preflight (live) |
| OP Mainnet | 2 | VERIFIED — preflight (live) + fork |
| Arbitrum One | 3 | VERIFIED — preflight (live) |
| Base | 6 | VERIFIED — preflight (live) + fork |

Interface used by `OmniUSD.rebalance` — verified against Circle's source,
`circlefin/evm-cctp-contracts` `src/v2/TokenMessengerV2.sol` and
`src/v2/FinalityThresholds.sol` at master
`a92a2b4e7e6ef99bf0b05dca71780f5ec190e729`
(<https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/TokenMessengerV2.sol>):

```solidity
function depositForBurn(
    uint256 amount,
    uint32 destinationDomain,
    bytes32 mintRecipient,
    address burnToken,
    bytes32 destinationCaller,
    uint256 maxFee,
    uint32 minFinalityThreshold
) external;
// FINALITY_THRESHOLD_FINALIZED = 2000 (Standard Transfer)
// FINALITY_THRESHOLD_CONFIRMED = 1000 (Fast Transfer)
```

Two things in that source that matter operationally:

- `master` contains a **minimum-fee switch** (`minFee`, `getMinFeeAmount`):
  when Circle sets it, `depositForBurn` requires `maxFee >= minFee share`.
  `OmniUSD.rebalance` hard-codes `maxFee = 0`, so it would revert — a safe
  failure, and deliberate: a non-zero fee would land less USDC on the peer
  than was burned and break the backing invariant. The contracts deployed
  on Base and Ethereum on 2026-11-13 did **not** yet expose
  `getMinFeeAmount` (the call fails like an unknown selector).
- `depositForBurn` is `notDenylistedCallers`: Circle can denylist a vault,
  which also makes `rebalance` revert.

## LayerZero V2

Source: LayerZero's deployment metadata,
<https://metadata.layerzero-api.com/v1/metadata/deployments>
(the table at <https://docs.layerzero.network/v2/deployments/deployed-contracts>
is rendered from it).

| Chain | EndpointV2 | eid | Status | Evidence |
|---|---|---|---|---|
| Ethereum | `0x1a44076050125825900e736c501f859c50fE728c` | 30101 | VERIFIED — preflight (live) + fork | sent and received in the rehearsal |
| OP Mainnet | `0x1a44076050125825900e736c501f859c50fE728c` | 30111 | VERIFIED — preflight (live) + fork | quoted, sent (PacketSent), configured, delegate set |
| Arbitrum One | `0x1a44076050125825900e736c501f859c50fE728c` | 30110 | VERIFIED — preflight (live) + fork | sent and received in the rehearsal |
| Base | `0x1a44076050125825900e736c501f859c50fE728c` | 30184 | VERIFIED — preflight (live) + fork | quoted, sent (PacketSent), configured, delegate set |
| BNB Chain | `0x1a44076050125825900e736c501f859c50fE728c` | 30102 | VERIFIED — preflight (live) + fork | sent and received in the rehearsal |

### The verifier set (DVNs) — chosen, configured by `scripts/configure-dvn.js`

`required: LayerZero Labs + Google` · `optional: 1 of {Horizen, Twinstake}`
— three independent attestations per message. Horizen and Twinstake are two
of the four verifiers of LayerZero's own default set on these pathways, so
they are exercised on them every day; Google Cloud is the second required
signer so that no single operator's key decides. The set is custody
security: whoever controls it controls what the hub and the vaults believe.

Addresses are per chain (`config/profiles.js` → `mainnet.dvn.addresses`).
Each one below is the address LayerZero's registry
(<https://metadata.layerzero-api.com/v1/metadata/dvns>) lists for that name
on that chain as live (v2, not deprecated), and each answered `getFee` on
every pathway it serves — `node scripts/dvn-survey.js` re-checks both and
exits 1 on any difference (run 2026-11-13: 16/16 ✓).

| DVN | Base | Optimism | Arbitrum One | Ethereum | BNB Chain |
|---|---|---|---|---|---|
| LayerZero Labs | `0x9e059a54699a285714207b43B055483E78FAac25` | `0x6A02D83e8d433304bba74EF1c427913958187142` | `0x2f55C492897526677C5B68fb199ea31E2c126416` | `0x589dEDbD617e0CBcB916A9223F4d1300c294236b` | `0xfD6865c841c2d64565562fCc7e05e619A30615f0` |
| Google | `0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc` | same | same | same | same |
| Horizen | `0xa7b5189bcA84Cd304D8553977c7C614329750d99` | `0x9E930731cb4A6bf7eCc11F695A295c60bDd212eB` | `0x19670Df5E16bEa2ba9b9e68b48C054C5bAEa06B8` | `0x380275805876Ff19055EA900CDb2B46a94ecF20D` | `0x247624e2143504730aeC22912ed41F092498bEf2` |
| Twinstake | `0xcd37CA043f8479064e10635020c65FfC005d36f6` | `0xa7b5189bcA84Cd304D8553977c7C614329750d99` | `0xa7b5189bcA84Cd304D8553977c7C614329750d99` | `0xa59BA433ac34D2927232918Ef5B2eaAfcF130BA5` | `0x31F748a368a893Bdb5aBB67ec95F232507601A73` |

**BNB Chain (added 2026-11-14).** The four candidates given for BNB Chain
were confirmed three ways before the profile trusted them: (1) LayerZero's
registry lists exactly these four for "bsc" as live v2, non-lzRead DVNs
(`node scripts/dvn-survey.js`, which now maps the profile's `bnb` to the
registry's `bsc`: 20/20 addresses ✓); (2) each answers `getFee` for
`bnb→base` and `base→bnb` on the live chain (`scripts/preflight.js`); (3) on
the forks the real BSC and Base libraries accepted the set on both ends and
every packet of the rehearsal crossed under it. One thing the check caught:
the checksummed form of Horizen's BSC address had been mistyped in the
profile (`…aEC…` for `…aeC…`); ethers rejects a bad checksum, so the quote
failed and the preflight said so — fixed, and the preflight now names a
non-checksummed address as such.

(The same address can be a different operator on another chain — `0xa7b5…0d99`
is Horizen on Base and Twinstake on Optimism and Arbitrum. Hence the table.)

Status: **Base, Optimism and Arbitrum One — LIVE** since 2026-11-13: the set
is configured on both ends of all four pathway directions (cross-checked by
`SPAWN_VERIFY=1 … configure-dvn.js` and by `status.js`), and full round trips
from Optimism and from Arbitrum crossed under it (the canaries).
**Ethereum — re-checked 2026-11-13, not live**: its four addresses match
LayerZero's registry and each quotes `eth→base` and `base→eth`
(`npm run dvn:survey`, 16/16 ✓); on forks of Ethereum AND of the live Base
deployment (`npm run rehearse:add-chain`) the real send and receive
libraries of both chains accepted the set, the hub's side was set BY THE
LIVE TIMELOCK, and the two ends cross-checked equal. Not proven until an
Ethereum leg exists: the DVNs actually signing an `eth↔base` packet.

A chain that lacks one of these verifiers names its own set for its pathway
(`dvn.pathways` in config/profiles.js) — the same names on both ends, each
resolved to that chain's addresses.

Fee per verifier, per pathway (ETH, `getFee`, 2026-11-13) — 25 DVNs are live
on all four chains; every ordinary one quotes the same few 1e-7:

| DVN | op→base | base→op | arb→base | base→arb | eth→base | base→eth |
|---|---|---|---|---|---|---|
| LayerZero Labs / Google / Horizen | 0.00000061 | 0.00000005 | 0.00000061 | 0.00000454 | 0.00000163 | 0.00000666 |
| Twinstake | 0.00000061 | 0.00000004 | 0.00000061 | 0.00000451 | 0.00000161 | 0.00000659 |
| Canary Subsidized | 0.00012600 | 0.00012551 | 0.00012600 | 0.00012930 | 0.00012687 | 0.00013196 |
| WBTC Canary | 0.00025147 | 0.00025098 | 0.00025147 | 0.00025478 | 0.00025234 | 0.00025743 |
| **Canary** (in LayerZero's default set) | **0.00050241** | **0.00050193** | **0.00050241** | **0.00050572** | **0.00050328** | **0.00050837** |

Measured on the forks with the real endpoint: a reply hub → Optimism costs
0.000629 ETH on the default set and **0.000127 ETH** on ours; a buy from
Optimism (send + a 0.0002 ETH reply budget) 0.000898 → **0.000396 ETH**.

## Read-only sanity pass — 2026-11-13

Public RPCs (`mainnet.base.org`, `mainnet.optimism.io`,
`arb1.arbitrum.io/rpc`, `ethereum-rpc.publicnode.com`), `eth_call` only:

| Chain | USDC `symbol`/`decimals` | TokenMessengerV2 → `localMessageTransmitter()` | MessageTransmitterV2 `localDomain()` | `endpoint.eid()` |
|---|---|---|---|---|
| Ethereum | USDC / 6 | `0x81D4…4B64` ✓ | 0 ✓ | 30101 ✓ |
| OP Mainnet | USDC / 6 | `0x81D4…4B64` ✓ | 2 ✓ | 30111 ✓ |
| Arbitrum One | USDC / 6 | `0x81D4…4B64` ✓ | 3 ✓ | 30110 ✓ |
| Base | USDC / 6 | `0x81D4…4B64` ✓ | 6 ✓ | 30184 ✓ |

On Base and Ethereum, a static call of
`depositForBurn(1e6, <other domain>, 0x…01, USDC, 0, 0, 2000)` from an
unfunded account reverted with `ERC20: transfer amount exceeds allowance` —
the 7-argument selector exists and `maxFee = 0` at threshold 2000 passes
Circle's own checks today.

## Independent second pass — 2026-11-13

Run separately from the pass above (different session, values typed
independently — which is how the wrong Ethereum USDC address was caught: it
failed the EIP-55 checksum).

**Native-vs-bridged USDC cross-check.** For each chain,
`TokenMessengerV2.localMinter()` returned
`0xfd78EE919681417d192449715b2594ab58f5D002`, and the candidate USDC answered
`isMinter(0xfd78…D002) == true`. A bridged `USDC.e`/`USDbC` does not list
Circle's CCTP minter as a minter, so this distinguishes the native token:

| Chain | USDC | `isMinter(CCTP TokenMinterV2)` | `totalSupply` |
|---|---|---|---|
| Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | true | 4.36B |
| OP Mainnet | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | true | 0.12B |
| Arbitrum One | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | true | 2.47B |
| Ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | true | 44.71B |

**LayerZero pathways.** `endpoint.defaultSendLibrary(otherEid)` is non-zero
for every ordered pair among the four chains.

## What a LayerZero message costs on mainnet — and why

`endpoint.quote` on 2026-11-13, 320-byte message, default config, native ETH:

| Route | 300k gas | 3M gas |
|---|---|---|
| Optimism → Base | 0.000632 | 0.000648 |
| Base → Optimism | 0.000628 | 0.000631 |
| Arbitrum → Base | 0.000632 | 0.000648 |
| Base → Arbitrum | 0.000651 | 0.000705 |
| Ethereum → Base | 0.000765 | 0.000808 |
| Base → Ethereum | 0.001338 | 0.001639 |

Attaching a 0.00002 ETH native drop to the destination adds ~0.000024 ETH.
Execution gas is nearly irrelevant on L2 destinations; the fee is a floor.

**The floor is one DVN.** The default ULN config
(`SendUln302.getUlnConfig`) is 4 REQUIRED DVNs, 0 optional — and
`IDVN.getFee` per verifier (names from
<https://metadata.layerzero-api.com/v1/metadata/dvns>) shows where the money
goes:

| Route | DVN | Address | Fee (ETH) |
|---|---|---|---|
| OP → Base | Canary | `0x5b6735c66d97479cCD18294fc96B3084EcB2fa3f` | **0.000502** |
| | LayerZero Labs | `0x6A02D83e8d433304bba74EF1c427913958187142` | 0.0000006 |
| | Horizen | `0x9E930731cb4A6bf7eCc11F695A295c60bDd212eB` | 0.0000006 |
| | Twinstake | `0xa7b5189bcA84Cd304D8553977c7C614329750d99` | 0.0000006 |
| Base → OP | Canary | `0x554833698Ae0FB22ECC90B01222903fD62CA4B47` | **0.000502** |
| | LayerZero Labs | `0x9e059a54699a285714207b43B055483E78FAac25` | ~0 |
| | Horizen | `0xa7b5189bcA84Cd304D8553977c7C614329750d99` | ~0 |
| | Twinstake | `0xcd37CA043f8479064e10635020c65FfC005d36f6` | ~0 |

One verifier is ~80% of the price. With an explicit ULN config that does not
include it, a message costs ~0.00013 ETH (executor + treasury). Consequences
baked into v7:

- The adapter sets a delegate so the admin can call `endpoint.setConfig`.
  Send config on the source and receive config on the destination must name
  the SAME DVN set for every pathway, or messages stall.
- The DVN set is custody security (a forged hub→spoke PAYOUT pays real
  USDC). It has since been chosen and tooled — see "The verifier set
  (DVNs)" above; this section is the analysis that led to it, kept as
  written on 2026-11-13.
- Hub-local trading on Base (no LayerZero message at all) is the primary
  path; cross-chain entry is the premium path and shows its fee.

## What an Ethereum leg costs — measured 2026-11-13

`npm run rehearse:add-chain` adds Ethereum to forks of the LIVE deployment
through the timelocks, then asks the real EndpointV2 on the Base fork for
quotes under our verifier set — at the L1 gas price LayerZero's price feed
held that day (0.14 gwei) and again after telling that same feed 5 and 30
gwei. Hub-side cost, ETH (USD at 1,962 $/ETH), with 1.0M executor gas bought
per message to Ethereum:

| L1 gas | SYNC → Ethereum | reply → Ethereum | a launch from Base prepays | … without Ethereum |
|---|---|---|---|---|
| 0.14 gwei (today) | 0.000956 | 0.000955 | **0.00156** (3.07 $) | 0.00037 (0.72 $) |
| 5 gwei | 0.00800 | 0.00799 | **0.0104** (20 $) | 0.00037 |
| 30 gwei | 0.0451 | 0.0451 | **0.0568** (111 $) | 0.00037 |

(The L2 quotes do not move: SYNC → Optimism 0.000127, → Arbitrum 0.000169.)

What that means, given that `pad.setGateway` is permanent and every spawn
SYNCs every wired chain:

- **Every launch, from every chain, pays the Ethereum SYNC** — 4.2× today's
  launch fee at 0.14 gwei, and it scales with L1 gas from there.
- **Every trade from Ethereum prepays an Ethereum reply** (0.0012 ETH with
  the margin today, on top of its own L1 transaction and send).
- **The contracts' ceilings bite early.** A launch from a spoke prepays
  `spawnLegs × returnUnit`, and `spawnLegs ≤ 32`. At Optimism's reply price
  (0.00016 ETH/leg) that is 0.0051 ETH: above **≈2 gwei** L1 a launch from
  Optimism can no longer prepay the Ethereum SYNC (≈3 gwei from Arbitrum)
  and the hub tank pays the difference — a drain anyone can trigger by
  launching — unless the operator raises that chain's per-leg price, which
  every trade from that chain then pays too. `tune-fees.js` clamps and warns;
  it does not make that trade-off by itself. `returnUnit ≤ 0.05 ETH` caps an
  Ethereum reply at ≈26 gwei.
- The only brake during an L1 gas spike is pausing entry (gateways) — there
  is no way to stop SYNCing a wired chain.

Deploying the leg itself is cheap at 0.1 gwei: the preflight asks the
deployer for 2 × 12.07M gas at the live gas price (0.0026 ETH on
2026-11-13), and the canary from Ethereum costs ≈0.009 ETH in messages.
