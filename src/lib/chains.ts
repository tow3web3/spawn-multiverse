export interface Chain {
  id: string
  label: string
  short: string
  color: string
}

export const CHAINS: Chain[] = [
  { id: 'solana', label: 'SOLANA', short: 'S', color: '#b5e95b' },
  { id: 'ethereum', label: 'ETHEREUM', short: 'E', color: '#9ccbf5' },
  { id: 'base', label: 'BASE', short: 'B', color: '#7fa8f8' },
  { id: 'bnb', label: 'BNB', short: 'BN', color: '#f8d55a' },
  { id: 'arbitrum', label: 'ARBITRUM', short: 'A', color: '#f5a8c8' },
  { id: 'optimism', label: 'OPTIMISM', short: 'O', color: '#f58b7e' },
]
