import { parseAbi } from 'viem'

export const padAbi = parseAbi([
  'function tokensLength() view returns (uint256)',
  'function allTokens(uint256) view returns (address)',
  'function spotPrice(address token) view returns (uint256)',
  // v5: actors (creator / trader) are bytes32 wire identities — an EVM
  // address rides left-padded, a Solana pubkey rides raw.
  'function getToken(uint256 i) view returns (address token, string name, string symbol, string metaURI, bytes32 creator, uint64 spawnedAt, uint32 homeChain, uint256 vBase, uint256 vTokens, uint256 sold, bool ascended, uint256 price)',
  'function feesOf(address token) view returns (uint8 mode, uint256 total, uint256 holders, uint256 dev, uint256 devClaimed, uint256 burnPot, uint256 burnedUsd, uint256 burnedTokens, uint256 holdersPaid)',
  // v6 FAIR GENESIS: the live anti-snipe window state for one actor.
  'function fairGenesisOf(address token, bytes32 actor) view returns (uint64 endsAt, uint256 snipeBpsNow, uint256 spentUsd, uint256 capUsd)',
  // v7: holder fees accrue on the hub per chain until someone pulls them.
  'function pendingDrop(address token, uint32 chain) view returns (uint256)',
  'function paused() view returns (bool)',
  'event Spawned(address indexed token, bytes32 indexed creator, uint32 homeChain, string name, string symbol, string metaURI)',
  'event Trade(address indexed token, uint32 indexed chain, bytes32 indexed trader, bool isBuy, uint256 usd, uint256 tokens, uint256 priceAfter, uint64 ts)',
  'event Ascended(address indexed token, uint256 raisedUsd, uint64 ts)',
  'event DevClaimed(address indexed token, bytes32 indexed dev, uint256 amount)',
  'event FeesPulled(address indexed token, uint32 indexed chain, uint256 amount)',
  'event GenesisGuard(address indexed token, bytes32 indexed actor, uint256 taxBps, uint256 taxUsd, uint256 refundedUsd)',
  // v7: the hub never reverts on a message — it REFUSES, and says why.
  'event Refused(uint8 indexed op, uint32 indexed srcChain, bytes32 token, bytes32 actor, uint256 amount, uint8 reason)',
  // v7.1: a chain whose SYNC could not be sent no longer undoes the launch —
  // the token simply has no replica there until the operator resyncs it.
  'event SyncFailed(address indexed token, uint32 indexed chain)',
  'event Resynced(address indexed token, uint32 indexed chain)',
  // v7.2: what the hub may front for a request toward a chain (an open's
  // SYNC, a moved claim's PAYOUT), in hub-native wei; its gateways and its
  // adapter, to price that SYNC before an open is offered.
  'function requestCap(uint32 chain) view returns (uint256)',
  'function syncCap(uint32 chain) view returns (uint256)',
  'function gateways(uint32 chain) view returns (bytes32)',
  'function messenger() view returns (address)',
  // v7.2: a claim burned on srcChain was forwarded to (dstChain, to) — or,
  // `forwarded` false, sent back home to (srcChain, from)
  'event Moved(uint32 indexed srcChain, uint32 indexed dstChain, bytes32 indexed from, bytes32 to, uint256 amount, bool forwarded)',
])

/** The hub's messaging adapter: what a message to a chain costs right now. */
export const messengerAbi = parseAbi([
  'function quote(uint32 dstChain, bytes32 dstAddr, bytes payload, uint256 returnLegs) view returns (uint256)',
])

/** `Refused.reason` and the wire opcodes live with the logic that reads
 * them (lib/v72: dependency-free, unit-tested). */
export { OP, REFUSAL } from '../lib/v72'

export const gatewayAbi = parseAbi([
  // v7: every action is payable — msg.value is the messaging fee (see quotes)
  'function spawnToken(string name, string symbol, string metaURI, uint256 devBuyUsd, uint8 feeMode) payable',
  'function spawnTokenUsdc(string name, string symbol, string metaURI, uint256 devBuyUsdc, uint8 feeMode) payable',
  'function buyToken(address hubToken, uint256 usdIn) payable',
  'function buyTokenUsdc(address hubToken, uint256 usdcIn) payable',
  'function sellToken(address hubToken, uint256 tokens) payable',
  // Price protection. v7.1: where the hub answers in the same transaction,
  // the trade reverts ("GW: min out") unless the minimum arrived. v7.2
  // (second round): the minimum rides the message to the hub, which refuses
  // a trade under it and sends it back whole — the same signatures, now on
  // every chain. Before v7.2 a remote gateway always reverts them.
  'function buyTokenUsdcMin(address hubToken, uint256 usdcIn, uint256 minTokensOut) payable',
  'function buyTokenMin(address hubToken, uint256 usdIn, uint256 minTokensOut) payable',
  'function sellTokenMin(address hubToken, uint256 tokens, uint256 minDollarsOut) payable',
  'function claimFees(address hubToken) payable',
  'function pullFees(address hubToken) payable',
  'function claimPending(address hubToken) returns (uint256 tokens)',
  'function quoteBuy() view returns (uint256)',
  'function quoteSell() view returns (uint256)',
  'function quoteClaim() view returns (uint256)',
  'function quotePull() view returns (uint256)',
  'function quoteSpawn(string name, string symbol, string metaURI, bool withDevBuy) view returns (uint256)',
  // v7.2: ask the hub for this chain's replica of a token it never got
  // (prepays the SYNC back), and send a dollar claim to another chain
  'function openToken(address hubToken) payable',
  'function moveClaim(uint32 dstChain, bytes32 to, uint256 amount) payable',
  'function quoteOpen() view returns (uint256)',
  // reverts "GW: route closed" for a destination with no price
  'function quoteMove(uint32 dstChain) view returns (uint256)',
  'function chainLabel() view returns (uint32)',
  'function replicaOf(address hubToken) view returns (address)',
  'function pendingDelivery(address hubToken, address account) view returns (uint256)',
  'function distributor() view returns (address)',
  'function paused() view returns (bool)',
])

/** Per-chain holder-dividend pool. Keyed by the LOCAL token (the replica). */
export const distributorAbi = parseAbi([
  'function withdrawable(address token, address account) view returns (uint256)',
  'function claim(address token) returns (uint256)',
])

/** Launch-time fee routing — indices must match SpawnPad's constants. */
export const FEE_MODE_INDEX = { holders: 0, split: 1, dev: 2, burn: 3 } as const

/** The vault (OmniUSD over USDC, OmniUSDLocal over a local dollar): holds
 * this chain's dollar token AND is the 18-decimal claim on it. Same surface
 * on both for everything the site calls. `wrap` is deliberately absent: the
 * site never mints a claim on demand, and the BNB vault (OmniUSDLocal) has
 * no such function at all (v7.2) — a USDT→USDC exchange at par. */
export const usdAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  // oUSD wei per smallest unit of the dollar token: 1e12 for 6 decimals, 1 for 18
  'function SCALE() view returns (uint256)',
  'function unwrap(uint256 amount18) returns (uint256)',
  'function liquidity() view returns (uint256)',
  'function depositCap() view returns (uint256)',
  'function depositsPaused() view returns (bool)',
  'event PaidOut(address indexed to, uint256 usdcOut, uint256 minted)',
])

/** A chain's dollar token — Circle's USDC, or Binance USDT on BNB Chain; a
 * mock with an open `mint` on testnets. The name `usdc` is historical: it is
 * whatever dollar THAT chain settles in. */
export const usdcAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
])

export const tokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
])

export interface ManifestChain {
  label: number
  id: string
  gateway: `0x${string}`
  /** This chain's OmniUSD vault (18-decimal claims on its USDC). */
  usd: `0x${string}`
  /** The dollar TOKEN users pay with (USDC, 6 decimals; BSC USDT, 18…).
   * The field name is historical. */
  usdc?: `0x${string}`
  /** Holder-dividend pool; probed from the gateway when absent. */
  dist?: `0x${string}`
  /** Chain id + RPC; defaults to the hub's when absent (local devnet). */
  chainId?: number
  rpc?: string
  /** v7: this gateway lives on the hub chain — trades settle in ONE
   * transaction, no LayerZero message, no messaging fee. */
  local?: boolean
  /** Guarded-launch cap on this chain's vault, in the dollar's smallest
   * units (informative; the vault's own `depositCap()` is the truth). */
  depositCap?: number | string
  /** v7.2: `cctp` — a USDC vault levelled with Circle CCTP; `local` — a
   * vault over a dollar Circle does not issue there (BNB: USDT), no wrap. */
  vault?: 'cctp' | 'local'
  /** v7.2: this chain's dollar when it differs from the manifest's. */
  dollar?: { symbol: string; decimals: number }
}

export interface Manifest {
  /** 'mainnet' flips the site into guarded real-money mode. */
  network?: 'mainnet' | 'testnet' | 'local'
  /** The protocol generation the deployment runs ("v7.2": one universe on
   * six chains, a dollar per chain, opens, moves, protection everywhere). */
  generation?: string
  /** The default dollar (each chain may declare its own). Informative: the
   * token's own `decimals()` and the vault's `SCALE()` are the truth, and a
   * mismatch refuses to boot. */
  dollar?: { symbol: string; decimals: number }
  /** v7.2: the hub's messaging adapter (prices an open's SYNC). */
  hubMessenger?: `0x${string}`
  /** Hub chain id + RPC (the pad lives here). */
  chainId: number
  rpc: string
  messenger?: `0x${string}`
  pad: `0x${string}`
  /** Price-discovery module behind the pad (InternalCurveVenue; LaunchLab/DBC adapter later). */
  venue?: `0x${string}`
  hubUsd?: `0x${string}`
  /** First hub block worth scanning for pad events (deploy block). */
  fromBlock?: number
  /** Optional gas-drip endpoint for burner wallets on public testnets. */
  gasDrip?: string
  /** v7 fees: true = the protocol's tank pays every message (testnets);
   * otherwise every gateway call must attach its `quote*` fee. */
  sponsored?: boolean
  chains: ManifestChain[]
}
