# SPAWN! — one token, every chain

**The litepaper.** Crypto-native, allergic to hype; numbers from the
testnet are labeled as testnet numbers.

- Live testnet beta: **https://spawn-multiverse.netlify.app** (⛓ TESTNET tab)
- Code, all of it: **https://github.com/tow3web3/spawn-multiverse**

## The problem

Launch a meme coin today and you pick a chain — and lose everyone else.
"Multichain" usually means six wrapped copies with six prices, six pools of
thin liquidity, and an arbitrage tax paid by your holders to bots. The
community fragments on day one.

## The idea

**One token. One global supply of 1,000,000,000. One price. Every chain.**

SPAWN! runs a single market per token on a hub chain. Every other chain
gets a *native* token (a real ERC-20, a real SPL mint — not a wrapped IOU)
plus a gateway contract. Buy on Arbitrum, sell on Optimism, claim on Base:
every action is forwarded to the same curve on the hub as a cross-chain
message (LayerZero V2), and tokens or dollars come back the same way.
Supply moves by burn-on-source / mint-on-destination, so the chains' supplies
always sum to exactly 1B — it cannot double-count, by construction.

There is no price to sync because there is only one price. There is nothing
to arbitrage between chains because there is only one market.

## Launching: gas on ONE chain only

A dev launches from whatever chain they already have gas on — that's the
whole requirement. The hub deploys the token, opens the curve, and pushes a
native replica to **every** connected chain in one genesis. No contract
deployments by the dev, no bridging tour, no approvals anywhere (the
gateways only ever move the caller's own funds).

The curve is pump.fun-shaped: 800M of the 1B sells on a constant-product
curve starting around $0.0000056; when it fills (~$86K market cap), the
token **ascends** — raised dollars plus the reserved 200M seed a pool and
trading continues, same address, same everything.

## Block 0 does not exist

On every launchpad you've used, the block that creates the token already
contains the snipers — bots buy in block 0 and dump on everyone who heard
about the launch like a human. On SPAWN!, **FAIR GENESIS** makes that
mechanically impossible, then makes trying expensive:

- **Block 0 accepts no buys.** The spawn block refuses every buy, full
  stop. The money bounces straight back — nothing to race.
- **The snipe tax pays everyone else.** For the first 10 minutes, buys pay
  a fee that starts at 30% and decays to the normal 1%. It isn't burned
  into nothing by default — it rides the token's fee mode, so a sniper
  firing at minute one is literally paying the holders (or the dev, or
  the buyback-burn). The faster they snipe, the more they fund the room.
- **$250 per wallet** while the window runs — a speed bump on top.
- **The multichain snipe doesn't exist either.** Buys from other chains
  ride LayerZero messages that take a minute or two — nobody can be first
  on six chains in the same second, because physics.

The one disclosed exception: the dev's own optional first buy rides inside
the spawn itself, shown on the launch form. Everything else waits its turn
like a human.

## Fees are a product: the dev picks the deal at launch

Every trade pays 1%, and the fee mode is locked forever at launch — a
public, on-chain promise to the community:

| Mode | The deal |
|---|---|
| 💰 **100% HOLDERS** | the whole fee streams to holders |
| 🤝 **50/50** | half to holders, half to the dev |
| 👑 **100% DEV** | the dev earns it all, claimable from any chain |
| 🔥 **BUYBACK & BURN** | fees auto-buy the token on the curve (a real buy — it moves the price) and burn it on the spot, shrinking global supply for every chain at once |

Because there is one market, there is **one fee pot** — no six-chain
reconciliation. Holder payouts are split pro-rata to where the supply
actually lives and dropped into a dividend pool **on each chain**; holders
claim with a cheap local transaction on their own chain. No snapshots to
wait for, no merkle proofs to fetch, and what you've already earned stays
yours even if you sell later.

## The Solana leg and being seen

Memes don't trade where they aren't charted. The production plan puts the
hub's price discovery on **already-indexed rails** — Raydium LaunchLab /
Meteora DBC on Solana — through a pluggable venue interface that's already
in the code. Axiom, Photon, Bullx and Dexscreener index those programs
today, so curve-phase trades chart from the first second with no
integration deal.

The Solana gateway itself is written: a LayerZero OApp in Rust/Anchor that
speaks the exact same byte-level message format as the EVM contracts
(proven against cross-generated test vectors), tested against the real
LayerZero programs. It's the sixth leg of the same organism, not a bridge
bolted on.

## What's real right now — the honest ladder

**Live today (testnet):** hub on Base Sepolia + gateways on Optimism and
Arbitrum Sepolia over real LayerZero V2. Real cross-chain launches, real
trades at one global price, fee modes, holder dividends, dev claims,
MetaMask or a zero-setup burner wallet, automatic gas for visitors. The
money is testnet money — the point is that the machine works, not that the
numbers are wealth.

**Next:** Ethereum Sepolia and BNB testnet legs (ready, awaiting faucet
gas), the Solana devnet leg (program built and locally proven), then real
USDC settlement via Circle CCTP.

**Before any mainnet:** an external security audit (the
[protocol spec](SPEC.md) auditors need is written) and proper legal
review. A protocol that holds people's money on six chains does not ship on
vibes. The full plan, with costs and owners: [MAINNET.md](MAINNET.md).

## FAQ for the suspicious (correctly so)

- **"Wrapped tokens?"** No — native deployments, minted/burned by the
  protocol so the global supply is conserved.
- **"Who holds the keys?"** Today, on testnet: a deployer key, honestly
  documented. Before mainnet: multisig + timelock, audited, with circuit
  breakers. The spec's trust-model section hides nothing.
- **"Can the price differ between chains?"** There is one market on one
  hub; the other chains hold no market at all. A "price difference" can't
  exist because there is no second price to differ.
- **"What's the catch?"** Cross-chain messages take seconds-to-minutes, not
  milliseconds. That's the honest cost of one global market, and the UI
  shows it rather than faking instant finality.
