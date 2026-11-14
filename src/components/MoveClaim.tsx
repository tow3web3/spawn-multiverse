import { useEffect, useState } from 'react'
import { useStore, type MoveOption } from '../store'
import { fmtUsd } from '../lib/format'
import { chainName, dollarOn } from '../lib/liveChains'
import { moveRecipient } from '../lib/v72'
import { ChainLogo, CoinLogo, coinOf } from './ChainLogos'

/**
 * v7.2: a claim the local vault cannot pay, sent to a chain whose vault can.
 * Lists only the destinations that can pay it in full right now (a priced
 * route, enough in the vault), each with the price of the move; the claim
 * arrives there as that chain's own dollar. `to` is the wallet itself
 * unless the user names another address.
 */
export function MoveClaim({ from, onDone }: { from: string; onDone?: (text: string) => void }) {
  const { onchain, wallet } = useStore()
  const info = onchain?.chainInfo
  const ci = info?.[from]
  const claim = ci?.ousd ?? 0
  const [amountStr, setAmountStr] = useState(() => (Math.floor(claim * 100) / 100).toFixed(2))
  const amount = Number.parseFloat(amountStr) || 0
  const [options, setOptions] = useState<MoveOption[] | null>(null)
  const [dst, setDst] = useState<string | null>(null)
  const [other, setOther] = useState(false)
  const [recipient, setRecipient] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; neutral?: boolean; text: string } | null>(null)

  // which chains can take it — re-asked when the amount changes
  useEffect(() => {
    if (!onchain?.moveOptions || !(amount > 0)) {
      setOptions([])
      return
    }
    let stale = false
    setOptions(null)
    const t = window.setTimeout(() => {
      void onchain.moveOptions!(from, Math.min(amount, claim)).then((o) => {
        if (stale) return
        setOptions(o)
        setDst((d) => (d && o.some((x) => x.chain === d) ? d : (o[0]?.chain ?? null)))
      })
    }, 300)
    return () => {
      stale = true
      window.clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, amount, claim, onchain?.moveOptions])

  if (!ci) return null
  const here = dollarOn(from, info)
  const chosen = options?.find((o) => o.chain === dst)
  const there = dst ? dollarOn(dst, info) : undefined
  const instant = onchain?.network === 'local' || ci.local
  const gasCoin = coinOf(ci.nativeSymbol)
  // a destination whose gateway is not an EVM address (Solana) takes a
  // 32-byte key, never the wallet's own address: the recipient is required
  const wide = !!chosen?.wide
  const naming = other || wide
  const shape = naming ? moveRecipient(recipient, wide) : null

  const go = async () => {
    if (busy || !dst || !onchain?.moveClaim) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await onchain.moveClaim(from, dst, Math.min(amount, claim), naming ? recipient : undefined)
      setMsg(r.ok ? { ok: true, text: r.text } : { ok: false, neutral: r.code === 'returned', text: r.reason.toUpperCase() })
      if (r.ok) onDone?.(r.text)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 rounded-xl border-3 border-ink bg-cream p-3" data-testid={`move-${from}`}>
      <p className="font-mono text-[10px] font-bold leading-relaxed tracking-wide">
        💸 YOUR {fmtUsd(claim)} CLAIM ON {from.toUpperCase()} — ITS VAULT HOLDS{' '}
        <CoinLogo id={here.coin} size={12} className="-mt-0.5" /> {fmtUsd(ci.liquidity)} {here.symbol}, SO IT CANNOT PAY
        ALL OF IT HERE. SEND IT TO A CHAIN THAT CAN:
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[9px] font-bold opacity-55">AMOUNT</span>
        <span className="flex items-center gap-1 rounded-lg border-2 border-ink bg-white px-2 py-1">
          <span className="font-mono text-[12px] font-bold opacity-50">$</span>
          <input
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9.]/g, ''))}
            inputMode="decimal"
            aria-label="Claim amount to move"
            className="w-24 bg-transparent font-mono text-[12px] font-bold outline-none"
          />
        </span>
        <button
          type="button"
          onClick={() => setAmountStr((Math.floor(claim * 100) / 100).toFixed(2))}
          className="rounded-md border-2 border-ink bg-white px-2 py-0.5 font-mono text-[9px] font-bold hover:bg-lime"
        >
          ALL
        </button>
        {amount > claim + 0.005 && (
          <span className="font-mono text-[9px] font-bold text-down">YOU HOLD {fmtUsd(claim)} OF CLAIM HERE</span>
        )}
      </div>

      <p className="mt-2 font-mono text-[9px] font-bold opacity-55">TO</p>
      <div className="mt-1 flex flex-wrap gap-1.5" data-testid="move-destinations">
        {options === null ? (
          <span className="font-mono text-[10px] font-bold opacity-50">✳ ASKING EVERY CHAIN…</span>
        ) : options.length === 0 ? (
          <span className="font-mono text-[10px] font-bold text-down">
            NO OTHER CHAIN CAN PAY {fmtUsd(Math.min(amount, claim))} IN FULL RIGHT NOW — TRY A SMALLER AMOUNT. YOUR CLAIM STAYS
            VALID HERE.
          </span>
        ) : (
          options.map((o) => {
            const d = dollarOn(o.chain, info)
            return (
              <button
                key={o.chain}
                type="button"
                onClick={() => setDst(o.chain)}
                aria-pressed={dst === o.chain}
                data-chain={o.chain}
                className={`inline-flex items-center gap-1.5 rounded-lg border-2 px-2 py-1 text-left font-mono text-[10px] font-bold transition ${
                  dst === o.chain ? 'border-ink bg-lime shadow-brutal-sm' : 'border-ink/30 bg-white hover:border-ink'
                }`}
              >
                <ChainLogo id={o.chain} size={16} />
                <span>
                  {o.chain.toUpperCase()}
                  <span className="block text-[8px] opacity-60">
                    PAID IN {d.symbol} · VAULT {fmtUsd(o.liquidity)}
                  </span>
                </span>
                <CoinLogo id={d.coin} size={14} />
              </button>
            )
          })
        )}
      </div>

      <div className="mt-2 font-mono text-[9px] font-bold">
        {naming ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="opacity-55">
              {wide ? `${dst?.toUpperCase()} ACCOUNT KEY (32 BYTES)` : `RECIPIENT ON ${dst ? dst.toUpperCase() : 'THAT CHAIN'}`}
            </span>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value.trim())}
              placeholder={wide ? '0x + 64 hex' : '0x…'}
              aria-label="Recipient"
              className="w-72 max-w-full rounded-md border-2 border-ink bg-white px-1.5 py-0.5 outline-none"
            />
            {!wide && (
              <button type="button" onClick={() => setOther(false)} className="underline">
                BACK TO MY OWN ADDRESS
              </button>
            )}
            {recipient && shape && !shape.ok && <span className="basis-full text-down">{shape.reason.toUpperCase()}</span>}
          </span>
        ) : (
          <span className="opacity-60">
            PAID TO YOUR OWN ADDRESS{wallet ? ` (${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)})` : ''} ·{' '}
            <button type="button" onClick={() => setOther(true)} className="underline">
              SEND TO ANOTHER ADDRESS
            </button>
          </span>
        )}
      </div>

      {chosen && there && (
        <p className="mt-2 font-mono text-[9px] font-bold leading-relaxed tracking-wide opacity-70">
          {instant
            ? `ARRIVES ON ${chosen.chain.toUpperCase()} IN THIS SAME TRANSACTION, AS ${there.symbol}.`
            : `CROSSES TO THE HUB AND ON TO ${chosen.chain.toUpperCase()}: A FEW MINUTES. PAID THERE IN ${there.symbol} — OR, IF THE HUB CANNOT HAND IT ON, IT COMES BACK TO YOU HERE AS THE SAME CLAIM.`}{' '}
          {onchain?.sponsored ? (
            'NETWORK FEE: SPONSORED.'
          ) : chosen.fee > 0 ? (
            <>
              NETWORK FEE ≈ {gasCoin && <CoinLogo id={gasCoin} size={12} className="-mt-0.5" />}{' '}
              {chosen.fee.toFixed(chosen.fee < 0.001 ? 6 : 5)} {ci.nativeSymbol} + GAS, NOT REFUNDABLE.
            </>
          ) : (
            'NO NETWORK FEE — ONLY GAS.'
          )}
          {there.symbol !== here.symbol
            ? ` A CLAIM IS A CLAIM ON THE UNIVERSE'S DOLLARS: IT LEAVES AS ${there.symbol} AT PAR.`
            : ''}
        </p>
      )}

      <button
        type="button"
        onClick={() => void go()}
        disabled={busy || !chosen || !(amount > 0) || amount > claim + 0.005 || (naming && !shape?.ok)}
        data-testid="move-button"
        className="mt-2 rounded-xl border-3 border-ink bg-lime px-4 py-2 font-mono text-[11px] font-bold shadow-brutal-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy
          ? instant
            ? '✳ MOVING…'
            : '✳ CROSSING CHAINS…'
          : chosen
            ? `MOVE ${fmtUsd(Math.min(amount, claim))} TO ${chainName(chosen.chain).toUpperCase()} ↗`
            : 'MOVE ↗'}
      </button>
      {msg && (
        <p
          className={`mt-2 font-mono text-[9px] font-bold tracking-wide ${msg.ok ? 'text-up' : msg.neutral ? '' : 'text-down'}`}
          data-testid="move-msg"
        >
          {msg.text}
        </p>
      )}
    </div>
  )
}
