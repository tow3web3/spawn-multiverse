import { useStore } from '../store'
import { CHAINS, type Chain } from './chains'

const WORDS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX']
const LOWER = ['zero', 'one', 'two', 'three', 'four', 'five', 'six']

export interface ChainSet {
  /** Chains users can actually trade from in the current mode. */
  live: Chain[]
  /** Chains of the six-chain design that this deployment does not run yet. */
  soon: Chain[]
  count: number
  /** "SIX", "THREE"… for display copy. */
  word: string
  /** "six", "three"… for sentence copy. */
  lower: string
  /** "Base, Optimism and Arbitrum" */
  names: string
}

const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase()

/**
 * The chain set the page may honestly talk about. The simulation runs the
 * full six-chain design; an on-chain deployment runs whatever its manifest
 * lists (mainnet v1: Base + Optimism + Arbitrum), and the copy must say so.
 */
export function useChainSet(): ChainSet {
  const { onchain } = useStore()
  const ids = onchain?.chains
  const live = ids ? CHAINS.filter((c) => ids.includes(c.id)) : CHAINS
  const soon = ids ? CHAINS.filter((c) => !ids.includes(c.id)) : []
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
  }
}
