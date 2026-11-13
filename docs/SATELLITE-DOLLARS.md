# Chains without Circle USDC — BNB Chain and Robinhood Chain

Research and design memo, 2026-11-13. No code. Every on-chain fact below was
read today with `eth_call` against public RPCs; every external fact carries
its URL. Where a fact rests on one weak source it says so.

## The short answer

- **Robinhood Chain: wait — and not for long, by the look of it.** Circle's
  CCTP V2 and a 6-decimal `USDC` are already deployed and wired on Robinhood
  Chain (CCTP domain 35), but not switched on: 2.63 USDC of supply, burns
  disabled, and Base / Ethereum / Optimism / Arbitrum do not recognize domain
  35 yet. The day that flips, Robinhood is an ordinary v7 spoke with **zero
  new custody code**. Adding a USDG satellite before then would be permanent
  (a gateway can never be removed or replaced) and would put a second dollar
  under every existing user's claim.
- **BNB Chain: not safely in the shared universe, yet.** There is no Circle
  dollar and no sign of one (CCTP domain 17 has no USDC linked on-chain).
  Every dollar there is either a Binance custodial peg or an issuer with no
  burn/mint route to USDC. The honest options are a **separate BNB-only
  universe** (its tokens are not the Base-universe tokens) or waiting.
- **No single dollar is issuer-native on Base + Optimism + Arbitrum + BNB +
  Robinhood.** A different settlement asset would not have solved this.

## 1. Facts

### 1.1 Robinhood Chain

| Fact | Value | How it was established |
|---|---|---|
| Mainnet | chain id 4663, live since ~2026-07-01, Arbitrum Orbit (Nitro) L2 settling to Ethereum with blobs | RPC `eth_chainId` = 4663 (block 113,543,816 at read time); launch date and stack: <https://defiprime.com/robinhood-chain>, <https://docs.bitquery.io/docs/blockchain/robinhood/robinhood-chain-rpc-chain-id/> |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` (rate-limited) | answered every call in this memo |
| Block time, gas | ~0.106 s per block (3,000 blocks in 317 s); gas token ETH; gas price 0.02 gwei | measured on-chain |
| Explorer | `robinhoodchain.blockscout.com` (behind an anti-bot challenge — not queried). LayerZero's registry names `robin.etherscan.io`; the two sources disagree | <https://docs.bitquery.io/docs/blockchain/robinhood/robinhood-chain-rpc-chain-id/>, <https://metadata.layerzero-api.com/v1/metadata/deployments> |
| Deployment | permissionless: a contract-creation `eth_call` and `eth_estimateGas` (56,132 gas) from arbitrary addresses succeed; press says the same | measured; <https://defiprime.com/robinhood-chain> |
| Who runs it | one sequencer, "run by or on behalf of Robinhood", first-come-first-served | <https://defiprime.com/robinhood-chain> |
| Restrictions | the tokenized STOCKS are geofenced (not the US; restricted in UK, Canada, Switzerland, UAE). No allowlist on deploying or transacting was found. "In supported jurisdictions" appears in one secondary source only | <https://defiprime.com/robinhood-chain>; weak: eco.com article surfaced by search |
| LayerZero V2 | EndpointV2 `0x6f475642a6e85809b1c36fa62763669b1b48dd5b`, `eid()` = 30416 | on-chain |
| LayerZero default pathway Base ↔ Robinhood | **closed**: the default ULN config on both ends names only `LZDeadDVN` (Base `0x6498b0632f3834d7647367334838111c8c889703`, Robinhood `0x6788f52439aca6bff597d3eec2dc9a44b8fee842`) and `endpoint.quote` reverts. An OApp must set its own verifier set on both ends | on-chain + <https://metadata.layerzero-api.com/v1/metadata/dvns> |
| Verifiers on both Robinhood and Base | ApeDVN, Blockaid, Canary (three variants), Deutsche Telekom, Fidelity Center for Applied Technology, Frax, FurtherFP, Horizen, LayerZero Labs, Luganodes, Nansen, P2P, Paxos, StablecoinX, Superform, Twinstake. **Google is not on Robinhood.** | LayerZero DVN registry; each of the ten I tried answers `getFee` in both directions (~0.000002 ETH Base→Robinhood, ~0.0000006 ETH back) |
| DEXes | Uniswap, Pleiades (prop AMM), Lighter (perps) live at launch | <https://defiprime.com/robinhood-chain> |
| Bridges | canonical Arbitrum bridge (≈10 min in, ≈7 days out), LayerZero, Chainlink CCIP, Relay, Across, LiFi | <https://docs.bitquery.io/docs/blockchain/robinhood/robinhood-chain-rpc-chain-id/> |

**The dollars on Robinhood Chain**

| Dollar | Address | Dec. | Supply there | Issuer / how it moves |
|---|---|---|---|---|
| **USDG** (Global Dollar) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | 6 | **630,204,816** | Issued by Paxos (Paxos Digital Singapore under MAS; Paxos Issuance Europe under FIN-FSA / MiCA) — <https://globaldollar.com/build-with-usdg>. A Paxos-pattern token (`supplyControl()` answers, it is not itself an OFT). Very active: 4,363 transfers in 317 s. |
| **USDC** (Circle, staged) | `0x3884564BA51B349e7661c7e28Ad947DEE327FeDF` | 6 | **2.63** | see below — deployed, not live |
| bridged USDC, USDT | not established | — | — | the explorer could not be queried; no source names one |

USDG moves between chains through a **Paxos-run LayerZero OFT mesh** rooted on
Ethereum (adapter `0x147bde4f997f0d4c7544ed0c55eacf1e5e6bf9c4`). Read on-chain:
the Ethereum adapter has peers on Solana, Ink, Robinhood
(`0x0d54755f5106BfdB43f7a35f5D49a23F940628d1`), Arbitrum
(`0xc3274ec3f772d8534575eaad5231cf250a48b6b6`), Mantle and X Layer — and
**none on Base, Optimism or BNB**. The Robinhood-side OFT has peers on
Ethereum and Solana only, so Robinhood → Arbitrum is two hops through
Ethereum. USDG supply: Ethereum 301.4M, Arbitrum 62.3M (token
`0x004B506865409877C9fA29bfb1ebA929984B9bbC`), Robinhood 630.2M. "USDG0" is a
separate bridged product by Paxos Labs for Hyperliquid / Plume / Aptos
(<https://www.paxoslabs.com/posts/introducing-usdg0>).

USDG ↔ USDC on-chain liquidity is thin where I could measure it: the only
Uniswap v3 USDG/USDC pool on Arbitrum holds **$302 + $181**; the one on
Ethereum holds **76k USDG + 176k USDC**. One third-party source says Across
delivers USDC from 13 chains as USDG on Robinhood (single weak source:
search summary of a stablecoin newsletter). Paxos redeems 1:1 for its own
customers, which is an account, not a contract.

**Circle on Robinhood Chain — deployed, wired, not switched on.** Circle's
pages list neither USDC nor CCTP there
(<https://developers.circle.com/stablecoins/usdc-contract-addresses>,
<https://developers.circle.com/cctp/cctp-supported-blockchains>). On-chain:

- `TokenMessengerV2` and `MessageTransmitterV2` exist at Circle's canonical
  addresses (`0x28b5a0e9…cf5d`, `0x81D40F21…4B64`);
  `MessageTransmitterV2.localDomain()` = **35**;
- `TokenMinterV2` (`0xfd78EE91…D002`) maps the USDC of Ethereum, Optimism,
  Arbitrum and Base to local token `0x3884564B…FeDF` — symbol `USDC`, 6
  decimals, `isMinter(TokenMinterV2)` = true;
- the Robinhood messenger already names remote messengers for domains 0, 1,
  2, 3, 5, 6, 7, 10;
- **but** `burnLimitsPerMessage(USDC)` = 0, total supply is 2.63, and on
  Ethereum, Base, Optimism and Arbitrum `remoteTokenMessengers(35)` is
  empty. Nothing can cross yet.

### 1.2 BNB Chain

LayerZero V2 is there (`eid()` = 30102) and the default Base ↔ BNB pathway is
open (Base→BNB quotes 0.000655 ETH, BNB→Base 0.00185 BNB on defaults). Our
core verifier set — LayerZero Labs + Google, 1 of Horizen / Twinstake —
exists on BNB and quotes in both directions.

| Dollar | Address | Dec. | Supply on BNB | Issuer and cross-chain trust |
|---|---|---|---|---|
| USDT ("BSC-USD") | `0x55d398326f99059fF775485246999027B3197955` | 18 | 9.18B | Binance-Peg: "minted by Binance" (<https://www.binance.com/en/collateral-btokens> — the page showed no backing figures today). A custodial IOU on Binance, not Tether's burn/mint |
| USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 18 | 1.59B | Binance-Peg, same trust. **Not Circle's.** Redeemable for real USDC only through Binance |
| USD1 | `0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d` | 18 | 1.12B | World Liberty Financial, reserves at BitGo, moves by Chainlink CCIP; on Ethereum, BNB, Solana, Tron and others — not found on Base, Optimism or Arbitrum (secondary sources: <https://www.allium.so/blog/what-is-usd1-stablecoin-a-clear-guide/>, <https://blockworks.co/news/bitgo-to-custody-wlfi-usd1>) |
| FDUSD | `0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409` | 18 | 55.9M | First Digital |
| USDe | `0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34` | 18 | 78.4M | Ethena, a LayerZero OFT — a synthetic dollar, not a fiat-redeemable one. Also on Base, Optimism, Arbitrum; not on Robinhood (<https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list>) |
| USDT0 | — | — | — | not on BNB in LayerZero's OFT registry; one AI-written page says otherwise, one article says no — **unconfirmed** |
| Circle USDC | none | — | — | CCTP domain 17 is "USYC only" (Circle's page); on-chain the BNB `TokenMinterV2` links no token to Ethereum's or Base's USDC and has no Base messenger |

Liquidity between BNB's own dollars is deep (two PancakeSwap v3 USDT/USDC
pools hold ~$31.8M and ~$39.2M; USD1/USDT ~$5.3M). None of it leads to
Circle USDC: that conversion is a Binance account or a third-party bridge
with its own pools.

### 1.3 Is any dollar issuer-native everywhere?

| Dollar | Base | Optimism | Arbitrum | BNB | Robinhood |
|---|---|---|---|---|---|
| Circle USDC (CCTP) | yes | yes | yes | no | staged, not live |
| Paxos USDG (OFT mesh) | no | no | yes | no | yes |
| USDT0 | yes (Stargate-run mesh) | yes | yes | unconfirmed, likely no | no |
| USDe (synthetic) | yes | yes | yes | yes | no |
| USD1 (CCIP) | not found | not found | not found | yes | not found |

No row is all "yes". Settling in something else would not have let five
chains share one dollar.

## 2. Why this is hard — it is not the decimals

One curve on the hub prices a token for every chain, so dollars that enter on
chain A pay sellers on chain B. The books always balance globally:

```
Σ over chains (dollars in vault)  =  Σ over chains (oUSD claims there)  +  hub ledger
```

Between USDC chains the vaults are levelled with CCTP: Circle burns on one
side and mints on the other, so "a dollar in the Optimism vault" and "a
dollar in the Base vault" are the same thing. A satellite vault holding
USDG or BSC-USD cannot be levelled with anything. Call `N` the satellite's
net inflow (what its users put in minus what they were paid):

- `N > 0` — the satellite vault ends up holding `N` dollars that nobody on
  that chain is owed, and the USDC chains together hold claims worth `N`
  more than their USDC. Nothing can move the `N`.
- `N < 0` — satellite users hold `|N|` of claims their vault can never pay.

Worked example. BNB buyers put in $100k, Base buyers $100k. The Base crowd
was early; when it is over Base has taken out $150k and BNB $50k. The Base
vault held $100k and owes $150k: **$50k of claims on Base have no USDC
behind them, while $50k of BSC-USD sits in the BNB vault owned by no one.**
On a launchpad this is the normal case, not the edge case — a token has a
home crowd that sells into the next chain's buyers.

Two things make it worse than a delay:

1. **It turns into a run.** The Base vault still pays whoever unwraps first
   (new deposits keep arriving), so the hole is handed to whoever exits
   last.
2. **A depeg lands on everyone.** If the satellite dollar goes to $0.90 the
   shared backing is short by 10% of the satellite vault, and holders on
   Base wear part of it.

One bound does exist today: `N` can never exceed what the satellite vault
holds, and a vault cannot hold more than its **deposit cap**. So the core's
exposure to a satellite is at most that satellite's cap. The cap bounds the
stock, not the leak: stranded dollars occupy cap space for good, so a
satellite slowly closes itself to new buyers.

## 3. What the live hub allows

The hub pad and its ledger are immutable, and the ledger is unit-blind: it
books what a gateway says arrived. So a satellite **can** be attached —
`pad.setGateway(label, gateway)` through the 48h timelock — and the vault
and gateway on the new chain are new code that may differ. What cannot
change:

- a gateway is **forever**: no removal, no replacement. Label 4 (BNB) or a
  new label for Robinhood, once used for a satellite dollar, can never
  become the USDC spoke; that would need yet another label;
- **every spawn SYNCs every chain, forever**: each extra chain adds a
  LayerZero message to every launch (the launcher pays) and ~0.27M gas to
  the hub's worst-case spawn — the 4.6M hub gas budget covers three remote
  chains today;
- the live USDC vaults release USDC only by payout, `unwrap`, or CCTP
  `rebalance` to a registered peer. There is no path from them to a
  non-CCTP chain.

## 4. The designs

| | What a core (USDC) user can lose | What a satellite user can lose | Who is trusted | One-sided flows | New custody code | Hub can host it |
|---|---|---|---|---|---|---|
| **(a)** satellite vault, local dollar, no rebalancing | unpayable claims and depeg loss, up to the satellite's deposit cap | unpayable claims when the satellite is net winner — unbounded; the local dollar's issuer | the satellite dollar's issuer and bridge | claims pile up on one side, dollars strand on the other; the satellite clogs | vault variant (18 decimals / no CCTP) | yes |
| **(b)** (a) + conversion path | same bound while conversion lags; plus whatever is in transit | same | **operator-run:** a key holding backing in transit, plus a CEX or issuer account. **Routed:** a converter contract, a bridge and DEX depth | levelled only as fast as the path allows | (a) + converter + sweep rules — the largest and riskiest piece | yes; core→satellite needs a converter registered as a CCTP "peer" on a CCTP chain |
| **(c)** settle the satellite in an asset redeemable 1:1 into USDC | nothing new | nothing new | Circle | levelled by CCTP | none | yes — **but no such asset exists on BNB, and on Robinhood it is not live yet** |
| **(d)** (a) + a hard net-inflow cap enforced by the satellite | at most the cap (tighter than the deposit cap) | as (a) | as (a) | buys from the satellite stop when the cap is reached | (a) + ~40 lines of accounting | yes — the gateway and vault see their own deposits and payouts; the hub is untouched |
| **(e)** a separate hub for the other dollar | nothing — untouched | only their own universe's risks | that dollar's issuer | contained in that universe | vault variant; second deployment of the same pad | n/a — it is another hub |
| **(f)** wait for Circle | nothing | nothing | — | — | none | yes, as a normal spoke |

Notes on each.

**(a)** The cap makes it bounded, not safe. With a $25k cap, up to $25k of
core claims can end up backed by a dollar on a chain their holders cannot
reach. It also changes what existing users were told — "every claim is
backed by USDC" becomes "by USDC, except up to the satellite cap".

**(b)** Candidate paths, and their limits.
*Robinhood:* Paxos mint/redeem (an institutional account); the Paxos OFT
mesh to Ethereum then a DEX (measured depth: ~$250k on Ethereum, ~$500 on
Arbitrum); Across / Relay / LiFi intents (relayer liquidity, fees; the
USDC→USDG claim rests on one weak source).
*BNB:* Binance (custodial account); a pool bridge such as Stargate or an
intents bridge — not verified today for native-USDC delivery from BNB.
Either way the protocol's backing passes through a hot key or through
someone else's liquidity. This is the design most likely to lose money by
accident.

**(c)** Robinhood is one switch away from having it. BNB has nothing:
Binance-Peg USDC is redeemable only at Binance.

**(d)** Expressible without touching the hub, and strictly better than (a):
the satellite refuses a buy once `deposits − payouts` would exceed the
limit. It protects the core. It does not protect satellite users when they
are the net winners — the hub decides payouts, and the satellite cannot
refuse to be owed. It also still makes the system's backing mixed.

**(e)** A second universe is clean because nothing is shared: a hub on the
satellite chain settling in its own dollar, with local trading in one
transaction (the code path that runs on Base today). The cost is the
product promise: a token launched there is **not** the token launched on
Base. "One token, one price" is true inside each universe and false across
them. For Robinhood such a universe could later reach Arbitrum, Ethereum
and Solana, where USDG is issuer-native — with a vault that levels through
Paxos' OFT mesh instead of CCTP (new custody code again).

**(f)** Costs nothing and risks nothing. For Robinhood it has a visible
end; for BNB it does not.

**Existing mainnet users.** They hold claims the site describes as
USDC-backed. Under (c), (e) and (f) nothing changes for them. Under (a),
(b) and (d) they acquire exposure to another issuer and to stranded
liquidity, bounded by a cap they did not agree to — that needs a notice
before, not after, and it cannot be undone once the gateway is set.

## 5. Recommendation

**Robinhood Chain — (f), wait for Circle, then add it as a normal spoke.**
The smallest safe first step is no transaction at all:

1. Watch three on-chain conditions (read-only, scriptable today):
   `TokenMessengerV2.remoteTokenMessengers(35) != 0` on **Base**;
   `TokenMinterV2.burnLimitsPerMessage(0x3884564B…FeDF) > 0` on Robinhood;
   the token's supply in the millions rather than 2.63. And Circle's two
   pages listing the chain — do not deploy on the on-chain signs alone.
2. Before deploying, run the same preflight as every other chain
   (`isMinter(TokenMessengerV2.localMinter())`, `localDomain()`), with a
   small canary cap.
3. Prepare the tooling for a **per-pathway verifier set** — today the
   profile has one global set, and Google is not on Robinhood.

New unaudited custody code: **none.** A USDG satellite in the meantime is
the wrong trade: it is permanent, it would be superseded within what looks
like a short time, and it would leave every future launch SYNCing a dead
label.

**Verifier set for Base ↔ Robinhood** (spokes only talk to the hub, so this
is the only pathway): required **LayerZero Labs + Deutsche Telekom**,
optional **1 of Horizen, Twinstake** — the same shape as the core set, with
the missing Google replaced by an independent infrastructure operator
present on both ends. P2P, Nansen, Luganodes and Fidelity's FCAT are
equivalent substitutes; I would not use Paxos (it issues the chain's other
dollar) or the Canary family (the expensive default). All quote for about
0.000002 ETH. The default pathway is the dead verifier, so nothing flows
until both ends are set and read back.

**BNB Chain — not safely in the shared universe.** In order of preference:

1. **(f)** wait — honest about there being no date;
2. **(e)** a BNB-only universe settling in USDT, if being on BNB matters
   more than the token being the same token. New custody code: a vault
   variant (18 decimals, no CCTP) — roughly 40 changed lines in a 250-line
   contract, plus tests and a BNB fork suite; the pad is reused unchanged;
3. **(d)** a capped satellite on the live hub, only if the owner accepts in
   writing that up to the cap can be stranded or depegged at existing
   users' expense, and tells them first. New custody code: the same vault
   variant plus net-inflow accounting; permanent.

Never **(a)** uncapped, and not **(b)** before an audit.

## 6. What I am least sure of

1. **That the CCTP contracts and the `USDC` token on Robinhood Chain are
   Circle's.** They sit at Circle's canonical addresses with a coherent
   configuration, but their owner (`0x4dDb5D4e…89EA`) differs from Base's,
   Circle's pages do not list the chain, and I could not check the
   explorer. Treat "staged by Circle" as very likely, not proven.
2. **What other dollars exist on Robinhood Chain** (a bridged USDC or USDT)
   and their liquidity against USDG — the explorer was unreachable and no
   source names one. USDG/USDC depth was measured only in direct Uniswap v3
   pools on Arbitrum and Ethereum; other venues were not surveyed.
3. **USDT0 on BNB Chain and the exact backing of Binance-Peg tokens.**
   LayerZero's OFT registry shows no USDT0 on BNB and sources conflict;
   Binance's collateral page showed no figures today. Neither changes the
   recommendation.
