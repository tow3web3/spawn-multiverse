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

/** A chain of the universe on its way into the LIVE mainnet: deployed, and
 * waiting for the hub's timelock to wire it. It is shown by the day it
 * joins — never as live, never as broken, never as "soon". The moment the
 * mainnet manifest lists it, it is live and its entry here is ignored. */
export interface Joining {
  /** When the hub's wiring batch becomes executable (ms since epoch). */
  at: number
  /** The day, as the site prints it: "18 NOV". */
  day: string
}

/** Solana: program live on mainnet-beta (paused); its link to the hub is a
 * timelock batch executable 2026-11-18 03:34 UTC. */
export const JOINING_MAINNET: Record<string, Joining> = {
  solana: { at: Date.UTC(2026, 10, 18, 3, 34), day: '18 NOV' },
}

/** "JOINS 18 NOV" — and "JOINING · 18 NOV" once that moment has passed but
 * the chain is not wired yet (the batch still has to be executed). */
export const joinText = (j: Joining, now = Date.now()) => (now < j.at ? `JOINS ${j.day}` : `JOINING · ${j.day}`)

/** "Solana joins on 18 Nov" for sentences. */
export const joinSentence = (name: string, j: Joining, now = Date.now()) => {
  const day = j.day.replace(/ (\w)(\w+)$/, (_, a: string, b: string) => ` ${a}${b.toLowerCase()}`)
  return now < j.at ? `${name} joins on ${day}` : `${name} is joining (${day})`
}
