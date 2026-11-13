import { useEffect, useMemo, useRef } from 'react'
import { useStore, type Creature } from '../store'
import { useChainSet } from '../lib/liveChains'
import { CreatureCard } from './CreatureCard'

export type PitTab = 'all' | 'hot' | 'new' | 'ascended'

const TABS: { id: PitTab; label: string }[] = [
  { id: 'all', label: 'ALL TOKENS' },
  { id: 'hot', label: '🔥 HOT RIGHT NOW' },
  { id: 'new', label: '✳ NEW' },
  { id: 'ascended', label: '⬆ ASCENDED' },
]

function matchesTab(c: Creature, tab: PitTab): boolean {
  switch (tab) {
    case 'all':
      return true
    case 'hot':
      return c.status === 'hot'
    case 'new':
      return Date.now() - c.spawnedAt < 60 * 60_000
    case 'ascended':
      return c.status === 'ascended'
  }
}

function TitleUnderline() {
  return (
    <svg
      className="absolute -bottom-1 left-0 h-2.5 w-[85%]"
      viewBox="0 0 200 12"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d="M3 8 Q 70 2 120 7 T 197 5" fill="none" stroke="#f06eaa" strokeWidth="7" strokeLinecap="round" />
    </svg>
  )
}

export function ThePit({
  tab,
  setTab,
  query,
  setQuery,
  onOpenCreature,
  onOpenLab,
}: {
  tab: PitTab
  setTab: (t: PitTab) => void
  query: string
  setQuery: (q: string) => void
  onOpenCreature: (num: number) => void
  onOpenLab: () => void
}) {
  const { creatures, justSpawned, onchain } = useStore()
  const chainSet = useChainSet()
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return creatures
      .filter((c) => matchesTab(c, tab))
      .filter(
        (c) =>
          !q || c.name.toLowerCase().includes(q) || c.ticker.toLowerCase().includes(q),
      )
      .sort((a, b) => b.change - a.change)
  }, [creatures, tab, query])

  const counts = useMemo(() => {
    const map = {} as Record<PitTab, number>
    for (const t of TABS) map[t.id] = creatures.filter((c) => matchesTab(c, t.id)).length
    return map
  }, [creatures])

  return (
    <section id="pit" className="mx-auto max-w-7xl scroll-mt-24 px-4 pb-20 pt-6 sm:px-6">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="font-mono text-[11px] font-bold tracking-[0.2em]">
            ◉ THE INTERDIMENSIONAL MARKETPLACE / 001
          </p>
          <h2 className="relative mt-2 inline-block font-display text-[clamp(3rem,7vw,5.5rem)] leading-none tracking-wide">
            THE PIT.
            <span className="absolute -right-8 -top-2 text-3xl text-hotpink">✳</span>
            <TitleUnderline />
          </h2>
        </div>
        <div className="max-w-sm text-right">
          <p className="text-[15px] font-semibold leading-snug">
            Freshly spawned. Ferociously unhinged.
            <br />
            Every token starts its life across all {chainSet.lower} chains.
          </p>
          <p className="mt-1 font-mono text-[10px] font-bold tracking-wide opacity-50">
            {!onchain
              ? 'ALL PRICES & TRADES ARE DEMO DATA.'
              : onchain.network === 'mainnet'
                ? 'REAL TOKENS, REAL USDC. ANYONE CAN LAUNCH ANYTHING — NOT ADVICE.'
                : 'REAL CONTRACTS, PLAY MONEY.'}
          </p>
        </div>
      </div>

      {/* toolbar */}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-full border-3 border-ink px-4 py-2 font-mono text-[11px] font-bold tracking-wide transition hover:-translate-y-0.5 ${
              tab === t.id
                ? 'bg-ink text-white shadow-brutal-sm'
                : 'bg-white shadow-brutal-sm hover:bg-lime'
            }`}
          >
            {t.label} {t.id === 'all' ? String(counts.all).padStart(2, '0') : ''}
          </button>
        ))}

        <label className="ml-auto flex min-w-[260px] flex-1 items-center gap-2 rounded-xl border-3 border-ink bg-white px-3.5 py-2.5 shadow-brutal-sm sm:max-w-xs">
          <span className="opacity-50">⌕</span>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="SEARCH A MEME / $TICKER"
            className="w-full bg-transparent font-mono text-[11px] font-bold tracking-wide outline-none placeholder:opacity-40"
          />
          <kbd className="rounded border-2 border-ink/20 px-1.5 py-0.5 font-mono text-[9px] font-bold opacity-50">
            ⌘K
          </kbd>
        </label>
      </div>

      <div className="mt-5 flex items-center justify-between font-mono text-[10px] font-bold tracking-[0.15em] opacity-60">
        <span>{filtered.length} TOKENS LISTED</span>
        <span>▦ SORTED BY MEME VELOCITY ↓</span>
      </div>

      {/* grid */}
      {filtered.length > 0 ? (
        <div className="mt-5 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((c) => (
            <CreatureCard
              key={c.num}
              creature={c}
              highlight={justSpawned === c.num}
              onOpen={() => onOpenCreature(c.num)}
            />
          ))}
        </div>
      ) : (
        <div className="mt-5 flex flex-col items-center gap-5 rounded-2xl border-3 border-dashed border-ink/40 bg-white/50 px-6 py-16 text-center">
          <p className="font-display text-3xl tracking-wide">
            NOTHING FOUND IN THIS DIMENSION.
          </p>
          <button
            onClick={onOpenLab}
            className="rounded-xl border-3 border-ink bg-ink px-6 py-3 font-mono text-[12px] font-bold tracking-wide text-white shadow-brutal transition hover:-translate-y-1 hover:shadow-brutal-lg"
          >
            SPAWN IT YOURSELF ↗
          </button>
        </div>
      )}
    </section>
  )
}
