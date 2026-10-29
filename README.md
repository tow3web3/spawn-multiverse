# SPAWN! — The Omnichain Meme Machine

A launchpad prototype where every meme token launches on **all six chains at once**
(Solana, Ethereum, Base, BNB, Arbitrum, Optimism) as **one single token**:

- **One genesis** — a single coordinated launch deploys natively on every chain.
- **One global supply** — the total supply is allocated across deployments, not
  duplicated per chain.
- **One price** — every chain reads the same global price reference, so the token
  costs the same everywhere, always.

Two modes, same UI (toggle in the nav):

- **SIM** — in-browser market engine, zero setup.
- **⛓ ONCHAIN** — a real Solidity deployment on a local chain: every buy,
  sell and spawn is a transaction against the hub-and-spoke protocol in
  [contracts/](contracts/). See [docs/ONCHAIN.md](docs/ONCHAIN.md) for the
  architecture and the path to testnet/mainnet.

```bash
npm run chain          # terminal 1 — local node
npm run chain:deploy   # terminal 2 — deploy + seed the pit
npm run chain:bots     # optional — live on-chain bot market
npm run dev            # terminal 3 — flip the nav toggle to ⛓ ONCHAIN
npm run chain:test     # contract invariants suite
```

The money is fictional in both modes; the math (and in on-chain mode, the
transactions) are not.

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
npm run dev     # http://localhost:5173
npm run build   # type-check + production build
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
