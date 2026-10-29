const PHRASE = [
  'ONE MEME',
  'SIX CHAINS',
  'ONE GLOBAL SUPPLY',
  'EVERYWHERE AT ONCE',
  'SPAWN IT',
]

function Band({
  className,
  animation,
  muted,
}: {
  className: string
  animation: string
  muted?: boolean
}) {
  const row = [...PHRASE, ...PHRASE]
  return (
    <div className={`overflow-hidden border-y-3 border-ink py-2.5 ${className}`}>
      <div className={`flex w-max ${animation}`}>
        {[0, 1].map((half) => (
          <div key={half} className="flex shrink-0 items-center" aria-hidden={half === 1}>
            {row.map((p, i) => (
              <span
                key={i}
                className={`flex items-center whitespace-nowrap font-display text-xl tracking-wider ${
                  muted ? 'text-ink/40' : 'text-ink'
                }`}
              >
                <span className="px-5">{p}</span>
                <span className={muted ? 'text-ink/30' : 'text-cream'}>✳</span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export function MarqueeBand() {
  return (
    <div className="relative my-10 h-24 overflow-visible">
      <div className="absolute inset-x-[-2%] top-6 rotate-[1.2deg]">
        <Band className="bg-grape/50" animation="animate-marquee-slow" muted />
      </div>
      <div className="absolute inset-x-[-2%] top-4 -rotate-[1.4deg]">
        <Band className="bg-grape shadow-brutal" animation="animate-marquee" />
      </div>
    </div>
  )
}
