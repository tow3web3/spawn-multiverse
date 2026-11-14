import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useStore,
  shortAddr,
  BURNER,
  FEE_RATE,
  GENESIS_MAX_USD,
  GENESIS_WINDOW_MS,
  SNIPE_MAX_RATE,
  type Side,
  type FeeMode,
  type TradeResult,
} from '../store'
import { CHAINS } from '../lib/chains'
import { chainName, dollarOn, useChainSet } from '../lib/liveChains'
import { LINK_META, linkHref } from '../lib/links'
import {
  creatureNum,
  fmtActor,
  fmtChange,
  fmtMoney,
  fmtNum,
  fmtPrice,
  fmtTokens,
  fmtUsd,
  timeShort,
} from '../lib/format'
import { CreatureArt } from './CreatureCard'
import { ChainLogo, CoinLogo, coinOf } from './ChainLogos'
import { PriceChart } from './PriceChart'
import { OpenToken } from './OpenToken'
import { ttlText } from '../lib/v72'

const QUICK_USD = [10, 50, 100]
const QUICK_PCT = [25, 50, 75, 100]
/** Price tolerances offered for a protected trade, in bps. */
const QUICK_BPS = [50, 100, 200, 500]

export const FEE_LABEL: Record<FeeMode, string> = {
  holders: '💚 100% TO HOLDERS',
  split: '🤝 50/50 HOLDERS & DEV',
  dev: '👑 100% TO DEV',
  burn: '🔥 AUTO BUYBACK & BURN',
}

const label = 'font-mono text-[10px] font-bold tracking-[0.15em] opacity-60'
const card = 'rounded-2xl border-3 border-ink bg-white p-4 shadow-brutal-sm'

export function TokenPage({ num, onBack }: { num: number; onBack: () => void }) {
  const { mode, creatures, wallet, connect, trade, getQuote, getMarket, onchain } = useStore()
  const c = creatures.find((x) => x.num === num)
  const market = getMarket(num)

  const [side, setSide] = useState<Side>('buy')
  const [chain, setChain] = useState('solana')
  // a deployment runs the chains its manifest lists — never more
  const chainSet = useChainSet()
  const liveChains = chainSet.live
  const info = onchain?.chainInfo
  // the dollar of the SELECTED chain: labels, decimals and approvals follow it
  const dollar = dollarOn(chain, info)
  useEffect(() => {
    if (!liveChains.length || liveChains.some((c) => c.id === chain)) return
    // start from the hub chain's own gateway when there is one: it is instant
    setChain(liveChains.find((c) => info?.[c.id]?.local)?.id ?? liveChains[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onchain?.chains?.join(), chain])
  const [usdStr, setUsdStr] = useState('50')
  const [pct, setPct] = useState(50)
  /** `neutral`: it came back whole (refused at its minimum) — not an error. */
  const [msg, setMsg] = useState<{ ok: boolean; text: string; retry?: boolean; neutral?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [customBps, setCustomBps] = useState('')
  const [claimBusy, setClaimBusy] = useState(false)
  const [claimedMsg, setClaimedMsg] = useState<string | null>(null)
  /** Which holder-fee side action is running: `pull:<chain>` / `park:<chain>`. */
  const [sideBusy, setSideBusy] = useState<string | null>(null)
  const [sideMsg, setSideMsg] = useState<{ at: 'fees' | 'bag'; ok: boolean; text: string } | null>(null)

  /** The token on screen — a late hub verdict only speaks on its own page. */
  const numRef = useRef(num)
  numRef.current = num
  useEffect(() => {
    window.scrollTo(0, 0)
    // another token: the last trade's verdict does not belong to it
    setMsg(null)
    setSideMsg(null)
    setClaimedMsg(null)
  }, [num])

  // One ticking clock, for the FAIR GENESIS countdown & live tax readout.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const pos = wallet?.positions[num]
  const usd = Number.parseFloat(usdStr) || 0
  // On-chain a bag is chain-native: a sell only reaches the tokens held on
  // the chain it is sent from, so the percentage applies to THAT bag.
  const bagsByChain = onchain?.bags?.[num]
  const bagHere = onchain ? (bagsByChain?.[chain] ?? 0) : (pos?.tokens ?? 0)
  const sellTokens = (bagHere * pct) / 100
  const amount = side === 'buy' ? usd : sellTokens
  const q = useMemo(
    () => getQuote(num, side, amount),
    // re-quote whenever the market moves
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getQuote, num, side, amount, c?.price],
  )
  // On-chain: what the hub will do with it, by its own arithmetic — fee,
  // FAIR GENESIS tax and cap included — and the minimum a protected trade
  // insists on. Re-done whenever the market, the chain or the tolerance moves.
  const slippageBps = onchain?.slippage?.bps ?? 200
  const exp = useMemo(
    () => (onchain?.expect ? onchain.expect(num, side, amount, chain) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onchain?.expect, num, side, amount, chain, c?.price, slippageBps, wallet?.balance],
  )
  /** This token cannot be traded on the selected chain yet (v7.1: its SYNC
   * is still crossing, or failed and waits for the operator). */
  const unavailableHere = onchain?.unavailable?.[num]?.[chain]
  /** FAIR GENESIS: this wallet's window cap is used up — a buy would put
   * nothing to work, so it is closed and explained instead of signed. */
  const capUsedUp =
    side === 'buy' && !!wallet && !!exp && amount > 0 && (exp.spend ?? 1) <= 0 && (exp.clamped ?? 0) > 0

  if (!c || !market) {
    return (
      <div className="px-4 py-24 text-center">
        <p className="font-display text-3xl tracking-wide">TOKEN NOT FOUND</p>
        <button
          onClick={onBack}
          className="mt-6 rounded-xl border-3 border-ink bg-lime px-6 py-3 font-mono text-[12px] font-bold shadow-brutal"
        >
          ← BACK TO THE PIT
        </button>
      </div>
    )
  }

  const posValue = pos ? pos.tokens * c.price : 0
  const rawPnl = pos ? posValue - pos.cost : 0
  const pnl = Math.abs(rawPnl) < 0.005 ? 0 : rawPnl
  const fees = c.fees
  const feeMode = c.feeMode ?? fees?.mode

  // FAIR GENESIS (v6): the anti-snipe window, mirrored from the hub's rules.
  const fgChain = onchain?.fairGenesis?.[num]
  const fgEndsAt = fgChain?.endsAt ?? c.spawnedAt + GENESIS_WINDOW_MS
  const fgActive = now < fgEndsAt
  // never more than the whole window: a clock a few seconds off must not
  // print a tax above the maximum
  const fgRemaining = Math.min(GENESIS_WINDOW_MS, Math.max(0, fgEndsAt - now))
  const fgTax = fgActive ? (SNIPE_MAX_RATE * fgRemaining) / GENESIS_WINDOW_MS : 0
  const fgSpent =
    fgChain?.spentUsd ??
    (wallet ? (market.genesisSpent?.get(wallet.address) ?? 0) : 0)
  const fgCap = fgChain?.capUsd ?? GENESIS_MAX_USD
  const fgRoom = Math.max(0, fgCap - fgSpent)
  const fgLeft = Math.ceil(fgRemaining / 1000)
  const fgCountdown = `${Math.floor(fgLeft / 60)}:${String(fgLeft % 60).padStart(2, '0')}`

  // The selected chain, as the connected wallet sees it (on-chain modes).
  const ci = info?.[chain]
  /** A one-node devnet or the hub chain's own gateway: one transaction, no wait. */
  const instant = !onchain || onchain.network === 'local' || !!ci?.local
  const chainUsd = ci ? ci.usdc + ci.ousd : (wallet?.balance ?? 0)
  // what the provider will attach: a live LayerZero quote gets 10% headroom
  const rawFee = ci ? (side === 'buy' ? ci.fee.buy : ci.fee.sell) : 0
  const netFee = instant ? rawFee : rawFee * 1.1
  const buyBlocked = side === 'buy' && (!!onchain?.hubPaused || !!ci?.paused)
  const fmtFee = (n: number) => `${n.toFixed(n < 0.001 ? 6 : 5)} ${ci?.nativeSymbol ?? 'ETH'}`
  const feeCoin = coinOf(ci?.nativeSymbol ?? 'ETH')

  const hf = onchain?.holderFees?.[num]
  const claimableNow = onchain?.holderRewards?.[num] ?? 0
  const waiting = Object.entries(hf?.waiting ?? {}).filter(([, w]) => w.pot > 0.005)
  const parked = Object.entries(onchain?.parked?.[num] ?? {}).filter(([, t]) => t > 0)

  const doTrade = async () => {
    if (busy) return
    setBusy(true)
    setMsg(null)
    try {
      if (!wallet) {
        await connect()
        setMsg({ ok: true, text: 'WALLET CONNECTED — HIT IT AGAIN TO TRADE.' })
        return
      }
      // what was traded where — the message must not follow later clicks
      const sd = side
      const ch = chain.toUpperCase()
      const sym = onchain ? ` ${dollar.symbol}` : ''
      const forNum = num
      const show = (r: TradeResult) => {
        if (r.ok) {
          const head = r.pending
            ? `${sd === 'buy' ? 'BUY' : 'SELL'} SENT FROM ${ch} (≈ ${fmtTokens(r.tokens)} $${c.ticker})`
            : r.arriving
              ? sd === 'buy'
                ? `FILLED AT THE HUB: ${fmtTokens(r.tokens)} $${c.ticker} FOR ${fmtUsd(r.usd)}${sym}${r.ascended ? ' — IT ASCENDED! ⬆' : ''}`
                : `FILLED AT THE HUB: SOLD ${fmtTokens(r.tokens)} $${c.ticker} FOR ${fmtUsd(r.usd)}${sym}`
              : sd === 'buy'
                ? `BOUGHT ${fmtTokens(r.tokens)} $${c.ticker} ON ${ch} FOR ${fmtUsd(r.usd)}${sym}${r.ascended ? ' — IT ASCENDED! ⬆' : ''}`
                : `SOLD ${fmtTokens(r.tokens)} $${c.ticker} ON ${ch} FOR ${fmtUsd(r.usd)}${sym}`
          setMsg({ ok: true, text: r.note ? `${head} · ${r.note}` : head })
          // the hub's answer to an order still crossing replaces this message
          if (r.later)
            void r.later.then((v) => {
              if (numRef.current === forNum) show(v)
            })
        } else {
          // the protection doing its job: nothing moved (or it came back
          // whole from the hub) — said plainly, with a retry
          setMsg({
            ok: false,
            text: r.reason.toUpperCase(),
            retry: r.code === 'min-out' || r.code === 'returned',
            neutral: r.code === 'min-out' || r.code === 'returned',
          })
        }
      }
      show(await trade(num, side, amount, chain))
    } catch {
      setMsg({ ok: false, text: 'TRANSACTION FAILED — IS THE CHAIN RUNNING?' })
    } finally {
      setBusy(false)
    }
  }

  const doPull = async (chainId: string) => {
    if (sideBusy || !onchain?.pullHolderFees) return
    setSideBusy(`pull:${chainId}`)
    setSideMsg(null)
    try {
      const r = await onchain.pullHolderFees(num, chainId)
      setSideMsg(
        r.ok
          ? {
              at: 'fees',
              ok: true,
              text: `PULL SENT FROM ${chainId.toUpperCase()} — THE FEES LAND IN A FEW MINUTES, THEN CLAIM.`,
            }
          : { at: 'fees', ok: false, text: (r.reason ?? 'PULL FAILED').toUpperCase() },
      )
    } finally {
      setSideBusy(null)
    }
  }

  const doClaimParked = async (chainId: string) => {
    if (sideBusy || !onchain?.claimParked) return
    setSideBusy(`park:${chainId}`)
    setSideMsg(null)
    try {
      const got = await onchain.claimParked(num, chainId)
      if (got > 0)
        setSideMsg({
          at: 'bag',
          ok: true,
          text: `${fmtTokens(got)} $${c.ticker} DELIVERED ON ${chainId.toUpperCase()} ✓`,
        })
    } catch {
      setSideMsg({
        at: 'bag',
        ok: false,
        text: 'NOT YET — THE TOKEN IS STILL ARRIVING ON THAT CHAIN. TRY AGAIN IN A MINUTE.',
      })
    } finally {
      setSideBusy(null)
    }
  }

  const chainAlloc = (() => {
    const total = Object.values(market.chainTokens).reduce((a, b) => a + b, 0)
    if (total <= 0) return null
    return CHAINS.map((ch) => ({
      ...ch,
      share: (market.chainTokens[ch.id] ?? 0) / total,
    })).filter((ch) => ch.share > 0.001)
  })()

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* top bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          onClick={onBack}
          className="rounded-xl border-2 border-ink bg-white px-4 py-2 font-mono text-[11px] font-bold tracking-wide shadow-brutal-sm transition hover:-translate-y-0.5 hover:bg-lime"
        >
          ← THE PIT
        </button>
        <span className="font-mono text-[10px] font-bold tracking-[0.2em] opacity-50">
          {creatureNum(c.num)} · GLOBAL TOKEN PAGE
        </span>
      </div>

      {/* identity */}
      <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <span
            className="shrink-0 overflow-hidden rounded-full border-3 border-ink shadow-brutal-sm"
            style={{ background: c.color }}
          >
            <CreatureArt c={c} size={72} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate font-display text-[clamp(1.9rem,4vw,3rem)] leading-none tracking-wide">
                {c.name}
              </h1>
              {c.status === 'ascended' && (
                <span className="rounded-full border-2 border-ink bg-grape px-2.5 py-1 font-mono text-[9px] font-bold shadow-brutal-sm">
                  ⬆ ASCENDED
                </span>
              )}
              {c.status === 'hot' && (
                <span className="rounded-full border-2 border-ink bg-tang px-2.5 py-1 font-mono text-[9px] font-bold shadow-brutal-sm">
                  🔥 HOT
                </span>
              )}
              {fgActive && (
                <span className="rounded-full border-2 border-ink bg-lime px-2.5 py-1 font-mono text-[9px] font-bold shadow-brutal-sm tabular-nums">
                  🛡 FAIR GENESIS {fgCountdown}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[12px] font-bold opacity-50">${c.ticker}</span>
              {c.links &&
                LINK_META.map(({ kind, chip }) => {
                  const value = c.links?.[kind]
                  if (!value) return null
                  return (
                    <a
                      key={kind}
                      href={linkHref(kind, value)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-full border-2 border-ink bg-white px-2.5 py-0.5 font-mono text-[9px] font-bold tracking-wide shadow-brutal-sm transition hover:-translate-y-0.5 hover:bg-lime"
                    >
                      {chip} ↗
                    </a>
                  )
                })}
            </div>
          </div>
        </div>
        <div className="text-right">
          <p className="font-mono text-3xl font-bold">{fmtPrice(c.price)}</p>
          <p className={`font-mono text-[13px] font-bold ${c.change >= 0 ? 'text-up' : 'text-down'}`}>
            {fmtChange(c.change)}
          </p>
        </div>
      </div>

      {/* stats strip */}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['GLOBAL MCAP', fmtMoney(c.mcap)],
          ['VOLUME', fmtMoney(c.volume)],
          ['HOLDERS', fmtNum(c.holders)],
          ['SUPPLY', fmtNum(c.supply)],
        ].map(([l, v]) => (
          <div key={l} className="rounded-xl border-2 border-ink bg-white px-3 py-2 shadow-brutal-sm">
            <p className="font-mono text-[8.5px] font-bold tracking-[0.15em] opacity-45">{l}</p>
            <p className="font-mono text-[14px] font-bold">{v}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1.45fr_1fr]">
        {/* left column */}
        <div className="min-w-0 space-y-5">
          {/* chart — the one dark, framed block of the page */}
          <div className="rounded-2xl border-3 border-ink bg-void p-4 text-white shadow-brutal">
            <p className="font-mono text-[10px] font-bold tracking-[0.15em] text-lime">
              <span className="mr-1.5 inline-block h-2 w-2 animate-blink rounded-full bg-lime align-middle" />
              GLOBAL PRICE — ONE CURVE, EVERY CHAIN · LIVE
            </p>
            <div className="mt-2">
              <PriceChart points={market.history} ascendedAt={market.ascendedAt} dark height="h-64" />
            </div>
          </div>

          {/* ascension */}
          {c.status === 'ascended' ? (
            <div className="rounded-xl border-3 border-ink bg-grape px-3 py-2 text-center font-mono text-[10px] font-bold tracking-wide shadow-brutal-sm">
              ⬆ ASCENDED — CURVE FILLED, NOW TRADING ON THE OMNIPOOL
            </div>
          ) : (
            <div>
              <div className="flex justify-between font-mono text-[9px] font-bold tracking-wide opacity-60">
                <span>ASCENSION PROGRESS</span>
                <span>{(c.progress * 100).toFixed(1)}% — ASCENDS AT ~$86K MCAP</span>
              </div>
              <div className="mt-1 h-3 overflow-hidden rounded-full border-2 border-ink bg-white">
                <div
                  className="h-full bg-lime transition-all duration-700"
                  style={{ width: `${Math.max(1.5, c.progress * 100)}%` }}
                />
              </div>
            </div>
          )}

          {/* fees */}
          {feeMode && (
            <div className={card}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className={label}>TRADING FEES — 1% ON EVERY TRADE</p>
                <span className="rounded-full border-2 border-ink bg-lime px-2.5 py-0.5 font-mono text-[9px] font-bold tracking-wide shadow-brutal-sm">
                  {FEE_LABEL[feeMode]}
                </span>
              </div>
              {fees ? (
                <>
                  <div className="mt-3 grid grid-cols-2 gap-2 border-t-2 border-dashed border-ink/20 pt-3 sm:grid-cols-4">
                    {[
                      ['COLLECTED', fmtMoney(fees.total)],
                      ['TO HOLDERS', fmtMoney(fees.holders)],
                      ['TO DEV', fmtMoney(fees.dev)],
                      [
                        'BURNED',
                        fees.burnedTokens > 0
                          ? `${fmtTokens(fees.burnedTokens)} (${fmtMoney(fees.burnedUsd)})`
                          : '—',
                      ],
                    ].map(([l, v]) => (
                      <div key={l}>
                        <p className="font-mono text-[8.5px] font-bold tracking-wide opacity-45">{l}</p>
                        <p className="font-mono text-[13px] font-bold">{v}</p>
                      </div>
                    ))}
                  </div>
                  {/* the connected wallet's slice of the holder stream: what is
                      claimable on its chains right now… */}
                  {onchain?.claimHolderRewards && (claimableNow > 0.005 || claimedMsg) && (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-ink bg-lime/40 px-3 py-2">
                      <div>
                        <p className="font-mono text-[8.5px] font-bold tracking-wide opacity-55">
                          YOUR HOLDER REWARDS — CLAIMABLE NOW
                        </p>
                        <p className="font-mono text-[15px] font-bold">
                          {claimedMsg ?? fmtUsd(claimableNow)}
                        </p>
                        <p className="font-mono text-[8px] font-bold tracking-wide opacity-45">
                          PAID IN oUSD — SPEND IT AS-IS OR UNWRAP IT TO {dollar.symbol} IN YOUR PORTFOLIO
                        </p>
                      </div>
                      {claimableNow > 0.005 && (
                        <button
                          onClick={() => {
                            if (claimBusy) return
                            setClaimBusy(true)
                            setClaimedMsg(null)
                            void onchain
                              .claimHolderRewards!(num)
                              .then((got) => setClaimedMsg(got > 0 ? `CLAIMED ${fmtUsd(got)} ✓` : null))
                              .finally(() => setClaimBusy(false))
                          }}
                          disabled={claimBusy}
                          data-testid="claim-rewards"
                          className="rounded-xl border-3 border-ink bg-lime px-5 py-2.5 font-mono text-[11px] font-bold shadow-brutal-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {claimBusy ? '✳ CLAIMING…' : 'CLAIM ↓'}
                        </button>
                      )}
                    </div>
                  )}
                  {/* …and what still waits on the hub: a remote chain's slice
                      only crosses when someone there pays to pull it */}
                  {waiting.map(([chainId, w]) => {
                    const fee = info?.[chainId]?.fee.pull ?? 0
                    return (
                      <div
                        key={chainId}
                        className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-dashed border-ink/50 bg-cream/60 px-3 py-2"
                      >
                        <div>
                          <p className="flex items-center gap-1.5 font-mono text-[8.5px] font-bold tracking-wide">
                            <ChainLogo id={chainId} size={14} />
                            <span className="opacity-55">
                              WAITING ON THE HUB FOR {chainId.toUpperCase()} HOLDERS
                            </span>
                          </p>
                          <p className="font-mono text-[13px] font-bold">
                            {fmtUsd(w.pot)}{' '}
                            <span className="opacity-50">· YOUR SHARE ≈ {fmtUsd(w.share)}</span>
                          </p>
                          <p className="font-mono text-[8px] font-bold tracking-wide opacity-45">
                            ANYONE CAN PULL IT — IT THEN LANDS FOR EVERY {chainId.toUpperCase()} HOLDER
                            {onchain?.sponsored
                              ? ' · FEE SPONSORED'
                              : fee > 0
                                ? ` · COSTS ≈ ${(fee * 1.1).toFixed(5)} ${info?.[chainId]?.nativeSymbol ?? 'ETH'}`
                                : ''}
                          </p>
                        </div>
                        <button
                          onClick={() => void doPull(chainId)}
                          disabled={sideBusy !== null}
                          className="rounded-xl border-3 border-ink bg-white px-4 py-2 font-mono text-[10px] font-bold shadow-brutal-sm transition hover:-translate-y-0.5 hover:bg-lime disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {sideBusy === `pull:${chainId}` ? '✳ PULLING…' : 'PULL ↓'}
                        </button>
                      </div>
                    )
                  })}
                  {sideMsg?.at === 'fees' && (
                    <p
                      className={`mt-2 font-mono text-[9px] font-bold tracking-wide ${sideMsg.ok ? 'text-up' : 'text-down'}`}
                    >
                      {sideMsg.text}
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-2 font-mono text-[10px] font-bold tracking-wide opacity-45">
                  FEE ROUTING IS LOCKED AT LAUNCH — THE COUNTERS APPEAR WITH THE FIRST TRADE.
                </p>
              )}
            </div>
          )}

          {/* allocation */}
          {chainAlloc && (
            <div className={card}>
              <p className={label}>WHERE THE SUPPLY LIVES</p>
              <div className="mt-2 flex h-3.5 overflow-hidden rounded-full border-2 border-ink">
                {/* segments wear the chain's brand colour, so they match the logos below */}
                {chainAlloc.map((ch) => (
                  <div
                    key={ch.id}
                    title={`${ch.label} ${(ch.share * 100).toFixed(0)}%`}
                    style={{ width: `${ch.share * 100}%`, background: ch.brand }}
                    className="border-r-2 border-white last:border-r-0"
                  />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] font-bold">
                {chainAlloc.map((ch) => (
                  <span key={ch.id} className="inline-flex items-center gap-1.5" title={ch.label}>
                    <ChainLogo id={ch.id} size={15} />
                    <span className="opacity-60">{(ch.share * 100).toFixed(0)}%</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* trade tape */}
          {market.trades.length > 0 && (
            <div>
              <p className={label}>LIVE TAPE — EVERY CHAIN, ONE CURVE</p>
              <div className="mt-1.5 overflow-hidden rounded-xl border-3 border-ink shadow-brutal-sm">
                {market.trades.slice(0, 10).map((t, i) => {
                  const ch = CHAINS.find((x) => x.id === t.chain)
                  const you = wallet && t.trader === wallet.address
                  const burner = t.trader === BURNER
                  // a 32-byte identity means a non-EVM (Solana) trader
                  const wide = t.trader.startsWith('0x') && t.trader.length > 42
                  return (
                    <div
                      key={t.id}
                      className={`flex items-center gap-2.5 px-3 py-1.5 font-mono text-[10px] font-bold ${
                        i > 0 ? 'border-t border-ink/10' : ''
                      } ${i % 2 ? 'bg-cream/50' : 'bg-white'}`}
                    >
                      <span className="w-7 opacity-45">{timeShort(t.ts)}</span>
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center" title={ch?.label}>
                        {ch && <ChainLogo id={ch.id} size={15} />}
                      </span>
                      <span className={t.side === 'buy' ? 'text-up' : 'text-down'}>
                        {t.side.toUpperCase()}
                      </span>
                      <span>{fmtUsd(t.usd)}</span>
                      <span className="opacity-45">{fmtTokens(t.tokens)}</span>
                      <span className="ml-auto opacity-60">{fmtPrice(t.price)}</span>
                      {burner && (
                        <span className="rounded border border-ink bg-tang px-1 text-[8px]">
                          🔥 BURN
                        </span>
                      )}
                      {you && (
                        <span className="rounded border border-ink bg-lime px-1 text-[8px]">YOU</span>
                      )}
                      {wide && (
                        <span className="rounded border border-ink bg-white px-1 text-[8px]">
                          {fmtActor(t.trader)}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* right column — trade */}
        <div className="space-y-4">
          {fgActive && (
            <div className="rounded-2xl border-3 border-ink bg-lime p-3.5 shadow-brutal-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-[10px] font-bold tracking-[0.15em]">
                  🛡 FAIR GENESIS — ANTI-SNIPE ON
                </p>
                <span className="rounded-lg border-2 border-ink bg-white px-2 py-0.5 font-mono text-[12px] font-bold tabular-nums">
                  {fgCountdown}
                </span>
              </div>
              <p className="mt-1.5 font-mono text-[9px] font-bold leading-relaxed opacity-75">
                BLOCK 0 DOES NOT EXIST — THE SPAWN BLOCK REFUSES EVERY BUY. UNTIL THE CLOCK
                RUNS OUT, BUYS PAY A {((FEE_RATE + fgTax) * 100).toFixed(1)}% FEE (DECAYS TO
                1%) ROUTED LIKE EVERY FEE{feeMode ? ` — ${FEE_LABEL[feeMode]}` : ''} · MAX $
                {GENESIS_MAX_USD}/WALLET{fgSpent > 0 ? ` (${fmtUsd(fgSpent)} USED)` : ''}.
                SNIPERS PAY EVERYONE ELSE.
              </p>
            </div>
          )}
          <div className="rounded-2xl border-3 border-ink bg-white p-4 shadow-brutal">
            <div className="flex items-center justify-between gap-3">
              <div className="flex overflow-hidden rounded-xl border-3 border-ink">
                {(['buy', 'sell'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setSide(s)
                      setMsg(null)
                    }}
                    className={`px-5 py-2 font-mono text-[12px] font-bold tracking-wide transition ${
                      side === s
                        ? s === 'buy'
                          ? 'bg-lime'
                          : 'bg-candy'
                        : 'bg-white hover:bg-cream'
                    } ${s === 'sell' ? 'border-l-3 border-ink' : ''}`}
                  >
                    {s.toUpperCase()}
                  </button>
                ))}
              </div>
              <span
                className="text-right font-mono text-[10px] font-bold opacity-55"
                title={
                  ci
                    ? `${fmtUsd(ci.usdc)} ${dollar.symbol} + ${fmtUsd(ci.ousd)} oUSD on ${chain.toUpperCase()}${chainSet.single ? '' : ` · ${fmtUsd(wallet?.balance ?? 0)} across every chain, each in its own dollar`}`
                    : undefined
                }
              >
                {!wallet ? (
                  'NO WALLET'
                ) : ci ? (
                  <span className="inline-flex items-center gap-1">
                    <CoinLogo id={dollar.coin} size={12} />
                    {fmtUsd(chainUsd)} {dollar.symbol} ON {chain.toUpperCase()}
                  </span>
                ) : (
                  `BAL ${fmtUsd(wallet.balance)}`
                )}
              </span>
            </div>

            <p className={`${label} mt-3`}>{chainSet.single ? 'ON' : 'FROM WHICH CHAIN?'}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {liveChains.map((ch) => {
                const na = onchain?.unavailable?.[num]?.[ch.id]
                return (
                  <button
                    key={ch.id}
                    onClick={() => setChain(ch.id)}
                    title={
                      na
                        ? na === 'closed'
                          ? `${ch.label} — not open yet: open it there for a small network fee`
                          : na === 'failed'
                            ? `${ch.label} — not available yet: the token's creation message did not reach this chain`
                            : `${ch.label} — not available yet: the token is still arriving here`
                        : `${ch.label} — trades in ${dollarOn(ch.id, info).symbol}${info?.[ch.id]?.local ? ', instant, no cross-chain wait' : ''}`
                    }
                    aria-pressed={chain === ch.id}
                    data-chain={ch.id}
                    data-unavailable={na ?? undefined}
                    className={`group inline-flex items-center gap-1.5 rounded-lg border-2 py-1 pl-1.5 pr-2.5 font-mono text-[10px] font-bold transition ${
                      chain === ch.id
                        ? 'border-ink shadow-brutal-sm -translate-y-0.5'
                        : 'border-ink/30 bg-white hover:border-ink'
                    } ${na ? 'border-dashed' : ''}`}
                    style={chain === ch.id ? { background: ch.color } : undefined}
                  >
                    {/* the logo never fades: it is what identifies the chain */}
                    <span className={na ? 'grayscale' : ''}>
                      <ChainLogo id={ch.id} size={18} />
                    </span>
                    <span className={chain === ch.id ? '' : 'opacity-50 group-hover:opacity-100'}>
                      {ch.label}
                      {na === 'closed' ? ' · OPEN IT' : na ? ' · NOT YET' : info?.[ch.id]?.local ? ' ⚡' : ''}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="mt-1.5 font-mono text-[9px] font-bold opacity-45">
              {chainSet.single ? 'ONE CHAIN, ONE TRANSACTION ⚡' : 'SAME PRICE EVERYWHERE ✓'}
              {onchain && onchain.network !== 'local' && !chainSet.single
                ? instant
                  ? ` · ${chain.toUpperCase()} SETTLES IN ONE TRANSACTION ⚡`
                  : ` · ${chain.toUpperCase()} CROSSES LAYERZERO: A FEW MINUTES EACH WAY`
                : ''}
              {ci?.protected ? ' · PRICE-PROTECTED 🛡' : ''}
            </p>
            {/* v7.2: not open here — offer the open instead of a refused trade */}
            {unavailableHere === 'closed' && (
              <OpenToken num={num} chain={chain} ticker={c.ticker} onOpened={(text) => setMsg({ ok: true, text })} />
            )}
            {unavailableHere && unavailableHere !== 'closed' && (
              <p className="mt-1.5 font-mono text-[9px] font-bold tracking-wide text-down" data-testid="unavailable-here">
                {unavailableHere === 'failed'
                  ? `${c.ticker} IS NOT AVAILABLE ON ${chain.toUpperCase()} YET — ITS CREATION MESSAGE DID NOT REACH THAT CHAIN. THE OPERATOR HAS TO SEND IT AGAIN; PICK ANOTHER CHAIN MEANWHILE.`
                  : `${c.ticker} HAS NOT REACHED ${chain.toUpperCase()} YET — ITS CREATION MESSAGE IS STILL CROSSING. GIVE IT A MINUTE, OR PICK ANOTHER CHAIN.`}
              </p>
            )}

            {/* nothing to trade on a chain where the token is not open: the
                open panel above is the whole offer there */}
            {unavailableHere !== 'closed' && (
            <>
            {side === 'buy' ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 rounded-xl border-3 border-ink bg-cream/60 px-3 py-2">
                  {/* the amount is in the selected chain's own dollar */}
                  {onchain && <CoinLogo id={dollar.coin} size={15} />}
                  <span className="font-mono text-[13px] font-bold opacity-50">$</span>
                  <input
                    value={usdStr}
                    onChange={(e) => setUsdStr(e.target.value.replace(/[^0-9.]/g, ''))}
                    inputMode="decimal"
                    className="w-24 bg-transparent font-mono text-[13px] font-bold outline-none"
                    aria-label={`Amount in ${dollar.symbol}`}
                  />
                </div>
                {QUICK_USD.map((v) => (
                  <button
                    key={v}
                    onClick={() => setUsdStr(String(v))}
                    className="rounded-lg border-2 border-ink bg-white px-2.5 py-1.5 font-mono text-[10px] font-bold transition hover:bg-lime"
                  >
                    ${v}
                  </button>
                ))}
                <button
                  onClick={() => {
                    if (!wallet) return
                    // on-chain a buy spends ONE asset on ONE chain: its USDC,
                    // or its oUSD claims — whichever stack is larger
                    const max = ci ? Math.max(ci.usdc, ci.ousd) : wallet.balance
                    setUsdStr((Math.floor(max * 100) / 100).toFixed(2))
                  }}
                  className="rounded-lg border-2 border-ink bg-white px-2.5 py-1.5 font-mono text-[10px] font-bold transition hover:bg-lime"
                >
                  MAX
                </button>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {QUICK_PCT.map((v) => (
                  <button
                    key={v}
                    onClick={() => setPct(v)}
                    className={`rounded-lg border-2 border-ink px-3 py-1.5 font-mono text-[10px] font-bold transition ${
                      pct === v ? 'bg-candy shadow-brutal-sm' : 'bg-white hover:bg-candy/50'
                    }`}
                  >
                    {v}%
                  </button>
                ))}
                <span className="font-mono text-[10px] font-bold opacity-55">
                  = {fmtTokens(sellTokens)} ${c.ticker}
                  {onchain && bagHere > 0 ? ` OF YOUR ${fmtTokens(bagHere)} ON ${chain.toUpperCase()}` : ''}
                </span>
                {/* the bag lives somewhere else: say where instead of failing */}
                {onchain && wallet && bagHere <= 0 && (
                  <span className="basis-full font-mono text-[9px] font-bold tracking-wide text-down">
                    {bagsByChain && Object.keys(bagsByChain).length
                      ? `NOTHING TO SELL ON ${chain.toUpperCase()} — YOUR BAG LIVES ON ${Object.entries(bagsByChain)
                          .map(([id, t]) => `${id.toUpperCase()} (${fmtTokens(t)})`)
                          .join(' + ')}. PICK THAT CHAIN.`
                      : 'YOU HOLD NONE OF THIS TOKEN.'}
                  </span>
                )}
              </div>
            )}

            {/* what the trade does: on-chain the hub's own arithmetic (fee and
                FAIR GENESIS included); in the simulation the engine's quote */}
            <p className="mt-2.5 font-mono text-[10px] font-bold tracking-wide opacity-70" data-testid="quote-line">
              {exp && amount > 0
                ? side === 'buy'
                  ? `≈ ${fmtTokens(exp.expected)} $${c.ticker}${q ? ` · IMPACT ${(q.impact * 100).toFixed(2)}%` : ''}${
                      exp.feeRate && exp.feeRate > FEE_RATE + 0.0001 ? ` · FEE ${(exp.feeRate * 100).toFixed(1)}%` : ''
                    }${(exp.clamped ?? 0) > 0.005 ? ` · ONLY ${fmtUsd(exp.spend ?? 0)} GOES IN (FAIR GENESIS CAP)` : ''}`
                  : `≈ ${fmtUsd(exp.expected)} ${dollar.symbol} BACK${q ? ` · IMPACT ${(q.impact * 100).toFixed(2)}%` : ''}`
                : q && amount > 0
                  ? side === 'buy'
                    ? `≈ ${fmtTokens(q.tokens)} $${c.ticker} · IMPACT ${(q.impact * 100).toFixed(2)}%${q.usd < usd - 0.01 ? ` · ONLY ${fmtUsd(q.usd)} FITS THE CURVE` : ''}`
                    : `≈ ${fmtUsd(q.usd)} BACK · IMPACT ${(q.impact * 100).toFixed(2)}%`
                  : '—'}
            </p>
            {/* v7.1 price protection: the minimum, and the tolerance behind it */}
            {onchain && ci && amount > 0 && (
              <div className="mt-1.5 rounded-lg border-2 border-ink/20 bg-cream/60 px-2.5 py-1.5" data-testid="protection">
                {capUsedUp ? (
                  <p className="font-mono text-[9px] font-bold tracking-wide text-down">
                    🛡 FAIR GENESIS: THIS WALLET HAS USED ITS ${fgCap} CAP FOR THE OPENING WINDOW — NOTHING WOULD BE
                    BOUGHT. BUY AGAIN IN {fgCountdown}, WHEN THE WINDOW CLOSES.
                  </p>
                ) : ci.protected && exp ? (
                  <>
                    <p className="font-mono text-[9px] font-bold tracking-wide">
                      🛡 YOU RECEIVE AT LEAST{' '}
                      <span data-testid="min-out">
                        {side === 'buy' ? `${fmtTokens(exp.min)} $${c.ticker}` : `${fmtUsd(exp.min)} ${dollar.symbol}`}
                      </span>{' '}
                      {instant
                        ? `— OR THE TRADE CANCELS ITSELF AND NOTHING IS SPENT${onchain.network === 'mainnet' ? ' BUT GAS' : ''}.`
                        : `— OR THE HUB REFUSES IT AND ${side === 'buy' ? `YOUR ${dollar.symbol}` : 'YOUR TOKENS'} COME BACK WHOLE: ALL OR NOTHING, ${onchain.sponsored ? 'NOTHING SPENT BUT GAS' : 'ONLY THE NETWORK FEE IS SPENT'}.`}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[9px] font-bold opacity-55">TOLERANCE</span>
                      {QUICK_BPS.map((b) => (
                        <button
                          key={b}
                          type="button"
                          onClick={() => {
                            setCustomBps('')
                            onchain.slippage?.set(b)
                          }}
                          aria-pressed={slippageBps === b}
                          data-bps={b}
                          className={`rounded-md border-2 border-ink px-2 py-0.5 font-mono text-[9px] font-bold transition ${
                            slippageBps === b ? 'bg-ink text-lime' : 'bg-white hover:bg-lime'
                          }`}
                        >
                          {b / 100}%
                        </button>
                      ))}
                      <span className="inline-flex items-center gap-0.5 rounded-md border-2 border-ink bg-white px-1.5 py-0.5 font-mono text-[9px] font-bold">
                        <input
                          value={customBps}
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^0-9.]/g, '')
                            setCustomBps(v)
                            const pct = Number.parseFloat(v)
                            if (pct >= 0.1 && pct <= 50) onchain.slippage?.set(Math.round(pct * 100))
                          }}
                          placeholder={String(slippageBps / 100)}
                          inputMode="decimal"
                          aria-label="Custom tolerance in percent"
                          className="w-8 bg-transparent text-right outline-none placeholder:opacity-40"
                        />
                        %
                      </span>
                    </div>
                  </>
                ) : (
                  <p className="font-mono text-[9px] font-bold tracking-wide text-down">
                    {instant
                      ? // a one-transaction trade on a gateway older than v7.1
                        '⚠ THIS DEPLOYMENT HAS NO PRICE PROTECTION YET (PRE-7.1 GATEWAY): THE TRADE FILLS AT THE PRICE THE CURVE HAS WHEN IT EXECUTES.'
                      : // a pre-v7.2 deployment (today's public testnet)
                        `⚠ THIS DEPLOYMENT PREDATES CROSS-CHAIN PRICE PROTECTION: FROM ${chain.toUpperCase()} THE TRADE FILLS AT THE PRICE THE CURVE HAS WHEN IT LANDS ON THE HUB, MINUTES FROM NOW.${
                          liveChains.some((ch) => info?.[ch.id]?.protected)
                            ? ` TRADE FROM ${liveChains
                                .filter((ch) => info?.[ch.id]?.protected)
                                .map((ch) => ch.label)
                                .join(' / ')} FOR A PROTECTED FILL.`
                            : ''
                        }`}
                  </p>
                )}
              </div>
            )}
            {/* what this chain means for the user, said where they decide */}
            {onchain && ci && (
              <ul className="mt-1.5 space-y-0.5 font-mono text-[9px] font-bold leading-relaxed tracking-wide" data-testid="chain-notes">
                {!instant && (
                  <li>
                    ⏱ FROM {chain.toUpperCase()} THE TRADE CROSSES TO THE HUB AND BACK: A FEW MINUTES, ALL OR NOTHING AT THE
                    MINIMUM YOU SET.
                    {ci.orderTtl
                      ? ` THE ORDER IS VALID FOR ${ttlText(ci.orderTtl).toUpperCase()}; IF IT LANDS LATER IT COMES BACK WHOLE.`
                      : ''}
                  </li>
                )}
                {chain === 'bnb' && (
                  <li data-testid="bnb-note">
                    <CoinLogo id="usdt" size={11} className="-mt-0.5" /> BNB CHAIN TRADES IN BINANCE USDT, POOLED WITH THE USDC
                    OF THE OTHER CHAINS: IF USDT LOST ITS PEG, EVERYONE WOULD SHARE THE LOSS — BOUNDED BY THE BNB VAULT'S CAP
                    {ci.depositCap > 0 && ci.depositCap < 1e8
                      ? ` (${fmtMoney(ci.depositCap)} USDT)`
                      : ''}
                    .
                  </li>
                )}
                {chain === 'ethereum' && (
                  <li data-testid="eth-note">
                    ⛽ ETHEREUM: EVERY ACTION PAYS L1 GAS (DOLLARS, NOT CENTS), AND A TOKEN MAY NEED OPENING HERE FIRST.
                  </li>
                )}
              </ul>
            )}
            {fgActive && side === 'buy' && (
              <p className="mt-1 font-mono text-[9px] font-bold tracking-wide text-down">
                🛡 FAIR GENESIS TAX {((FEE_RATE + fgTax) * 100).toFixed(1)}% APPLIES
                {usd > fgRoom
                  ? fgRoom > 0
                    ? ` · YOUR WALLET HAS ${fmtUsd(fgRoom)} OF ITS $${fgCap} WINDOW CAP LEFT — THE BUY IS SIZED DOWN TO THAT`
                    : capUsedUp
                      ? '' // said in full just above
                      : ` · YOUR WALLET HAS USED ITS $${fgCap} WINDOW CAP — BUY AGAIN WHEN THE WINDOW CLOSES`
                  : ''}
              </p>
            )}

            {/* what the signature will cost, before it is asked for */}
            {onchain && onchain.status === 'ready' && ci && (
              <p className="mt-1 font-mono text-[9px] font-bold tracking-wide">
                <span className="opacity-60">
                  {onchain.sponsored ? (
                    'NETWORK FEE: SPONSORED ON THIS TESTNET — YOU ONLY PAY GAS'
                  ) : netFee > 0 ? (
                    <>NETWORK FEE ≈ </>
                  ) : instant && onchain.network !== 'local' ? (
                    'NO MESSAGE FEE FROM THIS CHAIN — YOU ONLY PAY GAS'
                  ) : (
                    'NO NETWORK FEE — YOU ONLY PAY GAS'
                  )}
                </span>
                {/* the fee is paid in the chain's gas coin: show which one */}
                {!onchain.sponsored && netFee > 0 && (
                  <>
                    {feeCoin && <CoinLogo id={feeCoin} size={13} className="-mt-0.5 mr-1" />}
                    <span className="opacity-60">
                      {fmtFee(netFee)} + GAS
                      {instant ? '' : ' · PAYS THE LAYERZERO ROUND TRIP, NOT REFUNDABLE'}
                    </span>
                  </>
                )}
                <span className="opacity-60">
                  {side === 'buy' && onchain.network !== 'local'
                    ? ` · ${dollar.symbol} IS APPROVED FOR THIS EXACT AMOUNT`
                    : ''}
                </span>
              </p>
            )}
            </>
            )}
            {buyBlocked && (
              <p className="mt-1 font-mono text-[9px] font-bold tracking-wide text-down">
                ⏸ {onchain?.hubPaused ? 'THE HUB IS PAUSED' : `${chain.toUpperCase()} IS PAUSED`} — NEW BUYS ARE
                CLOSED. SELLING STAYS OPEN.
              </p>
            )}

            {/* while the token is not open here, the open panel is the only offer */}
            {unavailableHere !== 'closed' && (
            <button
              onClick={() => void doTrade()}
              disabled={
                busy ||
                (wallet !== null &&
                  (amount <= 0 ||
                    (side === 'sell' && bagHere <= 0) ||
                    buyBlocked ||
                    !!unavailableHere ||
                    capUsedUp))
              }
              data-testid="trade-button"
              className={`mt-3 w-full rounded-xl border-3 border-ink px-6 py-3 font-mono text-[13px] font-bold tracking-wide shadow-brutal transition hover:-translate-y-0.5 hover:shadow-brutal-lg active:translate-y-0 active:shadow-brutal disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-brutal ${
                side === 'buy' ? 'bg-lime' : 'bg-candy'
              }`}
            >
              {busy
                ? instant
                  ? '✳ CONFIRMING…'
                  : '✳ CROSSING TO THE HUB — A FEW MINUTES…'
                : !wallet
                  ? '◉ CONNECT WALLET TO TRADE'
                  : side === 'buy'
                    ? `BUY $${c.ticker} ON ${chain.toUpperCase()} ↗`
                    : `SELL $${c.ticker} ON ${chain.toUpperCase()} ↘`}
            </button>
            )}

            {msg && (
              <p
                className={`mt-2 text-center font-mono text-[10px] font-bold tracking-wide ${
                  msg.ok ? 'text-up' : msg.neutral ? 'rounded-lg border-2 border-ink bg-cream px-2 py-1.5' : 'text-down'
                }`}
                data-testid="trade-msg"
              >
                {msg.text}
                {msg.retry && (
                  <button
                    type="button"
                    onClick={() => void doTrade()}
                    disabled={busy}
                    data-testid="retry-trade"
                    className="ml-2 rounded-md border-2 border-ink bg-white px-2 py-0.5 text-ink transition hover:bg-lime disabled:opacity-40"
                  >
                    TRY AGAIN ↻
                  </button>
                )}
              </p>
            )}
          </div>

          {/* deliveries that beat their token to a chain wait at the gateway */}
          {parked.map(([chainId, tokens]) => (
            <div
              key={chainId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-3 border-ink bg-tang px-4 py-3 shadow-brutal-sm"
            >
              <div>
                <p className="flex items-center gap-1.5">
                  <ChainLogo id={chainId} size={15} />
                  <span className={label}>PARKED ON {chainId.toUpperCase()} — YOURS TO CLAIM</span>
                </p>
                <p className="font-mono text-[13px] font-bold">
                  {fmtTokens(tokens)} ${c.ticker}
                </p>
              </div>
              <button
                onClick={() => void doClaimParked(chainId)}
                disabled={sideBusy !== null}
                className="rounded-xl border-3 border-ink bg-white px-4 py-2 font-mono text-[10px] font-bold shadow-brutal-sm transition hover:-translate-y-0.5 hover:bg-lime disabled:cursor-not-allowed disabled:opacity-40"
              >
                {sideBusy === `park:${chainId}` ? '✳ CLAIMING…' : 'CLAIM ↓'}
              </button>
            </div>
          ))}
          {sideMsg?.at === 'bag' && (
            <p className={`font-mono text-[9px] font-bold tracking-wide ${sideMsg.ok ? 'text-up' : 'text-down'}`}>
              {sideMsg.text}
            </p>
          )}

          {/* position */}
          {wallet && pos && pos.tokens > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-3 border-ink bg-white px-4 py-3 shadow-brutal-sm">
              <div>
                <p className={label}>YOUR BAG — {shortAddr(wallet.address)}</p>
                <p className="font-mono text-[13px] font-bold">
                  {fmtTokens(pos.tokens)} ${c.ticker}
                </p>
                {bagsByChain && Object.keys(bagsByChain).length > 0 && (
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[9px] font-bold tracking-wide">
                    {Object.entries(bagsByChain).map(([id, t]) => (
                      <span key={id} className="inline-flex items-center gap-1" title={id.toUpperCase()}>
                        <ChainLogo id={id} size={13} />
                        <span className="opacity-50">
                          {fmtTokens(t)} ON {id.toUpperCase()}
                        </span>
                      </span>
                    ))}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="font-mono text-[13px] font-bold">{fmtUsd(posValue)}</p>
                {pos.costKnown === false ? (
                  <p
                    className="font-mono text-[9px] font-bold opacity-50"
                    title="Part of this bag was not bought through this browser, so its cost is unknown here."
                  >
                    PNL UNKNOWN ON THIS DEVICE
                  </p>
                ) : (
                  <p className={`font-mono text-[10px] font-bold ${pnl >= 0 ? 'text-up' : 'text-down'}`}>
                    {pnl >= 0 ? '+' : ''}
                    {fmtUsd(pnl).replace('$-', '-$')} PNL
                  </p>
                )}
              </div>
            </div>
          )}

          {/* chain sync grid */}
          <div className={card}>
            <p className={label}>
              ONE GLOBAL PRICE · {chainSet.word} LIVE CHAIN{liveChains.length === 1 ? '' : 'S'}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-2">
              {liveChains.map((ch) => {
                const na = onchain?.unavailable?.[num]?.[ch.id]
                return (
                  <div
                    key={ch.id}
                    className={`flex items-center gap-2 rounded-lg border-2 bg-cream/60 px-2 py-1.5 ${
                      na ? 'border-dashed border-ink/30 opacity-70' : 'border-ink/20'
                    }`}
                    title={
                      na === 'closed'
                        ? `Not open on ${chainName(ch.id)} yet — anyone there can open it`
                        : na
                          ? 'Not available on this chain yet'
                          : undefined
                    }
                  >
                    <span className={na ? 'grayscale' : ''}>
                      <ChainLogo id={ch.id} size={20} />
                    </span>
                    <span className="font-mono text-[10px] font-bold">{na ? '—' : fmtPrice(c.price)}</span>
                    {na === 'closed' ? (
                      <button
                        type="button"
                        onClick={() => setChain(ch.id)}
                        className="ml-auto rounded border border-ink bg-white px-1 font-mono text-[8px] font-bold hover:bg-lime"
                      >
                        OPEN IT
                      </button>
                    ) : (
                      <span className={`ml-auto font-mono text-[8px] font-bold ${na ? 'text-down' : 'text-up'}`}>
                        {na ? 'NOT YET' : '✓'}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <p className="text-center font-mono text-[9px] font-bold tracking-wide opacity-40">
            {mode === 'sim'
              ? 'DEMO MARKET — REAL CURVE MATH, FICTIONAL MONEY. NO TRANSACTION IS SUBMITTED.'
              : onchain?.network === 'mainnet'
                ? 'MAINNET GUARDED BETA — REAL DOLLARS, UNAUDITED CONTRACTS, CAPPED VAULTS. ONLY WHAT YOU CAN LOSE.'
                : onchain?.network === 'testnet'
                  ? 'PUBLIC TESTNET — REAL CONTRACTS AND REAL TRANSACTIONS, PLAY MONEY.'
                  : 'LOCAL DEVNET — REAL CONTRACTS ON YOUR OWN NODE, PLAY MONEY.'}
          </p>
        </div>
      </div>
    </div>
  )
}
