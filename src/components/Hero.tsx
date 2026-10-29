import { Face, type FaceId } from './Faces'
import { GenesisSim } from './GenesisSim'
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

const CULT: { face: FaceId; bg: string }[] = [
  { face: 'frog', bg: '#b5e95b' },
  { face: 'brain', bg: '#f7a8ce' },
  { face: 'bork', bg: '#f7be7b' },
  { face: 'alien', bg: '#8be0d4' },
]

export function Hero({ onOpenLab }: { onOpenLab: () => void }) {
  return (
    <section className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:py-10">
      {/* left — lime panel */}
      <div className="relative overflow-hidden rounded-3xl border-3 border-ink bg-lime p-6 shadow-brutal sm:p-10">
        <Asterisk
          size={420}
          className="pointer-events-none absolute -right-24 top-6 opacity-[0.08]"
        />

        <div className="relative flex flex-wrap items-center gap-2">
          <span className="rounded-full border-2 border-ink bg-cream px-3 py-1 font-mono text-[10px] font-bold tracking-wide">
            ✳ THE MEME MULTIVERSE IS OPEN
          </span>
          <span className="rounded-full border-2 border-ink bg-ink px-3 py-1 font-mono text-[10px] font-bold tracking-wide text-lime">
            GENESIS ENGINE V.01
          </span>
        </div>

        <h1 className="relative mt-6 font-display text-[clamp(3.2rem,8vw,6.5rem)] leading-[0.95] tracking-wide">
          YOUR MEME
          <br />
          IS NOT
          <br />
          <span className="relative inline-block">
            LOCAL.
            <Underline />
          </span>
        </h1>

        <p className="relative mt-7 max-w-md text-[17px] font-medium leading-relaxed">
          Spawn{' '}
          <mark className="bg-ink px-1.5 py-0.5 font-bold text-lime">
            one token on every chain
          </mark>{' '}
          in the same coordinated launch. One global supply. One shared price reference. A
          whole lot of internet nonsense.
        </p>

        <div className="relative mt-8 flex flex-wrap gap-3">
          <button
            onClick={onOpenLab}
            className="rounded-xl border-3 border-ink bg-ink px-6 py-3.5 font-mono text-[13px] font-bold tracking-wide text-white shadow-brutal transition hover:-translate-y-1 hover:shadow-brutal-lg active:translate-y-0 active:shadow-brutal"
          >
            SPAWN A MEME ↗
          </button>
          <a
            href="#pit"
            className="rounded-xl border-3 border-ink bg-lime px-6 py-3.5 font-mono text-[13px] font-bold tracking-wide shadow-brutal transition hover:-translate-y-1 hover:bg-cream hover:shadow-brutal-lg active:translate-y-0 active:shadow-brutal"
          >
            ENTER THE PIT ↓
          </a>
        </div>

        <div className="relative mt-10 flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex -space-x-2.5">
              {CULT.map(({ face, bg }) => (
                <span
                  key={face}
                  className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border-2 border-ink"
                  style={{ background: bg }}
                >
                  <Face id={face} size={26} />
                </span>
              ))}
            </div>
            <span className="font-mono text-[10px] font-bold leading-tight tracking-wide">
              THE CULT IS
              <br />
              EVERYWHERE
            </span>
          </div>
          <span className="font-mono text-[10px] font-bold tracking-wide opacity-70">
            6 CHAINS. 1 GENESIS. 0 GEOGRAPHICAL LIMITS.
          </span>
        </div>
      </div>

      {/* right — genesis simulation */}
      <GenesisSim />
    </section>
  )
}
