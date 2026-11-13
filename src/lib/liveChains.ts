import { useStore } from '../store'
import { CHAINS, DESIGN_CHAINS, type Chain } from './chains'
import { COMING_CHAINS } from './universes'
import { coinOf, type CoinLogoId } from '../components/ChainLogos'

/** The dollar the page is denominated in: the deployment's settlement token
 * on-chain (USDC, USDT…), plain USDC in the simulation. */
export function useDollar(): { symbol: string; decimals: number; coin: CoinLogoId } {
  const { onchain } = useStore()
  const symbol = onchain?.dollar.symbol ?? 'USDC'
  return { symbol, decimals: onchain?.dollar.decimals ?? 6, coin: coinOf(symbol) ?? 'usdc' }
}

const WORDS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX']
const LOWER = ['zero', 'one', 'two', 'three', 'four', 'five', 'six']

export interface ChainSet {
  /** Chains users can actually trade from in the current mode. */
  live: Chain[]
  /** Chains announced for THIS deployment and not live on it yet. Never the
   * chains of another universe: Ethereum and BNB are worlds of their own. */
  soon: Chain[]
  count: number
  /** "SIX", "THREE"… for display copy. */
  word: string
  /** "six", "three"… for sentence copy. */
  lower: string
  /** "Base, Optimism and Arbitrum" */
  names: string
  /** One chain only: there is nothing to cross, no message, no message fee. */
  single: boolean
}

const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase()

/**
 * The chain set the page may honestly talk about.
 *  - The simulation runs the full six-chain design.
 *  - A local devnet runs what its manifest lists; the rest of the six-chain
 *    design is "soon".
 *  - A mainnet UNIVERSE (and the public testnet that rehearses the omnichain
 *    one) runs what its manifest lists. The omnichain universe still has
 *    chains to come (Solana, Robinhood); a single-chain universe (BNB,
 *    Ethereum) is complete as it is.
 */
export function useChainSet(): ChainSet {
  const { onchain } = useStore()
  const ids = onchain?.chains
  const live = ids ? CHAINS.filter((c) => ids.includes(c.id)) : DESIGN_CHAINS
  let soon: Chain[] = []
  if (ids) {
    if (onchain?.network === 'local') {
      // the devnet simulates the six-chain design: whatever it leaves out
      soon = DESIGN_CHAINS.filter((c) => !ids.includes(c.id))
    } else if (!onchain?.universe?.single && live.length > 1) {
      // mainnet's omnichain universe and the public testnet that rehearses
      // it: the chains still to join are Solana and Robinhood. Ethereum and
      // BNB are never "coming" here — they are universes of their own.
      soon = CHAINS.filter((c) => (COMING_CHAINS as readonly string[]).includes(c.id) && !ids.includes(c.id))
    }
  }
  const labels = live.map((c) => (c.id === 'bnb' ? 'BNB' : title(c.label)))
  const names =
    labels.length <= 1
      ? (labels[0] ?? '')
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
  return {
    live,
    soon,
    count: live.length,
    word: WORDS[live.length] ?? String(live.length),
    lower: LOWER[live.length] ?? String(live.length),
    names,
    single: live.length === 1,
  }
}
