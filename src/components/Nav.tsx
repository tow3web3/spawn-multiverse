import { useStore, shortAddr } from '../store'
import { fmtUsd } from '../lib/format'

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
}

function LogoBlob() {
  return (
    <svg viewBox="0 0 64 64" width="38" height="38" aria-hidden="true">
      <path
        d="M32 4C49 4 60 15 60 32C60 49 49 60 32 60C15 60 4 49 4 32C4 15 15 4 32 4Z"
        fill="#C9F24B"
        stroke="#141414"
        strokeWidth="5"
      />
      <circle cx="23" cy="26" r="4.5" fill="#141414" />
      <circle cx="41" cy="26" r="4.5" fill="#141414" />
      <path d="M20 38Q32 50 44 38" fill="none" stroke="#141414" strokeWidth="5" strokeLinecap="round" />
    </svg>
  )
}

export function Nav({
  onOpenLab,
  onFreshSpawns,
}: {
  onOpenLab: () => void
  onFreshSpawns: () => void
}) {
  const { wallet, connect } = useStore()

  const link =
    'hidden lg:inline-block font-mono text-[12px] font-bold tracking-wide hover:underline decoration-[3px] decoration-lime underline-offset-4 cursor-pointer'

  return (
    <header className="sticky top-0 z-40 border-b-3 border-ink bg-cream/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3 sm:px-6">
        <button
          className="flex items-center gap-2.5"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          <LogoBlob />
          <span className="font-display text-2xl tracking-wide">SPAWN!</span>
          <span className="mt-1 hidden font-mono text-[9px] font-bold tracking-[0.15em] opacity-60 xl:inline">
            THE OMNICHAIN MEME MACHINE
          </span>
        </button>

        <nav className="ml-auto flex items-center gap-6">
          <button className={`${link} underline`} onClick={() => scrollTo('pit')}>
            THE PIT
          </button>
          <button className={link} onClick={onFreshSpawns}>
            FRESH SPAWNS
          </button>
          <button className={link} onClick={() => scrollTo('how')}>
            HOW IT WORKS
          </button>
          <button className={link} onClick={onOpenLab}>
            LAUNCH LAB ↗
          </button>
        </nav>

        <div className="hidden items-center gap-1.5 rounded-full border-2 border-ink bg-white px-3 py-1.5 font-mono text-[10px] font-bold sm:flex">
          <span className="h-2 w-2 animate-blink rounded-full bg-up" />
          MULTIVERSE LIVE
        </div>

        <button
          onClick={() => connect()}
          className="rounded-xl border-3 border-ink bg-ink px-4 py-2.5 font-mono text-[11px] font-bold tracking-wide text-white shadow-brutal-sm transition hover:-translate-y-0.5 hover:shadow-brutal active:translate-y-0 active:shadow-brutal-sm"
        >
          {wallet ? (
            <>
              ● {shortAddr(wallet.address)}{' '}
              <span className="text-lime">{fmtUsd(wallet.balance)}</span>
            </>
          ) : (
            '◉ CONNECT WALLET'
          )}
        </button>
      </div>
    </header>
  )
}
