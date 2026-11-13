import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { FACE_COLOR, type FaceId } from './components/Faces'
import {
  START_PRICE,
  TOTAL_SUPPLY,
  ascensionProgress,
  type MarketState,
  type Quote,
} from './engine/curve'
import {
  GENESIS_BLOCK_MS,
  createMarket,
  emptyFees,
  execute,
  holdersCount,
  priceAt,
  priceOf,
  quote as marketQuote,
  randomBotTrade,
  randomChain,
  simulateLife,
  type FeeMode,
  type Fees,
  type Market,
  type PricePoint,
  type SeedPhase,
  type Side,
  type Trade,
} from './engine/market'

export { TOTAL_SUPPLY as GLOBAL_SUPPLY, START_PRICE } from './engine/curve'
export {
  FEE_RATE,
  BURNER,
  GENESIS_WINDOW_MS,
  GENESIS_BLOCK_MS,
  GENESIS_MAX_USD,
  SNIPE_MAX_RATE,
  genesisTax,
} from './engine/market'
export type { Side, Trade, PricePoint, Market, FeeMode, Fees } from './engine/market'

export type Status = 'live' | 'hot' | 'ascended'

export interface CreatureLinks {
  website?: string
  x?: string
  telegram?: string
}

export interface CreatureMeta {
  num: number
  name: string
  ticker: string
  /** Seed creatures use a built-in SVG face… */
  face?: FaceId
  /** …user-created creatures have their own image: on-chain the hosted
   * path `/img/<sha256>`; in the SIM, or as the creator's own copy of an
   * un-hosted launch, a local data URL. Rendered only through
   * `safeImageSrc` — nothing else is ever loaded. */
  image?: string
  links?: CreatureLinks
  color: string
  spawnedAt: number
  custom?: boolean
  /** Who eats the 1% trading fee — chosen by the dev at launch. */
  feeMode?: FeeMode
  /** Wallet that launched it (dev dashboard ownership). */
  creator?: string
}

/** A creature with its live market data derived from the engine. */
export interface Creature extends CreatureMeta {
  status: Status
  price: number
  change: number
  volume: number
  holders: number
  supply: number
  mcap: number
  /** 0..1 along the genesis curve; 1 once ascended. */
  progress: number
  /** Live fee accounting (sim engine; on-chain fees land in protocol v2). */
  fees?: Fees
}

export interface Position {
  tokens: number
  cost: number
  /** On-chain only: false when part of this bag was not bought through
   * this browser, so its cost — and any PnL — is unknown here. */
  costKnown?: boolean
}

export interface Wallet {
  address: string
  balance: number
  positions: Record<number, Position>
}

const MIN = 60_000
const PALETTE = ['#b5e95b', '#f7a8ce', '#9ccbf5', '#a78bf0', '#f7be7b', '#8be0d4']
const CHANGE_WINDOW = 60 * MIN
const HOT_WINDOW = 15 * MIN
const HOT_THRESHOLD = 0.25
const STARTING_BALANCE = 1337

/* ------------------------------------------------------------------ */
/* Seeds — each demo creature's life is replayed through the engine,  */
/* so price, volume, holders and history are all real curve output.   */
/* ------------------------------------------------------------------ */

interface Seed {
  num: number
  name: string
  ticker: string
  face: FaceId
  minutesAgo: number
  steps: number
  phases: SeedPhase[]
  feeMode: FeeMode
}

const SEEDS: Seed[] = [
  {
    num: 1,
    name: 'GLOOP SUPREME',
    ticker: 'GLOOP',
    feeMode: 'holders',
    face: 'frog',
    minutesAgo: 47,
    steps: 320,
    phases: [
      { until: 0.55, buyBias: 0.72, stopAtPrice: 0.000018 },
      { until: 0.8, buyBias: 0.62, stopAtPrice: 0.000028 },
      { until: 1, buyBias: 0.82, stopAtPrice: 0.000048 },
    ],
  },
  {
    num: 2,
    name: 'BRAINROT 3000',
    ticker: 'ROT',
    feeMode: 'burn',
    face: 'brain',
    minutesAgo: 123,
    steps: 700,
    phases: [
      { until: 0.6, buyBias: 0.8 },
      { until: 0.95, buyBias: 0.66 },
      { until: 1, buyBias: 0.78 },
    ],
  },
  {
    num: 3,
    name: 'SIR BORKS',
    ticker: 'BORK',
    feeMode: 'split',
    face: 'bork',
    minutesAgo: 82,
    steps: 260,
    phases: [
      { until: 0.6, buyBias: 0.76, stopAtPrice: 0.000017 },
      { until: 1, buyBias: 0.5 },
    ],
  },
  {
    num: 4,
    name: 'COSMIC PICKLE',
    ticker: 'PICKL',
    feeMode: 'dev',
    face: 'pickle',
    minutesAgo: 36,
    steps: 90,
    phases: [{ until: 1, buyBias: 0.62, stopAtPrice: 0.0000095 }],
  },
  {
    num: 5,
    name: 'MOCHI MAYHEM',
    ticker: 'MOCHI',
    feeMode: 'holders',
    face: 'mochi',
    minutesAgo: 118,
    steps: 300,
    phases: [
      { until: 0.65, buyBias: 0.75, stopAtPrice: 0.000022 },
      { until: 1, buyBias: 0.24 },
    ],
  },
  {
    num: 6,
    name: 'ALIEN INTERN',
    ticker: 'INTRN',
    feeMode: 'split',
    face: 'alien',
    minutesAgo: 3,
    steps: 26,
    phases: [{ until: 1, buyBias: 0.82, stopAtPrice: 0.00001 }],
  },
]

/* ------------------------------------------------------------------ */
/* Persistence                                                        */
/* ------------------------------------------------------------------ */

const LS_CUSTOMS = 'spawn.customs.v2'
const LS_WALLET = 'spawn.wallet.v1'

interface StoredCustom {
  meta: CreatureMeta
  state: MarketState
  volume: number
  chainTokens: Record<string, number>
  balances: [string, number][]
  trades: Trade[]
  history: PricePoint[]
  fees?: Fees
  ascendedAt?: number
}

function loadWallet(): Wallet | null {
  try {
    const raw = localStorage.getItem(LS_WALLET)
    if (!raw) return null
    const w = JSON.parse(raw) as Wallet
    return w && typeof w.balance === 'number' && w.address ? w : null
  } catch {
    return null
  }
}

function saveWallet(w: Wallet | null) {
  try {
    if (w) localStorage.setItem(LS_WALLET, JSON.stringify(w))
    else localStorage.removeItem(LS_WALLET)
  } catch {
    // storage unavailable — demo state just won't persist
  }
}

interface World {
  metas: Map<number, CreatureMeta>
  markets: Map<number, Market>
}

function buildWorld(wallet: Wallet | null): World {
  const metas = new Map<number, CreatureMeta>()
  const markets = new Map<number, Market>()
  const now = Date.now()

  for (const s of SEEDS) {
    const spawnedAt = now - s.minutesAgo * MIN
    metas.set(s.num, {
      num: s.num,
      name: s.name,
      ticker: s.ticker,
      face: s.face,
      color: FACE_COLOR[s.face],
      spawnedAt,
      feeMode: s.feeMode,
    })
    const m = createMarket(spawnedAt, s.feeMode)
    simulateLife(m, spawnedAt, now - 3000, s.steps, s.phases)
    markets.set(s.num, m)
  }

  try {
    const raw = localStorage.getItem(LS_CUSTOMS)
    if (raw) {
      for (const sc of JSON.parse(raw) as StoredCustom[]) {
        if (!sc?.meta?.num || !sc.meta.name || !sc.state) continue
        metas.set(sc.meta.num, sc.meta)
        markets.set(sc.meta.num, {
          state: sc.state,
          volume: sc.volume ?? 0,
          chainTokens: sc.chainTokens ?? {},
          balances: new Map(sc.balances ?? []),
          trades: sc.trades ?? [],
          history: sc.history?.length ? sc.history : [{ ts: sc.meta.spawnedAt, price: START_PRICE }],
          fees: sc.fees ?? emptyFees(sc.meta.feeMode ?? 'holders'),
          ascendedAt: sc.ascendedAt,
          // FAIR GENESIS: restored markets re-key window spend from scratch —
          // a reload mid-window keeps the clock (spawnedAt) but not per-wallet
          // tallies, which only matters for the 10-minute opening.
          spawnTs: sc.meta.spawnedAt,
          genesisSpent: new Map(),
        })
      }
    }
  } catch {
    // corrupted storage — start fresh
  }

  // Seed markets are regenerated on every load; re-inject the user's holdings.
  if (wallet) {
    for (const [numStr, pos] of Object.entries(wallet.positions)) {
      const m = markets.get(Number(numStr))
      if (m && pos.tokens > 0) m.balances.set(wallet.address, pos.tokens)
    }
  }

  return { metas, markets }
}

function persistCustoms(world: World) {
  try {
    const out: StoredCustom[] = []
    for (const [num, meta] of world.metas) {
      if (!meta.custom) continue
      const m = world.markets.get(num)
      if (!m) continue
      out.push({
        meta,
        state: m.state,
        volume: m.volume,
        chainTokens: m.chainTokens,
        balances: [...m.balances.entries()].filter(([, v]) => v > 1),
        trades: m.trades.slice(0, 15),
        history: m.history.slice(-150),
        fees: m.fees,
        ascendedAt: m.ascendedAt,
      })
    }
    localStorage.setItem(LS_CUSTOMS, JSON.stringify(out))
  } catch {
    // storage unavailable
  }
}

/* ------------------------------------------------------------------ */
/* Derivation                                                         */
/* ------------------------------------------------------------------ */

export function deriveCreature(meta: CreatureMeta, m: Market, now: number): Creature {
  const price = priceOf(m)
  const ref = priceAt(m, Math.max(meta.spawnedAt, now - CHANGE_WINDOW))
  const recentRef = priceAt(m, Math.max(meta.spawnedAt, now - HOT_WINDOW))
  const hot = recentRef > 0 && price / recentRef - 1 >= HOT_THRESHOLD
  return {
    ...meta,
    status: m.state.phase === 'pool' ? 'ascended' : hot ? 'hot' : 'live',
    price,
    change: ref > 0 ? (price / ref - 1) * 100 : 0,
    volume: m.volume,
    holders: holdersCount(m),
    supply: TOTAL_SUPPLY - m.fees.burnedTokens,
    mcap: price * (TOTAL_SUPPLY - m.fees.burnedTokens),
    progress: ascensionProgress(m.state),
    fees: m.fees,
  }
}

function heatOf(meta: CreatureMeta, m: Market, now: number): number {
  const age = now - meta.spawnedAt
  let heat = 0.3
  if (age < 5 * MIN) heat = 0.85
  else if (age < 30 * MIN) heat = 0.5
  if (m.state.phase === 'pool') heat = Math.max(heat, 0.4)
  return Math.min(0.95, heat)
}

function genAddress(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16).toUpperCase()
  return `0x${Array.from({ length: 8 }, hex).join('')}`
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 5)}…${a.slice(-3)}`
}

/* ------------------------------------------------------------------ */
/* Store                                                              */
/* ------------------------------------------------------------------ */

export interface SpawnInput {
  name: string
  ticker: string
  /** The face as a local data URL — the preview, the SIM, and the creator's
   * own copy when no hosted image exists. */
  image: string
  /** On-chain only: the hosted path of that face (`/img/<sha256>`), which
   * is what the metaURI carries so every visitor sees it. */
  imageUrl?: string
  links?: CreatureLinks
  /** Fee routing, picked once at launch. Defaults to 'holders'. */
  feeMode?: FeeMode
  /** Dev buy riding inside the spawn itself — the one FAIR GENESIS
   * exemption (no block-0 rule, no snipe tax, no cap), disclosed in the UI. */
  devBuyUsd?: number
  /** On-chain only: the chain the launch is submitted (and paid) from. */
  chain?: string
}

export type TradeResult =
  | {
      ok: true
      usd: number
      tokens: number
      price: number
      ascended: boolean
      /** Something the trader should know about how it settled. */
      note?: string
      /** The message is still crossing chains — the figures are an estimate. */
      pending?: boolean
    }
  | { ok: false; reason: string }

/** Which world an on-chain store is talking to. */
export type NetworkProfile = 'local' | 'testnet' | 'mainnet'

/** One user-facing chain, as the connected wallet sees it. */
export interface ChainInfo {
  id: string
  /** The hub chain's own gateway: one-transaction trades, no messaging fee. */
  local: boolean
  /** The wallet's dollars here: USDC, plus oUSD claims on this chain's vault. */
  usdc: number
  ousd: number
  /** Native gas balance, and its symbol. */
  gas: number
  nativeSymbol: string
  /** The chain's USDC vault: what it holds and how much it may hold. */
  liquidity: number
  depositCap: number
  depositsPaused: boolean
  /** The gateway refuses new buys and launches (sells stay open). */
  paused: boolean
  /** Native messaging fee each action must attach (0 when sponsored). */
  fee: { buy: number; sell: number; claim: number; pull: number }
}

/** Holder fees of one creature for the connected wallet (v7: accrue, then pull). */
export interface HolderFees {
  /** Claimable right now, per chain. */
  claimable: Record<string, number>
  /** Per remote chain: that chain's whole slice still waiting on the hub
   * (`pot`) and the wallet's estimated share of it once pulled (`share`). */
  waiting: Record<string, { pot: number; share: number }>
}

/** How the person signs in on-chain: a throwaway burner key held by the
 * browser, or an injected wallet extension (MetaMask & friends). */
export type WalletSource = 'burner' | 'injected'

export interface StoreValue {
  mode: 'sim' | 'chain'
  creatures: Creature[]
  wallet: Wallet | null
  /** Connect. On-chain mode accepts a source; sim ignores it. */
  connect: (source?: WalletSource) => Promise<Wallet>
  spawn: (input: SpawnInput) => Promise<CreatureMeta>
  trade: (num: number, side: Side, amount: number, chain: string) => Promise<TradeResult>
  getQuote: (num: number, side: Side, amount: number) => Quote | null
  getMarket: (num: number) => Market | undefined
  /** Dev claims their accrued fee share (sim engine; absent on-chain for now). */
  claimFees?: (num: number) => Promise<number>
  justSpawned: number | null
  /** Present only in on-chain mode. */
  onchain?: {
    status: 'connecting' | 'ready' | 'offline'
    /** Local devnet, public testnet (play money) or mainnet (real USDC). */
    network: NetworkProfile
    /** The protocol's tank pays every message (testnets): no fee to attach. */
    sponsored: boolean
    /** Mints play USDC on every chain the wallet has gas on — testnets and
     * the local devnet only; absent on mainnet. */
    airdrop?: () => Promise<void>
    /** Chain ids actually live on this deployment. */
    chains?: string[]
    /** Per-chain balances, vault state and messaging fees. */
    chainInfo?: Record<string, ChainInfo>
    /** The hub refuses new buys and launches (they would be refunded). */
    hubPaused?: boolean
    /** Which signer is active right now. */
    walletSource?: WalletSource
    /** Forget the session (keeps the burner key for later). */
    disconnect?: () => void
    /** Holder fee rewards claimable NOW (USD) per creature num, summed across chains. */
    holderRewards?: Record<number, number>
    /** The same per chain, plus what still waits on the hub for a pull. */
    holderFees?: Record<number, HolderFees>
    /** Claim this creature's holder rewards on every chain holding any; returns USD claimed. */
    claimHolderRewards?: (num: number) => Promise<number>
    /** Bring one chain's waiting holder fees home (a paid cross-chain message). */
    pullHolderFees?: (num: number, chain: string) => Promise<{ ok: boolean; reason?: string }>
    /** Where each bag lives: creature num -> chain -> tokens. A sell only
     * reaches the bag of the chain it is sent from. */
    bags?: Record<number, Record<string, number>>
    /** Tokens delivered before their replica existed: creature num -> chain -> amount. */
    parked?: Record<number, Record<string, number>>
    claimParked?: (num: number, chain: string) => Promise<number>
    /** Turn the wallet's oUSD claims on a chain back into USDC; returns USDC received. */
    unwrap?: (chain: string) => Promise<number>
    /** The native fee a launch from `chain` must attach right now. */
    quoteSpawnFee?: (input: SpawnInput, chain: string) => Promise<number>
    /** Mainnet only: the one-time risk notice gating every transaction. */
    risk?: {
      accepted: boolean
      open: boolean
      show: () => void
      accept: () => void
      dismiss: () => void
    }
    /** FAIR GENESIS (v6): per creature num, the hub's live window state for
     * the connected wallet — absent on pre-v6 deployments. */
    fairGenesis?: Record<number, { endsAt: number; spentUsd: number; capUsd: number }>
  }
}

export const StoreCtx = createContext<StoreValue | null>(null)

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [wallet, setWallet] = useState<Wallet | null>(() => loadWallet())
  const walletRef = useRef<Wallet | null>(wallet)
  const worldRef = useRef<World | null>(null)
  if (!worldRef.current) worldRef.current = buildWorld(walletRef.current)
  const [version, bump] = useReducer((x: number) => x + 1, 0)
  const [justSpawned, setJustSpawned] = useState<number | null>(null)

  useEffect(() => saveWallet(wallet), [wallet])

  // The multiverse heartbeat: bots trade through the same engine you do.
  useEffect(() => {
    let tick = 0
    const t = setInterval(() => {
      const world = worldRef.current!
      const now = Date.now()
      for (const [num, m] of world.markets) {
        const meta = world.metas.get(num)!
        if (Math.random() < heatOf(meta, m, now) * 0.6) {
          const buyBias = Math.random() < 0.07 ? 0.15 : 0.58
          randomBotTrade(m, { buyBias })
        }
      }
      if (++tick % 5 === 0) persistCustoms(world)
      bump()
    }, 1700)
    return () => clearInterval(t)
  }, [])

  const connect = useCallback((): Wallet => {
    if (walletRef.current) return walletRef.current
    const w: Wallet = { address: genAddress(), balance: STARTING_BALANCE, positions: {} }
    walletRef.current = w
    setWallet(w)
    return w
  }, [])

  const trade = useCallback(
    (num: number, side: Side, amount: number, chain: string): TradeResult => {
      const world = worldRef.current!
      const w = walletRef.current
      if (!w) return { ok: false, reason: 'Connect a wallet first.' }
      const m = world.markets.get(num)
      if (!m) return { ok: false, reason: 'Unknown creature.' }
      if (!(amount > 0)) return { ok: false, reason: 'Enter an amount.' }

      if (side === 'buy') {
        if (amount > w.balance + 1e-6)
          return { ok: false, reason: `Insufficient balance — you have $${w.balance.toFixed(2)}.` }
        const r = execute(m, { side: 'buy', usd: amount, chain, trader: w.address })
        if (!r.ok) return r
        const pos = w.positions[num] ?? { tokens: 0, cost: 0 }
        const nw: Wallet = {
          ...w,
          balance: w.balance - r.usd,
          positions: {
            ...w.positions,
            [num]: { tokens: pos.tokens + r.tokens, cost: pos.cost + r.usd },
          },
        }
        walletRef.current = nw
        setWallet(nw)
        persistCustoms(world)
        bump()
        return r
      }

      const pos = w.positions[num]
      if (!pos || pos.tokens <= 0) return { ok: false, reason: 'You hold none of this creature.' }
      const tokens = Math.min(amount, pos.tokens)
      const r = execute(m, { side: 'sell', tokens, chain, trader: w.address })
      if (!r.ok) return r
      const fracLeft = pos.tokens > 0 ? (pos.tokens - r.tokens) / pos.tokens : 0
      const nw: Wallet = {
        ...w,
        balance: w.balance + r.usd,
        positions: {
          ...w.positions,
          [num]: { tokens: pos.tokens - r.tokens, cost: pos.cost * fracLeft },
        },
      }
      walletRef.current = nw
      setWallet(nw)
      persistCustoms(world)
      bump()
      return r
    },
    [],
  )

  const spawn = useCallback((input: SpawnInput): CreatureMeta => {
    const world = worldRef.current!
    const num = Math.max(0, ...world.metas.keys()) + 1
    const meta: CreatureMeta = {
      num,
      name: input.name.toUpperCase(),
      ticker: input.ticker.toUpperCase(),
      image: input.image,
      links: input.links,
      color: PALETTE[(num - 1) % PALETTE.length],
      spawnedAt: Date.now(),
      custom: true,
      feeMode: input.feeMode ?? 'holders',
      creator: walletRef.current?.address,
    }
    world.metas.set(num, meta)
    const m = createMarket(meta.spawnedAt, meta.feeMode)

    // The dev buy rides inside the spawn — the one FAIR GENESIS exemption.
    const devBuy = input.devBuyUsd ?? 0
    const w = walletRef.current
    if (devBuy > 0 && w) {
      const r = execute(m, {
        side: 'buy',
        usd: Math.min(devBuy, w.balance),
        chain: randomChain(),
        trader: w.address,
        genesisBuy: true,
        ts: meta.spawnedAt,
      })
      if (r.ok) {
        const nw: Wallet = {
          ...w,
          balance: w.balance - r.usd,
          positions: { ...w.positions, [num]: { tokens: r.tokens, cost: r.usd } },
        }
        walletRef.current = nw
        setWallet(nw)
      }
    }

    // A couple of instant snipes so a fresh spawn isn't lonely — they clear
    // the 2s "block 0" and pay the full ~30% FAIR GENESIS tax for the honor.
    randomBotTrade(m, { buyBias: 0.95, ts: meta.spawnedAt + GENESIS_BLOCK_MS + 400 })
    randomBotTrade(m, { buyBias: 0.95, ts: meta.spawnedAt + GENESIS_BLOCK_MS + 1100 })
    world.markets.set(num, m)
    persistCustoms(world)
    setJustSpawned(num)
    window.setTimeout(() => setJustSpawned(null), 4000)
    bump()
    return meta
  }, [])

  const getQuote = useCallback((num: number, side: Side, amount: number): Quote | null => {
    const m = worldRef.current!.markets.get(num)
    if (!m || !(amount > 0)) return null
    return marketQuote(m, side, amount)
  }, [])

  const getMarket = useCallback(
    (num: number) => worldRef.current!.markets.get(num),
    [],
  )

  const claimFees = useCallback((num: number): number => {
    const world = worldRef.current!
    const w = walletRef.current
    const m = world.markets.get(num)
    if (!w || !m) return 0
    const claimable = m.fees.dev - m.fees.devClaimed
    if (claimable <= 0.005) return 0
    m.fees.devClaimed += claimable
    const nw: Wallet = { ...w, balance: w.balance + claimable }
    walletRef.current = nw
    setWallet(nw)
    persistCustoms(world)
    bump()
    return claimable
  }, [])

  const creatures = useMemo(() => {
    void version
    const world = worldRef.current!
    const now = Date.now()
    return [...world.metas.values()].map((meta) =>
      deriveCreature(meta, world.markets.get(meta.num)!, now),
    )
  }, [version])

  const value = useMemo<StoreValue>(
    () => ({
      mode: 'sim',
      creatures,
      wallet,
      connect: async () => connect(),
      spawn: async (input: SpawnInput) => spawn(input),
      trade: async (num: number, side: Side, amount: number, chain: string) =>
        trade(num, side, amount, chain),
      getQuote,
      getMarket,
      claimFees: async (num: number) => claimFees(num),
      justSpawned,
    }),
    [creatures, wallet, connect, spawn, trade, getQuote, getMarket, claimFees, justSpawned],
  )

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
}

export function useStore(): StoreValue {
  const v = useContext(StoreCtx)
  if (!v) throw new Error('useStore must be used inside a store provider')
  return v
}
