import { useState } from 'react'
import { useStore } from '../store'
import { fmtPrice } from '../lib/format'
import { useChainSet, type ChainSet } from '../lib/liveChains'
import { Asterisk } from './bits'
import { ChainLogo } from './ChainLogos'

/** The four pillars. The copy counts and names the chains this mode really
 * runs — the simulation runs all six, a deployment runs what its manifest
 * lists. */
const steps = (cs: ChainSet) => [
  {
    num: '01',
    title: 'SPAWN ONCE',
    bg: '#c9f24b',
    body: `Upload an image, name your token, hit launch. One native deployment goes live on all ${cs.lower} chains ${
      cs.soon.length ? 'from a single transaction' : 'in a single coordinated genesis'
    } — no bridging, no wrapped versions, no knock-off contracts.`,
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
    body: `Every trade from every chain hits one global genesis curve, so your token costs the same on ${cs.names}. Fill the curve and the token ascends to the omnipool.`,
  },
  {
    num: '04',
    title: '🛡 FAIR GENESIS',
    bg: '#f7be7b',
    body: 'Snipers get nothing here. The spawn block refuses every buy — block 0 does not exist. For the first 10 minutes, buys pay a snipe tax decaying 30%→1%, routed like every fee — to your holders, you, or the burn — with a $250 cap per wallet.',
  },
]

const more = (cs: ChainSet, onchain: boolean, hubChain: string | undefined) => [
  {
    title: 'WHY SNIPERS LOSE HERE',
    body: 'Three walls. The spawn block bounces every buy — refunded in full, block 0 does not exist. For 10 minutes a snipe tax decays 30%→1% and is routed like the token’s fees — to its holders, its dev, or the burn — so early snipes fund everyone else. And a $250 per-wallet cap keeps the opening human-sized. Sniping from another chain is structurally impossible anyway: a cross-chain buy takes minutes to arrive. The one disclosed exemption is the creator’s public dev buy at launch.',
  },
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
    body: `Buy from Base and you hold real tokens ON Base — not an IOU. Sell them from the chain where they live. Across all ${cs.lower} chains the total supply always adds up to exactly 1,000,000,000. Always.`,
  },
  {
    title: 'FIXED RULES FOR EVERYONE',
    body: 'Supply is 1B for every token — not configurable, no hidden premine. The only head start anyone can get is a public dev buy at launch, visible to all. Pool liquidity belongs to the protocol forever: it can never be pulled.',
  },
  // how real dollars and real messages behave — only where they exist
  ...(onchain
    ? [
        {
          title: 'YOUR DOLLARS ARE USDC',
          body: 'You trade in USDC, and every chain keeps its own vault: a buy puts USDC in, a sell or a refund pays USDC out on the chain you sold from. If that chain’s vault is ever short you get oUSD instead — a 1:1 claim on the vault that you redeem once liquidity is rebalanced. Holder rewards are paid in oUSD too; spend it as it is or unwrap it.',
        },
        {
          title: 'WHAT CROSSING CHAINS COSTS',
          body: hubChain
            ? `The market lives on ${hubChain}. Trade from ${hubChain} and it is one transaction: no bridge, no wait, no message fee. Trade from another chain and your order crosses LayerZero and comes back — a minute or three, and a network fee that pays the round trip, shown before you sign. Holder fees work the same way: at home they arrive by themselves; elsewhere they wait on the hub until someone pays to pull them.`
            : 'Every order is a message to the one market and a message back. Whoever sends it pays for the round trip: a network fee shown before you sign.',
        },
      ]
    : []),
]

export function HowItWorks() {
  const { creatures, onchain } = useStore()
  const cs = useChainSet()
  const [open, setOpen] = useState(false)
  // the proof strip quotes a real creature — never a made-up number on-chain
  const ref =
    creatures.find((c) => c.ticker === 'GLOOP') ?? [...creatures].sort((a, b) => b.mcap - a.mcap)[0]
  const price = ref ? fmtPrice(ref.price) : onchain ? null : '$0.0000412'
  const hubChain = cs.live.find((c) => onchain?.chainInfo?.[c.id]?.local)
  const hubName = hubChain ? hubChain.label.charAt(0) + hubChain.label.slice(1).toLowerCase() : undefined

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
            ONE GENESIS. {cs.word} CHAIN{cs.count === 1 ? '' : 'S'}. ZERO FRAGMENTATION.
          </p>
        </div>

        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {steps(cs).map((s) => (
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
            onClick={() => setOpen((m) => !m)}
            aria-expanded={open}
            className="rounded-xl border-3 border-lime bg-transparent px-6 py-3 font-mono text-[12px] font-bold tracking-[0.15em] text-lime transition hover:bg-lime hover:text-ink"
          >
            {open ? 'LESS ↑' : 'MORE ↓'}
          </button>
        </div>
        {open && (
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {more(cs, !!onchain, hubName).map((m) => (
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
        {price && (
          <div className="mt-10 rounded-2xl border-3 border-white/20 bg-void p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-mono text-[10px] font-bold tracking-[0.2em] text-lime">
                LIVE PROOF // ${ref?.ticker ?? 'GLOOP'} GLOBAL PRICE REFERENCE
              </p>
              <p className="font-mono text-[10px] font-bold tracking-wide text-white/40">
                SAME NUMBER. {cs.word} CHAIN{cs.count === 1 ? '' : 'S'}. REFRESHED EVERY BLOCK-ISH.
              </p>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {cs.live.map((ch) => (
                <div
                  key={ch.id}
                  className="rounded-xl border-2 border-white/15 bg-ink px-3 py-3 text-center"
                >
                  <span className="mx-auto flex h-8 w-8 items-center justify-center">
                    <ChainLogo id={ch.id} size={30} />
                  </span>
                  <p className="mt-2 font-mono text-[9px] font-bold tracking-wide text-white/40">
                    {ch.label}
                  </p>
                  <p className="mt-1 font-mono text-[12px] font-bold text-lime">{price}</p>
                  <p className="mt-0.5 font-mono text-[8px] font-bold text-up">SYNCED ✓</p>
                </div>
              ))}
              {cs.soon.map((ch) => (
                <div
                  key={ch.id}
                  className="rounded-xl border-2 border-dashed border-white/15 px-3 py-3 text-center opacity-50"
                >
                  <span className="mx-auto flex h-8 w-8 items-center justify-center grayscale">
                    <ChainLogo id={ch.id} size={30} />
                  </span>
                  <p className="mt-2 font-mono text-[9px] font-bold tracking-wide text-white/40">
                    {ch.label}
                  </p>
                  <p className="mt-1 font-mono text-[12px] font-bold text-white/40">—</p>
                  <p className="mt-0.5 font-mono text-[8px] font-bold text-white/40">SOON</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
