import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { CHAINS } from '../lib/chains'

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

/** MAINNET only: the strip that never goes away. It says what this is (an
 * unaudited beta holding real USDC) and how much each chain's vault may hold. */
export function GuardedBanner() {
  const { onchain } = useStore()
  if (!onchain || onchain.network !== 'mainnet' || onchain.status !== 'ready') return null
  const info = onchain.chainInfo ?? {}
  const caps = CHAINS.filter((c) => info[c.id]).map((c) => ({ ...c, ...info[c.id] }))

  return (
    <div className="border-t-2 border-ink bg-tang">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 font-mono text-[10px] font-bold tracking-wide sm:px-6">
        <span className="rounded-full border-2 border-ink bg-ink px-2.5 py-0.5 text-lime">
          ⚠ GUARDED BETA — UNAUDITED
        </span>
        <span>REAL USDC · REAL RISK · DEPOSITS CAPPED PER CHAIN:</span>
        {caps.map((c) => (
          <span key={c.id} className="whitespace-nowrap">
            <span
              className="mr-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-ink px-0.5 text-[7px]"
              style={{ background: c.color }}
            >
              {c.short}
            </span>
            {money(c.liquidity)} / {money(c.depositCap)}
            {c.depositsPaused || c.paused ? ' · PAUSED' : ''}
          </span>
        ))}
        {onchain.hubPaused && <span className="text-down">· HUB PAUSED — BUYS & LAUNCHES CLOSED, SELLS OPEN</span>}
        <button
          onClick={() => onchain.risk?.show()}
          className="ml-auto underline decoration-2 underline-offset-2 hover:no-underline"
        >
          READ THE RISKS →
        </button>
      </div>
    </div>
  )
}

/** MAINNET only: the one-time notice a visitor must accept before their
 * first transaction. Opened by the provider whenever an action is attempted
 * without it, and from the banner at any time. */
export function RiskNotice() {
  const { onchain } = useStore()
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

  const points: [string, string][] = [
    [
      'NOT AUDITED',
      'These contracts have not been reviewed by an outside security firm. A bug can lose funds, and a loss on-chain is final.',
    ],
    [
      'CAPPED ON PURPOSE',
      cap > 0
        ? `Each chain's vault is capped (from ${money(cap)} of USDC) so the worst case stays small. A buy that would exceed the cap is refused.`
        : "Each chain's vault is capped so the worst case stays small. A buy that would exceed the cap is refused.",
    ],
    [
      'ADMIN & PAUSE EXIST',
      'Structural changes sit behind a public time-lock. A pause can stop new buys and launches at any moment — selling and withdrawing stay open.',
    ],
    [
      'HOW YOU GET PAID',
      "Sells and refunds pay USDC when that chain's vault holds enough. If it is short you receive an oUSD claim, redeemable 1:1 once liquidity is rebalanced.",
    ],
    [
      'CROSS-CHAIN TAKES TIME AND A FEE',
      'From Base a trade settles in one transaction. From another chain it crosses LayerZero: minutes, plus a network fee shown before you sign and not refundable.',
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
      >
        <div className="border-b-3 border-ink bg-tang px-6 py-4">
          <p className="font-mono text-[10px] font-bold tracking-[0.2em]">⚠ BEFORE YOUR FIRST TRANSACTION</p>
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
            />
            <span className="font-mono text-[11px] font-bold leading-relaxed">
              I HAVE READ THIS. I UNDERSTAND I CAN LOSE EVERYTHING I PUT IN.
            </span>
          </label>

          <div className="flex flex-wrap gap-3 pt-1">
            <button
              disabled={!ticked}
              onClick={() => risk.accept()}
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
            <p className="font-mono text-[10px] font-bold text-up">✓ ALREADY ACCEPTED ON THIS BROWSER</p>
          )}
        </div>
      </div>
    </div>
  )
}
