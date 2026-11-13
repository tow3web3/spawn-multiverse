import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { CHAINS } from '../lib/chains'
import { useChainSet, useDollar } from '../lib/liveChains'
import { useUniverseNav } from '../lib/universes'
import { ChainLogo, CoinLogo } from './ChainLogos'

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

/** MAINNET only: the strip that never goes away. It says WHICH universe this
 * is (its tokens exist nowhere else), what it is (an unaudited beta holding
 * real dollars), how much each chain's vault may hold, and where the other
 * universes are. */
export function GuardedBanner() {
  const { onchain } = useStore()
  const dollar = useDollar()
  const nav = useUniverseNav()
  if (!onchain || onchain.network !== 'mainnet' || onchain.status !== 'ready') return null
  const info = onchain.chainInfo ?? {}
  const caps = CHAINS.filter((c) => info[c.id]).map((c) => ({ ...c, ...info[c.id] }))
  const u = onchain.universe
  const others = nav.live.filter((x) => x.id !== u?.id)

  return (
    <div className="border-t-2 border-ink bg-tang" data-testid="guarded-banner">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 font-mono text-[10px] font-bold tracking-wide sm:px-6">
        {u && (
          <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-ink bg-white px-2.5 py-0.5" title={u.line}>
            <span className="flex items-center -space-x-1">
              {caps.map((c) => (
                <ChainLogo key={c.id} id={c.id} size={13} />
              ))}
            </span>
            ◉ {u.name} UNIVERSE
          </span>
        )}
        <span className="rounded-full border-2 border-ink bg-ink px-2.5 py-0.5 text-lime">
          ⚠ GUARDED BETA — UNAUDITED
        </span>
        {/* one dollar mark for the whole strip: every figure after it is that dollar */}
        <span className="inline-flex items-center gap-1.5">
          <CoinLogo id={dollar.coin} size={15} />
          REAL {dollar.symbol}
          {u?.id === 'bnb' ? ' (BINANCE-PEG)' : ''} · REAL RISK · DEPOSITS CAPPED{caps.length > 1 ? ' PER CHAIN' : ''}:
        </span>
        {caps.map((c) => (
          <span key={c.id} className="inline-flex items-center gap-1.5 whitespace-nowrap" title={c.label}>
            <ChainLogo id={c.id} size={15} />
            {money(c.liquidity)} / {money(c.depositCap)}
            {c.depositsPaused || c.paused ? ' · PAUSED' : ''}
          </span>
        ))}
        {onchain.hubPaused && <span className="text-down">· HUB PAUSED — BUYS & LAUNCHES CLOSED, SELLS OPEN</span>}
        {u && (
          <span className="opacity-70" title="A token launched in one universe does not exist in another.">
            · TOKENS HERE EXIST ONLY HERE
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-3">
          {others.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="opacity-60">OTHER UNIVERSES:</span>
              {others.map((o) => (
                <button
                  key={o.id}
                  onClick={() => nav.go(o.id)}
                  title={`${o.name} universe — ${o.line}`}
                  className="inline-flex items-center gap-1 rounded-full border-2 border-ink bg-white px-2 py-0.5 transition hover:bg-lime"
                >
                  {o.logos.map((id) => (
                    <ChainLogo key={id} id={id} size={12} />
                  ))}
                  {o.tab}
                </button>
              ))}
            </span>
          )}
          <button
            onClick={() => onchain.risk?.show()}
            className="underline decoration-2 underline-offset-2 hover:no-underline"
          >
            READ THE RISKS →
          </button>
        </span>
      </div>
    </div>
  )
}

/** MAINNET only: the notice a visitor must accept — once PER UNIVERSE —
 * before their first transaction there. Opened by the provider whenever an
 * action is attempted without it, and from the banner at any time. */
export function RiskNotice() {
  const { onchain } = useStore()
  const dollar = useDollar()
  const cs = useChainSet()
  const risk = onchain?.risk
  const [ticked, setTicked] = useState(false)
  const open = !!risk?.open

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && risk?.dismiss()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, risk])

  if (!risk || !open) return null
  const info = onchain?.chainInfo ?? {}
  const caps = Object.values(info).map((c) => c.depositCap).filter((n) => n > 0)
  const cap = caps.length ? Math.min(...caps) : 0
  const u = onchain?.universe
  const hub = cs.live.find((c) => info[c.id]?.local)
  const hubName = hub ? (hub.id === 'bnb' ? 'BNB Chain' : hub.label.charAt(0) + hub.label.slice(1).toLowerCase()) : 'the hub chain'
  const sym = dollar.symbol

  const points: [string, string][] = [
    [
      'NOT AUDITED',
      'These contracts have not been reviewed by an outside security firm. A bug can lose funds, and a loss on-chain is final.',
    ],
    ...(u
      ? ([
          [
            'THIS IS ONE UNIVERSE',
            `You are in the ${u.name} universe (${u.line}). A token launched here exists only here: the other universes are separate markets with their own tokens, their own dollar and their own caps. Nothing moves between them.`,
          ],
        ] as [string, string][])
      : []),
    ...(u?.id === 'bnb'
      ? ([
          [
            'YOUR DOLLAR IS A BINANCE-CUSTODIED PEG',
            'This universe settles in BSC USDT (Binance-Peg): a token whose real-world backing is custodied by Binance, not by its issuer. If that peg breaks or Binance halts it, every dollar in this universe breaks with it. You accept Binance as a counterparty by trading here.',
          ],
        ] as [string, string][])
      : []),
    ...(u?.id === 'ethereum'
      ? ([
          [
            'EVERY ACTION PAYS L1 GAS',
            'This universe lives on Ethereum mainnet. Every approval, buy, sell, claim and unwrap is an Ethereum transaction: gas can cost several dollars each, spikes without warning and is never refunded — not even when the trade is cancelled by your price protection.',
          ],
        ] as [string, string][])
      : []),
    [
      'CAPPED ON PURPOSE',
      cap > 0
        ? `${cs.single ? 'The vault' : "Each chain's vault"} is capped (${cs.single ? 'at' : 'from'} ${money(cap)} of ${sym}) so the worst case stays small. A buy that would exceed the cap is refused.`
        : `${cs.single ? 'The vault' : "Each chain's vault"} is capped so the worst case stays small. A buy that would exceed the cap is refused.`,
    ],
    [
      'ADMIN & PAUSE EXIST',
      'Structural changes sit behind a public time-lock. A pause can stop new buys and launches at any moment — selling and withdrawing stay open.',
    ],
    [
      'HOW YOU GET PAID',
      `Sells and refunds pay ${sym} when ${cs.single ? 'the' : "that chain's"} vault holds enough. If it is short you receive an oUSD claim, redeemable 1:1 once liquidity is rebalanced.`,
    ],
    cs.single
      ? [
          'ONE CHAIN, ONE TRANSACTION, PRICE-PROTECTED',
          `Every trade settles in one transaction on ${hubName} — no bridge, no message fee. It reverts unless you receive at least the minimum shown before you sign (your tolerance, 2% by default). A revert still costs its gas.`,
        ]
      : [
          'CROSS-CHAIN TAKES TIME AND A FEE — AND HAS NO PRICE PROTECTION YET',
          `From ${hubName} a trade settles in one transaction and reverts unless you receive at least the minimum shown before you sign. From another chain it crosses LayerZero: minutes, a network fee shown before you sign and not refundable, and it fills at whatever price the curve has when it lands.`,
        ],
    [
      'MEME TOKENS GO TO ZERO',
      'Anyone can launch anything here. Nothing on this site is advice. Only put in what you can lose, and only if it is legal where you live.',
    ],
  ]

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-ink/75 p-4 backdrop-blur-sm"
      onClick={() => risk.dismiss()}
    >
      <div
        className="my-auto w-full max-w-2xl animate-pop overflow-hidden rounded-3xl border-3 border-ink bg-cream shadow-[10px_10px_0_0_#f7be7b]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Risk notice"
        data-testid="risk-notice"
      >
        <div className="border-b-3 border-ink bg-tang px-6 py-4">
          <p className="font-mono text-[10px] font-bold tracking-[0.2em]">
            ⚠ BEFORE YOUR FIRST TRANSACTION{u ? ` IN THE ${u.name} UNIVERSE` : ''}
          </p>
          <h2 className="font-display text-[clamp(1.6rem,4vw,2.4rem)] leading-tight tracking-wide">
            THIS IS REAL MONEY.
          </h2>
        </div>
        <div className="space-y-3 px-6 py-5">
          {points.map(([head, body]) => (
            <div key={head} className="flex gap-3">
              <span className="mt-0.5 font-mono text-[11px] font-bold">✳</span>
              <p className="text-[13px] font-medium leading-relaxed">
                <span className="font-mono text-[11px] font-bold tracking-wide">{head} — </span>
                {body}
              </p>
            </div>
          ))}

          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border-3 border-ink bg-white p-3">
            <input
              type="checkbox"
              checked={ticked}
              onChange={(e) => setTicked(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[#141414]"
              data-testid="risk-tick"
            />
            <span className="font-mono text-[11px] font-bold leading-relaxed">
              I HAVE READ THIS. I UNDERSTAND I CAN LOSE EVERYTHING I PUT IN.
            </span>
          </label>

          <div className="flex flex-wrap gap-3 pt-1">
            <button
              disabled={!ticked}
              onClick={() => risk.accept()}
              data-testid="risk-accept"
              className="rounded-xl border-3 border-ink bg-lime px-6 py-3 font-mono text-[12px] font-bold tracking-wide shadow-brutal transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40"
            >
              I ACCEPT — CONTINUE
            </button>
            <button
              onClick={() => risk.dismiss()}
              className="rounded-xl border-3 border-ink bg-white px-6 py-3 font-mono text-[12px] font-bold tracking-wide shadow-brutal-sm transition hover:-translate-y-0.5"
            >
              NOT NOW
            </button>
          </div>
          {risk.accepted && (
            <p className="font-mono text-[10px] font-bold text-up">
              ✓ ALREADY ACCEPTED ON THIS BROWSER{u ? ` FOR THE ${u.name} UNIVERSE` : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
