/**
 * The on-chain store: same StoreValue contract as the sim provider, but every
 * number is read from the local SPAWN! deployment and every action is a real
 * transaction signed by a burner wallet. The UI cannot tell the difference —
 * that is the point.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  parseEventLogs,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { hardhat } from 'viem/chains'
import {
  StoreCtx,
  deriveCreature,
  type CreatureMeta,
  type SpawnInput,
  type StoreValue,
  type TradeResult,
  type Wallet,
} from '../store'
import { emptyFees, quote as marketQuote, type Market, type Side, type Trade } from '../engine/market'
import { gatewayAbi, padAbi, tokenAbi, usdAbi, type Manifest } from './abi'
import type { FaceId } from '../components/Faces'

const PALETTE = ['#b5e95b', '#f7a8ce', '#9ccbf5', '#a78bf0', '#f7be7b', '#8be0d4']
const POLL_MS = 2500
const AIRDROP_PER_CHAIN = 1337
// Hardhat's well-known dev account #0 — funds burner wallets with gas on the
// LOCAL dev chain only. Never reuse outside a throwaway devnet.
const FUNDER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const

const ef = (v: bigint) => Number(formatEther(v))

interface TokenEntry {
  meta: CreatureMeta
  token: Address
  market: Market
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

export function OnchainProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<'connecting' | 'ready' | 'offline'>('connecting')
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [justSpawned, setJustSpawned] = useState<number | null>(null)
  const [version, bump] = useReducer((x: number) => x + 1, 0)

  const manifestRef = useRef<Manifest | null>(null)
  const clientRef = useRef<PublicClient | null>(null)
  const walletClientRef = useRef<WalletClient | null>(null)
  const burnerRef = useRef<PrivateKeyAccount | null>(null)
  const entriesRef = useRef<Map<number, TokenEntry>>(new Map())
  const replicaCache = useRef<Map<string, Address>>(new Map())
  const usdByChainRef = useRef<Record<string, bigint>>({})
  const tokensByChainRef = useRef<Map<number, Record<string, bigint>>>(new Map())
  const lastBlockRef = useRef(0n)
  const connectedRef = useRef(false)
  const costsRef = useRef<Record<number, number>>({})

  const saveCosts = () => {
    const b = burnerRef.current
    if (!b) return
    try {
      localStorage.setItem(`spawn.cost.${b.address}`, JSON.stringify(costsRef.current))
    } catch {
      /* no storage */
    }
  }

  const replicaAddr = useCallback(async (chainId: string, token: Address): Promise<Address> => {
    const key = `${chainId}:${token}`
    const cached = replicaCache.current.get(key)
    if (cached) return cached
    const m = manifestRef.current!
    const gw = m.chains.find((c) => c.id === chainId)!
    const addr = (await clientRef.current!.readContract({
      address: gw.gateway,
      abi: gatewayAbi,
      functionName: 'replicaOf',
      args: [token],
    })) as Address
    if (addr !== '0x0000000000000000000000000000000000000000') replicaCache.current.set(key, addr)
    return addr
  }, [])

  const poll = useCallback(async () => {
    const client = clientRef.current
    const m = manifestRef.current
    if (!client || !m) return

    // 1. token roster + curve state
    const len = Number(await client.readContract({ address: m.pad, abi: padAbi, functionName: 'tokensLength' }))
    for (let i = 0; i < len; i++) {
      const num = i + 1
      const [token, name, symbol, metaURI, , spawnedAt, , vBase, vTokens, sold, ascended] =
        (await client.readContract({
          address: m.pad,
          abi: padAbi,
          functionName: 'getToken',
          args: [BigInt(i)],
        })) as [Address, string, string, string, Address, bigint, number, bigint, bigint, bigint, boolean, bigint]

      let entry = entriesRef.current.get(num)
      if (!entry) {
        const parsed = parseMetaURI(metaURI)
        // Images live off-chain (IPFS in production; localStorage keyed by
        // token address on the local devnet) — metaURI stays tiny.
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
            custom: false,
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
    }

    // 2. event tape -> history, volume, holders, chain allocation
    const latest = await client.getBlockNumber()
    if (latest >= lastBlockRef.current) {
      const logs = await client.getLogs({ address: m.pad, fromBlock: lastBlockRef.current, toBlock: latest })
      lastBlockRef.current = latest + 1n
      const parsed = parseEventLogs({ abi: padAbi, logs })
      const byToken = new Map<string, TokenEntry>()
      for (const e of entriesRef.current.values()) byToken.set(e.token.toLowerCase(), e)

      for (const log of parsed) {
        if (log.eventName === 'Trade') {
          const a = log.args
          const entry = byToken.get((a.token as string).toLowerCase())
          if (!entry) continue
          const chainId = m.chains.find((c) => c.label === Number(a.chain))?.id ?? 'solana'
          const trade: Trade = {
            id: Number(log.blockNumber) * 1000 + Number(log.logIndex ?? 0),
            ts: Number(a.ts) * 1000,
            side: a.isBuy ? 'buy' : 'sell',
            chain: chainId,
            usd: ef(a.usd as bigint),
            tokens: ef(a.tokens as bigint),
            price: ef(a.priceAfter as bigint),
            trader: (a.trader as string).toLowerCase(),
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
          mk.balances.set(trade.trader, Math.max(0, held + (trade.side === 'buy' ? trade.tokens : -trade.tokens)))
        } else if (log.eventName === 'Ascended') {
          const entry = byToken.get((log.args.token as string).toLowerCase())
          if (entry) entry.market.ascendedAt = Number(log.args.ts) * 1000
        }
      }
    }

    // 3. burner balances (oUSD per chain + token positions per chain)
    const burner = burnerRef.current
    if (burner && connectedRef.current) {
      const usdByChain: Record<string, bigint> = {}
      for (const c of m.chains) {
        usdByChain[c.id] = (await client.readContract({
          address: c.usd,
          abi: usdAbi,
          functionName: 'balanceOf',
          args: [burner.address],
        })) as bigint
      }
      usdByChainRef.current = usdByChain
      const positions: Wallet['positions'] = {}
      for (const [num, entry] of entriesRef.current) {
        const perChain: Record<string, bigint> = {}
        let sum = 0n
        for (const c of m.chains) {
          const rep = await replicaAddr(c.id, entry.token)
          if (rep === '0x0000000000000000000000000000000000000000') continue
          const bal = (await client.readContract({
            address: rep,
            abi: tokenAbi,
            functionName: 'balanceOf',
            args: [burner.address],
          })) as bigint
          perChain[c.id] = bal
          sum += bal
        }
        tokensByChainRef.current.set(num, perChain)
        if (sum > 0n) positions[num] = { tokens: ef(sum), cost: costsRef.current[num] ?? 0 }
      }
      const totalUsd = Object.values(usdByChain).reduce((a, b) => a + b, 0n)
      setWallet({ address: burner.address, balance: ef(totalUsd), positions })
    }

    bump()
  }, [replicaAddr])

  // boot: fetch manifest, check the chain, start polling
  useEffect(() => {
    let timer: number | undefined
    let stopped = false
    ;(async () => {
      try {
        const res = await fetch('/onchain/deployment.json', { cache: 'no-store' })
        if (!res.ok) throw new Error('no manifest')
        const manifest = (await res.json()) as Manifest
        manifestRef.current = manifest
        const client = createPublicClient({
          chain: hardhat,
          transport: http(manifest.rpc, { batch: true }),
        })
        await client.getChainId()
        clientRef.current = client
        burnerRef.current = loadBurner()
        costsRef.current = loadCosts(burnerRef.current.address)
        walletClientRef.current = createWalletClient({
          account: burnerRef.current,
          chain: hardhat,
          transport: http(manifest.rpc),
        })
        // if this burner has traded before, resume it silently
        const eth = await client.getBalance({ address: burnerRef.current.address })
        if (eth > 0n) connectedRef.current = true
        if (stopped) return
        setStatus('ready')
        await poll()
        timer = window.setInterval(() => void poll().catch(() => undefined), POLL_MS)
      } catch {
        if (!stopped) setStatus('offline')
      }
    })()
    return () => {
      stopped = true
      if (timer) window.clearInterval(timer)
    }
  }, [poll])

  const airdrop = useCallback(async () => {
    const m = manifestRef.current
    const wc = walletClientRef.current
    const client = clientRef.current
    const burner = burnerRef.current
    if (!m || !wc || !client || !burner) throw new Error('chain offline')
    for (const c of m.chains) {
      const hash = await wc.writeContract({
        address: c.usd,
        abi: usdAbi,
        functionName: 'faucet',
        args: [burner.address, parseEther(String(AIRDROP_PER_CHAIN))],
        chain: hardhat,
        account: burner,
      })
      await client.waitForTransactionReceipt({ hash })
    }
    await poll()
  }, [poll])

  const connect = useCallback(async (): Promise<Wallet> => {
    const m = manifestRef.current
    const client = clientRef.current
    const burner = burnerRef.current
    if (!m || !client || !burner) throw new Error('chain offline')
    // gas for the burner, from the local dev faucet account
    const eth = await client.getBalance({ address: burner.address })
    if (eth < parseEther('1')) {
      const funder = privateKeyToAccount(FUNDER_PK)
      const funderClient = createWalletClient({ account: funder, chain: hardhat, transport: http(m.rpc) })
      const hash = await funderClient.sendTransaction({
        to: burner.address,
        value: parseEther('100'),
        chain: hardhat,
        account: funder,
      })
      await client.waitForTransactionReceipt({ hash })
    }
    connectedRef.current = true
    // first connect: print some play money on every chain
    const anyUsd = (await client.readContract({
      address: m.chains[0].usd,
      abi: usdAbi,
      functionName: 'balanceOf',
      args: [burner.address],
    })) as bigint
    if (anyUsd === 0n) await airdrop()
    else await poll()
    const total = Object.values(usdByChainRef.current).reduce((a, b) => a + b, 0n)
    return {
      address: burner.address,
      balance: ef(total),
      positions: wallet?.positions ?? {},
    }
  }, [airdrop, poll, wallet])

  const trade = useCallback(
    async (num: number, side: Side, amount: number, chainId: string): Promise<TradeResult> => {
      const m = manifestRef.current
      const client = clientRef.current
      const wc = walletClientRef.current
      const burner = burnerRef.current
      const entry = entriesRef.current.get(num)
      if (!m || !client || !wc || !burner) return { ok: false, reason: 'Chain offline.' }
      if (!connectedRef.current) return { ok: false, reason: 'Connect a wallet first.' }
      if (!entry) return { ok: false, reason: 'Unknown creature.' }
      if (!(amount > 0)) return { ok: false, reason: 'Enter an amount.' }
      const gw = m.chains.find((c) => c.id === chainId)
      if (!gw) return { ok: false, reason: 'Unknown chain.' }

      try {
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
          hash = await wc.writeContract({
            address: gw.gateway,
            abi: gatewayAbi,
            functionName: 'buyToken',
            args: [entry.token, usdWei],
            chain: hardhat,
            account: burner,
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
          hash = await wc.writeContract({
            address: gw.gateway,
            abi: gatewayAbi,
            functionName: 'sellToken',
            args: [entry.token, tokensWei],
            chain: hardhat,
            account: burner,
          })
        }

        const receipt = await client.waitForTransactionReceipt({ hash })
        const events = parseEventLogs({ abi: padAbi, logs: receipt.logs })
        const t = events.find((e) => e.eventName === 'Trade')
        const ascended = events.some((e) => e.eventName === 'Ascended')
        const usd = t ? ef(t.args.usd as bigint) : amount
        const tokens = t ? ef(t.args.tokens as bigint) : 0
        if (side === 'buy') costsRef.current[num] = (costsRef.current[num] ?? 0) + usd
        else {
          const pos = wallet?.positions[num]
          if (pos && pos.tokens > 0) {
            costsRef.current[num] = Math.max(0, (costsRef.current[num] ?? 0) * (1 - tokens / pos.tokens))
          }
        }
        saveCosts()
        await poll()
        return {
          ok: true,
          usd,
          tokens,
          price: t ? ef(t.args.priceAfter as bigint) : 0,
          ascended,
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message.split('\n')[0] : 'Transaction failed.'
        return { ok: false, reason: msg.slice(0, 120) }
      }
    },
    [poll, wallet],
  )

  const spawn = useCallback(
    async (input: SpawnInput): Promise<CreatureMeta> => {
      const m = manifestRef.current
      const client = clientRef.current
      const wc = walletClientRef.current
      const burner = burnerRef.current
      if (!m || !client || !wc || !burner) throw new Error('chain offline')
      if (!connectedRef.current) await connect()

      // metaURI stays small on purpose: in production the image goes to IPFS
      // and the URI points at it; on the local devnet we keep the image in
      // this browser, keyed by the token address.
      const metaURI = JSON.stringify({ links: input.links, feeMode: input.feeMode ?? 'holders' })
      const gw = m.chains[0] // genesis is submitted from solana; it lands everywhere
      const hash = await wc.writeContract({
        address: gw.gateway,
        abi: gatewayAbi,
        functionName: 'spawnToken',
        args: [input.name.toUpperCase(), input.ticker.toUpperCase(), metaURI, 0n],
        chain: hardhat,
        account: burner,
      })
      const receipt = await client.waitForTransactionReceipt({ hash })
      const spawned = parseEventLogs({ abi: padAbi, logs: receipt.logs }).find(
        (e) => e.eventName === 'Spawned',
      )
      const token = (spawned?.args.token as Address) ?? '0x'
      if (token !== '0x') {
        try {
          localStorage.setItem(`spawn.img.${token.toLowerCase()}`, input.image)
        } catch {
          /* no storage */
        }
      }
      await poll()
      const entry = [...entriesRef.current.values()].find(
        (en) => en.token.toLowerCase() === token.toLowerCase(),
      )
      const num = entry?.meta.num ?? entriesRef.current.size
      setJustSpawned(num)
      window.setTimeout(() => setJustSpawned(null), 4000)
      return entry?.meta ?? { num, name: input.name, ticker: input.ticker, color: PALETTE[0], spawnedAt: Date.now() }
    },
    [connect, poll],
  )

  const getQuote = useCallback((num: number, side: Side, amount: number) => {
    const entry = entriesRef.current.get(num)
    if (!entry || !(amount > 0)) return null
    return marketQuote(entry.market, side, amount)
  }, [])

  const getMarket = useCallback((num: number) => entriesRef.current.get(num)?.market, [])

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
      getQuote,
      getMarket,
      justSpawned,
      onchain: { status, airdrop },
    }),
    [creatures, wallet, connect, spawn, trade, getQuote, getMarket, justSpawned, status, airdrop],
  )

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
}
