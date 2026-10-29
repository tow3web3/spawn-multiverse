import { useState } from 'react'
import { StoreProvider } from './store'
import { TickerBar } from './components/TickerBar'
import { Nav } from './components/Nav'
import { Hero } from './components/Hero'
import { MarqueeBand } from './components/MarqueeBand'
import { ThePit, type PitTab } from './components/ThePit'
import { HowItWorks } from './components/HowItWorks'
import { Footer } from './components/Footer'
import { GenesisLab } from './components/GenesisLab'
import { CreatureModal } from './components/CreatureModal'

export default function App() {
  const [labOpen, setLabOpen] = useState(false)
  const [detail, setDetail] = useState<number | null>(null)
  const [pitTab, setPitTab] = useState<PitTab>('all')
  const [query, setQuery] = useState('')

  const goToPit = (tab: PitTab) => {
    setPitTab(tab)
    document.getElementById('pit')?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <StoreProvider>
      <TickerBar />
      <Nav onOpenLab={() => setLabOpen(true)} onFreshSpawns={() => goToPit('new')} />
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
    </StoreProvider>
  )
}
