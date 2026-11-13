import { useState } from 'react'
import { useStore, shortAddr } from '../store'
import { fmtMoney, fmtPrice, fmtTokens, fmtUsd } from '../lib/format'
import { useChainSet } from '../lib/liveChains'
import { CreatureArt } from './CreatureCard'
import { FEE_LABEL } from './TokenPage'

const label = 'font-mono text-[10px] font-bold tracking-[0.15em] opacity-60'

export function DevDashboard({
  onOpenToken,
  onOpenLab,
  onBack,
}: {
  onOpenToken: (num: number) => void
  onOpenLab: () => void
  onBack: () => void
}) {
  const { mode, creatures, wallet, connect, claimFees, onchain } = useStore()
  const chainSet = useChainSet()
  const [busyNum, setBusyNum] = useState<number | null>(null)
  const [claimed, setClaimed] = useState<Record<number, number>>({})
  /** Claims the hub turned down (it refuses instead of reverting). */
  const [refused, setRefused] = useState<Record<number, boolean>>({})
  const [connecting, setConnecting] = useState(false)

  const mine = wallet
    ? creatures
        .filter((c) => c.custom && (!c.creator || c.creator === wallet.address))
        .sort((a, b) => b.spawnedAt - a.spawnedAt)
    : []

  const claimableOf = (num: number) => {
    const f = creatures.find((c) => c.num === num)?.fees
    return f ? Math.max(0, f.dev - f.devClaimed) : 0
  }
  const totalClaimable = mine.reduce((a, c) => a + claimableOf(c.num), 0)

  const doClaim = async (num: number) => {
    if (!claimFees || busyNum !== null) return
    setBusyNum(num)
    setRefused((m) => ({ ...m, [num]: false }))
    try {
      const got = await claimFees(num)
      if (got > 0) setClaimed((m) => ({ ...m, [num]: got }))
      // on-chain a claim never reverts: 0 back means the hub refused it
      // (or the risk notice is still unread on mainnet)
      else if (mode === 'chain' && onchain?.risk?.accepted !== false) setRefused((m) => ({ ...m, [num]: true }))
    } catch {
      setRefused((m) => ({ ...m, [num]: true }))
    } finally {
      setBusyNum(null)
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          onClick={onBack}
          className="rounded-xl border-2 border-ink bg-white px-4 py-2 font-mono text-[11px] font-bold tracking-wide shadow-brutal-sm transition hover:-translate-y-0.5 hover:bg-lime"
        >
          ← THE PIT
        </button>
        <span className="font-mono text-[10px] font-bold tracking-[0.2em] opacity-50">
          {wallet ? shortAddr(wallet.address) : 'NOT CONNECTED'}
        </span>
      </div>

      <h1 className="mt-5 font-display text-[clamp(2.4rem,6vw,4rem)] leading-none tracking-wide">
        DEV ZONE<span className="text-tang">.</span>
      </h1>
      <p className="mt-2 max-w-xl font-mono text-[11px] font-bold leading-relaxed opacity-55">
        YOUR LAUNCHES, YOUR FEE STREAMS, YOUR CLAIMS. REMEMBER: YOU LAUNCHED FROM ONE CHAIN
        WITH ONE GAS TOKEN — SPAWN! DEPLOYED TO ALL {chainSet.word}.
      </p>

      {!wallet ? (
        <div className="mt-10 rounded-2xl border-3 border-ink bg-white p-10 text-center shadow-brutal">
          <p className="font-display text-2xl tracking-wide">CONNECT TO SEE YOUR LAUNCHES.</p>
          <button
            onClick={() => {
              if (connecting) return
              setConnecting(true)
              void connect().finally(() => setConnecting(false))
            }}
            className="mt-5 rounded-xl border-3 border-ink bg-lime px-6 py-3 font-mono text-[12px] font-bold shadow-brutal transition hover:-translate-y-0.5"
          >
            {connecting ? '✳ CONNECTING…' : '◉ CONNECT WALLET'}
          </button>
        </div>
      ) : mine.length === 0 ? (
        <div className="mt-10 rounded-2xl border-3 border-ink bg-white p-10 text-center shadow-brutal">
          <p className="font-display text-2xl tracking-wide">NOTHING LAUNCHED YET.</p>
          <p className="mx-auto mt-3 max-w-md font-mono text-[10px] font-bold leading-relaxed opacity-55">
            LAUNCH COSTS GAS ON ONE CHAIN ONLY — THE ONE YOU LAUNCH FROM. PICK YOUR FEE MODEL
            (HOLDERS / 50-50 / DEV / BUYBACK&nbsp;&amp;&nbsp;BURN) AND IT'S LOCKED IN FOREVER.
          </p>
          <button
            onClick={onOpenLab}
            className="mt-5 rounded-xl border-3 border-ink bg-lime px-6 py-3 font-mono text-[12px] font-bold shadow-brutal transition hover:-translate-y-0.5"
          >
            LAUNCH A TOKEN ↗
          </button>
        </div>
      ) : (
        <>
          {/* totals */}
          <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {[
              ['TOKENS LAUNCHED', String(mine.length)],
              ['CLAIMABLE NOW', fmtUsd(totalClaimable)],
              ['WALLET BALANCE', fmtUsd(wallet.balance)],
            ].map(([l, v]) => (
              <div key={l} className="rounded-xl border-3 border-ink bg-white px-4 py-3 shadow-brutal-sm">
                <p className={label}>{l}</p>
                <p className="mt-1 font-mono text-lg font-bold">{v}</p>
              </div>
            ))}
          </div>

          <div className="mt-6 space-y-3">
            {mine.map((c) => {
              const f = c.fees
              const claimable = claimableOf(c.num)
              const mode_ = c.feeMode ?? f?.mode ?? 'holders'
              return (
                <div key={c.num} className="rounded-2xl border-3 border-ink bg-white p-4 shadow-brutal-sm">
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      onClick={() => onOpenToken(c.num)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left transition hover:-translate-y-0.5"
                    >
                      <span
                        className="shrink-0 overflow-hidden rounded-full border-2 border-ink"
                        style={{ background: c.color }}
                      >
                        <CreatureArt c={c} size={40} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-[14px] font-bold">
                          ${c.ticker} <span className="opacity-40">· {c.name}</span>
                        </span>
                        <span className="block font-mono text-[10px] font-bold opacity-50">
                          {fmtPrice(c.price)} · MCAP {fmtMoney(c.mcap)} · {c.holders} HOLDERS
                        </span>
                      </span>
                    </button>
                    <span className="rounded-full border-2 border-ink bg-lime px-2.5 py-1 font-mono text-[9px] font-bold tracking-wide shadow-brutal-sm">
                      {FEE_LABEL[mode_]}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t-2 border-dashed border-ink/20 pt-3">
                    <div className="flex flex-wrap gap-x-6 gap-y-1">
                      <div>
                        <p className="font-mono text-[8.5px] font-bold tracking-wide opacity-45">
                          FEES COLLECTED
                        </p>
                        <p className="font-mono text-[13px] font-bold">{fmtMoney(f?.total ?? 0)}</p>
                      </div>
                      {mode_ !== 'dev' && (
                        <div>
                          <p className="font-mono text-[8.5px] font-bold tracking-wide opacity-45">
                            {mode_ === 'burn' ? 'BURNED' : 'TO HOLDERS'}
                          </p>
                          <p className="font-mono text-[13px] font-bold">
                            {mode_ === 'burn'
                              ? f && f.burnedTokens > 0
                                ? `${fmtTokens(f.burnedTokens)} 🔥`
                                : '—'
                              : fmtMoney(f?.holders ?? 0)}
                          </p>
                        </div>
                      )}
                      <div>
                        <p className="font-mono text-[8.5px] font-bold tracking-wide opacity-45">
                          YOUR SHARE (CLAIMED)
                        </p>
                        <p className="font-mono text-[13px] font-bold">
                          {fmtMoney(f?.dev ?? 0)}{' '}
                          <span className="opacity-40">({fmtMoney(f?.devClaimed ?? 0)})</span>
                        </p>
                      </div>
                    </div>

                    {mode_ === 'dev' || mode_ === 'split' ? (
                      <div className="text-right">
                        <button
                          onClick={() => void doClaim(c.num)}
                          disabled={busyNum !== null || claimable <= 0.005 || !claimFees}
                          className="rounded-xl border-3 border-ink bg-lime px-5 py-2.5 font-mono text-[11px] font-bold shadow-brutal-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {busyNum === c.num ? '✳ CLAIMING…' : `CLAIM ${fmtUsd(claimable)} ↓`}
                        </button>
                        {claimed[c.num] !== undefined && (
                          <p className="mt-1 font-mono text-[9px] font-bold text-up">
                            +{fmtUsd(claimed[c.num])} IN YOUR WALLET ✓
                          </p>
                        )}
                        {refused[c.num] && claimed[c.num] === undefined && (
                          <p className="mt-1 font-mono text-[9px] font-bold text-down">
                            NOTHING WAS PAID — THE HUB REFUSED THE CLAIM.
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="font-mono text-[9px] font-bold tracking-wide opacity-45">
                        {mode_ === 'burn'
                          ? 'FEES AUTO-BUY & BURN — NOTHING TO CLAIM'
                          : 'FEES STREAM TO HOLDERS — NOTHING TO CLAIM'}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {mode === 'chain' && (
            <p className="mt-4 text-center font-mono text-[9px] font-bold leading-relaxed tracking-wide opacity-45">
              A CLAIM IS SENT FROM THE FIRST CHAIN YOUR WALLET HAS GAS ON (THE HUB CHAIN FIRST: IT
              IS INSTANT) AND PAYS OUT THERE IN USDC.
              {onchain?.sponsored
                ? ''
                : ' FROM ANOTHER CHAIN IT CROSSES LAYERZERO — A FEW MINUTES AND A NETWORK FEE.'}
            </p>
          )}
        </>
      )}
    </div>
  )
}
