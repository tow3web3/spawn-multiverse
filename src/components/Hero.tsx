import { HeroCharts } from './LastLaunch'
import { ChainLogo, CHAIN_LOGO_LABELS } from './ChainLogos'
import { Asterisk } from './bits'

function Underline() {
  return (
    <svg
      className="absolute -bottom-2 left-0 h-3 w-full"
      viewBox="0 0 220 14"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d="M4 10 Q 60 2 110 8 T 216 6"
        fill="none"
        stroke="#f06eaa"
        strokeWidth="8"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function Hero({
  onOpenLab,
  onOpenCreature,
}: {
  onOpenLab: () => void
  onOpenCreature: (num: number) => void
}) {
  return (
    <section className="mx-auto grid max-w-7xl gap-5 px-4 py-4 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:py-6">
      {/* left — lime panel */}
      <div className="relative overflow-hidden rounded-3xl border-3 border-ink bg-lime p-5 shadow-brutal sm:p-7">
        <Asterisk
          size={420}
          className="pointer-events-none absolute -right-24 top-6 opacity-[0.08]"
        />

        <div className="relative flex flex-wrap items-center gap-2">
          <span className="rounded-full border-2 border-ink bg-cream px-3 py-1 font-mono text-[10px] font-bold tracking-wide">
            ✳ LIVE ON 6 CHAINS
          </span>
        </div>

        <h1 className="relative mt-4 font-display text-[clamp(2.4rem,5.5vw,4.6rem)] leading-[0.95] tracking-wide">
          ONE TOKEN.
          <br />
          EVERY CHAIN.
          <br />
          <span className="relative inline-block">
            ONE PRICE.
            <Underline />
          </span>
        </h1>

        <p className="relative mt-4 max-w-md text-[15px] font-medium leading-relaxed">
          Launch a token once — it goes live{' '}
          <mark className="bg-ink px-1.5 py-0.5 font-bold text-lime">
            natively on all 6 chains
          </mark>{' '}
          at the same second. One global supply, one market, and the exact same price
          everywhere. No bridges, no wrapped copies.
        </p>

        <div className="relative mt-5 flex flex-wrap gap-3">
          <button
            onClick={onOpenLab}
            className="rounded-xl border-3 border-ink bg-ink px-6 py-3.5 font-mono text-[13px] font-bold tracking-wide text-white shadow-brutal transition hover:-translate-y-1 hover:shadow-brutal-lg active:translate-y-0 active:shadow-brutal"
          >
            LAUNCH A TOKEN ↗
          </button>
          <a
            href="#pit"
            className="rounded-xl border-3 border-ink bg-lime px-6 py-3.5 font-mono text-[13px] font-bold tracking-wide shadow-brutal transition hover:-translate-y-1 hover:bg-cream hover:shadow-brutal-lg active:translate-y-0 active:shadow-brutal"
          >
            ENTER THE PIT ↓
          </a>
        </div>

        <div className="relative mt-6">
          <p className="font-mono text-[10px] font-bold tracking-[0.2em] opacity-70">
            LIVE ON
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {CHAIN_LOGO_LABELS.map(({ id, label }) => (
              <span
                key={id}
                className="flex items-center gap-1.5 rounded-full border-2 border-ink bg-white px-3 py-1.5 font-mono text-[10px] font-bold tracking-wide shadow-brutal-sm"
              >
                <ChainLogo id={id} size={16} />
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* right — last launch + top mcap, live */}
      <HeroCharts onOpen={onOpenCreature} />
    </section>
  )
}
