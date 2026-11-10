import { useState } from 'react'
import { useStore, shortAddr, type WalletSource } from '../store'
import { fmtUsd } from '../lib/format'
import { PUBLIC_DEMO, type AppMode } from '../App'

function scrollTo(id: string) {
  // From a sub-page (#/token/…), go home first, then scroll.
  if (window.location.hash.startsWith('#/')) {
    window.location.hash = ''
    window.setTimeout(
      () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }),
      80,
    )
  } else {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
  }
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
  onHome,
}: {
  mode: AppMode
  setMode: (m: AppMode) => void
  onOpenLab: () => void
  onFreshSpawns: () => void
  onHome: () => void
}) {
  const { wallet, onchain } = useStore()

  const link =
    'hidden lg:inline-block font-mono text-[12px] font-bold tracking-wide hover:underline decoration-[3px] decoration-lime underline-offset-4 cursor-pointer'

  return (
    <header className="sticky top-0 z-40 border-b-3 border-ink bg-cream/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-5 px-4 py-3 sm:px-6">
        <button className="flex items-center gap-2.5" onClick={onHome}>
          <LogoBlob />
          <span className="font-display text-2xl tracking-wide">SPAWN!</span>
        </button>

        <nav className="ml-auto flex items-center gap-5">
          <button className={`${link} underline`} onClick={() => scrollTo('pit')}>
            THE PIT
          </button>
          <button className={link} onClick={onFreshSpawns}>
            NEW TOKENS
          </button>
          <button className={link} onClick={() => (window.location.hash = '/portfolio')}>
            PORTFOLIO
          </button>
          <button className={link} onClick={() => (window.location.hash = '/dev')}>
            DEV ZONE
          </button>
          <button className={link} onClick={() => scrollTo('how')}>
            HOW IT WORKS
          </button>
          <button className={link} onClick={onOpenLab}>
            LAUNCH LAB ↗
          </button>
        </nav>

        {/* market mode switch — LOCAL only exists outside the public build */}
        <div className="flex overflow-hidden rounded-full border-2 border-ink font-mono text-[10px] font-bold">
          {(PUBLIC_DEMO ? (['sim', 'testnet'] as const) : (['sim', 'testnet', 'chain'] as const)).map(
            (m, i) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2.5 py-1.5 transition ${
                  mode === m ? 'bg-ink text-lime' : 'bg-white hover:bg-lime'
                } ${i > 0 ? 'border-l-2 border-ink' : ''}`}
                title={
                  m === 'sim'
                    ? 'Simulated market'
                    : m === 'testnet'
                      ? 'Real contracts on public testnets (Base/Optimism/Arbitrum Sepolia)'
                      : 'Local on-chain deployment'
                }
              >
                {m === 'sim' ? 'SIM' : m === 'testnet' ? '⛓ TESTNET' : 'LOCAL'}
              </button>
            ),
          )}
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

        <ConnectButton />
      </div>

      {onchain && onchain.status !== 'ready' && (
        <div className="border-t-2 border-ink bg-down px-4 py-1.5 text-center font-mono text-[10px] font-bold tracking-wide text-white">
          {onchain.status === 'connecting'
            ? '⛓ CONNECTING TO THE CHAIN…'
            : mode === 'testnet'
              ? '⛓ TESTNET DEPLOYMENT NOT LIVE YET — THE MULTIVERSE IS BEING WIRED. FLIP BACK TO SIM FOR NOW.'
              : '⛓ LOCAL CHAIN OFFLINE — RUN `npm run chain` THEN `npm run chain:deploy`, OR FLIP BACK TO SIM.'}
        </div>
      )}
    </header>
  )
}

/** Connect pill + its dropdown. In on-chain mode with a wallet extension
 * present, connecting offers MetaMask vs the instant burner; once connected
 * the pill opens a small menu showing the source and a DISCONNECT. */
function ConnectButton() {
  const { wallet, connect, onchain } = useStore()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<WalletSource | 'any' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const hasInjected =
    typeof window !== 'undefined' && !!(window as { ethereum?: unknown }).ethereum
  const onchainMode = !!onchain

  const doConnect = async (source?: WalletSource) => {
    if (busy) return
    setBusy(source ?? 'any')
    setErr(null)
    try {
      await connect(source)
      setOpen(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message.split('\n')[0].slice(0, 90) : 'Connection failed.')
    } finally {
      setBusy(null)
    }
  }

  const onPillClick = () => {
    setErr(null)
    if (onchainMode && (wallet || hasInjected)) {
      setOpen((o) => !o)
      return
    }
    void doConnect()
  }

  const option =
    'w-full rounded-lg border-2 border-ink px-3 py-2.5 text-left font-mono text-[11px] font-bold shadow-brutal-sm transition hover:-translate-y-0.5 disabled:opacity-60'

  return (
    <div className="relative">
      <button
        onClick={onPillClick}
        className="rounded-xl border-3 border-ink bg-ink px-4 py-2.5 font-mono text-[11px] font-bold tracking-wide text-white shadow-brutal-sm transition hover:-translate-y-0.5 hover:shadow-brutal active:translate-y-0 active:shadow-brutal-sm"
      >
        {wallet ? (
          <>
            {onchain?.walletSource === 'injected' ? '🦊' : '●'} {shortAddr(wallet.address)}{' '}
            <span className="text-lime">{fmtUsd(wallet.balance)}</span>
          </>
        ) : busy ? (
          '✳ CONNECTING…'
        ) : (
          '◉ CONNECT WALLET'
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-60 rounded-xl border-3 border-ink bg-cream p-2 shadow-brutal">
          {wallet ? (
            <>
              <p className="px-1 pb-2 pt-1 font-mono text-[10px] font-bold opacity-60">
                {onchain?.walletSource === 'injected' ? '🦊 METAMASK' : '⚡ BURNER WALLET'} ·{' '}
                {shortAddr(wallet.address)}
              </p>
              <button
                className={`${option} bg-white hover:bg-hotpink`}
                onClick={() => {
                  onchain?.disconnect?.()
                  setOpen(false)
                }}
              >
                ✕ DISCONNECT
              </button>
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <button
                className={`${option} bg-lime`}
                disabled={busy !== null}
                onClick={() => void doConnect('injected')}
              >
                {busy === 'injected' ? '✳ CHECK YOUR WALLET…' : '🦊 METAMASK'}
                <span className="block font-body text-[10px] font-normal opacity-70">
                  your own wallet extension
                </span>
              </button>
              <button
                className={`${option} bg-white`}
                disabled={busy !== null}
                onClick={() => void doConnect('burner')}
              >
                {busy === 'burner' ? '✳ SPAWNING…' : '⚡ BURNER (INSTANT)'}
                <span className="block font-body text-[10px] font-normal opacity-70">
                  throwaway wallet, zero setup
                </span>
              </button>
            </div>
          )}
          {err && (
            <p className="mt-2 rounded-lg border-2 border-ink bg-hotpink px-2 py-1.5 font-mono text-[10px] font-bold">
              {err}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
