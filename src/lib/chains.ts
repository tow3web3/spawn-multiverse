export interface Chain {
  id: string
  label: string
  /** The app's pastel for this chain (tints, backgrounds). */
  color: string
  /** The chain's own brand colour — matches its logo (data marks: the supply bar). */
  brand: string
}

// No letter abbreviations on purpose: a chain is always shown by its real
// logo (components/ChainLogos.tsx), never by an initial.
//
// ONE universe on SIX chains (decided 2026-11-14), in the order the site
// names them: the hub chain first, then the L2s, Ethereum L1, BNB Chain and
// Solana. A deployment runs the ones its manifest lists.
export const CHAINS: Chain[] = [
  { id: 'base', label: 'BASE', color: '#7fa8f8', brand: '#0000FF' },
  { id: 'optimism', label: 'OPTIMISM', color: '#f58b7e', brand: '#FF0420' },
  { id: 'arbitrum', label: 'ARBITRUM', color: '#f5a8c8', brand: '#12AAFF' },
  { id: 'ethereum', label: 'ETHEREUM', color: '#9ccbf5', brand: '#627EEA' },
  { id: 'bnb', label: 'BNB', color: '#f8d55a', brand: '#F0B90B' },
  { id: 'solana', label: 'SOLANA', color: '#b5e95b', brand: '#9945FF' },
]

/** The six chains of the universe — what the concept copy and the
 * simulation talk about. */
export const DESIGN_CHAINS: Chain[] = CHAINS
