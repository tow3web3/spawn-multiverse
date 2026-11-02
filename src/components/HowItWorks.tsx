import { useState } from 'react'
import { useStore } from '../store'
import { CHAINS } from '../lib/chains'
import { fmtPrice } from '../lib/format'
import { Asterisk } from './bits'

const STEPS = [
  {
    num: '01',
    title: 'SPAWN ONCE',
    bg: '#c9f24b',
    body: 'Upload an image, name your token, hit launch. One native deployment goes live on all six chains in a single coordinated genesis — no bridging, no wrapped versions, no knock-off contracts.',
  },
  {
    num: '02',
    title: 'ONE GLOBAL SUPPLY',
    bg: '#f7a8ce',
    body: 'Your total supply is allocated across every native deployment. Not one full supply per chain — one supply for the whole multiverse, so the market cap means the same thing everywhere.',
  },
  {
    num: '03',
    title: 'ONE PRICE EVERYWHERE',
    bg: '#9ccbf5',
    body: 'Every trade from every chain hits one global genesis curve, so your token costs the same on Solana, Ethereum, Base, BNB, Arbitrum and Optimism. Fill the curve and the token ascends to the omnipool.',
  },
]

const MORE = [
  {
    title: 'WHY IS THE PRICE THE SAME?',
    body: 'Because there is only ONE market. Every buy and sell — from any chain — executes against the same global curve. The price isn’t synchronized between chains; it’s the same number because it’s the same market. Nothing to arbitrage.',
  },
  {
    title: 'THE CURVE, THEN ASCENSION',
    body: 'Every token starts on a launch curve: 800M of the 1B supply sells there, starting near zero. Around $86K market cap the curve completes and the token ASCENDS — everything raised plus the reserved 200M seed a permanent pool. Trading never stops.',
  },
  {
    title: 'YOUR BAG IS CHAIN-NATIVE',
    body: 'Buy from Base and you hold real tokens ON Base — not an IOU. Sell them from the chain where they live. Across all six chains the total supply always adds up to exactly 1,000,000,000. Always.',
  },
  {
    title: 'FIXED RULES FOR EVERYONE',
    body: 'Supply is 1B for every token — not configurable, no hidden premine. The only head start anyone can get is a public dev buy at launch, visible to all. Pool liquidity belongs to the protocol forever: it can never be pulled.',
  },
]

export function HowItWorks() {
  const { creatures } = useStore()
  const [more, setMore] = useState(false)
  const gloop = creatures.find((c) => c.ticker === 'GLOOP')
  const price = gloop ? fmtPrice(gloop.price) : '$0.0000412'

  return (
    <section id="how" className="scroll-mt-24 border-y-3 border-ink bg-ink py-16 text-white">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <p className="font-mono text-[11px] font-bold tracking-[0.2em] text-lime">
          ◉ THE GENESIS PROTOCOL / 002
        </p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <h2 className="font-display text-[clamp(2.6rem,6vw,4.5rem)] leading-none tracking-wide">
            HOW IT WORKS<span className="text-lime">.</span>
          </h2>
          <p className="pb-2 font-mono text-[11px] font-bold tracking-wide text-white/50">
            ONE GENESIS. SIX CHAINS. ZERO FRAGMENTATION.
          </p>
        </div>

        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {STEPS.map((s) => (
            <div
              key={s.num}
              className="relative overflow-hidden rounded-2xl border-3 border-ink p-6 text-ink shadow-[6px_6px_0_0_rgba(201,242,75,0.35)] transition hover:-translate-y-1"
              style={{ background: s.bg }}
            >
              <Asterisk size={120} className="absolute -right-6 -top-6 opacity-10" />
              <p className="font-display text-5xl tracking-wide opacity-25">{s.num}</p>
              <h3 className="mt-3 font-display text-2xl tracking-wide">{s.title}</h3>
              <p className="mt-3 text-[14px] font-medium leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>

        {/* deeper dive, on demand */}
        <div className="mt-8 text-center">
          <button
            onClick={() => setMore((m) => !m)}
            aria-expanded={more}
            className="rounded-xl border-3 border-lime bg-transparent px-6 py-3 font-mono text-[12px] font-bold tracking-[0.15em] text-lime transition hover:bg-lime hover:text-ink"
          >
            {more ? 'LESS ↑' : 'MORE ↓'}
          </button>
        </div>
        {more && (
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {MORE.map((m) => (
              <div key={m.title} className="rounded-2xl border-2 border-white/15 bg-void p-5">
                <h4 className="font-display text-lg tracking-wide text-lime">{m.title}</h4>
                <p className="mt-2 text-[14px] font-medium leading-relaxed text-white/80">
                  {m.body}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* live proof strip */}
        <div className="mt-10 rounded-2xl border-3 border-white/20 bg-void p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-[10px] font-bold tracking-[0.2em] text-lime">
              LIVE PROOF // $GLOOP GLOBAL PRICE REFERENCE
            </p>
            <p className="font-mono text-[10px] font-bold tracking-wide text-white/40">
              SAME NUMBER. SIX CHAINS. REFRESHED EVERY BLOCK-ISH.
            </p>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {CHAINS.map((ch) => (
              <div
                key={ch.id}
                className="rounded-xl border-2 border-white/15 bg-ink px-3 py-3 text-center"
              >
                <span
                  className="mx-auto flex h-7 w-fit min-w-7 items-center justify-center rounded-full border-2 border-ink px-1 font-mono text-[10px] font-bold text-ink"
                  style={{ background: ch.color }}
                >
                  {ch.short}
                </span>
                <p className="mt-2 font-mono text-[9px] font-bold tracking-wide text-white/40">
                  {ch.label}
                </p>
                <p className="mt-1 font-mono text-[12px] font-bold text-lime">{price}</p>
                <p className="mt-0.5 font-mono text-[8px] font-bold text-up">SYNCED ✓</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
