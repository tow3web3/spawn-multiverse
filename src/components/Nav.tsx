import { useState } from 'react'
import { useStore, shortAddr, type WalletSource } from '../store'
import { fmtUsd } from '../lib/format'
import { useDollar } from '../lib/liveChains'
import { universeOfMode, type AppMode, type UniverseDef } from '../lib/universes'
import { PUBLIC_DEMO } from '../App'
import { GuardedBanner } from './Guarded'
import { ChainLogo, CoinLogo } from './ChainLogos'

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

/** The non-mainnet modes of the switch. A mainnet universe is labelled by
 * its own definition (tab + chain logos). */
const MODE_LABEL: Record<Exclude<AppMode, UniverseDef['mode']>, string> = {
  sim: 'SIM',
  testnet: '⛓ TESTNET',
  chain: 'LOCAL',
}
const MODE_TITLE: Record<Exclude<AppMode, UniverseDef['mode']>, string> = {
  sim: 'Simulated market — nothing is real',
  testnet: 'Real contracts on public testnets, play money',
  chain: 'Local on-chain deployment',
}

export function Nav({
  mode,
  setMode,
  universes,
  onOpenLab,
  onFreshSpawns,
  onHome,
}: {
  mode: AppMode
  setMode: (m: AppMode) => void
  /** The mainnet universes whose manifest is published — each is a mode. */
  universes: UniverseDef[]
  onOpenLab: () => void
  onFreshSpawns: () => void
  onHome: () => void
}) {
  const { wallet, onchain } = useStore()
  const dollar = useDollar()
  const [minting, setMinting] = useState(false)
  // every live universe first, then SIM, TESTNET; LOCAL only outside the public build
  const modes: AppMode[] = [
    ...universes.map((u) => u.mode),
    'sim',
    'testnet',
    ...(PUBLIC_DEMO ? [] : (['chain'] as const)),
  ]
  const current = universeOfMode(mode)

  // The bar carries a mode switch, a mint button and a wallet pill next to
  // the links: nothing may wrap, so the less essential links only appear
  // where there is room for them.
  const linkBase =
    'whitespace-nowrap font-mono text-[12px] font-bold tracking-wide hover:underline decoration-[3px] decoration-lime underline-offset-4 cursor-pointer'
  const link = `hidden xl:inline-block ${linkBase}`
  const linkWide = `hidden min-[1440px]:inline-block ${linkBase}`

  return (
    <header className="sticky top-0 z-40 border-b-3 border-ink bg-cream/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1480px] items-center gap-4 px-4 py-3 sm:px-6">
        <button className="flex shrink-0 items-center gap-2.5" onClick={onHome}>
          <LogoBlob />
          <span className="font-display text-2xl tracking-wide">SPAWN!</span>
        </button>

        <nav className="ml-auto flex items-center gap-4">
          <button className={`${link} underline`} onClick={() => scrollTo('pit')}>
            THE PIT
          </button>
          <button className={linkWide} onClick={onFreshSpawns}>
            NEW TOKENS
          </button>
          <button className={link} onClick={() => (window.location.hash = '/portfolio')}>
            PORTFOLIO
          </button>
          <button className={link} onClick={() => (window.location.hash = '/dev')}>
            DEV ZONE
          </button>
          <button className={linkWide} onClick={() => scrollTo('how')}>
            HOW IT WORKS
          </button>
          <button className={link} onClick={onOpenLab}>
            LAUNCH LAB ↗
          </button>
        </nav>

        {/* market mode switch: one tab per live mainnet universe, then the
            play worlds. A universe tab wears the logos of the chains it runs. */}
        <div
          className="flex shrink-0 overflow-hidden rounded-full border-2 border-ink font-mono text-[10px] font-bold"
          role="tablist"
          aria-label="Market"
        >
          {modes.map((m, i) => {
            const u = universeOfMode(m)
            const title = u
              ? `${u.name} universe — ${u.line}. Real money. Tokens launched here exist only here.`
              : MODE_TITLE[m as keyof typeof MODE_TITLE]
            return (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                data-mode={m}
                onClick={() => setMode(m)}
                className={`inline-flex items-center gap-1 whitespace-nowrap px-2.5 py-1.5 transition ${
                  mode === m ? 'bg-ink text-lime' : 'bg-white hover:bg-lime'
                } ${i > 0 ? 'border-l-2 border-ink' : ''}`}
                title={title}
              >
                {u ? (
                  <>
                    <span className="flex items-center -space-x-1">
                      {u.logos.map((id) => (
                        <ChainLogo key={id} id={id} size={12} />
                      ))}
                    </span>
                    ◉ {u.tab}
                  </>
                ) : (
                  MODE_LABEL[m as keyof typeof MODE_LABEL]
                )}
              </button>
            )
          })}
        </div>

        {/* status light — makes way for the wallet once one is connected */}
        <div
          className={`hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border-2 border-ink bg-white px-3 py-1.5 font-mono text-[10px] font-bold ${
            wallet ? '' : 'min-[1440px]:flex'
          }`}
        >
          <span
            className={`h-2 w-2 animate-blink rounded-full ${
              !onchain || onchain.status === 'ready' ? 'bg-up' : 'bg-down'
            }`}
          />
          {onchain
            ? onchain.status === 'ready'
              ? onchain.network === 'mainnet'
                ? `${onchain.universe?.name ?? 'MAINNET'} LIVE`
                : onchain.network === 'testnet'
                  ? 'TESTNET LIVE'
                  : 'CHAIN LIVE'
              : onchain.status.toUpperCase()
            : 'SIMULATION'}
        </div>

        {/* play money exists on testnets and the local devnet only */}
        {onchain?.status === 'ready' && wallet && onchain.airdrop && (
          <button
            onClick={() => {
              if (minting) return
              setMinting(true)
              void onchain.airdrop!()
                .catch(() => undefined)
                .finally(() => setMinting(false))
            }}
            disabled={minting}
            title={`Mint 1,337 play ${dollar.symbol} on every chain your wallet has gas on`}
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border-2 border-ink bg-lime px-3 py-2 font-mono text-[10px] font-bold shadow-brutal-sm transition hover:-translate-y-0.5 disabled:opacity-60"
          >
            <CoinLogo id={dollar.coin} size={15} />
            {minting ? 'MINTING…' : `MINT ${dollar.symbol}`}
          </button>
        )}

        <ConnectButton />
      </div>

      {onchain && onchain.status !== 'ready' && (
        <div className="border-t-2 border-ink bg-down px-4 py-1.5 text-center font-mono text-[10px] font-bold tracking-wide text-white">
          {onchain.status === 'connecting'
            ? '⛓ CONNECTING TO THE CHAIN…'
            : current
              ? `⛓ THE ${current.name} UNIVERSE IS UNREACHABLE RIGHT NOW — CHECK YOUR CONNECTION, OR FLIP TO ANOTHER MARKET.`
              : mode === 'testnet'
                ? '⛓ TESTNET DEPLOYMENT NOT LIVE YET — THE MULTIVERSE IS BEING WIRED. FLIP BACK TO SIM FOR NOW.'
                : '⛓ LOCAL CHAIN OFFLINE — RUN `npm run chain` THEN `npm run chain:deploy`, OR FLIP BACK TO SIM.'}
        </div>
      )}
      {onchain?.status === 'ready' && onchain.network === 'testnet' && (
        <div className="border-t-2 border-ink bg-lime px-4 py-1 text-center font-mono text-[9px] font-bold tracking-wide">
          ⛓ PUBLIC TESTNET — REAL CONTRACTS, PLAY MONEY. NOTHING HERE HAS ANY VALUE.
        </div>
      )}
      {/* mainnet: lives inside the sticky header so it never scrolls away */}
      <GuardedBanner />
    </header>
  )
}

/** Connect pill + its dropdown. In on-chain mode with a wallet extension
 * present, connecting offers MetaMask vs the instant burner; once connected
 * the pill opens a small menu showing the source and a DISCONNECT. */
function ConnectButton() {
  const { wallet, connect, onchain } = useStore()
  const dollar = useDollar()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<WalletSource | 'any' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const hasInjected =
    typeof window !== 'undefined' && !!(window as { ethereum?: unknown }).ethereum
  const onchainMode = !!onchain
  // real money never touches a browser-held throwaway key
  const mainnet = onchain?.network === 'mainnet'

  const doConnect = async (source?: WalletSource) => {
    if (busy) return
    setBusy(source ?? 'any')
    setErr(null)
    try {
      await connect(source)
      setOpen(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message.split('\n')[0].slice(0, 140) : 'Connection failed.')
      setOpen(true)
    } finally {
      setBusy(null)
    }
  }

  const onPillClick = () => {
    setErr(null)
    if (onchainMode && (wallet || hasInjected || mainnet)) {
      setOpen((o) => !o)
      return
    }
    void doConnect()
  }

  const option =
    'w-full rounded-lg border-2 border-ink px-3 py-2.5 text-left font-mono text-[11px] font-bold shadow-brutal-sm transition hover:-translate-y-0.5 disabled:opacity-60'

  return (
    <div className="relative shrink-0">
      <button
        onClick={onPillClick}
        data-testid="wallet-pill"
        title={
          wallet && onchainMode
            ? `${fmtUsd(wallet.balance)} in ${dollar.symbol} and oUSD claims across this universe's chains`
            : undefined
        }
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl border-3 border-ink bg-ink px-4 py-2.5 font-mono text-[11px] font-bold tracking-wide text-white shadow-brutal-sm transition hover:-translate-y-0.5 hover:shadow-brutal active:translate-y-0 active:shadow-brutal-sm"
      >
        {wallet ? (
          <>
            <span>
              {onchain?.walletSource === 'injected' ? '🦊' : '●'} {shortAddr(wallet.address)}
            </span>
            {/* on-chain the wallet's dollars are the universe's dollar; the simulation's are not */}
            {onchainMode && <CoinLogo id={dollar.coin} size={15} />}
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
              {hasInjected ? (
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
              ) : (
                mainnet && (
                  <p className="rounded-lg border-2 border-ink bg-white px-3 py-2.5 font-mono text-[10px] font-bold leading-relaxed">
                    NO WALLET EXTENSION FOUND. INSTALL METAMASK (OR ANOTHER WALLET), THEN
                    RELOAD.
                  </p>
                )
              )}
              {mainnet ? (
                <p className="px-1 font-body text-[10px] leading-relaxed opacity-60">
                  Mainnet runs on your own wallet only — burner wallets hold play money and
                  exist on testnet.
                </p>
              ) : (
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
              )}
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
