/**
 * The on-chain store: same StoreValue contract as the sim provider, but every
 * number is read from a real SPAWN! deployment and every action is a real
 * transaction signed by a burner wallet.
 *
 * Works against two worlds through one manifest format:
 *  - LOCAL devnet: every logical chain lives on one hardhat node; omnichain
 *    messages deliver synchronously (results parse out of the same receipt).
 *  - PUBLIC TESTNET: the hub is Base Sepolia and each spoke is its own
 *    network; messages travel over live LayerZero, so results land on the
 *    hub minutes after the spoke tx — we poll for them.
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
  parseAbi,
  parseEther,
  parseEventLogs,
  type Address,
  type Chain,
  type PublicClient,
} from 'viem'
import { narrowActor } from '../lib/format'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import {
  StoreCtx,
  deriveCreature,
  type CreatureMeta,
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
import { FEE_MODE_INDEX, distributorAbi, gatewayAbi, padAbi, tokenAbi, usdAbi, type Manifest } from './abi'
import type { FaceId } from '../components/Faces'

const FEE_MODE_NAME: readonly FeeMode[] = ['holders', 'split', 'dev', 'burn']
// Fallback for protocol-v2 pads, whose FeeState has no holdersPaid yet.
const feesOfV2Abi = parseAbi([
  'function feesOf(address token) view returns (uint8 mode, uint256 total, uint256 holders, uint256 dev, uint256 devClaimed, uint256 burnPot, uint256 burnedUsd, uint256 burnedTokens)',
])
const PALETTE = ['#b5e95b', '#f7a8ce', '#9ccbf5', '#a78bf0', '#f7be7b', '#8be0d4']
/** v5 wire identities are bytes32. Narrow EVM-shaped ones back to their
 * checksummed address so every comparison with wallet addresses keeps
 * working; a wide (Solana) identity stays full-width lowercase. */
const toActor = (b32: string): string => {
  const n = narrowActor(b32)
  return n.length === 42 ? getAddress(n) : n
}
const AIRDROP_PER_CHAIN = 1337
const ZERO = '0x0000000000000000000000000000000000000000'
// Hardhat's well-known dev account #0 — funds burner wallets with gas on the
// LOCAL dev chain only. Never reuse outside a throwaway devnet.
const FUNDER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
// Public RPCs cap eth_getLogs hard (Base Sepolia: 200 blocks per call).
const LOG_CHUNK_LOCAL = 100_000n
const LOG_CHUNK_PUBLIC = 199n
// Testnet first load only backfills this many hub blocks of tape (~33h on
// Base's 2s blocks) — keeps page loads fast on capped public RPCs.
const BACKFILL_BLOCKS = 60_000n

const ef = (v: bigint) => Number(formatEther(v))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface TokenEntry {
  meta: CreatureMeta
  token: Address
  market: Market
}

/** One spoke network: its contracts and a client to reach it. */
interface ChainIO {
  id: string
  label: number
  gateway: Address
  usd: Address
  chain: Chain
  client: PublicClient
}

function mkChain(id: number, rpc: string, name: string): Chain {
  return defineChain({
    id,
    name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
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
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hexId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
        },
      ],
    })
    // some wallets add the chain without switching to it
    await provider
      .request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] })
      .catch(() => undefined)
  }
}

function loadCosts(addr: string): Record<number, number> {
  try {
    return JSON.parse(localStorage.getItem(`spawn.cost.${addr}`) ?? '{}')
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

  const manifestRef = useRef<Manifest | null>(null)
  const hubClientRef = useRef<PublicClient | null>(null)
  const hubChainRef = useRef<Chain | null>(null)
  const iosRef = useRef<ChainIO[]>([])
  const isLocalRef = useRef(true)
  const burnerRef = useRef<PrivateKeyAccount | null>(null)
  const entriesRef = useRef<Map<number, TokenEntry>>(new Map())
  const replicaCache = useRef<Map<string, Address>>(new Map())
  const usdByChainRef = useRef<Record<string, bigint>>({})
  const gasByChainRef = useRef<Record<string, bigint>>({})
  const tokensByChainRef = useRef<Map<number, Record<string, bigint>>>(new Map())
  /** Per-chain FeeDistributor (protocol v3); null = probed, none there (v2). */
  const distByChainRef = useRef<Record<string, Address | null>>({})
  /** Unclaimed holder rewards: creature num -> chain id -> wei. */
  const rewardsByChainRef = useRef<Map<number, Record<string, bigint>>>(new Map())
  const rewardsRef = useRef<Record<number, number>>({})
  const lastBlockRef = useRef(0n)
  const connectedRef = useRef(false)
  const costsRef = useRef<Record<number, number>>({})
  const sourceRef = useRef<WalletSource>('burner')
  const injectedRef = useRef<Address | null>(null)
  const [walletSource, setWalletSource] = useState<WalletSource>('burner')

  const io = (chainId: string) => iosRef.current.find((c) => c.id === chainId)
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

  const saveCosts = () => {
    const addr = activeAddr()
    if (!addr) return
    try {
      localStorage.setItem(`spawn.cost.${addr}`, JSON.stringify(costsRef.current))
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
    const addr = (await c.client.readContract({
      address: c.gateway,
      abi: gatewayAbi,
      functionName: 'replicaOf',
      args: [token],
    })) as Address
    if (addr !== ZERO) replicaCache.current.set(key, addr)
    return addr
  }, [])

  const poll = useCallback(async () => {
    const hub = hubClientRef.current
    const m = manifestRef.current
    if (!hub || !m) return

    // 1. token roster + curve state + fees (hub)
    const len = Number(
      await hub.readContract({ address: m.pad, abi: padAbi, functionName: 'tokensLength' }),
    )
    for (let i = 0; i < len; i++) {
      const num = i + 1
      const [token, name, symbol, metaURI, creator, spawnedAt, , vBase, vTokens, sold, ascended] =
        (await hub.readContract({
          address: m.pad,
          abi: padAbi,
          functionName: 'getToken',
          args: [BigInt(i)],
        })) as [Address, string, string, string, Address, bigint, number, bigint, bigint, bigint, boolean, bigint]

      let entry = entriesRef.current.get(num)
      if (!entry) {
        const parsed = parseMetaURI(metaURI)
        // Images live off-chain (IPFS in production; this browser's storage
        // on dev/test deployments) — metaURI stays tiny.
        let image = parsed.image
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
            spawnedAt: Number(spawnedAt) * 1000,
            // every on-chain token was launched by someone; `creator` gates
            // the dev dashboard to the launches of the connected wallet
            custom: true,
            creator: toActor(creator),
            feeMode: parsed.feeMode,
          },
          market: {
            state: { phase: 'curve', vBase: 0, vTokens: 1, sold: 0 },
            trades: [],
            history: [{ ts: Number(spawnedAt) * 1000, price: 6000 / 1.073e9 }],
            volume: 0,
            chainTokens: {},
            balances: new Map(),
            fees: emptyFees(parsed.feeMode ?? 'holders'),
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

      let fRow: readonly [number, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
      try {
        fRow = (await hub.readContract({
          address: m.pad,
          abi: padAbi,
          functionName: 'feesOf',
          args: [token],
        })) as typeof fRow
      } catch {
        // a v2 pad answers with one field fewer — read it that way
        const v2 = (await hub.readContract({
          address: m.pad,
          abi: feesOfV2Abi,
          functionName: 'feesOf',
          args: [token],
        })) as readonly [number, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
        fRow = [...v2, 0n]
      }
      const [fm, fTotal, fHolders, fDev, fDevClaimed, fBurnPot, fBurnedUsd, fBurnedTokens, fHoldersPaid] = fRow
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

    // 2. event tape -> history, volume, holders, chain allocation (hub)
    const latest = await hub.getBlockNumber()
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
            ts: Number(a.ts) * 1000,
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
          if (entry) entry.market.ascendedAt = Number(log.args.ts) * 1000
        }
      }
    }

    // 3. active wallet balances: oUSD + gas + token positions, per spoke network
    const addr = activeAddr()
    if (addr && connectedRef.current) {
      const usdByChain: Record<string, bigint> = {}
      const gasByChain: Record<string, bigint> = {}
      for (const c of iosRef.current) {
        try {
          usdByChain[c.id] = (await c.client.readContract({
            address: c.usd,
            abi: usdAbi,
            functionName: 'balanceOf',
            args: [addr],
          })) as bigint
          gasByChain[c.id] = await c.client.getBalance({ address: addr })
        } catch {
          usdByChain[c.id] = usdByChainRef.current[c.id] ?? 0n
        }
      }
      usdByChainRef.current = usdByChain
      gasByChainRef.current = gasByChain
      const positions: Wallet['positions'] = {}
      const rewards: Record<number, number> = {}
      for (const [num, entry] of entriesRef.current) {
        const perChain: Record<string, bigint> = {}
        const rewardPerChain: Record<string, bigint> = {}
        let sum = 0n
        let unclaimed = 0n
        for (const c of iosRef.current) {
          try {
            const rep = await replicaAddr(c.id, entry.token)
            if (rep === ZERO) continue
            const bal = (await c.client.readContract({
              address: rep,
              abi: tokenAbi,
              functionName: 'balanceOf',
              args: [addr],
            })) as bigint
            perChain[c.id] = bal
            sum += bal
            // protocol v3: this chain's distributor may owe the wallet a
            // slice of the holder fee stream
            const dist = distByChainRef.current[c.id]
            if (dist) {
              const w = (await c.client.readContract({
                address: dist,
                abi: distributorAbi,
                functionName: 'withdrawable',
                args: [rep, addr],
              })) as bigint
              if (w > 0n) {
                rewardPerChain[c.id] = w
                unclaimed += w
              }
            }
          } catch {
            /* spoke briefly unreachable — keep going */
          }
        }
        tokensByChainRef.current.set(num, perChain)
        rewardsByChainRef.current.set(num, rewardPerChain)
        if (unclaimed > 0n) rewards[num] = ef(unclaimed)
        if (sum > 0n) positions[num] = { tokens: ef(sum), cost: costsRef.current[num] ?? 0 }
      }
      rewardsRef.current = rewards
      const totalUsd = Object.values(usdByChain).reduce((a, b) => a + b, 0n)
      setWallet({ address: addr, balance: ef(totalUsd), positions })
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
        manifestRef.current = manifest
        isLocalRef.current = manifest.chainId === 31337

        const hubChain = mkChain(manifest.chainId, manifest.rpc, 'spawn-hub')
        hubChainRef.current = hubChain
        const hub = createPublicClient({ chain: hubChain, transport: http(manifest.rpc, { batch: true }) })
        await hub.getChainId()
        hubClientRef.current = hub
        lastBlockRef.current = BigInt(manifest.fromBlock ?? 0)
        if (!isLocalRef.current) {
          const tip = await hub.getBlockNumber()
          const floor = tip > BACKFILL_BLOCKS ? tip - BACKFILL_BLOCKS : 0n
          if (floor > lastBlockRef.current) lastBlockRef.current = floor
        }

        iosRef.current = manifest.chains.map((c) => {
          const chainId = c.chainId ?? manifest.chainId
          const rpc = c.rpc ?? manifest.rpc
          const sameAsHub = chainId === manifest.chainId && rpc === manifest.rpc
          const chain = sameAsHub ? hubChain : mkChain(chainId, rpc, `spawn-${c.id}`)
          return {
            id: c.id,
            label: c.label,
            gateway: c.gateway,
            usd: c.usd,
            chain,
            client: sameAsHub
              ? hub
              : createPublicClient({ chain, transport: http(rpc, { batch: true }) }),
          }
        })

        // probe each gateway for its FeeDistributor (absent on v2 deployments)
        for (const c of iosRef.current) {
          try {
            const d = (await c.client.readContract({
              address: c.gateway,
              abi: gatewayAbi,
              functionName: 'distributor',
            })) as Address
            distByChainRef.current[c.id] = d === ZERO ? null : d
          } catch {
            distByChainRef.current[c.id] = null
          }
        }

        burnerRef.current = loadBurner()
        costsRef.current = loadCosts(burnerRef.current.address)
        // if this burner has gas anywhere, resume it silently
        for (const c of iosRef.current) {
          const eth = await c.client.getBalance({ address: burnerRef.current.address }).catch(() => 0n)
          if (eth > 0n) {
            connectedRef.current = true
            break
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
              injectedRef.current = accounts[0] as Address
              sourceRef.current = 'injected'
              setWalletSource('injected')
              costsRef.current = loadCosts(accounts[0])
              connectedRef.current = true
            }
          }
        } catch {
          /* wallet locked or gone — the burner stays the fallback */
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
        injectedRef.current = accounts[0] as Address
        costsRef.current = loadCosts(accounts[0])
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

  /** Faucets oUSD on every spoke where the active wallet can pay for gas. */
  const airdrop = useCallback(async () => {
    const addr = activeAddr()
    if (!addr) throw new Error('chain offline')
    let done = 0
    for (const c of iosRef.current) {
      try {
        const gas = await c.client.getBalance({ address: addr })
        if (gas === 0n) continue
        const hash = await (await wcFor(c)).writeContract({
          address: c.usd,
          abi: usdAbi,
          functionName: 'faucet',
          args: [addr, parseEther(String(AIRDROP_PER_CHAIN))],
          chain: c.chain,
          account: activeAccount(),
        })
        await c.client.waitForTransactionReceipt({ hash })
        done++
      } catch {
        /* chain unreachable or faucet capped — keep going */
      }
    }
    await poll()
    if (done === 0) throw new Error('no gas on any chain — the wallet needs testnet ETH first')
  }, [poll])

  const connect = useCallback(async (source?: WalletSource): Promise<Wallet> => {
    const m = manifestRef.current
    if (!m || !burnerRef.current) throw new Error('chain offline')

    // no explicit choice → resume whatever source was used last time
    let src: WalletSource = source ?? 'burner'
    if (!source) {
      try {
        if (localStorage.getItem(LS_SOURCE) === 'injected' && injectedProvider()) src = 'injected'
      } catch {
        /* no storage */
      }
    }
    if (src === 'injected') {
      const provider = injectedProvider()
      if (!provider) throw new Error('No wallet extension found — use the burner instead.')
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
      injectedRef.current = accounts[0] as Address
      sourceRef.current = 'injected'
      setWalletSource('injected')
    } else {
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
    // the body below funds/drips whichever signer is now active
    const burner = { address: activeAddr()! }
    costsRef.current = loadCosts(burner.address)

    if (isLocalRef.current) {
      // local devnet: gas comes from hardhat's dev faucet account
      const hub = hubClientRef.current!
      const eth = await hub.getBalance({ address: burner.address })
      if (eth < parseEther('1')) {
        const funder = privateKeyToAccount(FUNDER_PK)
        const funderClient = createWalletClient({
          account: funder,
          chain: hubChainRef.current!,
          transport: http(m.rpc),
        })
        const hash = await funderClient.sendTransaction({
          to: burner.address,
          value: parseEther('100'),
          chain: hubChainRef.current!,
          account: funder,
        })
        await hub.waitForTransactionReceipt({ hash })
      }
    } else if (m.gasDrip) {
      // public testnet: ask the gas drip to wet new burners
      try {
        await fetch(m.gasDrip, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: burner.address }),
        })
        await sleep(4000)
      } catch {
        /* drip offline — the user can still fund the burner by hand */
      }
    }

    connectedRef.current = true
    try {
      await airdrop()
    } catch {
      /* no gas yet — connected with an empty wallet; UI shows the state */
    }
    const total = Object.values(usdByChainRef.current).reduce((a, b) => a + b, 0n)
    return {
      address: burner.address,
      balance: ef(total),
      positions: wallet?.positions ?? {},
    }
  }, [airdrop, wallet])

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

  /** Testnet: wait for the hub to receive this trader's Trade via LayerZero. */
  const waitHubTrade = useCallback(
    async (token: Address, trader: Address, fromBlock: bigint, timeoutMs: number) => {
      const hub = hubClientRef.current!
      const m = manifestRef.current!
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        try {
          const latest = await hub.getBlockNumber()
          if (latest >= fromBlock) {
            const logs = await getLogsChunked(
              hub,
              m.pad,
              fromBlock,
              latest,
              isLocalRef.current ? LOG_CHUNK_LOCAL : LOG_CHUNK_PUBLIC,
            )
            const parsed = parseEventLogs({ abi: padAbi, logs })
            const t = parsed.find(
              (e) =>
                e.eventName === 'Trade' &&
                (e.args.token as string).toLowerCase() === token.toLowerCase() &&
                narrowActor(e.args.trader as string) === trader.toLowerCase(),
            )
            if (t) {
              const a = t.args as { usd: bigint; tokens: bigint; priceAfter: bigint }
              return {
                usd: ef(a.usd),
                tokens: ef(a.tokens),
                price: ef(a.priceAfter),
                ascended: parsed.some(
                  (e) =>
                    e.eventName === 'Ascended' &&
                    (e.args.token as string).toLowerCase() === token.toLowerCase(),
                ),
              }
            }
          }
        } catch {
          /* transient RPC hiccup */
        }
        await sleep(6000)
      }
      return null
    },
    [],
  )

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
        const have = iosRef.current.map((x) => x.id.toUpperCase()).join(' + ')
        return { ok: false, reason: `${chainId.toUpperCase()} isn't live on this deployment yet — try ${have}.` }
      }
      if (!isLocalRef.current) {
        const gas = gasByChainRef.current[chainId] ?? (await c.client.getBalance({ address: addr }))
        if (gas < parseEther('0.00002')) {
          return {
            ok: false,
            reason: `No gas on ${chainId.toUpperCase()} — send a drop of testnet ETH to your wallet ${addr.slice(0, 8)}…`,
          }
        }
      }

      try {
        const hubMark = await hubClientRef.current.getBlockNumber()
        let hash: `0x${string}`
        if (side === 'buy') {
          const usdWei = parseEther(amount.toFixed(6))
          const have = usdByChainRef.current[chainId] ?? 0n
          if (have < usdWei) {
            return {
              ok: false,
              reason: `Only $${Number(formatEther(have)).toFixed(2)} oUSD on ${chainId.toUpperCase()} — hit AIRDROP or pick another chain.`,
            }
          }
          hash = await (await wcFor(c)).writeContract({
            address: c.gateway,
            abi: gatewayAbi,
            functionName: 'buyToken',
            args: [entry.token, usdWei],
            chain: c.chain,
            account: activeAccount(),
          })
        } else {
          const perChain = tokensByChainRef.current.get(num) ?? {}
          const have = perChain[chainId] ?? 0n
          if (have === 0n) {
            const where = Object.entries(perChain)
              .filter(([, v]) => v > 0n)
              .map(([k]) => k.toUpperCase())
            return {
              ok: false,
              reason: where.length
                ? `Your bag lives on ${where.join(' + ')} — tokens are chain-native. Sell from there.`
                : 'You hold none of this creature.',
            }
          }
          let tokensWei = parseEther(amount.toFixed(18))
          if (tokensWei > have) tokensWei = have
          hash = await (await wcFor(c)).writeContract({
            address: c.gateway,
            abi: gatewayAbi,
            functionName: 'sellToken',
            args: [entry.token, tokensWei],
            chain: c.chain,
            account: activeAccount(),
          })
        }

        const receipt = await c.client.waitForTransactionReceipt({ hash })

        let usd = 0
        let tokens = 0
        let price = 0
        let ascended = false
        if (isLocalRef.current) {
          // synchronous messenger: the hub events are in this very receipt
          const events = parseEventLogs({ abi: padAbi, logs: receipt.logs })
          const t = events.find((e) => e.eventName === 'Trade')
          ascended = events.some((e) => e.eventName === 'Ascended')
          usd = t ? ef(t.args.usd as bigint) : amount
          tokens = t ? ef(t.args.tokens as bigint) : 0
          price = t ? ef(t.args.priceAfter as bigint) : 0
        } else {
          // live LayerZero: the trade lands on the hub in a minute or three
          const got = await waitHubTrade(entry.token, addr, hubMark, 240_000)
          if (got) {
            usd = got.usd
            tokens = got.tokens
            price = got.price
            ascended = got.ascended
          } else {
            // the message is still in flight — estimate from the quote
            const q = marketQuote(entry.market, side, amount)
            usd = side === 'buy' ? amount : q.usd
            tokens = side === 'buy' ? q.tokens : amount
            price = entry.market.state.vBase / entry.market.state.vTokens
          }
        }
        if (side === 'buy') costsRef.current[num] = (costsRef.current[num] ?? 0) + usd
        else {
          const pos = wallet?.positions[num]
          if (pos && pos.tokens > 0) {
            costsRef.current[num] = Math.max(0, (costsRef.current[num] ?? 0) * (1 - tokens / pos.tokens))
          }
        }
        saveCosts()
        await poll()
        return { ok: true, usd, tokens, price, ascended }
      } catch (e) {
        const msg = e instanceof Error ? e.message.split('\n')[0] : 'Transaction failed.'
        return { ok: false, reason: msg.slice(0, 120) }
      }
    },
    [poll, waitHubTrade, wallet],
  )

  const spawn = useCallback(
    async (input: SpawnInput): Promise<CreatureMeta> => {
      const hub = hubClientRef.current
      const m = manifestRef.current
      if (!activeAddr() || !hub || !m || iosRef.current.length === 0) throw new Error('chain offline')
      if (!connectedRef.current) await connect()
      const addr = activeAddr()!

      // metaURI stays small on purpose: in production the image goes to IPFS
      // and the URI points at it; on dev/test deployments the image lives in
      // this browser, keyed by the token address.
      const metaURI = JSON.stringify({ links: input.links, feeMode: input.feeMode ?? 'holders' })
      const c = iosRef.current[0] // genesis submits from the first spoke; it lands everywhere
      const before = Number(
        await hub.readContract({ address: m.pad, abi: padAbi, functionName: 'tokensLength' }),
      )
      const hash = await (await wcFor(c)).writeContract({
        address: c.gateway,
        abi: gatewayAbi,
        functionName: 'spawnToken',
        args: [
          input.name.toUpperCase(),
          input.ticker.toUpperCase(),
          metaURI,
          0n,
          FEE_MODE_INDEX[input.feeMode ?? 'holders'],
        ],
        chain: c.chain,
        account: activeAccount(),
      })
      const receipt = await c.client.waitForTransactionReceipt({ hash })

      let token: Address | undefined
      if (isLocalRef.current) {
        const spawned = parseEventLogs({ abi: padAbi, logs: receipt.logs }).find(
          (e) => e.eventName === 'Spawned',
        )
        token = spawned?.args.token as Address | undefined
      } else {
        // wait for OP_SPAWN to land on the hub over LayerZero
        const t0 = Date.now()
        while (Date.now() - t0 < 300_000 && !token) {
          await sleep(8000)
          try {
            const len = Number(
              await hub.readContract({ address: m.pad, abi: padAbi, functionName: 'tokensLength' }),
            )
            for (let i = before; i < len; i++) {
              const [tokenAddr, , , , creator] = (await hub.readContract({
                address: m.pad,
                abi: padAbi,
                functionName: 'getToken',
                args: [BigInt(i)],
              })) as unknown as [Address, string, string, string, Address]
              if (narrowActor(creator) === addr.toLowerCase()) token = tokenAddr
            }
          } catch {
            /* transient */
          }
        }
      }
      if (token) {
        try {
          localStorage.setItem(`spawn.img.${token.toLowerCase()}`, input.image)
        } catch {
          /* no storage */
        }
      }
      await poll()
      const entry = token
        ? [...entriesRef.current.values()].find((en) => en.token.toLowerCase() === token.toLowerCase())
        : undefined
      const num = entry?.meta.num ?? entriesRef.current.size
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

  /** Real on-chain claim: the gateway messages the hub, the hub pays out
   * oUSD on that chain; polling picks the balance up. */
  const claimFees = useCallback(
    async (num: number): Promise<number> => {
      const addr = activeAddr()
      const entry = entriesRef.current.get(num)
      if (!addr || !entry || iosRef.current.length === 0) return 0
      const f = entry.market.fees
      const claimable = f ? Math.max(0, f.dev - f.devClaimed) : 0
      if (claimable <= 0.005) return 0
      // claim from the first spoke the burner can pay gas on
      let c = iosRef.current[0]
      for (const x of iosRef.current) {
        if ((gasByChainRef.current[x.id] ?? 0n) > 0n) {
          c = x
          break
        }
      }
      const hash = await (await wcFor(c)).writeContract({
        address: c.gateway,
        abi: gatewayAbi,
        functionName: 'claimFees',
        args: [entry.token],
        chain: c.chain,
        account: activeAccount(),
      })
      await c.client.waitForTransactionReceipt({ hash })
      await poll()
      return claimable
    },
    [poll],
  )

  /** Protocol v3: claim the wallet's holder fee rewards for one creature, on
   * every chain holding any — each claim is a pure local tx on that chain. */
  const claimHolderRewards = useCallback(
    async (num: number): Promise<number> => {
      const addr = activeAddr()
      const entry = entriesRef.current.get(num)
      if (!addr || !entry) return 0
      const perChain = rewardsByChainRef.current.get(num) ?? {}
      let claimed = 0
      for (const c of iosRef.current) {
        const amount = perChain[c.id] ?? 0n
        const dist = distByChainRef.current[c.id]
        if (!dist || amount === 0n) continue
        if (!isLocalRef.current && (gasByChainRef.current[c.id] ?? 0n) < parseEther('0.00002'))
          continue
        try {
          const rep = await replicaAddr(c.id, entry.token)
          if (rep === ZERO) continue
          const hash = await (await wcFor(c)).writeContract({
            address: dist,
            abi: distributorAbi,
            functionName: 'claim',
            args: [rep],
            chain: c.chain,
            account: activeAccount(),
          })
          await c.client.waitForTransactionReceipt({ hash })
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

  const creatures = useMemo(() => {
    void version
    const now = Date.now()
    return [...entriesRef.current.values()].map((e) => deriveCreature(e.meta, e.market, now))
  }, [version])

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
        airdrop,
        chains: manifestRef.current?.chains.map((c) => c.id),
        walletSource,
        disconnect,
        holderRewards: rewardsRef.current,
        claimHolderRewards,
      },
    }),
    [creatures, wallet, connect, spawn, trade, claimFees, getQuote, getMarket, justSpawned, status, airdrop, walletSource, disconnect, claimHolderRewards],
  )

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
}
