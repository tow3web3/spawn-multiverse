import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { chainName, useChainSet } from '../lib/liveChains'
import { ChainLogo } from './ChainLogos'

/** "0x1E71…9131" */
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** Clipboard write, with the old textarea route where the async API is
 * refused (insecure origin, no permission). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const t = document.createElement('textarea')
      t.value = text
      t.setAttribute('readonly', '')
      t.style.position = 'fixed'
      t.style.opacity = '0'
      document.body.appendChild(t)
      t.select()
      const ok = document.execCommand('copy')
      t.remove()
      return ok
    } catch {
      return false
    }
  }
}

function CopyButton({ text, what }: { text: string; what: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      data-copy={text}
      aria-label={`Copy the ${what} address`}
      onClick={() => {
        void copyText(text).then((ok) => {
          setState(ok ? 'copied' : 'failed')
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setState('idle'), 1600)
        })
      }}
      className={`shrink-0 rounded border-2 border-ink px-1.5 py-0.5 font-mono text-[9px] font-bold transition ${
        state === 'copied' ? 'bg-lime' : state === 'failed' ? 'bg-hotpink' : 'bg-white hover:bg-lime'
      }`}
    >
      {state === 'copied' ? 'COPIED ✓' : state === 'failed' ? 'COPY FAILED' : 'COPY'}
    </button>
  )
}

function ExplorerLink({ base, address, chain }: { base?: string; address: string; chain: string }) {
  if (!base) return null
  return (
    <a
      href={`${base}/token/${address}`}
      target="_blank"
      rel="noopener noreferrer"
      data-explorer={chain}
      title={`Open on ${base.replace(/^https?:\/\//, '')}`}
      className="shrink-0 rounded border-2 border-ink bg-white px-1.5 py-0.5 font-mono text-[9px] font-bold hover:bg-lime"
    >
      ↗
    </a>
  )
}

/**
 * CONTRACT ADDRESSES · SIX CHAINS — the token's address on each chain: the
 * replica that chain's gateway mints (what a buy there delivers, what a
 * wallet holds, what to add to a wallet), the chains it is not open on yet,
 * a chain with a day to join, and apart from them the hub's own token (the
 * curve's canonical record — wallets never hold it). On-chain modes only:
 * the simulation has no addresses.
 */
export function ContractAddresses({
  num,
  ticker,
  onOpenOn,
}: {
  num: number
  ticker: string
  /** Select `chain` in the trade panel, where the open-it action lives. */
  onOpenOn: (chain: string) => void
}) {
  const { onchain } = useStore()
  const cs = useChainSet()
  const k = onchain?.contracts?.[num]
  if (!onchain || !k) return null
  const info = onchain.chainInfo ?? {}
  const na = onchain.unavailable?.[num] ?? {}

  const row = 'flex min-w-0 items-center gap-2 rounded-lg border-2 px-2 py-1.5'
  return (
    <div className="rounded-2xl border-3 border-ink bg-white p-4 shadow-brutal-sm" data-testid="contract-addresses">
      <p className="font-mono text-[10px] font-bold tracking-[0.15em] opacity-60">
        {/* the universe is six chains: a deployment running fewer (the
            testnet) is not counted out loud */}
        CONTRACT ADDRESSES · {cs.count === 6 ? 'SIX CHAINS' : cs.single ? cs.names.toUpperCase() : 'EVERY LIVE CHAIN'}
      </p>
      <p className="mt-1 font-mono text-[9px] font-bold leading-relaxed opacity-45">
        ADD ${ticker} TO YOUR WALLET WITH THE ADDRESS OF THE CHAIN YOU HOLD IT ON — EACH CHAIN HAS ITS OWN.
      </p>
      <div className="mt-2 flex flex-col gap-1.5">
        {cs.live.map((ch) => {
          const addr = k.replicas[ch.id]
          const why = na[ch.id]
          return (
            <div
              key={ch.id}
              data-ca-chain={ch.id}
              data-ca={addr ?? ''}
              className={`${row} ${addr ? 'border-ink/20 bg-cream/60' : 'border-dashed border-ink/30'}`}
            >
              <ChainLogo id={ch.id} size={18} />
              <span className="w-[4.5rem] shrink-0 truncate font-mono text-[10px] font-bold sm:w-20">
                {chainName(ch.id).toUpperCase()}
              </span>
              {addr ? (
                <>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-bold" title={addr}>
                    {short(addr)}
                  </span>
                  <CopyButton text={addr} what={`${chainName(ch.id)} ${ticker}`} />
                  <ExplorerLink base={info[ch.id]?.explorer} address={addr} chain={ch.id} />
                </>
              ) : why === 'closed' ? (
                <>
                  <span className="min-w-0 flex-1 truncate font-mono text-[9px] font-bold opacity-55">NOT OPEN HERE YET</span>
                  <button
                    type="button"
                    onClick={() => onOpenOn(ch.id)}
                    className="shrink-0 rounded border-2 border-ink bg-white px-1.5 py-0.5 font-mono text-[9px] font-bold hover:bg-lime"
                  >
                    OPEN IT
                  </button>
                </>
              ) : (
                <span className="min-w-0 flex-1 truncate font-mono text-[9px] font-bold opacity-55">
                  {why === 'failed' ? 'NOT AVAILABLE HERE YET' : why === 'arriving' ? 'ARRIVING…' : 'NOT HERE YET'}
                </span>
              )}
            </div>
          )
        })}
        {/* TODO(solana): once the mainnet manifest lists Solana, show the
            replica's SPL mint — a PDA of the gateway program, seeds
            ["Mint", hub token as 32 bytes] — with a solscan.io/token link.
            Needs the program id in the manifest and an ed25519 off-curve
            check in the browser; the provider cannot derive it today. */}
        {cs.joining.map(({ chain: jc, text, sentence }) => (
          <div key={jc.id} data-ca-chain={jc.id} data-joining={jc.id} className={`${row} border-dashed border-ink/30`} title={sentence}>
            <ChainLogo id={jc.id} size={18} />
            <span className="w-[4.5rem] shrink-0 truncate font-mono text-[10px] font-bold sm:w-20">
              {chainName(jc.id).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1" />
            <span className="shrink-0 whitespace-nowrap rounded bg-ink px-1 font-mono text-[8px] font-bold text-lime">{text}</span>
          </div>
        ))}
      </div>

      {/* the hub's own token: canonical, not what a wallet holds */}
      <div className="mt-3 border-t-2 border-dashed border-ink/20 pt-2.5">
        <div className={`${row} border-ink/20 bg-white`} data-ca-hub={k.hub}>
          <ChainLogo id={k.hubChain} size={18} />
          <span className="w-[4.5rem] shrink-0 truncate font-mono text-[10px] font-bold sm:w-20">HUB TOKEN</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-bold" title={k.hub}>
            {short(k.hub)}
          </span>
          <CopyButton text={k.hub} what={`hub ${ticker}`} />
          <ExplorerLink base={info[k.hubChain]?.explorer} address={k.hub} chain={`hub-${k.hubChain}`} />
        </div>
        <p className="mt-1.5 font-mono text-[9px] font-bold leading-relaxed opacity-45">
          THE CANONICAL ${ticker} ON THE HUB ({chainName(k.hubChain).toUpperCase()}): THE CURVE&apos;S OWN RECORD OF THE SUPPLY.
          WALLETS DO NOT HOLD IT — ON {chainName(k.hubChain).toUpperCase()} TOO, YOUR ${ticker} IS THE ADDRESS ABOVE.
        </p>
      </div>
    </div>
  )
}
