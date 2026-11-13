import { useStore } from '../store'
import { ChainDots } from './bits'

export function Footer({ onOpenLab }: { onOpenLab: () => void }) {
  const { onchain } = useStore()
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
          {/* what the page in front of you actually is, mode by mode */}
          <p className="mt-4 max-w-md font-mono text-[10px] leading-relaxed opacity-45">
            {!onchain
              ? 'Simulation. Every price, trade and holder on this page is simulated demo data. No blockchain transactions are submitted, no financial advice is dispensed, and no creatures were harmed in any dimension.'
              : onchain.network === 'mainnet'
                ? `Guarded beta on mainnet${onchain.universe ? ` — the ${onchain.universe.name} universe (${onchain.universe.line})` : ''}. These contracts are unaudited and hold real ${onchain.dollar.symbol}${
                    onchain.universe?.id === 'bnb' ? ' (a Binance-custodied peg)' : ''
                  } under ${onchain.universe?.single ? '' : 'per-chain '}deposit caps; a bug can lose funds for good.${
                    onchain.universe?.id === 'ethereum' ? ' Every action pays Ethereum L1 gas.' : ''
                  }${onchain.universe ? ' A token launched in one universe does not exist in another.' : ''} Tokens here are launched by anyone and can go to zero. Nothing on this page is financial advice. Use it only where that is legal, and only with money you can lose.`
                : onchain.network === 'testnet'
                  ? 'Public testnet. Real contracts and real transactions on test networks, paid for with play money that has no value. No financial advice is dispensed, and no creatures were harmed in any dimension.'
                  : 'Local devnet. Real contracts on your own node, play money, no value. No creatures were harmed in any dimension.'}
          </p>
          {onchain?.risk && (
            <button
              onClick={() => onchain.risk!.show()}
              className="mt-2 font-mono text-[10px] font-bold underline decoration-2 underline-offset-2 hover:no-underline"
            >
              READ THE RISK NOTICE →
            </button>
          )}
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
