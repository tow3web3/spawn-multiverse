/**
 * Protocol v7.2 as the site sees it: ONE universe on six chains, each chain
 * settling in its own dollar, every trade price-protected, tokens opened
 * from the chain they never reached, dollar claims moved between chains.
 *
 * Everything here is pure and dependency-free (plain bigint, strings and
 * already-decoded events), so the decisions the provider makes — what a
 * set of hub events means for the user, whether to offer an open, which
 * chains a claim can be moved to — are unit-tested on bare node
 * (src/lib/v72.test.mjs).
 */

export interface ChainDollar {
  symbol: string
  decimals: number
}

export const USDC6: ChainDollar = { symbol: 'USDC', decimals: 6 }
export const USDT18: ChainDollar = { symbol: 'USDT', decimals: 18 }

/** A chain's dollar as the manifest declares it: its own `dollar` when it
 * differs from the deployment's, else the deployment's, else USDC. The
 * chain's token is still asked for its decimals before anything is signed. */
export function declaredDollar(
  top: Partial<ChainDollar> | undefined,
  chain: { dollar?: Partial<ChainDollar> } | undefined,
): ChainDollar {
  const d = chain?.dollar ?? top
  return {
    symbol: d?.symbol ?? USDC6.symbol,
    decimals: d?.decimals ?? USDC6.decimals,
  }
}

/** The dollar a chain of the design settles in (the simulation, and before
 * a manifest has loaded): Binance USDT on BNB Chain, USDC everywhere else. */
export function designDollar(chainId: string): ChainDollar {
  return chainId === 'bnb' ? USDT18 : USDC6
}

/* ------------------------------------------------------------------ */
/* Reading the hub's verdicts                                          */
/* ------------------------------------------------------------------ */

/** A decoded log, as viem's `parseEventLogs` hands it over. */
export interface HubEvent {
  eventName: string
  args: Record<string, unknown>
}

/** Wire opcodes as they appear in `Refused.op`. */
export const OP = { SPAWN: 1, BUY: 2, SELL: 3, CLAIM: 4, PULL: 5, OPEN: 6, MOVE: 7 } as const

/** `Refused.reason` — SpawnPad's R_* constants. 7 is ASSUMED: the reason
 * the second v7.2 contract round gives a cross-chain trade that arrives
 * under the minimum its sender named (not in the contracts at 16f2d0a). */
export const R = { PAUSED: 1, UNKNOWN: 2, FEE_MODE: 3, NOT_DEV: 4, NOTHING: 5, VENUE: 6, MIN_OUT: 7 } as const

export const REFUSAL: Record<number, string> = {
  1: 'the hub is paused',
  2: 'the hub does not know this token',
  3: 'bad fee mode',
  4: 'only the dev can claim',
  5: 'nothing to pay out',
  6: 'the market refused the trade (dust)',
  7: 'the price moved past the minimum you set',
}

/** A bytes32 wire identity narrowed to its EVM address when it is one. */
export function narrow(b: unknown): string {
  const h = String(b).toLowerCase()
  if (h.length === 66 && h.startsWith('0x' + '0'.repeat(24))) return '0x' + h.slice(26)
  return h
}

const WEI = 10n ** 18n
/** 18-decimal wei → a JS number, for display. */
export const wei = (v: unknown): number => {
  const b = typeof v === 'bigint' ? v : BigInt(String(v ?? 0))
  return Number(b / WEI) + Number(b % WEI) / 1e18
}

/** What the hub did with one trade message. */
export type TradeOutcome =
  | { kind: 'trade'; usd: number; tokens: number; price: number; ascended: boolean; guardRefund: number }
  | { kind: 'bounced'; refunded: number }
  | { kind: 'refused'; reason: number; amount: number }
  | { kind: 'claimed'; amount: number }

/**
 * Finds the hub's verdict on `actor`'s message about `token`, sent from the
 * chain labelled `label`, in a set of pad events (one receipt on the hub
 * chain, a block range for a message that crossed). The chain is part of
 * the match: the same wallet may have just traded the same token from
 * another chain.
 */
export function readTrade(
  events: HubEvent[],
  q: { token: string; actor: string; want: 'buy' | 'sell' | 'claim'; label: number },
): TradeOutcome | null {
  const tok = q.token.toLowerCase()
  const who = q.actor.toLowerCase()
  const mine = (b32: unknown) => narrow(b32) === who
  const same = (t: unknown) => String(t).toLowerCase() === tok

  if (q.want === 'claim') {
    const done = events.find((e) => e.eventName === 'DevClaimed' && same(e.args.token) && mine(e.args.dev))
    if (done) return { kind: 'claimed', amount: wei(done.args.amount) }
    const no = events.find(
      (e) =>
        e.eventName === 'Refused' &&
        Number(e.args.op) === OP.CLAIM &&
        Number(e.args.srcChain) === q.label &&
        mine(e.args.actor),
    )
    if (no) return { kind: 'refused', reason: Number(no.args.reason), amount: wei(no.args.amount) }
    return null
  }

  const isBuy = q.want === 'buy'
  const trade = events.find(
    (e) =>
      e.eventName === 'Trade' &&
      same(e.args.token) &&
      Number(e.args.chain) === q.label &&
      mine(e.args.trader) &&
      e.args.isBuy === isBuy,
  )
  const guard = isBuy
    ? events.find((e) => e.eventName === 'GenesisGuard' && same(e.args.token) && mine(e.args.actor))
    : undefined
  const guardRefund = guard ? wei(guard.args.refundedUsd) : 0
  if (trade) {
    return {
      kind: 'trade',
      usd: wei(trade.args.usd),
      tokens: wei(trade.args.tokens),
      price: wei(trade.args.priceAfter),
      ascended: events.some((e) => e.eventName === 'Ascended' && same(e.args.token)),
      guardRefund,
    }
  }
  const no = events.find(
    (e) =>
      e.eventName === 'Refused' &&
      Number(e.args.op) === (isBuy ? OP.BUY : OP.SELL) &&
      Number(e.args.srcChain) === q.label &&
      mine(e.args.actor) &&
      narrow(e.args.token) === tok,
  )
  if (no) return { kind: 'refused', reason: Number(no.args.reason), amount: wei(no.args.amount) }
  // a buy the genesis guard turned away whole leaves no Trade, only the guard
  if (guard) return { kind: 'bounced', refunded: guardRefund }
  return null
}

/**
 * A trade the hub refused came back WHOLE: the buyer's dollars refunded on
 * the chain they came from, the seller's tokens re-delivered there. Said as
 * what happened, not as an error. `money` formats the amount in the source
 * chain's dollar ("$50.00 USDC").
 */
export function returnedText(
  side: 'buy' | 'sell',
  reason: number,
  where: { chain: string; ticker: string; money?: string },
): string {
  const back =
    side === 'buy'
      ? `Your ${where.money ?? 'dollars'} came back to you on ${where.chain}.`
      : `Your $${where.ticker} came back to you on ${where.chain}.`
  if (reason === R.MIN_OUT)
    return `The price moved past the minimum you set while your order crossed to the hub, so it was not filled. ${back} Only the network fee is spent — try again, or widen your tolerance.`
  return `The hub refused it — ${REFUSAL[reason] ?? 'see the hub events'}. ${back}`
}

/** What became of an `openToken` request for `token` from chain `label`. */
export function readOpen(events: HubEvent[], token: string, label: number): 'opened' | 'failed' | 'unknown-token' | null {
  const tok = token.toLowerCase()
  for (const e of events) {
    const same = String(e.args.token).toLowerCase() === tok && Number(e.args.chain) === label
    if (e.eventName === 'Resynced' && same) return 'opened'
    if (e.eventName === 'SyncFailed' && same) return 'failed'
    if (
      e.eventName === 'Refused' &&
      Number(e.args.op) === OP.OPEN &&
      Number(e.args.srcChain) === label &&
      narrow(e.args.token) === tok
    )
      return 'unknown-token'
  }
  return null
}

/** What became of a `moveClaim` from (`label`, `from`). */
export function readMove(
  events: HubEvent[],
  q: { from: string; label: number; dst: number },
): { forwarded: boolean; amount: number; to: string } | null {
  const who = q.from.toLowerCase()
  const e = events.find(
    (x) =>
      x.eventName === 'Moved' &&
      Number(x.args.srcChain) === q.label &&
      Number(x.args.dstChain) === q.dst &&
      narrow(x.args.from) === who,
  )
  if (!e) return null
  return { forwarded: e.args.forwarded === true, amount: wei(e.args.amount), to: narrow(e.args.to) }
}

/* ------------------------------------------------------------------ */
/* Opening a token on a chain                                          */
/* ------------------------------------------------------------------ */

/** Where a token cannot be traded on a chain, and why:
 *  - `arriving`: it was launched moments ago and its SYNC may still be
 *    crossing — wait;
 *  - `closed`: it will not arrive by itself (the launch skipped this chain,
 *    its SYNC failed, or the chain joined later) — it can be OPENED from
 *    here (v7.2 gateway);
 *  - `failed`: the same, on a gateway older than v7.2 — only a resync on
 *    the hub brings it. */
export type Availability = 'arriving' | 'closed' | 'failed'

/** How long a fresh token's SYNC is given to land before the chain is
 * treated as closed for it (a LayerZero hop is minutes, not tens of them). */
export const ARRIVAL_GRACE_MS = 15 * 60_000

export function availability(p: {
  hasReplica: boolean
  /** The hub logged `SyncFailed` for this chain and nothing resent it. */
  syncFailed: boolean
  /** Messages land in the sender's own transaction (the local devnet). */
  synchronous: boolean
  /** The hub chain's own gateway: its replica is born with the token. */
  hubChain: boolean
  ageMs: number
  canOpen: boolean
}): Availability | null {
  if (p.hasReplica) return null
  if (p.hubChain && !p.syncFailed) return null
  const gone = p.syncFailed || p.synchronous || p.ageMs > ARRIVAL_GRACE_MS
  if (!gone) return 'arriving'
  return p.canOpen ? 'closed' : 'failed'
}

/** The SYNC the hub would send: `abi.encode(uint8 10, abi.encode(bytes32
 * token, string name, string symbol))`, built by `SpawnPad._syncPayload`.
 * Encoded by the caller (viem); this is only the verdict on its price. */
export function openVerdict(quote: bigint | null, cap: bigint): { ok: boolean; why?: 'too-dear' | 'unpriced' } {
  if (quote === null) return { ok: false, why: 'unpriced' }
  return quote <= cap ? { ok: true } : { ok: false, why: 'too-dear' }
}

/* ------------------------------------------------------------------ */
/* Moving a claim                                                      */
/* ------------------------------------------------------------------ */

/** What the wallet holds on one chain, and what that chain's vault can pay. */
export interface ClaimState {
  /** oUSD claim held, 18-decimal wei. */
  claim: bigint
  /** The vault's own dollars, in its token's smallest units. */
  liquidity: bigint
  /** oUSD wei per smallest unit of the vault's dollar. */
  scale: bigint
}

/** Below this a claim is dust nobody can act on: a cent. */
export const CLAIM_DUST = 10n ** 16n

/** A claim the local vault cannot pay in full: worth offering a move. */
export function stuckClaim(s: ClaimState): boolean {
  return s.claim >= CLAIM_DUST && s.liquidity * s.scale < s.claim
}

export interface MoveRoute {
  chain: string
  /** The source gateway's `quoteMove(dst)`, or null: "GW: route closed". */
  fee: bigint | null
  /** The destination vault's dollars, in ITS units, and its scale. */
  liquidity: bigint
  scale: bigint
}

/** The destinations a claim of `amount` wei can be moved to: a priced
 * route, and a vault there that holds enough to pay it in full now. */
export function moveTargets(amount: bigint, routes: MoveRoute[]): MoveRoute[] {
  return routes.filter((r) => r.fee !== null && r.liquidity * r.scale >= amount)
}
