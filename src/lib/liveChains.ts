import { useStore } from '../store'
import { CHAINS, DESIGN_CHAINS, JOINING_MAINNET, joinSentence, joinText, type Chain, type Joining } from './chains'
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

/** A chain about to join the live mainnet, with what the page says of it. */
export interface JoiningChain extends Joining {
  chain: Chain
  /** "JOINS 18 NOV" */
  text: string
  /** "Solana joins on 18 Nov" */
  sentence: string
}

export interface ChainSet {
  /** Chains a user can actually trade on in the current mode: the
   * manifest's list on-chain (never more), the six in the simulation. */
  live: Chain[]
  /** Mainnet only: the chains of the universe not live yet that have a day
   * to join (Solana, 18 Nov) — shown with that day, never as tradable. */
  joining: JoiningChain[]
  /** "Solana joins on 18 Nov." — empty when nothing is joining. */
  joinNote: string
  /** The six chains of the universe — for the concept copy only. */
  design: Chain[]
  /** The live chains plus the joining ones: the size of the universe the
   * deployment runs, or is about to (mainnet: six). */
  count: number
  /** "SIX"… for display copy (live + joining). */
  word: string
  /** "six"… for sentence copy (live + joining). */
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
  const joining: JoiningChain[] =
    onchain?.network === 'mainnet' && ids
      ? CHAINS.filter((c) => !ids.includes(c.id) && JOINING_MAINNET[c.id]).map((c) => {
          const j = JOINING_MAINNET[c.id]
          return { ...j, chain: c, text: joinText(j), sentence: joinSentence(chainName(c.id), j) }
        })
      : []
  const count = live.length + joining.length
  return {
    live,
    joining,
    joinNote: joining.map((j) => `${j.sentence}.`).join(' '),
    design: DESIGN_CHAINS,
    count,
    word: WORDS[count] ?? String(count),
    lower: LOWER[count] ?? String(count),
    names: listNames(live),
    single: count === 1,
  }
}
