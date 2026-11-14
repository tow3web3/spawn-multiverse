import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { CHAINS } from '../lib/chains'
import { chainName, dollarOn, listNames, useChainSet } from '../lib/liveChains'
import { ChainLogo, CoinLogo } from './ChainLogos'

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

/** MAINNET only: the strip that never goes away. It says what this is (an
 * unaudited guarded beta holding real dollars) and how much each live
 * chain's vault may hold, in that chain's own dollar. */
export function GuardedBanner() {
  const { onchain } = useStore()
  if (!onchain || onchain.network !== 'mainnet' || onchain.status !== 'ready') return null
  const info = onchain.chainInfo ?? {}
  const caps = CHAINS.filter((c) => info[c.id]).map((c) => ({ ...c, ...info[c.id] }))

  return (
    <div className="border-t-2 border-ink bg-tang" data-testid="guarded-banner">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 font-mono text-[10px] font-bold tracking-wide sm:px-6">
        <span className="rounded-full border-2 border-ink bg-ink px-2.5 py-0.5 text-lime">
          ⚠ GUARDED BETA — UNAUDITED
        </span>
        <span>REAL MONEY · REAL RISK · EACH VAULT CAPPED:</span>
        {caps.map((c) => {
          const d = dollarOn(c.id, info)
          return (
            <span
              key={c.id}
              className="inline-flex items-center gap-1.5 whitespace-nowrap"
              title={`${chainName(c.id)}'s vault: ${money(c.liquidity)} of ${money(c.depositCap)} ${d.symbol}`}
            >
              <ChainLogo id={c.id} size={15} />
              <CoinLogo id={d.coin} size={13} />
              {money(c.liquidity)} / {money(c.depositCap)}
              {c.depositsPaused || c.paused ? ' · PAUSED' : ''}
            </span>
          )
        })}
        {onchain.hubPaused && <span className="text-down">· HUB PAUSED — BUYS & LAUNCHES CLOSED, SELLS OPEN</span>}
        <span className="ml-auto inline-flex items-center gap-3">
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

/** MAINNET only: the notice a visitor must accept before their first
 * transaction. Opened by the provider whenever an action is attempted
 * without it, and from the banner at any time. */
export function RiskNotice() {
  const { onchain } = useStore()
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
  const live = cs.live.filter((c) => info[c.id])
  const capOf = (id: string) => `${money(info[id]?.depositCap ?? 0)} ${dollarOn(id, info).symbol}`
  const hub = cs.live.find((c) => info[c.id]?.local)
  const hubName = hub ? chainName(hub.id) : 'the hub chain'
  const bnb = live.find((c) => c.id === 'bnb')
  const eth = live.find((c) => c.id === 'ethereum')

  const points: [string, string][] = [
    [
      'NOT AUDITED — A GUARDED BETA',
      'These contracts have not been reviewed by an outside security firm. A bug can lose funds, and a loss on-chain is final.',
    ],
    [
      'CAPPED ON PURPOSE',
      `Each chain's vault is capped so the worst case stays small: ${
        live.length ? live.map((c) => `${chainName(c.id)} ${capOf(c.id)}`).join(', ') : 'see the strip above'
      }. A buy that would go past a cap is refused.`,
    ],
    [
      'ONE UNIVERSE, SIX CHAINS',
      `One token, one supply, one price on every chain. Trading is live on ${listNames(live) || cs.names}; a chain that is not listed there cannot be traded on yet.`,
    ],
    ...(bnb
      ? ([
          [
            'BNB CHAIN TRADES IN BINANCE USDT — AND IT IS POOLED',
            `On BNB Chain the dollars are Binance USDT, pooled with the USDC of the other chains: every vault backs the same claims. If USDT lost its peg, the loss would be shared by everyone — not only by BNB traders — bounded by the BNB vault's cap (${capOf('bnb')}).`,
          ],
        ] as [string, string][])
      : []),
    ...(eth
      ? ([
          [
            'ETHEREUM: OPEN FIRST, L1 GAS ALWAYS',
            'On Ethereum a token may need to be opened before it can be traded there (a small network fee, shown before you sign). Every approval, buy, sell, open, move and claim there is an Ethereum transaction: gas can cost several dollars, spikes without warning and is never refunded.',
          ],
        ] as [string, string][])
      : []),
    [
      'PRICE PROTECTION, AND WHAT CROSSING TAKES',
      `Every trade names a minimum (your tolerance, 2% by default). From ${hubName} it settles in one transaction and cancels before you sign if the price moved past it. From another chain it takes a few minutes and is all-or-nothing at that minimum: under it, the hub refuses it and your dollars or tokens come back. The network fee for the round trip is shown before you sign and is not refundable.`,
    ],
    [
      'HOW YOU GET PAID',
      "Sells and refunds pay the dollar of the chain you sold from when its vault holds enough. If it is short you receive an oUSD claim, redeemable 1:1 once it refills — or movable to another chain whose vault can pay it.",
    ],
    [
      'ADMIN & PAUSE EXIST',
      'Structural changes sit behind a public time-lock. A pause can stop new buys and launches at any moment — selling, withdrawing and moving claims stay open.',
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
            <p className="font-mono text-[10px] font-bold text-up">✓ ALREADY ACCEPTED ON THIS BROWSER</p>
          )}
        </div>
      </div>
    </div>
  )
}
