const ITEMS = [
  '● MULTIVERSE ONLINE',
  'ONE TOKEN ✳ EVERY CHAIN',
  'NO MORE FRAGMENTED MEMES',
  'ONE GLOBAL SUPPLY',
  'SAME PRICE IN EVERY DIMENSION',
]

export function TickerBar() {
  const row = [...ITEMS, ...ITEMS, ...ITEMS]
  return (
    <div className="overflow-hidden border-b-3 border-ink bg-ink py-1.5">
      <div className="flex w-max animate-marquee-slow">
        {[0, 1].map((half) => (
          <div key={half} className="flex shrink-0 items-center" aria-hidden={half === 1}>
            {row.map((item, i) => (
              <span
                key={i}
                className="whitespace-nowrap px-6 font-mono text-[10px] font-bold tracking-[0.18em] text-lime"
              >
                {item}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
