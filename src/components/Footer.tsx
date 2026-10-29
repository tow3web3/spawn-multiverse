import { ChainDots } from './bits'

export function Footer({ onOpenLab }: { onOpenLab: () => void }) {
  return (
    <footer className="bg-cream">
      <div className="mx-auto flex max-w-7xl flex-wrap items-end justify-between gap-8 px-4 py-14 sm:px-6">
        <div>
          <p className="font-display text-5xl tracking-wide">
            SPAWN!<span className="text-hotpink">✳</span>
          </p>
          <p className="mt-1 font-mono text-[10px] font-bold tracking-[0.2em] opacity-50">
            THE OMNICHAIN MEME MACHINE — 2026
          </p>
          <p className="mt-4 max-w-md font-mono text-[10px] leading-relaxed opacity-45">
            Prototype. Every price, trade and holder on this page is simulated demo data. No
            blockchain transactions are submitted, no financial advice is dispensed, and no
            creatures were harmed in any dimension.
          </p>
        </div>

        <div className="flex flex-col items-start gap-3 sm:items-end">
          <ChainDots />
          <nav className="flex gap-5 font-mono text-[11px] font-bold tracking-wide">
            <a href="#pit" className="hover:underline decoration-[3px] decoration-lime underline-offset-4">
              THE PIT
            </a>
            <button
              onClick={onOpenLab}
              className="hover:underline decoration-[3px] decoration-lime underline-offset-4"
            >
              GENESIS LAB
            </button>
            <a href="#how" className="hover:underline decoration-[3px] decoration-lime underline-offset-4">
              HOW IT WORKS
            </a>
          </nav>
        </div>
      </div>
    </footer>
  )
}
