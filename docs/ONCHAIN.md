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
| `SpawnPad.sol` | The hub. Factory + settlement: token custody, oUSD burn/mint, omnichain messaging, and the canonical `Spawned` / `Trade` / `Ascended` event stream (one address for indexers). Routes every trade through the venue. |
| `ICurveVenue.sol` / `InternalCurveVenue.sol` | The price-discovery slot. The internal venue is the genesis curve (constant-product, virtual reserves, 800M/1B on the curve) + ascension to the omnipool. Pure accounting — the pad keeps custody — so it swaps for a Raydium LaunchLab / Meteora DBC adapter without touching settlement or gateways. |
| `SpawnGateway.sol` | One per chain. Users `spawnToken` / `buyToken` / `sellToken` here with **no approvals**. Forwards everything to the pad as omnichain messages; mints deliveries and payouts coming back. |
| `SpawnToken.sol` | The creature. Hub instance pre-mints the whole 1B supply to the pad; spoke replicas are minted/burned as tokens cross chains. **Sum of supplies across chains ≡ 1B, always** (tested). |
| `OmniUSD.sol` | Demo settlement currency, one instance per chain, moved by burn/mint. The production slot for this is **USDC via Circle CCTP** — the exact same pattern. |
| `OmniMessenger.sol` | The transport abstraction. Contracts only know `IOmniMessenger` / `IOmniReceiver`. Locally, `LocalOmniMessenger` hosts all logical chains on one node and delivers synchronously. |
| `lz/LayerZeroOmniMessenger.sol` | The production transport: one adapter per chain over the real LayerZero V2 endpoint signatures (`lz/ILayerZeroV2.sol`), peered, with a native-fee gas tank. Tested against `lz/MockLZEndpointV2.sol`, which queues packets and lands them in **separate transactions** — the async reality of testnet/mainnet. |

Run the invariants suite (`npm run chain:test`): genesis on six chains, single
global curve, supply conservation, value conservation, ascension + refund,
message authentication.

## Running locally

```bash
npm run chain          # terminal 1 — local node (hardhat)
npm run chain:deploy   # terminal 2 — deploy + seed 6 creatures with real trades
npm run chain:bots     # terminal 2 — optional: live bot market (real txs)
npm run dev            # terminal 3 — frontend, flip the nav toggle to ⛓ ONCHAIN
```

On-chain mode uses a **burner wallet** (key in localStorage), funded with gas
by the local dev account and with oUSD by the faucet (`AIRDROP` button =
$1,337 on each chain). Every buy/sell/spawn is a real transaction; charts,
tape, holders and per-chain supply come from contract events.

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
