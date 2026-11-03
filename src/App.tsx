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

export type AppMode = 'sim' | 'chain'

/** Public demo builds (shareable link) have no local chain to talk to. */
export const PUBLIC_DEMO = Boolean(import.meta.env.VITE_PUBLIC_DEMO)

function loadMode(): AppMode {
  if (PUBLIC_DEMO) return 'sim'
  try {
    const m = localStorage.getItem('spawn.mode')
    return m === 'chain' ? 'chain' : 'sim'
  } catch {
    return 'sim'
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
  const [labOpen, setLabOpen] = useState(false)
  const [pitTab, setPitTab] = useState<PitTab>('all')
  const [query, setQuery] = useState('')
  const route = useRoute()

  useEffect(() => {
    try {
      localStorage.setItem('spawn.mode', mode)
    } catch {
      /* no storage */
    }
  }, [mode])

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

  const Provider = mode === 'chain' ? OnchainProvider : StoreProvider

  return (
    <Provider key={mode}>
      <TickerBar />
      <Nav
        mode={mode}
        setMode={setMode}
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
    </Provider>
  )
}
