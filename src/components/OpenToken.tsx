import { useEffect, useState } from 'react'
import { useStore, type OpenCheck } from '../store'
import { chainName } from '../lib/liveChains'
import { CoinLogo, coinOf } from './ChainLogos'

/**
 * v7.2: a token with no replica on the chain the user is on (its launch
 * skipped that chain — typically Ethereum, too dear at the time — or the
 * chain joined later). Instead of a trade the gateway would refuse, offer to
 * OPEN it: the user pays `quoteOpen()` and the replica arrives with the
 * hub's reply. Offered only once the hub's live price for that SYNC is
 * within its ceiling — otherwise the chain is too expensive right now and
 * no fee is taken.
 */
export function OpenToken({
  num,
  chain,
  ticker,
  onOpened,
}: {
  num: number
  chain: string
  ticker: string
  /** The panel goes away once the token is open: the page says it instead. */
  onOpened?: (text: string) => void
}) {
  const { onchain, wallet, connect } = useStore()
  const ci = onchain?.chainInfo?.[chain]
  const [check, setCheck] = useState<OpenCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!onchain?.checkOpen) return
    let stale = false
    setCheck(null)
    void onchain.checkOpen(num, chain).then((c) => !stale && setCheck(c))
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [num, chain, tick, onchain?.checkOpen])

  useEffect(() => setMsg(null), [num, chain])

  const name = chainName(chain).toUpperCase()
  const instant = onchain?.network === 'local' || !!ci?.local
  const gasCoin = coinOf(ci?.nativeSymbol)

  const go = async () => {
    if (busy || !onchain?.openToken) return
    setBusy(true)
    setMsg(null)
    try {
      if (!wallet) {
        await connect()
        setMsg({ ok: true, text: 'WALLET CONNECTED — HIT IT AGAIN TO OPEN.' })
        return
      }
      const r = await onchain.openToken(num, chain)
      setMsg(r.ok ? { ok: true, text: r.text } : { ok: false, text: r.reason.toUpperCase() })
      if (r.ok) onOpened?.(r.text)
      else setTick((t) => t + 1)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 rounded-xl border-3 border-ink bg-candy/60 p-3" data-testid="open-token">
      <p className="font-mono text-[11px] font-bold tracking-wide">🚪 ${ticker} IS NOT OPEN ON {name} YET</p>
      <p className="mt-1 font-mono text-[9px] font-bold leading-relaxed tracking-wide opacity-75">
        ITS LAUNCH SKIPPED THIS CHAIN (A CHAIN TOO EXPENSIVE AT THAT MOMENT IS LEFT OUT), SO THERE IS NOTHING TO
        TRADE HERE YET. OPEN IT: {onchain?.sponsored ? 'THE ROUND TRIP IS SPONSORED HERE' : 'YOU PAY THE NETWORK FEE FOR THE ROUND TRIP'}, THE HUB SENDS ${ticker} BACK{' '}
        {instant ? 'IN THE SAME TRANSACTION' : 'WITHIN A FEW MINUTES'}, AND IT IS TRADABLE ON {name} FOR EVERYONE.
        {chain === 'ethereum' ? ' EVERY ACTION ON ETHEREUM PAYS L1 GAS.' : ''}
      </p>

      {check === null ? (
        <p className="mt-2 font-mono text-[9px] font-bold opacity-60">✳ ASKING THE HUB WHAT IT WOULD COST…</p>
      ) : check.ok ? (
        <p className="mt-2 font-mono text-[9px] font-bold tracking-wide" data-testid="open-fee">
          {onchain?.sponsored ? (
            'NETWORK FEE: SPONSORED — YOU ONLY PAY GAS.'
          ) : check.fee > 0 ? (
            <>
              NETWORK FEE ≈ {gasCoin && <CoinLogo id={gasCoin} size={12} className="-mt-0.5" />}{' '}
              {check.fee.toFixed(check.fee < 0.001 ? 6 : 5)} {ci?.nativeSymbol ?? 'ETH'} + GAS, NOT REFUNDABLE.
            </>
          ) : (
            'NO NETWORK FEE — YOU ONLY PAY GAS.'
          )}
          {!instant && (
            <span className="opacity-60">
              {' '}
              IF A MESSAGE TO {name} GETS DEARER BEFORE YOUR REQUEST ARRIVES, THE HUB WILL NOT SEND IT
              {onchain?.sponsored ? ' — TRY AGAIN LATER.' : ' AND THE FEE PAYS FOR THE ATTEMPT.'}
            </span>
          )}
        </p>
      ) : (
        <p className="mt-2 font-mono text-[9px] font-bold tracking-wide text-down" data-testid="open-closed">
          {check.reason.toUpperCase()}
          <button
            type="button"
            onClick={() => setTick((t) => t + 1)}
            className="ml-2 rounded-md border-2 border-ink bg-white px-2 py-0.5 text-ink hover:bg-lime"
          >
            CHECK AGAIN ↻
          </button>
        </p>
      )}

      <button
        type="button"
        onClick={() => void go()}
        disabled={busy || !check?.ok}
        data-testid="open-button"
        className="mt-2 w-full rounded-xl border-3 border-ink bg-lime px-4 py-2.5 font-mono text-[12px] font-bold tracking-wide shadow-brutal-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy
          ? instant
            ? '✳ OPENING…'
            : '✳ ASKING THE HUB — A FEW MINUTES…'
          : !wallet
            ? '◉ CONNECT WALLET TO OPEN'
            : `OPEN $${ticker} ON ${name} ↗`}
      </button>
      {msg && (
        <p
          className={`mt-2 font-mono text-[9px] font-bold tracking-wide ${msg.ok ? 'text-up' : 'text-down'}`}
          data-testid="open-msg"
        >
          {msg.text}
        </p>
      )}
    </div>
  )
}
