import { fallback, http, type Transport } from 'viem'

/** Extra public endpoints per chain, tried in order when the manifest's own
 * RPC refuses a request (public nodes rate-limit: 429 / 403 under polling).
 * Each was checked for the right `eth_chainId` and for browser CORS. */
const BACKUPS: Record<number, string[]> = {
  8453: ['https://base-rpc.publicnode.com', 'https://base.drpc.org'],
  10: ['https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org'],
  42161: ['https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org'],
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
