import { useState } from 'react'
import { useStore, type Creature } from '../store'
import { fmtChange, fmtPrice } from '../lib/format'
import { CreatureArt } from './CreatureCard'

function MiniCard({
  c,
  rank,
  onOpen,
}: {
  c: Creature
  rank: number
  onOpen: (num: number) => void
}) {
  return (
    <button
      onClick={() => onOpen(c.num)}
      title={c.name}
      className="flex w-60 shrink-0 items-center gap-2.5 rounded-xl border-2 border-ink bg-white px-3 py-2.5 shadow-brutal-sm transition hover:-translate-y-0.5 hover:bg-lime/40"
    >
      <span className="rounded-md border-2 border-ink bg-ink px-1.5 py-0.5 font-mono text-[9px] font-bold text-lime">
        #{rank}
      </span>
      <span
        className="shrink-0 overflow-hidden rounded-full border-2 border-ink"
        style={{ background: c.color }}
      >
        <CreatureArt c={c} size={34} />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate font-mono text-[11px] font-bold">
          ${c.ticker}
          {c.status === 'ascended' ? ' ⬆' : c.status === 'hot' ? ' 🔥' : ''}
        </span>
        <span className="block font-mono text-[9px] font-bold opacity-50">{fmtPrice(c.price)}</span>
      </span>
      <span
        className={`font-mono text-[10px] font-bold ${c.change >= 0 ? 'text-up' : 'text-down'}`}
      >
        {fmtChange(c.change)}
      </span>
    </button>
  )
}

/** The launched tokens, live, scrolling under the hero. Hover pauses it. */
export function TrendingNow({ onOpen }: { onOpen: (num: number) => void }) {
  const { creatures } = useStore()
  const [paused, setPaused] = useState(false)
  // Freeze the ORDER on first render (cards must not teleport mid-scroll);
  // the data inside each card stays live via lookups.
  const [order, setOrder] = useState<number[]>([])
  if (order.length === 0 && creatures.length > 1) {
    setOrder(
      [...creatures]
        .sort(
          (a, b) =>
            (b.status === 'hot' ? 1 : 0) - (a.status === 'hot' ? 1 : 0) || b.change - a.change,
        )
        .slice(0, 10)
        .map((c) => c.num),
    )
  }
  const list = order
    .map((num) => creatures.find((c) => c.num === num))
    .filter((c): c is Creature => c !== undefined)
  if (list.length < 2) return null

  return (
    <section className="overflow-hidden border-y-3 border-ink bg-white py-4">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 sm:px-6">
        <p className="font-display text-xl tracking-wide">
          🔥 TRENDING NOW<span className="text-tang">.</span>
        </p>
        <p className="font-mono text-[9px] font-bold tracking-[0.2em] opacity-40">
          POINT AT IT TO STOP IT
        </p>
      </div>
      <div
        className="mt-3 overflow-hidden"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <div
          className="marquee-track flex w-max"
          style={{ animationPlayState: paused ? 'paused' : 'running' }}
        >
          {[0, 1].map((half) => (
            <div key={half} className="flex gap-3 pr-3" aria-hidden={half === 1}>
              {list.map((c, i) => (
                <MiniCard key={`${half}-${c.num}`} c={c} rank={i + 1} onOpen={onOpen} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
