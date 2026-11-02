import { useStore } from '../store'
import { fmtChange, fmtMoney, fmtPrice, fmtNum, timeAgo, creatureNum } from '../lib/format'
import { CreatureArt } from './CreatureCard'
import { Sparkle } from './bits'

function ChainTag({
  label,
  color,
  rot,
  delay,
  className,
}: {
  label: string
  color: string
  rot: number
  delay: string
  className: string
}) {
  return (
    <div
      className={`absolute z-20 animate-floaty-sm rounded-lg border-2 border-ink px-2.5 py-1 font-mono text-[10px] font-bold text-ink shadow-brutal-sm ${className}`}
      style={{ background: color, animationDelay: delay, ['--tag-rot' as string]: `${rot}deg` }}
    >
      {label} ✓
    </div>
  )
}

/** The hero's right panel: the most recent token launched, live. */
export function LastLaunch({ onOpen }: { onOpen: (num: number) => void }) {
  const { creatures } = useStore()
  const last = [...creatures].sort((a, b) => b.spawnedAt - a.spawnedAt)[0]
  if (!last) return null

  const badge =
    last.status === 'ascended' ? '⬆ ASCENDED' : last.status === 'hot' ? '🔥 HOT' : '● LIVE'

  return (
    <div className="relative flex min-h-[460px] flex-col overflow-hidden rounded-3xl border-3 border-ink bg-void p-5 text-white shadow-brutal lg:min-h-[540px]">
      <div className="dot-grid-light pointer-events-none absolute inset-0" />

      {/* perspective grid floor */}
      <div
        className="pointer-events-none absolute -inset-x-[30%] bottom-[-12%] h-[68%] opacity-35"
        style={{
          transform: 'perspective(520px) rotateX(58deg)',
          backgroundImage:
            'linear-gradient(rgba(201,242,75,.55) 1px, transparent 1px), linear-gradient(90deg, rgba(201,242,75,.55) 1px, transparent 1px)',
          backgroundSize: '46px 46px',
          maskImage: 'linear-gradient(to top, black 25%, transparent 90%)',
          WebkitMaskImage: 'linear-gradient(to top, black 25%, transparent 90%)',
        }}
      />

      {/* header */}
      <div className="relative z-10 flex items-center justify-between font-mono text-[10px] font-bold tracking-[0.15em]">
        <span className="text-lime">
          <span className="mr-1.5 inline-block h-2 w-2 animate-blink rounded-full bg-lime align-middle" />
          LAST LAUNCH // {timeAgo(last.spawnedAt).toUpperCase()}
        </span>
        <span className="opacity-60">{creatureNum(last.num)}</span>
      </div>

      {/* chain tags */}
      <ChainTag label="SOLANA" color="#f5a8c8" rot={-7} delay="0s" className="left-[6%] top-[16%]" />
      <ChainTag label="BASE" color="#c9f24b" rot={5} delay="-1.2s" className="right-[6%] top-[20%]" />
      <ChainTag label="ETHEREUM" color="#9ccbf5" rot={-4} delay="-2.1s" className="left-[7%] top-[52%]" />
      <ChainTag label="BNB + 2" color="#a78bf0" rot={6} delay="-3s" className="right-[8%] top-[48%]" />

      {/* sparkles */}
      <Sparkle size={30} className="absolute left-[24%] top-[12%] animate-twinkle" />
      <Sparkle size={18} className="absolute right-[26%] top-[34%] animate-twinkle" style={{ animationDelay: '-0.9s' }} />
      <Sparkle size={24} className="absolute left-[30%] top-[56%] animate-twinkle" style={{ animationDelay: '-1.7s' }} />

      {/* the token */}
      <div className="relative z-10 flex flex-1 items-center justify-center py-4">
        <button
          onClick={() => onOpen(last.num)}
          title={`Open ${last.name}`}
          className="animate-floaty cursor-pointer transition hover:scale-105"
        >
          <div className="overflow-hidden rounded-full border-3 border-ink drop-shadow-[0_18px_0_rgba(0,0,0,0.45)]">
            <CreatureArt c={last} size={170} />
          </div>
        </button>
      </div>

      {/* info + CTA */}
      <div className="relative z-10">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border-2 border-white/25 px-2 py-0.5 font-mono text-[9px] font-bold tracking-wide text-lime">
                {badge}
              </span>
              <span className="font-mono text-[10px] font-bold tracking-wide opacity-60">
                {last.name.toUpperCase()}
              </span>
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="font-display text-4xl tracking-wide">${last.ticker}</span>
              <span className={`font-mono text-sm font-bold ${last.change >= 0 ? 'text-lime' : 'text-down'}`}>
                {fmtChange(last.change)}
              </span>
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-[9px] font-bold tracking-[0.2em] opacity-60">PRICE</div>
            <div className="font-mono text-xl font-bold text-lime">{fmtPrice(last.price)}</div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          {[
            ['MCAP', fmtMoney(last.mcap)],
            ['VOLUME', fmtMoney(last.volume)],
            ['HOLDERS', fmtNum(last.holders)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border-2 border-white/15 bg-ink px-2 py-1.5 text-center">
              <div className="font-mono text-[8px] font-bold tracking-[0.15em] opacity-50">{k}</div>
              <div className="font-mono text-[13px] font-bold">{v}</div>
            </div>
          ))}
        </div>

        <button
          onClick={() => onOpen(last.num)}
          className="mt-3 w-full rounded-xl border-3 border-ink bg-lime px-5 py-3 font-mono text-[13px] font-bold tracking-wide text-ink shadow-brutal-sm transition hover:-translate-y-0.5 hover:shadow-brutal active:translate-y-0"
        >
          TRADE ${last.ticker} ↗
        </button>
      </div>
    </div>
  )
}
