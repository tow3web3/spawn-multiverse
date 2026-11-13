import { useChainSet } from '../lib/liveChains'

function Band({
  phrase,
  className,
  animation,
  muted,
}: {
  phrase: string[]
  className: string
  animation: string
  muted?: boolean
}) {
  const row = [...phrase, ...phrase]
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
  const { word, count } = useChainSet()
  const phrase = [
    'ONE MEME',
    `${word} CHAIN${count === 1 ? '' : 'S'}`,
    'ONE GLOBAL SUPPLY',
    'EVERYWHERE AT ONCE',
    'BLOCK 0 DOES NOT EXIST',
    'SPAWN IT',
  ]
  return (
    <div className="relative my-10 h-24 overflow-visible">
      <div className="absolute inset-x-[-2%] top-6 rotate-[1.2deg]">
        <Band phrase={phrase} className="bg-grape/50" animation="animate-marquee-slow" muted />
      </div>
      <div className="absolute inset-x-[-2%] top-4 -rotate-[1.4deg]">
        <Band phrase={phrase} className="bg-grape shadow-brutal" animation="animate-marquee" />
      </div>
    </div>
  )
}
