import { useState } from 'react'
import { useStore, shortAddr } from '../store'
import { fmtChange, fmtPrice, fmtTokens, fmtUsd } from '../lib/format'
import { CHAINS } from '../lib/chains'
import { useChainSet } from '../lib/liveChains'
import { CreatureArt } from './CreatureCard'

const label = 'font-mono text-[10px] font-bold tracking-[0.15em] opacity-60'

export function PortfolioPage({
  onOpenToken,
  onBack,
}: {
  onOpenToken: (num: number) => void
  onBack: () => void
}) {
  const { creatures, wallet, connect, onchain } = useStore()
  const chainSet = useChainSet()
  const [busy, setBusy] = useState(false)
  const [unwrapping, setUnwrapping] = useState<string | null>(null)
  const [cashMsg, setCashMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // holder fee rewards claimable right now, summed across tokens + chains
  const feeRewards = Object.values(onchain?.holderRewards ?? {}).reduce((a, b) => a + b, 0)

  // on-chain: where the wallet's dollars sit, chain by chain
  const cash = CHAINS.filter((c) => onchain?.chainInfo?.[c.id]).map((c) => ({
    ...c,
    ...onchain!.chainInfo![c.id],
  }))

  const doUnwrap = async (chainId: string) => {
    if (unwrapping || !onchain?.unwrap) return
    setUnwrapping(chainId)
    setCashMsg(null)
    try {
      const got = await onchain.unwrap(chainId)
      setCashMsg(
        got > 0
          ? { ok: true, text: `${fmtUsd(got)} USDC BACK IN YOUR WALLET ON ${chainId.toUpperCase()} ✓` }
          : { ok: false, text: `${chainId.toUpperCase()}'S VAULT HAS NO USDC TO PAY RIGHT NOW — YOUR CLAIM STAYS VALID.` },
      )
    } catch {
      setCashMsg({ ok: false, text: 'UNWRAP FAILED — NOTHING MOVED. TRY AGAIN.' })
    } finally {
      setUnwrapping(null)
    }
  }

  const rows = wallet
    ? Object.entries(wallet.positions)
        .map(([numStr, pos]) => {
          const c = creatures.find((x) => x.num === Number(numStr))
          if (!c || pos.tokens <= 1) return null
          const value = pos.tokens * c.price
          const rawPnl = value - pos.cost
          // on-chain, a bag partly bought elsewhere has no known cost here
          const known = pos.costKnown !== false
          return { c, pos, value, known, pnl: !known || Math.abs(rawPnl) < 0.005 ? 0 : rawPnl }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => b.value - a.value)
    : []

  const holdings = rows.reduce((a, r) => a + r.value, 0)
  const totalPnl = rows.reduce((a, r) => a + r.pnl, 0)
  const untracked = rows.some((r) => !r.known)

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
        YOUR BAGS<span className="text-grape">.</span>
      </h1>
      <p className="mt-2 max-w-lg font-mono text-[11px] font-bold leading-relaxed opacity-55">
        EVERY TOKEN YOU TRADED THROUGH SPAWN!, ACROSS ALL {chainSet.word} CHAIN
        {chainSet.count === 1 ? '' : 'S'}, IN ONE PLACE.
      </p>

      {!wallet ? (
        <div className="mt-10 rounded-2xl border-3 border-ink bg-white p-10 text-center shadow-brutal">
          <p className="font-display text-2xl tracking-wide">NO WALLET, NO BAGS.</p>
          <button
            onClick={() => {
              if (busy) return
              setBusy(true)
              void connect().finally(() => setBusy(false))
            }}
            className="mt-5 rounded-xl border-3 border-ink bg-lime px-6 py-3 font-mono text-[12px] font-bold shadow-brutal transition hover:-translate-y-0.5"
          >
            {busy ? '✳ CONNECTING…' : '◉ CONNECT WALLET'}
          </button>
        </div>
      ) : (
        <>
          {/* totals */}
          <div className={`mt-6 grid grid-cols-2 gap-2 ${feeRewards > 0.005 ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
            {[
              ['CASH BALANCE', fmtUsd(wallet.balance), ''],
              ['HOLDINGS VALUE', fmtUsd(holdings), ''],
              [
                untracked ? 'PNL — BAGS BOUGHT ON THIS DEVICE ONLY' : 'TOTAL PNL',
                `${totalPnl >= 0 ? '+' : ''}${fmtUsd(totalPnl).replace('$-', '-$')}`,
                totalPnl >= 0 ? 'text-up' : 'text-down',
              ],
              ...(feeRewards > 0.005
                ? [['FEE REWARDS — CLAIM ON EACH TOKEN PAGE', fmtUsd(feeRewards), 'text-up'] as const]
                : []),
            ].map(([l, v, cls]) => (
              <div key={l} className="rounded-xl border-3 border-ink bg-white px-4 py-3 shadow-brutal-sm">
                <p className={label}>{l}</p>
                <p className={`mt-1 font-mono text-lg font-bold ${cls}`}>{v}</p>
              </div>
            ))}
          </div>

          {/* on-chain: the cash, chain by chain — dollars are chain-native too */}
          {cash.length > 0 && (
            <div className="mt-4 rounded-2xl border-3 border-ink bg-white p-4 shadow-brutal-sm">
              <p className={label}>YOUR DOLLARS, CHAIN BY CHAIN</p>
              <div className="mt-2 divide-y divide-ink/10">
                {cash.map((c) => {
                  const canUnwrap = c.ousd >= 0.01 && c.liquidity > 0
                  return (
                    <div key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                      <span
                        className="flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-ink px-1 font-mono text-[9px] font-bold"
                        style={{ background: c.color }}
                      >
                        {c.short}
                      </span>
                      <span className="w-24 font-mono text-[11px] font-bold">
                        {c.label}
                        {c.local ? ' ⚡' : ''}
                      </span>
                      <span className="font-mono text-[12px] font-bold">{fmtUsd(c.usdc)} USDC</span>
                      {c.ousd >= 0.01 && (
                        <span
                          className="font-mono text-[11px] font-bold opacity-60"
                          title="oUSD: a 1:1 claim on this chain's USDC vault. It comes from holder rewards, or from a payout made while the vault was short."
                        >
                          + {fmtUsd(c.ousd)} oUSD
                        </span>
                      )}
                      <span className="font-mono text-[10px] font-bold opacity-40">
                        GAS {c.gas.toFixed(c.gas < 0.01 ? 5 : 3)} {c.nativeSymbol}
                      </span>
                      {c.ousd >= 0.01 && (
                        <button
                          onClick={() => void doUnwrap(c.id)}
                          disabled={unwrapping !== null || !canUnwrap}
                          title={
                            canUnwrap
                              ? 'Turn your oUSD claim back into USDC'
                              : "This chain's vault has no USDC right now — the claim stays valid until liquidity returns"
                          }
                          className="ml-auto rounded-lg border-2 border-ink bg-lime px-3 py-1.5 font-mono text-[10px] font-bold shadow-brutal-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {unwrapping === c.id ? '✳ UNWRAPPING…' : canUnwrap ? 'UNWRAP → USDC' : 'VAULT SHORT'}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
              {cashMsg && (
                <p className={`mt-2 font-mono text-[9px] font-bold tracking-wide ${cashMsg.ok ? 'text-up' : 'text-down'}`}>
                  {cashMsg.text}
                </p>
              )}
              <p className="mt-2 font-mono text-[9px] font-bold leading-relaxed tracking-wide opacity-40">
                A BUY SPENDS THE DOLLARS OF THE CHAIN YOU BUY FROM. SELLS PAY USDC ON THE CHAIN
                YOU SELL FROM.
              </p>
            </div>
          )}

          {/* positions */}
          {rows.length === 0 ? (
            <div className="mt-6 rounded-2xl border-3 border-ink bg-white p-10 text-center shadow-brutal">
              <p className="font-display text-2xl tracking-wide">EMPTY BAGS. FIX THAT.</p>
              <button
                onClick={onBack}
                className="mt-5 rounded-xl border-3 border-ink bg-lime px-6 py-3 font-mono text-[12px] font-bold shadow-brutal transition hover:-translate-y-0.5"
              >
                ENTER THE PIT ↓
              </button>
            </div>
          ) : (
            <div className="mt-6 overflow-hidden rounded-2xl border-3 border-ink shadow-brutal-sm">
              {rows.map(({ c, pos, value, pnl, known }, i) => (
                <button
                  key={c.num}
                  onClick={() => onOpenToken(c.num)}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-lime/30 ${
                    i > 0 ? 'border-t border-ink/10' : ''
                  } ${i % 2 ? 'bg-cream/50' : 'bg-white'}`}
                >
                  <span
                    className="shrink-0 overflow-hidden rounded-full border-2 border-ink"
                    style={{ background: c.color }}
                  >
                    <CreatureArt c={c} size={36} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[13px] font-bold">
                      ${c.ticker} <span className="opacity-40">· {fmtTokens(pos.tokens)}</span>
                    </span>
                    <span className="block font-mono text-[10px] font-bold opacity-50">
                      {fmtPrice(c.price)}{' '}
                      <span className={c.change >= 0 ? 'text-up' : 'text-down'}>
                        {fmtChange(c.change)}
                      </span>
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block font-mono text-[13px] font-bold">{fmtUsd(value)}</span>
                    {known ? (
                      <span
                        className={`block font-mono text-[10px] font-bold ${
                          pnl >= 0 ? 'text-up' : 'text-down'
                        }`}
                      >
                        {pnl >= 0 ? '+' : ''}
                        {fmtUsd(pnl).replace('$-', '-$')} PNL
                      </span>
                    ) : (
                      <span className="block font-mono text-[9px] font-bold opacity-45">
                        PNL UNKNOWN ON THIS DEVICE
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-[12px] opacity-40">→</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
