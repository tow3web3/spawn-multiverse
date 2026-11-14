# SPAWN! on-chain architecture

One token. Every chain. One price. This document explains how the on-chain
protocol works, how to run it locally, and what the path to testnet/mainnet
looks like.

## The core idea: hub & spokes

There is only **one market per token** — a genesis curve (then an omnipool)
living on the **hub**. The six user-facing chains are **entry points**:

```
user on Solana ─┐
user on Base   ─┤   burn oUSD            ┌─> deliver tokens (mint replica)
user on BNB    ─┼─> [SpawnGateway] ──msg──> [SpawnPad / hub]
user on ETH    ─┤                         │   · one genesis curve per token
user on ARB    ─┤                         │   · ascension -> omnipool
user on OP     ─┘                         └─> payout oUSD (mint on spoke)
```

Because every buy and sell — from any chain — executes against the same
curve, the price is **identical everywhere by construction**. There is no
arbitrage to do, because there is nothing to arbitrage: no fragmented pools,
no per-chain price.

Inside the hub, **settlement and price discovery are separate modules**. The
pad owns custody, messaging and the canonical event stream; *where* the
market sits is a pluggable `ICurveVenue`:

```
[SpawnPad]  ──execBuy/execSell──>  [ICurveVenue]
 settlement                         price discovery
 · custody, oUSD burn/mint          · InternalCurveVenue (local / EVM hub)
 · omnichain messaging              · Raydium LaunchLab / Meteora DBC
 · Spawned/Trade/Ascended events      adapter (production Solana hub)
```

The gateways never know which venue is live — they keep burning oUSD and
sending the same messages. This slot is the whole visibility strategy
(see the last section).

## Contracts (`contracts/contracts/`)

| Contract | Role |
|---|---|
| `SpawnPad.sol` | The hub. Factory + settlement: token custody, oUSD burn/mint, omnichain messaging, and the canonical `Spawned` / `Trade` / `Ascended` event stream (one address for indexers). Routes every trade through the venue and takes the **1% fee** into one global pot per token. |
| `ICurveVenue.sol` / `InternalCurveVenue.sol` | The price-discovery slot. The internal venue is the genesis curve (constant-product, virtual reserves, 800M/1B on the curve) + ascension to the omnipool. Pure accounting — the pad keeps custody — so it swaps for a Raydium LaunchLab / Meteora DBC adapter without touching settlement or gateways. |
| `SpawnGateway.sol` | One per chain. Users `spawnToken` / `buyToken` / `sellToken` here with **no approvals**. Forwards everything to the pad as omnichain messages; mints deliveries and payouts coming back. |
| `SpawnToken.sol` | The creature. Hub instance pre-mints the whole 1B supply to the pad; spoke replicas are minted/burned as tokens cross chains. **Sum of supplies across chains ≡ 1B, always** (tested). |
| `OmniUSD.sol` / `OmniUSDLocal.sol` | Each chain's dollar vault: it holds that chain's dollar (USDC, levelled with Circle CCTP; Binance USDT on BNB Chain, `OmniUSDLocal`, no wrap) and is the 18-decimal oUSD claim on it. A short vault pays in claims, which can be moved to another chain (v7.2). The hub's instance is a pure ledger. |
| `OmniMessenger.sol` | The transport abstraction. Contracts only know `IOmniMessenger` / `IOmniReceiver`. Locally, `LocalOmniMessenger` hosts all logical chains on one node and delivers synchronously. |
| `lz/LayerZeroOmniMessenger.sol` | The production transport: one adapter per chain over the real LayerZero V2 endpoint signatures (`lz/ILayerZeroV2.sol`), peered, with a native-fee gas tank. Tested against `lz/MockLZEndpointV2.sol`, which queues packets and lands them in **separate transactions** — the async reality of testnet/mainnet. |

## Fees: one market, one pot

Every trade pays **1%**, routed per a fee mode the dev locks at launch:
`FEE_HOLDERS` (100% to holders), `FEE_SPLIT` (50/50), `FEE_DEV` (100% dev,
claimable) or `FEE_BURN` (auto buyback & burn). Because there is only one
market, fees from all six chains land in **one oUSD pot on the hub** — no
per-chain reconciliation:

- **FAIR GENESIS (v6, live)** — block 0 accepts no buys at all, then for 10
  minutes every buy pays a snipe tax decaying 30%→1% (routed through the
  token's fee mode: snipers pay everyone else) with a $250/wallet cap; the
  guard **clamps and refunds, never reverts** — a refused cross-chain buy
  rides home in the ordinary `OP_DELIVER`. The dev buy inside the spawn is
  the one disclosed exemption. See SPEC §8.
- **Dev claim** — `gateway.claimFees(token)` from ANY chain; the hub verifies
  the creator and pays out there via the ordinary `OP_PAYOUT` path.
- **Buyback & burn** — once the pot passes $4 the pad executes a REAL buy on
  the curve (it moves the price) and burns the tokens on the spot, shrinking
  global supply for every chain at once (`BuybackBurn` event, tested).
- **Holder stream (v3, live)** — the pot accrues per token; once it passes
  `DIST_TRIGGER` ($2) the pad splits it pro-rata to where the supply actually
  lives (it tracks `supplyByChain` at every mint/burn it orchestrates) and
  drops each slice into that chain's **FeeDistributor** — the hub share
  locally, spoke shares as `OP_FEE_DROP` burn/mints. Each distributor runs
  the classic magnified-dividends-per-share accounting, fed by a transfer
  hook on every SpawnToken, with protocol accounts (pad, venue, gateways)
  excluded. Holders claim with a **pure local transaction** on their own
  chain — no cross-chain hop, no snapshot ceremony, and dividends already
  earned stay claimable after a sell.

Run the invariants suite (`npm run chain:test`): genesis on six chains, single
global curve, supply conservation (including under burns), value conservation,
ascension + refund, fee routing + dev claim + buyback&burn, message
authentication.

## One universe, six chains (v7.2) — what the site does

Since 2026-11-14 SPAWN! is ONE universe on six chains: Base (the hub),
Optimism, Arbitrum, Ethereum, BNB Chain and Solana. The five EVM chains open
first; Solana joins when its program is deployed. The site reads ONE mainnet
manifest (`public/onchain/mainnet.json`, written by the deployment tooling,
`generation: "v7.2"`) and offers trading only on the chains it lists.

- **A dollar per chain.** USDC (6 decimals) on Base, Optimism, Arbitrum and
  Ethereum; Binance USDT (18 decimals) on BNB Chain, behind `OmniUSDLocal`
  (no `wrap`, ever). The manifest declares each chain's dollar
  (`chains[].dollar`, `chains[].vault: "cctp" | "local"`); the site checks
  the token's `decimals()` and the vault's `SCALE()` on that chain and
  refuses to boot on a mismatch. Labels, approvals and amounts follow the
  chain the user is on.
- **Price protection everywhere.** Every trade goes through `buyTokenUsdcMin`
  / `buyTokenMin` / `sellTokenMin` with the user's tolerance. On the hub
  chain an order under its minimum reverts before it is signed; from another
  chain the minimum rides the message and the hub refuses an order under it
  minutes later (`Refused`, reason 6) and sends it back whole, which the site
  says in plain words. Where the gateway has `orderTtl()` (third v7.2
  round) the panel says how long a cross-chain order stays valid, and a
  reason-6 refusal dated after that deadline reads as "expired". A v7.1
  manifest (today's public testnet) keeps the v7.1 behaviour: protection only
  where the hub answers in the same transaction.
- **Open a token on your chain.** A token with no replica on a chain (its
  SYNC was skipped at launch, or the chain joined later) offers `openToken`
  instead of a trade — only after the site has checked that the hub would
  send the SYNC: the hub adapter's live `quote(chain, gateway, sync, 1)`
  (one return leg), asked as the pad, ≤ `pad.requestCap(chain, 10)`;
  otherwise it says the chain is too expensive right now and takes no fee.
- **Move your dollars.** A claim the local vault cannot pay (`liquidity()`)
  can be sent with `moveClaim` to any chain whose vault can pay it, priced by
  `quoteMove(dst)`. A destination is offered only if its route is open AND
  the hub would forward the PAYOUT there (its quote, one return leg, ≤
  `pad.requestCap(dst, 12)`) — otherwise the claim would only come home and
  the fee would be spent. The recipient must have the destination's shape:
  an address toward an EVM chain, a 32-byte key toward a chain whose gateway
  is not an address (Solana).

The decisions behind these (reading hub events, the open verdict, which
chains a claim can go to) live in `src/lib/v72.ts` and are unit-tested on
bare node (`npm run test:units`), including the minutes-later outcomes the
synchronous local world cannot show.

## Running locally

```bash
npm run chain          # terminal 1 — local node (hardhat)
npm run chain:deploy   # terminal 2 — deploy the local v7.2 world + seed 6 tokens
npm run dev            # terminal 3 — frontend, flip the mode switch to LOCAL
```

`contracts/scripts/deploy-local.js` builds one universe on the five EVM
chains behind the synchronous `LocalOmniMessenger` (every message and its
replies land in the sender's transaction), in the shape the mainnet
manifest has:

- Base is the hub chain's own gateway; BNB settles in an 18-decimal mock
  USDT behind `OmniUSDLocal`; the others in mock USDC behind `OmniUSD`;
- every message is paid (a flat fee per message), and opens and moves are
  priced (`openLegs`, `moveLegs`, `requestCap`);
- `PICKL` never reached Ethereum (its launch SYNC was skipped by a
  `syncCap`), so it can be opened there;
- the BNB vault is left short: Hardhat account #19 holds an oUSD claim on BNB
  that the vault cannot pay — load its key as the burner (the script prints
  the `localStorage` line) to find it waiting in the portfolio with MOVE IT.
  The same wallet launched `INTRN`, so its dev dashboard has a fee share.

`npm run chain:bots` predates this world (it assumes 6-decimal dollars and
free messages) and does not run against it.

On-chain mode uses a **burner wallet** (key in localStorage), funded with gas
by the local dev account and with play dollars by the `MINT` button ($1,337
on each chain, in that chain's own dollar). Every buy/sell/spawn/open/move is
a real transaction; charts, tape, holders and per-chain supply come from
contract events.

Two honest demo shortcuts, both with clear production equivalents:

- **Images**: stored in the browser keyed by token address; `metaURI` on-chain
  stays tiny. Production: pin to IPFS, store the `ipfs://` URI.
- **Messaging**: `LocalOmniMessenger` delivers in the same block. The
  production adapter already exists and is tested: `lz/LayerZeroOmniMessenger`
  runs the whole protocol over an async queued endpoint (spawn/buy/sell land
  in separate transactions; supply and value conservation hold — see
  `test/layerzero.test.js`). What remains for testnet is pointing each
  adapter at the real LayerZero V2 endpoint address and funding its gas tank.

## Path to testnet / mainnet

1. **Hub on Solana** — the pad's role moves into an Anchor program whose
   `ICurveVenue` slot is a **Raydium LaunchLab (or Meteora DBC) adapter**:
   the curve is executed by an already-indexed launch venue (see the
   visibility section below). Ascension graduates into Raydium liquidity
   automatically, LP burned.
2. **EVM chains (ETH, Base, BNB, Arbitrum, Optimism)** — deploy the gateway
   bytecode as is, with `lz/LayerZeroOmniMessenger` (already written and
   async-tested) pointed at each chain's real LayerZero V2 endpoint
   (LayerZero V2 connects all six chains, Solana included); swap `OmniUSD`
   for USDC + Circle CCTP (also live on Solana).
3. **EVM-hub fallback** — if the hub stays on an EVM chain instead, the same
   venue slot takes a **Uniswap v4 hook** adapter (curve logic inside a real
   Uniswap pool: every trade is an indexed swap) and ascension LPs into
   Uniswap v3/v4 with the position burned.

## Visibility: Axiom / Dexscreener from the first second

The strategy is **don't ask terminals to index us — run the market on rails
they already index.** That is exactly what the venue slot is for:

- **Curve phase**: on the production Solana hub, `ICurveVenue` is a Raydium
  LaunchLab / Meteora DBC adapter. Axiom, Photon, Bullx, Dexscreener,
  GeckoTerminal and Birdeye index those programs today, so every curve-phase
  trade — including ones routed in from Base or Arbitrum — charts on every
  terminal from the first second. No integration deal, no waiting. (This is
  the lesson of the post-pump.fun launchpads: pump.fun was invisible until
  terminals indexed it; LaunchLab-based launchpads are visible at birth.)
- **Ascension**: liquidity graduates into **Raydium** (or Uniswap v3/v4 on an
  EVM hub) with the LP burned — aggregators pick the pair up automatically,
  usually within minutes.
- **Becoming a venue ourselves (later)**: the pad already emits a complete,
  swap-shaped `Trade` stream from one address, which is what Dexscreener /
  GeckoTerminal / DEXTools ask for in their venue-integration process. With
  traction, "SPAWN!" becomes its own venue label next to pump.fun.
- **What NOT to do**: fake Uniswap-V2 `Swap`/`Sync` events to impersonate a
  pair. Indexers key off canonical factory deployments, not event shapes —
  it fails silently and burns credibility with aggregators.
- **Robinhood / CEX listings** are manual, curated business decisions — no
  protocol design makes that automatic.
