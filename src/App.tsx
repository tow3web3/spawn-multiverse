import { useEffect, useMemo, useState } from 'react'
import { StoreProvider } from './store'
import { OnchainProvider } from './onchain/OnchainProvider'
import { TickerBar } from './components/TickerBar'
import { Nav } from './components/Nav'
import { Hero } from './components/Hero'
import { MarqueeBand } from './components/MarqueeBand'
import { TrendingNow } from './components/TrendingNow'
import { ThePit, type PitTab } from './components/ThePit'
import { HowItWorks } from './components/HowItWorks'
import { Footer } from './components/Footer'
import { GenesisLab } from './components/GenesisLab'
import { TokenPage } from './components/TokenPage'
import { PortfolioPage } from './components/PortfolioPage'
import { DevDashboard } from './components/DevDashboard'
import { RiskNotice } from './components/Guarded'
import {
  UNIVERSES,
  UniverseNavCtx,
  universeOf,
  universeOfMode,
  type AppMode,
  type UniverseDef,
  type UniverseId,
} from './lib/universes'

export type { AppMode } from './lib/universes'

/** Public demo builds (shareable link) have no LOCAL chain — but testnet works anywhere. */
export const PUBLIC_DEMO = Boolean(import.meta.env.VITE_PUBLIC_DEMO)

/** Where each mode's deployment manifest lives. Mainnet is one manifest PER
 * UNIVERSE: a universe exists on the site only once its file is published. */
const MANIFEST: Record<Exclude<AppMode, 'sim'>, string> = {
  testnet: '/onchain/testnet.json',
  chain: '/onchain/deployment.json',
  ...(Object.fromEntries(UNIVERSES.map((u) => [u.mode, u.manifest])) as Record<
    UniverseDef['mode'],
    string
  >),
}
const LS_MODE = 'spawn.mode'
const LS_MAINNET_SEEN = 'spawn.mode.mainnetSeen'
const UNIVERSE_MODES = new Set<string>(UNIVERSES.map((u) => u.mode))

function loadMode(): AppMode {
  try {
    const m = localStorage.getItem(LS_MODE)
    if (m === 'testnet') return 'testnet'
    if (m && UNIVERSE_MODES.has(m)) return m as AppMode
    if (m === 'chain') return PUBLIC_DEMO ? 'sim' : 'chain'
    return 'sim'
  } catch {
    return 'sim'
  }
}

/** A universe exists only once its manifest is published AND names it. A
 * missing file can come back as the app's own index.html with a 200, so the
 * body is checked, not the status. */
async function probeUniverse(u: UniverseDef): Promise<boolean> {
  try {
    const res = await fetch(u.manifest, { cache: 'no-store' })
    if (!res.ok) return false
    const m = await res.json()
    return (
      m?.network === 'mainnet' &&
      typeof m?.pad === 'string' &&
      Array.isArray(m?.chains) &&
      (m?.universe ?? 'core') === u.id
    )
  } catch {
    return false
  }
}

/* Tiny hash router: '', '#/token/3', '#/portfolio', '#/dev'. */
type Route = { page: 'home' } | { page: 'token'; num: number } | { page: 'portfolio' } | { page: 'dev' }

function parseRoute(hash: string): Route {
  const token = hash.match(/^#\/token\/(\d+)/)
  if (token) return { page: 'token', num: Number(token[1]) }
  if (hash.startsWith('#/portfolio')) return { page: 'portfolio' }
  if (hash.startsWith('#/dev')) return { page: 'dev' }
  return { page: 'home' }
}

export function navigate(path: string) {
  window.location.hash = path
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return route
}

export default function App() {
  const [mode, setMode] = useState<AppMode>(loadMode)
  /** null while the mainnet manifests are being looked for. */
  const [live, setLive] = useState<UniverseDef[] | null>(null)
  const [labOpen, setLabOpen] = useState(false)
  const [pitTab, setPitTab] = useState<PitTab>('all')
  const [query, setQuery] = useState('')
  const route = useRoute()

  useEffect(() => {
    let stale = false
    void Promise.all(UNIVERSES.map(async (u) => ((await probeUniverse(u)) ? u : null))).then((found) => {
      if (stale) return
      const universes = found.filter((u): u is UniverseDef => u !== null)
      setLive(universes)
      // a remembered universe with no manifest behind it any more
      setMode((m) =>
        UNIVERSE_MODES.has(m) && !universes.some((u) => u.mode === m) ? (universes[0]?.mode ?? 'sim') : m,
      )
      if (universes.length === 0) return
      // the first visit after mainnet goes live lands on it, once — on the
      // omnichain universe when it exists; after that the visitor's own
      // choice of mode is what sticks
      try {
        if (!localStorage.getItem(LS_MAINNET_SEEN)) {
          localStorage.setItem(LS_MAINNET_SEEN, '1')
          setMode((universes.find((u) => u.id === 'core') ?? universes[0]).mode)
        }
      } catch {
        /* no storage */
      }
    })
    return () => {
      stale = true
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(LS_MODE, mode)
    } catch {
      /* no storage */
    }
  }, [mode])

  // Switching universe: a token page of one universe means nothing in another
  const switchMode = (m: AppMode) => {
    if (m !== mode && route.page === 'token') navigate('')
    setMode(m)
  }

  const nav = useMemo(
    () => ({
      live: live ?? [],
      current: universeOfMode(mode)?.id,
      go: (id: UniverseId) => {
        const u = universeOf(id)
        if (u) switchMode(u.mode)
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live, mode, route.page],
  )

  const goToPit = (tab: PitTab) => {
    setPitTab(tab)
    navigate('')
    window.setTimeout(
      () => document.getElementById('pit')?.scrollIntoView({ behavior: 'smooth' }),
      60,
    )
  }
  const goHome = () => {
    navigate('')
    window.setTimeout(() => window.scrollTo({ top: 0 }), 30)
  }
  const openToken = (num: number) => navigate(`/token/${num}`)

  const content = (
    <>
      <TickerBar />
      <Nav
        mode={mode}
        setMode={switchMode}
        universes={live ?? []}
        onOpenLab={() => setLabOpen(true)}
        onFreshSpawns={() => goToPit('new')}
        onHome={goHome}
      />
      <main>
        {route.page === 'token' ? (
          <TokenPage num={route.num} onBack={goHome} />
        ) : route.page === 'portfolio' ? (
          <PortfolioPage onOpenToken={openToken} onBack={goHome} />
        ) : route.page === 'dev' ? (
          <DevDashboard
            onOpenToken={openToken}
            onOpenLab={() => setLabOpen(true)}
            onBack={goHome}
          />
        ) : (
          <>
            <Hero onOpenLab={() => setLabOpen(true)} onOpenCreature={openToken} />
            <TrendingNow onOpen={openToken} />
            <MarqueeBand />
            <ThePit
              tab={pitTab}
              setTab={setPitTab}
              query={query}
              setQuery={setQuery}
              onOpenCreature={openToken}
              onOpenLab={() => setLabOpen(true)}
            />
            <HowItWorks />
          </>
        )}
      </main>
      <Footer onOpenLab={() => setLabOpen(true)} />

      {labOpen && (
        <GenesisLab
          onClose={() => setLabOpen(false)}
          onSpawned={(num) => {
            setQuery('')
            openToken(num)
          }}
        />
      )}
      <RiskNotice />
    </>
  )

  return (
    <UniverseNavCtx.Provider value={nav}>
      {mode === 'sim' ? (
        <StoreProvider key="sim">{content}</StoreProvider>
      ) : (
        // one provider per mode, remounted on every switch: a universe's
        // wallet state, tokens and approvals never survive into another
        <OnchainProvider key={mode} manifestUrl={MANIFEST[mode]}>
          {content}
        </OnchainProvider>
      )}
    </UniverseNavCtx.Provider>
  )
}
