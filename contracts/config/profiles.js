/**
 * Deploy profiles — every network-specific fact the tooling needs, in one
 * place. Scripts never hard-code an address: they read a profile, and the
 * mainnet preflight (scripts/lib-net.js) re-derives each external address
 * from the live chain before a single transaction is sent.
 *
 *   SPAWN_PROFILE=testnet   (default)   public testnets, mock dollars, sponsored
 *   SPAWN_PROFILE=mainnet               THE universe: Base (hub) + Optimism + Arbitrum + Ethereum + BNB Chain
 *
 * ONE UNIVERSE, SIX CHAINS (owner's decision, 2026-11-14). One hub (the pad
 * on Base), one market per token, one set of books. Five EVM chains launch
 * together; Solana (label 1, reserved) joins later through the add-a-chain
 * path. The single-chain `bnb` and `ethereum` universes of v7.1 are retired:
 * both chains are spokes of this one.
 *
 * THE DOLLAR AND THE VAULT ARE PER CHAIN, not per profile:
 *   vault 'cctp'   OmniUSD over Circle's native USDC (6 decimals). These
 *                  vaults level each other through CCTP V2 (`rebalance` to a
 *                  fixed peer): Base, Optimism, Arbitrum, Ethereum.
 *   vault 'local'  OmniUSDLocal over a dollar Circle does not issue there —
 *                  BNB Chain: Binance-Peg USDT, 18 decimals. No CCTP, no peer,
 *                  no `wrap`; it is never anybody's CCTP peer and names none.
 *                  The tooling refuses, loudly, any state where it is one.
 *
 * Chain labels (the protocol's own ids, see lib-deploy CHAINS):
 *   0 = the hub (protocol-only)  1 = solana (reserved)  2 = ethereum  3 = base
 *   4 = bnb  5 = arbitrum  6 = optimism
 * The hub CHAIN is also a user-facing chain: its gateway (label 3) reaches
 * the pad by the hub adapter's loopback.
 *
 * Environment overrides (all optional):
 *   RPC_<NET>                  RPC url of a network key, upper-cased (RPC_BASE…)
 *   SPAWN_SPONSORED=0|1        gateways ride their adapter's tank (testnet default 1)
 *   SPAWN_RETURN_UNIT=<eth>    initial reply budget per leg (tune-fees replaces it)
 *   SPAWN_DEPOSIT_CAP_USDC=<n> the cap EVERY vault opens with at deploy, in WHOLE units
 *                              of that chain's own dollar (launch.sh: the canary cap, 100).
 *                              Unset: each chain's `launchCap`.
 *   SPAWN_LAUNCH_CAP_<NET>=<n> finish.sh's cap for one chain (whole dollars of its dollar)
 *   SPAWN_SYNC_CAP_<NET>=<eth> a chain's launch ceiling (SpawnPad.syncCap), hub-native
 *   SPAWN_OPEN_DEPOSITS=0      leave every vault closed (cap 0) at deploy
 *   SPAWN_ENABLE=<net,net>     switch on nets that are disabled by default
 *   SPAWN_SKIP=<net,net>       leave nets out of this run (testnet: an unfunded optional spoke)
 *   SPAWN_STATE_FILE / SPAWN_MANIFEST_FILE   redirect the state / manifest (tests, dry runs)
 *   SPAWN_NET=<net>            the profile network to act on when the hardhat network
 *                              is only a transport (a local fork) — see netKeyOf
 */
const path = require('path')

const ROOT = path.join(__dirname, '..')
const eth = (s) => BigInt(Math.round(Number(s) * 1e9)) * 10n ** 9n
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k])
const envKey = (net) => net.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()
const rpc = (net, d) => env(`RPC_${envKey(net)}`, d)
const enabledExtra = new Set(env('SPAWN_ENABLE', '').split(',').map((s) => s.trim()).filter(Boolean))
const skipped = new Set(env('SPAWN_SKIP', '').split(',').map((s) => s.trim()).filter(Boolean))
/** a chain's launch ceiling: the profile's figure, or SPAWN_SYNC_CAP_<NET> */
const syncCapOf = (net, d) => eth(env(`SPAWN_SYNC_CAP_${envKey(net)}`, d))

/** The label no profile may use for an EVM chain: Solana's, kept for it. */
const RESERVED_LABELS = { 1: 'solana' }

/* ------------------------------- testnet ------------------------------- */

const testnet = {
  name: 'testnet',
  mainnet: false,
  stateFile: env('SPAWN_STATE_FILE', path.join(ROOT, 'deployments', 'testnet.json')),
  manifestFile: env('SPAWN_MANIFEST_FILE', path.join(ROOT, '..', 'public', 'onchain', 'testnet.json')),
  // LayerZero V2 EndpointV2 — same address on these testnets (verified on-chain).
  endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
  hub: 'baseSepolia',
  nets: {
    baseSepolia: {
      eid: 40245, role: 'hub', label: 3, id: 'base',
      chainId: 84532, rpc: rpc('baseSepolia', 'https://sepolia.base.org'),
    },
    optimismSepolia: {
      eid: 40232, role: 'spoke', label: 6, id: 'optimism',
      chainId: 11155420, rpc: rpc('optimismSepolia', 'https://sepolia.optimism.io'),
    },
    arbitrumSepolia: {
      eid: 40231, role: 'spoke', label: 5, id: 'arbitrum',
      chainId: 421614, rpc: rpc('arbitrumSepolia', 'https://sepolia-rollup.arbitrum.io/rpc'),
    },
    // The five-chain shape on real testnets. OPTIONAL: launch.sh skips a
    // chain where the deployer holds no gas (their faucets are stingy).
    ethereumSepolia: {
      eid: 40161, role: 'spoke', label: 2, id: 'ethereum',
      chainId: 11155111, rpc: rpc('ethereumSepolia', 'https://ethereum-sepolia-rpc.publicnode.com'),
      optional: true,
      // the L1 leg has a launch ceiling here too, as on mainnet
      syncCap: syncCapOf('ethereumSepolia', '0.0003'),
      gasToSpoke: 1_000_000n,
    },
    bnbTestnet: {
      eid: 40102, role: 'spoke', label: 4, id: 'bnb',
      chainId: 97, rpc: rpc('bnbTestnet', 'https://bsc-testnet-rpc.publicnode.com'),
      optional: true,
      // the USDT vault, as on mainnet — over a mock 18-decimal dollar
      vault: 'local',
      dollar: { symbol: 'USDT', decimals: 18 },
      native: 'tBNB',
    },
  },
  // money: mock dollars anyone can mint, no CCTP (tokenMessenger = 0)
  mockUsdc: true,
  dollar: { symbol: 'USDC', decimals: 6 },
  native: 'ETH',
  depositCapUsdc: 1_000_000_000n, // wide open — it is play money
  canaryCap: 1_000_000,
  openDeposits: env('SPAWN_OPEN_DEPOSITS', '1') !== '0',
  // fees: gateways ride their tank so visitors need no fee logic
  sponsored: env('SPAWN_SPONSORED', '1') !== '0',
  returnUnit: eth(env('SPAWN_RETURN_UNIT', '0.00005')),
  // same executor gas as mainnet: the rehearsal must exercise the real limits
  gasToHub: 5_200_000n,
  gasToSpoke: 1_200_000n,
  // tanks: sized to whatever the faucet-fed deployer can spare
  tank: { mode: 'spare', floor: eth('0.002'), max: eth('0.005') },
  gasDrip: '/.netlify/functions/gas-drip',
  // LayerZero's testnet defaults are fine for play money
  dvn: null,
  timelockDelay: 0,
}

/* ------------------------------- mainnet ------------------------------- */

/**
 * Every address below is a CANDIDATE until the preflight has re-derived it
 * on the live chain (see docs/MAINNET-ADDRESSES.md for the method):
 *   endpoint.eid() == eid
 *   USDC chains: usdc.symbol() == "USDC", decimals() == 6,
 *     isMinter(TokenMessengerV2.localMinter()),
 *     TokenMessengerV2.localMessageTransmitter().localDomain() == cctpDomain
 *   BNB Chain: USDT symbol / decimals and a supply sanity bound
 */
const CCTP_TOKEN_MESSENGER_V2 = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'

const mainnet = {
  name: 'mainnet',
  universe: 'mainnet',
  mainnet: true,
  stateFile: env('SPAWN_STATE_FILE', path.join(ROOT, 'deployments', 'mainnet.json')),
  manifestFile: env('SPAWN_MANIFEST_FILE', path.join(ROOT, '..', 'public', 'onchain', 'mainnet.json')),
  endpoint: '0x1a44076050125825900e736c501f859c50fE728c',
  hub: 'base',
  nets: {
    base: {
      eid: 30184, role: 'hub', label: 3, id: 'base',
      chainId: 8453, rpc: rpc('base', 'https://mainnet.base.org'),
      vault: 'cctp',
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      tokenMessenger: CCTP_TOKEN_MESSENGER_V2, cctpDomain: 6,
      confirmations: 10, opStack: true,
      launchCap: 25_000,
    },
    optimism: {
      eid: 30111, role: 'spoke', label: 6, id: 'optimism',
      chainId: 10, rpc: rpc('optimism', 'https://mainnet.optimism.io'),
      vault: 'cctp',
      usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      tokenMessenger: CCTP_TOKEN_MESSENGER_V2, cctpDomain: 2,
      confirmations: 20, opStack: true,
      launchCap: 25_000,
    },
    arbitrum: {
      eid: 30110, role: 'spoke', label: 5, id: 'arbitrum',
      chainId: 42161, rpc: rpc('arbitrum', 'https://arb1.arbitrum.io/rpc'),
      vault: 'cctp',
      usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      tokenMessenger: CCTP_TOKEN_MESSENGER_V2, cctpDomain: 3,
      confirmations: 20,
      launchCap: 25_000,
    },
    /**
     * Ethereum L1 — a spoke whose every message costs L1 gas. A launch from
     * an L2 cannot prepay an L1 SYNC at any price (spawnLegs tops out at 32
     * of the L2's units), so this chain has a LAUNCH CEILING
     * (SpawnPad.syncCap): while its SYNC costs more than `syncCap` (in Base
     * ETH), launches skip Ethereum and a token is opened there later by
     * whoever wants it (`openToken`), or by anyone paying a `resync`.
     */
    ethereum: {
      eid: 30101, role: 'spoke', label: 2, id: 'ethereum',
      chainId: 1, rpc: rpc('ethereum', 'https://ethereum-rpc.publicnode.com'),
      vault: 'cctp',
      usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      tokenMessenger: CCTP_TOKEN_MESSENGER_V2, cctpDomain: 0,
      confirmations: 15,
      launchCap: 25_000,
      // ~1 dollar of Base ETH: an Ethereum SYNC above it leaves every launch
      // (measured on forks — docs/RUNBOOK.md "The Ethereum ceiling")
      syncCap: syncCapOf('ethereum', '0.0003'),
      // An L1 deploy is ~11M gas at L1 prices: the preflight budget is 2 ×
      // the life-cycle gas at the LIVE gas price (lib-net.js → deployBudget).
      // This is only the absolute floor.
      budgetFloor: eth('0.002'),
      // On an L1 the hub pays for every unit of executor gas it buys: the
      // worst SYNC (a replica deploy, longest strings) measured ~0.78M.
      gasToSpoke: 1_000_000n,
      // What the canary may spend here, from the deployer's own wallet: it
      // checks the LIVE price against this first and says so plainly when
      // it cannot afford a round trip, without failing the other chains.
      canaryBudget: { coin: eth('0.02'), dollars: 5 },
      canaryBuy: 2,
    },
    /**
     * BNB Chain — a spoke settled in Binance-Peg USDT ("BSC-USD", 18
     * decimals; one key can mint it). Its vault is OmniUSDLocal: no CCTP,
     * no peer, no wrap. Its LAUNCH CAP is its own setting, smaller than the
     * USDC vaults': what that vault holds is what bounds every holder's
     * exposure to a USDT de-peg (docs/SPEC.md §7 "Two dollars").
     */
    bnb: {
      eid: 30102, role: 'spoke', label: 4, id: 'bnb',
      chainId: 56, rpc: rpc('bnb', 'https://bsc-rpc.publicnode.com'),
      vault: 'local',
      usdc: '0x55d398326f99059fF775485246999027B3197955', // "the dollar token" of this chain: BSC USDT
      dollar: { symbol: 'USDT', decimals: 18, minSupply: 1_000_000_000n, maxSupply: 100_000_000_000n },
      native: 'BNB',
      confirmations: 20,
      registryKey: 'bsc', // LayerZero's metadata names this chain "bsc"
      launchCap: 10_000,
      // measured 2026-11-13 on a BSC fork: ~9M gas for a spoke — 0.0005 BNB at
      // 0.05 gwei; the floor covers a 0.1 gwei day with the ×2 margin
      budgetFloor: eth('0.003'),
    },
  },
  mockUsdc: false,
  // the TOP-LEVEL dollar: the hub's and every chain that names no other
  dollar: { symbol: 'USDC', decimals: 6 },
  native: 'ETH',
  // guarded launch: a chain's `launchCap` (finish.sh), the canary cap before
  depositCapUsdc: 25_000n,
  canaryCap: 100,
  openDeposits: env('SPAWN_OPEN_DEPOSITS', '1') !== '0',
  // users pay for their messages and the replies they cause — never the tank
  sponsored: env('SPAWN_SPONSORED', '0') === '1',
  // Reply budget per leg, in HUB-chain native. Initial value only: after the
  // DVN set is configured, `tune-fees.js` replaces it with the live quote +
  // margin. Sized for the custom DVN set (a reply costs ~0.00013 ETH).
  returnUnit: eth(env('SPAWN_RETURN_UNIT', '0.0002')),
  // Executor gas bought per message — the floor of hubGasFor (the worst
  // spawn with four remote chains, measured on forks of the five chains,
  // see hubGasFor) and the spoke-bound default (a SYNC deploys a replica).
  gasToHub: 5_200_000n,
  gasToSpoke: 1_200_000n,
  /**
   * SEAM (contract round 2): executor gas per destination AND op, set by
   * tune-fees.js only if the adapter has `setGasForOp` (scripts/lib-ops.js).
   * Measured on the five forks (exec gas where the op lands, max seen) with
   * ~30%+ on top. Hub-bound SPAWN (op 1) uses hubGasFor.
   *   hub:   BUY 0.59M · SELL 0.54M · CLAIM 0.49M · PULL_FEES 0.61M · OPEN 0.55M
   *   spoke: SYNC 0.773M (worst strings) · DELIVER 0.16M · PAYOUT 0.11M · FEE_DROP 0.114M
   */
  opGas: {
    toHub: { 1: 0, 2: 800_000, 3: 750_000, 4: 700_000, 5: 800_000, 6: 750_000, 7: 750_000 },
    toSpoke: { 10: 1_000_000, 11: 250_000, 12: 200_000, 13: 200_000 },
  },
  // the hub tank is a buffer between prepaid reply budgets and reply fees;
  // spokes need none (their users pay each send in full)
  tank: { mode: 'fixed', hub: eth('0.003'), spoke: 0n },
  // what a deploy needs in the deployer's wallet, per role — the preflight
  // floor (an L1 / a chain of its own coin has its own `budgetFloor`)
  budget: { hub: eth('0.005'), spoke: eth('0.002') },
  gasDrip: null,
  /**
   * The verifier set, custody-critical: since v7.2 a forged OP_MOVE pays out
   * on ANY chain, so the weakest pathway is custody of every vault. ONE set
   * on every pathway, both ends cross-checked. Addresses are per chain;
   * names follow LayerZero's registry
   * (https://metadata.layerzero-api.com/v1/metadata/dvns — `node
   * scripts/dvn-survey.js` re-checks every address against it and fee-quotes
   * each on every pathway). `configure-dvn.js` refuses any DVN it cannot
   * fee-quote on a pathway.
   */
  dvn: {
    required: ['LayerZero Labs', 'Google'],
    optional: ['Horizen', 'Twinstake'],
    optionalThreshold: 1,
    maxMessageSize: 10_000,
    // Per-pathway exceptions, keyed "<net>|<net>" (either order). None: the
    // four verifiers are live on all five chains.
    pathways: {},
    addresses: {
      'LayerZero Labs': {
        base: '0x9e059a54699a285714207b43B055483E78FAac25',
        optimism: '0x6A02D83e8d433304bba74EF1c427913958187142',
        arbitrum: '0x2f55C492897526677C5B68fb199ea31E2c126416',
        ethereum: '0x589dEDbD617e0CBcB916A9223F4d1300c294236b',
        // registry 2026-11-14 ("bsc", v2, not lzRead) — fee-quoted on forks
        bnb: '0xfD6865c841c2d64565562fCc7e05e619A30615f0',
      },
      Google: {
        base: '0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc',
        optimism: '0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc',
        arbitrum: '0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc',
        ethereum: '0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc',
        bnb: '0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc',
      },
      Horizen: {
        base: '0xa7b5189bcA84Cd304D8553977c7C614329750d99',
        optimism: '0x9E930731cb4A6bf7eCc11F695A295c60bDd212eB',
        arbitrum: '0x19670Df5E16bEa2ba9b9e68b48C054C5bAEa06B8',
        ethereum: '0x380275805876Ff19055EA900CDb2B46a94ecF20D',
        bnb: '0x247624e2143504730aeC22912ed41F092498bEf2',
      },
      Twinstake: {
        base: '0xcd37CA043f8479064e10635020c65FfC005d36f6',
        optimism: '0xa7b5189bcA84Cd304D8553977c7C614329750d99',
        arbitrum: '0xa7b5189bcA84Cd304D8553977c7C614329750d99',
        ethereum: '0xa59BA433ac34D2927232918Ef5B2eaAfcF130BA5',
        bnb: '0x31F748a368a893Bdb5aBB67ec95F232507601A73',
      },
    },
  },
  // every topology / custody change waits this long in public (seconds)
  timelockDelay: Number(env('SPAWN_TIMELOCK_DELAY', String(48 * 3600))),
}

/* ------------------------------- access ------------------------------- */

const PROFILES = { testnet, mainnet }

/** The universes this repository no longer launches — what to say instead. */
const RETIRED = {
  bnb: 'the single-chain BNB universe is retired: BNB Chain is a spoke of the one mainnet universe (SPAWN_PROFILE=mainnet)',
  ethereum: 'the single-chain Ethereum universe is retired: Ethereum is a spoke of the one mainnet universe (SPAWN_PROFILE=mainnet)',
  core: '"core" is now simply "mainnet" — one universe on five EVM chains',
}

/** Throws on a profile that breaks the rules the tooling relies on. */
function validate(p) {
  const labels = new Set()
  for (const [net, c] of Object.entries(p.nets)) {
    if (RESERVED_LABELS[c.label]) throw new Error(`${p.name}/${net}: label ${c.label} is reserved for ${RESERVED_LABELS[c.label]}`)
    if (labels.has(c.label)) throw new Error(`${p.name}/${net}: label ${c.label} is used twice`)
    labels.add(c.label)
    const v = c.vault ?? 'cctp'
    if (v !== 'cctp' && v !== 'local') throw new Error(`${p.name}/${net}: vault must be "cctp" or "local", got "${v}"`)
    // a USDT (local) vault has no CCTP: a domain or a messenger here would
    // let the tooling name it as somebody's peer
    if (v === 'local' && (c.cctpDomain !== undefined || c.tokenMessenger)) {
      throw new Error(`${p.name}/${net}: a "local" vault has no CCTP — it may name no cctpDomain and no tokenMessenger`)
    }
  }
  return p
}
Object.values(PROFILES).forEach(validate)

/**
 * The profile network a script acts on: the hardhat network's own name, or
 * SPAWN_NET when the hardhat network is only a transport — e.g. rehearsing
 * the mainnet deploy against a local fork:
 *   FORK=base SPAWN_NET=base npx hardhat run scripts/deploy.js --network fork
 * (the preflight still checks the chain id of whatever answers).
 */
function netKeyOf(networkName) {
  return process.env.SPAWN_NET || networkName
}

/** The active profile: SPAWN_PROFILE, or inferred from the network key. */
function getProfile(networkName) {
  networkName = netKeyOf(networkName)
  const explicit = process.env.SPAWN_PROFILE
  if (explicit) {
    if (RETIRED[explicit]) throw new Error(`SPAWN_PROFILE=${explicit}: ${RETIRED[explicit]}`)
    if (!PROFILES[explicit]) {
      throw new Error(`unknown SPAWN_PROFILE "${explicit}" (${Object.keys(PROFILES).join(' | ')})`)
    }
    return PROFILES[explicit]
  }
  for (const p of Object.values(PROFILES)) {
    if (networkName && p.nets[networkName] && p.nets[networkName].enabled !== false) return p
  }
  return testnet
}

/* ---------------------------- per-chain money ---------------------------- */

/** 'cctp' (OmniUSD over USDC) or 'local' (OmniUSDLocal, no CCTP). */
const vaultKind = (profile, net) => profile.nets[net]?.vault ?? 'cctp'
/** The vault contract on `net`. */
const vaultContract = (profile, net) => (vaultKind(profile, net) === 'local' ? 'OmniUSDLocal' : 'OmniUSD')
/** The dollar a chain settles in: its own `dollar`, else the profile's. */
const dollarOfNet = (profile, net) => profile.nets[net]?.dollar ?? profile.dollar ?? { symbol: 'USDC', decimals: 6 }
/** The coin gas is paid in on `net`. */
const nativeOfNet = (profile, net) => profile.nets[net]?.native ?? profile.native ?? 'ETH'

/** `whole` dollars of `net`'s own dollar, in its smallest units. NOTHING in
 * the tooling may assume 6 decimals. (Without `net`: the profile's dollar.) */
function dollarUnits(profile, whole, net) {
  const d = net ? dollarOfNet(profile, net) : profile.dollar
  return BigInt(whole) * 10n ** BigInt(d?.decimals ?? 6)
}
/** One smallest unit of `net`'s dollar, in oUSD wei (18 decimals). */
function dollarScale(profile, net) {
  const d = net ? dollarOfNet(profile, net) : profile.dollar
  return 10n ** BigInt(18 - (d?.decimals ?? 6))
}

/** The cap (whole dollars of its own dollar) a vault opens with at deploy:
 * SPAWN_DEPOSIT_CAP_USDC for every chain (launch.sh: the canary cap), else
 * the chain's `launchCap`, else the profile's figure. */
function deployCapOf(profile, net) {
  const forced = env('SPAWN_DEPOSIT_CAP_USDC', '')
  if (forced !== '') return BigInt(forced)
  return BigInt(profile.nets[net]?.launchCap ?? profile.depositCapUsdc)
}
/** finish.sh's cap for a chain: SPAWN_LAUNCH_CAP_<NET>, else its `launchCap`. */
function launchCapOf(profile, net) {
  return BigInt(env(`SPAWN_LAUNCH_CAP_${envKey(net)}`, String(profile.nets[net]?.launchCap ?? profile.depositCapUsdc)))
}

/** Nets that take part in a deployment: enabled, and not skipped this run. */
function activeNets(profile) {
  return Object.fromEntries(
    Object.entries(profile.nets).filter(
      ([net, c]) => (c.enabled !== false || enabledExtra.has(net)) && !skipped.has(net),
    ),
  )
}

/**
 * The executor gas a spoke buys for a hub-bound message — sized for the
 * worst SPAWN the gateway admits (64/16/1024-byte strings, a dev buy),
 * which deploys the token and the hub chain's own replica, sends one SYNC
 * to every remote chain, quotes first every chain that has a launch
 * ceiling, and delivers the dev bag.
 *
 * Measured against the REAL EndpointV2 on forks of the five mainnet chains
 * (scripts/fork-rehearsal.js, "measurements", 2026-11-14 — our verifier set):
 *   worst spawn, 4 remote chains:  no ceiling 4.17M · a ceiling on Ethereum
 *   (under it) 4.25M · ceilings on all four 4.52M · Ethereum skipped 4.04M
 *   ⇒ ≈ 3.34M + 0.209M per remote chain + 0.089M per ceiling quote
 * Rounded up (3.40M + 0.22M + 0.10M) and +20%, never below the profile's
 * `gasToHub`. A spawn that runs out of gas on the hub is a stuck message —
 * adding a chain must raise this on EVERY spoke adapter (tune-fees.js does).
 */
function hubGasFor(profile, remoteSpokes, ceilings = 0) {
  const worst = 3_400_000n + 220_000n * BigInt(Math.max(0, remoteSpokes)) + 100_000n * BigInt(Math.max(0, ceilings))
  const need = (worst * 120n) / 100n
  return need > profile.gasToHub ? need : profile.gasToHub
}

/** The verifier set of the pathway between `a` and `b`: its own entry in
 * `dvn.pathways` (either key order), else the profile default. */
function dvnSetFor(profile, a, b) {
  const d = profile.dvn
  const own = d.pathways?.[`${a}|${b}`] ?? d.pathways?.[`${b}|${a}`]
  const set = own ?? d
  return {
    required: set.required,
    optional: set.optional ?? [],
    optionalThreshold: (set.optional ?? []).length ? set.optionalThreshold : 0,
    own: !!own,
  }
}

module.exports = {
  PROFILES,
  RETIRED,
  RESERVED_LABELS,
  validate,
  getProfile,
  netKeyOf,
  activeNets,
  hubGasFor,
  dvnSetFor,
  dollarUnits,
  dollarScale,
  dollarOfNet,
  nativeOfNet,
  vaultKind,
  vaultContract,
  deployCapOf,
  launchCapOf,
  eth,
}
