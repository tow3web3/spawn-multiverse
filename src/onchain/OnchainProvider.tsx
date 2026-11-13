/**
 * The on-chain store: same StoreValue contract as the sim provider, but every
 * number is read from a real SPAWN! deployment (protocol v7) and every action
 * is a real transaction.
 *
 * Three worlds through one manifest format:
 *  - LOCAL devnet: every logical chain lives on one hardhat node; omnichain
 *    messages deliver synchronously (results parse out of the same receipt).
 *  - PUBLIC TESTNET: the hub is Base Sepolia, each spoke its own network;
 *    play money (a MockUSDC anyone can mint), burner wallets, a gas drip,
 *    and usually sponsored messaging.
 *  - MAINNET: real USDC, the user's own wallet only, user-paid messaging,
 *    guarded by deposit caps and a one-time risk notice.
 *
 * What v7 means here:
 *  - Money is USDC (6 decimals). Each chain's OmniUSD is the USDC vault AND
 *    an 18-decimal claim on it: a wallet's dollars on a chain are USDC +
 *    oUSD. Buys pull USDC through an EXACT approval to the vault (never the
 *    gateway); payouts come back as USDC, or as an oUSD claim when that
 *    chain's vault is short.
 *  - Every gateway call is payable: it must attach the fee its `quote*`
 *    view returns, unless the deployment is sponsored.
 *  - The hub chain has its own gateway (`local`): trades there settle in one
 *    transaction, no cross-chain wait.
 *  - The hub never reverts on a message — it REFUSES (event `Refused`) and
 *    sends value home. Outcomes are read from events, not from reverts.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  formatEther,
  formatUnits,
  getAddress,
  http,
  pad as padHex,
  parseEther,
  parseEventLogs,
  parseUnits,
  type Address,
  type Chain,
  type Log,
  type PublicClient,
} from 'viem'
import { narrowActor } from '../lib/format'
import { hostedImagePath } from '../lib/tokenImage'
import { MAX_META_BYTES, buildMetaURI, utf8Len } from '../lib/tokenMeta'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import {
  StoreCtx,
  deriveCreature,
  type ChainInfo,
  type CreatureMeta,
  type HolderFees,
  type NetworkProfile,
  type SpawnInput,
  type StoreValue,
  type TradeResult,
  type Wallet,
} from '../store'
import {
  emptyFees,
  quote as marketQuote,
  type FeeMode,
  type Market,
  type Side,
  type Trade,
} from '../engine/market'
import {
  FEE_MODE_INDEX,
  OP,
  REFUSAL,
  distributorAbi,
  gatewayAbi,
  padAbi,
  tokenAbi,
  usdAbi,
  usdcAbi,
  type Manifest,
} from './abi'
import type { FaceId } from '../components/Faces'

const FEE_MODE_NAME: readonly FeeMode[] = ['holders', 'split', 'dev', 'burn']
const PALETTE = ['#b5e95b', '#f7a8ce', '#9ccbf5', '#a78bf0', '#f7be7b', '#8be0d4']
/** v5 wire identities are bytes32. Narrow EVM-shaped ones back to their
 * checksummed address so every comparison with wallet addresses keeps
 * working; a wide (Solana) identity stays full-width lowercase. */
const toActor = (b32: string): string => {
  const n = narrowActor(b32)
  return n.length === 42 ? getAddress(n) : n
}
/** Play dollars minted per chain on testnets / the local devnet. */
const MINT_PER_CHAIN = 1337
const ZERO = '0x0000000000000000000000000000000000000000'
/** oUSD has 18 decimals, USDC 6: one USDC unit is SCALE oUSD wei. */
const SCALE = 10n ** 12n
// Hardhat's well-known dev account #0 — funds wallets with gas on the LOCAL
// dev chain only. Never reuse outside a throwaway devnet.
const FUNDER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
// Public RPCs cap eth_getLogs hard (Base Sepolia: 200 blocks per call).
const LOG_CHUNK_LOCAL = 100_000n
const LOG_CHUNK_PUBLIC = 199n
// First load only backfills this many hub blocks of tape (~33h on Base's 2s
// blocks) — keeps page loads fast on capped public RPCs.
const BACKFILL_BLOCKS = 60_000n
const LS_RISK = 'spawn.risk.accepted.v1'
/** Gateway string caps (bytes) — a longer string reverts "GW: string too long".
 * (The metaURI cap, 1024, lives with its builder in lib/tokenMeta.) */
const MAX_NAME_BYTES = 64
const MAX_SYMBOL_BYTES = 16

/** Real names for wallet prompts: a wallet asked to add "spawn-base" over an
 * unknown RPC looks like a phish. */
const KNOWN_CHAINS: Record<number, { name: string; symbol?: string; explorer?: string }> = {
  1: { name: 'Ethereum', explorer: 'https://etherscan.io' },
  10: { name: 'OP Mainnet', explorer: 'https://optimistic.etherscan.io' },
  56: { name: 'BNB Smart Chain', symbol: 'BNB', explorer: 'https://bscscan.com' },
  8453: { name: 'Base', explorer: 'https://basescan.org' },
  42161: { name: 'Arbitrum One', explorer: 'https://arbiscan.io' },
  97: { name: 'BNB Smart Chain Testnet', symbol: 'tBNB', explorer: 'https://testnet.bscscan.com' },
  84532: { name: 'Base Sepolia', explorer: 'https://sepolia.basescan.org' },
  421614: { name: 'Arbitrum Sepolia', explorer: 'https://sepolia.arbiscan.io' },
  11155111: { name: 'Sepolia', explorer: 'https://sepolia.etherscan.io' },
  11155420: { name: 'OP Sepolia', explorer: 'https://sepolia-optimism.etherscan.io' },
  31337: { name: 'Hardhat Local' },
}

const ef = (v: bigint) => Number(formatEther(v))
const e6 = (v: bigint) => Number(formatUnits(v, 6))
const toU6 = (n: number) => parseUnits(n.toFixed(6), 6)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const up = (chainId: string) => chainId.toUpperCase()

interface TokenEntry {
  meta: CreatureMeta
  token: Address
  market: Market
}

/** One user-facing network: its contracts and a client to reach it. */
interface ChainIO {
  id: string
  label: number
  gateway: Address
  usd: Address
  usdc: Address
  /** Holder pool; resolved at boot (manifest, else the gateway). */
  dist: Address | null
  /** Hub chain's own gateway: the pad's events are in the same receipt. */
  local: boolean
  chain: Chain
  client: PublicClient
}

interface ChainState {
  usdc: bigint
  ousd: bigint
  gas: bigint
  liquidity: bigint
  depositCap: bigint
  depositsPaused: boolean
  paused: boolean
  fee: { buy: bigint; sell: bigint; claim: bigint; pull: bigint }
}

const EMPTY_CHAIN: ChainState = {
  usdc: 0n,
  ousd: 0n,
  gas: 0n,
  liquidity: 0n,
  depositCap: 0n,
  depositsPaused: false,
  paused: false,
  fee: { buy: 0n, sell: 0n, claim: 0n, pull: 0n },
}

function mkChain(id: number, rpc: string): Chain {
  const known = KNOWN_CHAINS[id]
  return defineChain({
    id,
    name: known?.name ?? `Chain ${id}`,
    nativeCurrency: { name: known?.symbol ?? 'Ether', symbol: known?.symbol ?? 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: known?.explorer ? { default: { name: 'Explorer', url: known.explorer } } : undefined,
  })
}

async function getLogsChunked(
  client: PublicClient,
  address: Address,
  from: bigint,
  to: bigint,
  chunk: bigint,
) {
  const ranges: [bigint, bigint][] = []
  for (let b = from; b <= to; b += chunk + 1n) {
    ranges.push([b, b + chunk > to ? to : b + chunk])
  }
  const out = []
  const BATCH = 8 // parallel requests per wave — fast backfill, polite to RPCs
  for (let i = 0; i < ranges.length; i += BATCH) {
    const wave = await Promise.all(
      ranges
        .slice(i, i + BATCH)
        .map(([f, t]) => client.getLogs({ address, fromBlock: f, toBlock: t })),
    )
    for (const r of wave) out.push(...r)
  }
  return out
}

function loadBurner(): PrivateKeyAccount {
  let pk = null
  try {
    pk = localStorage.getItem('spawn.burner.pk')
  } catch {
    /* no storage */
  }
  if (!pk) {
    pk = generatePrivateKey()
    try {
      localStorage.setItem('spawn.burner.pk', pk)
    } catch {
      /* no storage */
    }
  }
  return privateKeyToAccount(pk as `0x${string}`)
}

type WalletSource = 'burner' | 'injected'
const LS_SOURCE = 'spawn.wallet.source'

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  on?: (event: string, handler: (...args: unknown[]) => void) => void
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void
}

function injectedProvider(): Eip1193Provider | undefined {
  return (window as { ethereum?: Eip1193Provider }).ethereum
}

/** Puts an injected wallet on `chain`, offering to add it first if the wallet
 * doesn't know it (params come from the manifest's chainId/rpc). */
async function ensureInjectedChain(provider: Eip1193Provider, chain: Chain) {
  const hexId = `0x${chain.id.toString(16)}`
  const current = (await provider.request({ method: 'eth_chainId' }).catch(() => null)) as
    | string
    | null
  if (current && parseInt(current, 16) === chain.id) return
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] })
  } catch (e) {
    const code = (e as { code?: number }).code
    if (code !== 4902 && !/4902|unrecognized|not been added/i.test(String((e as Error).message ?? e)))
      throw e
    const explorer = chain.blockExplorers?.default.url
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hexId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
          ...(explorer ? { blockExplorerUrls: [explorer] } : {}),
        },
      ],
    })
    // some wallets add the chain without switching to it
    await provider
      .request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] })
      .catch(() => undefined)
  }
}

/** The per-browser trade ledger of one wallet: dollars paid per creature
 * (`cost`) and the tokens those dollars bought, net of sells (`held`). PnL is
 * only shown for a bag this ledger fully accounts for. */
function loadLedger(kind: 'cost' | 'held', addr: string): Record<number, number> {
  try {
    return JSON.parse(localStorage.getItem(`spawn.${kind}.${addr.toLowerCase()}`) ?? '{}')
  } catch {
    return {}
  }
}

function parseMetaURI(uri: string): {
  face?: FaceId
  image?: string
  links?: CreatureMeta['links']
  feeMode?: CreatureMeta['feeMode']
} {
  try {
    return JSON.parse(uri)
  } catch {
    return {}
  }
}

/** A short, human reason out of a viem / wallet error. */
function reasonOf(e: unknown): string {
  const any = e as { shortMessage?: string; message?: string; code?: number; cause?: { code?: number } }
  if (any?.code === 4001 || any?.cause?.code === 4001) return 'Rejected in the wallet.'
  const msg = String(any?.shortMessage ?? any?.message ?? 'Transaction failed.')
  if (/GW: paused/.test(msg)) return 'Buys and launches are paused on this chain — sells stay open.'
  if (/deposit cap/.test(msg)) return "This chain's deposit cap is full — try a smaller amount or another chain."
  if (/deposits paused/.test(msg)) return 'Deposits are paused on this chain.'
  if (/GW: unknown token/.test(msg)) return 'This token has not reached this chain yet — give it a minute.'
  if (/LZM: fee|LOM: fee/.test(msg)) return 'The network fee moved — try again.'
  if (/vault short/.test(msg)) return "This chain's vault is short of USDC right now — your claim stays valid."
  if (/insufficient funds/i.test(msg)) return 'Not enough gas in the wallet for this transaction.'
  if (/User rejected|denied/i.test(msg)) return 'Rejected in the wallet.'
  return msg.split('\n')[0].slice(0, 140)
}

/** What the hub did with one message, read from its events. */
type HubOutcome =
  | { kind: 'trade'; usd: number; tokens: number; price: number; ascended: boolean; guardRefund: number }
  | { kind: 'bounced'; refunded: number }
  | { kind: 'refused'; reason: number }
  | { kind: 'claimed'; amount: number }

type Want = 'buy' | 'sell' | 'claim'

/** Finds the hub's verdict on `actor`'s message about `token`, sent from the
 * chain labelled `label`, in a set of pad logs (one receipt on a local chain,
 * a block range on a remote one). The chain is part of the match: the same
 * wallet may have just traded the same token from another chain. */
function readOutcome(
  logs: Log[],
  token: Address,
  actor: Address,
  want: Want,
  label: number,
): HubOutcome | null {
  const events = parseEventLogs({ abi: padAbi, logs })
  const tok = token.toLowerCase()
  const who = actor.toLowerCase()
  const mine = (b32: unknown) => narrowActor(String(b32)) === who
  const same = (t: unknown) => String(t).toLowerCase() === tok

  if (want === 'claim') {
    const done = events.find((e) => e.eventName === 'DevClaimed' && same(e.args.token) && mine(e.args.dev))
    if (done && done.eventName === 'DevClaimed') return { kind: 'claimed', amount: ef(done.args.amount) }
    const no = events.find(
      (e) =>
        e.eventName === 'Refused' &&
        Number(e.args.op) === OP.CLAIM &&
        Number(e.args.srcChain) === label &&
        mine(e.args.actor),
    )
    if (no && no.eventName === 'Refused') return { kind: 'refused', reason: Number(no.args.reason) }
    return null
  }

  const isBuy = want === 'buy'
  const trade = events.find(
    (e) =>
      e.eventName === 'Trade' &&
      same(e.args.token) &&
      Number(e.args.chain) === label &&
      mine(e.args.trader) &&
      e.args.isBuy === isBuy,
  )
  const guard = isBuy
    ? events.find((e) => e.eventName === 'GenesisGuard' && same(e.args.token) && mine(e.args.actor))
    : undefined
  const guardRefund = guard && guard.eventName === 'GenesisGuard' ? ef(guard.args.refundedUsd) : 0
  if (trade && trade.eventName === 'Trade') {
    return {
      kind: 'trade',
      usd: ef(trade.args.usd),
      tokens: ef(trade.args.tokens),
      price: ef(trade.args.priceAfter),
      ascended: events.some((e) => e.eventName === 'Ascended' && same(e.args.token)),
      guardRefund,
    }
  }
  const no = events.find(
    (e) =>
      e.eventName === 'Refused' &&
      Number(e.args.op) === (isBuy ? OP.BUY : OP.SELL) &&
      Number(e.args.srcChain) === label &&
      mine(e.args.actor) &&
      narrowActor(String(e.args.token)) === tok,
  )
  if (no && no.eventName === 'Refused') return { kind: 'refused', reason: Number(no.args.reason) }
  // a buy the genesis guard turned away whole leaves no Trade, only the guard
  if (guard) return { kind: 'bounced', refunded: guardRefund }
  return null
}

export function OnchainProvider({
  children,
  manifestUrl = '/onchain/deployment.json',
}: {
  children: React.ReactNode
  manifestUrl?: string
}) {
  const [status, setStatus] = useState<'connecting' | 'ready' | 'offline'>('connecting')
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [justSpawned, setJustSpawned] = useState<number | null>(null)
  const [version, bump] = useReducer((x: number) => x + 1, 0)
  const [network, setNetwork] = useState<NetworkProfile>('local')
  const [sponsored, setSponsored] = useState(false)
  const [hubPaused, setHubPaused] = useState(false)
  const [riskAccepted, setRiskAccepted] = useState(() => {
    try {
      return localStorage.getItem(LS_RISK) === '1'
    } catch {
      return false
    }
  })
  const [riskOpen, setRiskOpen] = useState(false)
  /** The chains this deployment runs. Remembered per manifest so a return
   * visit never flashes the full six-chain design before the manifest
   * loads — the copy must only name what is live. */
  const [chainIds, setChainIds] = useState<string[] | undefined>(() => {
    try {
      const raw = localStorage.getItem(`spawn.chains.${manifestUrl}`)
      const ids = raw ? (JSON.parse(raw) as unknown) : undefined
      return Array.isArray(ids) && ids.every((x) => typeof x === 'string') ? (ids as string[]) : undefined
    } catch {
      return undefined
    }
  })

  const manifestRef = useRef<Manifest | null>(null)
  const hubClientRef = useRef<PublicClient | null>(null)
  const hubChainRef = useRef<Chain | null>(null)
  const iosRef = useRef<ChainIO[]>([])
  /** The hub is a hardhat node: gas comes from its dev account, logs are
   * cheap to scan, blocks only move when someone transacts. */
  const isLocalRef = useRef(true)
  /** deploy-local's world: every chain on ONE node behind the simulated
   * transport, so a message and its replies land in the sender's own
   * receipt. (A manifest that names its `network` is a real, asynchronous
   * topology even when it is rehearsed on a hardhat node.) */
  const syncRef = useRef(true)
  const networkRef = useRef<NetworkProfile>('local')
  const sponsoredRef = useRef(false)
  const hubPausedRef = useRef(false)
  const riskRef = useRef(riskAccepted)
  const burnerRef = useRef<PrivateKeyAccount | null>(null)
  const entriesRef = useRef<Map<number, TokenEntry>>(new Map())
  const replicaCache = useRef<Map<string, Address>>(new Map())
  const chainStateRef = useRef<Record<string, ChainState>>({})
  const tokensByChainRef = useRef<Map<number, Record<string, bigint>>>(new Map())
  /** Claimable holder rewards: creature num -> chain id -> oUSD wei. */
  const rewardsByChainRef = useRef<Map<number, Record<string, bigint>>>(new Map())
  const rewardsRef = useRef<Record<number, number>>({})
  const holderFeesRef = useRef<Record<number, HolderFees>>({})
  const parkedRef = useRef<Record<number, Record<string, number>>>({})
  /** v6 FAIR GENESIS: creature num -> live window state for the connected wallet. */
  const fairGenesisRef = useRef<Record<number, { endsAt: number; spentUsd: number; capUsd: number }>>({})
  const lastBlockRef = useRef(0n)
  /** Chain clock minus browser clock, measured once at boot. Every on-chain
   * timestamp is shifted onto the browser's clock as it is read, so the UI
   * can keep comparing against Date.now() — a visitor's wrong clock (or a
   * time-travelled devnet) must not bend a FAIR GENESIS countdown. */
  const skewRef = useRef(0)
  const connectedRef = useRef(false)
  const costsRef = useRef<Record<number, number>>({})
  const heldRef = useRef<Record<number, number>>({})
  /** Loads the trade ledger of the wallet that just became active. */
  const rekey = (addr: string) => {
    costsRef.current = loadLedger('cost', addr)
    heldRef.current = loadLedger('held', addr)
  }
  const sourceRef = useRef<WalletSource>('burner')
  const injectedRef = useRef<Address | null>(null)
  const [walletSource, setWalletSource] = useState<WalletSource>('burner')

  const io = (chainId: string) => iosRef.current.find((c) => c.id === chainId)
  const stateOf = (chainId: string): ChainState => chainStateRef.current[chainId] ?? EMPTY_CHAIN
  /** A chain timestamp (seconds) as browser-clock milliseconds. */
  const at = (chainSeconds: bigint | number) => Number(chainSeconds) * 1000 - skewRef.current
  /** Address of whichever signer is active (burner or injected wallet). */
  const activeAddr = (): Address | null =>
    sourceRef.current === 'injected' ? injectedRef.current : (burnerRef.current?.address ?? null)
  /** Account value passed to viem tx calls (an Address for injected wallets). */
  const activeAccount = () =>
    sourceRef.current === 'injected' ? injectedRef.current! : burnerRef.current!
  /** Wallet client for the active signer on chain `c`. The burner signs over
   * plain RPC; an injected wallet is switched to the target chain first. */
  const wcFor = async (c: ChainIO) => {
    if (sourceRef.current === 'injected') {
      const provider = injectedProvider()
      if (!provider || !injectedRef.current) throw new Error('Injected wallet unavailable.')
      await ensureInjectedChain(provider, c.chain)
      return createWalletClient({
        account: injectedRef.current,
        chain: c.chain,
        transport: custom(provider),
      })
    }
    return createWalletClient({
      account: burnerRef.current!,
      chain: c.chain,
      transport: http(c.chain.rpcUrls.default.http[0]),
    })
  }

  /** Signs, sends and waits for one contract call on chain `c`. */
  const write = async (
    c: ChainIO,
    req: { address: Address; abi: unknown; functionName: string; args?: readonly unknown[]; value?: bigint },
  ) => {
    const wc = await wcFor(c)
    const hash = await (wc.writeContract as unknown as (a: unknown) => Promise<`0x${string}`>)({
      ...req,
      chain: c.chain,
      account: activeAccount(),
    })
    const receipt = await c.client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error('The transaction reverted.')
    return receipt
  }

  const read = <T,>(
    client: PublicClient,
    req: { address: Address; abi: unknown; functionName: string; args?: readonly unknown[] },
  ) => client.readContract(req as never) as Promise<T>

  /** The fee a gateway action must attach. A real LayerZero quote moves
   * with gas prices between quoting and mining, so it gets 10% of headroom
   * (the surplus stays in the protocol's tank — it is not refunded); a
   * same-chain quote is exact. */
  const feeFor = async (
    c: ChainIO,
    fn: 'quoteBuy' | 'quoteSell' | 'quoteClaim' | 'quotePull' | 'quoteSpawn',
    args?: readonly unknown[],
  ): Promise<bigint> => {
    if (sponsoredRef.current) return 0n
    const q = await read<bigint>(c.client, { address: c.gateway, abi: gatewayAbi, functionName: fn, args })
    return syncRef.current || c.local ? q : (q * 110n) / 100n
  }

  /** True when a transaction may go ahead. On mainnet the one-time risk
   * notice comes first: an unaccepted notice opens it and blocks the action. */
  const cleared = () => {
    if (networkRef.current !== 'mainnet' || riskRef.current) return true
    setRiskOpen(true)
    return false
  }

  const saveCosts = () => {
    const addr = activeAddr()
    if (!addr) return
    try {
      const key = addr.toLowerCase()
      localStorage.setItem(`spawn.cost.${key}`, JSON.stringify(costsRef.current))
      localStorage.setItem(`spawn.held.${key}`, JSON.stringify(heldRef.current))
    } catch {
      /* no storage */
    }
  }

  const replicaAddr = useCallback(async (chainId: string, token: Address): Promise<Address> => {
    const key = `${chainId}:${token}`
    const cached = replicaCache.current.get(key)
    if (cached) return cached
    const c = io(chainId)
    if (!c) return ZERO
    const addr = await read<Address>(c.client, {
      address: c.gateway,
      abi: gatewayAbi,
      functionName: 'replicaOf',
      args: [token],
    })
    if (addr !== ZERO) replicaCache.current.set(key, addr)
    return addr
  }, [])

  const poll = useCallback(async () => {
    const hub = hubClientRef.current
    const m = manifestRef.current
    if (!hub || !m) return

    // 1. token roster + curve state + fees (hub) — one batched round trip
    const len = Number(
      await hub.readContract({ address: m.pad, abi: padAbi, functionName: 'tokensLength' }),
    )
    const rows = await Promise.all(
      Array.from({ length: len }, (_, i) =>
        hub.readContract({ address: m.pad, abi: padAbi, functionName: 'getToken', args: [BigInt(i)] }),
      ),
    )
    const feeRows = await Promise.all(
      rows.map((r) =>
        hub.readContract({ address: m.pad, abi: padAbi, functionName: 'feesOf', args: [r[0]] }),
      ),
    )
    for (let i = 0; i < len; i++) {
      const num = i + 1
      const [token, name, symbol, metaURI, creator, spawnedAt, , vBase, vTokens, sold, ascended] = rows[i]

      let entry = entriesRef.current.get(num)
      if (!entry) {
        const parsed = parseMetaURI(metaURI)
        // The image is hosted by the site (`/img/<sha256>`), and the metaURI
        // carries only that path. Chain data is hostile until proven
        // otherwise: anything that is not exactly such a path on THIS origin
        // is dropped, never loaded. A launch made where hosting was not
        // available falls back to the creator's own browser copy.
        let image = hostedImagePath(parsed.image)
        if (!image) {
          try {
            image = localStorage.getItem(`spawn.img.${token.toLowerCase()}`) ?? undefined
          } catch {
            /* no storage */
          }
        }
        entry = {
          token,
          meta: {
            num,
            name,
            ticker: symbol,
            face: parsed.face,
            image,
            links: parsed.links,
            color: PALETTE[(num - 1) % PALETTE.length],
            spawnedAt: at(spawnedAt),
            // every on-chain token was launched by someone; `creator` gates
            // the dev dashboard to the launches of the connected wallet
            custom: true,
            creator: toActor(creator),
            feeMode: parsed.feeMode,
          },
          market: {
            state: { phase: 'curve', vBase: 0, vTokens: 1, sold: 0 },
            trades: [],
            history: [{ ts: at(spawnedAt), price: 6000 / 1.073e9 }],
            volume: 0,
            chainTokens: {},
            balances: new Map(),
            fees: emptyFees(parsed.feeMode ?? 'holders'),
            spawnTs: at(spawnedAt),
            genesisSpent: new Map(),
          },
        }
        entriesRef.current.set(num, entry)
      }
      entry.market.state = {
        phase: ascended ? 'pool' : 'curve',
        vBase: ef(vBase),
        vTokens: ef(vTokens),
        sold: ef(sold),
      }

      const [fm, fTotal, fHolders, fDev, fDevClaimed, fBurnPot, fBurnedUsd, fBurnedTokens, fHoldersPaid] =
        feeRows[i]
      const feeMode = FEE_MODE_NAME[fm] ?? 'holders'
      entry.meta.feeMode = feeMode
      entry.market.fees = {
        mode: feeMode,
        total: ef(fTotal),
        holders: ef(fHolders),
        dev: ef(fDev),
        devClaimed: ef(fDevClaimed),
        burnPot: ef(fBurnPot),
        burnedUsd: ef(fBurnedUsd),
        burnedTokens: ef(fBurnedTokens),
        holdersPaid: ef(fHoldersPaid),
      }
    }

    // the roster is enough to render the pit — don't make the UI wait for
    // the (possibly long) first log backfill below
    bump()

    // 2. event tape -> history, volume, holders, chain allocation (hub).
    //    No block-number cache: a poll right after a trade must see its block.
    const latest = await hub.getBlockNumber({ cacheTime: 0 })
    if (latest >= lastBlockRef.current) {
      const logs = await getLogsChunked(
        hub,
        m.pad,
        lastBlockRef.current,
        latest,
        isLocalRef.current ? LOG_CHUNK_LOCAL : LOG_CHUNK_PUBLIC,
      )
      lastBlockRef.current = latest + 1n
      const parsed = parseEventLogs({ abi: padAbi, logs })
      const byToken = new Map<string, TokenEntry>()
      for (const e of entriesRef.current.values()) byToken.set(e.token.toLowerCase(), e)

      for (const log of parsed) {
        if (log.eventName === 'Trade') {
          const a = log.args
          const entry = byToken.get((a.token as string).toLowerCase())
          if (!entry) continue
          const chainId = m.chains.find((c) => c.label === Number(a.chain))?.id ?? 'hub'
          const trade: Trade = {
            id: Number(log.blockNumber) * 1000 + Number(log.logIndex ?? 0),
            ts: at(a.ts),
            side: a.isBuy ? 'buy' : 'sell',
            chain: chainId,
            usd: ef(a.usd as bigint),
            tokens: ef(a.tokens as bigint),
            price: ef(a.priceAfter as bigint),
            trader: toActor(a.trader as string).toLowerCase(),
          }
          const mk = entry.market
          mk.trades.unshift(trade)
          if (mk.trades.length > 30) mk.trades.length = 30
          mk.history.push({ ts: trade.ts, price: trade.price })
          if (mk.history.length > 600) mk.history.splice(0, mk.history.length - 500)
          mk.volume += trade.usd
          mk.chainTokens[chainId] = Math.max(
            0,
            (mk.chainTokens[chainId] ?? 0) + (trade.side === 'buy' ? trade.tokens : -trade.tokens),
          )
          const held = mk.balances.get(trade.trader) ?? 0
          mk.balances.set(
            trade.trader,
            Math.max(0, held + (trade.side === 'buy' ? trade.tokens : -trade.tokens)),
          )
        } else if (log.eventName === 'Ascended') {
          const entry = byToken.get((log.args.token as string).toLowerCase())
          if (entry) entry.market.ascendedAt = at(log.args.ts)
        }
      }
    }

    // 3. per-chain health: vault, pause switches, messaging fees. Each
    //    chain's reads leave together so the RPC batches them.
    const addr = connectedRef.current ? activeAddr() : null
    const wantFees = !sponsoredRef.current
    const padPaused = await hub
      .readContract({ address: m.pad, abi: padAbi, functionName: 'paused' })
      .catch(() => hubPausedRef.current)
    if (padPaused !== hubPausedRef.current) {
      hubPausedRef.current = padPaused
      setHubPaused(padPaused)
    }
    const nextState: Record<string, ChainState> = {}
    await Promise.all(
      iosRef.current.map(async (c) => {
        const prev = stateOf(c.id)
        try {
          const g = (fn: string) => read<bigint>(c.client, { address: c.gateway, abi: gatewayAbi, functionName: fn })
          const [liquidity, depositCap, depositsPaused, paused, fb, fs, fc, fp, usdc, ousd, gas] =
            await Promise.all([
              read<bigint>(c.client, { address: c.usd, abi: usdAbi, functionName: 'liquidity' }),
              read<bigint>(c.client, { address: c.usd, abi: usdAbi, functionName: 'depositCap' }),
              read<boolean>(c.client, { address: c.usd, abi: usdAbi, functionName: 'depositsPaused' }),
              read<boolean>(c.client, { address: c.gateway, abi: gatewayAbi, functionName: 'paused' }),
              wantFees ? g('quoteBuy') : 0n,
              wantFees ? g('quoteSell') : 0n,
              wantFees ? g('quoteClaim') : 0n,
              wantFees ? g('quotePull') : 0n,
              addr
                ? read<bigint>(c.client, { address: c.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [addr] })
                : 0n,
              addr
                ? read<bigint>(c.client, { address: c.usd, abi: usdAbi, functionName: 'balanceOf', args: [addr] })
                : 0n,
              addr ? c.client.getBalance({ address: addr }) : 0n,
            ])
          nextState[c.id] = {
            usdc,
            ousd,
            gas,
            liquidity,
            depositCap,
            depositsPaused,
            paused,
            fee: { buy: fb, sell: fs, claim: fc, pull: fp },
          }
        } catch {
          // chain briefly unreachable — keep what we knew
          nextState[c.id] = prev
        }
      }),
    )
    chainStateRef.current = nextState

    // 4. the wallet's bags, holder rewards, parked deliveries
    if (addr) {
      const entries = [...entriesRef.current.entries()]
      // make sure every replica address is known (cached after the first hit)
      await Promise.all(
        entries.flatMap(([, entry]) =>
          iosRef.current.map((c) => replicaAddr(c.id, entry.token).catch(() => ZERO as Address)),
        ),
      )

      const positions: Wallet['positions'] = {}
      const rewards: Record<number, number> = {}
      const holderFees: Record<number, HolderFees> = {}
      const parked: Record<number, Record<string, number>> = {}

      await Promise.all(
        entries.map(async ([num, entry]) => {
          const perChain: Record<string, bigint> = {}
          const rewardPerChain: Record<string, bigint> = {}
          const fees: HolderFees = { claimable: {}, waiting: {} }
          const holdersMode = entry.market.fees.mode === 'holders' || entry.market.fees.mode === 'split'
          await Promise.all(
            iosRef.current.map(async (c) => {
              try {
                const rep = replicaCache.current.get(`${c.id}:${entry.token}`)
                // a delivery can be parked before the replica even exists
                const parkedP = read<bigint>(c.client, {
                  address: c.gateway,
                  abi: gatewayAbi,
                  functionName: 'pendingDelivery',
                  args: [entry.token, addr],
                })
                if (!rep) {
                  const p = await parkedP
                  if (p > 0n) (parked[num] ??= {})[c.id] = ef(p)
                  return
                }
                const [bal, w, p] = await Promise.all([
                  read<bigint>(c.client, { address: rep, abi: tokenAbi, functionName: 'balanceOf', args: [addr] }),
                  c.dist
                    ? read<bigint>(c.client, {
                        address: c.dist,
                        abi: distributorAbi,
                        functionName: 'withdrawable',
                        args: [rep, addr],
                      })
                    : 0n,
                  parkedP,
                ])
                perChain[c.id] = bal
                if (w > 0n) {
                  rewardPerChain[c.id] = w
                  fees.claimable[c.id] = ef(w)
                }
                if (p > 0n) (parked[num] ??= {})[c.id] = ef(p)
                // a remote chain's slice of the holder pot waits on the hub
                // until someone there pulls it — worth showing to holders
                if (holdersMode && !c.local && bal > 0n) {
                  const pot = await hub.readContract({
                    address: m.pad,
                    abi: padAbi,
                    functionName: 'pendingDrop',
                    args: [entry.token, c.label],
                  })
                  if (pot > 0n) {
                    const supply = await read<bigint>(c.client, {
                      address: rep,
                      abi: tokenAbi,
                      functionName: 'totalSupply',
                    })
                    fees.waiting[c.id] = {
                      pot: ef(pot),
                      share: supply > 0n ? ef((pot * bal) / supply) : 0,
                    }
                  }
                }
              } catch {
                /* chain briefly unreachable — keep going */
              }
            }),
          )
          tokensByChainRef.current.set(num, perChain)
          rewardsByChainRef.current.set(num, rewardPerChain)
          const sum = Object.values(perChain).reduce((a, b) => a + b, 0n)
          const unclaimed = Object.values(rewardPerChain).reduce((a, b) => a + b, 0n)
          if (unclaimed > 0n) rewards[num] = ef(unclaimed)
          if (unclaimed > 0n || Object.keys(fees.waiting).length) holderFees[num] = fees
          if (sum > 0n) {
            const tokens = ef(sum)
            const held = heldRef.current[num] ?? 0
            positions[num] = {
              tokens,
              cost: costsRef.current[num] ?? 0,
              // PnL needs the cost of the WHOLE bag: only when this browser's
              // ledger accounts for (within 1% of) every token held
              costKnown: Math.abs(tokens - held) <= Math.max(1, tokens * 0.01),
            }
          }
        }),
      )
      rewardsRef.current = rewards
      holderFeesRef.current = holderFees
      parkedRef.current = parked

      // FAIR GENESIS window state, for tokens still inside (or near) their
      // window — one cheap hub read each, skipped once closed
      const fg: Record<number, { endsAt: number; spentUsd: number; capUsd: number }> = {}
      await Promise.all(
        entries.map(async ([num, entry]) => {
          if (Date.now() > entry.meta.spawnedAt + 660_000) return
          try {
            const [endsAt, , spentUsd, capUsd] = await hub.readContract({
              address: m.pad,
              abi: padAbi,
              functionName: 'fairGenesisOf',
              args: [entry.token, padHex(addr, { size: 32 })],
            })
            fg[num] = { endsAt: at(endsAt), spentUsd: ef(spentUsd), capUsd: ef(capUsd) }
          } catch {
            /* transient */
          }
        }),
      )
      fairGenesisRef.current = fg

      const total = Object.values(nextState).reduce((a, s) => a + s.usdc * SCALE + s.ousd, 0n)
      setWallet({ address: addr, balance: ef(total), positions })
    }

    bump()
  }, [replicaAddr])

  // boot: fetch manifest, build one client per network, start polling
  useEffect(() => {
    let timer: number | undefined
    let stopped = false
    ;(async () => {
      try {
        const res = await fetch(manifestUrl, { cache: 'no-store' })
        if (!res.ok) throw new Error('no manifest')
        const manifest = (await res.json()) as Manifest
        if (!manifest?.pad || !Array.isArray(manifest.chains)) throw new Error('bad manifest')
        if (manifest.chains.some((c) => !c.usdc))
          throw new Error('pre-v7 deployment manifest (no USDC) — redeploy or wait for the v7 rollout')
        manifestRef.current = manifest
        const ids = manifest.chains.map((c) => c.id)
        setChainIds(ids)
        try {
          localStorage.setItem(`spawn.chains.${manifestUrl}`, JSON.stringify(ids))
        } catch {
          /* no storage */
        }
        isLocalRef.current = manifest.chainId === 31337
        syncRef.current = isLocalRef.current && !manifest.network
        const profile: NetworkProfile =
          manifest.network === 'mainnet'
            ? 'mainnet'
            : manifest.network === 'testnet' || !isLocalRef.current
              ? 'testnet'
              : 'local'
        networkRef.current = profile
        sponsoredRef.current = manifest.sponsored === true
        setNetwork(profile)
        setSponsored(sponsoredRef.current)

        const hubChain = mkChain(manifest.chainId, manifest.rpc)
        hubChainRef.current = hubChain
        const hub = createPublicClient({ chain: hubChain, transport: http(manifest.rpc, { batch: true }) })
        await hub.getChainId()
        hubClientRef.current = hub
        // the chain's clock vs this browser's, once (see skewRef). The
        // pending block carries the time the NEXT block will have — on a
        // quiet devnet the latest block can be arbitrarily old.
        try {
          const head = await hub
            .getBlock({ blockTag: 'pending' })
            .catch(() => hub.getBlock({ blockTag: 'latest' }))
          const skew = Number(head.timestamp) * 1000 - Date.now()
          skewRef.current = Math.abs(skew) < 15_000 ? 0 : skew
        } catch {
          skewRef.current = 0
        }
        lastBlockRef.current = BigInt(manifest.fromBlock ?? 0)
        if (!isLocalRef.current) {
          const tip = await hub.getBlockNumber()
          const floor = tip > BACKFILL_BLOCKS ? tip - BACKFILL_BLOCKS : 0n
          if (floor > lastBlockRef.current) lastBlockRef.current = floor
        }

        iosRef.current = await Promise.all(
          manifest.chains.map(async (c) => {
            const chainId = c.chainId ?? manifest.chainId
            const rpc = c.rpc ?? manifest.rpc
            const sameAsHub = chainId === manifest.chainId && rpc === manifest.rpc
            const chain = sameAsHub ? hubChain : mkChain(chainId, rpc)
            const client = sameAsHub
              ? hub
              : createPublicClient({ chain, transport: http(rpc, { batch: true }) })
            let dist: Address | null = c.dist ?? null
            if (!dist) {
              try {
                const d = await read<Address>(client, {
                  address: c.gateway,
                  abi: gatewayAbi,
                  functionName: 'distributor',
                })
                dist = d === ZERO ? null : d
              } catch {
                dist = null
              }
            }
            return {
              id: c.id,
              label: c.label,
              gateway: c.gateway,
              usd: c.usd,
              usdc: c.usdc!,
              dist,
              // on the one-node devnet every chain is "local" in effect; the
              // flag only marks the hub chain's own gateway on real networks
              local: c.local === true,
              chain,
              client,
            }
          }),
        )

        if (profile !== 'mainnet') {
          // burner wallets hold play money only — never created on mainnet
          burnerRef.current = loadBurner()
          rekey(burnerRef.current.address)
          // if this burner has gas anywhere, resume it silently
          for (const c of iosRef.current) {
            const eth = await c.client.getBalance({ address: burnerRef.current.address }).catch(() => 0n)
            if (eth > 0n) {
              connectedRef.current = true
              break
            }
          }
        }
        // if an injected wallet was connected last time and is still
        // authorized for this site, resume it silently (no popup)
        try {
          if (localStorage.getItem(LS_SOURCE) === 'injected') {
            const provider = injectedProvider()
            const accounts = provider
              ? ((await provider.request({ method: 'eth_accounts' })) as string[])
              : []
            if (accounts?.[0]) {
              injectedRef.current = getAddress(accounts[0])
              sourceRef.current = 'injected'
              setWalletSource('injected')
              rekey(accounts[0])
              connectedRef.current = true
            }
          }
        } catch {
          /* wallet locked or gone — stay disconnected */
        }
        if (stopped) return
        setStatus('ready')
        await poll()
        const every = isLocalRef.current ? 2500 : 8000
        timer = window.setInterval(() => void poll().catch(() => undefined), every)
      } catch (e) {
        console.error('onchain boot failed:', e)
        if (!stopped) setStatus('offline')
      }
    })()
    return () => {
      stopped = true
      if (timer) window.clearInterval(timer)
    }
  }, [poll, manifestUrl])

  // follow the injected wallet: an account switch re-keys the session,
  // a lock/disconnect in the wallet falls back to the disconnected state
  useEffect(() => {
    const provider = injectedProvider()
    if (!provider?.on) return
    const onAccounts = (...args: unknown[]) => {
      if (sourceRef.current !== 'injected') return
      const accounts = (args[0] as string[]) ?? []
      if (!accounts[0]) {
        injectedRef.current = null
        sourceRef.current = 'burner'
        connectedRef.current = false
        setWalletSource('burner')
        setWallet(null)
        try {
          localStorage.removeItem(LS_SOURCE)
        } catch {
          /* no storage */
        }
      } else {
        injectedRef.current = getAddress(accounts[0])
        rekey(accounts[0])
        void poll().catch(() => undefined)
      }
    }
    const onChain = () => void poll().catch(() => undefined)
    provider.on('accountsChanged', onAccounts)
    provider.on('chainChanged', onChain)
    return () => {
      provider.removeListener?.('accountsChanged', onAccounts)
      provider.removeListener?.('chainChanged', onChain)
    }
  }, [poll])

  /** Mints play USDC on every chain where the active wallet can pay for gas.
   * Testnets and the local devnet only — on mainnet USDC is Circle's.
   * `onlyIfLow` skips chains where the wallet already holds some. */
  const mintUsdc = useCallback(
    async (onlyIfLow = false) => {
      const addr = activeAddr()
      if (!addr) throw new Error('chain offline')
      if (networkRef.current === 'mainnet') throw new Error('There is no faucet on mainnet.')
      let done = 0
      for (const c of iosRef.current) {
        try {
          const gas = await c.client.getBalance({ address: addr })
          if (gas === 0n) continue
          if (onlyIfLow) {
            const have = await read<bigint>(c.client, {
              address: c.usdc,
              abi: usdcAbi,
              functionName: 'balanceOf',
              args: [addr],
            })
            if (have >= toU6(50)) {
              done++
              continue
            }
          }
          await write(c, {
            address: c.usdc,
            abi: usdcAbi,
            functionName: 'mint',
            args: [addr, toU6(MINT_PER_CHAIN)],
          })
          done++
        } catch {
          /* chain unreachable or rejected — keep going */
        }
      }
      await poll()
      if (done === 0) throw new Error('no gas on any chain — the wallet needs testnet ETH first')
    },
    [poll],
  )
  const airdrop = useCallback(() => mintUsdc(false), [mintUsdc])

  const connect = useCallback(async (source?: WalletSource): Promise<Wallet> => {
    const m = manifestRef.current
    if (!m) throw new Error('chain offline')
    const mainnet = networkRef.current === 'mainnet'

    // no explicit choice → resume whatever source was used last time
    let src: WalletSource = source ?? (mainnet ? 'injected' : 'burner')
    if (!source && !mainnet) {
      try {
        if (localStorage.getItem(LS_SOURCE) === 'injected' && injectedProvider()) src = 'injected'
      } catch {
        /* no storage */
      }
    }
    if (mainnet && src !== 'injected')
      throw new Error('Mainnet runs on your own wallet — burner wallets are testnet-only.')
    if (src === 'injected') {
      const provider = injectedProvider()
      if (!provider)
        throw new Error(
          mainnet
            ? 'No wallet extension found — install MetaMask (or another wallet) to use mainnet.'
            : 'No wallet extension found — use the burner instead.',
        )
      let accounts: string[] = []
      try {
        accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
      } catch (e) {
        throw new Error(
          (e as { code?: number }).code === 4001
            ? 'Connection request rejected in the wallet.'
            : 'Wallet connection failed.',
        )
      }
      if (!accounts?.[0]) throw new Error('The wallet returned no account.')
      injectedRef.current = getAddress(accounts[0])
      sourceRef.current = 'injected'
      setWalletSource('injected')
    } else {
      if (!burnerRef.current) throw new Error('chain offline')
      sourceRef.current = 'burner'
      injectedRef.current = null
      setWalletSource('burner')
    }
    try {
      if (src === 'injected') localStorage.setItem(LS_SOURCE, 'injected')
      else localStorage.removeItem(LS_SOURCE)
    } catch {
      /* no storage */
    }
    const who = activeAddr()!
    rekey(who)

    if (isLocalRef.current && !mainnet) {
      // local devnet: gas comes from hardhat's dev faucet account
      const hub = hubClientRef.current!
      const eth = await hub.getBalance({ address: who })
      if (eth < parseEther('1')) {
        const funder = privateKeyToAccount(FUNDER_PK)
        const funderClient = createWalletClient({
          account: funder,
          chain: hubChainRef.current!,
          transport: http(m.rpc),
        })
        const hash = await funderClient.sendTransaction({
          to: who,
          value: parseEther('100'),
          chain: hubChainRef.current!,
          account: funder,
        })
        await hub.waitForTransactionReceipt({ hash })
      }
    } else if (!mainnet && m.gasDrip) {
      // public testnet: ask the gas drip to wet new wallets
      try {
        await fetch(m.gasDrip, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: who }),
        })
        await sleep(4000)
      } catch {
        /* drip offline — the user can still fund the wallet by hand */
      }
    }

    connectedRef.current = true
    if (mainnet) {
      await poll()
    } else {
      try {
        // first visit: a starting stack of play USDC on every chain
        await mintUsdc(true)
      } catch {
        /* no gas yet — connected with an empty wallet; UI shows the state */
      }
    }
    const total = Object.values(chainStateRef.current).reduce((a, s) => a + s.usdc * SCALE + s.ousd, 0n)
    return { address: who, balance: ef(total), positions: wallet?.positions ?? {} }
  }, [mintUsdc, poll, wallet])

  /** Back to the disconnected state. The burner key stays in storage, so
   * reconnecting as burner later resumes the same address and bags. */
  const disconnect = useCallback(() => {
    sourceRef.current = 'burner'
    injectedRef.current = null
    connectedRef.current = false
    setWalletSource('burner')
    setWallet(null)
    try {
      localStorage.removeItem(LS_SOURCE)
    } catch {
      /* no storage */
    }
  }, [])

  /** Remote chains: wait for the hub to rule on this actor's message. */
  const waitHub = useCallback(
    async (
      token: Address,
      actor: Address,
      want: Want,
      label: number,
      fromBlock: bigint,
      timeoutMs: number,
    ) => {
      const hub = hubClientRef.current!
      const m = manifestRef.current!
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        try {
          const latest = await hub.getBlockNumber({ cacheTime: 0 })
          if (latest >= fromBlock) {
            const logs = await getLogsChunked(
              hub,
              m.pad,
              fromBlock,
              latest,
              isLocalRef.current ? LOG_CHUNK_LOCAL : LOG_CHUNK_PUBLIC,
            )
            const got = readOutcome(logs, token, actor, want, label)
            if (got) return got
          }
        } catch {
          /* transient RPC hiccup */
        }
        await sleep(isLocalRef.current ? 1500 : 6000)
      }
      return null
    },
    [],
  )

  /** Makes sure the vault may pull exactly `usdc6` from the wallet. The
   * approval goes to the OmniUSD vault (it is what moves the USDC), and it
   * is exact: the gateway can pull from anyone who approved the vault, so a
   * standing unlimited approval would be a standing risk. */
  const approveExact = async (c: ChainIO, owner: Address, usdc6: bigint) => {
    const allowance = await read<bigint>(c.client, {
      address: c.usdc,
      abi: usdcAbi,
      functionName: 'allowance',
      args: [owner, c.usd],
    })
    if (allowance >= usdc6) return
    await write(c, { address: c.usdc, abi: usdcAbi, functionName: 'approve', args: [c.usd, usdc6] })
  }

  const trade = useCallback(
    async (num: number, side: Side, amount: number, chainId: string): Promise<TradeResult> => {
      const addr = activeAddr()
      const entry = entriesRef.current.get(num)
      if (!addr || !hubClientRef.current) return { ok: false, reason: 'Chain offline.' }
      if (!connectedRef.current) return { ok: false, reason: 'Connect a wallet first.' }
      if (!entry) return { ok: false, reason: 'Unknown creature.' }
      if (!(amount > 0)) return { ok: false, reason: 'Enter an amount.' }
      const c = io(chainId)
      if (!c) {
        const have = iosRef.current.map((x) => up(x.id)).join(' + ')
        return { ok: false, reason: `${up(chainId)} isn't live on this deployment yet — try ${have}.` }
      }
      if (!cleared()) return { ok: false, reason: 'Read and accept the risk notice first.' }
      const st = stateOf(chainId)
      const sym = c.chain.nativeCurrency.symbol

      try {
        const fee = await feeFor(c, side === 'buy' ? 'quoteBuy' : 'quoteSell')
        const gas = await c.client.getBalance({ address: addr })
        if (gas < fee + parseEther('0.00002')) {
          return {
            ok: false,
            reason:
              fee > 0n
                ? `Not enough ${sym} on ${up(chainId)}: this trade needs ~${ef(fee).toFixed(5)} ${sym} of network fee plus gas.`
                : `No gas on ${up(chainId)} — the wallet ${addr.slice(0, 8)}… needs a drop of ${sym} there.`,
          }
        }

        // the hub block to start looking from — read fresh: a cached number
        // could sit before this wallet's previous trade and resurrect it
        const hubMark = (await hubClientRef.current.getBlockNumber({ cacheTime: 0 })) + 1n
        let receipt
        if (side === 'buy') {
          if (hubPausedRef.current)
            return { ok: false, reason: 'The hub is paused: a buy would only be refunded. Sells stay open.' }
          if (st.paused)
            return { ok: false, reason: `Buys are paused on ${up(chainId)} — sells stay open.` }
          const usdc6 = toU6(amount)
          const usd18 = usdc6 * SCALE
          // spend oUSD claims first (no approval, no vault deposit), else USDC
          if (st.ousd >= usd18) {
            receipt = await write(c, {
              address: c.gateway,
              abi: gatewayAbi,
              functionName: 'buyToken',
              args: [entry.token, usd18],
              value: fee,
            })
          } else if (st.usdc >= usdc6) {
            if (st.depositsPaused)
              return { ok: false, reason: `Deposits are paused on ${up(chainId)} for now.` }
            if (st.liquidity + usdc6 > st.depositCap)
              return {
                ok: false,
                reason: `${up(chainId)}'s vault is at its deposit cap ($${e6(st.depositCap).toLocaleString('en-US')}) — only $${Math.max(0, e6(st.depositCap - st.liquidity)).toFixed(2)} of room left.`,
              }
            await approveExact(c, addr, usdc6)
            receipt = await write(c, {
              address: c.gateway,
              abi: gatewayAbi,
              functionName: 'buyTokenUsdc',
              args: [entry.token, usdc6],
              value: fee,
            })
          } else {
            const usdc = e6(st.usdc)
            const ousd = ef(st.ousd)
            return {
              ok: false,
              reason:
                `Only $${usdc.toFixed(2)} USDC on ${up(chainId)}` +
                (ousd >= 0.01 ? ` (+ $${ousd.toFixed(2)} in oUSD claims — unwrap them or buy less)` : '') +
                (networkRef.current === 'mainnet' ? ' — fund this chain or pick another.' : ' — hit MINT USDC or pick another chain.'),
            }
          }
        } else {
          const perChain = tokensByChainRef.current.get(num) ?? {}
          const have = perChain[chainId] ?? 0n
          if (have === 0n) {
            const where = Object.entries(perChain)
              .filter(([, v]) => v > 0n)
              .map(([k]) => up(k))
            return {
              ok: false,
              reason: where.length
                ? `Your bag lives on ${where.join(' + ')} — tokens are chain-native. Sell from there.`
                : 'You hold none of this creature.',
            }
          }
          let tokensWei = parseEther(amount.toFixed(18))
          // "sell everything" must not leave float dust behind on the chain
          if (tokensWei > have || (have - tokensWei) * 1_000_000_000n < have) tokensWei = have
          receipt = await write(c, {
            address: c.gateway,
            abi: gatewayAbi,
            functionName: 'sellToken',
            args: [entry.token, tokensWei],
            value: fee,
          })
        }

        // The hub's verdict: in this very receipt when the pad is on the same
        // chain (local devnet, or the hub chain's own gateway); otherwise it
        // arrives over LayerZero in a minute or three.
        const instant = syncRef.current || c.local
        const got = instant
          ? readOutcome(receipt.logs, entry.token, addr, side, c.label)
          : await waitHub(entry.token, addr, side, c.label, hubMark, 240_000)

        if (got?.kind === 'refused') {
          await poll()
          return {
            ok: false,
            reason:
              `The hub refused it — ${REFUSAL[got.reason] ?? 'see the hub events'}. ` +
              (side === 'buy' ? 'Your dollars were sent back.' : 'Your tokens were sent back.'),
          }
        }
        if (got?.kind === 'bounced') {
          await poll()
          return {
            ok: false,
            reason: `FAIR GENESIS turned the buy away (spawn block or your $250 window cap) — $${got.refunded.toFixed(2)} refunded.`,
          }
        }

        let usd: number
        let tokens: number
        let price: number
        let ascended = false
        let note: string | undefined
        let pending = false
        if (got?.kind === 'trade') {
          usd = got.usd
          tokens = got.tokens
          price = got.price
          ascended = got.ascended
          if (got.guardRefund > 0.005)
            note = `FAIR GENESIS CAPPED IT — $${got.guardRefund.toFixed(2)} REFUNDED`
        } else {
          // still in flight (or an unreadable receipt) — estimate from the quote
          const q = marketQuote(entry.market, side, amount)
          usd = side === 'buy' ? amount : q.usd
          tokens = side === 'buy' ? q.tokens : amount
          price = entry.market.state.vBase / entry.market.state.vTokens
          pending = !instant
          note = pending ? 'STILL CROSSING CHAINS — YOUR BALANCE UPDATES WHEN IT LANDS' : undefined
        }
        // a sell paid as a claim instead of USDC is worth saying out loud
        if (side === 'sell' && instant) {
          const paid = parseEventLogs({ abi: usdAbi, logs: receipt.logs }).find(
            (e) => e.eventName === 'PaidOut' && String(e.args.to).toLowerCase() === addr.toLowerCase(),
          )
          if (paid && paid.args.usdcOut === 0n && paid.args.minted >= SCALE)
            note = `${up(chainId)}'S VAULT IS SHORT — PAID AS AN oUSD CLAIM, UNWRAP IT WHEN LIQUIDITY RETURNS`
        }

        if (!pending) {
          if (side === 'buy') {
            costsRef.current[num] = (costsRef.current[num] ?? 0) + usd
            heldRef.current[num] = (heldRef.current[num] ?? 0) + tokens
          } else {
            const pos = wallet?.positions[num]
            if (pos && pos.tokens > 0) {
              costsRef.current[num] = Math.max(0, (costsRef.current[num] ?? 0) * (1 - tokens / pos.tokens))
            }
            heldRef.current[num] = Math.max(0, (heldRef.current[num] ?? 0) - tokens)
          }
          saveCosts()
        }
        await poll()
        return { ok: true, usd, tokens, price, ascended, note, pending }
      } catch (e) {
        return { ok: false, reason: reasonOf(e) }
      }
    },
    [poll, waitHub, wallet],
  )

  /** Where a launch is submitted from when the user did not choose: the hub
   * chain's own gateway if there is one (instant, cheapest), else the first
   * chain the wallet has gas on. */
  const defaultSpawnChain = (): ChainIO | undefined => {
    const all = iosRef.current
    return (
      all.find((c) => c.local && stateOf(c.id).gas > 0n) ??
      all.find((c) => stateOf(c.id).gas > 0n) ??
      all.find((c) => c.local) ??
      all[0]
    )
  }

  const spawnArgs = (input: SpawnInput) => {
    const name = input.name.toUpperCase()
    const ticker = input.ticker.toUpperCase()
    // metaURI stays small on purpose: the image is hosted by the site and
    // the URI carries only its path (69 bytes). Without a hosted image the
    // face lives in the creator's browser only, keyed by the token address.
    const metaURI = buildMetaURI({
      links: input.links,
      feeMode: input.feeMode,
      image: hostedImagePath(input.imageUrl),
    })
    return { name, ticker, metaURI }
  }

  const quoteSpawnFee = useCallback(async (input: SpawnInput, chainId: string): Promise<number> => {
    const c = io(chainId)
    if (!c) return 0
    const { name, ticker, metaURI } = spawnArgs(input)
    const fee = await feeFor(c, 'quoteSpawn', [name, ticker, metaURI, (input.devBuyUsd ?? 0) > 0])
    return ef(fee)
  }, [])

  const spawn = useCallback(
    async (input: SpawnInput): Promise<CreatureMeta> => {
      const hub = hubClientRef.current
      const m = manifestRef.current
      if (!hub || !m || iosRef.current.length === 0) throw new Error('Chain offline.')
      if (!connectedRef.current) await connect()
      const addr = activeAddr()
      if (!addr) throw new Error('Connect a wallet first.')
      if (!cleared()) throw new Error('Read and accept the risk notice first.')

      const c = (input.chain ? io(input.chain) : undefined) ?? defaultSpawnChain()
      if (!c) throw new Error('No chain to launch from.')
      const st = stateOf(c.id)
      if (hubPausedRef.current) throw new Error('The hub is paused — launches are closed for now.')
      if (st.paused) throw new Error(`Launches are paused on ${up(c.id)}.`)

      const { name, ticker, metaURI } = spawnArgs(input)
      if (utf8Len(name) > MAX_NAME_BYTES) throw new Error('That name is too long.')
      if (utf8Len(ticker) > MAX_SYMBOL_BYTES) throw new Error('That ticker is too long.')
      if (utf8Len(metaURI) > MAX_META_BYTES) throw new Error('Those links are too long — shorten them.')

      const devBuy = input.devBuyUsd ?? 0
      const usdc6 = devBuy > 0 ? toU6(devBuy) : 0n
      const usd18 = usdc6 * SCALE
      const feeMode = FEE_MODE_INDEX[input.feeMode ?? 'holders']
      const fee = await feeFor(c, 'quoteSpawn', [name, ticker, metaURI, devBuy > 0])
      const sym = c.chain.nativeCurrency.symbol
      const gas = await c.client.getBalance({ address: addr })
      if (gas < fee + parseEther('0.00005'))
        throw new Error(
          `Not enough ${sym} on ${up(c.id)}: launching needs ~${ef(fee).toFixed(5)} ${sym} of network fee plus gas.`,
        )

      const before = Number(
        await hub.readContract({ address: m.pad, abi: padAbi, functionName: 'tokensLength' }),
      )
      const hubMark = (await hub.getBlockNumber({ cacheTime: 0 })) + 1n
      let receipt
      try {
        if (usdc6 > 0n && st.ousd >= usd18) {
          receipt = await write(c, {
            address: c.gateway,
            abi: gatewayAbi,
            functionName: 'spawnToken',
            args: [name, ticker, metaURI, usd18, feeMode],
            value: fee,
          })
        } else {
          if (usdc6 > 0n) {
            if (st.usdc < usdc6)
              throw new Error(`Only $${e6(st.usdc).toFixed(2)} USDC on ${up(c.id)} for the dev buy.`)
            if (st.depositsPaused || st.liquidity + usdc6 > st.depositCap)
              throw new Error(`${up(c.id)}'s vault cannot take a $${devBuy} deposit right now (deposit cap).`)
            await approveExact(c, addr, usdc6)
          }
          receipt = await write(c, {
            address: c.gateway,
            abi: gatewayAbi,
            functionName: 'spawnTokenUsdc',
            args: [name, ticker, metaURI, usdc6, feeMode],
            value: fee,
          })
        }
      } catch (e) {
        throw new Error(reasonOf(e))
      }

      const refusedIn = (logs: Log[]) =>
        parseEventLogs({ abi: padAbi, logs }).find(
          (e) =>
            e.eventName === 'Refused' &&
            Number(e.args.op) === OP.SPAWN &&
            narrowActor(String(e.args.actor)) === addr.toLowerCase(),
        )
      const refusal = (e: ReturnType<typeof refusedIn>) =>
        new Error(
          `The hub refused the launch — ${REFUSAL[Number(e && e.eventName === 'Refused' ? e.args.reason : 0)] ?? 'see the hub events'}. Any dev buy was sent back.`,
        )

      let token: Address | undefined
      if (syncRef.current || c.local) {
        const no = refusedIn(receipt.logs)
        if (no) throw refusal(no)
        const spawned = parseEventLogs({ abi: padAbi, logs: receipt.logs }).find(
          (e) => e.eventName === 'Spawned',
        )
        token = spawned?.eventName === 'Spawned' ? spawned.args.token : undefined
      } else {
        // wait for OP_SPAWN to land on the hub over LayerZero
        const t0 = Date.now()
        while (Date.now() - t0 < 300_000 && !token) {
          await sleep(isLocalRef.current ? 2000 : 8000)
          try {
            const len = Number(
              await hub.readContract({ address: m.pad, abi: padAbi, functionName: 'tokensLength' }),
            )
            for (let i = before; i < len; i++) {
              const row = await hub.readContract({
                address: m.pad,
                abi: padAbi,
                functionName: 'getToken',
                args: [BigInt(i)],
              })
              if (narrowActor(row[4]) === addr.toLowerCase()) token = row[0]
            }
            if (!token) {
              const latest = await hub.getBlockNumber()
              const logs = await getLogsChunked(
                hub,
                m.pad,
                hubMark,
                latest,
                isLocalRef.current ? LOG_CHUNK_LOCAL : LOG_CHUNK_PUBLIC,
              )
              const no = refusedIn(logs)
              if (no) throw refusal(no)
            }
          } catch (e) {
            if (e instanceof Error && e.message.startsWith('The hub refused')) throw e
            /* transient */
          }
        }
      }
      if (token) {
        // the creator's own copy of the face: what this browser shows when
        // the launch carries no hosted image
        try {
          localStorage.setItem(`spawn.img.${token.toLowerCase()}`, input.image)
        } catch {
          /* no storage */
        }
        // A background poll may have listed the token while the launch was
        // still crossing — an entry is built once, so hand it the face now.
        const early = [...entriesRef.current.values()].find(
          (en) => en.token.toLowerCase() === token.toLowerCase(),
        )
        if (early && !early.meta.image && input.image) early.meta.image = input.image
      }
      await poll()
      const entry = token
        ? [...entriesRef.current.values()].find((en) => en.token.toLowerCase() === token.toLowerCase())
        : undefined
      const num = entry?.meta.num ?? entriesRef.current.size
      if (entry && token && devBuy > 0) {
        // the dev buy is this wallet's first trade of the token: book it in
        // the ledger from the hub's own Trade event (same tx as the spawn)
        try {
          const logs =
            syncRef.current || c.local
              ? receipt.logs
              : await getLogsChunked(
                  hub,
                  m.pad,
                  hubMark,
                  await hub.getBlockNumber({ cacheTime: 0 }),
                  isLocalRef.current ? LOG_CHUNK_LOCAL : LOG_CHUNK_PUBLIC,
                )
          const got = readOutcome(logs, token, addr, 'buy', c.label)
          if (got?.kind === 'trade') {
            costsRef.current[num] = (costsRef.current[num] ?? 0) + got.usd
            heldRef.current[num] = (heldRef.current[num] ?? 0) + got.tokens
            saveCosts()
            void poll().catch(() => undefined)
          }
        } catch {
          /* ledger stays silent: PnL shows as unknown for this bag */
        }
      }
      setJustSpawned(num)
      window.setTimeout(() => setJustSpawned(null), 4000)
      return (
        entry?.meta ?? { num, name: input.name, ticker: input.ticker, color: PALETTE[0], spawnedAt: Date.now() }
      )
    },
    [connect, poll],
  )

  const getQuote = useCallback((num: number, side: Side, amount: number) => {
    const entry = entriesRef.current.get(num)
    if (!entry || !(amount > 0)) return null
    return marketQuote(entry.market, side, amount)
  }, [])

  const getMarket = useCallback((num: number) => entriesRef.current.get(num)?.market, [])

  /** The chain a claim-type message is sent from: the hub chain's gateway
   * when the wallet has gas there (no message at all), else the first chain
   * with gas. */
  const claimChain = (): ChainIO | undefined => {
    const all = iosRef.current
    return (
      all.find((c) => c.local && stateOf(c.id).gas > 0n) ??
      all.find((c) => stateOf(c.id).gas > 0n) ??
      all[0]
    )
  }

  /** The dev's fee share: the gateway messages the hub, the hub pays out on
   * that chain (USDC when its vault is liquid). A claim the hub will not
   * honour does not revert — it is refused, and this returns 0. */
  const claimFees = useCallback(
    async (num: number): Promise<number> => {
      const addr = activeAddr()
      const entry = entriesRef.current.get(num)
      if (!addr || !entry || iosRef.current.length === 0) return 0
      const f = entry.market.fees
      const claimable = f ? Math.max(0, f.dev - f.devClaimed) : 0
      if (claimable <= 0.005) return 0
      if (!cleared()) return 0
      const c = claimChain()
      if (!c) return 0
      const hubMark = (await hubClientRef.current!.getBlockNumber({ cacheTime: 0 })) + 1n
      const fee = await feeFor(c, 'quoteClaim')
      const receipt = await write(c, {
        address: c.gateway,
        abi: gatewayAbi,
        functionName: 'claimFees',
        args: [entry.token],
        value: fee,
      })
      const got =
        syncRef.current || c.local
          ? readOutcome(receipt.logs, entry.token, addr, 'claim', c.label)
          : await waitHub(entry.token, addr, 'claim', c.label, hubMark, 240_000)
      await poll()
      if (got?.kind === 'claimed') return got.amount
      if (got?.kind === 'refused') return 0
      return claimable // still crossing — the hub will pay this out
    },
    [poll, waitHub],
  )

  /** Claims the wallet's holder fee rewards for one creature, on every chain
   * holding any — each claim is a pure local tx on that chain. Rewards are
   * paid in oUSD (spendable as-is, or unwrapped to USDC). */
  const claimHolderRewards = useCallback(
    async (num: number): Promise<number> => {
      const addr = activeAddr()
      const entry = entriesRef.current.get(num)
      if (!addr || !entry) return 0
      if (!cleared()) return 0
      const perChain = rewardsByChainRef.current.get(num) ?? {}
      let claimed = 0
      for (const c of iosRef.current) {
        const amount = perChain[c.id] ?? 0n
        if (!c.dist || amount === 0n) continue
        if (!isLocalRef.current && stateOf(c.id).gas < parseEther('0.00002')) continue
        try {
          const rep = await replicaAddr(c.id, entry.token)
          if (rep === ZERO) continue
          await write(c, { address: c.dist, abi: distributorAbi, functionName: 'claim', args: [rep] })
          claimed += ef(amount)
        } catch {
          /* chain unreachable or rejected in the wallet — claim the rest */
        }
      }
      await poll()
      return claimed
    },
    [poll, replicaAddr],
  )

  /** Asks the hub for one chain's waiting slice of a creature's holder fees.
   * The caller pays the round trip; it lands in that chain's pool for every
   * holder there a few minutes later. */
  const pullHolderFees = useCallback(
    async (num: number, chainId: string): Promise<{ ok: boolean; reason?: string }> => {
      const addr = activeAddr()
      const entry = entriesRef.current.get(num)
      const c = io(chainId)
      if (!addr || !entry || !c) return { ok: false, reason: 'Chain offline.' }
      if (!cleared()) return { ok: false, reason: 'Read and accept the risk notice first.' }
      try {
        const fee = await feeFor(c, 'quotePull')
        const gas = await c.client.getBalance({ address: addr })
        const sym = c.chain.nativeCurrency.symbol
        if (gas < fee + parseEther('0.00002'))
          return {
            ok: false,
            reason: `Not enough ${sym} on ${up(chainId)} — the pull needs ~${ef(fee).toFixed(5)} ${sym} plus gas.`,
          }
        await write(c, {
          address: c.gateway,
          abi: gatewayAbi,
          functionName: 'pullFees',
          args: [entry.token],
          value: fee,
        })
        await poll()
        return { ok: true }
      } catch (e) {
        return { ok: false, reason: reasonOf(e) }
      }
    },
    [poll],
  )

  /** Mints the wallet's parked deliveries of one creature on one chain. */
  const claimParked = useCallback(
    async (num: number, chainId: string): Promise<number> => {
      const entry = entriesRef.current.get(num)
      const c = io(chainId)
      const amount = parkedRef.current[num]?.[chainId] ?? 0
      if (!entry || !c || !activeAddr() || amount <= 0) return 0
      if (!cleared()) return 0
      await write(c, { address: c.gateway, abi: gatewayAbi, functionName: 'claimPending', args: [entry.token] })
      // the replica may be brand new to this session
      replicaCache.current.delete(`${chainId}:${entry.token}`)
      await poll()
      return amount
    },
    [poll],
  )

  /** Turns the wallet's oUSD claims on one chain back into USDC, as far as
   * that chain's vault can pay right now. Returns the USDC received. */
  const unwrap = useCallback(
    async (chainId: string): Promise<number> => {
      const c = io(chainId)
      if (!c || !activeAddr()) return 0
      if (!cleared()) return 0
      const st = stateOf(chainId)
      let usdc6 = st.ousd / SCALE
      if (usdc6 > st.liquidity) usdc6 = st.liquidity
      if (usdc6 === 0n) return 0
      await write(c, { address: c.usd, abi: usdAbi, functionName: 'unwrap', args: [usdc6 * SCALE] })
      await poll()
      return e6(usdc6)
    },
    [poll],
  )

  const creatures = useMemo(() => {
    void version
    const now = Date.now()
    return [...entriesRef.current.values()].map((e) => deriveCreature(e.meta, e.market, now))
  }, [version])

  const chainInfo = useMemo(() => {
    void version
    const out: Record<string, ChainInfo> = {}
    for (const c of iosRef.current) {
      const s = stateOf(c.id)
      out[c.id] = {
        id: c.id,
        local: c.local,
        usdc: e6(s.usdc),
        ousd: ef(s.ousd),
        gas: ef(s.gas),
        nativeSymbol: c.chain.nativeCurrency.symbol,
        liquidity: e6(s.liquidity),
        depositCap: e6(s.depositCap),
        depositsPaused: s.depositsPaused,
        paused: s.paused,
        fee: { buy: ef(s.fee.buy), sell: ef(s.fee.sell), claim: ef(s.fee.claim), pull: ef(s.fee.pull) },
      }
    }
    return out
  }, [version])

  const bags = useMemo(() => {
    void version
    const out: Record<number, Record<string, number>> = {}
    for (const [num, perChain] of tokensByChainRef.current) {
      for (const [chainId, wei] of Object.entries(perChain)) {
        // below one whole token is dust, not a bag anyone can act on
        if (wei >= 10n ** 18n) (out[num] ??= {})[chainId] = ef(wei)
      }
    }
    return out
  }, [version])

  const risk = useMemo(
    () =>
      network === 'mainnet'
        ? {
            accepted: riskAccepted,
            open: riskOpen,
            show: () => setRiskOpen(true),
            dismiss: () => setRiskOpen(false),
            accept: () => {
              riskRef.current = true
              setRiskAccepted(true)
              setRiskOpen(false)
              try {
                localStorage.setItem(LS_RISK, '1')
              } catch {
                /* no storage — asked again next visit */
              }
            },
          }
        : undefined,
    [network, riskAccepted, riskOpen],
  )

  const value = useMemo<StoreValue>(
    () => ({
      mode: 'chain',
      creatures,
      wallet,
      connect,
      spawn,
      trade,
      claimFees,
      getQuote,
      getMarket,
      justSpawned,
      onchain: {
        status,
        network,
        sponsored,
        airdrop: network === 'mainnet' ? undefined : airdrop,
        chains: chainIds,
        chainInfo,
        hubPaused,
        walletSource,
        disconnect,
        holderRewards: rewardsRef.current,
        holderFees: holderFeesRef.current,
        claimHolderRewards,
        pullHolderFees,
        bags,
        parked: parkedRef.current,
        claimParked,
        unwrap,
        quoteSpawnFee,
        fairGenesis: fairGenesisRef.current,
        risk,
      },
    }),
    [
      creatures,
      wallet,
      connect,
      spawn,
      trade,
      claimFees,
      getQuote,
      getMarket,
      justSpawned,
      status,
      network,
      sponsored,
      airdrop,
      chainIds,
      chainInfo,
      hubPaused,
      walletSource,
      disconnect,
      claimHolderRewards,
      pullHolderFees,
      bags,
      claimParked,
      unwrap,
      quoteSpawnFee,
      risk,
    ],
  )

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
}
