import { type Creature } from '../store'
import {
  creatureNum,
  fmtChange,
  fmtMoney,
  fmtNum,
  fmtPrice,
  timeAgo,
} from '../lib/format'
import { Face } from './Faces'
import { Asterisk, ChainDots, Sparkle } from './bits'

function StatusBadge({ c }: { c: Creature }) {
  if (c.status === 'ascended') {
    return (
      <span className="rounded-full border-2 border-ink bg-grape px-2.5 py-1 font-mono text-[9px] font-bold tracking-wide shadow-brutal-sm">
        ⬆ ASCENDED
      </span>
    )
  }
  return (
    <span className="rounded-full border-2 border-ink bg-white px-2.5 py-1 font-mono text-[9px] font-bold tracking-wide shadow-brutal-sm">
      {c.status === 'hot' ? '🔥 HOT GENESIS' : '✦ LIVE'}
    </span>
  )
}

export function CreatureArt({ c, size }: { c: Creature; size: number }) {
  if (c.image) {
    return (
      <img
        src={c.image}
        alt=""
        style={{ width: size, height: size }}
        className="relative rounded-full border-3 border-ink bg-white object-cover"
        draggable={false}
      />
    )
  }
  return <Face id={c.face ?? 'frog'} size={size} className="relative" />
}

export function CreatureCard({
  creature: c,
  highlight,
  onOpen,
}: {
  creature: Creature
  highlight: boolean
  onOpen: () => void
}) {
  return (
    <article
      onClick={onOpen}
      className={`group cursor-pointer overflow-hidden rounded-2xl border-3 border-ink bg-white shadow-brutal transition hover:-translate-y-1.5 hover:shadow-brutal-lg ${
        highlight ? 'animate-pop ring-4 ring-hotpink ring-offset-2 ring-offset-cream' : ''
      }`}
    >
      {/* art header */}
      <div
        className="dot-grid relative flex h-52 items-center justify-center border-b-3 border-ink"
        style={{ background: c.color }}
      >
        <div className="absolute left-3 top-3">
          <StatusBadge c={c} />
        </div>
        <span className="absolute right-3 top-3 font-mono text-[10px] font-bold opacity-60">
          {creatureNum(c.num)}
        </span>

        <div className="absolute h-44 w-44 rounded-full border-2 border-dashed border-ink/30" />
        <Sparkle size={22} className="absolute left-[16%] top-[22%] animate-twinkle" />
        <Sparkle
          size={14}
          className="absolute right-[20%] top-[16%] animate-twinkle"
          style={{ animationDelay: '-1.1s' }}
        />
        <Sparkle
          size={17}
          className="absolute bottom-[18%] right-[14%] animate-twinkle"
          style={{ animationDelay: '-2s' }}
        />

        <div className="relative transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-3">
          <CreatureArt c={c} size={132} />
        </div>

        <span className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full border-3 border-ink bg-lime shadow-brutal-sm transition-transform duration-300 group-hover:rotate-90">
          <Asterisk size={18} />
        </span>

        {/* ascension progress along the genesis curve */}
        {c.status !== 'ascended' && (
          <div
            className="absolute inset-x-0 bottom-0 h-1.5 bg-ink/10"
            title={`Ascension ${(c.progress * 100).toFixed(0)}%`}
          >
            <div
              className="h-full bg-ink/70 transition-all duration-700"
              style={{ width: `${Math.max(1, c.progress * 100)}%` }}
            />
          </div>
        )}
      </div>

      {/* body */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate font-display text-[22px] tracking-wide">{c.name}</h3>
            <p className="font-mono text-[10px] font-bold tracking-wide opacity-50">
              ${c.ticker} · {timeAgo(c.spawnedAt)}
            </p>
          </div>
          <div className="text-right">
            <p className="font-mono text-base font-bold">{fmtPrice(c.price)}</p>
            <p
              className={`font-mono text-[11px] font-bold ${
                c.change >= 0 ? 'text-up' : 'text-down'
              }`}
            >
              {fmtChange(c.change)}
            </p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 border-t-2 border-dashed border-ink/25 pt-3">
          {[
            ['GLOBAL MCAP', fmtMoney(c.mcap)],
            ['VOLUME', fmtMoney(c.volume)],
            ['HOLDERS', fmtNum(c.holders)],
          ].map(([label, value]) => (
            <div key={label}>
              <p className="font-mono text-[8.5px] font-bold tracking-wide opacity-45">{label}</p>
              <p className="font-mono text-[13px] font-bold">{value}</p>
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between border-t-2 border-dashed border-ink/25 pt-3">
          <ChainDots size="sm" />
          <span className="font-mono text-[9px] font-bold tracking-wide">
            1 TOKEN · 6 CHAINS ↗
          </span>
        </div>
      </div>
    </article>
  )
}
