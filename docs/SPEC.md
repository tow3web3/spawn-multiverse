# SPAWN! protocol specification (v7.2)

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

Protocol version v7.1 (**a full redeploy of v7 from corrected sources; the
wire is unchanged again**). The v7.0 mainnet deployment was retired a few
hours after launch, holding only the project's own canary funds, because
deployed bytecode cannot be patched:
- *an unset peer is never a match* (F-11, §3) — the LayerZero adapter took a
  packet with an all-zero sender, from any chain it had never been told
  about, for a message from the hub. Fixed in the adapter, and the whole
  class (an UNSET storage value compared with an attacker-influenced input)
  was audited across every contract (§3, the class table);
- *one dead leg does not brick every launch* (F-12, §4) — a SYNC that cannot
  be sent is logged (`SyncFailed`) instead of undoing the spawn, and the
  operator re-sends it with `SpawnPad.resync`;
- *slippage protection where the hub answers in the same transaction* (§3) —
  `buyTokenUsdcMin`, `buyTokenMin`, `sellTokenMin` on the gateway: additive,
  no pad change, no wire change;
- *both vaults refuse a deposit that credited nothing* (`MIN_DEPOSIT`, §7).

Protocol version v7.2 (**a full redeploy once more — v7.1 never reached
mainnet. THE WIRE CHANGES: two new ops, 6 and 7; one more word in ops 2
and 3, the trader's minimum; one more word in the inter-adapter envelope,
the reply budget. Ops 1, 4, 5 and 10–13 are unchanged. The Solana codec
vectors were NOT regenerated and must be**).
The hub pad cannot be changed once deployed and a gateway is forever — and
so is the adapter under them (`messenger` is immutable in both) — so
what ONE universe on six chains needs from the hub goes in now: Base (the
hub) + Optimism + Arbitrum on Circle USDC, levelled with CCTP; Ethereum L1
on USDC, where a message costs L1 gas; BNB Chain on BSC USDT (18 decimals,
no Circle dollar, no CCTP); Solana, later. Chains open one by one.
- *anyone can bring a token to a chain* (§4) — `SpawnPad.resync` is payable
  and permissionless: the operator still sends it on the tank's account,
  anyone else attaches what the message costs;
- *one dear leg does not drain the tank* (§3, §4) — an operator-set ceiling
  per chain on the SYNC a spawn fans out (`syncCap`): above it that chain
  is skipped, like a dead leg, and the others are served;
- *a chain that was skipped is opened from that chain* (§4) — `OP_OPEN = 6`:
  `SpawnGateway.openToken` asks the hub for the replica and prepays the
  SYNC in its own coin;
- *a claim can leave a chain whose vault cannot pay it* (§4, §7) —
  `OP_MOVE = 7`: `SpawnGateway.moveClaim` burns oUSD on one chain and the
  hub forwards it as a PAYOUT to another — or sends it home;
- *the tank fronts nothing it was not paid for* (§3) — a message someone
  asked for (an open's SYNC, a move's PAYOUT) is sent only under a second
  ceiling per chain and per kind of message, `requestCap`, set to what such
  a request prepays;
- *the USDT vault mints no claim on demand* (§7) — `OmniUSDLocal`, now the
  spoke vault of BNB Chain inside the shared universe, has no `wrap`;
- *every trade can name its price, on every chain* (§3) — OP_BUY and
  OP_SELL carry a minimum and the hub enforces it where the price is: under
  it the trade does not happen and everything goes home. A cross-chain
  order is public minutes before it executes and anyone may deliver it;
  without this it could be sandwiched inside one hub-chain transaction;
- *a reply budget must arrive with its message* (§3) — the budget rides in
  the envelope and the receiving adapter refuses a delivery that brings
  less: nobody can make the tank pay for a reply by delivering a packet
  with nothing;
- *executor gas per kind of message* (§3) — `gasForOp` on the adapter: a
  buy no longer pays for a spawn's worth of hub gas, a payout to Ethereum
  no longer for a replica deployment's worth of L1 gas.

## 2. Actors and trust model

| Actor | Powers | Where |
|---|---|---|
| **admin** (mainnet: a `TimelockController`) | topology and custody — see the role table below | `Roles.sol`, every contract |
| **operator** (mainnet: the owner's Safe) | prices, limits, rebalancing, unpause | `Roles.sol`, every contract |
| **guardian** (a hot key) | pause | `Roles.sol`, every contract |
| **token creator ("dev")** | locks the fee mode at launch; claims the dev fee share from any chain | `SpawnGateway.sol:spawnToken/spawnTokenUsdc`, `SpawnPad.sol:_claim` |
| **trader / holder** | buy, sell, pull this chain's holder fees, claim holder dividends, claim a parked delivery — all on their own chain; wrap USDC → oUSD (USDC chains only) and unwrap; v7.2: open a token on a chain it never reached, move an oUSD claim to another chain | `SpawnGateway.sol:buyToken/buyTokenUsdc/sellToken/pullFees/claimPending/openToken/moveClaim`, `FeeDistributor.sol:claim`, `OmniUSD.sol:wrap/unwrap`, `OmniUSDLocal.sol:unwrap` |
| **anyone** (v7.2) | send a token's SYNC to a chain, by paying for the message on the hub | `SpawnPad.sol:resync` |
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
| | pad `resync(token, chain)` with NO value attached (v7.1) | re-sends a token's SYNC to one chain on the hub tank's account. Since v7.2 anyone else may call it too — by attaching what the message costs (§4) |
| | pad `setSyncCap(chain, cap)`, `setRequestCap(chain, op, cap)`; gateway `setOpenLegs` (≤ 8), `setMoveLegs` (≤ 4096); adapter `setGasForOp(chain, op, gas)` (v7.2) | prices again: what the tank may front for a message the pad is free to skip, what a user prepays for one, and how much executor gas each kind of message buys (§3) |
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
| | `resync` in a loop (v7.1) → the hub tank pays one message per call until it is empty and replies stall (retryable) | — | the same harm as a reply budget set too low; a SYNC moves no value and a gateway ignores a duplicate |
| | (v7.2) `setSyncCap` / `setRequestCap` to 1 wei → no launch reaches that chain, no open of it succeeds (the opener's fee is spent for nothing), every claim moved toward it comes home. Set huge → the tank is exposed to that chain's price again. `setMoveLegs(dst, 0)` closes moves from one chain to another; `setOpenLegs` / `setMoveLegs` set high over-charge whoever signs the quote | — | no value at risk: a SYNC that was skipped is sent by anyone's paid `resync` (no ceiling applies to it), a claim that cannot go on returns to its owner. But the `moveClaim` exit toward a chain is live only while the operator prices it — like every message-based exit already is, through `setDestination` |
| | (v7.2) `setGasForOp` too LOW → that kind of message runs out of gas on arrival and waits; too HIGH → whoever signs the quote pays the EXECUTOR for gas nobody uses (it is LayerZero's, not the tank's: unlike a reply budget set too high, the admin cannot `recover` it) | — | no bound in the contract: a `uint128`. Value is not lost — a delivery that ran out of gas is made again by anyone with more — but a user can be over-charged up to whatever they sign for. The quote is always what is charged |
| **admin** (the Safe proposes through the timelock) | nothing | **everything**: name an attacker as peer vault and have the operator rebalance into it; re-point a spoke's hub route to a forged adapter and send it `OP_PAYOUT`; add a gateway label that mints unbacked oUSD into the hub's books; `recover` every tank; sponsor a gateway; replace operator and guardian | the delay itself: each of these is a public `CallScheduled` event for 48–72 h, during which every exit stays open and the guardian can `cancel`. **The timelock buys users time to leave, not immunity** — a hostile admin whom nobody vetoes drains what is left |
| **deployer** (after the hand-over) | nothing | nothing | holds no role anywhere (asserted) |

Testnets run with all three roles on the deployer EOA — a configuration
value of `deploy-testnet.js`, not a code branch. **A deployment whose admin
is an EOA has no delay: its admin key is a drain key.**

### The v7.2 entry points — who can do what with them

| Entry point | A stranger | A user of a spoke | Operator | Guardian | A destination that fails |
|---|---|---|---|---|---|
| `SpawnPad.resync(token, chain)` payable | sends the SYNC of a REAL token to a chain that HAS a gateway, if `msg.value ≥` the adapter's quote; the whole value goes to the adapter, which pays the fee out of it — the tank ends ≥ where it started (to the wei on the mock). Cannot name a token the pad did not spawn or a chain without a gateway (`"PAD: unknown"`), cannot change what the SYNC says (it is rebuilt from the pad's own storage), cannot fork a token (a gateway ignores a second SYNC). Works while paused | — (a hub-chain call) | the same with no value: the tank pays, as in v7.1 | pays like a stranger | the call reverts with the leg's own error (`"LZM: no gas limit"`, …) — a user call, atomic, the value is not taken |
| `SpawnPad.setSyncCap` / `setRequestCap`, `LayerZeroOmniMessenger.setGasForOp` | `"ROLES: not operator"` | — | any value, any chain, any kind — see the table above | `"ROLES: not operator"` | — |
| `buyTokenUsdcMin` / `buyTokenMin` / `sellTokenMin` on a REMOTE gateway (v7.2: they used to revert there) | trades their own money with a minimum on the wire | the same. Cannot make the hub fill under the minimum (the venue reverts, the pad refuses); cannot strand anything with an absurd one (the largest number is refused like any other); cannot make someone ELSE'S trade fill under its minimum — but CAN make it bounce, by moving the price past its tolerance just before it lands: that costs the mover the price impact and two fees, and the victim one messaging fee and a retry | — | cannot stop a sell: the gateway's pause does not apply to it | the refusal's own reply is a reply like any other: prepaid, never skipped |
| `LayerZeroOmniMessenger.lzReceive` — i.e. anyone executing a verified packet through the endpoint | may deliver any verified packet, with any gas and any value. With less value than the envelope names: `"LZM: value"`, the packet stays deliverable. With too little gas: the delivery reverts as a whole (or, where a failed inner call is tolerated, the pad tells starvation from refusal — `"PAD: gas"`), and stays deliverable. With the right value and enough gas they have done the executor's job at their own expense. What they still choose is WHEN — which is what the minimum on the wire is for | — | — | — | — |
| `SpawnGateway.openToken` → `OP_OPEN` | on any chain where they hold its coin: asks for a token's replica THERE, only where none exists, prepaying `openLegs`. The hub sends the SYNC if the id is a token it spawned and the SYNC costs ≤ `requestCap` of that chain. Cannot create a replica of anything the hub did not spawn, cannot make the tank front more than `requestCap` | the same | sets `openLegs`, `requestCap` | a paused GATEWAY refuses opens; a paused PAD serves them | the hub logs `SyncFailed` and consumes the message — the fee is spent, nothing else was at stake |
| `SpawnGateway.moveClaim` → `OP_MOVE` | nothing without oUSD of their own on that chain: the gateway burns the CALLER's balance | moves their own claim to any chain the operator priced, for any recipient; pays the message and the hub's leg (`moveLegs[dst]`). Cannot move more than they hold, cannot reach the hub's own books, cannot make the hub pay out more than was burned (the amount is the gateway's, not theirs to state twice) | prices and thereby opens or closes each (source, destination) pair; sets `requestCap` | cannot stop it: neither the gateway's pause nor the pad's applies | the claim comes home: no gateway there, a recipient that chain cannot pay, a leg that cannot be priced or will not take the message, or costs more than `requestCap`. If the way home fails too, the inbound message reverts and LayerZero keeps it |
| a `SpawnGateway` itself (i.e. whoever can speak as one: its chain's adapter route, its verifier set) | — | — | — | — | **v7.2 widens this**: a forged `OP_MOVE` is a PAYOUT of any amount on ANY chain, where before v7.2 the hub only ever paid the chain a message came from. Every pathway's verifier set is now custody of every vault, directly (§11) |

The admin (the timelock) gains nothing here that it did not hold: it may
act as operator for each of these — free `resync`, the ceilings, the legs —
after its delay, like everything it does. It names the gateways, and a
gateway is what `OP_MOVE` trusts.

Trust chain for an inbound message (production transport):
1. endpoint authenticity — `lzReceive` requires `msg.sender == endpoint`
   (`LayerZeroOmniMessenger.sol:lzReceive`, `"LZM: not endpoint"`);
2. peer authenticity — packet's `origin.sender` must equal the peer adapter
   that was SET for that srcEid (`"LZM: not a peer"`). An eid with no peer
   matches nothing, not even a zero sender (v7.1, F-11 — §3);
3. source chain label derives from `origin.srcEid` via `labelOf`, never from
   message content (same function);
4. envelope authentication — the adapter refuses an envelope that names no
   source (`"LZM: no sender"`, v7.1), and the receiver checks the
   protocol-level sender: pad requires a non-zero `srcSender` equal to
   `gateways[srcChain]`
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
  mock charges a flat fee (+ optional per-byte, per-destination and
  per-unit-of-gas fees), honours the executor native-value option (the
  sender pays `value` on top; delivery hands it to the receiver's payable
  `lzReceive`), delivers with exactly the gas the options bought, and
  leaves a reverted delivery queued (retryable). Like the real endpoint it
  also lets anyone deliver a queued packet with a gas limit or a value of
  their choosing (`deliverAtWithGas`, `deliverAtWithValue`).
- `LayerZeroOmniMessenger` — production adapter, one per chain.

### Who pays (v7)

The rule: **whoever causes a message pays for it and for the replies it
triggers.** Nothing rides on charity, so nothing can be drained by spam.

- Every gateway entrypoint is `payable` and forwards `msg.value` to
  `messenger.send` with `returnLegs` = the replies the hub will send because
  of it: `tradeLegs` for a buy / sell / claim / fee pull (1 on a remote
  chain: the DELIVER, PAYOUT or FEE_DROP), `spawnLegs (+ tradeLegs with a
  dev buy)` for a spawn (the SYNC to every remote chain). Both are
  operator-set per gateway (`SpawnGateway.sol:setLegs`, capped at 4 and 128 —
  32 until v7.2)
  — budget multipliers, not hard message counts.
- The adapter requires `msg.value ≥ fee` unless the sender is `sponsored`
  (`"LZM: fee"`); a short fee reverts the user's whole transaction — nothing
  is burned or pulled (`transport.test.js`). Any surplus stays in the tank.
- The fee is `endpoint.quote(...)` for a packet whose executor option
  carries `returnUnit[dst] × returnLegs` of DESTINATION-chain native
  currency. The executor delivers that value into the remote adapter's
  payable `lzReceive`, i.e. into its balance — and since v7.2 the
  adapter REFUSES a delivery that brings less (below, "The budget must
  arrive").
- That balance is the adapter's **gas tank**. The pad never attaches value
  of its own: it is the one always-sponsored sender, and its replies are
  paid out of the hub tank — which was just topped up by the message being
  answered. With `returnUnit ≥` the real reply fee the tank never shrinks
  (asserted to the wei on the mock).
- **What the pad's own messages carry (v7.2).** A REPLY that takes a
  user's value home (DELIVER, the PAYOUT of a sale or a claim, FEE_DROP,
  a claim sent back) passes `returnLegs = 0`. A message the pad is free to
  skip — a SYNC at spawn, on an open or a resync, the PAYOUT a move
  forwards — passes **1**: one `returnUnit[dst]` of the DESTINATION's
  coin, taken from the HUB adapter's table. These are the messages that
  make their destination create something for someone who may never have
  been there: a replica, an account for the recipient of a moved claim.
  On an EVM chain that costs gas and nothing else; on Solana it costs
  rent (0.00274 SOL for a replica's accounts, 0.0019 SOL for a
  recipient's), and a message arriving with no lamports would draw it
  from a tank over there that nobody funds — and that anyone could spend,
  from any chain, by launching or by moving a micro-dollar to a fresh
  address. With the leg, the message brings what it costs; the quote
  includes it, so the ceilings bound it and whoever caused the message
  prepaid it through the existing prices.
  **THE RULE THE TOOLING MUST CHECK:** on the hub adapter `returnUnit` is
  0 for every EVM destination, the hub chain's own gateway included, and
  set only for a chain that charges for accounts. (`returnUnit[0]` there
  is a different thing: what users of the hub chain's gateway prepay per
  leg; the pad never sends to label 0.) A unit on an EVM label is tested
  to break exactly what one would expect: on the hub chain's label a move
  toward it no longer fits under its zero ceiling and comes home, and a
  resync toward it stops being free; on a remote EVM label every SYNC
  makes a gift of that unit to the spoke's tank out of the hub's.
- `SpawnGateway.quoteBuy / quoteSell / quoteClaim / quotePull /
  quoteSpawn(name, symbol, metaURI, withDevBuy)` return the exact fee before
  signing. Trade payloads are fixed-size; a spawn's fee depends on its
  strings, so its quote takes them.
- (v7.2) Two actions are answered by a message that is NOT a trade's
  reply, and are priced on their own:
  - `openToken` prepays `openLegs` units — the SYNC the hub sends back to
    this chain (`quoteOpen()`). A fresh gateway has `openLegs = 1`, not 0:
    on a remote chain an open that prepaid nothing would be the hub tank's
    to pay, and anyone could ask for one. The hub chain's own gateway is
    set to 0 (its SYNC is a local call). Capped at 8.
  - `moveClaim` prepays `moveLegs[dstChain]` units — the PAYOUT the hub
    carries to ANOTHER chain, priced per destination in the SOURCE chain's
    reply units (`quoteMove(dstChain)`); never fewer than `tradeLegs`,
    which pays for the way home if the hub has to return the claim; 0 = no
    price = that destination is refused (`"GW: route closed"`). Capped at
    4096: an L1 seen from an L2 costs hundreds of the L2's units.
    `tradeLegs` could not serve here — it is 0 on the hub chain's own
    gateway and priced on a reply to the source everywhere else (F-14).
- (v7.2) The pad forwards value in exactly one place: `resync` hands its
  caller's whole `msg.value` to the messenger (§4). Everywhere else it
  still attaches nothing and passes `returnLegs = 0`.
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

### The budget must arrive (v7.2)

`EndpointV2.lzReceive` is permissionless and payable: once a packet is
verified, ANYONE may execute it, with whatever gas and whatever
`msg.value` they like. The executor's option is what the sender paid for;
the endpoint does not insist on it. Until v7.2 the adapter took what came.
So the sender of a message — or anyone watching the chain — could deliver
a hub-bound packet themselves with no value, and the tank paid the reply
out of its float. It cost them at least what it cost the tank; but a tank
is a few dollars of float, an empty one stalls EVERY reply of EVERY user
(retryable, but stalled), and a few dollars is cheap for that.

The budget now rides inside the message: the envelope's last word is the
value the sending adapter put in the executor option
(`LayerZeroOmniMessenger._packet`: one variable, written twice), and
`lzReceive` requires `msg.value >= value` (`"LZM: value"`). A delivery
that brings less reverts and the packet stays deliverable — by the
executor, or by anyone who attaches the budget, in which case they have
paid for the reply themselves. The hub's own messages carry 0 and are
unaffected; the loopback already required its budget in the same
transaction. Asserted (`v72-wire.test.js`): a BUY, a spawn with five
legs, a move and an open are each refused with a wei less than they
carry, the tank and the books do not move, and the same packet lands once
the value comes with it.

What this rests on, and has NOT been observed on a live network: that
LayerZero's executor calls `lzReceive` with exactly the option's value.
It is what the option is for, and the mock does it; a testnet round trip
must confirm it before mainnet — if an executor ever delivered short,
messages would wait for a manual delivery instead of draining the tank.

### What the tank fronts, and its two ceilings (v7.2)

Every reply is prepaid by its cause — at the price the operator last set.
Between that and the price the hub pays when the reply leaves, the tank
carries the difference. For a reply that carries a user's value home there
is no choice: it is sent, and a budget set too low drains the tank (the
liveness model of §11). For a message the pad is FREE TO SKIP there is a
choice, and v7.2 makes it (`SpawnPad._within`, `_trySend`):

| Message | Who prepaid it | Ceiling (hub-native wei, operator-set) | Above it |
|---|---|---|---|
| a token's SYNC in a spawn's fan-out | the launcher, in ANOTHER chain's units (`spawnLegs`) | `syncCap[chain]`; 0 = none, and no quote is made | `SyncFailed`, the spawn goes on |
| the same SYNC toward the chain the spawn came FROM | the launcher, in that chain's OWN units | the larger of `syncCap[chain]` and `requestCap[chain][10]` — and none where `syncCap` is 0 | `SyncFailed`; a dev buy's bag is then parked on that chain until the token is opened there (§4) |
| the SYNC of an `OP_OPEN` | the opener, in that chain's own units (`openLegs`) | `requestCap[chain][10]` (10 = OP_SYNC_TOKEN); always quoted, so 0 lets through only a leg that costs nothing | `SyncFailed`, the message is consumed |
| the PAYOUT an `OP_MOVE` forwards | the mover, in the source chain's units (`moveLegs[dst]`) | `requestCap[dstChain][12]` (12 = OP_PAYOUT), the same rule | the claim goes home (a reply, prepaid by the same legs) |
| `resync` | its caller, in full, on the hub — or the operator's own decision | none | — |

The second row is what lets a chain that is left out of every launch still
launch for itself: its launcher prepaid at its own price, exactly like an
opener (tested: a launch FROM the dear chain gets its replica and its dev
buy there, and the tank comes out ahead; at a spike it does not).

Why two. `syncCap` is a POLICY on launches — two policies, in fact. Set a
little above a chain's ordinary price it only cuts off the spikes; set
below it, it leaves that chain out of every launch, to be opened token by
token. Which one suits Ethereum is the operator's call: measured on forks,
a SYNC toward Ethereum costs 0.00104 ETH against 0.00013–0.00017 toward
the other chains, and a spoke's reply unit is 0.0001–0.00015 ETH, so a
launch that reaches Ethereum prepays 15–30 of its origin's legs — at the
edge of the 32 that `spawnLegs` was capped at, which is why the cap is 128
since v7.2. `requestCap` is SOLVENCY: set to what an open or a move toward
that chain prepays, the tank never fronts more than a request brought,
whatever the price does between the user's quote and the hub (F-15, §12).
It defaults to 0: a remote chain is closed to opens and to incoming moves
until the operator prices it; the hub chain's own gateway needs none, its
leg costs nothing.

**Per kind of message** (`requestCap[chain][op]`, `setRequestCap(chain,
op, cap)`; the pad reads keys 10 and 12 and no other). One ceiling per
chain was enough while a SYNC and a PAYOUT toward a chain cost the same.
With executor gas per kind (below) they do not — a replica deployment
against a payout, five to one on an L1 — and a single ceiling would have
to sit at the SYNC's price: every move would then be covered several times
over what it prepaid, i.e. the spike drain of F-15 again, for moves, up to
that multiple (F-21). It also gives the hub ONE switch for "no more claims
into this chain" that leaves everything else open — `setRequestCap(chain,
12, 0)` — which is the fast brake on the USDC → USDT channel of §7.

Asserted on the mock (`v72.test.js`), with a leg ten times dearer than the
others: without a ceiling a launch from Optimism takes `3·fee + 10·fee −
4·unit` out of the tank; with `syncCap` the same launch skips that chain
and the tank GROWS by `4·unit − 3·fee`; an open from the dear chain adds
its own unit and spends the dear fee (a positive margin); under a 5× price
spike the open is not sent and the tank keeps what it prepaid, while a
stranger's `resync` at the spike price leaves the tank unchanged to the
wei; and a move adds one unit and spends at most one fee for each of the
twenty (source, destination) pairs, the hub chain's own gateway included.

### Per-destination options

`setDestination(label, gas, unit)` replaces the old global options blob.
Each send builds a type-3 option list with one executor lzReceive option:
`0x0003 | 0x01 | uint16 size | 0x01 | uint128 gas [| uint128 value]` — 17
bytes of option (22 in total) when no reply is prepaid, 33 (38 in total)
with `value = returnUnit × returnLegs` (`_packet`). A destination without a
gas limit is refused (`"LZM: no gas limit"`).

**Gas per kind of message (v7.2).** `gasLimit[dst]` is one number per
destination, so it must cover the dearest message that chain ever
receives: toward the hub the worst-case spawn (5M with four remote
chains), toward a spoke a replica deployment — and every buy pays for 5M
of hub gas, every DELIVER and PAYOUT to Ethereum for a deployment's worth
of L1 gas, five times what it uses. `gasForOp[dst][op]` (operator,
`setGasForOp`) overrides the limit for one kind of message; 0 = the
chain's limit. The op is the first word of every protocol payload
(`abi.encode(uint8 op, bytes data)`), read as the last byte of that word;
a payload shorter than a word has none. `quote` and `send` build the
packet with the same function, so the quote is what the send requires
(tested with a price per unit of gas on the mock: the quote of a buy
falls by exactly the gas it no longer buys, a sell and a spawn are
unchanged, the option on the wire carries the override, and the message
lands inside it). `gasLimit[dst] = 0` still closes a destination whatever
is set per op — it stays the operator's switch for a leg.

**What the option is, and is not.** It is what the HONEST executor
delivers with, and what the user pays for. It is not a promise to the
receiver: anyone may deliver a verified packet with any gas. Nothing in
the pad or a gateway relies on it. A delivery that runs short reverts as
a whole and stays deliverable (tested: a BUY sold 60k of gas waits, and
lands when anyone delivers it with more). Where a failed inner call is
TOLERATED, gas could otherwise choose the outcome, and each such place is
closed by construction or by the pad's floor (§4, "Two properties of the
`try` blocks") — swept in tests for every one: a spawn, an open and a
move (`"PAD: gas"`), a buy and a sell against the venue (never refused for
want of gas), a DELIVER and a FEE_DROP on a spoke (never parked for want
of gas). One sizing rule follows for the operator: a kind of message that
may meet a refusing leg (SPAWN, OPEN, MOVE toward the hub) must be sold
200,000 gas more than its failure path uses (the pad's floor, §4), or the
honest executor's own delivery reverts `"PAD: gas"` where the leg had
simply said no — and waits for someone to deliver it with more. The least
gas such a delivery lands with, on the mock: an open answered 0.24M,
refused 0.29M; a move forwarded 0.10M, refused and sent home 0.28M (on a
fork an open measured 0.55M before the floor was raised: real quotes and
sends cost more than the mock's quote and less than its send).

Gas actually used by `lzReceive`, measured on the mock endpoint (which
itself burns ~0.52M per `send` it stores, against ~0.2M for the real
endpoint — hub figures are therefore pessimistic):

| Op (where it lands) | Gas used | Budget in deploy config |
|---|---|---|
| OP_SPAWN (hub), 5 remote SYNCs and a dev buy | 4.59M on the mock ≈ 1.4M of protocol work + one send per remote chain + the DELIVER (≈ 0.52M each on the mock). v7.1 measured 4.546M on the same test; v7.2's first round 4.560M (under 3k per chain of the fan-out); its second 4.592M (about 5k more per message SENT: one storage read for the gas of that kind of message, and on the mock one more word of envelope to store) | 4M to the hub |
| OP_SPAWN (hub), v7.2 worst case: the largest spawn a gateway admits (64 + 16 + 1,024 bytes of strings, a dev buy), FOUR remote chains and the hub chain's own replica | **4.973M** with no ceiling; **4.985M** with a `syncCap` on one chain that is under it (+0.011M: one quote); **4.435M** with that chain over its ceiling (−0.538M: one send less); 5.021M with a ceiling on all four | 6M on the mock; real: `hubGasFor` |
| OP_BUY / OP_SELL / OP_PULL_FEES (hub), incl. one reply send | 0.260M / 0.220M / 0.151M (v7.1: 0.256M / 0.214M / 0.145M — the minimum on the wire costs a few hundred gas, the rest is the per-send cost above) | 4M to the hub — or its own, smaller budget (`gasForOp`) |
| OP_OPEN (hub), v7.2 — one quote, one SYNC send | 0.25M | 4M to the hub |
| OP_MOVE (hub), v7.2 — forwarded to a remote chain (one quote, one send) / to the hub chain's own gateway (one quote, the payout itself) / turned back | 0.12M / 0.12M / 0.10M | 4M to the hub |
| OP_SYNC_TOKEN (spoke — a replica deploy) | 0.72M | 2M to a spoke |
| OP_DELIVER / OP_PAYOUT / OP_FEE_DROP (spoke) | 0.15M / 0.10M (0.07M for a claim on an empty vault) / 0.13M | 2M to a spoke |

(`PRINT_GAS=1 npx hardhat test --grep "executor gas"` reprints these.)

What the mock does not tell, against what forks of the five chains
measured through the real EndpointV2. A real send costs 0.21–0.28M gas;
the mock's costs 0.52M when it stores a fresh packet and next to nothing
when the reply reuses the slots the delivered packet just freed — which
is why a BUY or a MOVE reads 0.1–0.26M here. A real quote costs
0.12–0.23M; the mock's about 10k (every chain with a `syncCap`, every
open and every move pays one). Net, the mock is PESSIMISTIC for a spawn:
the worst case above with a ceiling on all four chains is 4.52M on a
fork (first-round contracts) against 5.02M here. The executor gas the
tooling buys comes from the fork figures, not from this table.

Executor gas is nearly free on L2 destinations (≈ destination gas price ×
gas — see MAINNET-ADDRESSES.md) and anything but free on Ethereum. Until
v7.2 it was one number per destination, so a trade toward the hub bought
the same 4M as a spawn and a payout to a spoke the same as a replica
deployment; `gasForOp` (above) prices each kind on its own.

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

### A minimum for every trade, on every chain (v7.1 locally, v7.2 on the wire)

A plain buy or sell names no price: it takes whatever the curve gives when
it executes. On the hub chain that is the usual mempool sandwich (early in
a curve a $300 buy moves the price ~10%; `v71.test.js` shows the attack
netting a profit after fees). Across chains it is worse, and v7.1 could
not close it: a cross-chain order is PUBLIC on its source chain minutes
before it executes on the hub, and anyone may deliver it (`lzReceive` is
permissionless). So the whole sandwich fits in ONE hub-chain transaction,
with no race and no risk: buy on the hub chain's own gateway (settled at
once), deliver the victim's packet at the price just moved, sell. On a
fresh curve a $1,000 buy from another chain, delivered between a $6,000
buy and its sale, got 27% of the tokens it should have — the attacker
kept over $600 after fees (`v72-wire.test.js` runs it, with a contract
that does it in one transaction; a sell is robbed the same way: paid a
third of what its bag was worth). Five of the six chains trade this way.

**v7.2: the minimum rides the wire and the hub enforces it.** OP_BUY and
OP_SELL carry a fourth word (§4): `minTokensOut`, or `minUsdOut` — what
the seller is PAID, net of the fee, 18 decimals. 0 = none. The check is in
the VENUE, where the price is (`ICurveVenue.execBuy(token, usdIn, minOut)`,
`execSell(token, tokensIn, minOut)`: revert `"VENUE: min out"` before any
state changes), so the pad needs no new path — its existing refusal does
the rest (`Refused`, reason 6):

- a buy under its minimum: the genesis accounting is undone, nothing is
  booked, and the WHOLE `usdIn` rides home in the DELIVER — as dollars if
  that vault holds them;
- a sell under its minimum: the bag the spoke burned is delivered back;
- **all or nothing**: a fill cut down by FAIR GENESIS, or by the end of the
  curve, is under the minimum and bounces whole. So does a buy landing in
  the launch block or on a paused hub (nothing bought);
- the seller's NET minimum is turned into the venue's GROSS one exactly:
  with the fee floored, `net(g) = g − ⌊g/100⌋`, and the smallest `g` whose
  net reaches `n` is `n + ⌊(n−1)/99⌋` (`SpawnPad._sell`). Exact matters: a
  seller who names the very amount the sale would pay must be served — a
  conversion rounded the easy way (`n + ⌊n/99⌋`) refuses one sale in a
  hundred at its own price (tested on such a sale) — and is never paid a
  wei under what they named. A minimum too large to convert becomes the
  largest number there is, not an overflow: a revert there would strand
  the bag (tested with `2^256 − 1` and its neighbours);
- the dev buy inside a spawn names none (it is the first trade of a curve
  created one line above).

The same sandwich against an order with a minimum 1% under its fair fill:
the victim's trade is refused inside the attacker's own transaction, the
attacker has bought and sold into nobody and is out two fees ($119 on
$6,000), and the victim has every dollar — or the whole bag — back.

**The three gateway functions** keep their v7.1 signatures and now work on
every chain. A minimum of 0 is refused (`"GW: zero min"`): it would be the
unprotected function under another name.

| Function | Does exactly what | Where the hub answers in the same transaction | On a remote chain |
|---|---|---|---|
| `buyTokenUsdcMin(hubToken, usdcIn, minTokensOut)` | `buyTokenUsdc`, with the minimum on the wire | also requires the caller's replica balance to have risen by ≥ `minTokensOut`, or reverts `"GW: min out"` | returns once the message is sent; the hub fills at the minimum or sends the dollars home |
| `buyTokenMin(hubToken, usdIn, minTokensOut)` | `buyToken` (oUSD already held), same | same | same |
| `sellTokenMin(hubToken, tokens, minDollarsOut)` | `sellToken` (ignores the pause, like every exit), same | also requires what the caller holds in this chain's dollars — dollar token × `SCALE` plus oUSD claims, 18 decimals — to have risen by ≥ `minDollarsOut` | returns once the message is sent; the hub pays at least the minimum or delivers the bag back |

"Where the hub answers in the same transaction" is what the messenger says
(`IOmniMessenger.isLocal(HUB_CHAIN)`: true on the hub adapter, whose label
0 is a loopback, and on the simulated transport; false on a spoke adapter,
which can never be told otherwise — a routed label cannot be made local).
There the call behaves exactly as in v7.1: the whole transaction unwinds
— deposit, burn, curve trade and reply together — whenever the caller's
BALANCE did not rise by the minimum: a trade the hub refused, a delivery
the gateway had to park, a sell paid in tokens because the venue refused
it. A sell paid as an oUSD claim because the vault is short COUNTS: the
claim is the payout (§7). A wallet sees the failure in simulation, and the
launch canary proves that revert. The plain functions put a zero on the
wire.

Limits, stated plainly:
- **on a remote chain the protection is a refusal, not a revert.** The
  caller parts with their dollars (or their bag) for the minutes the round
  trip takes and gets them back by the reply; the messaging fee is spent.
  Someone who wants an order NOT to fill can make it bounce by moving the
  price past its tolerance just before it lands — at the cost of that
  move and two fees to them, one messaging fee and a retry to the victim;
- the refusal says "the market would not fill it" (`Refused`, reason 6) —
  the same reason as dust: the pad does not tell the two apart;
- the buy check counts tokens only; the refund of a buy the curve capped
  is not part of it (it is the caller's own dollars coming back);
- no deadline argument: an order that waits is bounded by its minimum, not
  by time;
- on the local path the minimum is held twice, by the hub and by the
  balance check. They agree to the wei on a sale that is paid; the balance
  check is the stricter one (a parked delivery fails it), and no minimum,
  however large, is an arithmetic overflow there (`"GW: min out"`);
- reentrancy is unchanged: the three are `nonReentrant` user entrypoints,
  the loopback still re-enters `onOmniMessage` (which is not), and a dollar
  token with a transfer hook cannot call back into any guarded function
  during the deposit or the payout (`v71.test.js`, with a hooked token).

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

**Envelope (v5; one more word in v7.2).** Between adapters every LZ
message body is `abi.encode(bytes32 srcSender, bytes32 dstAddr, bytes
payload, uint256 value)` (`LayerZeroOmniMessenger.sol:_packet`) — `value`
is the reply budget the message must arrive with, the same number as in
its executor option ("The budget must arrive", above); 0 on everything the
hub sends. The receiving EVM adapter downcasts only the local target
(`"LZM: bad target"`, `lzReceive`), passes `srcSender` wide and requires
`msg.value ≥ value`. The Solana program must encode and decode the same
four fields, in canonical form, and enforce the same rule on what it
receives; `msg_codec.rs::Envelope` and the `envelopes` section of
`solana/tests/codec-vectors.json` are still the three-field shape of v5 —
**to be regenerated**. (A three-field envelope is not rejected for its
shape — ABI decoding does not insist on canonical offsets — it reads as
one whose budget is the length of its payload in wei, and is refused for
not bringing it. Pinned by a test so that nobody mistakes it for a
check.)

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

### A peer is a SET peer (v7.1, F-11)

`lzReceive` and `allowInitializePath` used to test
`peers[origin.srcEid] == origin.sender` and nothing else. For every chain
the adapter was never told about, `peers[eid]` is `bytes32(0)` — and
`labelOf[eid]` is `0`, which is the HUB's label. So a packet whose sender is
`bytes32(0)`, from ANY unconfigured eid, passed the peer check and was
handed to its target as `(srcChain 0, srcSender <taken from the message
body>)`. A gateway authenticates the hub by exactly those two values: a
forged `OP_PAYOUT` emptied a vault (`v71.test.js` replays it against a
frozen copy of the v7.0 adapter, `mocks/LayerZeroOmniMessengerV70.sol`).

What it made custody depend on. No user can send such a packet: on an EVM
chain the sender of a LayerZero packet is a contract address, never zero.
It takes LayerZero itself delivering one — and for a pathway the adapter
never configured, what decides that is LayerZero's DEFAULT receive library
and DEFAULT verifier set for that source chain (including chains added
after deployment), plus any source chain where an OApp may carry the
all-zero address. The whole point of pinning our own libraries and
verifiers per pathway (§3 "DVN configuration") is that custody rests on
that choice. With this bug it rested on the weakest default of any chain
LayerZero supports, now or later, and on LayerZero's governance over
defaults. A standard OApp is immune: LayerZero's `OAppReceiver.lzReceive`
compares the sender with `_getPeerOrRevert(srcEid)`, which reverts
`NoPeer` for an unset peer.

v7.1: `_isPeer(srcEid, sender)` = the peer is non-zero AND equals the
sender, used by both functions; the envelope must also name a non-zero
source (`"LZM: no sender"`). Deployed bytecode cannot be patched and an
adapter cannot be swapped under a pad or a gateway (`messenger` is
immutable in both), so the fix required a full redeploy — done while the
v7.0 deployment held nothing but the project's canary funds.

**The class, audited across every contract** — an UNSET storage value
(zero address, `bytes32(0)`, label 0, eid 0) that can equal an
attacker-influenced input:

| Site | The unset value | Compared with | v7.0 | v7.1 |
|---|---|---|---|---|
| adapter `lzReceive`, `allowInitializePath` | `peers[eid] == 0` | the packet's `origin.sender` | **exploitable**, given a delivered zero-sender packet | **fixed** — `_isPeer` |
| adapter `lzReceive`, the label handed on | `labelOf[eid] == 0` = the hub's label | derived, not compared | what turned the above into a hub impersonation | unreachable — only read for a set peer (on a spoke, label 0 IS the hub route's label, legitimately) |
| adapter `lzReceive`, the envelope | — | `srcSender` from the message body | reachable only from a set peer | **fixed (explicit)** — `"LZM: no sender"` |
| pad `onOmniMessage` | `gateways[0]` (can never be set), `gateways[unwired] == 0` | `srcSender` | reachable-but-harmless: (chain 0, sender 0) passed the check and only reverted later, by luck, when the reply targeted `address(0)` | **fixed** — a zero `srcSender` is never a gateway |
| gateway `onOmniMessage` | `pad` (immutable; could be constructed as 0) | `srcSender` | unreachable in any real deployment | **fixed** — the constructor refuses a zero pad, a zero messenger and label 0 (`"GW: zero address"`, `"GW: hub label"`) |
| adapter `send`, loopback source | `labelOfSender[x] == 0` for an unregistered `x` — the hub's label | — | unreachable: `senders[msg.sender]` is checked first, and the target must be a registered contract of the destination label | unchanged; `register(address(0))` now refused (`"LZM: zero sender"`) |
| adapter `_packet` | `eidOf`, `peers`, `gasLimit` | — | explicit (`"LZM: no route"`, `"LZM: no gas limit"`) | unchanged |
| `LocalOmniMessenger` | `chainOf[x] == 0` | — | explicit (`registered` checked first, on both ends) | unchanged |
| pad `_known` | `metas[token].spawnedAt == 0` | a token id from a message | explicit | unchanged |
| pad `_claim` | `metas[token].creator` | `claimer` | unreachable: the token is known, so its creator was stored at spawn from a gateway's `msg.sender`; a zero creator needs a faulty gateway | unchanged (documented) |
| pad `setGateway`, `resync` | `gateways[chain] == 0` | — | explicit | explicit |
| gateway | `replicaOf[token] == 0`, `distributor == 0` | a token id from a user or from the hub | explicit everywhere: refused at entry, parked on the message path | unchanged |
| `OmniUSD`, `OmniUSDLocal`, `FeeDistributor`, `SpawnToken`, `InternalCurveVenue`, `Roles` | `agent`, `controller`, `pad`, `pendingAdmin`, `operator`, `guardian` unset | `msg.sender` | unreachable: `msg.sender` is never the zero address in a transaction | unchanged |
| `OmniUSD` | `peers[label].vault == 0`, `tokenMessenger == 0` | a label from the operator | explicit (`"oUSD: no peer"`, `"oUSD: no CCTP"`) | unchanged |
| `OmniUSD`, `OmniUSDLocal` | `depositCap == 0` | — | fail-closed by design (deposits shut until opened) | unchanged |
| `FeeDistributor` state keyed by `msg.sender` | zero `magDPS` / shares for any caller | a rogue "token" contract | reachable-but-harmless: it can only write its own key, and `magDPS` stays 0 without a drop from the agent, so nothing is claimable. It can raise the global `liveShares`, which only blocks the admin's wire-up-only `exclude` before the set is sealed | unchanged (documented) |
| `InternalCurveVenue` | `_curves[token].vTokens == 0` | a token from the pad | explicit (`"VENUE: unknown token"`, `"VENUE: market open"`) | unchanged |

Not this class, but the same shape of default worth knowing: an operator
who never calls `setLegs` on a REMOTE gateway leaves `tradeLegs = 0`, i.e.
its users prepay no reply and the hub tank pays them. The deploy script
sets the legs and its self-check reads them back; the contract does not
enforce it.

The class in v7.2's own additions — each default chosen so that UNSET means
closed, or means what it meant before:

| Site | The unset value | What it means |
|---|---|---|
| pad `_move` | `gateways[dstChain] == 0` for a destination a USER names | explicit: refused before any send, the claim goes home (F-16 — with a route already on the adapter the send would have succeeded, to nobody) |
| pad `_move` | `to == 0` | explicit: goes home (the gateway refuses it at entry too) |
| pad `requestCap[chain][op] == 0` | no price for that kind of request | closed: only a leg that costs nothing passes. A key the pad never reads (any `op` but 10 and 12) is inert |
| pad `syncCap[chain] == 0` | no ceiling | open, deliberately: the fan-out behaves as in v7.1 |
| gateway `moveLegs[dst] == 0` | no price | closed (`"GW: route closed"`) — also what refuses a destination that does not exist |
| gateway `openLegs` | starts at 1, not 0 | an open prepays one leg unless the operator says otherwise (the hub chain's gateway is set to 0) |
| pad `resync` | `operator == 0` (never named) | nobody but the admin sends for free; everyone else pays |

## 4. Message catalog — the single source of truth

Envelope payload = `abi.encode(uint8 op, bytes data)`; `data` per op below.
All tuples use canonical ABI encoding; every account rider is `bytes32`.
"wide ok" = the value may be a non-EVM identity and is never downcast on
that path; "downcast" = checked 20-byte downcast, top-12-bytes-zero or
revert (`SpawnPad.sol:_addr` → `"PAD: bad recipient"`,
`SpawnGateway.sol:_addr` → `"GW: bad recipient"`).

| Op | Name | Direction | Wire tuple (`data`) | Trigger | Effect on receive |
|---|---|---|---|---|---|
| 1 | OP_SPAWN | gateway → pad | `(bytes32 creator [wide ok], string name, string symbol, string metaURI, uint256 devBuyUsd, uint8 feeMode)` | `SpawnGateway.spawnToken` (burns dev-buy oUSD first) or `spawnTokenUsdc` (v7: pulls dev-buy USDC into the vault via `OmniUSD.depositFor`) — same message. The gateway first refuses what the hub would: `feeMode > 3` (`"GW: bad fee mode"`), name > 64 / symbol > 16 / metaURI > 1024 bytes (`"GW: string too long"`), a paused gateway (`"GW: paused"`), and (v7.1) an oUSD dev buy under 1e12 wei (`"GW: dust"`) | `SpawnPad._spawn`: deploy hub `SpawnToken` (premint 1B to pad, reporting to no distributor), store `Meta` (creator stays wide), `venue.openMarket`, emit `Spawned`, send OP_SYNC_TOKEN to **every** registered chain — each send under `try` (v7.1): one that fails emits `SyncFailed(token, chain)` and the spawn goes on; a chain with a `syncCap` is quoted first and skipped the same way above it (v7.2) — then optional dev-buy via `_buy`. **Refused** (no token; a dev buy goes home by OP_PAYOUT) when the pad is paused or `feeMode > 3` |
| 2 | OP_BUY | gateway → pad | `(bytes32 token [downcast], bytes32 buyer [wide ok], uint256 usdIn, uint256 minTokensOut)` — **the fourth word is new in v7.2**; 0 = no minimum | `SpawnGateway.buyToken` (burns buyer's oUSD; ≥ 1e12 wei, `"GW: dust"`) or `buyTokenUsdc` (v7: pulls USDC into the vault; the vault refuses a deposit that credited less than 1e12 oUSD wei, `"oUSD: dust"`, v7.1) — both with `minTokensOut = 0` — or their `…Min` twins, which carry the caller's minimum (v7.2: on every chain, §3). All first require a local replica (`"GW: unknown token"`), so a BUY for a token the hub never spawned cannot leave the chain | `SpawnPad._buy`: genesis gate, fee off the top, `venue.execBuy(token, usd, minTokensOut)`, mint `spend + fee` into the hub's books, burn hub tokens, `supplyByChain[src] += out`, send OP_DELIVER (tokens + refund), emit `Trade`, `_accrueFee`. **Refused** — whole `usdIn` refunded — when the pad is paused or the venue refuses, which now includes a fill under `minTokensOut` (via OP_DELIVER, `out = 0`), or the token id is wide/unknown (via OP_PAYOUT) |
| 3 | OP_SELL | gateway → pad | `(bytes32 token [downcast], bytes32 seller [wide ok], uint256 tokensIn, uint256 minUsdOut)` — **the fourth word is new in v7.2**: what the seller must be PAID, net of the fee, 18 decimals; 0 = no minimum | `SpawnGateway.sellToken` (burns seller's replica; ≥ 1e12 wei, `"GW: dust"`; `minUsdOut = 0`), or `sellTokenMin` with the caller's minimum (v7.2: on every chain, §3). Never paused | `SpawnPad._sell`: turn `minUsdOut` into the smallest gross that nets it (§3), `venue.execSell(token, tokens, minGross)`, mint tokens back to pad custody, `supplyByChain[src] -= tokensIn`, 1% fee, burn net oUSD, send OP_PAYOUT, emit `Trade`, `_accrueFee`. **Refused** when the venue will not price it, or not at the seller's minimum: the bag goes back by OP_DELIVER |
| 4 | OP_CLAIM | gateway → pad | `(bytes32 token [downcast], bytes32 claimer [wide ok])` | `SpawnGateway.claimFees` (requires a local replica). Never paused | `SpawnPad._claim`: pay `dev − devClaimed` via OP_PAYOUT to the claim chain, emit `DevClaimed`. **Refused** (no reply) when `claimer` is not the creator (wide comparison) or nothing is accrued |
| 5 | OP_PULL_FEES (v7) | gateway → pad | `(bytes32 token [downcast])` | `SpawnGateway.pullFees` — anyone, for any token with a local replica; prepays `tradeLegs`. Never paused | `SpawnPad._pull`: split any pot not split yet, then send `OP_FEE_DROP(token, pendingDrop[token][src])` to the source chain and zero it, emit `FeesPulled`. **Refused** (no reply) when nothing is waiting or the token is unknown |
| 6 | OP_OPEN (v7.2) | gateway → pad | `(bytes32 token [downcast])` | `SpawnGateway.openToken` — anyone, for a hub token id that has NO replica on this chain (`"GW: already open"`); prepays `openLegs`. Refused by a paused gateway (`"GW: paused"`) | send that token's OP_SYNC_TOKEN to the SOURCE chain if it costs the tank no more than `requestCap[src][10]`, emit `Resynced`; otherwise — the leg refuses, cannot be priced, or is above the ceiling — emit `SyncFailed`, no revert. **Refused** (`Refused`, reason 2, no reply) for an id the pad never spawned. Ignores the pad's pause |
| 7 | OP_MOVE (v7.2) | gateway → pad | `(bytes32 from [wide ok], bytes32 to [wide ok — see §5], uint256 amount, uint32 dstChain)` | `SpawnGateway.moveClaim` — burns `amount` (≥ 1e12 wei, `"GW: dust"`) of the caller's oUSD; `to ≠ 0`, `dstChain` neither this chain nor label 0 (`"GW: bad destination"`), and a destination the operator priced (`"GW: route closed"`); prepays `moveLegs[dstChain]`. Never paused | `SpawnPad._move`: forward `OP_PAYOUT(to, amount)` to `dstChain`, or — no gateway there, `to` is zero, `to` is not shaped like an account of the destination (an address for an EVM gateway, a 32-byte key for a wide one — §5), the leg (with the one unit of native value it carries, §3) costs more than `requestCap[dst][12]`, cannot be priced or will not take the message — send `OP_PAYOUT(from, amount)` back to the source. Emits `Moved(src, dst, from, to, amount, forwarded)`. The hub's own books are not touched. Ignores the pad's pause |
| 10 | OP_SYNC_TOKEN | pad → gateway | `(bytes32 token [downcast on EVM spokes; raw 32-byte seed on Solana], string name, string symbol)` — sent with one `returnUnit[dst]` of native value (v7.2, §3: 0 toward an EVM chain) | inside `_spawn`, one per registered chain not above its `syncCap`; `SpawnPad.resync(token, chain)` (v7.1; v7.2: anyone who pays, or the operator) for a chain whose SYNC failed, was skipped, or which joined after the token; the answer to OP_OPEN (v7.2) | EVM: deploy replica (`SpawnToken` premint 0, controller = gateway), record `replicaOf`, then book any fee drop parked for it. A SYNC for a token that already has a replica is ignored. Solana: create Replica PDA + SPL mint, decimals 6, authority = store (`lz_receive.rs::handle_sync_token`) |
| 11 | OP_DELIVER | pad → gateway | `(bytes32 token [downcast/seed], bytes32 to [downcast on EVM; raw pubkey on Solana], uint256 tokens, uint256 refund)` | inside `_buy`; also a refused sell's bag coming back | EVM: `replica.bridgeMint(to, tokens)` — or, if the replica does not exist yet or the mint fails, **park** in `pendingDelivery[token][to]` for `claimPending`; the refund settles at once either way by `OmniUSD.payout(to, refund)` (USDC if the vault is liquid, else an oUSD claim). Solana: mint `tokens / 1e12` to recipient's ATA (+ scaled refund) |
| 12 | OP_PAYOUT | pad → gateway | `(bytes32 to [downcast on EVM; raw pubkey on Solana], uint256 usdOut)` | `_sell` net proceeds, `_claim` dev share, a refused spawn's dev buy, a refused unknown-token buy; v7.2: a moved claim arriving at its destination, or coming home | EVM: `OmniUSD.payout(to, usdOut)` (v7 — USDC if liquid, else an oUSD claim; never reverts) |
| 13 | OP_FEE_DROP | pad → gateway | `(bytes32 token [downcast/seed], uint256 amount)` | the reply to OP_PULL_FEES; or, for an `autoDrop` chain only, `_distributeHolders` directly | EVM: `distributor.drop(replica, amount)` and mint the oUSD into the chain's `FeeDistributor`; if there is no replica or no distributor yet, or the distributor refuses, **park** in `pendingFeeDrop[token]` (flushed by the SYNC, or by anyone via `flushFeeDrop`). Holders claim oUSD and unwrap or trade with it. Solana: mint into the store's vault ATA, parked pending the phase-3 distributor |

Unknown ops revert (`"PAD: bad op"` / `"GW: bad op"`); the Solana codec
rejects unknown ops, dirty envelope padding and bad offsets
(`msg_codec.rs` tests). Ops 5, 6 and 7 are ADDITIVE; ops 1, 4 and 10–13
are byte-for-byte what they were. **Ops 2 and 3 are NOT** (v7.2): each
gained a fourth word, and the pad decodes four — a three-word BUY or SELL
is malformed and reverts. So is the envelope around every message (§3).
The codec vectors in `solana/tests/codec-vectors.json` were not
regenerated — they still describe the three-word trades and the
three-field envelope and are WRONG for this hub; the Solana program must
send the new shapes (a minimum of 0 is a valid one) before it speaks to
it. It neither sends ops 5–7 yet nor ever receives them (they are gateway
→ pad only). What v7.2 also asks of a non-EVM gateway: its PAYOUT handler
now receives recipients a user CHOSE (a moved claim), not only identities
that were a signer on that chain — it must pay, park or mint a claim for
any 32-byte `to`, never fail (§5, §11).

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
| adapter | `"LZM: not endpoint"`, `"LZM: not a peer"` (v7.1: also for ANY eid with no peer set, F-11), `"LZM: no sender"`, `"LZM: bad target"` | authentication | not a protocol message at all |
| pad, gateway | `"… not messenger"`, `"PAD: not a gateway"` (v7.1: also for a zero sender), `"GW: not the pad"`, malformed `abi.decode`, `"… bad op"` | authentication | not a protocol message at all; an authentic gateway/pad cannot produce these |
| pad `_spawn` | ~~`"PAD: bad fee mode"`~~ | **was a stranding bug — fixed** | `spawnToken` did not validate `feeMode`, so a spawn with a bad mode and a dev buy burned the dev buy and reverted on the hub forever. Now refused at the gateway AND refunded by the pad |
| pad `_spawn` | out of gas on oversized strings | **was reachable — fixed** | name/symbol/metaURI are stored on the hub and replayed to every chain; now capped at the gateway (64 / 16 / 1024 bytes). The largest legal spawn (max strings + dev buy, 5 remote chains) costs ≈ 2.33M of hub work plus one endpoint send per remote chain — ≈ 3.5M at an ESTIMATED 0.2M per real send, inside the 4M budget (the mock's 0.52M per send is measured, the real figure is not: the testnet rehearsal must confirm it, and the hub gas limit must rise with the number of remote chains) |
| pad | ~~`"PAD: bad recipient"` on a wide token id~~ | fixed (defence in depth) | a wide or unknown token id is refused; a BUY's dollars go home by OP_PAYOUT |
| pad `_claim` | ~~`"PAD: not the dev"`, `"PAD: nothing to claim"`~~ | fixed | carried no value, but left a dead, never-retryable packet behind; now a refusal with no reply |
| pad `_buy` / `_sell` / buyback → venue | `"VENUE: dust"`, `"VENUE: zero …"`, `"VENUE: unknown token"`, `"VENUE: min out"` (v7.2), anything a future venue throws | fixed | `execBuy` / `execSell` run under `try`: a buy bounces whole, a sold bag is re-delivered, a buyback leaves its pot for the next fee. The gateway also floors buys and sells at 1e12 wei so dust never leaves. v7.2 uses this very path for the trader's minimum: the venue reverts under it, before any state change, and the refusal is the protection (§3) |
| pad `_sell`, the seller's minimum → the venue's gross minimum | ~~an arithmetic overflow on a minimum near `2^256`~~ | **would have been a stranding bug — designed out** | `minUsdOut` is the first NUMBER on the wire that a user chooses freely and the pad does arithmetic on. The conversion runs unchecked and saturates: a minimum too large to convert becomes one no sale can meet, the venue refuses, the bag goes back (tested with `2^256 − 1` and its neighbours; the checked version reverts the delivery for good) |
| adapter `lzReceive` | `"LZM: value"` (v7.2) | acceptable — retryable | the delivery brought less than the reply budget the envelope names. The packet is not consumed: the executor, or anyone who attaches the budget, delivers it (§3, "The budget must arrive") |
| adapter `lzReceive` → anything, with too little gas | out of gas | acceptable — retryable | the executor's gas is per kind of message since v7.2 and an operator can set one too low; anyone can also deliver with less on purpose. A delivery that runs short reverts as a whole; where an inner failure is tolerated the outcome does not depend on gas (§3, "What the option is, and is not") |
| pad `_sell` | **a 1-wei sell returned 1 wei of oUSD; a round trip could leave the pad 1 wei short of its own pots, reverting the burn that pays the last seller or puller** | **was a stranding bug — fixed at the root** | `InternalCurveVenue` rounded in the trader's favour. It now rounds every trade against the trader (ceiling division), which keeps `vBase ≥ V_BASE_0`; `hardening.test.js` asserts pad solvency (V1) as an exact equality after each of 90 odd-sized random trades |
| pad `_sell` | `supplyByChain[token][src] -= tokensIn` underflow | invariant guard | cannot fire while S2 holds: a gateway can only burn replicas the hub delivered to its chain. If it fires, the ledger is corrupt and a loud, retryable revert is the right outcome |
| pad | `usd.bridgeBurn` / `SpawnToken.bridgeBurn` insufficient balance | invariant guard | cannot fire while V1 / S1 hold (now exact, see above) |
| pad | `"VENUE: market open"`, `new SpawnToken` | unreachable | a fresh CREATE address has no market; deployment fails only by running out of gas (bounded by the string caps) |
| pad → adapter | `"LZM: gas tank empty"` | **acceptable — retryable** | the reply cannot be paid; the inbound message is not consumed and LayerZero keeps it re-executable by anyone once the tank is refilled (tested). Cannot happen from protocol traffic alone: every reply is prepaid |
| pad `_spawn` → the SYNC fan-out | ANY failure of one chain's send: `"LZM: no route"`, `"LZM: no gas limit"`, a message the pathway's executor will not carry (LayerZero's default toward some chains admits less than a SYNC), a pathway LayerZero retired; on the hub chain's own gateway, `"GW: no distributor"` | **was a liveness bug (F-12) — fixed in v7.1** | `setGateway` is permanent and `_spawn` sent every SYNC with a plain call, so one leg whose send reverted undid EVERY launch from EVERY chain — for the 48 h a timelocked repair takes, or for good if the chain is gone. Each SYNC now runs under `try`; a failure emits `SyncFailed(token, chain)` and the spawn stands. It is re-sent with `resync(token, chain)` once the leg works — by the operator on the tank's account, or (v7.2) by anyone who pays for it. Meanwhile that chain has no replica: its gateway refuses buys, sells, claims and pulls at entry, and anything the hub sends there first (a dev buy's DELIVER, a FEE_DROP) is parked |
| pad `_spawn` | `"PAD: gas"` | acceptable — retryable | a SYNC send that failed with almost no gas left behind it (`gasleft() < 200,000` — 100,000 until v7.2) was STARVED, not refused: the spawn reverts and is retried with enough gas. Without this, whoever delivers a spawn — or a wallet's own `eth_estimateGas` — could pick the gas at which the last SYNC runs dry and the launch "succeeds" without a chain (`v71.test.js` sweeps the gas of a spawn and finds no such value) |
| pad, every skippable message (v7.2: a spawn's SYNC under a `syncCap`, the SYNC of an OP_OPEN, the forward leg of an OP_MOVE) → the QUOTE, then the send | any failure of either; a quote above the ceiling | never a revert — except starvation | `_within` prices the message (`messenger.quote` under `try`), `_trySend` sends it (under `try`). A quote over the ceiling, a quote that reverts and a send that reverts all mean "not sent": `SyncFailed` for a SYNC, the way home for a move. The same floor applies to both calls (`_notStarved`, `"PAD: gas"`): a QUOTE that ran dry must not pass for a ceiling, or the gas of a delivery would again decide whether a chain gets its replica — after a failed quote on the last chain of a fan-out, or on an OP_OPEN, only an event remains to be emitted. `v72.test.js` sweeps the gas of a spawn, an open and a move with a quote that costs what a real one does (the mock's is nearly free, which hides it) and fails without the floor |
| pad OP_OPEN | an id the pad never spawned | refused | `Refused(6, src, id, 0, 0, 2)`, no reply. It carried no value; the fee it prepaid stays in the tank |
| pad OP_MOVE → the way home (`_sendHome`) | `"LZM: no route"`, `"LZM: no gas limit"`, `"LZM: gas tank empty"` | misconfiguration — retryable | the forward leg is skippable, the return is not: it is a reply carrying the mover's value to the chain it came from. If it cannot be sent the inbound message reverts as a whole and LayerZero keeps it (tested) |
| pad OP_MOVE → the destination gateway's PAYOUT handler | ~~`"GW: bad recipient"` on a recipient that is not an address~~, ~~a mint to the zero address~~, ~~a payout addressed to no contract~~ | **would have been stranding bugs — designed out** | `to` is the first recipient on the wire that a user chose. An EVM gateway reverts on a wide one (corruption guard, above), `OmniUSD.payout` reverts minting a claim to `address(0)`, and a message to a chain whose adapter route exists but whose gateway the pad does not know yet (a chain being added, inside the timelock delay) would be addressed to nobody. The pad refuses all three BEFORE it forwards — the claim goes home — and the source gateway refuses a zero recipient at entry |
| pad `resync` (v7.2: anyone) | `"PAD: unknown"`, `"PAD: fee"`, the leg's own error | a user call | atomic: the value attached is not taken |
| pad → adapter, REPLIES (DELIVER, PAYOUT, a pulled FEE_DROP) | `"LZM: no route"`, `"LZM: no gas limit"` | misconfiguration — retryable | a reply carries a user's value to the chain it came from; it cannot be skipped. If that leg cannot be sent the inbound message reverts and LayerZero keeps it until the adapter is fixed. Deploy scripts set the destination before the pad learns a gateway |
| pad `_distributeHolders` → `autoDrop` send | any failure of the local drop | fixed | the send runs under `try`; a drop that cannot be shipped falls back to `pendingDrop` instead of undoing the trade that triggered it |
| gateway DELIVER | ~~missing replica~~ (F-2), a failing `bridgeMint` | **was a stranding bug — fixed** | parked in `pendingDelivery`, claimed by the recipient with `claimPending`; the refund leg still settles at once |
| gateway FEE_DROP | ~~`"GW: no replica"`~~, no distributor, a failing `drop` | fixed | parked in `pendingFeeDrop`, flushed by the SYNC or by `flushFeeDrop` |
| gateway SYNC | a second SYNC for the same token | fixed | ignored; it used to overwrite `replicaOf` and orphan every holder of the first replica |
| gateway SYNC | `"GW: no distributor"` | misconfiguration — retryable (added on purpose) | a replica deployed before the gateway has its holder pool could never be given one — its holders would earn nothing, forever. A SYNC carries no user value, so it fails loudly until the admin sets the distributor; a DELIVER or FEE_DROP landing meanwhile parks. Deploy scripts set the pool before the pad learns the gateway. On the hub chain's own gateway the SYNC is a call inside `_spawn`: since v7.1 it is caught like any failed SYNC (`SyncFailed`), the launch stands, and `resync` deploys the replica once the pool is wired |
| gateway → `SpawnToken._update` → `FeeDistributor.handleTransfer` | arithmetic overflow in `magDPS × amount` | **was an exploitable stranding bug — fixed at the root** | see §8 "The 2^128 edge": a drop landing on a few wei of shares made every later mint of that replica revert, i.e. every later DELIVER on that chain. Closed by `MIN_SHARES`; a failing mint is parked in any case |
| gateway | `"GW: bad recipient"` on a wide `to` / token id | corruption guard (kept) | this is an EVM chain: every recipient the hub echoes back was a local `msg.sender`, every token id a hub address. A wide value has no EVM account to be parked for |
| gateway → `OmniUSD.payout` | — | never reverts | USDC if the vault is liquid and the transfer is accepted, else an oUSD claim (§7); `to == 0` is unreachable |
| gateway → `OmniUSD.payout` / `bridgeMint` | `ReentrancyGuard` | unreachable | no path re-enters `OmniUSD` while one of its guarded functions is on the stack: `depositFor` returns before the message is sent, and USDC has no transfer hook |

Two properties of the `try` blocks that matter. (1) They cannot be turned
into a forced bounce or a forced park by an executor that starves the call
of gas: the call receives 63/64 of the remaining gas, and what must run
afterwards (a reply send on the pad, a fresh storage slot on the gateway)
needs far more than the 1/64 left — so either the inner call had ample gas
or the whole delivery reverts and stays retryable. The SYNC `try` of v7.1
is the one place where that argument does NOT hold by itself — after the
last SYNC of a spawn with no dev buy, only an event remains to be emitted —
which is why it carries an explicit floor (`"PAD: gas"`, above). (2) A
`try` only guards an external call's revert; nothing is swallowed inside
the pad or the gateway themselves.

**A correction to (1), found in v7.2 — and the floor raised to 200,000.**
"63/64 of the remaining gas" is per call frame, and each frame between the
pad and the one that actually runs dry hands its own 1/64 back as it
unwinds. After a starved call `k` frames deep the pad holds about `k/64`
of what the call needed, not `1/64` of it. v7.1 wrote that its 100,000
floor covered "any send that needs less than ~6.3M gas"; it covered 6.4M /
k.

Measured, on forks of the five chains, through the real EndpointV2 with
the deployment's verifier set (829 deliveries of a worst-case spawn traced
under `debug_traceCall`, 485 of them starving a send or a quote; 79
deliveries of an open from Ethereum): a LayerZero send costs 0.21–0.28M
gas and a quote 0.12–0.23M, SEVEN frames below the pad (adapter, endpoint,
send library, executor or DVN, fee library, price feed). Every starved
delivery reverted `"PAD: gas"`: no hole. But the most gas a starved call
left behind was about 34,300 — a margin of only 2.9× under a floor of
100,000 — and the thin end was not a LayerZero send: it is the hub
chain's OWN replica SYNC, a loopback that deploys a contract (0.77M, three
frames deep). 2.9× is too thin for a constant that can never change:
`SYNC_GAS_FLOOR` is **200,000** — 5.8× what that deployment leaves when
starved, about 6.5× what a LayerZero send does. The cost: after a leg that
refuses, the pad needs 200k left, against at least 0.7M of headroom in the
hub gas the tooling buys for a spawn (worst spawn on a fork 4.52M, limit
5.26M). On the mock the sweeps are unchanged in outcome, and one more test
puts a number on the margin: with a quote made to cost 4M gas (twenty
times a real one) at two frames, a starved quote leaves up to ~125,000 —
over the old floor, under this one — and the open is never left closed.

The bound this puts on the future: nothing the pad calls under `try` may
ever need more than 64 × 200,000 / depth gas — 4.2M three frames deep,
1.8M seven frames deep.

### Liveness of the SYNC fan-out (v7.1, v7.2)

- **A chain without the replica is closed for that token, not broken.**
  `buyToken*`, `claimFees`, `pullFees` revert `"GW: unknown token"`,
  `sellToken*` and `claimPending` `"GW: no replica"` — user calls, atomic,
  nothing moves. Every other chain trades normally.
- **The launcher's own chain.** If the SYNC to the chain a spawn came from
  fails but its replies can still be sent (the Solana case: an executor
  limit below a SYNC's size but above a DELIVER's), the dev buy's bag is
  delivered and PARKED there (`pendingDelivery`), counted in
  `supplyByChain` like any delivered token, and minted by `claimPending`
  after `resync`. If the replies cannot be sent either, the spawn message
  reverts and waits in LayerZero — a reply is never skipped.
- **`resync(token, chain)`** — payable, and anyone's since v7.2. The pad is
  a sponsored sender, so its messages are paid by the hub tank: the
  OPERATOR (or the admin) may call it with no value, as in v7.1; anyone
  else must attach at least `messenger.quote(chain, gateway, payload, 1)`
  — the message and the one unit of native value a SYNC carries, §3 —
  (`"PAD: fee"`), and the WHOLE `msg.value` is handed to the messenger, so
  the tank is never out of pocket (on the mock: unchanged to the wei at
  the exact fee, larger by any surplus). It needs a token the pad spawned
  and a chain that has a gateway (`"PAD: unknown"`), re-sends the same
  `OP_SYNC_TOKEN` built from the stored name and symbol, and emits
  `Resynced`. No ceiling applies — the caller is paying — and it ignores
  the pad's pause: it moves no value and cannot fork a token (a gateway
  ignores a SYNC for a replica it already has). Tokens spawned BEFORE a
  chain was added are given a replica there the same way, by whoever
  wants them there. A resync toward the hub chain's own gateway costs
  nothing but its gas (the leg is a local call).
- **A ceiling per chain on the fan-out: `syncCap` (v7.2).** With Ethereum as
  a leg, one SYNC costs what dozens of L2 messages do, and a launcher
  prepaid the fan-out at ANOTHER chain's prices (`spawnLegs` × its own
  reply unit, capped at 128 legs — 32 until v7.2, too few to reach
  Ethereum with room to spare): at an L1 gas spike every spawn would take
  the difference out of the tank's
  float, after which ordinary replies, prepaid with no slack, start
  failing. `setSyncCap(chain, cap)` (operator; hub-native wei) bounds what
  one spawn may spend on that chain's SYNC: the pad asks the adapter for
  the quote first, and above the ceiling — or if the quote itself reverts —
  it emits `SyncFailed` and goes on to the next chain without sending. The
  tank is not charged for a message that was not sent (asserted to the
  wei). `0` means no ceiling AND no quote: a chain without one costs the
  spawn exactly what it did. A ceiling cannot skip the hub chain's own
  gateway (its SYNC costs nothing). And for the chain a spawn came FROM the
  ceiling is the larger of `syncCap` and `requestCap`: that launcher
  prepaid at that chain's own price and wants the token where they stand —
  without this, a chain left out of every launch could not launch for
  itself (its dev buy would be parked behind a replica nobody sent). Set
  BELOW a chain's ordinary price, the ceiling takes that chain out of every
  OTHER chain's launches: it is then opened token by token —
- **`openToken` / `OP_OPEN` (v7.2).** Someone on the chain a token never
  reached asks the hub for it and pays the round trip in that chain's own
  coin: the message, plus `openLegs` reply units for the SYNC (its own
  count: a SYNC can cost more than the DELIVER a trade leg is priced on).
  The hub sends the SYNC if it costs no more than `requestCap` of that
  chain (§3) and emits `Resynced`; otherwise `SyncFailed`, and the fee
  stays in the tank. The gateway only takes the call where no replica
  exists; two opens in flight for the same token cost their callers one
  fee each and deploy one replica.
- **Retiring a leg.** Two reversible switches, both the operator's. On the
  hub adapter, `setDestination(label, 0, …)` makes every send to that label
  revert `"LZM: no gas limit"` before any fee is paid — replies included,
  so it is for a chain that is gone. On the pad (v7.2), `setSyncCap(label,
  1)` takes the chain out of the launch fan-out only, at the cost of one
  quote per spawn, and `setRequestCap(label, 10, 0)` / `setRequestCap(label,
  12, 0)` close it to opens and to incoming moves, one kind at a time;
  trades already there keep their replies.

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
- **A recipient someone chose (v7.2).** Until `OP_MOVE`, every identity the
  hub echoed back to a chain had been a signer ON that chain, which is
  what made the EVM spoke's downcast a safe revert. `moveClaim(dstChain,
  to, amount)` breaks that: `to` is typed by a user on another chain. The
  hub therefore decides BEFORE forwarding whether the destination can pay
  it — by SHAPE: a gateway id whose top 12 bytes are zero is an EVM chain
  (a 32-byte key with 96 leading zero bits does not occur), and its
  recipients are addresses; a wide gateway id is a 32-byte chain, and its
  recipients are 32-byte keys. **The shape of `to` must match the shape
  of the destination's gateway** (`wide(gateway) == wide(to)`,
  `SpawnPad._move`). An EVM gateway would revert on a wide recipient, for
  good. A 32-byte chain would ACCEPT a left-padded address — the likeliest
  slip of someone moving a claim out of an EVM wallet — and book the claim
  for a key nobody holds, for good; so that comes home too. What fails
  the test goes home to `(srcChain, from)` — and `from` IS a signer of the
  source chain, so the way home cannot hit the same wall. A recipient of
  the right shape that nobody controls is the sender's own mistake, as
  with any transfer.

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
  subtraction cannot underflow while S2 holds. v7.2's `moveClaim` moves
  DOLLAR CLAIMS between chains, never tokens: it does not touch
  `supplyByChain` or any replica.

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
- **Backed by another dollar** (`OmniUSDLocal`, v7.2: the spoke vault of BNB
  Chain): the same vault over a dollar Circle does not issue there — BSC
  USDT, 18 decimals. `SCALE = 10^(18 − decimals)` (1 for USDT: no sub-unit
  dust), no CCTP, no peer, no `rebalance`, **no `wrap`**. It keeps
  `OmniUSD`'s surface wherever the gateway, the distributor and the tooling
  touch it (same selectors, events and revert strings — pinned by
  `bnb-universe.test.js`), so the one `SpawnGateway` runs against either.
  See "Two dollars, one set of books" below.

How oUSD comes to exist or disappear — the complete list (a test pins the
set of state-changing functions, `test/settlement.test.js`):

| Path | Who | USDC | oUSD |
|---|---|---|---|
| `wrap(usdc6)` — `OmniUSD` only; `OmniUSDLocal` has none (v7.2) | anyone, on a USDC chain | pulled into the vault (under `depositCap`) | minted 1:1 to the caller |
| `unwrap(amount18)` | anyone | paid out; reverts `"oUSD: vault short"` if the local vault lacks it | whole-USDC multiple burned, sub-`SCALE` dust stays |
| `depositFor(from, usdc6)` | agent (gateway) | pulled from `from` (under `depositCap`) | **none** — the value leaves in the outgoing message (≡ wrap + bridgeBurn) |
| `payout(to, amount18)` | agent (gateway) | `floor(amount18/SCALE)` paid if the vault has it and the transfer succeeds | only the sub-`SCALE` dust minted — or, on fallback, the **whole** amount |
| `bridgeMint` / `bridgeBurn` | agent | — | value arriving by / leaving in a protocol message (oUSD-denominated buys, fee drops into the distributor, all hub ledger moves; v7.2: the claim a `moveClaim` burns on its way to another chain, where it arrives through `payout`) |

Deposits credit the balance **delta** actually received, not the requested
amount, and every USDC-moving function is `nonReentrant`. A deposit that
rides a message (`depositFor`) must credit at least `MIN_DEPOSIT = 1e12`
oUSD wei — one USDC unit (`"oUSD: dust"`, v7.1). Real USDC can never
credit less; the floor refuses a deposit that credited NOTHING instead of
sending the hub a zero-dollar buy, and it is the same check as in
`OmniUSDLocal` (the vault of a single-chain universe settled in a dollar
of 6 to 18 decimals, where an amount below the floor is otherwise
expressible — docs/BNB-UNIVERSE.md).

- **V0 (global backing) — the invariant everything else rests on:**
  `Σ over vaults of dollar tokens held × that vault's SCALE = Σ over ALL
  instances (hub ledger included) of oUSD.totalSupply()`, modulo value in
  flight (a message between its burn and its mint; a CCTP rebalance between
  its burn and Circle's mint). It is a GLOBAL equality, not a per-chain
  one — and since v7.2 the left side adds up two different dollars (USDC ×
  1e12, USDT × 1). `v72.test.js` asserts it after every step of a
  five-chain, two-dollar universe (label 3 by loopback, USDC on 6, 5 and
  2, USDT on 4): launches from every chain, trades, pulls, claims, moves,
  moves turned back, opens, and a randomized sequence of them.
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
  on local liquidity; later claimants hold oUSD until a rebalance — or,
  since v7.2, take the claim to a chain whose vault can pay it
  (`moveClaim`, below).
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

### Two dollars, one set of books (v7.2)

Between USDC chains the vaults are levelled with CCTP: a dollar in the
Optimism vault and a dollar in the Base vault are the same thing, one burn
and one mint apart. The BNB vault holds USDT and can be levelled with
nothing (docs/SATELLITE-DOLLARS.md). With one curve pricing a token for
every chain, dollars that enter on BNB pay sellers on Base and the reverse,
so the two sides drift apart for good: a seller on BNB can be left with a
claim that vault will never hold the USDT for while the dollars sit on
Base as USDC — and a seller on Base with a claim whose dollars sit on BNB.

**`moveClaim(dstChain, to, amount)`** is the answer the protocol gives: the
holder burns the claim where it cannot be paid and the hub forwards it as
an `OP_PAYOUT` to a chain of their choosing, where that vault pays its own
dollar if it holds it and mints a claim there if it does not (the holder
may move it on). What it is and is not:

- it never touches the hub's books (V1 is unchanged: tested — the ledger's
  supply is the same before and after a move) and V0 holds at both ends: a
  claim burned on one chain becomes a claim, or a dollar leaving a vault,
  on another. In flight the two sides of V0 differ by exactly the amount;
- it is an exit: no pause applies, on the gateway or on the pad;
- it pays out whatever the DESTINATION vault holds. A claim that arose in
  USDT leaves in USDC and the reverse, at par. That is the point — and
  the exposure: **every vault now backs every claim in the universe, in
  its own dollar**. First-come-first-served is global.

**What `OmniUSDLocal` having no `wrap` does, and does not do.** With
portable claims, `wrap` on the USDT vault would be a free, unlimited,
one-step exchange of USDT for USDC at par through the vaults — ruinous for
every USDC holder the day USDT slips its peg. Without it, oUSD exists on
BNB only as a claim does: a payout that vault could not make (short, or the
issuer froze the recipient), and holder fees dropped into the distributor
(there is no sub-unit dust at 18 decimals). Dollars enter that vault
through the gateway only (`depositFor`), bound to a trade. It does NOT
separate the two dollars:

| Channel | Direction | Rate | What bounds it |
|---|---|---|---|
| `OmniUSD.wrap` on a USDC chain, then `moveClaim` to BNB | USDC → USDT, at par | one message, any size | what the BNB vault holds at that moment; the operator can close the route (`setMoveLegs(4, 0)` on a gateway) or the destination (`setRequestCap(4, 12, 0)`) |
| a claim on BNB (short vault, frozen seller), moved to a USDC chain | USDT-side claim → USDC, at par | as claims arise | by design — this is the exit; bounded by what USDC vaults hold |
| fees: trade on BNB in USDT, claim the dev share on a USDC chain (`claimFees` pays on the chain the dev asks from), or pull and move a holder share | USDT → USDC, at par | 1% of volume per trade — 2% of a wallet's capital per round trip on its own token, up to 30% of a buy inside a genesis window | the BNB vault's deposit cap bounds its BALANCE, not this flow; the guardian's stops are the brake: `pause` on the BNB gateway and `pauseDeposits` on its vault end every USDT inflow |
| a sale on a USDC chain of a bag whose price BNB buyers pushed up | USDT in, USDC out | the market itself | this is "one curve": inherent |

So a depeg of either dollar is every holder's problem, to the extent of
what the other side's vaults hold: if USDT slips, USDC leaves through the
fee channels until the guardian closes BNB's deposits; if USDC slips, the
BNB vault's USDT leaves through `wrap` + `moveClaim` at the speed of one
message per transfer until a route is closed. Neither is theft and V0
holds throughout — in UNITS. V0 says nothing about what a unit is worth.
The honest statement to users: **a claim is a claim on the universe's
dollars — mostly USDC, partly USDT — not on USDC.** The deposit cap on the
BNB vault is the knob that bounds how much of the backing can be USDT.

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

4. **With a minimum, all or nothing (v7.2).** A buy that names
   `minTokensOut` and that the gate cuts down (the cap), or lets through
   taxed, fills only if what is left still buys the minimum; otherwise the
   venue refuses it, the cap accounting of rule 3 is undone
   (`genesisSpent` is as it was), no tax is taken and the whole `usdIn`
   goes home (`v72-wire.test.js`).

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
- **Minimums (v7.2).** `execBuy(token, usdIn, minOut)` reverts `"VENUE:
  min out"` if `out < minOut` — after the cap above, so a buy the curve
  can only fill in part is under its minimum — and `execSell(token,
  tokensIn, minOut)` if the gross `usdOut < minOut`; both before any
  state changes, on the curve and on the pool after ascension. 0 = none.
  It is part of `ICurveVenue`: any future venue must enforce it, or the
  hub's cross-chain orders are unprotected again.
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
  **Stale since v7.2**: the generator and the vectors still describe the
  three-word OP_BUY / OP_SELL and the three-field envelope, and know
  nothing of ops 6 and 7. Both must be brought to §3 / §4 before the
  program speaks to a v7.2 hub.

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
| `returnUnit` / `tradeLegs` / `spawnLegs` are operator-set estimates of a moving price | AUDIT SCOPE as a liveness model — set too low the hub tank drains and replies stall (retryable, §3); set too high users overpay into the tank (now bounded: `MAX_RETURN_UNIT`, legs ≤ 4 / 32). Needs monitoring + a refresh routine; one `returnUnit` per destination means a spawn's SYNC legs are priced at the origin's unit, not each target's; `spawnLegs` goes stale on every gateway when a chain is added. v7.2 adds numbers of the same kind — `syncCap`, `requestCap` per kind, `openLegs`, `moveLegs` per destination, `gasForOp` per kind — each a price the operator must keep near the market; none can lose user value when wrong (a skipped SYNC, a claim sent home, a delivery to make again), all can cost users fees or liveness |
| ~~One executor gas limit per destination~~ | **RESOLVED in v7.2** (§3, F-20) — `gasForOp[dst][op]`. Not bounded by the contract (a `uint128`): set absurdly high it over-charges whoever signs the quote, and that money goes to LayerZero's executor, not to the tank — nobody can give it back |
| Gateway sponsorship is one admin flag | AUDIT SCOPE (hostile/mistaken admin, now behind the timelock) — sponsoring a gateway on mainnet reopens the dust-drain of its adapter's tank |
| ~~The adapter accepts a zero-sender packet from an unconfigured chain as the hub~~ | **RESOLVED in v7.1** (F-11, §3) by a full redeploy; the retired v7.0 deployment held only canary funds |
| ~~One chain whose send reverts bricks every launch~~ | **RESOLVED in v7.1** (F-12, §4) — failed SYNCs are logged, `resync` repairs them |
| ~~Only the operator can bring a token to a chain~~ | **RESOLVED in v7.2** (§4) — `resync` is anyone's who pays for the message; `openToken` asks for it from the chain itself |
| ~~A dear leg (Ethereum L1) drains the hub tank at every launch~~ | **RESOLVED in v7.2** (§3, §4) — `syncCap` per chain. Residual: the ceilings are operator-set estimates of a moving price, like every reply budget (below) |
| Two dollars back one set of claims (v7.2: USDT on BNB, USDC elsewhere) | **BY DESIGN, and the largest economic exposure of v7.2** (§7 "Two dollars, one set of books"). The vaults cannot be levelled; `moveClaim` makes every vault pay any claim, at par; removing `wrap` from the USDT vault closes the free, unlimited USDT → USDC exchange but not the fee channels, and `OmniUSD.wrap` + `moveClaim` is a USDC → USDT exchange at par up to the BNB vault's balance. A depeg of either dollar is socialised to the extent of the other side's vaults. Bounded by the BNB deposit cap (stock, not flow) and the guardian's deposit pause; AUDIT SCOPE as an economic model, and to be disclosed to users |
| A forged gateway message can now pay out on ANY chain (v7.2) | **AUDIT SCOPE** — before `OP_MOVE` the hub only ever sent value back to the chain a message came from, so a compromised leg (its adapter route, its verifier set, a faulty non-EVM gateway program) could drain other vaults only indirectly (unbacked buys moving the price). A forged `OP_MOVE` is a direct `OP_PAYOUT` of any amount to any chain: USDC out of every liquid vault, unbacked claims beyond. The weakest pathway's verifier set is now custody of every vault. There is no per-chain or per-period limit on what a chain may move out — it would need hub storage and a policy; not built |
| ~~The executor's prepaid value is not enforced on arrival~~ | **RESOLVED in v7.2** (§3 "The budget must arrive", F-19) — the budget rides in the envelope and `lzReceive` refuses a delivery that brings less. Residual, to verify on a testnet before mainnet: it assumes the real executor delivers exactly the option's value, as the mock does. If one delivered short, hub-bound messages would wait for a manual delivery (anyone, with the value attached) instead of landing |
| ~~A spawn cannot prepay a leg far dearer than its own chain's reply~~ | **RESOLVED in v7.2** — `MAX_SPAWN_LEGS` is 128 (it was 32). Measured on forks, a launch that reaches Ethereum needs 15–30 of its origin's legs, and more as executor gas per kind shrinks the unit. The legs are still priced on a reply to the ORIGIN chain (one unit per destination), so `spawnLegs` must be re-tuned when any leg's price moves; and with a `syncCap` set below Ethereum's ordinary price NO token is on Ethereum until someone pays to open it there — a policy, no longer a necessity |
| The pad is close to the code-size limit | 23,872 of 24,576 bytes after v7.2 (704 to spare; `sizes.test.js` requires 512). Room was made by routing every reply send, every `Refused`, every `Trade` and the BUY/SELL dispatch through shared internals — no behaviour change. The minimum on the wire cost the pad 8 bytes (the check lives in the venue). No compiler override, same optimizer settings as every other contract. It only matters until the pad is deployed: after that nothing can be added anyway |
| `requestCap` defaults to 0 — closed | by design (fail-closed: an unpriced chain cannot make the tank front anything) — but the deploy tooling must set it for every remote chain and for both kinds (10: opens, 12: incoming moves), with `moveLegs` for every pair and `openLegs = 0` on the hub chain's gateway, or opens waste their fee and moves come home. TOOLING CHANTIER (next) |
| ~~No slippage protection on CROSS-CHAIN trades~~ | **RESOLVED in v7.2** (§3, F-18) — the minimum rides OP_BUY / OP_SELL and the venue enforces it; `…Min` work on every chain. Residuals: on a remote chain the protection is a refusal after the fact, not a revert (the order's value makes the round trip and the messaging fee is spent); an order can be made to BOUNCE by whoever moves the price past its tolerance; the refusal's reason code (6) is shared with dust. And the PLAIN functions still name no price: a frontend that sends a cross-chain trade without a minimum sends it unprotected — it should not offer that |
| No slippage protection on a spawn's dev buy | not needed — it executes first on a curve that did not exist one instruction earlier, inside the spawn itself |
| A parked delivery needs a user transaction (`claimPending`) and the UI does not surface it yet | frontend chantier — the tokens are safe and visible on-chain (`pendingDelivery`, `DeliveryParked`), but a user who never looks never gets them |
| No rescue path for a permanently refused message's prepaid native fee, or for USDC sent to a vault by mistake | by design so far (no admin function moves vault USDC); note it |
| Solana program still pays its sends from a protocol GasTank and prepays no reply | must adopt the v7 fee model before a Solana mainnet leg (wire unchanged; the fee plumbing is transport-side) |
| Solana program and the v7.2 ops | not written. As a DESTINATION of a move its PAYOUT handler receives a user-chosen 32-byte recipient and must never fail on it (an account that does not exist, is not a wallet, has no token account): pay, park, or mint a claim. The hub forwards any WIDE `to` to a wide gateway (an address-shaped one is sent home, §5), with one `returnUnit` of that chain's coin for the account it may have to open (§3): the program must be told what that unit is and the tooling must set it on the hub adapter for that label only. As a SOURCE it needs `OP_OPEN` / `OP_MOVE` in its codec (new vectors) and per-destination pricing. And for ANYTHING it sends to this hub: the four-word OP_BUY / OP_SELL (a minimum of 0 is valid) and the four-field envelope whose last word is the reply budget its executor option carries — the hub's adapter refuses a delivery that brings less — and, on what it receives, the same envelope (budget 0) |
| Frontend indexing by raw `eth_getLogs` scans | OUT OF SCOPE (ops; mainnet gets an indexer) |
| LayerZero DVN/executor selection | adapters now set a delegate (v7), so the set CAN be chosen — and must be, at deploy time, per pathway and on both sides (§3). Until `endpoint.setConfig` is called the defaults apply. AUDIT SCOPE for mainnet config review |
| Raydium/Meteora venue adapter | does not exist yet; OUT OF SCOPE until written |
| Solana devnet deploy + live delivery | pending; everything local is test-proven |

## 12. Findings while specifying

Observations made while writing this spec from the code — none silently
papered over. Status after the v7 hardening chantier: **F-1, F-2, F-5, F-6
resolved; F-7 to F-10 found and resolved by that chantier; F-11 to F-13
found after the v7.0 mainnet deployment and resolved in v7.1; F-14 to F-25
found while building v7.2 and resolved in it; F-3 and F-4 are Solana-side
and remain open.**

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
- **F-11 — an unset peer matched a zero sender.** RESOLVED in v7.1 (§3, "A
  peer is a SET peer"). `LayerZeroOmniMessenger.lzReceive` and
  `allowInitializePath` compared the packet's sender with `peers[srcEid]`
  only; for a chain nobody configured both the peer and the label default
  to zero, so a zero-sender packet from any such chain was a message from
  the hub, and a forged PAYOUT paid real USDC. Not reachable by a user, but
  it moved custody from the verifier set pinned for our pathways to
  LayerZero's defaults for every other one. Found by the BNB-universe
  chantier while asking what can reach a single-chain vault from outside;
  the v7.0 mainnet deployment was retired for it. The same shape in
  `SpawnPad.onOmniMessage` ((chain 0, sender 0) passed `gateways[srcChain]
  == srcSender`) is closed too; the full class table is in §3.
- **F-12 — one dead leg bricked every launch.** RESOLVED in v7.1 (§4).
  `_spawn` sent each `OP_SYNC_TOKEN` with a plain call and `setGateway` is
  permanent, so any leg whose send reverts — an unset route, a retired
  pathway, an executor message-size limit below a SYNC (found on the Solana
  pathway: 200 bytes by default, a SYNC is 288–480) — undid every spawn
  from every chain. Now `try` + `SyncFailed` + operator `resync`.
- **F-13 — a caught call can be starved on purpose.** RESOLVED with F-12
  (§4, `"PAD: gas"`). Putting the SYNC under `try` would by itself have let
  the gas of a delivery decide whether a chain gets its replica: the last
  send can be given too little gas to succeed while 1/64 of it is enough to
  finish the spawn. A wallet's own gas estimate lands exactly there. The
  floor makes a starved send revert the spawn instead; `v71.test.js` fails
  without it (a spawn delivered with 3,524,093 gas skipped one SYNC).

Found while building v7.2 (none of these ever ran anywhere):

- **F-14 — a move priced like a trade is a free message from the hub
  chain.** The first shape of `moveClaim` prepaid `tradeLegs`, like a sell.
  But `tradeLegs` is 0 on the hub chain's own gateway (its replies are
  local calls) and is priced on a reply to the SOURCE chain everywhere
  else — while a move's reply goes to ANOTHER chain. From Base, anyone
  holding 0.000001 oUSD (`wrap` is open on USDC chains) could have made
  the hub tank pay a remote message per call, for the gas of a Base
  transaction, until replies stalled for everyone. RESOLVED before it
  shipped: `moveLegs[dstChain]`, a price per destination with 0 = closed,
  never below `tradeLegs`; `quoteMove(dstChain)`. Tested for all twenty
  (source, destination) pairs of a five-chain universe: the tank never
  falls.
- **F-15 — a ceiling on the launch fan-out cannot also be the ceiling on
  requests.** One cap per chain looked enough. But a dear chain (Ethereum)
  is meant to be left OUT of the fan-out — its ceiling sits below its
  ordinary price — and opened per token by those who pay; the same ceiling
  on opens and incoming moves would then refuse them all. With no ceiling
  on them, a price spike lets anyone drain the tank through opens and
  moves that prepaid yesterday's price (a 5× spike: the tank loses four
  times what each request brought). RESOLVED: `requestCap`, a second
  ceiling per chain for messages their requester prepaid, always enforced
  (0 = closed), set to what such a request prepays (and per kind of
  message since F-21).
- **F-16 — a payout forwarded to a chain being added would be addressed to
  nobody.** `_move` forwards to `gateways[dst]`. Between the moment the
  hub adapter gets a new chain's route and the moment the pad learns its
  gateway (two timelocked steps), `gateways[dst]` is `bytes32(0)` while the
  send would succeed — a PAYOUT to no contract, reverting on that chain
  for good. RESOLVED: a destination without a gateway is refused before
  any send and the claim goes home (tested with exactly that wiring). Same
  family as F-11: an unset value that a user-influenced input can reach.
- **F-17 — a quote can be starved like a send (F-13 again).** Pricing a
  message before sending it puts a second call under `try`. After a
  failed quote on the last chain of a fan-out, or on an `OP_OPEN`, only an
  event remains to be emitted — so the gas of a delivery could again
  decide whether a chain gets its replica. The mock endpoint hid it (its
  quote costs almost nothing; a real one walks the send library, the
  DVNs and a price feed). RESOLVED: the same floor after a failed quote
  (`_notStarved`); the mock can now charge a realistic quote
  (`setQuoteWork`) and `v72.test.js` fails without the floor. The same
  work corrected the floor's stated margin (§4, "A correction to (1)").

Found in the second round of v7.2 — before the adapter and the pad were
frozen, since neither can be changed after:

- **F-18 — a cross-chain order could be sandwiched in one transaction, at
  no risk.** The order is public on its source chain minutes before it
  executes; `lzReceive` is permissionless; the hub chain's own gateway
  settles at once. So: buy locally, deliver the victim's packet, sell
  locally — one transaction, no race. On a fresh curve a $1,000 buy got
  27% of its tokens and the attacker kept $623; a sell was paid a third.
  v7.1 protected only the chain where the hub answers at once and said so
  ("until the wire carries a minimum"). RESOLVED: the minimum is on the
  wire (ops 2 and 3) and enforced in the venue; the same attack now costs
  the attacker two fees and the victim nothing but a messaging fee (§3;
  both directions run as tests against a contract that does it in one
  transaction).
- **F-19 — a packet could be delivered without the budget it had prepaid.**
  The endpoint lets anyone execute a verified packet with any value; the
  adapter took what came. Delivered with nothing, a hub-bound message made
  the tank pay its reply out of its float — at a cost to the attacker, but
  a tank is small and an empty one stalls every reply for everyone.
  RESOLVED: the budget is the last word of the envelope and `lzReceive`
  refuses less (§3).
- **F-20 — every message bought the gas of the dearest one.** One executor
  gas limit per destination: a buy paid for a spawn's worth of hub gas, a
  payout to Ethereum for a replica deployment's worth of L1 gas — and the
  adapter is as permanent as the pad. RESOLVED: `gasForOp` (§3). Checked
  along the way: nothing in the pad or a gateway relies on the gas a
  delivery comes with (it never could: anyone may deliver with any gas);
  every place where a failed inner call is tolerated is swept in tests.
- **F-21 — one ceiling for two prices.** `requestCap[chain]` covered both
  the SYNC of an open and the PAYOUT of a move — the same price while one
  gas limit served both. With F-20 fixed they differ, five to one on an
  L1, and a single ceiling at the SYNC's price would have let the tank
  front several times what a move prepaid: F-15 again, for moves, up to
  that multiple. RESOLVED before it shipped: the ceiling is per kind of
  message (`requestCap[chain][op]`), like the gas.
- **F-22 — a number a user types must not reach checked arithmetic on the
  message path.** `minUsdOut` is converted net → gross on the hub; in
  checked arithmetic a minimum near `2^256` overflows and reverts the
  delivery forever, with the seller's bag already burned on the spoke.
  RESOLVED as it was written: the conversion saturates (§4). The same
  care on the user-call side: the local balance check no longer adds the
  minimum to a balance (an absurd minimum was a panic there since v7.1 —
  atomic and harmless, but not the `"GW: min out"` a wallet expects).

And three from the reviews that came back while the second round was being
written — the fork measurements, and the Solana program's view of what the
frozen hub must give it:

- **F-23 — the gas floor's margin was 2.9×, on the hub chain's own
  deployment.** Measured through the real endpoint: the most a starved
  call left behind was ~34,300 gas, under a floor of 100,000 — and not
  behind a LayerZero send (0.21–0.28M, seven frames deep) but behind the
  hub chain's own replica SYNC, a loopback that deploys a contract (0.77M,
  three frames). No delivery slipped through in 829 traced; but the
  constant can never change. RAISED to 200,000 (5.8× and ~6.5×), §4.
- **F-24 — a message that makes a chain create an account must bring what
  the account costs.** On Solana a SYNC creates the replica's accounts
  and a moved PAYOUT may have to open one for a stranger; both arrived
  with no lamports, so the rent fell on a tank over there that nobody
  funds and anyone could spend from any chain. RESOLVED: the messages
  the pad is free to skip carry one reply unit of the destination's coin
  (`returnLegs = 1`) — 0 on every EVM label, the rent on Solana's — inside
  the quote, under the ceilings, prepaid by whoever caused them (§3).
- **F-25 — a 32-byte chain would have taken an EVM address for a key.**
  `_move` refused a wide recipient toward an EVM chain but let anything
  through toward a wide gateway, a left-padded address included: a claim
  booked for a key nobody holds, for good. RESOLVED: the shape of the
  recipient must match the shape of the destination's gateway (§5).
- **`MAX_SPAWN_LEGS` 32 → 128.** Not a defect of the code but of a bound:
  a launch that reaches Ethereum needs 15–30 of its origin's legs on the
  fork figures, at the edge of 32 (§3).
