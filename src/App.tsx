import { useEffect, useState } from 'react'
import { StoreProvider } from './store'
import { OnchainProvider } from './onchain/OnchainProvider'
import { TickerBar } from './components/TickerBar'
import { Nav } from './components/Nav'
import { Hero } from './components/Hero'
import { MarqueeBand } from './components/MarqueeBand'
import { ThePit, type PitTab } from './components/ThePit'
import { HowItWorks } from './components/HowItWorks'
import { Footer } from './components/Footer'
import { GenesisLab } from './components/GenesisLab'
import { CreatureModal } from './components/CreatureModal'

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

export default function App() {
  const [mode, setMode] = useState<AppMode>(loadMode)
  const [labOpen, setLabOpen] = useState(false)
  const [detail, setDetail] = useState<number | null>(null)
  const [pitTab, setPitTab] = useState<PitTab>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    try {
      localStorage.setItem('spawn.mode', mode)
    } catch {
      /* no storage */
    }
  }, [mode])

  const goToPit = (tab: PitTab) => {
    setPitTab(tab)
    document.getElementById('pit')?.scrollIntoView({ behavior: 'smooth' })
  }

  const Provider = mode === 'chain' ? OnchainProvider : StoreProvider

  return (
    <Provider key={mode}>
      <TickerBar />
      <Nav
        mode={mode}
        setMode={setMode}
        onOpenLab={() => setLabOpen(true)}
        onFreshSpawns={() => goToPit('new')}
      />
      <main>
        <Hero onOpenLab={() => setLabOpen(true)} />
        <MarqueeBand />
        <ThePit
          tab={pitTab}
          setTab={setPitTab}
          query={query}
          setQuery={setQuery}
          onOpenCreature={setDetail}
          onOpenLab={() => setLabOpen(true)}
        />
        <HowItWorks />
      </main>
      <Footer onOpenLab={() => setLabOpen(true)} />

      {labOpen && (
        <GenesisLab
          onClose={() => setLabOpen(false)}
          onSpawned={() => {
            setQuery('')
            goToPit('all')
          }}
        />
      )}
      {detail !== null && <CreatureModal num={detail} onClose={() => setDetail(null)} />}
    </Provider>
  )
}
