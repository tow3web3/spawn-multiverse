import { useEffect, useMemo, useState } from 'react'
import { useStore, shortAddr, type Side } from '../store'
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
import { Sparkle } from './bits'

const QUICK_USD = [10, 50, 100]
const QUICK_PCT = [25, 50, 75, 100]

export function CreatureModal({ num, onClose }: { num: number; onClose: () => void }) {
  const { creatures, wallet, connect, trade, getQuote, getMarket } = useStore()
  const c = creatures.find((x) => x.num === num)
  const market = getMarket(num)

  const [side, setSide] = useState<Side>('buy')
  const [chain, setChain] = useState('solana')
  const [usdStr, setUsdStr] = useState('50')
  const [pct, setPct] = useState(50)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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

  if (!c || !market) return null

  const posValue = pos ? pos.tokens * c.price : 0
  const rawPnl = pos ? posValue - pos.cost : 0
  const pnl = Math.abs(rawPnl) < 0.005 ? 0 : rawPnl

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

  const label = 'font-mono text-[10px] font-bold tracking-[0.15em] opacity-60'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="my-auto w-full max-w-2xl animate-pop overflow-hidden rounded-3xl border-3 border-ink bg-white shadow-brutal-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={c.name}
      >
        {/* header */}
        <div
          className="dot-grid relative flex h-36 items-center justify-center border-b-3 border-ink"
          style={{ background: c.color }}
        >
          <span className="absolute left-4 top-3 font-mono text-[10px] font-bold opacity-60">
            {creatureNum(c.num)}
          </span>
          {c.status === 'ascended' && (
            <span className="absolute left-4 bottom-3 rounded-full border-2 border-ink bg-grape px-2.5 py-1 font-mono text-[9px] font-bold shadow-brutal-sm">
              ⬆ ASCENDED
            </span>
          )}
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full border-3 border-ink bg-white font-bold shadow-brutal-sm transition hover:rotate-90"
          >
            ✕
          </button>
          <Sparkle size={20} className="absolute left-[18%] top-[24%] animate-twinkle" />
          <Sparkle
            size={15}
            className="absolute bottom-[20%] right-[16%] animate-twinkle"
            style={{ animationDelay: '-1.4s' }}
          />
          <CreatureArt c={c} size={96} />
        </div>

        <div className="p-5">
          {/* name + price */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate font-display text-3xl tracking-wide">{c.name}</h3>
              <p className="font-mono text-[11px] font-bold opacity-50">${c.ticker}</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-xl font-bold">{fmtPrice(c.price)}</p>
              <p
                className={`font-mono text-[12px] font-bold ${c.change >= 0 ? 'text-up' : 'text-down'}`}
              >
                {fmtChange(c.change)}
              </p>
            </div>
          </div>

          {c.links && (
            <div className="mt-2 flex flex-wrap gap-2">
              {LINK_META.map(({ kind, chip }) => {
                const value = c.links?.[kind]
                if (!value) return null
                return (
                  <a
                    key={kind}
                    href={linkHref(kind, value)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-full border-2 border-ink bg-white px-3 py-1 font-mono text-[10px] font-bold tracking-wide shadow-brutal-sm transition hover:-translate-y-0.5 hover:bg-lime"
                  >
                    {chip} ↗
                  </a>
                )
              })}
            </div>
          )}

          {/* stats */}
          <div className="mt-3 grid grid-cols-3 gap-2 border-t-2 border-dashed border-ink/25 pt-3">
            {[
              ['GLOBAL MCAP', fmtMoney(c.mcap)],
              ['VOLUME', fmtMoney(c.volume)],
              ['HOLDERS', fmtNum(c.holders)],
            ].map(([l, v]) => (
              <div key={l}>
                <p className="font-mono text-[8.5px] font-bold tracking-wide opacity-45">{l}</p>
                <p className="font-mono text-[13px] font-bold">{v}</p>
              </div>
            ))}
          </div>

          {/* chart */}
          <div className="mt-4 rounded-xl border-3 border-ink p-2">
            <p className={`${label} px-1`}>GLOBAL PRICE — ONE CURVE, SIX CHAINS</p>
            <PriceChart points={market.history} ascendedAt={market.ascendedAt} />
          </div>

          {/* ascension */}
          <div className="mt-3">
            {c.status === 'ascended' ? (
              <div className="rounded-xl border-3 border-ink bg-grape px-3 py-2 text-center font-mono text-[10px] font-bold tracking-wide">
                ⬆ ASCENDED — CURVE FILLED, NOW TRADING ON THE OMNIPOOL
              </div>
            ) : (
              <div>
                <div className="flex justify-between font-mono text-[9px] font-bold tracking-wide opacity-60">
                  <span>ASCENSION PROGRESS</span>
                  <span>{(c.progress * 100).toFixed(1)}% — ASCENDS AT ~$86K MCAP</span>
                </div>
                <div className="mt-1 h-3 overflow-hidden rounded-full border-2 border-ink bg-cream">
                  <div
                    className="h-full bg-lime transition-all duration-700"
                    style={{ width: `${Math.max(1.5, c.progress * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* trade panel */}
          <div className="mt-4 rounded-2xl border-3 border-ink bg-cream/70 p-4">
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
              <span className="font-mono text-[10px] font-bold opacity-55">
                {wallet ? `BAL ${fmtUsd(wallet.balance)}` : 'NO WALLET'}
              </span>
            </div>

            {/* chain selector */}
            <p className={`${label} mt-3`}>FROM WHICH DIMENSION?</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {CHAINS.map((ch) => (
                <button
                  key={ch.id}
                  onClick={() => setChain(ch.id)}
                  title={ch.label}
                  className={`rounded-lg border-2 border-ink px-2.5 py-1 font-mono text-[10px] font-bold transition ${
                    chain === ch.id ? 'shadow-brutal-sm -translate-y-0.5' : 'opacity-50 hover:opacity-100'
                  }`}
                  style={{ background: ch.color }}
                >
                  {ch.short}
                </button>
              ))}
              <span className="ml-1 self-center font-mono text-[9px] font-bold opacity-45">
                SAME PRICE EVERYWHERE ✓
              </span>
            </div>

            {/* amount */}
            {side === 'buy' ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 rounded-xl border-3 border-ink bg-white px-3 py-2">
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
                  onClick={() => wallet && setUsdStr(wallet.balance.toFixed(2))}
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
                </span>
              </div>
            )}

            {/* quote */}
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
              className={`mt-3 w-full rounded-xl border-3 border-ink px-6 py-3 font-mono text-[13px] font-bold tracking-wide shadow-brutal transition hover:-translate-y-0.5 hover:shadow-brutal-lg active:translate-y-0 active:shadow-brutal disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-brutal ${
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
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border-3 border-ink bg-white px-4 py-3">
              <div>
                <p className={label}>YOUR BAG — {shortAddr(wallet.address)}</p>
                <p className="font-mono text-[13px] font-bold">
                  {fmtTokens(pos.tokens)} ${c.ticker}
                </p>
              </div>
              <div className="text-right">
                <p className="font-mono text-[13px] font-bold">{fmtUsd(posValue)}</p>
                <p
                  className={`font-mono text-[10px] font-bold ${pnl >= 0 ? 'text-up' : 'text-down'}`}
                >
                  {pnl >= 0 ? '+' : ''}
                  {fmtUsd(pnl).replace('$-', '-$')} PNL
                </p>
              </div>
            </div>
          )}

          {/* chain sync grid */}
          <p className={`${label} mt-4`}>ONE GLOBAL PRICE · SIX NATIVE DEPLOYMENTS</p>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {CHAINS.map((ch) => (
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

          {/* allocation */}
          {chainAlloc && (
            <div className="mt-3">
              <p className={label}>WHERE THE SUPPLY LIVES</p>
              <div className="mt-1.5 flex h-3.5 overflow-hidden rounded-full border-2 border-ink">
                {chainAlloc.map((ch) => (
                  <div
                    key={ch.id}
                    title={`${ch.label} ${(ch.share * 100).toFixed(0)}%`}
                    style={{ width: `${ch.share * 100}%`, background: ch.color }}
                    className="border-r border-ink/30 last:border-r-0"
                  />
                ))}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[8.5px] font-bold opacity-55">
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
            <div className="mt-4">
              <p className={label}>LIVE TAPE — EVERY CHAIN, ONE CURVE</p>
              <div className="mt-1.5 overflow-hidden rounded-xl border-3 border-ink">
                {market.trades.slice(0, 8).map((t, i) => {
                  const ch = CHAINS.find((x) => x.id === t.chain)
                  const you = wallet && t.trader === wallet.address
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
                      {you && (
                        <span className="rounded border border-ink bg-lime px-1 text-[8px]">YOU</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <p className="mt-3 text-center font-mono text-[9px] font-bold tracking-wide opacity-40">
            DEMO MARKET — REAL CURVE MATH, FICTIONAL MONEY. NO TRANSACTION IS SUBMITTED.
          </p>
        </div>
      </div>
    </div>
  )
}
