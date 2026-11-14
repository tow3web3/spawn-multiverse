/**
 * The on-chain store: same StoreValue contract as the sim provider, but every
 * number is read from a real SPAWN! deployment and every action is a real
 * transaction.
 *
 * Three worlds through one manifest format:
 *  - LOCAL devnet: every logical chain lives on one hardhat node; omnichain
 *    messages deliver synchronously (results parse out of the same receipt).
 *  - PUBLIC TESTNET: the hub is Base Sepolia, each spoke its own network;
 *    play money (a mock dollar anyone can mint), burner wallets, a gas drip,
 *    and usually sponsored messaging.
 *  - MAINNET: real dollars, the user's own wallet only, user-paid messaging,
 *    guarded by deposit caps and a risk notice. ONE universe on six chains,
 *    one manifest (`/onchain/mainnet.json`) listing the chains that are live.
 *
 * What v7 means here:
 *  - Every gateway call is payable: it must attach the fee its `quote*`
 *    view returns, unless the deployment is sponsored.
 *  - The hub chain has its own gateway (`local`): trades there settle in one
 *    transaction, no cross-chain wait.
 *  - The hub never reverts on a message — it REFUSES (event `Refused`) and
 *    sends value home. Outcomes are read from events, not from reverts.
 *
 * What v7.2 means here (protocol of 2026-11, one universe, six chains):
 *  - THE DOLLAR IS PER CHAIN. Base, Optimism, Arbitrum and Ethereum settle in
 *    USDC (6 decimals), BNB Chain in Binance USDT (18). Each chain's token
 *    decimals and vault SCALE are read from that chain and every conversion
 *    goes through lib/dollars with THAT chain's figures — nothing here
 *    assumes six, nor one dollar for the page. A wallet's dollars on a chain
 *    are its token + oUSD claims on that chain's vault. Buys pull the token
 *    through an EXACT approval to the vault (never the gateway).
 *  - PRICE PROTECTION EVERYWHERE. Every trade goes through the `*Min`
 *    entrypoints with the user's tolerance. On the hub chain an order under
 *    its minimum reverts before it is signed; from another chain the hub
 *    refuses it minutes later and sends it back whole (`Refused`) — said in
 *    plain words, not as an error. (A pre-v7.2 deployment keeps the v7.1
 *    rule: protection only where the hub answers in the same transaction.)
 *  - OPEN A TOKEN on a chain it never reached (`openToken`), only after
 *    checking that the hub would actually send its SYNC (its live quote
 *    within `requestCap`) — no fee is taken for an open that cannot happen.
 *  - MOVE A CLAIM (`moveClaim`) to a chain whose vault can pay it, when the
 *    local vault cannot.
 *  - Everything this provider remembers in the browser is keyed by the
 *    deployment (its pad).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  formatEther,
  getAddress,
  http,
  pad as padHex,
  parseEther,
  encodeAbiParameters,
  parseEventLogs,
  toFunctionSelector,
  type Address,
  type Chain,
  type Log,
  type PublicClient,
} from 'viem'
import { narrowActor } from '../lib/format'
import { fromUnits, lessBps, scaleOf, toUnits, type Dollar } from '../lib/dollars'
import { expectBuy, expectSell, type CurveState, type GenesisState } from '../lib/curveMath'
import {
  CLAIM_DUST,
  availability,
  declaredDollar,
  moveTargets,
  openVerdict,
  readMove,
  readOpen,
  readTrade,
  returnedText,
  type Availability,
  type HubEvent,
} from '../lib/v72'
import { hostedImagePath } from '../lib/tokenImage'
import { MAX_META_BYTES, buildMetaURI, utf8Len } from '../lib/tokenMeta'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import {
  StoreCtx,
  deriveCreature,
  type ChainInfo,
  type CreatureMeta,
  type ActionResult,
  type HolderFees,
  type MoveOption,
  type NetworkProfile,
  type OpenCheck,
  type SpawnInput,
  type StoreValue,
  type TradeExpectation,
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
  messengerAbi,
  padAbi,
  tokenAbi,
  usdAbi,
  usdcAbi,
  type Manifest,
} from './abi'
import { rpcTransport } from './rpc'
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
const ZERO32 = `0x${'0'.repeat(64)}` as const
/** The gateway's floor on a trade (`MIN_AMOUNT`): 1e12 wei of dollars on a
 * buy, 1e12 wei of tokens on a sell — below it the call reverts "GW: dust". */
const MIN_AMOUNT = 10n ** 12n
/** Price tolerance of a protected trade, in basis points. */
const DEFAULT_SLIPPAGE_BPS = 200
const MIN_SLIPPAGE_BPS = 10
const MAX_SLIPPAGE_BPS = 5000
const LS_SLIPPAGE = 'spawn.slippage.bps'
/** The v7.1 gateway's protected entrypoints. A gateway without them (the
 * v7.0 testnet) is recognised by this selector missing from its code. */
const MIN_SELECTOR = toFunctionSelector('buyTokenUsdcMin(address,uint256,uint256)').slice(2).toLowerCase()
/** The v7.2 gateway's `openToken` and `moveClaim` — absent before v7.2. */
const OPEN_SELECTOR = toFunctionSelector('openToken(address)').slice(2).toLowerCase()
const MOVE_SELECTOR = toFunctionSelector('moveClaim(uint32,bytes32,uint256)').slice(2).toLowerCase()
/** OP_SYNC_TOKEN, as `SpawnPad._syncPayload` builds it. */
const OP_SYNC_TOKEN = 10
// Hardhat's well-known dev account #0 — funds wallets with gas on the LOCAL
// dev chain only. Never reuse outside a throwaway devnet.
const FUNDER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
// Public RPCs cap eth_getLogs hard (Base Sepolia: 200 blocks per call).
const LOG_CHUNK_LOCAL = 100_000n
const LOG_CHUNK_PUBLIC = 199n
// First load only backfills this many hub blocks of tape (~33h on Base's 2s
// blocks) — keeps page loads fast on capped public RPCs.
const BACKFILL_BLOCKS = 60_000n
/** The risk notice is accepted once per deployment generation: v7.2 (one
 * universe, six chains, two dollars) carries risks the v7.1 notice did not. */
const riskKey = (generation: string) => `spawn.risk.accepted.v3.${generation}`
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const up = (chainId: string) => chainId.toUpperCase()

interface TokenEntry {
  meta: CreatureMeta
  token: Address
  market: Market
  /** The curve exactly as the venue stores it (wei): what a minimum is
   * computed from. `market.state` is its float shadow, for display. */
  curve: CurveState
}

/** A trade as the hub will execute it, in the chain's own integers. */
interface RawExpectation {
  protected: boolean
  /** Buy: token wei. Sell: dollar wei (18 decimals), net of the fee. */
  expected: bigint
  /** `expected` less the tolerance. */
  min: bigint
  /** Buy: the dollars that will really be sent — the request, sized down to
   * what the FAIR GENESIS cap leaves — in wei and in the token's units. */
  spendWei: bigint
  spendUnits: bigint
  /** Buy: the part of the request the cap turns away (wei). */
  clampedWei: bigint
  feeBps: bigint
  /** Sell: the token wei that will be sold (a whole bag sells whole). */
  tokensWei: bigint
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
  /** THIS chain's dollar (symbol + decimals), the decimals of its token
   * and oUSD wei per smallest unit of it (the vault's own SCALE).
   * `verified`: decimals and scale were read from the chain; until then they
   * are what the manifest declares, and no transaction goes out before they
   * are confirmed. */
  dollar: Dollar
  dec: number
  scale: bigint
  verified: boolean
  /** `cctp`: a USDC vault; `local`: a vault over its own dollar (no wrap). */
  vault: 'cctp' | 'local'
  /** The gateway has the v7.1 `*Min` entrypoints. */
  hasMin: boolean
  /** The gateway has the v7.2 actions (`openToken`, `moveClaim`). */
  v72: boolean
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
  fee: { buy: bigint; sell: bigint; claim: bigint; pull: bigint; open: bigint }
}

const EMPTY_CHAIN: ChainState = {
  usdc: 0n,
  ousd: 0n,
  gas: 0n,
  liquidity: 0n,
  depositCap: 0n,
  depositsPaused: false,
  paused: false,
  fee: { buy: 0n, sell: 0n, claim: 0n, pull: 0n, open: 0n },
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
function loadLedger(kind: 'cost' | 'held', scope: string, addr: string): Record<number, number> {
  // keyed by the deployment (its pad): creature #1 of one universe is not
  // creature #1 of another
  try {
    return JSON.parse(localStorage.getItem(`spawn.${kind}.${scope}.${addr.toLowerCase()}`) ?? '{}')
  } catch {
    return {}
  }
}

function loadSlippage(): number {
  try {
    const n = Number(localStorage.getItem(LS_SLIPPAGE))
    if (Number.isInteger(n) && n >= MIN_SLIPPAGE_BPS && n <= MAX_SLIPPAGE_BPS) return n
  } catch {
    /* no storage */
  }
  return DEFAULT_SLIPPAGE_BPS
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

/** Everything a viem / wallet error says, flattened: the revert string of a
 * failed gas estimate can sit in `details` or deep in the cause chain. */
function errorText(e: unknown): string {
  const parts: string[] = []
  let cur = e as { shortMessage?: string; message?: string; details?: string; cause?: unknown } | undefined
  for (let i = 0; cur && i < 6; i++) {
    if (typeof cur === 'string') {
      parts.push(cur)
      break
    }
    for (const s of [cur.shortMessage, cur.details, cur.message]) if (s) parts.push(String(s))
    cur = cur.cause as typeof cur
  }
  return parts.join('\n')
}

/** A transaction that was mined and reverted: gas was spent, nothing else. */
class MinedRevert extends Error {
  mined = true
}

/** A protected trade the chain turned away because the price left the
 * tolerance. Not a failure of anything: the protection doing its job. */
const isMinOut = (e: unknown) => /GW: min out/.test(errorText(e))
const minOutReason = (e: unknown) =>
  e instanceof MinedRevert
    ? 'The price moved more than your tolerance — the trade was cancelled and nothing was spent but the gas of that transaction. Try again.'
    : 'The price moved more than your tolerance — nothing was spent. Try again.'

/** A short, human reason out of a viem / wallet error. `sym` is the dollar
 * of the chain the call went to ("USDC", "USDT"). */
function reasonOf(e: unknown, sym = 'USDC'): string {
  const any = e as { shortMessage?: string; message?: string; code?: number; cause?: { code?: number } }
  if (any?.code === 4001 || any?.cause?.code === 4001) return 'Rejected in the wallet.'
  const all = errorText(e)
  const msg = String(any?.shortMessage ?? any?.message ?? 'Transaction failed.')
  if (/GW: min out/.test(all)) return minOutReason(e)
  if (/GW: paused/.test(all)) return 'Buys and launches are paused on this chain — sells stay open.'
  if (/deposit cap/.test(all)) return "This chain's deposit cap is full — try a smaller amount or another chain."
  if (/deposits paused/.test(all)) return 'Deposits are paused on this chain.'
  if (/GW: unknown token|GW: no replica/.test(all)) return 'This token is not open on this chain yet.'
  if (/GW: already open/.test(all)) return 'This token is already open on this chain.'
  if (/GW: route closed/.test(all)) return 'Moves to that chain are closed right now.'
  if (/GW: bad destination/.test(all)) return 'That destination cannot receive this claim.'
  if (/GW: dust|oUSD: dust|GW: zero|VENUE: dust/.test(all)) return 'That amount is too small to trade.'
  if (/PAD: gas/.test(all))
    return 'The launch ran out of gas before it could reach every chain — send it again with a higher gas limit.'
  if (/LZM: fee|LOM: fee/.test(all)) return 'The network fee moved — try again.'
  if (/vault short/.test(all)) return `This chain's vault is short of ${sym} right now — your claim stays valid.`
  if (/insufficient funds/i.test(all)) return 'Not enough gas in the wallet for this transaction.'
  if (/User rejected|denied/i.test(all)) return 'Rejected in the wallet.'
  return msg.split('\n')[0].slice(0, 140)
}

type Want = 'buy' | 'sell' | 'claim'

/** Pad logs → the plain events lib/v72 reads (one receipt on the hub chain,
 * a block range for a message that crossed). */
const hubEvents = (logs: Log[]): HubEvent[] =>
  parseEventLogs({ abi: padAbi, logs }) as unknown as HubEvent[]

/** The hub's verdict on `actor`'s message about `token`, sent from the chain
 * labelled `label` (see lib/v72 `readTrade`). */
const readOutcome = (logs: Log[], token: Address, actor: Address, want: Want, label: number) =>
  readTrade(hubEvents(logs), { token, actor, want, label })

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
  /** The protocol generation the manifest declares ("v7.2"…). */
  const [generation, setGeneration] = useState<string | undefined>(undefined)
  /** Read from storage once the manifest says which generation's notice it is. */
  const [riskAccepted, setRiskAccepted] = useState(false)
  const [riskOpen, setRiskOpen] = useState(false)
  const [slippageBps, setSlippageBps] = useState(loadSlippage)
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
  /** v7.2 deployment: every chain's trades go through the `*Min` entrypoints
   * (the hub enforces the minimum of a trade that crossed). */
  const v72Ref = useRef(false)
  const generationRef = useRef('v7')
  /** The hub's messaging adapter — prices an open's SYNC before it is offered. */
  const hubMessengerRef = useRef<Address | null>(null)
  /** The deployment's key for everything kept in this browser: its pad. */
  const scopeRef = useRef('')
  const slippageRef = useRef(slippageBps)
  const burnerRef = useRef<PrivateKeyAccount | null>(null)
  const entriesRef = useRef<Map<number, TokenEntry>>(new Map())
  const replicaCache = useRef<Map<string, Address>>(new Map())
  /** Tokens whose SYNC to a chain failed and was not sent again:
   * hub token (lowercase) -> chain labels. */
  const syncFailedRef = useRef<Map<string, Set<number>>>(new Map())
  /** creature num -> chain id -> why it cannot be traded there yet. */
  const unavailableRef = useRef<Record<number, Record<string, Availability>>>({})
  /** FAIR GENESIS in the hub's integers, for the tokens still in their
   * window: creature num -> tax now, and this wallet's spend against the cap. */
  const genesisRawRef = useRef<Record<number, GenesisState>>({})
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
    costsRef.current = loadLedger('cost', scopeRef.current, addr)
    heldRef.current = loadLedger('held', scopeRef.current, addr)
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
      transport: rpcTransport(c.chain.id, c.chain.rpcUrls.default.http[0]),
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
    if (receipt.status !== 'success') {
      // Mined and reverted (a wallet lets the user send a transaction its
      // own estimate said would fail). The receipt carries no reason, so the
      // call is replayed against the block it died in to hear it.
      let why = ''
      try {
        await c.client.simulateContract({
          ...req,
          account: activeAddr() ?? undefined,
          blockNumber: receipt.blockNumber,
        } as never)
      } catch (e) {
        why = errorText(e)
      }
      throw new MinedRevert(why || 'The transaction reverted.')
    }
    return receipt
  }

  /** Confirms a chain's dollar decimals and vault scale against the chain
   * itself before the first transaction there, when boot could not (its RPC
   * was unreachable). An amount is never converted on a declared value alone. */
  const sure = async (c: ChainIO) => {
    if (c.verified) return
    const [dec, scale] = await Promise.all([
      read<number>(c.client, { address: c.usdc, abi: usdcAbi, functionName: 'decimals' }),
      read<bigint>(c.client, { address: c.usd, abi: usdAbi, functionName: 'SCALE' }),
    ])
    if (Number(dec) !== c.dec || scale !== c.scale)
      throw new Error(`${up(c.id)}'s dollar does not match this deployment's manifest — refusing to trade.`)
    c.verified = true
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
    fn: 'quoteBuy' | 'quoteSell' | 'quoteClaim' | 'quotePull' | 'quoteSpawn' | 'quoteOpen' | 'quoteMove',
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
      const key = `${scopeRef.current}.${addr.toLowerCase()}`
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

  const pollOnce = useCallback(async () => {
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
            image = localStorage.getItem(`spawn.img.${scopeRef.current}.${token.toLowerCase()}`) ?? undefined
          } catch {
            /* no storage */
          }
        }
        entry = {
          token,
          curve: { vBase, vTokens, sold, ascended },
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
      entry.curve = { vBase, vTokens, sold, ascended }
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
        } else if (log.eventName === 'SyncFailed' || log.eventName === 'Resynced') {
          // v7.1: a chain the launch could not reach has no replica of the
          // token until the operator sends the SYNC again
          const key = (log.args.token as string).toLowerCase()
          const set = syncFailedRef.current.get(key) ?? new Set<number>()
          if (log.eventName === 'SyncFailed') set.add(Number(log.args.chain))
          else set.delete(Number(log.args.chain))
          syncFailedRef.current.set(key, set)
        }
      }
    }

    // 2b. where each token can be traded: a remote chain needs its replica.
    //     Resolved for everyone, wallet or not — the token page must not
    //     offer a chain the gateway would refuse ("GW: unknown token").
    {
      const entries = [...entriesRef.current.entries()]
      await Promise.all(
        entries.flatMap(([, entry]) =>
          iosRef.current.map((c) => replicaAddr(c.id, entry.token).catch(() => ZERO as Address)),
        ),
      )
      const unavailable: Record<number, Record<string, Availability>> = {}
      for (const [num, entry] of entries) {
        const failed = syncFailedRef.current.get(entry.token.toLowerCase())
        for (const c of iosRef.current) {
          // arriving (a fresh SYNC may still land), closed (it will not by
          // itself: open it from that chain), failed (pre-v7.2: only a resync)
          const why = availability({
            hasReplica: replicaCache.current.has(`${c.id}:${entry.token}`),
            syncFailed: failed?.has(c.label) ?? false,
            synchronous: syncRef.current,
            hubChain: c.local,
            ageMs: Date.now() - entry.meta.spawnedAt,
            canOpen: c.v72,
          })
          if (why) (unavailable[num] ??= {})[c.id] = why
        }
      }
      unavailableRef.current = unavailable
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
          const [liquidity, depositCap, depositsPaused, paused, fb, fs, fc, fp, fo, usdc, ousd, gas] =
            await Promise.all([
              read<bigint>(c.client, { address: c.usd, abi: usdAbi, functionName: 'liquidity' }),
              read<bigint>(c.client, { address: c.usd, abi: usdAbi, functionName: 'depositCap' }),
              read<boolean>(c.client, { address: c.usd, abi: usdAbi, functionName: 'depositsPaused' }),
              read<boolean>(c.client, { address: c.gateway, abi: gatewayAbi, functionName: 'paused' }),
              wantFees ? g('quoteBuy') : 0n,
              wantFees ? g('quoteSell') : 0n,
              wantFees ? g('quoteClaim') : 0n,
              wantFees ? g('quotePull') : 0n,
              wantFees && c.v72 ? g('quoteOpen') : 0n,
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
            fee: { buy: fb, sell: fs, claim: fc, pull: fp, open: fo },
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
      const raw: Record<number, GenesisState> = {}
      await Promise.all(
        entries.map(async ([num, entry]) => {
          if (Date.now() > entry.meta.spawnedAt + 660_000) return
          try {
            const [endsAt, snipeBps, spentUsd, capUsd] = await hub.readContract({
              address: m.pad,
              abi: padAbi,
              functionName: 'fairGenesisOf',
              args: [entry.token, padHex(addr, { size: 32 })],
            })
            fg[num] = { endsAt: at(endsAt), spentUsd: ef(spentUsd), capUsd: ef(capUsd) }
            raw[num] = { snipeBps, spent: spentUsd, cap: capUsd }
          } catch {
            /* transient */
          }
        }),
      )
      fairGenesisRef.current = fg
      genesisRawRef.current = raw

      setWallet({ address: addr, balance: ef(dollarsWei(nextState)), positions })
    }

    bump()
  }, [replicaAddr])

  /** Polls never overlap. Two at once would both read the tape from the same
   * block and book every trade in it twice (volume, holders, the tape
   * itself). A call made while one is in flight gets the NEXT poll — one
   * that starts after this moment, so whoever just transacted sees their
   * own block — and every such caller shares that one. */
  const pollRunning = useRef<Promise<void> | null>(null)
  const pollQueued = useRef<Promise<void> | null>(null)
  const poll = useCallback((): Promise<void> => {
    const start = () => {
      const p = pollOnce().finally(() => {
        if (pollRunning.current === p) pollRunning.current = null
      })
      pollRunning.current = p
      return p
    }
    if (!pollRunning.current) return start()
    if (!pollQueued.current) {
      pollQueued.current = pollRunning.current
        .catch(() => undefined)
        .then(() => {
          pollQueued.current = null
          return start()
        })
    }
    return pollQueued.current
  }, [pollOnce])

  /** Everything the wallet holds in dollars across the chains, in 18-decimal
   * wei: each chain's dollar token at ITS scale, plus oUSD. */
  const dollarsWei = (states: Record<string, ChainState>) =>
    iosRef.current.reduce((a, c) => {
      const s = states[c.id]
      return s ? a + s.usdc * c.scale + s.ousd : a
    }, 0n)

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
          throw new Error('pre-v7 deployment manifest (no dollar token) — redeploy or wait for the v7 rollout')
        manifestRef.current = manifest
        scopeRef.current = manifest.pad.toLowerCase()
        // which generation this deployment is: v7.2 is one universe on six
        // chains, a dollar per chain, protection everywhere, opens, moves
        const gen = manifest.generation ?? 'v7'
        generationRef.current = gen
        v72Ref.current = gen === 'v7.2'
        setGeneration(manifest.generation)
        hubMessengerRef.current = manifest.hubMessenger ?? manifest.messenger ?? null
        if (manifest.network === 'mainnet') {
          let accepted = false
          try {
            accepted = localStorage.getItem(riskKey(gen)) === '1'
          } catch {
            /* no storage */
          }
          riskRef.current = accepted
          setRiskAccepted(accepted)
        }
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
        const hub = createPublicClient({
          chain: hubChain,
          transport: rpcTransport(manifest.chainId, manifest.rpc, { batch: true }),
        })
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
              : createPublicClient({ chain, transport: rpcTransport(chainId, rpc, { batch: true }) })
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
            // THIS chain's dollar as the chain has it: the token's decimals
            // and the vault's SCALE. The manifest declares a dollar per chain
            // (USDC 6 on most, Binance USDT 18 on BNB); a chain that says
            // otherwise is not booted — every amount on the screen would be
            // off by a power of ten.
            const declared: Dollar = declaredDollar(manifest.dollar, c)
            scaleOf(declared.decimals) // throws on nonsense
            let dec = declared.decimals
            let scale = scaleOf(dec)
            let verified = false
            let hasMin = false
            let v72 = false
            try {
              const [d, s, code] = await Promise.all([
                read<number>(client, { address: c.usdc!, abi: usdcAbi, functionName: 'decimals' }),
                read<bigint>(client, { address: c.usd, abi: usdAbi, functionName: 'SCALE' }),
                client.getCode({ address: c.gateway }),
              ])
              if (Number(d) !== declared.decimals)
                throw new Error(
                  `${c.id}: the dollar token has ${d} decimals, the manifest says ${declared.decimals}`,
                )
              if (s !== scaleOf(Number(d)))
                throw new Error(`${c.id}: the vault's SCALE is ${s}, not 10^(18-${d})`)
              dec = Number(d)
              scale = s
              verified = true
              const hex = (code ?? '').toLowerCase()
              hasMin = hex.includes(MIN_SELECTOR)
              v72 = hex.includes(OPEN_SELECTOR) && hex.includes(MOVE_SELECTOR)
            } catch (e) {
              // a real mismatch is fatal; a chain that merely did not answer
              // is confirmed before its first transaction (see `sure`)
              if (/decimals, the manifest|SCALE is/.test(String((e as Error).message))) throw e
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
              dollar: declared,
              dec,
              scale,
              verified,
              vault: c.vault ?? (declared.decimals === 6 ? 'cctp' : 'local'),
              hasMin,
              v72,
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
            if (have >= toUnits(50, c.dec)) {
              done++
              continue
            }
          }
          await sure(c)
          await write(c, {
            address: c.usdc,
            abi: usdcAbi,
            functionName: 'mint',
            args: [addr, toUnits(MINT_PER_CHAIN, c.dec)],
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
    return { address: who, balance: ef(dollarsWei(chainStateRef.current)), positions: wallet?.positions ?? {} }
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

  /** Remote chains: reads the pad's events from `fromBlock` until `pick`
   * finds what it is looking for, or `timeoutMs` passes (then null). */
  const waitEvents = useCallback(
    async <T,>(fromBlock: bigint, timeoutMs: number, pick: (logs: Log[]) => T | null): Promise<T | null> => {
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
            const got = pick(logs)
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

  /** Remote chains: wait for the hub to rule on this actor's message. */
  const waitHub = useCallback(
    (token: Address, actor: Address, want: Want, label: number, fromBlock: bigint, timeoutMs: number) =>
      waitEvents(fromBlock, timeoutMs, (logs) => readOutcome(logs, token, actor, want, label)),
    [waitEvents],
  )

  /** Makes sure the vault may pull exactly `units` of the dollar token from
   * the wallet. The approval goes to the vault (it is what moves the token),
   * and it is exact: the gateway can pull from anyone who approved the vault,
   * so a standing unlimited approval would be a standing risk. */
  const approveExact = async (c: ChainIO, owner: Address, units: bigint) => {
    const allowance = await read<bigint>(c.client, {
      address: c.usdc,
      abi: usdcAbi,
      functionName: 'allowance',
      args: [owner, c.usd],
    })
    if (allowance >= units) return
    await write(c, { address: c.usdc, abi: usdcAbi, functionName: 'approve', args: [c.usd, units] })
  }

  /** `amount` dollars (as typed) in chain `c`'s token units and in wei. */
  const dollarsIn = (c: ChainIO, amount: number) => {
    const units = toUnits(amount, c.dec)
    return { units, wei: units * c.scale }
  }
  /** A dollar figure in chain `c`'s own dollar: "$12.50 USDT". */
  const money = (c: ChainIO, units: bigint) =>
    `$${fromUnits(units, c.dec).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c.dollar.symbol}`

  /** The trade is protected when the gateway has the `*Min` entrypoints and
   * the minimum is enforced: in this very transaction (the hub chain, the
   * devnet), or — v7.2 — at the hub, which refuses a crossed trade under it
   * and sends it back whole. A pre-v7.2 remote gateway would always revert
   * them, so there the trade stays unprotected and the page says so. */
  const protectedOn = (c: ChainIO) => c.hasMin && (syncRef.current || c.local || v72Ref.current)

  /**
   * What the hub will do with this trade right now, in its own integers:
   * the fee, the FAIR GENESIS tax and the per-wallet cap included. `fresh`
   * reads the curve and the window straight from the hub (right before
   * signing); otherwise the last poll's figures serve the display.
   */
  const expectRaw = async (
    entry: TokenEntry,
    side: Side,
    amount: number,
    c: ChainIO,
    fresh: boolean,
  ): Promise<RawExpectation> => {
    let curve = entry.curve
    let genesis = genesisRawRef.current[entry.meta.num]
    const addr = activeAddr()
    if (fresh && hubClientRef.current && manifestRef.current) {
      const hub = hubClientRef.current
      const m = manifestRef.current
      const [row, fg] = await Promise.all([
        hub.readContract({
          address: m.pad,
          abi: padAbi,
          functionName: 'getToken',
          args: [BigInt(entry.meta.num - 1)],
        }),
        hub.readContract({
          address: m.pad,
          abi: padAbi,
          functionName: 'fairGenesisOf',
          args: [entry.token, addr ? padHex(addr, { size: 32 }) : ZERO32],
        }),
      ])
      curve = { vBase: row[7], vTokens: row[8], sold: row[9], ascended: row[10] }
      genesis = { snipeBps: fg[1], spent: fg[2], cap: fg[3] }
      entry.curve = curve
    }
    const prot = protectedOn(c)
    if (side === 'buy') {
      const { wei } = dollarsIn(c, amount)
      const e = expectBuy(curve, wei, genesis)
      // a buy the cap would cut is SIZED DOWN to what the hub will take, so
      // nothing rides out only to be refunded (and so a protected minimum
      // can be met at all)
      const spendUnits = e.spendable / c.scale
      return {
        protected: prot,
        expected: e.tokens,
        min: prot ? lessBps(e.tokens, slippageRef.current) : 0n,
        spendWei: spendUnits * c.scale,
        spendUnits,
        clampedWei: wei - spendUnits * c.scale,
        feeBps: e.feeBps,
        tokensWei: 0n,
      }
    }
    const perChain = tokensByChainRef.current.get(entry.meta.num) ?? {}
    const have = perChain[c.id] ?? 0n
    let tokensWei = parseEther(amount.toFixed(18))
    // "sell everything" must not leave float dust behind on the chain
    if (have > 0n && (tokensWei > have || (have - tokensWei) * 1_000_000_000n < have)) tokensWei = have
    const net = expectSell(curve, tokensWei)
    return {
      protected: prot,
      expected: net,
      min: prot ? lessBps(net, slippageRef.current) : 0n,
      spendWei: 0n,
      spendUnits: 0n,
      clampedWei: 0n,
      feeBps: 100n,
      tokensWei,
    }
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
      const usdSym = c.dollar.symbol
      const why = unavailableRef.current[num]?.[chainId]
      if (why)
        return {
          ok: false,
          reason:
            why === 'closed'
              ? `${entry.meta.ticker} is not open on ${up(chainId)} yet — open it there first.`
              : why === 'failed'
                ? `${entry.meta.ticker} is not available on ${up(chainId)} yet — its creation message did not reach that chain; the operator has to send it again.`
                : `${entry.meta.ticker} has not reached ${up(chainId)} yet — give it a minute.`,
        }

      // what the hub will do with it, on a fresh read, in its own integers
      let exp: RawExpectation
      try {
        await sure(c)
        exp = await expectRaw(entry, side, amount, c, true)
      } catch (e) {
        return { ok: false, reason: reasonOf(e, usdSym) }
      }
      let note: string | undefined

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
          const asked = dollarsIn(c, amount)
          // FAIR GENESIS: inside the window a wallet may put at most the cap
          // to work. A buy the cap would cut is sized down to what the hub
          // will take — the rest would only ride out and be refunded — and
          // a wallet at its cap is told so before anything is signed.
          if (exp.spendUnits === 0n) {
            const cap = fairGenesisRef.current[num]?.capUsd ?? 250
            return {
              ok: false,
              reason: `FAIR GENESIS: this wallet has used its $${cap.toLocaleString('en-US')} cap for ${entry.meta.ticker}'s opening window — buy again when the window closes.`,
            }
          }
          if (exp.clampedWei > 0n)
            note = `FAIR GENESIS CAP — SIZED DOWN TO ${money(c, exp.spendUnits)} OF THE ${money(c, asked.units)} ASKED`
          if (exp.spendWei < MIN_AMOUNT) return { ok: false, reason: 'That amount is too small to buy with.' }
          if (exp.protected && exp.min === 0n)
            return { ok: false, reason: 'That amount is too small to buy anything with — nothing would arrive.' }
          const usdUnits = exp.spendUnits
          const usd18 = exp.spendWei
          // spend oUSD claims first (no approval, no vault deposit), else the token
          if (st.ousd >= usd18) {
            receipt = await write(c, {
              address: c.gateway,
              abi: gatewayAbi,
              functionName: exp.protected ? 'buyTokenMin' : 'buyToken',
              args: exp.protected ? [entry.token, usd18, exp.min] : [entry.token, usd18],
              value: fee,
            })
          } else if (st.usdc >= usdUnits) {
            if (st.depositsPaused)
              return { ok: false, reason: `Deposits are paused on ${up(chainId)} for now.` }
            if (st.liquidity + usdUnits > st.depositCap)
              return {
                ok: false,
                reason: `${up(chainId)}'s vault is at its deposit cap (${money(c, st.depositCap)}) — only ${money(c, st.depositCap > st.liquidity ? st.depositCap - st.liquidity : 0n)} of room left.`,
              }
            await approveExact(c, addr, usdUnits)
            receipt = await write(c, {
              address: c.gateway,
              abi: gatewayAbi,
              functionName: exp.protected ? 'buyTokenUsdcMin' : 'buyTokenUsdc',
              args: exp.protected ? [entry.token, usdUnits, exp.min] : [entry.token, usdUnits],
              value: fee,
            })
          } else {
            const ousd = ef(st.ousd)
            return {
              ok: false,
              reason:
                `Only ${money(c, st.usdc)} on ${up(chainId)}` +
                (ousd >= 0.01 ? ` (+ $${ousd.toFixed(2)} in oUSD claims — unwrap them or buy less)` : '') +
                (networkRef.current === 'mainnet'
                  ? ' — fund this chain or pick another.'
                  : ` — hit MINT ${usdSym} or pick another chain.`),
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
          const tokensWei = exp.tokensWei
          if (tokensWei < MIN_AMOUNT) return { ok: false, reason: 'That amount is too small to sell.' }
          if (exp.protected && exp.min === 0n)
            return { ok: false, reason: 'That amount is too small to sell — it would pay out nothing.' }
          receipt = await write(c, {
            address: c.gateway,
            abi: gatewayAbi,
            functionName: exp.protected ? 'sellTokenMin' : 'sellToken',
            args: exp.protected ? [entry.token, tokensWei, exp.min] : [entry.token, tokensWei],
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
          // the hub turned it away and sent it home whole — under its
          // minimum (v7.2, a trade that crossed), or for another reason. It
          // is what happened, not a failure: said plainly, with a retry.
          await poll()
          return {
            ok: false,
            code: 'returned',
            reason: returnedText(side, got.reason, {
              chain: up(chainId),
              ticker: entry.meta.ticker,
              money: side === 'buy' ? money(c, exp.spendUnits) : undefined,
            }),
          }
        }
        if (got?.kind === 'bounced') {
          await poll()
          const cap = fairGenesisRef.current[num]?.capUsd ?? 250
          return {
            ok: false,
            reason: `FAIR GENESIS turned the buy away (spawn block or your $${cap.toLocaleString('en-US')} window cap) — $${got.refunded.toFixed(2)} refunded.`,
          }
        }

        let usd: number
        let tokens: number
        let price: number
        let ascended = false
        let pending = false
        if (got?.kind === 'trade') {
          usd = got.usd
          tokens = got.tokens
          price = got.price
          ascended = got.ascended
          if (got.guardRefund > 0.005)
            note = `FAIR GENESIS CAPPED IT — $${got.guardRefund.toFixed(2)} REFUNDED`
        } else {
          // still in flight (or an unreadable receipt) — the expectation serves
          usd = side === 'buy' ? ef(exp.spendWei) : ef(exp.expected)
          tokens = side === 'buy' ? ef(exp.expected) : ef(exp.tokensWei)
          price = entry.market.state.vBase / entry.market.state.vTokens
          pending = !instant
          note = pending
            ? exp.protected
              ? 'STILL CROSSING CHAINS — IT FILLS AT YOUR MINIMUM OR BETTER, OR COMES BACK WHOLE'
              : 'STILL CROSSING CHAINS — YOUR BALANCE UPDATES WHEN IT LANDS'
            : note
        }
        // a sell paid as a claim instead of the dollar token is worth saying out loud
        if (side === 'sell' && instant) {
          const paid = parseEventLogs({ abi: usdAbi, logs: receipt.logs }).find(
            (e) => e.eventName === 'PaidOut' && String(e.args.to).toLowerCase() === addr.toLowerCase(),
          )
          if (paid && paid.args.usdcOut === 0n && paid.args.minted >= c.scale)
            note = c.v72
              ? `${up(chainId)}'S VAULT IS SHORT — PAID AS AN oUSD CLAIM: UNWRAP IT LATER, OR MOVE IT TO A CHAIN THAT CAN PAY (PORTFOLIO)`
              : `${up(chainId)}'S VAULT IS SHORT — PAID AS AN oUSD CLAIM, UNWRAP IT WHEN LIQUIDITY RETURNS`
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
        // the protection doing its job is not a failure: nothing moved, and
        // trying again (or widening the tolerance) is the whole remedy
        if (isMinOut(e)) {
          void poll().catch(() => undefined)
          return { ok: false, reason: minOutReason(e), code: 'min-out' }
        }
        return { ok: false, reason: reasonOf(e, usdSym) }
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

      // Where other people see the token (public testnet, mainnet) it must
      // carry its real image: the hosted path has to be in the metaURI. A
      // local devnet has no image function and keeps the creator's own copy.
      if (networkRef.current !== 'local' && !hostedImagePath(input.imageUrl))
        throw new Error('A token needs its image — pick one, it is hosted when you launch.')

      const { name, ticker, metaURI } = spawnArgs(input)
      if (utf8Len(name) > MAX_NAME_BYTES) throw new Error('That name is too long.')
      if (utf8Len(ticker) > MAX_SYMBOL_BYTES) throw new Error('That ticker is too long.')
      if (utf8Len(metaURI) > MAX_META_BYTES) throw new Error('Those links are too long — shorten them.')

      const devBuy = input.devBuyUsd ?? 0
      await sure(c)
      const { units: usdUnits, wei: usd18 } = devBuy > 0 ? dollarsIn(c, devBuy) : { units: 0n, wei: 0n }
      if (devBuy > 0 && usd18 < MIN_AMOUNT) throw new Error('That dev buy is too small.')
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
        if (usdUnits > 0n && st.ousd >= usd18) {
          receipt = await write(c, {
            address: c.gateway,
            abi: gatewayAbi,
            functionName: 'spawnToken',
            args: [name, ticker, metaURI, usd18, feeMode],
            value: fee,
          })
        } else {
          if (usdUnits > 0n) {
            if (st.usdc < usdUnits)
              throw new Error(`Only ${money(c, st.usdc)} on ${up(c.id)} for the dev buy.`)
            if (st.depositsPaused || st.liquidity + usdUnits > st.depositCap)
              throw new Error(
                `${up(c.id)}'s vault cannot take a ${money(c, usdUnits)} deposit right now (deposit cap).`,
              )
            await approveExact(c, addr, usdUnits)
          }
          receipt = await write(c, {
            address: c.gateway,
            abi: gatewayAbi,
            functionName: 'spawnTokenUsdc',
            args: [name, ticker, metaURI, usdUnits, feeMode],
            value: fee,
          })
        }
      } catch (e) {
        throw new Error(reasonOf(e, c.dollar.symbol))
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
          localStorage.setItem(`spawn.img.${scopeRef.current}.${token.toLowerCase()}`, input.image)
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

  /** Turns the wallet's oUSD claims on one chain back into its dollar token,
   * as far as that chain's vault can pay right now. Returns the dollars
   * received. Only whole token units unwrap: sub-unit oUSD dust (none with an
   * 18-decimal dollar) stays as a claim. */
  const unwrap = useCallback(
    async (chainId: string): Promise<number> => {
      const c = io(chainId)
      if (!c || !activeAddr()) return 0
      if (!cleared()) return 0
      await sure(c)
      const st = stateOf(chainId)
      let units = st.ousd / c.scale
      if (units > st.liquidity) units = st.liquidity
      if (units === 0n) return 0
      try {
        await write(c, { address: c.usd, abi: usdAbi, functionName: 'unwrap', args: [units * c.scale] })
      } catch (e) {
        throw new Error(reasonOf(e, c.dollar.symbol))
      }
      await poll()
      return fromUnits(units, c.dec)
    },
    [poll],
  )

  /* ------------------- v7.2: open a token, move a claim ------------------- */

  /**
   * Would the hub send `entry`'s SYNC to chain `c` right now? The hub sends
   * the SYNC an open asks for only if its live quote for that leg (its
   * adapter's `quote(label, gateway, syncPayload, 0)`, asked AS the pad) is
   * at most `requestCap(label)`. Checked before an open is offered, so no
   * fee is ever taken for an open the hub would decline.
   */
  const openPrice = async (
    entry: TokenEntry,
    c: ChainIO,
  ): Promise<{ ok: true; fee: bigint } | { ok: false; reason: string; tooDear?: boolean }> => {
    const hub = hubClientRef.current
    const m = manifestRef.current
    if (!hub || !m) return { ok: false, reason: 'Chain offline.' }
    if (!c.v72) return { ok: false, reason: `${up(c.id)}'s gateway predates v7.2: tokens cannot be opened from there.` }
    const [cap, gw, adapter] = await Promise.all([
      hub.readContract({ address: m.pad, abi: padAbi, functionName: 'requestCap', args: [c.label] }),
      hub.readContract({ address: m.pad, abi: padAbi, functionName: 'gateways', args: [c.label] }),
      hubMessengerRef.current ?? hub.readContract({ address: m.pad, abi: padAbi, functionName: 'messenger' }),
    ])
    // the payload the pad would send: SpawnPad._syncPayload, from the name
    // and symbol it stored
    const sync = encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'bytes' }],
      [
        OP_SYNC_TOKEN,
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'string' }, { type: 'string' }],
          [padHex(entry.token, { size: 32 }), entry.meta.name, entry.meta.ticker],
        ),
      ],
    )
    let quote: bigint | null = null
    try {
      quote = await hub.readContract({
        address: adapter as Address,
        abi: messengerAbi,
        functionName: 'quote',
        args: [c.label, gw, sync, 0n],
        account: m.pad,
      })
    } catch {
      quote = null
    }
    const v = openVerdict(quote, cap)
    if (!v.ok)
      return v.why === 'too-dear'
        ? {
            ok: false,
            tooDear: true,
            reason: `${up(c.id)} is too expensive right now: at today's price the hub would not send $${entry.meta.ticker} there, so no fee is taken. Try again later.`,
          }
        : { ok: false, reason: `The hub cannot price a message to ${up(c.id)} right now. Try again later.` }
    return { ok: true, fee: await feeFor(c, 'quoteOpen') }
  }

  const checkOpen = useCallback(async (num: number, chainId: string): Promise<OpenCheck> => {
    const entry = entriesRef.current.get(num)
    const c = io(chainId)
    if (!entry || !c) return { ok: false, reason: 'Chain offline.' }
    try {
      const p = await openPrice(entry, c)
      return p.ok ? { ok: true, fee: ef(p.fee) } : p
    } catch (e) {
      return { ok: false, reason: reasonOf(e, c.dollar.symbol) }
    }
  }, [])

  /** Asks the hub for this chain's replica of a token that never reached
   * it. The caller pays the round trip in this chain's gas coin; the replica
   * arrives with the hub's reply (in the same transaction on the devnet and
   * the hub chain, minutes later from anywhere else). */
  const openToken = useCallback(
    async (num: number, chainId: string): Promise<ActionResult> => {
      const addr = activeAddr()
      const entry = entriesRef.current.get(num)
      const c = io(chainId)
      if (!addr || !entry || !c || !hubClientRef.current) return { ok: false, reason: 'Chain offline.' }
      if (!connectedRef.current) return { ok: false, reason: 'Connect a wallet first.' }
      if (!cleared()) return { ok: false, reason: 'Read and accept the risk notice first.' }
      if (stateOf(chainId).paused) return { ok: false, reason: `${up(chainId)} is paused — opens are closed for now.` }
      try {
        const p = await openPrice(entry, c)
        if (!p.ok) return { ok: false, reason: p.reason }
        const sym = c.chain.nativeCurrency.symbol
        const gas = await c.client.getBalance({ address: addr })
        if (gas < p.fee + parseEther('0.00002'))
          return {
            ok: false,
            reason: `Not enough ${sym} on ${up(chainId)}: opening needs ~${ef(p.fee).toFixed(5)} ${sym} of network fee plus gas.`,
          }
        const hubMark = (await hubClientRef.current.getBlockNumber({ cacheTime: 0 })) + 1n
        const receipt = await write(c, {
          address: c.gateway,
          abi: gatewayAbi,
          functionName: 'openToken',
          args: [entry.token],
          value: p.fee,
        })
        const instant = syncRef.current || c.local
        const got = instant
          ? readOpen(hubEvents(receipt.logs), entry.token, c.label)
          : await waitEvents(hubMark, 300_000, (logs) => readOpen(hubEvents(logs), entry.token, c.label))
        replicaCache.current.delete(`${chainId}:${entry.token}`)
        await poll()
        if (got === 'failed')
          return {
            ok: false,
            reason: `The hub did not send it: a message to ${up(chainId)} cost more than its ceiling when your request arrived. The fee paid for that attempt; $${entry.meta.ticker} is still closed there — try again later.`,
          }
        if (got === 'unknown-token') return { ok: false, reason: 'The hub does not know this token.' }
        if (got === 'opened' && instant)
          return { ok: true, pending: false, text: `$${entry.meta.ticker} IS OPEN ON ${up(chainId)} — TRADE IT THERE NOW ✓` }
        return {
          ok: true,
          pending: true,
          text: `OPEN REQUEST SENT FROM ${up(chainId)} — $${entry.meta.ticker} ARRIVES WITH THE HUB'S REPLY IN A FEW MINUTES.`,
        }
      } catch (e) {
        return { ok: false, reason: reasonOf(e, c.dollar.symbol) }
      }
    },
    [poll, waitEvents],
  )

  /** The source gateway's price for a move to `d`, or null when that route
   * is closed ("GW: route closed": not offered). */
  const movePrice = async (c: ChainIO, d: ChainIO): Promise<bigint | null> => {
    try {
      const q = await read<bigint>(c.client, {
        address: c.gateway,
        abi: gatewayAbi,
        functionName: 'quoteMove',
        args: [d.label],
      })
      if (sponsoredRef.current) return 0n
      return syncRef.current || c.local ? q : (q * 110n) / 100n
    } catch {
      return null
    }
  }

  /** The chains a claim of `amount` dollars held on `from` can be moved to:
   * a priced route, and a vault there that can pay it in full now. */
  const moveOptions = useCallback(async (from: string, amount: number): Promise<MoveOption[]> => {
    const c = io(from)
    if (!c || !c.v72 || !(amount > 0)) return []
    const want = toUnits(amount, 18)
    const routes = await Promise.all(
      iosRef.current
        .filter((d) => d.id !== c.id && d.v72)
        .map(async (d) => {
          const [fee, liquidity] = await Promise.all([
            movePrice(c, d),
            read<bigint>(d.client, { address: d.usd, abi: usdAbi, functionName: 'liquidity' }).catch(
              () => stateOf(d.id).liquidity,
            ),
          ])
          return { chain: d.id, fee, liquidity, scale: d.scale, dec: d.dec }
        }),
    )
    return moveTargets(want, routes).map((r) => ({
      chain: r.chain,
      fee: ef(r.fee ?? 0n),
      liquidity: fromUnits(r.liquidity, routes.find((x) => x.chain === r.chain)!.dec),
    }))
  }, [])

  /** Sends `amount` dollars of the wallet's claim on `from` to chain `to`,
   * where that vault pays it in its own dollar (or as a claim there, if it
   * ran short meanwhile). If the hub cannot hand it on, it comes home. */
  const moveClaim = useCallback(
    async (from: string, to: string, amount: number, recipient?: string): Promise<ActionResult> => {
      const addr = activeAddr()
      const c = io(from)
      const d = io(to)
      if (!addr || !c || !d || !hubClientRef.current) return { ok: false, reason: 'Chain offline.' }
      if (!connectedRef.current) return { ok: false, reason: 'Connect a wallet first.' }
      if (!cleared()) return { ok: false, reason: 'Read and accept the risk notice first.' }
      if (!c.v72 || !d.v72) return { ok: false, reason: 'Moves need the v7.2 gateways on both chains.' }
      let dest: Address = addr
      if (recipient && recipient.trim()) {
        try {
          dest = getAddress(recipient.trim())
        } catch {
          return { ok: false, reason: 'That recipient is not an address.' }
        }
      }
      const st = stateOf(from)
      let wei = toUnits(amount, 18)
      // "the whole claim" must not leave float dust behind
      if (wei > st.ousd || st.ousd - wei < CLAIM_DUST) wei = st.ousd
      if (wei < MIN_AMOUNT) return { ok: false, reason: 'That amount is too small to move.' }
      try {
        const fee = await movePrice(c, d)
        if (fee === null) return { ok: false, reason: `Moves from ${up(from)} to ${up(to)} are closed right now.` }
        const sym = c.chain.nativeCurrency.symbol
        const gas = await c.client.getBalance({ address: addr })
        if (gas < fee + parseEther('0.00002'))
          return {
            ok: false,
            reason: `Not enough ${sym} on ${up(from)}: the move needs ~${ef(fee).toFixed(5)} ${sym} of network fee plus gas.`,
          }
        const hubMark = (await hubClientRef.current.getBlockNumber({ cacheTime: 0 })) + 1n
        const receipt = await write(c, {
          address: c.gateway,
          abi: gatewayAbi,
          functionName: 'moveClaim',
          args: [d.label, padHex(dest, { size: 32 }), wei],
          value: fee,
        })
        const instant = syncRef.current || c.local
        const q = { from: addr, label: c.label, dst: d.label }
        const got = instant
          ? readMove(hubEvents(receipt.logs), q)
          : await waitEvents(hubMark, 240_000, (logs) => readMove(hubEvents(logs), q))
        const usd = `$${ef(wei).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        await poll()
        if (got && !got.forwarded)
          return {
            ok: false,
            code: 'returned',
            reason: `The hub could not hand your ${usd} on to ${up(to)} right now, so it came back to you on ${up(from)} as the same claim. Only the network fee is spent.`,
          }
        if (got && instant) {
          // the destination vault's payout sits in this same receipt
          const paid = parseEventLogs({ abi: usdAbi, logs: receipt.logs }).find(
            (e) =>
              e.eventName === 'PaidOut' &&
              e.address.toLowerCase() === d.usd.toLowerCase() &&
              String(e.args.to).toLowerCase() === dest.toLowerCase(),
          )
          if (paid && paid.eventName === 'PaidOut' && paid.args.usdcOut > 0n)
            return {
              ok: true,
              pending: false,
              text: `${money(d, paid.args.usdcOut)} PAID ON ${up(to)}${dest === addr ? '' : ` TO ${dest.slice(0, 8)}…`} ✓`,
            }
          return {
            ok: true,
            pending: false,
            text: `${usd} ARRIVED ON ${up(to)} AS AN oUSD CLAIM — THAT VAULT RAN SHORT MEANWHILE; IT STAYS VALID THERE.`,
          }
        }
        return {
          ok: true,
          pending: true,
          text: `${usd} ON ITS WAY TO ${up(to)} — PAID THERE IN ${d.dollar.symbol} WITHIN A FEW MINUTES (OR AS A CLAIM THERE IF THAT VAULT RUNS SHORT MEANWHILE).`,
        }
      } catch (e) {
        return { ok: false, reason: reasonOf(e, c.dollar.symbol) }
      }
    },
    [poll, waitEvents],
  )

  /** What a trade does right now, for the screen: the last poll's curve and
   * window, the hub's arithmetic, the user's tolerance. */
  const expect = useCallback(
    (num: number, side: Side, amount: number, chainId: string): TradeExpectation | null => {
      const entry = entriesRef.current.get(num)
      const c = io(chainId)
      if (!entry || !c || !(amount > 0)) return null
      const prot = protectedOn(c)
      if (side === 'buy') {
        const { wei } = dollarsIn(c, amount)
        const e = expectBuy(entry.curve, wei, genesisRawRef.current[num])
        const spendUnits = e.spendable / c.scale
        return {
          protected: prot,
          expected: ef(e.tokens),
          min: prot ? ef(lessBps(e.tokens, slippageRef.current)) : ef(e.tokens),
          spend: ef(spendUnits * c.scale),
          clamped: ef(wei - spendUnits * c.scale),
          feeRate: Number(e.feeBps) / 10_000,
        }
      }
      const have = tokensByChainRef.current.get(num)?.[chainId] ?? 0n
      let tokensWei = parseEther(amount.toFixed(18))
      if (have > 0n && (tokensWei > have || (have - tokensWei) * 1_000_000_000n < have)) tokensWei = have
      const net = expectSell(entry.curve, tokensWei)
      return {
        protected: prot,
        expected: ef(net),
        min: prot ? ef(lessBps(net, slippageRef.current)) : ef(net),
        feeRate: 0.01,
      }
    },
    [],
  )

  const slippage = useMemo(
    () => ({
      bps: slippageBps,
      set: (bps: number) => {
        const v = Math.min(MAX_SLIPPAGE_BPS, Math.max(MIN_SLIPPAGE_BPS, Math.round(bps)))
        slippageRef.current = v
        setSlippageBps(v)
        try {
          localStorage.setItem(LS_SLIPPAGE, String(v))
        } catch {
          /* no storage */
        }
      },
    }),
    [slippageBps],
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
        dollar: { symbol: c.dollar.symbol, decimals: c.dec },
        vault: c.vault,
        v72: c.v72,
        usdc: fromUnits(s.usdc, c.dec),
        ousd: ef(s.ousd),
        protected: protectedOn(c),
        gas: ef(s.gas),
        nativeSymbol: c.chain.nativeCurrency.symbol,
        liquidity: fromUnits(s.liquidity, c.dec),
        depositCap: fromUnits(s.depositCap, c.dec),
        depositsPaused: s.depositsPaused,
        paused: s.paused,
        fee: {
          buy: ef(s.fee.buy),
          sell: ef(s.fee.sell),
          claim: ef(s.fee.claim),
          pull: ef(s.fee.pull),
          open: ef(s.fee.open),
        },
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
                localStorage.setItem(riskKey(generationRef.current), '1')
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
        generation,
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
        expect,
        slippage,
        unavailable: unavailableRef.current,
        checkOpen,
        openToken,
        moveOptions,
        moveClaim,
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
      generation,
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
      expect,
      slippage,
      checkOpen,
      openToken,
      moveOptions,
      moveClaim,
      quoteSpawnFee,
      risk,
    ],
  )

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
}
