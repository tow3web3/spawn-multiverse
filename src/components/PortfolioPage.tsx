import { useState } from 'react'
import { useStore, shortAddr } from '../store'
import { fmtChange, fmtPrice, fmtTokens, fmtUsd } from '../lib/format'
import { CreatureArt } from './CreatureCard'

const label = 'font-mono text-[10px] font-bold tracking-[0.15em] opacity-60'

export function PortfolioPage({
  onOpenToken,
  onBack,
}: {
  onOpenToken: (num: number) => void
  onBack: () => void
}) {
  const { creatures, wallet, connect, onchain } = useStore()
  const [busy, setBusy] = useState(false)

  // protocol v3: unclaimed holder fee rewards, summed across tokens + chains
  const feeRewards = Object.values(onchain?.holderRewards ?? {}).reduce((a, b) => a + b, 0)

  const rows = wallet
    ? Object.entries(wallet.positions)
        .map(([numStr, pos]) => {
          const c = creatures.find((x) => x.num === Number(numStr))
          if (!c || pos.tokens <= 1) return null
          const value = pos.tokens * c.price
          const rawPnl = value - pos.cost
          return { c, pos, value, pnl: Math.abs(rawPnl) < 0.005 ? 0 : rawPnl }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => b.value - a.value)
    : []

  const holdings = rows.reduce((a, r) => a + r.value, 0)
  const totalPnl = rows.reduce((a, r) => a + r.pnl, 0)

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          onClick={onBack}
          className="rounded-xl border-2 border-ink bg-white px-4 py-2 font-mono text-[11px] font-bold tracking-wide shadow-brutal-sm transition hover:-translate-y-0.5 hover:bg-lime"
        >
          ← THE PIT
        </button>
        <span className="font-mono text-[10px] font-bold tracking-[0.2em] opacity-50">
          {wallet ? shortAddr(wallet.address) : 'NOT CONNECTED'}
        </span>
      </div>

      <h1 className="mt-5 font-display text-[clamp(2.4rem,6vw,4rem)] leading-none tracking-wide">
        YOUR BAGS<span className="text-grape">.</span>
      </h1>
      <p className="mt-2 max-w-lg font-mono text-[11px] font-bold leading-relaxed opacity-55">
        EVERY TOKEN YOU TRADED THROUGH SPAWN!, ACROSS ALL SIX CHAINS, IN ONE PLACE.
      </p>

      {!wallet ? (
        <div className="mt-10 rounded-2xl border-3 border-ink bg-white p-10 text-center shadow-brutal">
          <p className="font-display text-2xl tracking-wide">NO WALLET, NO BAGS.</p>
          <button
            onClick={() => {
              if (busy) return
              setBusy(true)
              void connect().finally(() => setBusy(false))
            }}
            className="mt-5 rounded-xl border-3 border-ink bg-lime px-6 py-3 font-mono text-[12px] font-bold shadow-brutal transition hover:-translate-y-0.5"
          >
            {busy ? '✳ CONNECTING…' : '◉ CONNECT WALLET'}
          </button>
        </div>
      ) : (
        <>
          {/* totals */}
          <div className={`mt-6 grid grid-cols-2 gap-2 ${feeRewards > 0.005 ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
            {[
              ['CASH BALANCE', fmtUsd(wallet.balance), ''],
              ['HOLDINGS VALUE', fmtUsd(holdings), ''],
              [
                'TOTAL PNL',
                `${totalPnl >= 0 ? '+' : ''}${fmtUsd(totalPnl).replace('$-', '-$')}`,
                totalPnl >= 0 ? 'text-up' : 'text-down',
              ],
              ...(feeRewards > 0.005
                ? [['FEE REWARDS — CLAIM ON EACH TOKEN PAGE', fmtUsd(feeRewards), 'text-up'] as const]
                : []),
            ].map(([l, v, cls]) => (
              <div key={l} className="rounded-xl border-3 border-ink bg-white px-4 py-3 shadow-brutal-sm">
                <p className={label}>{l}</p>
                <p className={`mt-1 font-mono text-lg font-bold ${cls}`}>{v}</p>
              </div>
            ))}
          </div>

          {/* positions */}
          {rows.length === 0 ? (
            <div className="mt-6 rounded-2xl border-3 border-ink bg-white p-10 text-center shadow-brutal">
              <p className="font-display text-2xl tracking-wide">EMPTY BAGS. FIX THAT.</p>
              <button
                onClick={onBack}
                className="mt-5 rounded-xl border-3 border-ink bg-lime px-6 py-3 font-mono text-[12px] font-bold shadow-brutal transition hover:-translate-y-0.5"
              >
                ENTER THE PIT ↓
              </button>
            </div>
          ) : (
            <div className="mt-6 overflow-hidden rounded-2xl border-3 border-ink shadow-brutal-sm">
              {rows.map(({ c, pos, value, pnl }, i) => (
                <button
                  key={c.num}
                  onClick={() => onOpenToken(c.num)}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-lime/30 ${
                    i > 0 ? 'border-t border-ink/10' : ''
                  } ${i % 2 ? 'bg-cream/50' : 'bg-white'}`}
                >
                  <span
                    className="shrink-0 overflow-hidden rounded-full border-2 border-ink"
                    style={{ background: c.color }}
                  >
                    <CreatureArt c={c} size={36} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[13px] font-bold">
                      ${c.ticker} <span className="opacity-40">· {fmtTokens(pos.tokens)}</span>
                    </span>
                    <span className="block font-mono text-[10px] font-bold opacity-50">
                      {fmtPrice(c.price)}{' '}
                      <span className={c.change >= 0 ? 'text-up' : 'text-down'}>
                        {fmtChange(c.change)}
                      </span>
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block font-mono text-[13px] font-bold">{fmtUsd(value)}</span>
                    <span
                      className={`block font-mono text-[10px] font-bold ${
                        pnl >= 0 ? 'text-up' : 'text-down'
                      }`}
                    >
                      {pnl >= 0 ? '+' : ''}
                      {fmtUsd(pnl).replace('$-', '-$')} PNL
                    </span>
                  </span>
                  <span className="font-mono text-[12px] opacity-40">→</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
