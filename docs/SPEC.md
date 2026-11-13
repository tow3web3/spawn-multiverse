# SPAWN! protocol specification (v7)

Audience: a security auditor opening this repo cold. Everything below is
written from the code at the commit that introduced it, with
`file:function` citations; where reality falls short of intent, it says so.
Companion docs: [ONCHAIN.md](ONCHAIN.md) (narrative architecture),
[MAINNET.md](MAINNET.md) (what is testnet-only and what the mainnet plan
changes), [LITEPAPER.md](LITEPAPER.md) (public pitch),
[../solana/NOTES.md](../solana/NOTES.md) (Solana leg engineering log).

## 1. What the protocol is

One meme token = one global supply (1B) = one price on every chain. A single
market per token lives on a **hub** chain (`SpawnPad`); every user-facing
chain runs a **gateway** that forwards spawns, buys, sells and claims to the
hub as cross-chain messages and receives tokens/payouts back. Supply moves
by burn-on-source / mint-on-destination, so the sum of per-chain supplies is
the global supply by construction (`SpawnToken.sol` header note).

Protocol version v5: all cross-chain account riders are `bytes32` ("wide"),
actors stay wide end-to-end on the hub, and the transport envelope is
bytes32-addressed on both seats — this is what lets a Solana pubkey use the
same wire as EVM addresses.

Protocol version v7 (**the payload wire and the envelope are unchanged**):
- *settlement* — oUSD stops being faucet money. On every user-facing chain
  `OmniUSD` is a USDC vault and oUSD a 1:1 claim on it; on the hub it is a
  pure ledger. See §7.
- *transport* — messages are paid by whoever causes them, replies included;
  the hub adapter's gas tank funds itself from those prepaid reply budgets;
  and the hub chain is a user-facing chain too: its own gateway reaches the
  pad by a same-transaction loopback, with no LayerZero message. See §3.

## 2. Actors and trust model

| Actor | Powers | Where |
|---|---|---|
| **admin (deployer EOA)** | one-time wiring: `setVenue`, `setDistributor`, `setGateway` (pad); `setDistributor` (gateway); `setAgent`/`exclude` (distributor); `setAgent` (OmniUSD); `setLegs` (gateway — how many replies a user prepays); on the LZ adapter: `register` (admit a local sender and its chain label), `setRoute`, `setDestination` (executor gas + reply budget per destination), `setSponsored` (whose fees ride the tank), `setLocal` (labels hosted on this chain — loopback), `setDelegate` (who may configure DVNs on the endpoint), `recover` (drain the tank) | `SpawnPad.sol:setVenue/setDistributor/setGateway`, `SpawnGateway.sol:setDistributor/setLegs`, `FeeDistributor.sol:54-66`, `OmniUSD.sol:setAgent`, `lz/LayerZeroOmniMessenger.sol` (admin section) |
| **admin, on each USDC vault (v7)** | `setDepositCap` (open/close/limit deposits — never withdrawals); `setPeer` (name a chain's peer vault, once per label); `rebalance` (CCTP-burn vault USDC toward a named peer vault). **No function sends USDC to an arbitrary address — but the admin chooses the peers; see §7 "Rebalancing trust model".** | `OmniUSD.sol:setDepositCap/setPeer/rebalance` |
| **token creator ("dev")** | locks the fee mode at launch; claims the dev fee share from any chain | `SpawnGateway.sol:spawnToken/spawnTokenUsdc`, `SpawnPad.sol:_claim` |
| **trader / holder** | buy, sell, claim holder dividends — all on their own chain; wrap/unwrap USDC ⇄ oUSD | `SpawnGateway.sol:buyToken/buyTokenUsdc/sellToken`, `FeeDistributor.sol:claim`, `OmniUSD.sol:wrap/unwrap` |
| **Circle (USDC issuer, CCTP attester)** | can blacklist any account incl. a vault, pause USDC, denylist CCTP callers, switch on a CCTP minimum fee | external — see §7 |
| **LayerZero endpoint + DVN/executor** | message verification & delivery between adapters | `lz/LayerZeroOmniMessenger.sol` |

**Honesty section.** Today every admin surface is a single EOA (the testnet
deployer). There is no multisig, no timelock, no pause switch, no rate
limit, and the wiring functions are one-shot (`require(x == 0, "… set")`)
but not renounceable. The mainnet plan (MAINNET.md Phase 1) moves admin
behind a Safe + timelock and adds circuit breakers; **audit should assume
admin is malicious-until-proven-benign and enumerate what a hostile admin
could do pre- and post-wiring.**

Trust chain for an inbound message (production transport):
1. endpoint authenticity — `lzReceive` requires `msg.sender == endpoint`
   (`LayerZeroOmniMessenger.sol:lzReceive`, `"LZM: not endpoint"`);
2. peer authenticity — packet's `origin.sender` must equal the configured
   peer adapter for that srcEid (`"LZM: not a peer"`);
3. source chain label derives from `origin.srcEid` via `labelOf`, never from
   message content (same function);
4. envelope authentication — receiver checks the protocol-level sender:
   pad requires `gateways[srcChain] == srcSender`
   (`SpawnPad.sol:onOmniMessage`, `"PAD: not a gateway"`), gateway requires
   the pad (`SpawnGateway.sol:onOmniMessage`, `"GW: not the pad"`), Solana
   store requires
   `env.src_sender == store.hub_pad` and `env.dst_addr == store`
   (`solana …/lz_receive.rs:77-79`);
5. sender gating on the way out — adapters only accept registered local
   protocol contracts (`LayerZeroOmniMessenger.sol:send`, `"LZM: unknown
   sender"`), the Solana program only sends from its own store PDA.

The loopback (v7, §3) replaces steps 1–3 for a message between two contracts
of the SAME chain: the adapter itself is the witness. It hands the receiver
`labelOfSender[msg.sender]` and `msg.sender` — the admin-registered label of
the caller and its real address — and only ever calls a registered endpoint
of the destination label (`"LZM: bad target"`). Step 4 is unchanged, so a
registered sender still cannot pose as the pad or as another gateway.

## 3. Transport and envelope

Protocol contracts speak
`IOmniMessenger.send(dstChain, bytes32 dstAddr, payload, returnLegs)`
(payable) / `quote(...)` (same arguments, returns the native fee `send` will
require) and receive `onOmniMessage(srcChain, bytes32 srcSender, payload)`
(`OmniMessenger.sol`). Transports are swappable:

- `LocalOmniMessenger` — synchronous, all-EVM dev transport, with a
  configurable flat fee per message (0 by default) and the same
  sponsored-sender rule, so the fee logic is exercised without LayerZero.
- `MockLZEndpointV2` + `LayerZeroOmniMessenger` — async queue for tests. The
  mock charges a flat fee (+ optional per-byte fee), honours the executor
  native-value option (the sender pays `value` on top; delivery hands it to
  the receiver's payable `lzReceive`), delivers with exactly the gas the
  options bought, and leaves a reverted delivery queued (retryable).
- `LayerZeroOmniMessenger` — production adapter, one per chain.

### Who pays (v7)

The rule: **whoever causes a message pays for it and for the replies it
triggers.** Nothing rides on charity, so nothing can be drained by spam.

- Every gateway entrypoint is `payable` and forwards `msg.value` to
  `messenger.send` with `returnLegs` = the replies the hub will send because
  of it: `tradeLegs` for a buy / sell / claim (1 on a remote chain: the
  DELIVER or PAYOUT), `spawnLegs (+ tradeLegs with a dev buy)` for a spawn
  (the SYNC to every remote chain). Both are admin-set per gateway
  (`SpawnGateway.sol:setLegs`) — budget multipliers, not hard message counts.
- The adapter requires `msg.value ≥ fee` unless the sender is `sponsored`
  (`"LZM: fee"`); a short fee reverts the user's whole transaction — nothing
  is burned or pulled (`transport.test.js`). Any surplus stays in the tank.
- The fee is `endpoint.quote(...)` for a packet whose executor option
  carries `returnUnit[dst] × returnLegs` of DESTINATION-chain native
  currency. The executor delivers that value into the remote adapter's
  payable `lzReceive`, i.e. into its balance.
- That balance is the adapter's **gas tank**. The pad never attaches value
  and always passes `returnLegs = 0`: it is the one always-sponsored sender,
  and its replies are paid out of the hub tank — which was just topped up by
  the message being answered. With `returnUnit ≥` the real reply fee the
  tank never shrinks (asserted to the wei on the mock).
- `SpawnGateway.quoteBuy / quoteSell / quoteClaim / quoteSpawn(name, symbol,
  metaURI, withDevBuy)` return the exact fee before signing. Trade payloads
  are fixed-size; a spawn's fee depends on its strings, so its quote takes
  them.
- Sponsorship is configuration, not a code path: testnets sponsor their
  gateways (the tank pays, visitors need no fee logic); mainnet sponsors the
  pad only.

**Failure mode.** If the hub tank cannot pay a reply (`"LZM: gas tank
empty"`), the inbound `lzReceive` reverts as a whole: the BUY/SELL/SPAWN is
not consumed, the user's value is still in flight, and LayerZero keeps the
message retryable — anyone can re-execute it once the tank is refilled
(tested: the packet stays queued and lands after a top-up). A tank only
runs dry if `returnUnit` is set below the real reply cost, or through the
replies nobody prepays (next paragraph). Tank level is an ops alert.

**Not prepaid today.** A trade's single reply budget covers its DELIVER /
PAYOUT. It does NOT cover the `OP_FEE_DROP` fan-out a trade may trigger
(§8: one message per chain holding supply, each time the holders pot
crosses `DIST_TRIGGER = $2`). Those ride the hub tank unfunded. At mainnet
message prices that is both uneconomic (a $2 drop can cost more than $2 to
ship) and a slow drain; see §11.

### Per-destination options

`setDestination(label, gas, unit)` replaces the old global options blob.
Each send builds a type-3 option list with one executor lzReceive option:
`0x0003 | 0x01 | uint16 size | 0x01 | uint128 gas [| uint128 value]` — 17
bytes of option (22 in total) when no reply is prepaid, 33 (38 in total)
with `value = returnUnit × returnLegs` (`_packet`). A destination without a
gas limit is refused (`"LZM: no gas limit"`).

Gas actually used by `lzReceive`, measured on the mock endpoint (which
itself burns ~0.52M per `send` it stores, against ~0.2M for the real
endpoint — hub figures are therefore pessimistic):

| Op (where it lands) | Gas used | Budget in deploy config |
|---|---|---|
| OP_SPAWN (hub), 5 remote SYNCs, no dev buy / with dev buy | 3.94M / 4.52M on the mock ≈ 1.4M of protocol work + one send per remote chain (+ the DELIVER) | 4M to the hub |
| OP_BUY / OP_SELL (hub), incl. one reply send | 0.18–0.64M | 4M to the hub |
| OP_SYNC_TOKEN (spoke — a replica deploy) | 0.72M | 2M to a spoke |
| OP_DELIVER / OP_PAYOUT / OP_FEE_DROP (spoke) | 0.06–0.13M | 2M to a spoke |

Executor gas is nearly free on L2 destinations (≈ destination gas price ×
gas — see MAINNET-ADDRESSES.md), but it is one number per destination, so a
trade toward the hub buys the same 4M as a spawn. A per-op gas class would
save ~0.00003 ETH per hub-bound trade message at today's Base gas price.

### Hub-local trading — the loopback (v7)

The hub chain is also a user-facing chain (label 3, Base): it has its own
USDC vault, gateway and holder pool, and that gateway is wired to the HUB
adapter. Labels marked `isLocal` on an adapter (the hub's: 0 and 3) are
never routed through LayerZero: `send` calls
`IOmniReceiver(dst).onOmniMessage(labelOfSender[msg.sender], bytes32(msg.sender), payload)`
directly, in the same transaction, and only if `dst` is a REGISTERED sender
of that label. Consequences:

- a buy, sell or claim on the hub chain is ONE transaction — tokens or USDC
  are in the user's wallet when it returns — and costs no messaging fee
  (`tradeLegs = 0`);
- a spawn on the hub chain creates the token and the local replica in that
  transaction, and still SYNCs every remote chain: the local sender prepays
  that fan-out as `returnUnit[0] × spawnLegs`, kept in the hub tank;
- the pad needed no change: the hub chain's gateway is just another
  `gateways[3]`, and every reply to label 3 takes the loopback;
- FAIR GENESIS block 0 is now a real case rather than an executor-batching
  corner: a local buy in the spawn block bounces with a full USDC refund,
  inside the buyer's own transaction (`transport.test.js`);
- the synchronous nesting gateway → adapter → pad → adapter → gateway →
  vault is exactly what `LocalOmniMessenger` has always done for all six
  chains, so every pre-existing suite already exercised it. The gateway's
  user entrypoints are `nonReentrant`; `onOmniMessage` deliberately is not
  (the loopback re-enters it while a user call is on the stack) and is
  protected by its two authentication checks instead.

### DVN configuration

Each adapter names its admin as LayerZero **delegate** at construction
(`endpoint.setDelegate`), and the admin can move it (`setDelegate`). The
delegate — not the adapter — calls `endpoint.setConfig` to choose the send
and receive ULN config (DVN set, confirmations) and the executor per
pathway. Until someone does, an adapter rides LayerZero's defaults, which on
mainnet today means four required DVNs, one of which is ~80% of the message
fee (MAINNET-ADDRESSES.md). Choosing the set is deploy-time configuration
and is custody security (§7): both sides of every pathway must agree or
messages stall.

**Envelope (v5).** Between adapters every LZ message body is
`abi.encode(bytes32 srcSender, bytes32 dstAddr, bytes payload)`
(`LayerZeroOmniMessenger.sol:_packet`). The receiving EVM adapter downcasts
only the local target (`"LZM: bad target"`, `lzReceive`) and passes `srcSender`
wide; the Solana program encodes/decodes the identical layout
(`msg_codec.rs::Envelope`, cross-proven by the `envelopes` section of
`solana/tests/codec-vectors.json`).

Delivery is **unordered** (`nextNonce` returns 0); every
message must therefore be self-contained. See Finding F-2 for the one
ordering race this leaves.

## 4. Message catalog — the single source of truth

Envelope payload = `abi.encode(uint8 op, bytes data)`; `data` per op below.
All tuples use canonical ABI encoding; every account rider is `bytes32`.
"wide ok" = the value may be a non-EVM identity and is never downcast on
that path; "downcast" = checked 20-byte downcast, top-12-bytes-zero or
revert (`SpawnPad.sol:_addr` → `"PAD: bad recipient"`,
`SpawnGateway.sol:_addr` → `"GW: bad recipient"`).

| Op | Name | Direction | Wire tuple (`data`) | Trigger | Effect on receive |
|---|---|---|---|---|---|
| 1 | OP_SPAWN | gateway → pad | `(bytes32 creator [wide ok], string name, string symbol, string metaURI, uint256 devBuyUsd, uint8 feeMode)` | `SpawnGateway.spawnToken` (burns dev-buy oUSD first) or `spawnTokenUsdc` (v7: pulls dev-buy USDC into the vault via `OmniUSD.depositFor`) — same message | `SpawnPad._spawn`: deploy hub `SpawnToken` (premint 1B to pad), store `Meta` (creator stays wide), `venue.openMarket`, emit `Spawned`, send OP_SYNC_TOKEN to **every** registered chain, then optional dev-buy via `_buy` |
| 2 | OP_BUY | gateway → pad | `(bytes32 token [downcast], bytes32 buyer [wide ok], uint256 usdIn)` | `SpawnGateway.buyToken` (burns buyer's oUSD) or `buyTokenUsdc` (v7: pulls USDC into the vault) — same message; both first require a local replica (`"GW: unknown token"`), so a BUY for a token the hub never spawned cannot leave the chain | `SpawnPad._buy`: mint oUSD to pad, 1% fee, `venue.execBuy`, burn hub tokens, `supplyByChain[src] += out`, burn refund, send OP_DELIVER, emit `Trade`, `_accrueFee` |
| 3 | OP_SELL | gateway → pad | `(bytes32 token [downcast], bytes32 seller [wide ok], uint256 tokensIn)` | `SpawnGateway.sellToken` (burns seller's replica) | `SpawnPad._sell`: mint tokens back to pad custody, `supplyByChain[src] -= tokensIn`, `venue.execSell`, 1% fee, burn net oUSD, send OP_PAYOUT, emit `Trade`, `_accrueFee` |
| 4 | OP_CLAIM | gateway → pad | `(bytes32 token [downcast], bytes32 claimer [wide ok])` | `SpawnGateway.claimFees` | `SpawnPad._claim`: `require(metas[token].creator == claimer)` (wide comparison), pay `dev − devClaimed` via OP_PAYOUT to the claim chain, emit `DevClaimed` |
| 10 | OP_SYNC_TOKEN | pad → gateway | `(bytes32 token [downcast on EVM spokes; raw 32-byte seed on Solana], string name, string symbol)` | inside `_spawn`, one per registered chain | EVM: deploy replica (`SpawnToken` premint 0, controller = gateway), record `replicaOf` (`SpawnGateway.sol:115-131`). Solana: create Replica PDA + SPL mint, decimals 6, authority = store (`lz_receive.rs::handle_sync_token`) |
| 11 | OP_DELIVER | pad → gateway | `(bytes32 token [downcast/seed], bytes32 to [downcast on EVM; raw pubkey on Solana], uint256 tokens, uint256 refund)` | inside `_buy` | EVM: `replica.bridgeMint(to, tokens)`, refund settled by `OmniUSD.payout(to, refund)` (v7 — USDC if the vault is liquid, else an oUSD claim; `SpawnGateway.sol:onOmniMessage`). Solana: mint `tokens / 1e12` to recipient's ATA (+ scaled refund) |
| 12 | OP_PAYOUT | pad → gateway | `(bytes32 to [downcast on EVM; raw pubkey on Solana], uint256 usdOut)` | `_sell` net proceeds, `_claim` dev share | EVM: `OmniUSD.payout(to, usdOut)` (v7 — USDC if liquid, else an oUSD claim; never reverts) |
| 13 | OP_FEE_DROP | pad → gateway | `(bytes32 token [downcast/seed], uint256 amount)` | `_distributeHolders` when the holders pot ≥ DIST_TRIGGER | EVM: mint oUSD into the chain's `FeeDistributor`, `drop(replica, amount)` (`SpawnGateway.sol:onOmniMessage`); holders claim oUSD and unwrap or trade with it. Solana: mint into the store's vault ATA, parked pending the phase-3 distributor |

Unknown ops revert (`"PAD: bad op"` / `"GW: bad op"`); the Solana codec
rejects unknown ops, dirty envelope padding and bad offsets
(`msg_codec.rs` tests).

## 5. Identity model — the downcast is a security boundary

The rule (`SpawnPad.sol:209-219` comment block): **actors stay wide
end-to-end; only hub-local settlement downcasts.**

- The hub never pays an actor by local transfer — it pays by message — so a
  Solana creator/trader flows through storage (`Meta.creator: bytes32`),
  events (`Spawned/Trade/DevClaimed` emit `bytes32 indexed` actors) and auth
  (`_claim`'s wide comparison) untouched.
- Token ids always downcast on the hub (every token is an EVM contract
  deployed there) — a wide token id is corruption and reverts.
- An EVM **spoke** downcasts delivery recipients (`"GW: bad recipient"`),
  which yields a positive guarantee: **a wide identity's payout can only be
  cashed on its own chain** — a message mis-routed to an EVM spoke with a
  Solana recipient bounces instead of minting to a truncated address.
- `pad.gateways` is `mapping(uint32 => bytes32)` so a Solana OApp store
  pubkey can be a gateway (`SpawnPad.sol:87`, `setGateway`).

Audit focus: every `_addr` call site is classified in code comments
(passthrough vs local settlement); verify none of the passthrough paths can
reach an EVM `address` consumer un-checked.

## 6. Supply accounting and invariants

Let `T = TOTAL_SUPPLY = 1e9 · 1e18` (`SpawnPad.sol:24`).

- Hub premint: token constructor mints `T` to the pad
  (`SpawnPad._spawn` → `SpawnToken` constructor).
- Outbound: `_buy` burns `out` from pad custody and credits
  `supplyByChain[token][srcChain] += out`; the spoke mints the same `out`.
- Inbound: `_sell` mints `tokensIn` back to custody and debits
  `supplyByChain[token][srcChain] -= tokensIn`; the spoke burned it first.
- Buyback&burn (`_accrueFee`, burn mode): buys from the curve **inside pad
  custody** and burns immediately — `supplyByChain` is untouched, which is
  correct because that supply never circulated.

Invariants an auditor should try to break:

- **S1 (conservation):** Σ over all chains of `token.totalSupply()`
  `= T − feesOf[token].burnedTokens`.
- **S2 (ledger ≡ reality):** for every spoke chain `c`,
  `supplyByChain[token][c] =` that chain's replica `totalSupply()`
  — up to the Solana dust noted in Finding F-4.
- **S3:** `supplyByChain[token][HUB_CHAIN] == 0` always. Hub-local trading
  (v7) does not go through label 0: the hub chain's users trade through
  their own gateway, label 3, like any other chain's (`supplyByChain[token][3]`
  = Base's replica supply, S2). The `_distributeHolders` hub branch
  (`SpawnPad.sol:_distributeHolders`, the `HUB_CHAIN` share) therefore
  remains dead code, as does the hub's own `FeeDistributor`.
- **S4 (no spoke-to-spoke path):** replicas cannot move between spokes
  except through a hub sell + re-buy, so `_sell`'s unchecked-looking
  subtraction cannot underflow while S2 holds.

## 7. Value (oUSD) accounting and invariants

**v7: real-money settlement.** `OmniUSD` has no faucet. There is one
instance per chain, in one of two modes fixed at construction
(`OmniUSD.sol:constructor`):

- **Backed** (`usdc != 0`, every user-facing chain): the contract is that
  chain's USDC vault; oUSD (18 dec) is a 1:1 claim on USDC (6 dec,
  `SCALE = 1e12`). The constructor rejects a non-6-decimal backing token.
- **Ledger** (`usdc == 0`, the hub): a pure accounting unit minted/burned by
  the pad. The hub holds no dollars — it holds the books for dollars that
  sit in the spokes' vaults. All USDC functions revert `"oUSD: ledger
  only"`; a gateway cannot be constructed over a ledger instance
  (`"GW: ledger usd"`).

How oUSD comes to exist or disappear — the complete list (a test pins the
set of state-changing functions, `test/settlement.test.js`):

| Path | Who | USDC | oUSD |
|---|---|---|---|
| `wrap(usdc6)` | anyone | pulled into the vault (under `depositCap`) | minted 1:1 to the caller |
| `unwrap(amount18)` | anyone | paid out; reverts `"oUSD: vault short"` if the local vault lacks it | whole-USDC multiple burned, sub-`SCALE` dust stays |
| `depositFor(from, usdc6)` | agent (gateway) | pulled from `from` (under `depositCap`) | **none** — the value leaves in the outgoing message (≡ wrap + bridgeBurn) |
| `payout(to, amount18)` | agent (gateway) | `floor(amount18/SCALE)` paid if the vault has it and the transfer succeeds | only the sub-`SCALE` dust minted — or, on fallback, the **whole** amount |
| `bridgeMint` / `bridgeBurn` | agent | — | value arriving by / leaving in a protocol message (oUSD-denominated buys, fee drops into the distributor, all hub ledger moves) |

Deposits credit the balance **delta** actually received, not the requested
amount, and every USDC-moving function is `nonReentrant`.

- **V0 (global backing) — the invariant everything else rests on:**
  `Σ over backed instances of USDC held × 1e12 = Σ over ALL instances (hub
  ledger included) of oUSD.totalSupply()`, modulo value in flight (a
  message between its burn and its mint; a CCTP rebalance between its burn
  and Circle's mint). It is a GLOBAL equality, not a per-chain one.
- **Payouts never revert (message path).** `payout` runs inside
  `onOmniMessage`; a revert would strand the payout. It is all-or-nothing:
  if the vault holds the USDC **and** the transfer succeeds (low-level call —
  Circle can blacklist a recipient or pause USDC) the user gets USDC;
  otherwise the whole amount is minted as oUSD, a claim redeemable with
  `unwrap` once liquidity returns, or spendable at par through the
  oUSD-denominated `buyToken`. Reachable revert left upstream: the
  gateway's `_addr` on a wide recipient (§5, by design), and `to == 0`
  (unreachable — recipients are always a prior `msg.sender`).
- **Vault shortage is expected, not exceptional.** Dollars enter where
  buyers are and leave where sellers are; fees drop where holders are; a
  dev may claim on any chain. A chain's vault can therefore owe more oUSD
  than it holds USDC while V0 still holds globally. First-come-first-served
  on local liquidity; later claimants hold oUSD until a rebalance.
- **Rebalancing trust model.** `rebalance(dstLabel, usdc6)` (admin-only)
  burns vault USDC through Circle CCTP V2 `TokenMessengerV2.depositForBurn`
  with `mintRecipient = peers[dstLabel].vault`, `destinationCaller = 0`
  (anyone may relay the attestation), `maxFee = 0`,
  `minFinalityThreshold = 2000` (Standard Transfer). `setPeer` is
  once-per-label and can never be re-aimed. **What this does and does not
  give:** there is no code path that sends vault USDC to an arbitrary
  address in one step — but the admin *names* the peers, and nothing stops
  a hostile admin from naming a fresh label whose "peer vault" is their own
  address and rebalancing into it. Until peers are sealed or time-locked
  (hardening chantier), **the admin key can drain every vault** — treat it
  exactly like an upgrade key. The admin can also move all local liquidity
  to a legitimate peer (a liveness, not a theft, power).
- **Deposit cap.** `depositCap` bounds the vault's USDC *balance* at deposit
  time (default 0 = closed). It never blocks exits. It is not a bound on
  oUSD claims minted by payout fallbacks, and a direct USDC donation or an
  inbound rebalance can fill it (deposits then wait for the admin).
- **Circle dependencies.** A blacklisted *vault* freezes that chain's USDC
  (exits fall back to oUSD claims, deposits revert); a CCTP denylist entry
  or a non-zero CCTP `minFee` makes `rebalance` revert (safe failure — a
  non-zero fee would otherwise break V0 by the fee amount).

The pre-v7 invariants are unchanged in shape:

- **V1 (pad solvency):** hub oUSD balance of the pad
  `= Σ_tokens [curve real reserves (vBase − V_BASE_0 pre-ascension; vBase
  post-ascension) + (dev − devClaimed) + (holders − holdersPaid) + burnPot]`.
  Every outbound payment burns hub-side before minting on the spoke
  (`_sell`, `_claim`, `_distributeHolders` spoke branch); the only local
  transfer is the hub-distributor share (`SpawnPad.sol:407`).
- **V2 (fee caps):** `devClaimed ≤ dev`, `holdersPaid ≤ holders`,
  enforced by monotone accounting in `_accrueFee`/`_claim`/
  `_distributeHolders`; rounding dust stays in the pot
  (`holdersPaid += paid`, `SpawnPad.sol:422`).
- **V3 (distributor solvency):** each `FeeDistributor`'s oUSD balance
  `≥ Σ withdrawable` across holders — drops transfer/mint funds in before
  `drop()` is called (`SpawnGateway.sol:148`, `SpawnPad.sol:407`), claims
  pay out `withdrawable` exactly once (`FeeDistributor.sol:claim`).

## 8. Fee state machine

1% (`FEE_BPS = 100`) of every trade (`SpawnPad.sol:28`), computed off the
top on buys — with the fee recomputed down if the curve caps the buy
(`_buy`, `SpawnPad.sol:309-313`) — and off the proceeds on sells. Routed per
the launch-locked mode (`FeeState.mode`, set once in `_spawn`):

| Mode | Routing | Payout path |
|---|---|---|
| 0 FEE_HOLDERS | 100% → `holders` pot | distributed at `DIST_TRIGGER = 2e18` (`_distributeHolders`) |
| 1 FEE_SPLIT | 50% `holders`, 50% `dev` | both paths below |
| 2 FEE_DEV | 100% → `dev` pot | creator claims from any chain (OP_CLAIM → OP_PAYOUT) |
| 3 FEE_BURN | 100% → `burnPot` | at `BURN_TRIGGER = 4e18`: real `venue.execBuy` with the pot (moves the price), tokens burned on the spot, `Trade` emitted with the pad as buyer (`_accrueFee`, `SpawnPad.sol:366-381`) |

Holder distribution (`_distributeHolders`): pot = `holders − holdersPaid`,
split pro-rata to `supplyByChain`; each spoke slice burns hub-side and
re-materializes in that chain's `FeeDistributor` via OP_FEE_DROP. Claims
are pure local transactions.

`FeeDistributor` is the classic magnified-dividends-per-share pattern
(`MAG = 2^128`, `FeeDistributor.sol:23`): a transfer hook on every
`SpawnToken` (`SpawnToken.sol:_update`) mirrors balances into shares;
protocol accounts (agent, venue, the distributor itself) are excluded and
earn nothing; drops landing with zero holders park in `pendingOf` and fold
in when the first holder appears. Known edge, in audit scope: the
`magDPS · shares` product can overflow int256 only on absurd
drop-over-dust-supply ratios — standard for this pattern, flagged when it
was built; quantify the bound.
State keyed by the calling token contract, so a rogue token can only corrupt
its own key and can never make `claim` pay more than its own dropped funds
(`FeeDistributor.sol:33-35` comment, `handleTransfer`).

### FAIR GENESIS (v6) — the anti-snipe opening

Constants (`SpawnPad.sol`): `GENESIS_WINDOW = 600` seconds,
`SNIPE_MAX_BPS = 2900`, `GENESIS_MAX_USD = 250e18`. State:
`spawnBlock[token]` (set in `_spawn`) and `genesisSpent[token][actor]` —
keyed by the **wide** actor, so a Solana sniper and an EVM sniper are
capped identically. UI view: `fairGenesisOf(token, actor)`.

Rules, applied by `_genesisGate` to every OP_BUY (never to the spawn's own
dev buy — `genesisBuy = true`, the one exemption, disclosed in the UI):

1. **Block 0 does not exist.** `block.number <= spawnBlock[token]` ⇒
   spendable 0 — the whole `usdIn` rides home as a refund. LayerZero
   executor batching CAN land OP_SPAWN and OP_BUY in the same hub block,
   which is exactly why this is a clamp and not a revert.
2. **Decaying snipe tax.** Inside the window the buy fee rate is
   `FEE_BPS + SNIPE_MAX_BPS·(end − now)/GENESIS_WINDOW`: 30% total at t=0,
   linear to 1% at window end. The whole fee flows through `_accrueFee`
   under the token's launch-locked mode — snipers pay the holders, the dev,
   or the burn, like every other fee, just much more of it.
3. **Per-wallet cap.** Cumulative window spend per actor is clamped to
   `GENESIS_MAX_USD`; the excess refunds. The clamped *intent* is what
   counts against the cap (conservative under the curve-cap edge).

**Clamp-not-revert invariant.** The gate never reverts on the message
path: the spoke burned the buyer's oUSD before the message flew, and a hub
revert would strand that value (the adapter has no retry). Every refusal
re-uses the ordinary `OP_DELIVER(out=0, refund=…)`, so the §7 value
conservation holds through every guard action. `GenesisGuard(token, actor,
taxBps, taxUsd, refundedUsd)` logs guard actions; `Trade` is emitted only
when `spend + fee > 0`, so a full bounce leaves no phantom trade on the
tape (indexers wanting bounce analytics watch `GenesisGuard`).

**Wire compatibility.** No new ops, no payload changes — v6 is hub-only
logic; gateways, adapters and the Solana program are untouched.

**Sybil caveat (honest).** The $250 cap is per-identity and trivially
sybil-able by funding N wallets; treat it as a speed bump. The defenses
that survive sybils are the tax — every wallet pays the same decaying
rate, so splitting a snipe N ways saves nothing — and the structural one:
cross-chain buys ride ~1–2 minutes of LayerZero latency, so a same-second
multichain snipe is physically impossible on this architecture.

## 9. Curve math (InternalCurveVenue)

Constant-product with virtual reserves (`InternalCurveVenue.sol`):
`V_BASE_0 = 6_000e18`, `V_TOKENS_0 = 1_073_000_000e18`,
`CURVE_SUPPLY = 800M·1e18` of the 1B sold on the curve.

- Buy: `out = vTokens − k/(vBase + usdIn)`; if the buy overshoots the
  remaining curve supply it is capped and charged only what the remainder
  costs, `+1` rounding against the buyer (`execBuy`, `:52-71`); the pad
  refunds the unspent remainder to the buyer's chain.
- **Ascension:** when `sold ≥ CURVE_SUPPLY`, `vBase −= V_BASE_0` (the
  virtual part evaporates; what remains is real raised USD) and
  `vTokens = 200M` — the reserved supply seeds the "omnipool" and trading
  continues on the same storage slot (`:65-71`).
- Sell: inverse CP; pre-ascension `sold` decreases (floored at 0).
- The venue is **pure accounting** — the pad keeps custody of all tokens
  and oUSD (`InternalCurveVenue.sol` header); `onlyPad` on every mutator.
  This is what makes the venue swappable (`ICurveVenue`) for a Raydium
  LaunchLab / Meteora DBC adapter on a production Solana hub without
  touching settlement. The adapter itself does not exist yet — OUT OF
  SCOPE until written.

## 10. Solana leg (spawn_gateway program)

Status: built and proven locally against the real devnet LayerZero binaries
(endpoint, ULN302, executor, price feed, DVN — snapshotted by
`solana/tests/fetch-fixtures.sh`); not yet deployed to devnet. Details and
the engineering log: [../solana/NOTES.md](../solana/NOTES.md).

- **Accounts:** Store PDA (`["Store"]`) is the OApp identity the hub routes
  to as bytes32; PeerConfig per remote eid holds the hub **adapter** as LZ
  peer, while `Store.hub_pad` holds the hub **pad** as protocol peer — the
  same two-level trust chain as the EVM adapters (`state.rs`).
- **Receive:** `lz_receive` burns the nonce via the endpoint `clear()` CPI
  **before any state change** (`lz_receive.rs:48-69`), then unwraps and
  authenticates the envelope, then dispatches. The executor resolves the
  account list through `lz_receive_types_v2` (Solana has no dynamic account
  access).
- **Decimal bridge:** SPL mints use 6 decimals; hub 1e18 amounts divide by
  `1e12` on receive (floor) and multiply back on send; overflow errors,
  never wraps (`constants.rs:30-35`). See Finding F-4 for the dust ledger
  skew.
- **GasTank:** `["GasTank"]`, a zero-data system-owned PDA anyone can fund;
  each send self-quotes and reimburses the payer from it, so users send for
  ~free (~0.001 SOL/message at current devnet config) — the mirror of the
  EVM adapters' tank (`constants.rs:19-25`, `send_to_hub.rs`).
- **Codec:** hand-rolled canonical ABI codec, byte-exact against vectors
  generated by ethers' AbiCoder (`contracts/scripts/gen-codec-vectors.js`
  → `solana/tests/codec-vectors.json`: 25 op vectors + 3 envelope vectors).

## 11. Known gaps and testnet shortcuts

| Item | Status |
|---|---|
| ~~OmniUSD open faucet instead of real USDC~~ | **RESOLVED in v7** — `OmniUSD` is a USDC-backed vault with no faucet (§7). Testnets and the local world run the *same* contract over a `MockUSDC` (open mint, 6 decimals, admin blacklist) and no CCTP; mainnet passes Circle's USDC + `TokenMessengerV2`. `MockUSDC`/`MockTokenMessenger` must never be deployed to a mainnet. AUDIT SCOPE: `OmniUSD.sol`, the gateway USDC paths |
| Vault peers chosen by the admin, not sealed or time-locked | AUDIT SCOPE — a hostile admin can name a fake peer and rebalance into it (§7); fix planned in the hardening chantier |
| CCTP attestation relay for rebalances is manual (no keeper), payouts are all-or-nothing | OUT OF SCOPE (ops) — but note the user-facing effect: oUSD claims on a short chain wait for the admin |
| Admin = single EOA, no multisig/timelock | AUDIT SCOPE as a threat model (hostile admin), fix planned pre-mainnet |
| No pause switch, no per-token or global rate limits on messages | AUDIT SCOPE (absence is the finding; mainnet adds them) |
| Unordered delivery + LZ retry as the only ordering backstop | AUDIT SCOPE (see F-2) |
| `FeeDistributor` 2^128 magnitude edge | AUDIT SCOPE (quantify) |
| ~~Hub-chain local trading absent~~ | **RESOLVED in v7** — the hub chain has its own gateway (label 3) on the hub adapter's loopback (§3). What remains is the S3 dead branch (`HUB_CHAIN` share + the hub `FeeDistributor`): AUDIT SCOPE (dead code is attack surface) |
| `OP_FEE_DROP` fan-out is not prepaid by anyone (v7 fee model) | AUDIT SCOPE + design decision before mainnet — each holders distribution sends one message per chain holding supply, paid by the hub tank; with `DIST_TRIGGER = $2` the shipping can exceed the drop. Options: raise the trigger, net the fan-out cost from the pot, or make distribution a user-paid pull |
| `returnUnit` / `tradeLegs` / `spawnLegs` are admin-set estimates of a moving price | AUDIT SCOPE as a liveness model — set too low the hub tank drains and replies stall (retryable, §3); set too high users overpay into the tank. Needs monitoring + a refresh routine; one `returnUnit` per destination means a spawn's SYNC legs are priced at the origin's unit, not each target's |
| Gateway sponsorship is one admin flag | AUDIT SCOPE (hostile/mistaken admin) — sponsoring a gateway on mainnet reopens the dust-drain of its adapter's tank |
| Solana program still pays its sends from a protocol GasTank and prepays no reply | must adopt the v7 fee model before a Solana mainnet leg (wire unchanged; the fee plumbing is transport-side) |
| Frontend indexing by raw `eth_getLogs` scans | OUT OF SCOPE (ops; mainnet gets an indexer) |
| LayerZero DVN/executor selection | adapters now set a delegate (v7), so the set CAN be chosen — and must be, at deploy time, per pathway and on both sides (§3). Until `endpoint.setConfig` is called the defaults apply. AUDIT SCOPE for mainnet config review |
| Raydium/Meteora venue adapter | does not exist yet; OUT OF SCOPE until written |
| Solana devnet deploy + live delivery | pending; everything local is test-proven |

## 12. Findings while specifying

Observations made while writing this spec from the code — none silently
papered over:

- **F-1 — `gatewayChain` is write-only.** `SpawnPad.setGateway` populates
  `gatewayChain[gw]` (`SpawnPad.sol:150`) but no contract, script, test or
  frontend code reads it. Either remove it or document the intended
  consumer; unused reverse-mappings invite drift.
- **F-2 — SYNC/DELIVER ordering race on spawn with dev-buy.** `_spawn`
  sends OP_SYNC_TOKEN to every chain and then `_buy` immediately sends
  OP_DELIVER to the creator's chain. Delivery is unordered
  (`nextNonce = 0`), so the DELIVER can land first, hit
  `replicaOf[token] == address(0)` and revert; recovery relies on
  LayerZero's failed-message retry until the SYNC lands. Works, but is an
  implicit liveness dependency worth an explicit code comment and a test —
  and on Solana the equivalent path must be checked (`lz_receive_types_v2`
  resolves the replica PDA; a missing replica fails account resolution
  rather than execution).
- **F-3 — stale seed-width comments in `constants.rs`.** Comments say
  `hub_token(20)` for `REPLICA_SEED`/`MINT_SEED` but the code seeds PDAs
  with the full 32-byte wire id (`lz_receive.rs:134,154`). Comment-only
  staleness from the v4 widening; fix the comments before an auditor trips
  on them.
- **F-4 — Solana dust skews ledger S2.** DELIVER floors `tokens/1e12` when
  minting SPL units while the hub credits the full 1e18 amount to
  `supplyByChain[token][1]`; the sub-1e-6 dust is un-sellable phantom
  supply that also weighs (negligibly) in holder-distribution pro-rata.
  Bound it (≤ 1e12−1 wei per delivery) and decide whether the hub should
  floor identically.
- **F-5 — curve-capped buys round the fee in the buyer's favor by design.**
  When the curve caps a buy, the fee is recomputed as 1% of the actual
  spend (`SpawnPad.sol:312`) — the refund includes the fee difference.
  Intentional, but assert it in tests so a refactor doesn't flip it.
- **F-6 — `FeeDistributor.exclude` is assumed wire-up-only.** Excluding an
  account that already holds shares leaves its shares counted
  (`handleTransfer` clamps decreases but never retro-syncs). The code
  comment states the assumption (`FeeDistributor.sol:61-62`); the admin
  threat model in §2 should cover a late `exclude` call.
