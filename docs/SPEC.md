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
- *hardening* — every contract answers to three roles (admin = a timelock,
  operator, guardian — §2); new exposure can be paused, exits cannot (§2);
  holder fees accrue on the hub and are pulled by a user-paid message
  instead of fanning out for free (§8, one ADDITIVE wire op, `OP_PULL_FEES
  = 5`); and a message that carries a user's value never reverts — it is
  refused with a refund, or parked for its owner (§4, "What can still
  revert").

## 2. Actors and trust model

| Actor | Powers | Where |
|---|---|---|
| **admin** (mainnet: a `TimelockController`) | topology and custody — see the role table below | `Roles.sol`, every contract |
| **operator** (mainnet: the owner's Safe) | prices, limits, rebalancing, unpause | `Roles.sol`, every contract |
| **guardian** (a hot key) | pause | `Roles.sol`, every contract |
| **token creator ("dev")** | locks the fee mode at launch; claims the dev fee share from any chain | `SpawnGateway.sol:spawnToken/spawnTokenUsdc`, `SpawnPad.sol:_claim` |
| **trader / holder** | buy, sell, pull this chain's holder fees, claim holder dividends, claim a parked delivery — all on their own chain; wrap/unwrap USDC ⇄ oUSD | `SpawnGateway.sol:buyToken/buyTokenUsdc/sellToken/pullFees/claimPending`, `FeeDistributor.sol:claim`, `OmniUSD.sol:wrap/unwrap` |
| **Circle (USDC issuer, CCTP attester)** | can blacklist any account incl. a vault, pause USDC, denylist CCTP callers, switch on a CCTP minimum fee | external — see §7 |
| **LayerZero endpoint + DVN/executor** | message verification & delivery between adapters | `lz/LayerZeroOmniMessenger.sol` |

### Roles (v7)

`Roles.sol` is inherited by `SpawnPad`, `SpawnGateway`,
`LayerZeroOmniMessenger`, `LocalOmniMessenger`, `OmniUSD` and
`FeeDistributor` (`InternalCurveVenue` and `SpawnToken` have no privileged
function). The admin is two-step transferable (`transferAdmin` →
`acceptAdmin` by the nominee; nominating `address(0)` cancels) and names
the operator and the guardian. The admin may always act as operator, and
the operator as guardian. On `acceptAdmin` the LayerZero adapter re-points
its endpoint delegate to the new admin, so the right to choose DVNs follows
the admin (`LayerZeroOmniMessenger._onAdminChanged`).

Powers are split by what they can do to user funds:

| Role | Function | Why it sits there |
|---|---|---|
| **admin** | pad `setVenue` (once), `setGateway` (once per label, never label 0), `setAutoDrop` | a gateway mints value into the hub's books; the venue prices every trade; `autoDrop` on a remote chain re-opens the unfunded fan-out |
| | adapter `register` / `unregister`, `setRoute` (once per label), `repointRoute`, `setLocal`, `setSponsored`, `setDelegate`, `recover` | who may speak, whose word is believed, who chooses the DVNs, where the tank's ETH goes |
| | OmniUSD `setAgent` (once), `setPeer` (once per label) | the agent can pay out the vault; a peer is a destination for vault USDC |
| | FeeDistributor `setAgent` (once), `exclude`, `sealExclusions`; gateway `setDistributor` (once) | who drops fees in, who earns nothing |
| | `transferAdmin`, `setOperator`, `setGuardian` — everywhere | role assignment |
| **operator** | adapter `setDestination` (executor gas, reply budget — capped at `MAX_RETURN_UNIT = 0.05` native); gateway `setLegs` (capped at 4 / 32) | prices a moving market; bounded |
| | OmniUSD `setDepositCap`, `rebalance` (to an existing peer only), `unpauseDeposits`; pad / gateway `unpause` | limits and liveness |
| **guardian** | pad `pause`, gateway `pause`, OmniUSD `pauseDeposits` | a fast stop for NEW exposure |

**Intended mainnet deployment** (proved end to end in
`test/hardening.test.js`, "admin behind a real TimelockController"): admin
= `SpawnTimelock` (OpenZeppelin `TimelockController`, 48–72 h); proposer and
executor = the owner's Safe; operator = the same Safe, acting directly;
guardian = a hot key that also holds the timelock's `CANCELLER_ROLE`. The
bootstrap: the timelock is created with delay 0 and the deployer as its
only proposer/executor, every contract nominates it, it accepts them all in
one `executeBatch`, raises its own delay through itself, the Safe and the
guardian are granted their roles and the deployer renounces all of its own
(including `DEFAULT_ADMIN_ROLE`).

### What each role can do in hostile hands

| Role | At once | After the timelock delay | What bounds it |
|---|---|---|---|
| **guardian** (hot key stolen) | pause the pad, any gateway, any vault's deposits — repeatedly | — | cannot unpause, tune, wire or move anything. Exits (`sellToken`, `claimFees`, `pullFees`, `claimPending`, `unwrap`, `payout`, distributor `claim`) have no pause. Griefing only; the admin replaces the key |
| | cancel any scheduled timelock operation (`CANCELLER_ROLE`) | — | can block upgrades/wiring indefinitely (liveness), never cause one |
| **operator** (the Safe, used directly) | set reply budgets and legs too LOW → the hub tank drains and replies stall (retryable); too HIGH → users who sign the quoted fee overpay into the tank | — | `MAX_RETURN_UNIT`, `MAX_TRADE_LEGS`, `MAX_SPAWN_LEGS`; the overpayment lands in the adapter's tank, which only the ADMIN can `recover` |
| | set executor gas too low → hub-bound messages run out of gas on arrival | — | value is not lost: a failed LayerZero delivery stays retryable by anyone with more gas |
| | `rebalance` a vault's whole USDC to a peer vault; `setDepositCap`; unpause during an incident | — | USDC can only go to a peer the admin named; local payouts fall back to oUSD claims, redeemable once liquidity returns. No operator function sends funds out of the protocol |
| **admin** (the Safe proposes through the timelock) | nothing | **everything**: name an attacker as peer vault and have the operator rebalance into it; re-point a spoke's hub route to a forged adapter and send it `OP_PAYOUT`; add a gateway label that mints unbacked oUSD into the hub's books; `recover` every tank; sponsor a gateway; replace operator and guardian | the delay itself: each of these is a public `CallScheduled` event for 48–72 h, during which every exit stays open and the guardian can `cancel`. **The timelock buys users time to leave, not immunity** — a hostile admin whom nobody vetoes drains what is left |
| **deployer** (after the hand-over) | nothing | nothing | holds no role anywhere (asserted) |

Testnets run with all three roles on the deployer EOA — a configuration
value of `deploy-testnet.js`, not a code branch. **A deployment whose admin
is an EOA has no delay: its admin key is a drain key.**

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
  of it: `tradeLegs` for a buy / sell / claim / fee pull (1 on a remote
  chain: the DELIVER, PAYOUT or FEE_DROP), `spawnLegs (+ tradeLegs with a
  dev buy)` for a spawn (the SYNC to every remote chain). Both are
  operator-set per gateway (`SpawnGateway.sol:setLegs`, capped at 4 and 32)
  — budget multipliers, not hard message counts.
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
- `SpawnGateway.quoteBuy / quoteSell / quoteClaim / quotePull /
  quoteSpawn(name, symbol, metaURI, withDevBuy)` return the exact fee before
  signing. Trade payloads are fixed-size; a spawn's fee depends on its
  strings, so its quote takes them.
- Sponsorship is configuration, not a code path: testnets sponsor their
  gateways (the tank pays, visitors need no fee logic); mainnet sponsors the
  pad only.

**Failure mode.** If the hub tank cannot pay a reply (`"LZM: gas tank
empty"`), the inbound `lzReceive` reverts as a whole: the BUY/SELL/SPAWN is
not consumed, the user's value is still in flight, and LayerZero keeps the
message retryable — anyone can re-execute it once the tank is refilled
(tested: the packet stays queued and lands after a top-up). A tank only
runs dry if `returnUnit` is set below the real reply cost. Tank level is an
ops alert.

**Every remote message the hub sends is prepaid (v7 hardening).** The one
exception M2 left — the `OP_FEE_DROP` fan-out a trade could trigger, one
message per chain holding supply, paid by nobody — is gone: a trade now
only BOOKS each chain's slice on the hub (`pendingDrop`), and the slice
travels when someone on that chain sends `OP_PULL_FEES` and prepays the
reply like any trade (§8). The only chain shipped to without a pull is one
the admin flagged `autoDrop` — the hub chain's own gateway, where the drop
is a free same-transaction call. Asserted in `hardening.test.js`: through a
long mixed scenario with unsponsored gateways (spawns from four chains in
every fee mode, with and without dev buys, buys inside and after the
genesis window, sells, dev claims, pulls) the hub tank's balance is
checked after every single delivery and never decreases.

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
| OP_SPAWN (hub), 5 remote SYNCs and a dev buy | 4.50M on the mock ≈ 1.4M of protocol work + one send per remote chain + the DELIVER (≈ 0.52M each on the mock) | 4M to the hub |
| OP_BUY / OP_SELL / OP_PULL_FEES (hub), incl. one reply send | 0.24M / 0.20M / 0.13M (a buy no longer carries a fee fan-out) | 4M to the hub |
| OP_SYNC_TOKEN (spoke — a replica deploy) | 0.72M | 2M to a spoke |
| OP_DELIVER / OP_PAYOUT / OP_FEE_DROP (spoke) | 0.15M / 0.10M / 0.13M | 2M to a spoke |

(`PRINT_GAS=1 npx hardhat test --grep "executor gas"` reprints these.)

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
(`endpoint.setDelegate`), the admin can move it (`setDelegate`), and a new
admin becomes the delegate as it accepts the role (`_onAdminChanged`) — on
mainnet the delegate is therefore the timelock, and a DVN change is as slow
and public as any other topology change. The
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
message must therefore be self-contained. The one ordering race this left
(Finding F-2: a DELIVER landing before the SYNC that creates its replica)
is now absorbed by the gateway, which parks what it cannot settle yet (§4).

### Routes (v7 hardening)

`setRoute(label, eid, peer)` opens a route once: it refuses a label that
already has one (`"LZM: label routed"`), an eid that already serves a label
(`"LZM: eid taken"` — two labels can never share a peer) and a label marked
local (`"LZM: label is local"`; `setLocal` conversely refuses a routed
label). Changing whose word is believed for a chain is a separate call,
`repointRoute`, which vacates the old eid and emits `RouteRepointed(label,
oldEid, oldPeer, eid, peer)`. Both are admin-only. `unregister` strikes a
sender off (and drops its sponsorship).

## 4. Message catalog — the single source of truth

Envelope payload = `abi.encode(uint8 op, bytes data)`; `data` per op below.
All tuples use canonical ABI encoding; every account rider is `bytes32`.
"wide ok" = the value may be a non-EVM identity and is never downcast on
that path; "downcast" = checked 20-byte downcast, top-12-bytes-zero or
revert (`SpawnPad.sol:_addr` → `"PAD: bad recipient"`,
`SpawnGateway.sol:_addr` → `"GW: bad recipient"`).

| Op | Name | Direction | Wire tuple (`data`) | Trigger | Effect on receive |
|---|---|---|---|---|---|
| 1 | OP_SPAWN | gateway → pad | `(bytes32 creator [wide ok], string name, string symbol, string metaURI, uint256 devBuyUsd, uint8 feeMode)` | `SpawnGateway.spawnToken` (burns dev-buy oUSD first) or `spawnTokenUsdc` (v7: pulls dev-buy USDC into the vault via `OmniUSD.depositFor`) — same message. The gateway first refuses what the hub would: `feeMode > 3` (`"GW: bad fee mode"`), name > 64 / symbol > 16 / metaURI > 1024 bytes (`"GW: string too long"`), a paused gateway (`"GW: paused"`) | `SpawnPad._spawn`: deploy hub `SpawnToken` (premint 1B to pad, reporting to no distributor), store `Meta` (creator stays wide), `venue.openMarket`, emit `Spawned`, send OP_SYNC_TOKEN to **every** registered chain, then optional dev-buy via `_buy`. **Refused** (no token; a dev buy goes home by OP_PAYOUT) when the pad is paused or `feeMode > 3` |
| 2 | OP_BUY | gateway → pad | `(bytes32 token [downcast], bytes32 buyer [wide ok], uint256 usdIn)` | `SpawnGateway.buyToken` (burns buyer's oUSD; ≥ 1e12 wei, `"GW: dust"`) or `buyTokenUsdc` (v7: pulls USDC into the vault) — same message; both first require a local replica (`"GW: unknown token"`), so a BUY for a token the hub never spawned cannot leave the chain | `SpawnPad._buy`: genesis gate, fee off the top, `venue.execBuy`, mint `spend + fee` into the hub's books, burn hub tokens, `supplyByChain[src] += out`, send OP_DELIVER (tokens + refund), emit `Trade`, `_accrueFee`. **Refused** — whole `usdIn` refunded — when the pad is paused or the venue refuses (via OP_DELIVER, `out = 0`), or the token id is wide/unknown (via OP_PAYOUT) |
| 3 | OP_SELL | gateway → pad | `(bytes32 token [downcast], bytes32 seller [wide ok], uint256 tokensIn)` | `SpawnGateway.sellToken` (burns seller's replica; ≥ 1e12 wei, `"GW: dust"`). Never paused | `SpawnPad._sell`: `venue.execSell`, mint tokens back to pad custody, `supplyByChain[src] -= tokensIn`, 1% fee, burn net oUSD, send OP_PAYOUT, emit `Trade`, `_accrueFee`. **Refused** when the venue will not price it: the bag goes back by OP_DELIVER |
| 4 | OP_CLAIM | gateway → pad | `(bytes32 token [downcast], bytes32 claimer [wide ok])` | `SpawnGateway.claimFees` (requires a local replica). Never paused | `SpawnPad._claim`: pay `dev − devClaimed` via OP_PAYOUT to the claim chain, emit `DevClaimed`. **Refused** (no reply) when `claimer` is not the creator (wide comparison) or nothing is accrued |
| 5 | OP_PULL_FEES (v7) | gateway → pad | `(bytes32 token [downcast])` | `SpawnGateway.pullFees` — anyone, for any token with a local replica; prepays `tradeLegs`. Never paused | `SpawnPad._pull`: split any pot not split yet, then send `OP_FEE_DROP(token, pendingDrop[token][src])` to the source chain and zero it, emit `FeesPulled`. **Refused** (no reply) when nothing is waiting or the token is unknown |
| 10 | OP_SYNC_TOKEN | pad → gateway | `(bytes32 token [downcast on EVM spokes; raw 32-byte seed on Solana], string name, string symbol)` | inside `_spawn`, one per registered chain | EVM: deploy replica (`SpawnToken` premint 0, controller = gateway), record `replicaOf`, then book any fee drop parked for it. A SYNC for a token that already has a replica is ignored. Solana: create Replica PDA + SPL mint, decimals 6, authority = store (`lz_receive.rs::handle_sync_token`) |
| 11 | OP_DELIVER | pad → gateway | `(bytes32 token [downcast/seed], bytes32 to [downcast on EVM; raw pubkey on Solana], uint256 tokens, uint256 refund)` | inside `_buy`; also a refused sell's bag coming back | EVM: `replica.bridgeMint(to, tokens)` — or, if the replica does not exist yet or the mint fails, **park** in `pendingDelivery[token][to]` for `claimPending`; the refund settles at once either way by `OmniUSD.payout(to, refund)` (USDC if the vault is liquid, else an oUSD claim). Solana: mint `tokens / 1e12` to recipient's ATA (+ scaled refund) |
| 12 | OP_PAYOUT | pad → gateway | `(bytes32 to [downcast on EVM; raw pubkey on Solana], uint256 usdOut)` | `_sell` net proceeds, `_claim` dev share, a refused spawn's dev buy, a refused unknown-token buy | EVM: `OmniUSD.payout(to, usdOut)` (v7 — USDC if liquid, else an oUSD claim; never reverts) |
| 13 | OP_FEE_DROP | pad → gateway | `(bytes32 token [downcast/seed], uint256 amount)` | the reply to OP_PULL_FEES; or, for an `autoDrop` chain only, `_distributeHolders` directly | EVM: `distributor.drop(replica, amount)` and mint the oUSD into the chain's `FeeDistributor`; if there is no replica or no distributor yet, or the distributor refuses, **park** in `pendingFeeDrop[token]` (flushed by the SYNC, or by anyone via `flushFeeDrop`). Holders claim oUSD and unwrap or trade with it. Solana: mint into the store's vault ATA, parked pending the phase-3 distributor |

Unknown ops revert (`"PAD: bad op"` / `"GW: bad op"`); the Solana codec
rejects unknown ops, dirty envelope padding and bad offsets
(`msg_codec.rs` tests). Op 5 is ADDITIVE: ops 1–4 and 10–13 are byte-for-
byte unchanged, the codec vectors in `solana/tests/codec-vectors.json` were
not regenerated, and the Solana program neither sends op 5 yet nor ever
receives it (it is gateway → pad only).

### What can still revert on the message path

The rule (v7): **a message that reached its destination carries value a
user already gave up on the other chain; it must be executed, refused with
that value sent home, or parked for its owner — never reverted.** Refusals
on the pad emit `Refused(op, srcChain, token, actor, amount, reason)`
(1 paused, 2 unknown token, 3 bad fee mode, 4 not the dev, 5 nothing to
pay, 6 venue refused). Every revert site reachable from `onOmniMessage`,
through every contract it calls:

| Where | Revert | Class | Why / what was done |
|---|---|---|---|
| pad, gateway | `"… not messenger"`, `"PAD: not a gateway"`, `"GW: not the pad"`, malformed `abi.decode`, `"… bad op"` | authentication | not a protocol message at all; an authentic gateway/pad cannot produce these |
| pad `_spawn` | ~~`"PAD: bad fee mode"`~~ | **was a stranding bug — fixed** | `spawnToken` did not validate `feeMode`, so a spawn with a bad mode and a dev buy burned the dev buy and reverted on the hub forever. Now refused at the gateway AND refunded by the pad |
| pad `_spawn` | out of gas on oversized strings | **was reachable — fixed** | name/symbol/metaURI are stored on the hub and replayed to every chain; now capped at the gateway (64 / 16 / 1024 bytes). The largest legal spawn (max strings + dev buy, 5 remote chains) costs ≈ 2.33M of hub work plus one endpoint send per remote chain — ≈ 3.5M at an ESTIMATED 0.2M per real send, inside the 4M budget (the mock's 0.52M per send is measured, the real figure is not: the testnet rehearsal must confirm it, and the hub gas limit must rise with the number of remote chains) |
| pad | ~~`"PAD: bad recipient"` on a wide token id~~ | fixed (defence in depth) | a wide or unknown token id is refused; a BUY's dollars go home by OP_PAYOUT |
| pad `_claim` | ~~`"PAD: not the dev"`, `"PAD: nothing to claim"`~~ | fixed | carried no value, but left a dead, never-retryable packet behind; now a refusal with no reply |
| pad `_buy` / `_sell` / buyback → venue | `"VENUE: dust"`, `"VENUE: zero …"`, `"VENUE: unknown token"`, anything a future venue throws | fixed | `execBuy` / `execSell` run under `try`: a buy bounces whole, a sold bag is re-delivered, a buyback leaves its pot for the next fee. The gateway also floors buys and sells at 1e12 wei so dust never leaves |
| pad `_sell` | **a 1-wei sell returned 1 wei of oUSD; a round trip could leave the pad 1 wei short of its own pots, reverting the burn that pays the last seller or puller** | **was a stranding bug — fixed at the root** | `InternalCurveVenue` rounded in the trader's favour. It now rounds every trade against the trader (ceiling division), which keeps `vBase ≥ V_BASE_0`; `hardening.test.js` asserts pad solvency (V1) as an exact equality after each of 90 odd-sized random trades |
| pad `_sell` | `supplyByChain[token][src] -= tokensIn` underflow | invariant guard | cannot fire while S2 holds: a gateway can only burn replicas the hub delivered to its chain. If it fires, the ledger is corrupt and a loud, retryable revert is the right outcome |
| pad | `usd.bridgeBurn` / `SpawnToken.bridgeBurn` insufficient balance | invariant guard | cannot fire while V1 / S1 hold (now exact, see above) |
| pad | `"VENUE: market open"`, `new SpawnToken` | unreachable | a fresh CREATE address has no market; deployment fails only by running out of gas (bounded by the string caps) |
| pad → adapter | `"LZM: gas tank empty"` | **acceptable — retryable** | the reply cannot be paid; the inbound message is not consumed and LayerZero keeps it re-executable by anyone once the tank is refilled (tested). Cannot happen from protocol traffic alone: every reply is prepaid |
| pad → adapter | `"LZM: no route"`, `"LZM: no gas limit"` | misconfiguration — retryable | a gateway label wired on the pad before its destination was configured on the hub adapter; fixing the adapter un-sticks the message. Deploy scripts set the destination first |
| pad `_distributeHolders` → `autoDrop` send | any failure of the local drop | fixed | the send runs under `try`; a drop that cannot be shipped falls back to `pendingDrop` instead of undoing the trade that triggered it |
| gateway DELIVER | ~~missing replica~~ (F-2), a failing `bridgeMint` | **was a stranding bug — fixed** | parked in `pendingDelivery`, claimed by the recipient with `claimPending`; the refund leg still settles at once |
| gateway FEE_DROP | ~~`"GW: no replica"`~~, no distributor, a failing `drop` | fixed | parked in `pendingFeeDrop`, flushed by the SYNC or by `flushFeeDrop` |
| gateway SYNC | a second SYNC for the same token | fixed | ignored; it used to overwrite `replicaOf` and orphan every holder of the first replica |
| gateway SYNC | `"GW: no distributor"` | misconfiguration — retryable (added on purpose) | a replica deployed before the gateway has its holder pool could never be given one — its holders would earn nothing, forever. A SYNC carries no user value, so it fails loudly until the admin sets the distributor; a DELIVER or FEE_DROP landing meanwhile parks. Deploy scripts set the pool before the pad learns the gateway. On the hub chain's own gateway this reverts the whole spawn (atomic) |
| gateway → `SpawnToken._update` → `FeeDistributor.handleTransfer` | arithmetic overflow in `magDPS × amount` | **was an exploitable stranding bug — fixed at the root** | see §8 "The 2^128 edge": a drop landing on a few wei of shares made every later mint of that replica revert, i.e. every later DELIVER on that chain. Closed by `MIN_SHARES`; a failing mint is parked in any case |
| gateway | `"GW: bad recipient"` on a wide `to` / token id | corruption guard (kept) | this is an EVM chain: every recipient the hub echoes back was a local `msg.sender`, every token id a hub address. A wide value has no EVM account to be parked for |
| gateway → `OmniUSD.payout` | — | never reverts | USDC if the vault is liquid and the transfer is accepted, else an oUSD claim (§7); `to == 0` is unreachable |
| gateway → `OmniUSD.payout` / `bridgeMint` | `ReentrancyGuard` | unreachable | no path re-enters `OmniUSD` while one of its guarded functions is on the stack: `depositFor` returns before the message is sent, and USDC has no transfer hook |

Two properties of the `try` blocks that matter. (1) They cannot be turned
into a forced bounce or a forced park by an executor that starves the call
of gas: the call receives 63/64 of the remaining gas, and what must run
afterwards (a reply send on the pad, a fresh storage slot on the gateway)
needs far more than the 1/64 left — so either the inner call had ample gas
or the whole delivery reverts and stays retryable. (2) A `try` only guards
an external call's revert; nothing is swallowed inside the pad or the
gateway themselves.

## 5. Identity model — the downcast is a security boundary

The rule (`SpawnPad.sol:209-219` comment block): **actors stay wide
end-to-end; only hub-local settlement downcasts.**

- The hub never pays an actor by local transfer — it pays by message — so a
  Solana creator/trader flows through storage (`Meta.creator: bytes32`),
  events (`Spawned/Trade/DevClaimed` emit `bytes32 indexed` actors) and auth
  (`_claim`'s wide comparison) untouched.
- Token ids always downcast on the hub (every token is an EVM contract
  deployed there) — a wide token id is corruption. Since v7 the hub
  REFUSES it rather than reverting (`SpawnPad._known`): a BUY's dollars are
  sent home, anything else is logged and dropped (§4).
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
- **S2 (ledger ≡ reality):** for every user-facing chain `c`,
  `supplyByChain[token][c] =` that chain's replica `totalSupply()` + the
  deliveries parked for it (`Σ pendingDelivery[token][·]`, v7 — tokens the
  hub debited that are waiting for `claimPending`) — up to the Solana dust
  noted in Finding F-4.
- **S3:** `supplyByChain[token][HUB_CHAIN] == 0` always, and nothing reads
  it. Hub-local trading (v7) does not go through label 0: the hub chain's
  users trade through their own gateway, label 3, like any other chain's
  (`supplyByChain[token][3]` = Base's replica supply, S2). The dead code
  that assumed otherwise was removed in the hardening chantier: the
  `HUB_CHAIN` share of `_distributeHolders`, the pad's `distributor` /
  `setDistributor`, and the hub-side `FeeDistributor` itself. The hub
  `SpawnToken` now reports to no distributor (`distributor == address(0)`):
  it never leaves the pad's custody. `setGateway` refuses label 0.
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
- **Rebalancing trust model.** `rebalance(dstLabel, usdc6)`
  (operator) burns vault USDC through Circle CCTP V2
  `TokenMessengerV2.depositForBurn` with `mintRecipient =
  peers[dstLabel].vault`, `destinationCaller = 0` (anyone may relay the
  attestation), `maxFee = 0`, `minFinalityThreshold = 2000` (Standard
  Transfer). `setPeer` (admin) is once-per-label and can never be re-aimed.
  **What this does and does not give:** the operator can move a vault's
  liquidity to another protocol vault and nowhere else — a liveness power
  (local payouts fall back to oUSD claims until it comes back), not a theft
  power. Naming a NEW label is the admin's, i.e. the timelock's: a label
  whose "peer vault" is an attacker's address is a way out of the vault, so
  it has to sit in public for the delay before `rebalance` can use it, and
  the guardian can cancel it (§2, tested with the real `TimelockController`).
  After the delay, un-vetoed, it works — the admin remains the root of
  trust; the timelock makes its hostility visible, not impossible.
- **Deposit cap and deposit pause.** `depositCap` (operator) bounds the
  vault's USDC *balance* at deposit time (default 0 = closed);
  `pauseDeposits` (guardian) closes `wrap` and `depositFor` outright
  (`"oUSD: deposits paused"`, reopened by the operator). Neither ever blocks
  an exit: `unwrap` and `payout` have no switch at all. The cap is not a
  bound on oUSD claims minted by payout fallbacks, and a direct USDC
  donation or an inbound rebalance can fill it (deposits then wait for the
  operator).
- **Circle dependencies.** A blacklisted *vault* freezes that chain's USDC
  (exits fall back to oUSD claims, deposits revert); a CCTP denylist entry
  or a non-zero CCTP `minFee` makes `rebalance` revert (safe failure — a
  non-zero fee would otherwise break V0 by the fee amount).

The pre-v7 invariants are unchanged in shape:

- **V1 (pad solvency) — an exact equality:** hub oUSD balance of the pad
  `= Σ_tokens [curve real reserves (vBase − V_BASE_0 pre-ascension; vBase
  post-ascension) + (dev − devClaimed) + (holders − holdersPaid) + burnPot
  + Σ_chains pendingDrop]`. The last term is new in v7: slices booked for a
  chain stay in the pad's books until pulled. The pad mints exactly `spend
  + fee` on a buy and burns exactly what leaves (`_sell`, `_claim`, `_pull`,
  the `autoDrop` branch of `_distributeHolders`); there is no local
  transfer left. V1 used to be off by wei because the curve rounded in the
  trader's favour (§9, F-7) — which mattered: the burn that pays the last
  seller or puller of a token would revert. It is now asserted as an
  equality after every one of 90 odd-sized random trades across all four
  fee modes, with drops, pulls, claims, a buyback and an ascension
  (`hardening.test.js`, "the pad is solvent to the wei").
- **V2 (fee caps):** `devClaimed ≤ dev`, `holdersPaid ≤ holders`,
  enforced by monotone accounting in `_accrueFee`/`_claim`/
  `_distributeHolders`; rounding dust stays in the pot.
- **V3 (distributor solvency):** each `FeeDistributor`'s oUSD balance
  `≥ Σ withdrawable` across holders — a drop is booked and its oUSD minted
  in the same call (`SpawnGateway._flushFeeDrop`), claims pay out
  `withdrawable` exactly once (`FeeDistributor.sol:claim`).

## 8. Fee state machine

1% (`FEE_BPS = 100`) of every trade (`SpawnPad.sol:28`), computed off the
top on buys — with the fee recomputed down if the curve caps the buy
(`_buy`, `SpawnPad.sol:309-313`) — and off the proceeds on sells. Routed per
the launch-locked mode (`FeeState.mode`, set once in `_spawn`):

| Mode | Routing | Payout path |
|---|---|---|
| 0 FEE_HOLDERS | 100% → `holders` pot | split per chain at `DIST_TRIGGER = 2e18` (`_distributeHolders`), then pulled to each chain (below) |
| 1 FEE_SPLIT | 50% `holders`, 50% `dev` | both paths below |
| 2 FEE_DEV | 100% → `dev` pot | creator claims from any chain (OP_CLAIM → OP_PAYOUT) |
| 3 FEE_BURN | 100% → `burnPot` | at `BURN_TRIGGER = 4e18`: real `venue.execBuy` with the pot (moves the price), tokens burned on the spot, `Trade` emitted with the pad as buyer (`_accrueFee`, `SpawnPad.sol:366-381`) |

### Holder distribution: accrue, then pull (v7)

`_distributeHolders` runs when the holders pot (`holders − holdersPaid`)
reaches `DIST_TRIGGER`, and on demand at the start of every pull. It
splits the pot pro-rata to `supplyByChain` exactly as before — but a
chain's slice is now only an entry in `pendingDrop[token][chain]` (a public
mapping the UI reads); the oUSD stays in the pad's books (V1). No message
leaves, so no trade can make the hub tank pay for a fan-out (§3).

- **Pull.** Anyone on a chain calls `SpawnGateway.pullFees(hubToken)`,
  prepaying one reply like a trade. The pad first splits whatever was not
  split yet (so the puller gets everything due, not what was due at the
  last trigger), burns `pendingDrop[token][src]` from its books and replies
  `OP_FEE_DROP`; the slice lands in that chain's `FeeDistributor` for every
  holder there. Nothing waiting → no reply, no revert, and the prepaid
  budget stays in the hub tank.
- **`autoDrop`.** A chain the admin flagged is shipped at the trigger
  without a pull, together with anything still waiting for it. This is for
  the hub chain's own gateway only, where the "message" is a free
  same-transaction call; flagging a remote chain would bring the unfunded
  fan-out back. The send runs under `try`: a local drop that fails falls
  back to `pendingDrop` rather than undoing the trade that triggered it.
  The simulated one-node network (`deployWorld`) flags every label by
  default, since every delivery there is a free synchronous call;
  `deployWorld({ autoDrop: false })` runs it the mainnet way.
- **Claims** are pure local transactions, in oUSD, as before.

**Economic property to weigh (not a bug in the accounting).** A slice is
distributed to the holders present on a chain when it LANDS, not when it
was earned. With automatic $2 drips that difference was negligible; with
pull, a chain's slice can grow large if nobody pulls, and whoever buys on
that chain just before the pull shares in it. The costs working against
such "just-in-time" capture are the 2% round-trip fee, curve slippage and,
in the genesis window, the snipe tax; the structural answer is that anyone
(a keeper, the UI, any holder) can pull at any time, which keeps slices
small. `bots.js` pulls any slice above $1.

### FeeDistributor

The classic magnified-dividends-per-share pattern (`MAG = 2^128`): a
transfer hook on every replica (`SpawnToken.sol:_update`) mirrors balances
into shares; protocol accounts (the agent — this chain's gateway — and the
distributor itself) are excluded and earn nothing. State is keyed by the
calling token contract, so a rogue token can only corrupt its own key and
can never make `claim` pay more than its own dropped funds.

- **The 2^128 edge — was exploitable, now closed.** `magDPS[token] +=
  drop × 2^128 / totalShares`. If a drop lands while a chain holds a few
  wei of shares, `magDPS` becomes so large that `magDPS × amount` overflows
  on the next real mint; the transfer hook reverts, and with it every later
  mint of that replica — i.e. every later OP_DELIVER of that token to that
  chain, with the buyers' dollars already in the curve. That is not an
  absurd ratio but a cheap, deliberate setup: buy, sell all but 1 wei, let
  the fees you just paid be dropped on that 1 wei. Fix: a drop only folds
  in once `totalShares ≥ MIN_SHARES = 1,000 tokens`; below that it waits in
  `pendingOf` (as it always did with zero holders). Bound: `magDPS ≤ P ×
  2^128 / MIN_SHARES` for `P` oUSD-wei ever dropped on one token on one
  chain, and `magDPS × 1e27 < 2^255` holds while `P < 1.7e32` wei —
  $1.7e14. The attacker's setup is replayed step by step in
  `hardening.test.js` ("the 2^128 edge is closed") against the fixed code:
  the drop waits, the victim's delivery mints, `magDPS × 1e27` stays below
  2^255. (The pre-fix overflow itself is arithmetic, not re-run: a $61 drop
  on 1 wei gives `magDPS ≈ 2.1e58`, and × a 6e25-wei mint exceeds 2^256.)
  Independently, a mint that fails for any reason is parked by the gateway
  (§4).
- **Exclusions are wire-up only (F-6).** `exclude` refuses once
  `liveShares` — the total of shares across all tokens — is non-zero, and
  `sealExclusions()` (one-way) makes the set final. Deploy scripts seal
  every pool right after `setAgent`.

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

- **Rounding is always against the trader (v7, F-7).** Every trade computes
  the new reserve on the other side with a CEILING division, so `vBase ×
  vTokens` never decreases. Since `vTokens` can never exceed its starting
  value (a sell only returns what a buy took out), `vBase ≥ V_BASE_0` holds
  forever: the curve can never owe more dollars than were paid in. Before
  v7 both divisions floored — in the trader's favour: selling 1 wei of
  token returned 1 wei of oUSD (~178,000× its value), and a plain round
  trip could leave `vBase = V_BASE_0 − 1`, i.e. the pad one wei short of
  its own fee pots.
- Buy: `out = vTokens − ⌈k/(vBase + usdIn)⌉`; if the buy overshoots the
  remaining curve supply it is capped and charged only what the remainder
  costs, `+1` rounding against the buyer (`execBuy`); the pad
  refunds the unspent remainder to the buyer's chain.
- **Ascension:** when `sold ≥ CURVE_SUPPLY`, `vBase −= V_BASE_0` (the
  virtual part evaporates; what remains is real raised USD) and
  `vTokens = 200M` — the reserved supply seeds the "omnipool" and trading
  continues on the same storage slot (`:65-71`).
- Sell: `usdOut = vBase − ⌈k/(vTokens + tokensIn)⌉`; pre-ascension `sold`
  decreases (floored at 0). A sell worth less than one wei of oUSD reverts
  `"VENUE: dust"` — which the pad turns into a re-delivery of the bag (§4).
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
| ~~Vault peers chosen by the admin, not sealed or time-locked~~ | **RESOLVED in the hardening chantier** — naming a peer is admin-only and the admin is meant to be a timelock; `rebalance` is the operator's and reaches existing peers only (§2, §7). Residual, by design: an un-vetoed hostile admin succeeds after the delay |
| CCTP attestation relay for rebalances is manual (no keeper), payouts are all-or-nothing | OUT OF SCOPE (ops) — but note the user-facing effect: oUSD claims on a short chain wait for the operator |
| ~~Admin = single EOA, no multisig/timelock~~ | **RESOLVED in code** — three roles, two-step admin, hand-over to a real `TimelockController` proved by test (§2). NOT yet done on any live deployment: testnets keep all roles on the deployer; a mainnet deploy must run the hand-over (deploy tooling chantier) |
| ~~No pause switch~~ | **RESOLVED** — guardian pause of new exposure on the pad, each gateway and each vault's deposits; exits have no switch (§2, §7). Still absent: per-token or global RATE limits on messages — AUDIT SCOPE |
| ~~Unordered delivery + LZ retry as the only ordering backstop~~ | **RESOLVED** — the gateway parks what it cannot settle yet (F-2, §4) |
| ~~`FeeDistributor` 2^128 magnitude edge~~ | **RESOLVED** — it was exploitable, not theoretical; closed by `MIN_SHARES`, bound quantified in §8 |
| ~~Hub-chain local trading absent~~ | **RESOLVED in v7** — the hub chain has its own gateway (label 3) on the hub adapter's loopback (§3); the S3 dead branch was removed in the hardening chantier (§6) |
| ~~`OP_FEE_DROP` fan-out is not prepaid by anyone~~ | **RESOLVED** — holder fees accrue on the hub and travel on a user-paid `OP_PULL_FEES` (§8); every remote message the hub sends is now prepaid (§3). New economic property to review: just-in-time capture of a large un-pulled slice (§8) |
| `returnUnit` / `tradeLegs` / `spawnLegs` are operator-set estimates of a moving price | AUDIT SCOPE as a liveness model — set too low the hub tank drains and replies stall (retryable, §3); set too high users overpay into the tank (now bounded: `MAX_RETURN_UNIT`, legs ≤ 4 / 32). Needs monitoring + a refresh routine; one `returnUnit` per destination means a spawn's SYNC legs are priced at the origin's unit, not each target's; `spawnLegs` goes stale on every gateway when a chain is added |
| Gateway sponsorship is one admin flag | AUDIT SCOPE (hostile/mistaken admin, now behind the timelock) — sponsoring a gateway on mainnet reopens the dust-drain of its adapter's tank |
| A parked delivery needs a user transaction (`claimPending`) and the UI does not surface it yet | frontend chantier — the tokens are safe and visible on-chain (`pendingDelivery`, `DeliveryParked`), but a user who never looks never gets them |
| No rescue path for a permanently refused message's prepaid native fee, or for USDC sent to a vault by mistake | by design so far (no admin function moves vault USDC); note it |
| Solana program still pays its sends from a protocol GasTank and prepays no reply | must adopt the v7 fee model before a Solana mainnet leg (wire unchanged; the fee plumbing is transport-side) |
| Frontend indexing by raw `eth_getLogs` scans | OUT OF SCOPE (ops; mainnet gets an indexer) |
| LayerZero DVN/executor selection | adapters now set a delegate (v7), so the set CAN be chosen — and must be, at deploy time, per pathway and on both sides (§3). Until `endpoint.setConfig` is called the defaults apply. AUDIT SCOPE for mainnet config review |
| Raydium/Meteora venue adapter | does not exist yet; OUT OF SCOPE until written |
| Solana devnet deploy + live delivery | pending; everything local is test-proven |

## 12. Findings while specifying

Observations made while writing this spec from the code — none silently
papered over. Status after the v7 hardening chantier: **F-1, F-2, F-5, F-6
resolved; F-7 to F-10 found and resolved by that chantier; F-3 and F-4 are
Solana-side and remain open.**

- **F-1 — `gatewayChain` is write-only.** RESOLVED: removed. *(Original
  note:)* `SpawnPad.setGateway` populates
  `gatewayChain[gw]` (`SpawnPad.sol:150`) but no contract, script, test or
  frontend code reads it. Either remove it or document the intended
  consumer; unused reverse-mappings invite drift.
- **F-2 — SYNC/DELIVER ordering race on spawn with dev-buy.** RESOLVED on
  EVM: the gateway parks a DELIVER whose replica does not exist yet
  (`pendingDelivery`, claimed with `claimPending`) and a FEE_DROP likewise
  (`pendingFeeDrop`, flushed by the SYNC); tested with the mock endpoint
  delivering out of order. STILL OPEN on Solana (below). *(Original
  note:)* `_spawn`
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
  RESOLVED: asserted (`hardening.test.js`, "F-5"). *(Original note:)*
  When the curve caps a buy, the fee is recomputed as 1% of the actual
  spend (`SpawnPad.sol:312`) — the refund includes the fee difference.
  Intentional, but assert it in tests so a refactor doesn't flip it.
- **F-6 — `FeeDistributor.exclude` is assumed wire-up-only.** RESOLVED:
  `exclude` refuses while any share is live and `sealExclusions()` makes
  the set final (§8). *(Original note:)* Excluding an
  account that already holds shares leaves its shares counted
  (`handleTransfer` clamps decreases but never retro-syncs). The code
  comment states the assumption (`FeeDistributor.sol:61-62`); the admin
  threat model in §2 should cover a late `exclude` call.

Found by the hardening chantier's own revert audit, all RESOLVED there:

- **F-7 — the curve rounded in the trader's favour.** Both divisions in
  `InternalCurveVenue` floored, so a 1-wei token sell returned 1 wei of
  oUSD and a round trip could leave the pad a wei short of its own pots —
  after which the `bridgeBurn` paying the last seller (or, in v7, puller)
  of a token reverted on the message path. Now ceiling divisions; V1 is an
  exact, tested equality (§7, §9).
- **F-8 — the `FeeDistributor` 2^128 edge was a trap, not a curiosity.** A
  creator could make every later delivery of their token to a chain revert
  (1 wei of shares + one fee drop), stranding buyers' dollars in a curve
  the creator could then sell into from another chain. Closed by
  `MIN_SHARES`; a failing mint is also parked (§8, §4).
- **F-9 — an unvalidated `feeMode` stranded dev buys.** `spawnToken`
  accepted any `uint8`; the hub reverted on `> 3` forever, after the spoke
  had burned the dev buy. Now refused at the gateway and refunded by the
  pad (§4).
- **F-10 — a second `OP_SYNC_TOKEN` would have replaced a live replica.**
  The handler overwrote `replicaOf`; LayerZero delivers exactly once, so
  this needed a hostile or buggy hub — but the cost was every holder's bag
  on that chain. Now ignored.
