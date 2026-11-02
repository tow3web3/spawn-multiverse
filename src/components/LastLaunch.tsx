import { useStore } from '../store'
import { fmtChange, fmtMoney, fmtPrice, fmtNum, timeAgo, timeShort, creatureNum } from '../lib/format'
import { CHAINS } from '../lib/chains'
import { CreatureArt } from './CreatureCard'
import { PriceChart } from './PriceChart'

const chainShort = (id: string) => CHAINS.find((c) => c.id === id)?.label ?? id.toUpperCase()

/** The hero's right panel: a live chart of the most recent launch, built
 * straight from its executed trades — same engine as the trading view. */
export function LastLaunch({ onOpen }: { onOpen: (num: number) => void }) {
  const { creatures, getMarket } = useStore()
  const last = [...creatures].sort((a, b) => b.spawnedAt - a.spawnedAt)[0]
  if (!last) return null

  const market = getMarket(last.num)
  const history = market?.history ?? []
  const points = history.length > 80 ? history.slice(-80) : history
  const tape = (market?.trades ?? []).slice(0, 3)
  const badge =
    last.status === 'ascended' ? '⬆ ASCENDED' : last.status === 'hot' ? '🔥 HOT' : '● LIVE'

  return (
    <div className="relative flex flex-col overflow-hidden rounded-3xl border-3 border-ink bg-void p-5 text-white shadow-brutal">
      <div className="dot-grid-light pointer-events-none absolute inset-0" />

      {/* header */}
      <div className="relative z-10 flex items-center justify-between font-mono text-[10px] font-bold tracking-[0.15em]">
        <span className="text-lime">
          <span className="mr-1.5 inline-block h-2 w-2 animate-blink rounded-full bg-lime align-middle" />
          LAST LAUNCH // LIVE
        </span>
        <span className="opacity-60">
          {creatureNum(last.num)} · {timeAgo(last.spawnedAt).toUpperCase()}
        </span>
      </div>

      {/* identity + price */}
      <div className="relative z-10 mt-3 flex items-end justify-between gap-3">
        <button
          onClick={() => onOpen(last.num)}
          className="flex items-center gap-2.5 text-left transition hover:-translate-y-0.5"
          title={`Open ${last.name}`}
        >
          <span className="overflow-hidden rounded-full border-2 border-white/25">
            <CreatureArt c={last} size={42} />
          </span>
          <span>
            <span className="block font-display text-2xl leading-none tracking-wide">
              ${last.ticker}
            </span>
            <span className="mt-1 block font-mono text-[9px] font-bold tracking-wide opacity-60">
              {last.name.toUpperCase()} · {badge}
            </span>
          </span>
        </button>
        <div className="text-right">
          <div className="font-mono text-xl font-bold leading-none text-lime">
            {fmtPrice(last.price)}
          </div>
          <div
            className={`mt-1 font-mono text-[11px] font-bold ${
              last.change >= 0 ? 'text-up' : 'text-down'
            }`}
          >
            {fmtChange(last.change)}
          </div>
        </div>
      </div>

      {/* the live chart — every point is an executed trade */}
      <div className="relative z-10 mt-3 rounded-xl border-2 border-white/15 bg-ink/70 px-1 pt-1">
        <PriceChart points={points} ascendedAt={market?.ascendedAt} dark />
      </div>

      {/* last transactions feeding the chart */}
      <div className="relative z-10 mt-3 space-y-1">
        {tape.map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between rounded-lg border-2 border-white/10 bg-ink/60 px-2.5 py-1 font-mono text-[10px] font-bold"
          >
            <span className={t.side === 'buy' ? 'text-up' : 'text-down'}>
              {t.side === 'buy' ? '▲ BUY' : '▼ SELL'} {fmtMoney(t.usd)}
            </span>
            <span className="opacity-50">
              {chainShort(t.chain)} · {timeShort(t.ts)} AGO
            </span>
          </div>
        ))}
      </div>

      {/* stats + CTA */}
      <div className="relative z-10 mt-3 flex items-stretch gap-2">
        {[
          ['MCAP', fmtMoney(last.mcap)],
          ['VOL', fmtMoney(last.volume)],
          ['HOLDERS', fmtNum(last.holders)],
        ].map(([k, v]) => (
          <div key={k} className="flex-1 rounded-lg border-2 border-white/15 bg-ink px-2 py-1.5 text-center">
            <div className="font-mono text-[8px] font-bold tracking-[0.15em] opacity-50">{k}</div>
            <div className="font-mono text-[12px] font-bold">{v}</div>
          </div>
        ))}
        <button
          onClick={() => onOpen(last.num)}
          className="flex-1 rounded-lg border-2 border-ink bg-lime px-2 font-mono text-[11px] font-bold tracking-wide text-ink shadow-brutal-sm transition hover:-translate-y-0.5 active:translate-y-0"
        >
          TRADE ↗
        </button>
      </div>
    </div>
  )
}
