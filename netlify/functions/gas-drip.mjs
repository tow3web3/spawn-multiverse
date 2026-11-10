// Testnet gas drip: wets a visitor's burner wallet with a drop of ETH on the
// spoke testnets so they can trade without hunting faucets. Testnet money
// only; the one real guard is the balance check — an address that already
// has gas gets nothing, so the same burner can't farm the drip.
import { createPublicClient, createWalletClient, http, isAddress, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const DROP = parseEther('0.0005')
const ALREADY_WET = parseEther('0.0002')
const CHAINS = [
  { id: 11155420, name: 'optimism-sepolia', rpc: 'https://sepolia.optimism.io' },
  { id: 421614, name: 'arbitrum-sepolia', rpc: 'https://sepolia-rollup.arbitrum.io/rpc' },
  { id: 11155111, name: 'ethereum-sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
  { id: 97, name: 'bnb-testnet', rpc: 'https://bsc-testnet-rpc.publicnode.com', symbol: 'tBNB' },
]

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  const pk = process.env.DRIP_PK
  if (!pk) return Response.json({ error: 'drip not configured' }, { status: 503 })

  let address
  try {
    address = (await req.json()).address
  } catch {
    return Response.json({ error: 'bad body' }, { status: 400 })
  }
  if (!isAddress(address)) return Response.json({ error: 'bad address' }, { status: 400 })

  const account = privateKeyToAccount(pk)
  const out = {}
  for (const c of CHAINS) {
    const chain = {
      id: c.id,
      name: c.name,
      nativeCurrency: { name: 'Ether', symbol: c.symbol ?? 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [c.rpc] } },
    }
    try {
      const client = createPublicClient({ chain, transport: http(c.rpc) })
      const bal = await client.getBalance({ address })
      if (bal >= ALREADY_WET) {
        out[c.name] = 'already wet'
        continue
      }
      const wc = createWalletClient({ account, chain, transport: http(c.rpc) })
      const hash = await wc.sendTransaction({ to: address, value: DROP })
      out[c.name] = hash
    } catch (e) {
      out[c.name] = 'dry: ' + String(e?.shortMessage ?? e).slice(0, 60)
    }
  }
  return Response.json({ dripped: out })
}
