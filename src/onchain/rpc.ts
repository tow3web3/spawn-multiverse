import { createPublicClient, fallback, http, type Address, type Chain, type Log, type Transport } from 'viem'

/** Extra public endpoints per chain, tried in order when the manifest's own
 * RPC refuses a request (public nodes rate-limit: 429 / 403 under polling).
 * Each was checked for the right `eth_chainId` and for browser CORS.
 * BNB Chain: drpc before publicnode — publicnode answers an unknown
 * transaction hash with an error (not `null`), which would break polling
 * for a receipt that is not mined yet. */
const BACKUPS: Record<number, string[]> = {
  8453: ['https://base-rpc.publicnode.com', 'https://base.gateway.tenderly.co', 'https://base.drpc.org'],
  10: ['https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org'],
  42161: ['https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org'],
  1: ['https://eth.drpc.org', 'https://rpc.mevblocker.io'],
  56: ['https://bsc.drpc.org', 'https://bsc-rpc.publicnode.com'],
  84532: ['https://base-sepolia-rpc.publicnode.com'],
  11155420: ['https://optimism-sepolia-rpc.publicnode.com'],
  421614: ['https://arbitrum-sepolia-rpc.publicnode.com'],
}

/** The manifest's RPC first, then this chain's backups. `rank: false` keeps
 * the order fixed, so reads stay on one node unless it fails. */
export function rpcTransport(chainId: number, primary: string, opts: { batch?: boolean } = {}): Transport {
  const urls = [primary, ...(BACKUPS[chainId] ?? []).filter((u) => u !== primary)]
  // small batches: some public nodes answer 413 to a large JSON-RPC batch
  const batch = opts.batch ? { batchSize: 20, wait: 16 } : undefined
  if (urls.length === 1) return http(primary, { batch })
  return fallback(
    urls.map((u) => http(u, { batch, retryCount: 1 })),
    { rank: false },
  )
}

/* ------------------------------- event logs ------------------------------- */

/** One endpoint that serves `eth_getLogs`, and the widest block range it
 * accepts per call (`span` blocks after the first: a call covers span + 1). */
export interface LogSource {
  url: string
  span: bigint
}

/**
 * Where a chain's event logs are read from, in order — NOT always the
 * manifest's RPC. Probed from a browser origin on 2026-11-16 (read-only):
 *  - Base: mainnet.base.org answers EVERY eth_getLogs with 429 "request limit
 *    reached" (eth_call works, so state reads stay there). publicnode serves
 *    50,000-block ranges back for months; tenderly ≤ 1,000; drpc's free tier
 *    ≤ 100.
 *  - BNB Chain: bsc-dataseed (the manifest's) serves no logs at all ("limit
 *    exceeded"); publicnode serves 50,000-block ranges; drpc ≤ 100.
 *  - Ethereum: publicnode serves ~1 day of history only (older: 403
 *    "archive"); mevblocker 10,000-block ranges; drpc ≤ 100.
 *  - Optimism: the official RPC 10,000; publicnode ≤ 5,000 and ~1 day deep.
 *  - Arbitrum: the official RPC 50,000; publicnode keeps almost no history.
 *  - Base Sepolia (testnet hub): see its entry.
 * Spans are kept under each limit. A chunk one endpoint refuses is asked of
 * the next one, cut to that one's span.
 */
const LOG_SOURCES: Record<number, LogSource[]> = {
  8453: [
    { url: 'https://base-rpc.publicnode.com', span: 9_999n },
    { url: 'https://base.gateway.tenderly.co', span: 999n },
    { url: 'https://base.drpc.org', span: 99n },
  ],
  56: [
    { url: 'https://bsc-rpc.publicnode.com', span: 9_999n },
    { url: 'https://bsc.drpc.org', span: 99n },
  ],
  1: [
    { url: 'https://ethereum-rpc.publicnode.com', span: 4_999n },
    { url: 'https://rpc.mevblocker.io', span: 9_999n },
    { url: 'https://eth.drpc.org', span: 99n },
  ],
  10: [
    { url: 'https://mainnet.optimism.io', span: 9_999n },
    { url: 'https://optimism-rpc.publicnode.com', span: 4_999n },
    { url: 'https://optimism.drpc.org', span: 99n },
  ],
  42161: [
    { url: 'https://arb1.arbitrum.io/rpc', span: 9_999n },
    { url: 'https://arbitrum.drpc.org', span: 99n },
  ],
  // the testnet hub: sepolia.base.org caps a call at 200 blocks and answers
  // a burst of them with 429; publicnode serves 50,000-block ranges
  84532: [
    { url: 'https://base-sepolia-rpc.publicnode.com', span: 9_999n },
    { url: 'https://sepolia.base.org', span: 199n },
  ],
}

/** Public testnet RPCs cap eth_getLogs hard (Base Sepolia: 200 blocks). */
const SPAN_PUBLIC = 199n
/** A local hardhat node takes any range. */
const SPAN_LOCAL = 100_000n

/** The endpoints a chain's logs are read from: the table above for a chain
 * listed there, else the manifest's RPC and its backups at the cautious
 * public span — or the one local node, whole. */
export function logSources(chainId: number, primary: string, local: boolean): LogSource[] {
  if (local) return [{ url: primary, span: SPAN_LOCAL }]
  const listed = LOG_SOURCES[chainId]
  if (listed) return listed
  return [primary, ...(BACKUPS[chainId] ?? []).filter((u) => u !== primary)].map((url) => ({
    url,
    span: SPAN_PUBLIC,
  }))
}

/** Parallel calls per wave — fast backfill, polite to public nodes. */
const WAVE = 8
/** An endpoint that failed is skipped for this long before being asked again. */
const COOLDOWN_MS = 60_000

export interface LogReader {
  /** Every log `address` emitted in [from, to], in block order. Throws only
   * when no endpoint could serve some part of the range. */
  getLogs(address: Address, from: bigint, to: bigint): Promise<Log[]>
}

/** Reads one chain's event logs from its log endpoints (`logSources`), each
 * in chunks it accepts. A chunk the first endpoint refuses is read from the
 * next one instead; an endpoint that fails sits out a minute, so a node that
 * is down does not cost every poll a failed round trip. */
export function logReader(chain: Chain, sources: LogSource[]): LogReader {
  const nodes = sources.map((s) => ({
    span: s.span,
    downUntil: 0,
    client: createPublicClient({ chain, transport: http(s.url, { retryCount: 1 }) }),
  }))

  const read = async (address: Address, from: bigint, to: bigint, start: number): Promise<Log[]> => {
    // the first endpoint not sitting out (the last one is always tried)
    let i = start
    while (i < nodes.length - 1 && nodes[i].downUntil > Date.now()) i++
    const node = nodes[i]
    const ranges: [bigint, bigint][] = []
    for (let b = from; b <= to; b += node.span + 1n) ranges.push([b, b + node.span > to ? to : b + node.span])
    const out: Log[] = []
    for (let w = 0; w < ranges.length; w += WAVE) {
      const wave = await Promise.all(
        ranges.slice(w, w + WAVE).map(async ([f, t]) => {
          try {
            return await node.client.getLogs({ address, fromBlock: f, toBlock: t })
          } catch (e) {
            if (i + 1 >= nodes.length) throw e
            // a node a block behind the head the range was cut from is not
            // down: only that chunk goes elsewhere
            if (!/beyond current head|head block|block range extends/i.test(String((e as Error)?.message)))
              node.downUntil = Date.now() + COOLDOWN_MS
            return read(address, f, t, i + 1)
          }
        }),
      )
      for (const r of wave) out.push(...r)
    }
    return out
  }

  return { getLogs: (address, from, to) => (from > to ? Promise.resolve([]) : read(address, from, to, 0)) }
}
