import { createContext, useContext } from 'react'
import type { ChainLogoId } from '../components/ChainLogos'

/**
 * SPAWN! on mainnet is not one deployment but several independent UNIVERSES:
 * each has its own hub, its own tokens and its own dollar. A token launched
 * in one universe does not exist in another.
 *
 *  - omnichain ("core"): Base (hub) + Optimism + Arbitrum, settled in USDC.
 *    One token, one price, across its chains.
 *  - bnb: BNB Chain alone, settled in BSC USDT — a Binance-custodied peg.
 *  - ethereum: Ethereum mainnet alone, settled in native USDC; every action
 *    pays L1 gas.
 *
 * A universe exists on the site only once its manifest is published.
 */
export type UniverseId = 'core' | 'bnb' | 'ethereum'

/** What the mode switch can select. `mainnet` is the omnichain universe (the
 * name it has had since the first launch, kept so stored choices survive). */
export type AppMode = 'sim' | 'testnet' | 'chain' | 'mainnet' | 'bnb' | 'ethereum'

export interface UniverseDef {
  id: UniverseId
  mode: Extract<AppMode, 'mainnet' | 'bnb' | 'ethereum'>
  manifest: string
  /** Label on the mode switch. */
  tab: string
  /** "THE … UNIVERSE". */
  name: string
  /** Logos shown next to the name (the chains it runs on). */
  logos: ChainLogoId[]
  /** One line: where it lives and what it settles in. */
  line: string
  /** A universe that is one chain: no cross-chain trading, no message fee. */
  single: boolean
}

export const UNIVERSES: UniverseDef[] = [
  {
    id: 'core',
    mode: 'mainnet',
    manifest: '/onchain/mainnet.json',
    tab: 'MAINNET',
    name: 'OMNICHAIN',
    logos: ['base', 'optimism', 'arbitrum'],
    line: 'Base + Optimism + Arbitrum · settled in USDC',
    single: false,
  },
  {
    id: 'bnb',
    mode: 'bnb',
    manifest: '/onchain/mainnet-bnb.json',
    tab: 'BNB',
    name: 'BNB',
    logos: ['bnb'],
    line: 'BNB Chain · settled in USDT (Binance-Peg)',
    single: true,
  },
  {
    id: 'ethereum',
    mode: 'ethereum',
    manifest: '/onchain/mainnet-ethereum.json',
    tab: 'ETHEREUM',
    name: 'ETHEREUM',
    logos: ['ethereum'],
    line: 'Ethereum mainnet · settled in USDC',
    single: true,
  },
]

export const universeOf = (id: string | undefined): UniverseDef | undefined => UNIVERSES.find((u) => u.id === id)
export const universeOfMode = (mode: AppMode): UniverseDef | undefined => UNIVERSES.find((u) => u.mode === mode)

/** Chains announced for the omnichain universe and not live yet. Ethereum and
 * BNB are NOT here: they are universes of their own, not future chains of
 * this one. */
export const COMING_CHAINS = ['solana', 'robinhood'] as const

/** Which universes are live on this site, and how to move between them. The
 * App owns it; components below the store read it to point at the others. */
export interface UniverseNav {
  /** Universes whose manifest is published. */
  live: UniverseDef[]
  /** The universe on screen, when the mode is a mainnet universe. */
  current?: UniverseId
  go: (id: UniverseId) => void
}

export const UniverseNavCtx = createContext<UniverseNav>({ live: [], go: () => undefined })
export const useUniverseNav = () => useContext(UniverseNavCtx)
