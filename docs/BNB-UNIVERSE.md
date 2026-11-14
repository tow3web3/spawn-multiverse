# The BNB universe — retired (2026-11-14)

**There is no separate BNB universe any more.** On 2026-11-14 the owner
decided on ONE universe on six chains: BNB Chain is a **spoke** of the
mainnet universe (hub on Base), launched together with Optimism, Arbitrum
and Ethereum (`bash scripts/launch.sh`, then `bash scripts/finish.sh` —
[RUNBOOK.md](RUNBOOK.md)). The single-chain `bnb` and `ethereum` profiles,
their wrappers (`launch.sh bnb`, `finish.sh bnb`) and their fork rehearsal
(`scripts/fork-universe.js`) were removed from the tooling; asking for them
now fails with a message that points here. Nothing was ever deployed from
them on mainnet.

What carried over into the one universe:

| From the BNB universe | Where it lives now |
|---|---|
| `OmniUSDLocal` over Binance-Peg USDT (18 decimals, `SCALE = 1`) | the vault of the BNB Chain spoke (`vault: 'local'` in `config/profiles.js`). v7.2 removed its `wrap` — with portable claims it would be a free USDT → USDC exchange ([SPEC.md §7](SPEC.md)) |
| The USDT preflight: symbol, decimals, a supply sanity bound (no issuer registry to ask) | `scripts/lib-net.js → preflight`, per chain |
| Every amount through the dollar's own decimals | per CHAIN now: `dollarUnits(profile, whole, net)`, `dollarScale(profile, net)` |
| The 18-decimal manifest | `public/onchain/mainnet.json`: BNB Chain's entry carries `"vault": "local"` and `"dollar": { "symbol": "USDT", "decimals": 18 }` |
| Its own deposit cap | the BNB vault's launch cap is its own setting (10,000 USDT, against 25,000 USDC per USDC vault): it bounds every holder's exposure to a USDT de-peg |

What is new because BNB Chain now shares the books with the USDC chains —
and why it is the largest economic exposure of v7.2 — is in
[SPEC.md §7 "Two dollars, one set of books"](SPEC.md) and
[SATELLITE-DOLLARS.md](SATELLITE-DOLLARS.md). The tooling refuses, loudly,
any state in which the USDT vault is a CCTP peer of a USDC vault (deploy,
self-check, status), and `status.js` prints the USDT exposure in plain
figures.
