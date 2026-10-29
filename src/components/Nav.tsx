import { useStore, shortAddr } from '../store'
import { fmtUsd } from '../lib/format'
import { PUBLIC_DEMO, type AppMode } from '../App'

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
  mode,
  setMode,
  onOpenLab,
  onFreshSpawns,
}: {
  mode: AppMode
  setMode: (m: AppMode) => void
  onOpenLab: () => void
  onFreshSpawns: () => void
}) {
  const { wallet, connect, onchain } = useStore()

  const link =
    'hidden lg:inline-block font-mono text-[12px] font-bold tracking-wide hover:underline decoration-[3px] decoration-lime underline-offset-4 cursor-pointer'

  return (
    <header className="sticky top-0 z-40 border-b-3 border-ink bg-cream/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-5 px-4 py-3 sm:px-6">
        <button
          className="flex items-center gap-2.5"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          <LogoBlob />
          <span className="font-display text-2xl tracking-wide">SPAWN!</span>
        </button>

        <nav className="ml-auto flex items-center gap-5">
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

        {/* sim / chain switch (hidden on the public demo — no local chain there) */}
        <div className={`${PUBLIC_DEMO ? 'hidden' : 'flex'} overflow-hidden rounded-full border-2 border-ink font-mono text-[10px] font-bold`}>
          {(['sim', 'chain'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2.5 py-1.5 transition ${
                mode === m ? 'bg-ink text-lime' : 'bg-white hover:bg-lime'
              } ${m === 'chain' ? 'border-l-2 border-ink' : ''}`}
              title={m === 'sim' ? 'Simulated market' : 'Local on-chain deployment'}
            >
              {m === 'sim' ? 'SIM' : '⛓ ONCHAIN'}
            </button>
          ))}
        </div>

        <div className="hidden items-center gap-1.5 rounded-full border-2 border-ink bg-white px-3 py-1.5 font-mono text-[10px] font-bold xl:flex">
          <span
            className={`h-2 w-2 animate-blink rounded-full ${
              !onchain || onchain.status === 'ready' ? 'bg-up' : 'bg-down'
            }`}
          />
          {onchain
            ? onchain.status === 'ready'
              ? 'CHAIN LIVE'
              : onchain.status.toUpperCase()
            : 'MULTIVERSE LIVE'}
        </div>

        {onchain?.status === 'ready' && wallet && (
          <button
            onClick={() => void onchain.airdrop()}
            title="Faucet $1,337 oUSD on every chain"
            className="rounded-xl border-2 border-ink bg-lime px-3 py-2 font-mono text-[10px] font-bold shadow-brutal-sm transition hover:-translate-y-0.5"
          >
            💸 AIRDROP
          </button>
        )}

        <button
          onClick={() => void connect()}
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

      {onchain && onchain.status !== 'ready' && (
        <div className="border-t-2 border-ink bg-down px-4 py-1.5 text-center font-mono text-[10px] font-bold tracking-wide text-white">
          {onchain.status === 'connecting'
            ? '⛓ CONNECTING TO THE LOCAL CHAIN…'
            : '⛓ LOCAL CHAIN OFFLINE — RUN `npm run chain` THEN `npm run chain:deploy`, OR FLIP BACK TO SIM.'}
        </div>
      )}
    </header>
  )
}
