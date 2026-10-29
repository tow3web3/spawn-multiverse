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

## Contracts (`contracts/contracts/`)

| Contract | Role |
|---|---|
| `SpawnPad.sol` | The hub. Factory + one genesis curve per token (constant-product, virtual reserves, 800M/1B sold on the curve) + ascension to the omnipool (raised USD + reserved 200M). Executes all trades, emits `Spawned` / `Trade` / `Ascended`. |
| `SpawnGateway.sol` | One per chain. Users `spawnToken` / `buyToken` / `sellToken` here with **no approvals**. Forwards everything to the pad as omnichain messages; mints deliveries and payouts coming back. |
| `SpawnToken.sol` | The creature. Hub instance pre-mints the whole 1B supply to the pad; spoke replicas are minted/burned as tokens cross chains. **Sum of supplies across chains ≡ 1B, always** (tested). |
| `OmniUSD.sol` | Demo settlement currency, one instance per chain, moved by burn/mint. The production slot for this is **USDC via Circle CCTP** — the exact same pattern. |
| `OmniMessenger.sol` | The transport abstraction. Contracts only know `IOmniMessenger` / `IOmniReceiver`. Locally, `LocalOmniMessenger` hosts all logical chains on one node and delivers synchronously. |

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
- **Messaging**: `LocalOmniMessenger` delivers in the same block. Production:
  a LayerZero V2 adapter implementing `IOmniMessenger` (one rollout per
  chain + `setPeer` wiring); flows become async (seconds), which the UI
  already tolerates (`CONFIRMING…`).

## Path to testnet / mainnet

1. **EVM chains (ETH, Base, BNB, Arbitrum, Optimism)** — deploy the same
   bytecode; swap `LocalOmniMessenger` for a LayerZero V2 `OApp` adapter;
   swap `OmniUSD` for USDC + CCTP. Pick the hub where gas is cheapest (Base).
2. **Solana** — needs a small Anchor program playing the `SpawnGateway` role
   (burn USDC via CCTP, send the LayerZero message, mint the SPL replica via
   the token program). LayerZero V2 and CCTP both support Solana today.
3. **Ascension → real DEX liquidity (important for visibility, see below)** —
   replace the internal omnipool with: LP the raised USD + 200M tokens into
   **Raydium (Solana)** and/or **Uniswap v3 (EVM hub)** and burn the LP
   position. Aggregators index those venues automatically.

## Will tokens show up on Axiom / Dexscreener / etc.?

Only if the token **actually trades on venues those platforms index**:

- **Axiom, Photon, Bullx** index Solana venues (pump.fun, Raydium, Meteora…).
  A SPAWN! token appears there once the Solana leg is a real SPL token **and**
  its ascension liquidity lands on Raydium — that's why step 3 above matters.
- **Dexscreener / GeckoTerminal / DEXTools** index known DEX factories on EVM
  chains the same way: ascend into Uniswap v2/v3 and the pair shows up
  automatically, usually within minutes.
- **Robinhood / CEX listings** are manual, curated business decisions — no
  protocol design makes that automatic.

During the curve phase (before ascension) trades happen inside SPAWN!
contracts, so third-party terminals won't chart them until either (a) the
token ascends into an indexed DEX, or (b) SPAWN! gets indexed as a venue
itself — which is exactly how pump.fun became visible: first nowhere, then
everywhere.
