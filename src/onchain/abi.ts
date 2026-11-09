import { parseAbi } from 'viem'

export const padAbi = parseAbi([
  'function tokensLength() view returns (uint256)',
  'function allTokens(uint256) view returns (address)',
  'function spotPrice(address token) view returns (uint256)',
  'function getToken(uint256 i) view returns (address token, string name, string symbol, string metaURI, address creator, uint64 spawnedAt, uint32 homeChain, uint256 vBase, uint256 vTokens, uint256 sold, bool ascended, uint256 price)',
  'function feesOf(address token) view returns (uint8 mode, uint256 total, uint256 holders, uint256 dev, uint256 devClaimed, uint256 burnPot, uint256 burnedUsd, uint256 burnedTokens)',
  'event Spawned(address indexed token, address indexed creator, uint32 homeChain, string name, string symbol, string metaURI)',
  'event Trade(address indexed token, uint32 indexed chain, address indexed trader, bool isBuy, uint256 usd, uint256 tokens, uint256 priceAfter, uint64 ts)',
  'event Ascended(address indexed token, uint256 raisedUsd, uint64 ts)',
])

export const gatewayAbi = parseAbi([
  'function spawnToken(string name, string symbol, string metaURI, uint256 devBuyUsd, uint8 feeMode)',
  'function buyToken(address hubToken, uint256 usdIn)',
  'function sellToken(address hubToken, uint256 tokens)',
  'function claimFees(address hubToken)',
  'function replicaOf(address hubToken) view returns (address)',
])

/** Launch-time fee routing — indices must match SpawnPad's constants. */
export const FEE_MODE_INDEX = { holders: 0, split: 1, dev: 2, burn: 3 } as const

export const usdAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function faucet(address to, uint256 amount)',
])

export const tokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
])

export interface Manifest {
  /** Hub chain id + RPC (the pad lives here). */
  chainId: number
  rpc: string
  messenger?: `0x${string}`
  pad: `0x${string}`
  /** Price-discovery module behind the pad (InternalCurveVenue locally; LaunchLab/DBC adapter in prod). */
  venue?: `0x${string}`
  hubUsd?: `0x${string}`
  /** First hub block worth scanning for pad events (deploy block). */
  fromBlock?: number
  /** Optional gas-drip endpoint for burner wallets on public testnets. */
  gasDrip?: string
  chains: {
    label: number
    id: string
    gateway: `0x${string}`
    usd: `0x${string}`
    /** Spoke chain id + RPC; defaults to the hub's when absent (local devnet). */
    chainId?: number
    rpc?: string
  }[]
}
