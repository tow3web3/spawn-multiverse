import { useEffect, useState } from 'react'
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

/** What the mode switch can select. ONE universe on six chains: one mainnet
 * (its manifest lists the chains that are live), the simulation, the public
 * testnet and a local devnet. */
export type AppMode = 'sim' | 'testnet' | 'chain' | 'mainnet'

/** Public demo builds (shareable link) have no LOCAL chain — but testnet works anywhere. */
export const PUBLIC_DEMO = Boolean(import.meta.env.VITE_PUBLIC_DEMO)

/** Where each mode's deployment manifest lives. Mainnet exists on the site
 * only once its manifest is published. */
const MANIFEST: Record<Exclude<AppMode, 'sim'>, string> = {
  testnet: '/onchain/testnet.json',
  chain: '/onchain/deployment.json',
  mainnet: '/onchain/mainnet.json',
}
const LS_MODE = 'spawn.mode'
const LS_MAINNET_SEEN = 'spawn.mode.mainnetSeen'

function loadMode(): AppMode {
  try {
    const m = localStorage.getItem(LS_MODE)
    if (m === 'testnet') return 'testnet'
    // the retired per-universe modes ('bnb', 'ethereum') all mean mainnet now
    if (m === 'mainnet' || m === 'bnb' || m === 'ethereum') return 'mainnet'
    if (m === 'chain') return PUBLIC_DEMO ? 'sim' : 'chain'
    return 'sim'
  } catch {
    return 'sim'
  }
}

/** Mainnet is live only once its manifest is published AND is the v7.2 one
 * (one universe on six chains): a manifest of a retired generation is never
 * offered. A missing file can come back as the app's own index.html with a
 * 200, so the body is checked, not the status. Returns its live chain ids. */
async function probeMainnet(): Promise<string[] | null> {
  try {
    const res = await fetch(MANIFEST.mainnet, { cache: 'no-store' })
    if (!res.ok) return null
    const m = await res.json()
    const ok =
      m?.network === 'mainnet' &&
      m?.generation === 'v7.2' &&
      typeof m?.pad === 'string' &&
      Array.isArray(m?.chains) &&
      m.chains.length > 0
    return ok ? (m.chains as { id: string }[]).map((c) => String(c.id)) : null
  } catch {
    return null
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
  /** The live mainnet chains, once its manifest is found (null: not live). */
  const [mainnet, setMainnet] = useState<string[] | null>(null)
  const [labOpen, setLabOpen] = useState(false)
  const [pitTab, setPitTab] = useState<PitTab>('all')
  const [query, setQuery] = useState('')
  const route = useRoute()

  useEffect(() => {
    let stale = false
    void probeMainnet().then((chains) => {
      if (stale) return
      setMainnet(chains)
      // a remembered mainnet with no manifest behind it (yet)
      setMode((m) => (m === 'mainnet' && !chains ? 'sim' : m))
      if (!chains) return
      // the first visit after mainnet goes live lands on it, once; after
      // that the visitor's own choice of mode is what sticks
      try {
        if (!localStorage.getItem(LS_MAINNET_SEEN)) {
          localStorage.setItem(LS_MAINNET_SEEN, '1')
          setMode('mainnet')
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

  // Switching world: a token page of one deployment means nothing in another
  const switchMode = (m: AppMode) => {
    if (m !== mode && route.page === 'token') navigate('')
    setMode(m)
  }

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
        mainnet={mainnet}
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

  return mode === 'sim' ? (
    <StoreProvider key="sim">{content}</StoreProvider>
  ) : (
    // one provider per mode, remounted on every switch: a deployment's
    // wallet state, tokens and approvals never survive into another
    <OnchainProvider key={mode} manifestUrl={MANIFEST[mode]}>
      {content}
    </OnchainProvider>
  )
}
