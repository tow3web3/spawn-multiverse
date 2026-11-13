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
])

/** `Refused.reason` — must match SpawnPad's R_* constants. */
export const REFUSAL: Record<number, string> = {
  1: 'the hub is paused',
  2: 'the hub does not know this token',
  3: 'bad fee mode',
  4: 'only the dev can claim',
  5: 'nothing to pay out',
  6: 'the market refused the trade (dust)',
}

/** Wire opcodes as they appear in `Refused.op`. */
export const OP = { SPAWN: 1, BUY: 2, SELL: 3, CLAIM: 4, PULL: 5 } as const

export const gatewayAbi = parseAbi([
  // v7: every action is payable — msg.value is the messaging fee (see quotes)
  'function spawnToken(string name, string symbol, string metaURI, uint256 devBuyUsd, uint8 feeMode) payable',
  'function spawnTokenUsdc(string name, string symbol, string metaURI, uint256 devBuyUsdc, uint8 feeMode) payable',
  'function buyToken(address hubToken, uint256 usdIn) payable',
  'function buyTokenUsdc(address hubToken, uint256 usdcIn) payable',
  'function sellToken(address hubToken, uint256 tokens) payable',
  // v7.1, hub-chain gateway only: the whole trade reverts ("GW: min out")
  // unless the caller received at least the minimum in this transaction.
  // On a remote gateway they always revert — never call them there.
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
 * on both for everything the site calls. */
export const usdAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  // oUSD wei per smallest unit of the dollar token: 1e12 for 6 decimals, 1 for 18
  'function SCALE() view returns (uint256)',
  'function wrap(uint256 units) returns (uint256)',
  'function unwrap(uint256 amount18) returns (uint256)',
  'function liquidity() view returns (uint256)',
  'function depositCap() view returns (uint256)',
  'function depositsPaused() view returns (bool)',
  'event PaidOut(address indexed to, uint256 usdcOut, uint256 minted)',
])

/** The dollar token — Circle's USDC or BSC USDT on mainnet, a mock with an
 * open `mint` on testnets. The name `usdc` is historical: it is whatever
 * dollar the universe settles in. */
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
}

export interface Manifest {
  /** 'mainnet' flips the site into guarded real-money mode. */
  network?: 'mainnet' | 'testnet' | 'local'
  /** Mainnet: which independent universe this deployment is (default core). */
  universe?: 'core' | 'bnb' | 'ethereum'
  /** The settlement dollar. Informative: the token's own `decimals()` and
   * the vault's `SCALE()` are the truth, and a mismatch refuses to boot. */
  dollar?: { symbol: string; decimals: number }
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
