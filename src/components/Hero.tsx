import { useStore } from '../store'
import { fmtMoney, fmtTokens } from '../lib/format'
import { HeroCharts } from './LastLaunch'
import { ChainLogo, CHAIN_LOGO_LABELS } from './ChainLogos'
import { Asterisk } from './bits'

/** The whole pitch, scannable in five chips. */
const FEATURES: { label: string; cls: string; bg?: string }[] = [
  { label: '⛓ 6 CHAINS, 1 LAUNCH', cls: 'bg-ink text-lime' },
  { label: '✳ ONE GLOBAL SUPPLY', cls: 'bg-white' },
  { label: '⚖ ONE PRICE EVERYWHERE', cls: '', bg: '#9ccbf5' },
  { label: '🛡 BLOCK 0 DOES NOT EXIST', cls: '', bg: '#f7a8ce' },
  { label: '⛽ GAS ON ONE CHAIN ONLY', cls: 'bg-white' },
  { label: '💸 FEES: HOLDERS / DEV / 🔥 BURN', cls: 'bg-tang' },
]

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
  const { creatures } = useStore()
  const traded = creatures.reduce((a, c) => a + c.volume, 0)
  const burned = creatures.reduce((a, c) => a + (c.fees?.burnedTokens ?? 0), 0)
  const ascended = creatures.filter((c) => c.status === 'ascended').length
  const stats: string[] = [
    `✳ ${creatures.length} TOKENS LIVE`,
    `📈 ${fmtMoney(traded)} TRADED`,
    ...(burned > 0 ? [`🔥 ${fmtTokens(burned)} BURNED`] : []),
    ...(ascended > 0 ? [`⬆ ${ascended} ASCENDED`] : []),
  ]
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
          Launch once — your token goes live{' '}
          <mark className="bg-ink px-1.5 py-0.5 font-bold text-lime">
            natively on all 6 chains
          </mark>{' '}
          at the same second. No bridges, no wrapped copies.
        </p>

        {/* the pitch, scannable */}
        <div className="relative mt-4 flex max-w-lg flex-wrap gap-2">
          {FEATURES.map(({ label: l, cls, bg }) => (
            <span
              key={l}
              className={`rounded-full border-2 border-ink px-3 py-1.5 font-mono text-[10px] font-bold tracking-wide shadow-brutal-sm ${cls}`}
              style={bg ? { background: bg } : undefined}
            >
              {l}
            </span>
          ))}
        </div>

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

        {/* live protocol stats */}
        <div className="relative mt-4 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] font-bold tracking-wide opacity-75">
          {stats.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>

        <div className="relative mt-4">
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
