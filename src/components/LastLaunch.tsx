import { useStore, type Creature } from '../store'
import { fmtChange, fmtMoney, fmtPrice, timeAgo } from '../lib/format'
import { CreatureArt } from './CreatureCard'
import { PriceChart } from './PriceChart'

function PreviewCard({
  label,
  c,
  onOpen,
}: {
  label: string
  c: Creature
  onOpen: (num: number) => void
}) {
  const { getMarket } = useStore()
  const market = getMarket(c.num)
  const history = market?.history ?? []
  const points = history.length > 70 ? history.slice(-70) : history

  return (
    <button
      onClick={() => onOpen(c.num)}
      className="relative block w-full overflow-hidden rounded-3xl border-3 border-ink bg-void p-4 text-left text-white shadow-brutal transition hover:-translate-y-1 hover:shadow-brutal-lg"
      title={`Open ${c.name}`}
    >
      <div className="dot-grid-light pointer-events-none absolute inset-0" />

      <div className="relative z-10 flex items-center justify-between font-mono text-[10px] font-bold tracking-[0.15em]">
        <span className="text-lime">
          <span className="mr-1.5 inline-block h-2 w-2 animate-blink rounded-full bg-lime align-middle" />
          {label}
        </span>
        <span className="opacity-60">{timeAgo(c.spawnedAt).toUpperCase()}</span>
      </div>

      <div className="relative z-10 mt-2.5 flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="shrink-0 overflow-hidden rounded-full border-2 border-white/25">
            <CreatureArt c={c} size={34} />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-display text-xl leading-none tracking-wide">
              ${c.ticker}
            </span>
            <span className="mt-0.5 block truncate font-mono text-[9px] font-bold tracking-wide opacity-55">
              {c.name.toUpperCase()}
              {c.status === 'ascended' ? ' · ⬆' : c.status === 'hot' ? ' · 🔥' : ''}
            </span>
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-mono text-[15px] font-bold leading-none text-lime">
            {fmtPrice(c.price)}
          </span>
          <span
            className={`mt-0.5 block font-mono text-[10px] font-bold ${
              c.change >= 0 ? 'text-up' : 'text-down'
            }`}
          >
            {fmtChange(c.change)}
          </span>
        </span>
      </div>

      <div className="relative z-10 mt-2.5 rounded-xl border-2 border-white/15 bg-ink/70 px-1 pt-1">
        <PriceChart points={points} ascendedAt={market?.ascendedAt} dark height="h-24" />
      </div>

      <div className="relative z-10 mt-2 flex items-center justify-between font-mono text-[10px] font-bold">
        <span className="opacity-55">MCAP {fmtMoney(c.mcap)}</span>
        <span className="rounded-md border-2 border-ink bg-lime px-2 py-0.5 text-ink">
          TRADE ↗
        </span>
      </div>
    </button>
  )
}

/** The hero's right column: two live previews straight from the engine. */
export function HeroCharts({ onOpen }: { onOpen: (num: number) => void }) {
  const { creatures } = useStore()
  if (creatures.length === 0) return null

  const last = [...creatures].sort((a, b) => b.spawnedAt - a.spawnedAt)[0]
  const byMcap = [...creatures].sort((a, b) => b.mcap - a.mcap)
  const top = byMcap[0].num === last.num && byMcap.length > 1 ? byMcap[1] : byMcap[0]

  return (
    <div className="flex flex-col gap-5">
      <PreviewCard label="LAST LAUNCH // LIVE" c={last} onOpen={onOpen} />
      <PreviewCard label="TOP MARKET CAP // LIVE" c={top} onOpen={onOpen} />
    </div>
  )
}
