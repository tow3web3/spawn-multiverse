import { useEffect, useMemo, useState } from 'react'
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
} from '../store'
import { CHAINS } from '../lib/chains'
import { useChainSet } from '../lib/liveChains'
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
import { PriceChart } from './PriceChart'

const QUICK_USD = [10, 50, 100]
const QUICK_PCT = [25, 50, 75, 100]

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
  // a deployment runs the chains its manifest lists (mainnet v1: three)
  const chainSet = useChainSet()
  const liveChains = chainSet.live
  const info = onchain?.chainInfo
  useEffect(() => {
    if (!liveChains.length || liveChains.some((c) => c.id === chain)) return
    // start from the hub chain's own gateway when there is one: it is instant
    setChain(liveChains.find((c) => info?.[c.id]?.local)?.id ?? liveChains[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onchain?.chains?.join(), chain])
  const [usdStr, setUsdStr] = useState('50')
  const [pct, setPct] = useState(50)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [claimBusy, setClaimBusy] = useState(false)
  const [claimedMsg, setClaimedMsg] = useState<string | null>(null)
  /** Which holder-fee side action is running: `pull:<chain>` / `park:<chain>`. */
  const [sideBusy, setSideBusy] = useState<string | null>(null)
  const [sideMsg, setSideMsg] = useState<{ at: 'fees' | 'bag'; ok: boolean; text: string } | null>(null)

  useEffect(() => {
    window.scrollTo(0, 0)
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
      const r = await trade(num, side, amount, chain)
      if (r.ok) {
        const head = r.pending
          ? `${side === 'buy' ? 'BUY' : 'SELL'} SENT FROM ${chain.toUpperCase()} (≈ ${fmtTokens(r.tokens)} $${c.ticker})`
          : side === 'buy'
            ? `BOUGHT ${fmtTokens(r.tokens)} $${c.ticker} ON ${chain.toUpperCase()} FOR ${fmtUsd(r.usd)}${r.ascended ? ' — IT ASCENDED! ⬆' : ''}`
            : `SOLD ${fmtTokens(r.tokens)} $${c.ticker} ON ${chain.toUpperCase()} FOR ${fmtUsd(r.usd)}`
        setMsg({ ok: true, text: r.note ? `${head} · ${r.note}` : head })
      } else {
        setMsg({ ok: false, text: r.reason.toUpperCase() })
      }
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
              GLOBAL PRICE — ONE CURVE, {chainSet.word} CHAIN{chainSet.count === 1 ? '' : 'S'} · LIVE
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
                          PAID IN oUSD — SPEND IT AS-IS OR UNWRAP IT TO USDC IN YOUR PORTFOLIO
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
                          <p className="font-mono text-[8.5px] font-bold tracking-wide opacity-55">
                            WAITING ON THE HUB FOR {chainId.toUpperCase()} HOLDERS
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
                {chainAlloc.map((ch) => (
                  <div
                    key={ch.id}
                    title={`${ch.label} ${(ch.share * 100).toFixed(0)}%`}
                    style={{ width: `${ch.share * 100}%`, background: ch.color }}
                    className="border-r border-ink/30 last:border-r-0"
                  />
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[8.5px] font-bold opacity-55">
                {chainAlloc.map((ch) => (
                  <span key={ch.id}>
                    {ch.short} {(ch.share * 100).toFixed(0)}%
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
                      <span
                        className="flex h-4 min-w-4 items-center justify-center rounded-full border border-ink px-0.5 text-[7px]"
                        style={{ background: ch?.color }}
                      >
                        {ch?.short}
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
                    ? `${fmtUsd(ci.usdc)} USDC + ${fmtUsd(ci.ousd)} oUSD on ${chain.toUpperCase()} · ${fmtUsd(wallet?.balance ?? 0)} across all chains`
                    : undefined
                }
              >
                {!wallet
                  ? 'NO WALLET'
                  : ci
                    ? `${fmtUsd(chainUsd)} ON ${chain.toUpperCase()}`
                    : `BAL ${fmtUsd(wallet.balance)}`}
              </span>
            </div>

            <p className={`${label} mt-3`}>FROM WHICH CHAIN?</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {liveChains.map((ch) => (
                <button
                  key={ch.id}
                  onClick={() => setChain(ch.id)}
                  title={info?.[ch.id]?.local ? `${ch.label} — instant, no cross-chain wait` : ch.label}
                  className={`rounded-lg border-2 border-ink px-2.5 py-1 font-mono text-[10px] font-bold transition ${
                    chain === ch.id ? 'shadow-brutal-sm -translate-y-0.5' : 'opacity-50 hover:opacity-100'
                  }`}
                  style={{ background: ch.color }}
                >
                  {ch.short}
                  {info?.[ch.id]?.local ? ' ⚡' : ''}
                </button>
              ))}
            </div>
            <p className="mt-1.5 font-mono text-[9px] font-bold opacity-45">
              SAME PRICE EVERYWHERE ✓
              {onchain && onchain.network !== 'local'
                ? instant
                  ? ` · ${chain.toUpperCase()} SETTLES IN ONE TRANSACTION ⚡`
                  : ` · ${chain.toUpperCase()} CROSSES LAYERZERO: 1–3 MIN`
                : ''}
            </p>

            {side === 'buy' ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 rounded-xl border-3 border-ink bg-cream/60 px-3 py-2">
                  <span className="font-mono text-[13px] font-bold opacity-50">$</span>
                  <input
                    value={usdStr}
                    onChange={(e) => setUsdStr(e.target.value.replace(/[^0-9.]/g, ''))}
                    inputMode="decimal"
                    className="w-24 bg-transparent font-mono text-[13px] font-bold outline-none"
                    aria-label="USD amount"
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

            <p className="mt-2.5 font-mono text-[10px] font-bold tracking-wide opacity-70">
              {q && amount > 0
                ? side === 'buy'
                  ? `≈ ${fmtTokens(q.tokens)} $${c.ticker} · IMPACT ${(q.impact * 100).toFixed(2)}%${q.usd < usd - 0.01 ? ` · ONLY ${fmtUsd(q.usd)} FITS THE CURVE` : ''}`
                  : `≈ ${fmtUsd(q.usd)} BACK · IMPACT ${(q.impact * 100).toFixed(2)}%`
                : '—'}
            </p>
            {fgActive && side === 'buy' && (
              <p className="mt-1 font-mono text-[9px] font-bold tracking-wide text-down">
                🛡 FAIR GENESIS TAX {((FEE_RATE + fgTax) * 100).toFixed(1)}% APPLIES
                {usd > fgRoom ? ` · CAPPED AT ${fmtUsd(fgRoom)} FOR YOUR WALLET` : ''}
              </p>
            )}

            {/* what the signature will cost, before it is asked for */}
            {onchain && onchain.status === 'ready' && ci && (
              <p className="mt-1 font-mono text-[9px] font-bold tracking-wide opacity-60">
                {onchain.sponsored
                  ? 'NETWORK FEE: SPONSORED ON THIS TESTNET — YOU ONLY PAY GAS'
                  : netFee > 0
                    ? `NETWORK FEE ≈ ${fmtFee(netFee)} + GAS${instant ? '' : ' · PAYS THE LAYERZERO ROUND TRIP, NOT REFUNDABLE'}`
                    : instant && onchain.network !== 'local'
                      ? 'NO MESSAGE FEE FROM THIS CHAIN — YOU ONLY PAY GAS'
                      : 'NO NETWORK FEE — YOU ONLY PAY GAS'}
                {side === 'buy' && onchain.network !== 'local' ? ' · USDC IS APPROVED FOR THIS EXACT AMOUNT' : ''}
              </p>
            )}
            {buyBlocked && (
              <p className="mt-1 font-mono text-[9px] font-bold tracking-wide text-down">
                ⏸ {onchain?.hubPaused ? 'THE HUB IS PAUSED' : `${chain.toUpperCase()} IS PAUSED`} — NEW BUYS ARE
                CLOSED. SELLING STAYS OPEN.
              </p>
            )}

            <button
              onClick={() => void doTrade()}
              disabled={
                busy ||
                (wallet !== null && (amount <= 0 || (side === 'sell' && bagHere <= 0) || buyBlocked))
              }
              className={`mt-3 w-full rounded-xl border-3 border-ink px-6 py-3 font-mono text-[13px] font-bold tracking-wide shadow-brutal transition hover:-translate-y-0.5 hover:shadow-brutal-lg active:translate-y-0 active:shadow-brutal disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-brutal ${
                side === 'buy' ? 'bg-lime' : 'bg-candy'
              }`}
            >
              {busy
                ? instant
                  ? '✳ CONFIRMING…'
                  : '✳ CROSSING CHAINS — 1 TO 3 MIN…'
                : !wallet
                  ? '◉ CONNECT WALLET TO TRADE'
                  : side === 'buy'
                    ? `BUY $${c.ticker} ON ${chain.toUpperCase()} ↗`
                    : `SELL $${c.ticker} ON ${chain.toUpperCase()} ↘`}
            </button>

            {msg && (
              <p
                className={`mt-2 text-center font-mono text-[10px] font-bold tracking-wide ${
                  msg.ok ? 'text-up' : 'text-down'
                }`}
              >
                {msg.text}
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
                <p className={label}>PARKED ON {chainId.toUpperCase()} — YOURS TO CLAIM</p>
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
                  <p className="font-mono text-[9px] font-bold tracking-wide opacity-50">
                    {Object.entries(bagsByChain)
                      .map(([id, t]) => `${fmtTokens(t)} ON ${id.toUpperCase()}`)
                      .join(' · ')}
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
              ONE GLOBAL PRICE · {liveChains.length === 6 ? 'SIX' : liveChains.length} NATIVE DEPLOYMENTS
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-2">
              {liveChains.map((ch) => (
                <div
                  key={ch.id}
                  className="flex items-center gap-2 rounded-lg border-2 border-ink/20 bg-cream/60 px-2 py-1.5"
                >
                  <span
                    className="flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-ink px-0.5 font-mono text-[8px] font-bold"
                    style={{ background: ch.color }}
                  >
                    {ch.short}
                  </span>
                  <span className="font-mono text-[10px] font-bold">{fmtPrice(c.price)}</span>
                  <span className="ml-auto font-mono text-[8px] font-bold text-up">✓</span>
                </div>
              ))}
            </div>
          </div>

          <p className="text-center font-mono text-[9px] font-bold tracking-wide opacity-40">
            {mode === 'sim'
              ? 'DEMO MARKET — REAL CURVE MATH, FICTIONAL MONEY. NO TRANSACTION IS SUBMITTED.'
              : onchain?.network === 'mainnet'
                ? 'MAINNET — REAL USDC, UNAUDITED CONTRACTS, CAPPED VAULTS. ONLY WHAT YOU CAN LOSE.'
                : onchain?.network === 'testnet'
                  ? 'PUBLIC TESTNET — REAL CONTRACTS AND REAL TRANSACTIONS, PLAY MONEY.'
                  : 'LOCAL DEVNET — REAL CONTRACTS ON YOUR OWN NODE, PLAY MONEY.'}
          </p>
        </div>
      </div>
    </div>
  )
}
