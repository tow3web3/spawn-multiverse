import { useEffect, useMemo, useState } from 'react'
import { useStore, shortAddr, BURNER, type Side, type FeeMode } from '../store'
import { CHAINS } from '../lib/chains'
import { LINK_META, linkHref } from '../lib/links'
import {
  creatureNum,
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

const label = 'font-mono text-[10px] font-bold tracking-[0.15em] text-white/50'
const card = 'rounded-2xl border-2 border-white/15 bg-ink/60 p-4'

export function TokenPage({ num, onBack }: { num: number; onBack: () => void }) {
  const { mode, creatures, wallet, connect, trade, getQuote, getMarket } = useStore()
  const c = creatures.find((x) => x.num === num)
  const market = getMarket(num)

  const [side, setSide] = useState<Side>('buy')
  const [chain, setChain] = useState('solana')
  const [usdStr, setUsdStr] = useState('50')
  const [pct, setPct] = useState(50)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [num])

  const pos = wallet?.positions[num]
  const usd = Number.parseFloat(usdStr) || 0
  const sellTokens = pos ? (pos.tokens * pct) / 100 : 0
  const amount = side === 'buy' ? usd : sellTokens
  const q = useMemo(
    () => getQuote(num, side, amount),
    // re-quote whenever the market moves
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getQuote, num, side, amount, c?.price],
  )

  if (!c || !market) {
    return (
      <div className="border-b-3 border-ink bg-void px-4 py-24 text-center text-white">
        <p className="font-display text-3xl tracking-wide">TOKEN NOT FOUND</p>
        <button
          onClick={onBack}
          className="mt-6 rounded-xl border-3 border-ink bg-lime px-6 py-3 font-mono text-[12px] font-bold text-ink shadow-brutal"
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

  const doTrade = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (!wallet) {
        await connect()
        setMsg({ ok: true, text: 'WALLET CONNECTED — HIT IT AGAIN TO TRADE.' })
        return
      }
      const r = await trade(num, side, amount, chain)
      if (r.ok) {
        setMsg({
          ok: true,
          text:
            side === 'buy'
              ? `BOUGHT ${fmtTokens(r.tokens)} $${c.ticker} ON ${chain.toUpperCase()} FOR ${fmtUsd(r.usd)}${r.ascended ? ' — IT ASCENDED! ⬆' : ''}`
              : `SOLD ${fmtTokens(r.tokens)} $${c.ticker} ON ${chain.toUpperCase()} FOR ${fmtUsd(r.usd)}`,
        })
      } else {
        setMsg({ ok: false, text: r.reason.toUpperCase() })
      }
    } catch {
      setMsg({ ok: false, text: 'TRANSACTION FAILED — IS THE CHAIN RUNNING?' })
    } finally {
      setBusy(false)
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
    <div className="border-b-3 border-ink bg-void text-white">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {/* top bar */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            onClick={onBack}
            className="rounded-xl border-2 border-white/25 px-4 py-2 font-mono text-[11px] font-bold tracking-wide transition hover:border-lime hover:text-lime"
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
            <span className="shrink-0 overflow-hidden rounded-full border-3 border-white/25">
              <CreatureArt c={c} size={72} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate font-display text-[clamp(1.9rem,4vw,3rem)] leading-none tracking-wide">
                  {c.name}
                </h1>
                {c.status === 'ascended' && (
                  <span className="rounded-full border-2 border-ink bg-grape px-2.5 py-1 font-mono text-[9px] font-bold text-ink">
                    ⬆ ASCENDED
                  </span>
                )}
                {c.status === 'hot' && (
                  <span className="rounded-full border-2 border-white/25 px-2.5 py-1 font-mono text-[9px] font-bold text-lime">
                    🔥 HOT
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <span className="font-mono text-[12px] font-bold text-white/50">${c.ticker}</span>
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
                        className="rounded-full border-2 border-white/20 px-2.5 py-0.5 font-mono text-[9px] font-bold tracking-wide transition hover:border-lime hover:text-lime"
                      >
                        {chip} ↗
                      </a>
                    )
                  })}
              </div>
            </div>
          </div>
          <div className="text-right">
            <p className="font-mono text-3xl font-bold text-lime">{fmtPrice(c.price)}</p>
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
            <div key={l} className="rounded-xl border-2 border-white/15 bg-ink px-3 py-2">
              <p className="font-mono text-[8.5px] font-bold tracking-[0.15em] opacity-45">{l}</p>
              <p className="font-mono text-[14px] font-bold">{v}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-[1.45fr_1fr]">
          {/* left column */}
          <div className="min-w-0 space-y-5">
            {/* chart */}
            <div className={card}>
              <p className={label}>GLOBAL PRICE — ONE CURVE, SIX CHAINS · LIVE</p>
              <div className="mt-2">
                <PriceChart points={market.history} ascendedAt={market.ascendedAt} dark height="h-64" />
              </div>
            </div>

            {/* ascension */}
            {c.status === 'ascended' ? (
              <div className="rounded-xl border-2 border-grape bg-grape/15 px-3 py-2 text-center font-mono text-[10px] font-bold tracking-wide text-white">
                ⬆ ASCENDED — CURVE FILLED, NOW TRADING ON THE OMNIPOOL
              </div>
            ) : (
              <div>
                <div className="flex justify-between font-mono text-[9px] font-bold tracking-wide opacity-60">
                  <span>ASCENSION PROGRESS</span>
                  <span>{(c.progress * 100).toFixed(1)}% — ASCENDS AT ~$86K MCAP</span>
                </div>
                <div className="mt-1 h-3 overflow-hidden rounded-full border-2 border-white/25 bg-ink">
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
                  <span className="rounded-full border-2 border-lime/60 px-2.5 py-0.5 font-mono text-[9px] font-bold tracking-wide text-lime">
                    {FEE_LABEL[feeMode]}
                  </span>
                </div>
                {fees ? (
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
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
                ) : (
                  <p className="mt-2 font-mono text-[10px] font-bold tracking-wide opacity-45">
                    FEE ROUTING IS RECORDED AT LAUNCH — ON-CHAIN ACCOUNTING LANDS WITH PROTOCOL V2.
                  </p>
                )}
              </div>
            )}

            {/* allocation */}
            {chainAlloc && (
              <div className={card}>
                <p className={label}>WHERE THE SUPPLY LIVES</p>
                <div className="mt-2 flex h-3.5 overflow-hidden rounded-full border-2 border-white/25">
                  {chainAlloc.map((ch) => (
                    <div
                      key={ch.id}
                      title={`${ch.label} ${(ch.share * 100).toFixed(0)}%`}
                      style={{ width: `${ch.share * 100}%`, background: ch.color }}
                      className="border-r border-ink/40 last:border-r-0"
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
              <div className={card}>
                <p className={label}>LIVE TAPE — EVERY CHAIN, ONE CURVE</p>
                <div className="mt-2 overflow-hidden rounded-xl border-2 border-white/15">
                  {market.trades.slice(0, 10).map((t, i) => {
                    const ch = CHAINS.find((x) => x.id === t.chain)
                    const you = wallet && t.trader === wallet.address
                    const burner = t.trader === BURNER
                    return (
                      <div
                        key={t.id}
                        className={`flex items-center gap-2.5 px-3 py-1.5 font-mono text-[10px] font-bold ${
                          i > 0 ? 'border-t border-white/10' : ''
                        } ${i % 2 ? 'bg-white/5' : 'bg-ink/40'}`}
                      >
                        <span className="w-7 opacity-45">{timeShort(t.ts)}</span>
                        <span
                          className="flex h-4 min-w-4 items-center justify-center rounded-full border border-ink px-0.5 text-[7px] text-ink"
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
                          <span className="rounded border border-tang bg-tang/20 px-1 text-[8px] text-tang">
                            🔥 BURN
                          </span>
                        )}
                        {you && (
                          <span className="rounded border border-ink bg-lime px-1 text-[8px] text-ink">
                            YOU
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
            <div className="rounded-2xl border-3 border-white/20 bg-ink p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex overflow-hidden rounded-xl border-3 border-ink">
                  {(['buy', 'sell'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => {
                        setSide(s)
                        setMsg(null)
                      }}
                      className={`px-5 py-2 font-mono text-[12px] font-bold tracking-wide text-ink transition ${
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
                <span className="font-mono text-[10px] font-bold opacity-55">
                  {wallet ? `BAL ${fmtUsd(wallet.balance)}` : 'NO WALLET'}
                </span>
              </div>

              <p className={`${label} mt-3`}>FROM WHICH CHAIN?</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {CHAINS.map((ch) => (
                  <button
                    key={ch.id}
                    onClick={() => setChain(ch.id)}
                    title={ch.label}
                    className={`rounded-lg border-2 border-ink px-2.5 py-1 font-mono text-[10px] font-bold text-ink transition ${
                      chain === ch.id ? 'shadow-brutal-sm -translate-y-0.5' : 'opacity-50 hover:opacity-100'
                    }`}
                    style={{ background: ch.color }}
                  >
                    {ch.short}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 font-mono text-[9px] font-bold opacity-45">
                SAME PRICE EVERYWHERE ✓
              </p>

              {side === 'buy' ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 rounded-xl border-2 border-white/25 bg-void px-3 py-2">
                    <span className="font-mono text-[13px] font-bold opacity-50">$</span>
                    <input
                      value={usdStr}
                      onChange={(e) => setUsdStr(e.target.value.replace(/[^0-9.]/g, ''))}
                      inputMode="decimal"
                      className="w-24 bg-transparent font-mono text-[13px] font-bold text-white outline-none"
                      aria-label="USD amount"
                    />
                  </div>
                  {QUICK_USD.map((v) => (
                    <button
                      key={v}
                      onClick={() => setUsdStr(String(v))}
                      className="rounded-lg border-2 border-white/25 px-2.5 py-1.5 font-mono text-[10px] font-bold transition hover:border-lime hover:text-lime"
                    >
                      ${v}
                    </button>
                  ))}
                  <button
                    onClick={() => wallet && setUsdStr(wallet.balance.toFixed(2))}
                    className="rounded-lg border-2 border-white/25 px-2.5 py-1.5 font-mono text-[10px] font-bold transition hover:border-lime hover:text-lime"
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
                      className={`rounded-lg border-2 px-3 py-1.5 font-mono text-[10px] font-bold transition ${
                        pct === v
                          ? 'border-candy bg-candy text-ink shadow-brutal-sm'
                          : 'border-white/25 hover:border-candy hover:text-candy'
                      }`}
                    >
                      {v}%
                    </button>
                  ))}
                  <span className="font-mono text-[10px] font-bold opacity-55">
                    = {fmtTokens(sellTokens)} ${c.ticker}
                  </span>
                </div>
              )}

              <p className="mt-2.5 font-mono text-[10px] font-bold tracking-wide opacity-70">
                {q && amount > 0
                  ? side === 'buy'
                    ? `≈ ${fmtTokens(q.tokens)} $${c.ticker} · IMPACT ${(q.impact * 100).toFixed(2)}%${q.usd < usd - 0.01 ? ` · ONLY ${fmtUsd(q.usd)} FITS THE CURVE` : ''}`
                    : `≈ ${fmtUsd(q.usd)} BACK · IMPACT ${(q.impact * 100).toFixed(2)}%`
                  : '—'}
              </p>

              <button
                onClick={() => void doTrade()}
                disabled={busy || (wallet !== null && (amount <= 0 || (side === 'sell' && !pos?.tokens)))}
                className={`mt-3 w-full rounded-xl border-3 border-ink px-6 py-3 font-mono text-[13px] font-bold tracking-wide text-ink shadow-brutal transition hover:-translate-y-0.5 hover:shadow-brutal-lg active:translate-y-0 active:shadow-brutal disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-brutal ${
                  side === 'buy' ? 'bg-lime' : 'bg-candy'
                }`}
              >
                {busy
                  ? '✳ CONFIRMING…'
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

            {/* position */}
            {wallet && pos && pos.tokens > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-white/20 bg-ink px-4 py-3">
                <div>
                  <p className={label}>YOUR BAG — {shortAddr(wallet.address)}</p>
                  <p className="font-mono text-[13px] font-bold">
                    {fmtTokens(pos.tokens)} ${c.ticker}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-[13px] font-bold">{fmtUsd(posValue)}</p>
                  <p className={`font-mono text-[10px] font-bold ${pnl >= 0 ? 'text-up' : 'text-down'}`}>
                    {pnl >= 0 ? '+' : ''}
                    {fmtUsd(pnl).replace('$-', '-$')} PNL
                  </p>
                </div>
              </div>
            )}

            {/* chain sync grid */}
            <div className={card}>
              <p className={label}>ONE GLOBAL PRICE · SIX NATIVE DEPLOYMENTS</p>
              <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-2">
                {CHAINS.map((ch) => (
                  <div
                    key={ch.id}
                    className="flex items-center gap-2 rounded-lg border border-white/15 bg-ink px-2 py-1.5"
                  >
                    <span
                      className="flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-ink px-0.5 font-mono text-[8px] font-bold text-ink"
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

            {mode === 'sim' && (
              <p className="text-center font-mono text-[9px] font-bold tracking-wide opacity-40">
                DEMO MARKET — REAL CURVE MATH, FICTIONAL MONEY. NO TRANSACTION IS SUBMITTED.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
