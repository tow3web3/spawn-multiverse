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
export const CHAINS: Chain[] = [
  { id: 'solana', label: 'SOLANA', color: '#b5e95b', brand: '#9945FF' },
  { id: 'ethereum', label: 'ETHEREUM', color: '#9ccbf5', brand: '#627EEA' },
  { id: 'base', label: 'BASE', color: '#7fa8f8', brand: '#0000FF' },
  { id: 'bnb', label: 'BNB', color: '#f8d55a', brand: '#F0B90B' },
  { id: 'arbitrum', label: 'ARBITRUM', color: '#f5a8c8', brand: '#12AAFF' },
  { id: 'optimism', label: 'OPTIMISM', color: '#f58b7e', brand: '#FF0420' },
  // announced for the omnichain universe once Circle's USDC is live there;
  // never part of the simulation's six-chain design
  { id: 'robinhood', label: 'ROBINHOOD', color: '#dff78a', brand: '#CCFF00' },
]

/** The six chains the simulation runs. */
export const DESIGN_CHAINS: Chain[] = CHAINS.filter((c) => c.id !== 'robinhood')
