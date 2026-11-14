# SPAWN! — The Omnichain Meme Machine

A launchpad prototype where every meme token launches on **all six chains at once**
(Solana, Ethereum, Base, BNB, Arbitrum, Optimism) as **one single token**:

- **One genesis** — a single coordinated launch deploys natively on every chain.
- **One global supply** — the total supply is allocated across deployments, not
  duplicated per chain.
- **One price** — every chain reads the same global price reference, so the token
  costs the same everywhere, always.
- **No block 0** — FAIR GENESIS: the spawn block refuses every buy, then a
  10-minute snipe tax (30%→1%, paid to the token's fee stream) and a $250
  per-wallet cap make sniping fund the room instead of draining it.

Four modes, same UI (toggle in the nav):

- **SIM** — in-browser market engine, zero setup, all six chains simulated.
- **⛓ TESTNET** — the public beta at
  [spawn-multiverse.netlify.app](https://spawn-multiverse.netlify.app): the
  hub on Base Sepolia (which also trades locally, in one transaction), spokes
  on Optimism + Arbitrum Sepolia over real LayerZero V2 messages, a gas drip
  for visitors, MetaMask or an instant burner wallet, play USDC anyone can
  mint.
- **◉ MAINNET** — **one universe on six chains** (`public/onchain/mainnet.json`):
  the hub on Base, spokes on Optimism, Arbitrum, Ethereum and BNB Chain,
  launched together; Solana joins later. One market per token for every
  chain. The dollar is per chain: Circle USDC on Base, Optimism, Arbitrum and
  Ethereum (vaults levelled by CCTP), Binance-Peg USDT (18 decimals) on BNB
  Chain — a claim (oUSD) is a claim on the universe's dollars, mostly USDC,
  partly USDT, and can be moved from one chain to another. Ethereum is left
  out of a launch while its message is dear, and opened there later by
  whoever wants the token there. Real money, your own wallet only (no
  burner, no drip, no mint), a risk notice before the first transaction, a
  permanent "guarded beta — unaudited" banner with each chain's deposit cap,
  and the network fee shown before every signature. The launch itself is two
  lines for the owner — `bash scripts/launch.sh` then `bash scripts/finish.sh`
  from `contracts/` — rehearsed end to end on forks of the five chains
  (`npm run rehearse`); see [docs/RUNBOOK.md](docs/RUNBOOK.md). On hold until
  the hub's v7.2 is final (`contracts/deployments/HOLD-MAINNET`).
- **LOCAL** — the same Solidity protocol on a hardhat chain: every buy,
  sell and spawn is a transaction against the hub-and-spoke protocol in
  [contracts/](contracts/). Price discovery is a pluggable **venue module**
  (`ICurveVenue`): the internal genesis curve locally, a Raydium LaunchLab /
  Meteora DBC adapter on the production Solana hub — so curve-phase trades
  chart on Axiom/Dexscreener from the first second. See
  [docs/ONCHAIN.md](docs/ONCHAIN.md) for the architecture and the path to
  testnet/mainnet.

**Docs:** [LITEPAPER.md](docs/LITEPAPER.md) (the pitch, honest version) ·
[ONCHAIN.md](docs/ONCHAIN.md) (architecture) · [SPEC.md](docs/SPEC.md)
(auditor-grade protocol spec) · [MAINNET.md](docs/MAINNET.md) (the road to
mainnet) · [solana/NOTES.md](solana/NOTES.md) (Solana leg log).

```bash
npm run chain          # terminal 1 — local node
npm run chain:deploy   # terminal 2 — deploy + seed the pit
npm run chain:bots     # optional — live on-chain bot market
npm run dev            # terminal 3 — flip the nav toggle to LOCAL
npm run chain:test     # contract invariants suite
```

The money is fictional in SIM, TESTNET and LOCAL; the math (and on-chain, the
transactions) are not. In MAINNET mode the money is real.

How money moves on-chain (protocol v7.1): you trade in the universe's
**dollar** — USDC (6 decimals) or BSC USDT (18 decimals); its decimals are
read from the chain, never assumed ([src/lib/dollars.ts](src/lib/dollars.ts)
is the only place an amount is converted). Each chain has a vault — a buy
approves the vault for the exact amount and puts the dollar in, a sell or
refund pays it out on the chain you sold from. If that chain's vault is short
you receive **oUSD**, a 1:1 claim you unwrap once liquidity is back; holder
rewards are paid in oUSD too. Every action attaches the network fee its
`quote*` view returns (testnets sponsor it). On the hub chain a trade is one
transaction **and price-protected**: the page computes what the hub will
deliver with the hub's own arithmetic ([src/lib/curveMath.ts](src/lib/curveMath.ts)),
shows "you receive at least …" with a tolerance you set (2% by default), and
the trade reverts — nothing spent — if the price moves past it. From another
chain a trade crosses LayerZero and back and fills at whatever price it finds
(no price protection yet; the page says so). Holder fees arrive by themselves
on the hub chain; elsewhere they wait on the hub until someone pulls them. A
chain the launch could not reach (`SyncFailed`) is shown as "not available
yet" for that token until the operator resyncs it.

## The engine

Each token has **one global market** ([src/engine/](src/engine/)):

- **Genesis curve** — a constant-product bonding curve with virtual reserves
  (pump.fun style). 800M of the 1B supply sells on the curve, starting at
  ~$0.0000056. Every buy and sell, from any chain, hits this one curve — that's
  why the price is identical everywhere.
- **Ascension** — when the curve sells out (~$86K market cap), the raised USD
  plus the reserved 200M tokens seed the "omnipool", a real constant-product
  pool where trading continues.
- **Everything is derived from trades**: price history, market cap, volume,
  holder counts and per-chain supply allocation all come out of executed
  trades — yours and the bots'. Bots trade through the exact same engine.

## Run it

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # type-check + production build
npm run test:units     # amount conversions (6/8/18 decimals) + the hub's trade arithmetic
npm run test:functions # the Netlify functions
```

## What's inside

- **The Pit** — the marketplace. Filter tabs (hot / just spawned / ascended),
  `⌘K` search, live prices, and an ascension progress bar on every card. No
  "incoming" list — a token exists the moment it is launched.
- **Trading view** — click any card: live price chart with crosshair, buy/sell
  from any of the six chains (same curve, same price), quotes with price
  impact, your position with PnL, the live trade tape, and the per-chain
  supply allocation.
- **Demo wallet** — connect to get a $1,337 demo balance. Balance, positions
  and PnL persist in `localStorage`.
- **Genesis Lab** — name a token, upload its image, optionally drop its links
  (website / X / Telegram) and an optional dev buy. The global supply is
  predefined (1,000,000,000 for every creature — not configurable). Spawned
  creatures persist, and bots start trading them immediately.
- **Genesis simulation** — the hero panel's creature is draggable
  ("drag to disturb reality").

## Stack

Vite · React 19 · TypeScript · Tailwind CSS v4. All creature art is inline SVG
([src/components/Faces.tsx](src/components/Faces.tsx)); the price engine lives in
[src/store.tsx](src/store.tsx).
