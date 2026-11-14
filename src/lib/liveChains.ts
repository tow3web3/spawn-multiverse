import { useStore } from '../store'
import { CHAINS, DESIGN_CHAINS, type Chain } from './chains'
import { designDollar } from './v72'
import { CHAIN_NAME, coinOf, isChainLogoId, type CoinLogoId } from '../components/ChainLogos'

export interface DollarView {
  symbol: string
  decimals: number
  coin: CoinLogoId
}

type DollarInfo = Record<string, { dollar: { symbol: string; decimals: number } }>

/** The dollar a chain settles in: what the chain itself reported (on-chain
 * modes), else the design's — Binance USDT on BNB Chain, USDC elsewhere. */
export function dollarOn(chainId: string | undefined, info?: DollarInfo): DollarView {
  const d = (chainId && info?.[chainId]?.dollar) || designDollar(chainId ?? '')
  return { symbol: d.symbol, decimals: d.decimals, coin: coinOf(d.symbol) ?? 'usdc' }
}

/** The dollar of ONE chain — never of the page: labels, decimals and
 * approvals follow the chain the user is on. */
export function useChainDollar(chainId: string | undefined): DollarView {
  const { onchain } = useStore()
  return dollarOn(chainId, onchain?.chainInfo)
}

/** Every distinct dollar the live chains settle in (USDC, USDT). */
export function useDollars(): DollarView[] {
  const { live } = useChainSet()
  const { onchain } = useStore()
  const out: DollarView[] = []
  for (const c of live) {
    const d = dollarOn(c.id, onchain?.chainInfo)
    if (!out.some((x) => x.symbol === d.symbol)) out.push(d)
  }
  return out
}

const WORDS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX']
const LOWER = ['zero', 'one', 'two', 'three', 'four', 'five', 'six']

/** "Base", "BNB Chain"… the full name of a chain. */
export const chainName = (id: string) => (isChainLogoId(id) ? CHAIN_NAME[id] : id)

/** "Base, Optimism and Arbitrum". */
export function listNames(chains: Chain[]): string {
  const labels = chains.map((c) => chainName(c.id))
  return labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

export interface ChainSet {
  /** Chains a user can actually trade on in the current mode: the
   * manifest's list on-chain (never more), the six in the simulation. */
  live: Chain[]
  /** The six chains of the universe — for the concept copy only. */
  design: Chain[]
  count: number
  /** "FIVE", "SIX"… for display copy. */
  word: string
  /** "five", "six"… for sentence copy. */
  lower: string
  /** "Base, Optimism and Arbitrum" — the live chains. */
  names: string
  /** One chain only: there is nothing to cross, no message, no message fee. */
  single: boolean
}

/**
 * The chains the page may honestly say something about. The concept (one
 * universe, six chains) is `design`; anything that says what can be traded
 * NOW is `live` — the manifest's chains, nothing greyed, nothing promised.
 */
export function useChainSet(): ChainSet {
  const { onchain } = useStore()
  const ids = onchain?.chains
  const live = ids ? CHAINS.filter((c) => ids.includes(c.id)) : DESIGN_CHAINS
  return {
    live,
    design: DESIGN_CHAINS,
    count: live.length,
    word: WORDS[live.length] ?? String(live.length),
    lower: LOWER[live.length] ?? String(live.length),
    names: listNames(live),
    single: live.length === 1,
  }
}
