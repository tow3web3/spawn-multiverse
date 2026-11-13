/**
 * Deploy profiles — every network-specific fact the tooling needs, in one
 * place. Scripts never hard-code an address: they read a profile, and the
 * mainnet preflight (scripts/lib-net.js) re-derives each external address
 * from the live chain before a single transaction is sent.
 *
 *   SPAWN_PROFILE=testnet   (default)   public testnets, MockUSDC, sponsored
 *   SPAWN_PROFILE=mainnet               the CORE universe: Base hub + Optimism + Arbitrum One, USDC
 *   SPAWN_PROFILE=bnb                   the BNB universe: BNB Chain alone, settled in BSC USDT
 *   SPAWN_PROFILE=ethereum              the Ethereum universe: Ethereum alone, settled in USDC
 *
 * A UNIVERSE is one complete, separate SPAWN! market: its own hub, its own
 * tokens, its own dollars. The core universe spans three chains over
 * LayerZero. `bnb` and `ethereum` are SINGLE-CHAIN universes: hub + local
 * gateway on one chain, every action one transaction, no LayerZero message
 * (the adapter is used as a loopback only — no route is ever set), vault =
 * OmniUSDLocal (any-decimals dollar, no CCTP). A token launched in one
 * universe does not exist in another.
 *
 * Chain labels (the protocol's own ids, see lib-deploy CHAINS):
 *   0 = the hub (protocol-only)  1 = solana  2 = ethereum  3 = base
 *   4 = bnb  5 = arbitrum  6 = optimism
 * The hub CHAIN is also a user-facing chain: its gateway (label 3) reaches
 * the pad by the hub adapter's loopback.
 *
 * Environment overrides (all optional):
 *   RPC_<NET>                  RPC url of a network key, upper-cased (RPC_BASE…)
 *   SPAWN_SPONSORED=0|1        gateways ride their adapter's tank (testnet default 1)
 *   SPAWN_RETURN_UNIT=<eth>    reply budget per leg
 *   SPAWN_DEPOSIT_CAP_USDC=<n> vault deposit cap, in WHOLE units of the universe's dollar
 *                              (mainnet universes default 25000) — the tooling scales it
 *                              by the dollar's own decimals, never by 6
 *   SPAWN_OPEN_DEPOSITS=0      leave every vault closed (cap 0) at deploy
 *   SPAWN_ENABLE=<net,net>     switch on nets that are disabled by default — REHEARSAL ONLY
 *                              for `ethereum` in the core profile (see its entry)
 *   SPAWN_STATE_FILE / SPAWN_MANIFEST_FILE   redirect the state / manifest (tests, dry runs)
 *   SPAWN_NET=<net>            the profile network to act on when the hardhat network
 *                              is only a transport (a local fork) — see netKeyOf
 */
const path = require('path')

const ROOT = path.join(__dirname, '..')
const eth = (s) => BigInt(Math.round(Number(s) * 1e9)) * 10n ** 9n
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k])
const rpc = (net, d) => env(`RPC_${net.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`, d)
const enabledExtra = new Set(env('SPAWN_ENABLE', '').split(',').map((s) => s.trim()).filter(Boolean))

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
    ethereumSepolia: {
      eid: 40161, role: 'spoke', label: 2, id: 'ethereum',
      chainId: 11155111, rpc: rpc('ethereumSepolia', 'https://ethereum-sepolia-rpc.publicnode.com'),
    },
    bnbTestnet: {
      eid: 40102, role: 'spoke', label: 4, id: 'bnb',
      chainId: 97, rpc: rpc('bnbTestnet', 'https://bsc-testnet-rpc.publicnode.com'),
    },
  },
  // money: a MockUSDC anyone can mint, no CCTP (tokenMessenger = 0)
  mockUsdc: true,
  dollar: { symbol: 'USDC', decimals: 6 },
  vault: 'OmniUSD',
  native: 'ETH',
  depositCapUsdc: 1_000_000_000n, // wide open — it is play money
  openDeposits: env('SPAWN_OPEN_DEPOSITS', '1') !== '0',
  // fees: gateways ride their tank so visitors need no fee logic
  sponsored: env('SPAWN_SPONSORED', '1') !== '0',
  returnUnit: eth(env('SPAWN_RETURN_UNIT', '0.00005')),
  // same executor gas as mainnet: the rehearsal must exercise the real limits
  gasToHub: 4_600_000n,
  gasToSpoke: 1_200_000n,
  // tanks: sized to whatever the faucet-fed deployer can spare
  tank: { mode: 'spare', floor: eth('0.002'), max: eth('0.005') },
  gasDrip: '/.netlify/functions/gas-drip',
  // LayerZero's testnet defaults are fine for play money
  dvn: null,
  timelockDelay: 0,
  // the spokes the launch wrappers deploy (the other two were never funded)
  launchSpokes: ['optimismSepolia', 'arbitrumSepolia'],
}

/* ------------------------------- mainnet ------------------------------- */

/**
 * Every address below is a CANDIDATE until the preflight has re-derived it
 * on the live chain (see docs/MAINNET-ADDRESSES.md for the method):
 *   endpoint.eid() == eid
 *   usdc.symbol() == "USDC", decimals() == 6, isMinter(TokenMessengerV2.localMinter())
 *   TokenMessengerV2.localMessageTransmitter().localDomain() == cctpDomain
 */
const CCTP_TOKEN_MESSENGER_V2 = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'

const mainnet = {
  name: 'mainnet',
  universe: 'core',
  mainnet: true,
  stateFile: env('SPAWN_STATE_FILE', path.join(ROOT, 'deployments', 'mainnet.json')),
  manifestFile: env('SPAWN_MANIFEST_FILE', path.join(ROOT, '..', 'public', 'onchain', 'mainnet.json')),
  endpoint: '0x1a44076050125825900e736c501f859c50fE728c',
  hub: 'base',
  nets: {
    base: {
      eid: 30184, role: 'hub', label: 3, id: 'base',
      chainId: 8453, rpc: rpc('base', 'https://mainnet.base.org'),
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      tokenMessenger: CCTP_TOKEN_MESSENGER_V2, cctpDomain: 6,
      confirmations: 10, opStack: true,
    },
    optimism: {
      eid: 30111, role: 'spoke', label: 6, id: 'optimism',
      chainId: 10, rpc: rpc('optimism', 'https://mainnet.optimism.io'),
      usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      tokenMessenger: CCTP_TOKEN_MESSENGER_V2, cctpDomain: 2,
      confirmations: 20, opStack: true,
    },
    arbitrum: {
      eid: 30110, role: 'spoke', label: 5, id: 'arbitrum',
      chainId: 42161, rpc: rpc('arbitrum', 'https://arb1.arbitrum.io/rpc'),
      usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      tokenMessenger: CCTP_TOKEN_MESSENGER_V2, cctpDomain: 3,
      confirmations: 20,
    },
    // NOT A LEG OF THE CORE UNIVERSE, and not meant to become one:
    // pad.setGateway is permanent and every spawn SYNCs every chain, so an
    // L1 leg ties the fee of EVERY launch to L1 gas ($0.72 → $3.07 at 0.14
    // gwei, $111 at 30 gwei) and above ~2–3 gwei a launch from a spoke can
    // no longer prepay it — the hub tank pays (docs/MAINNET-ADDRESSES.md).
    // Ethereum has its own single-chain universe instead: SPAWN_PROFILE=ethereum.
    // The entry stays, disabled, only so the add-a-chain tooling can be
    // rehearsed against forks (scripts/fork-addchain.js, SPAWN_ENABLE):
    // every script refuses it on a live network (`rehearsalOnly`).
    ethereum: {
      eid: 30101, role: 'spoke', label: 2, id: 'ethereum',
      chainId: 1, rpc: rpc('ethereum', 'https://ethereum-rpc.publicnode.com'),
      usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      tokenMessenger: CCTP_TOKEN_MESSENGER_V2, cctpDomain: 0,
      confirmations: 15,
      // An L1 deploy is ~12M gas at L1 prices: the preflight budget is 2 ×
      // that at the LIVE gas price (lib-net.js → deployBudget) — ~0.003 ETH
      // at 0.14 gwei, ~0.7 ETH at 30 gwei. This is only the absolute floor.
      budgetFloor: eth('0.002'),
      // On an L1 the hub pays for every unit of executor gas it buys: the
      // worst SYNC (a replica deploy, longest strings) measured 0.78M, so
      // 1.0M (+28%) instead of the profile's 1.2M.
      gasToSpoke: 1_000_000n,
      enabled: enabledExtra.has('ethereum'),
      rehearsalOnly:
        'an Ethereum L1 leg must not be added to the core hub (permanent, and it ties every launch fee to L1 gas — ' +
        'docs/MAINNET-ADDRESSES.md). Ethereum is its own universe: SPAWN_PROFILE=ethereum.',
    },
  },
  mockUsdc: false,
  dollar: { symbol: 'USDC', decimals: 6 },
  vault: 'OmniUSD', // CCTP-capable: vaults rebalance among themselves
  native: 'ETH',
  // guarded launch: 25,000 USDC per vault until the caps are raised on purpose
  depositCapUsdc: BigInt(env('SPAWN_DEPOSIT_CAP_USDC', '25000')),
  openDeposits: env('SPAWN_OPEN_DEPOSITS', '1') !== '0',
  // users pay for their messages and the replies they cause — never the tank
  sponsored: env('SPAWN_SPONSORED', '0') === '1',
  // Reply budget per leg, in HUB-chain native. Initial value only: after the
  // DVN set is configured, `tune-fees.js` replaces it with the live quote +
  // margin. Sized for the custom DVN set (a reply costs ~0.00013 ETH).
  returnUnit: eth(env('SPAWN_RETURN_UNIT', '0.0002')),
  // Executor gas bought per message, from measurements against the REAL
  // EndpointV2 on mainnet forks (test-fork/, 2026-11-13; docs/RUNBOOK.md):
  //  - hub-bound worst case is OP_SPAWN with the largest strings the gateway
  //    admits (64/16/1024 bytes) and a dev buy: 3.63M gas with 2 remote
  //    spokes, 3.88M with 3 (a typical spawn: 2.4M / 2.7M). 4.6M = +27% / +18%.
  //    A 4th remote spoke needs this raised (~+0.27M per spoke): the fork
  //    test fails if the limit stops covering the worst spawn.
  //  - spoke-bound worst case is OP_SYNC_TOKEN (a replica deploy).
  gasToHub: 4_600_000n,
  gasToSpoke: 1_200_000n,
  // the hub tank is a buffer between prepaid reply budgets and reply fees;
  // spokes need none (their users pay each send in full)
  tank: { mode: 'fixed', hub: eth('0.003'), spoke: 0n },
  // what a deploy needs in the deployer's wallet, per role — the preflight
  // floor. Measured cost at 2026-11-13 gas prices: hub ~0.0032 ETH (0.003 of
  // it is the tank float), a spoke < 0.0003 ETH (scripts/estimate-budget.js).
  budget: { hub: eth('0.005'), spoke: eth('0.002') },
  gasDrip: null,
  /**
   * The verifier set, custody-critical: a forged hub→spoke PAYOUT pays real
   * USDC. Both ends of every pathway must name the SAME set — the send
   * config on the source, the receive config on the destination — or
   * messages stall. Addresses are per chain; names follow LayerZero's
   * registry (https://metadata.layerzero-api.com/v1/metadata/dvns).
   * `configure-dvn.js` refuses any DVN it cannot fee-quote on a pathway.
   */
  dvn: {
    required: ['LayerZero Labs', 'Google'],
    optional: ['Horizen', 'Twinstake'],
    optionalThreshold: 1,
    maxMessageSize: 10_000,
    // Per-pathway exceptions, keyed "<net>|<net>" (either order): a chain
    // may lack one of the verifiers above (Google is not on every chain).
    // A pathway named here uses ITS set on both ends; every other pathway
    // uses the default above. Example:
    //   'base|somechain': { required: ['LayerZero Labs', 'Horizen'], optional: ['Twinstake'], optionalThreshold: 1 },
    pathways: {},
    addresses: {
      'LayerZero Labs': {
        base: '0x9e059a54699a285714207b43B055483E78FAac25',
        optimism: '0x6A02D83e8d433304bba74EF1c427913958187142',
        arbitrum: '0x2f55C492897526677C5B68fb199ea31E2c126416',
        ethereum: '0x589dEDbD617e0CBcB916A9223F4d1300c294236b',
      },
      Google: {
        base: '0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc',
        optimism: '0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc',
        arbitrum: '0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc',
        ethereum: '0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc',
      },
      Horizen: {
        base: '0xa7b5189bcA84Cd304D8553977c7C614329750d99',
        optimism: '0x9E930731cb4A6bf7eCc11F695A295c60bDd212eB',
        arbitrum: '0x19670Df5E16bEa2ba9b9e68b48C054C5bAEa06B8',
        ethereum: '0x380275805876Ff19055EA900CDb2B46a94ecF20D',
      },
      Twinstake: {
        base: '0xcd37CA043f8479064e10635020c65FfC005d36f6',
        optimism: '0xa7b5189bcA84Cd304D8553977c7C614329750d99',
        arbitrum: '0xa7b5189bcA84Cd304D8553977c7C614329750d99',
        ethereum: '0xa59BA433ac34D2927232918Ef5B2eaAfcF130BA5',
      },
    },
  },
  // every topology / custody change waits this long in public (seconds)
  timelockDelay: Number(env('SPAWN_TIMELOCK_DELAY', String(48 * 3600))),
}

/* ------------------------- single-chain universes ------------------------- */

/**
 * What every single-chain universe shares. Hub + local gateway on ONE chain:
 *   SpawnPad + InternalCurveVenue + a ledger OmniUSD(0,0,0) for the books
 *   + LayerZeroOmniMessenger as a LOOPBACK (built against the chain's real
 *     EndpointV2, no route ever set: since v7.1 an eid with no peer matches
 *     nothing, so nothing can come in from outside)
 *   + SpawnGateway(label) + FeeDistributor + OmniUSDLocal(label, dollar).
 * chainLabels = [label]: a spawn SYNCs only the local gateway. tradeLegs =
 * spawnLegs = 0, every quote is 0, the tank is never used.
 */
const singleChain = {
  mainnet: true,
  singleChain: true,
  mockUsdc: false,
  vault: 'OmniUSDLocal',
  openDeposits: env('SPAWN_OPEN_DEPOSITS', '1') !== '0',
  // guarded launch: 25,000 of the universe's dollar until raised on purpose
  depositCapUsdc: BigInt(env('SPAWN_DEPOSIT_CAP_USDC', '25000')),
  sponsored: false,
  returnUnit: 0n, // no reply ever leaves: nothing to prepay
  gasToHub: 4_600_000n, // unused (no spoke) — kept so shared code has a number
  gasToSpoke: 1_200_000n,
  tank: { mode: 'fixed', hub: 0n, spoke: 0n },
  gasDrip: null,
  dvn: null, // no pathway, no verifier set
  timelockDelay: Number(env('SPAWN_TIMELOCK_DELAY', String(48 * 3600))),
}

/**
 * The BNB universe — settled in BSC USDT ("BSC-USD", 18 decimals, a
 * Binance-custodied peg: one key can mint it; that risk is why this universe
 * is SEPARATE and never sits under the core's USDC claims).
 * Preflight: chain id, endpoint.eid(), the dollar's symbol/decimals and a
 * supply sanity bound (a look-alike token does not have billions out) — no
 * CCTP checks: Circle has no USDC here.
 */
const bnb = {
  ...singleChain,
  name: 'bnb',
  universe: 'bnb',
  stateFile: env('SPAWN_STATE_FILE', path.join(ROOT, 'deployments', 'mainnet-bnb.json')),
  manifestFile: env('SPAWN_MANIFEST_FILE', path.join(ROOT, '..', 'public', 'onchain', 'mainnet-bnb.json')),
  endpoint: '0x1a44076050125825900e736c501f859c50fE728c',
  hub: 'bnb',
  nets: {
    bnb: {
      eid: 30102, role: 'hub', label: 4, id: 'bnb',
      chainId: 56, rpc: rpc('bnb', 'https://bsc-rpc.publicnode.com'),
      usdc: '0x55d398326f99059fF775485246999027B3197955', // "the dollar token" of this universe: BSC USDT
    },
  },
  native: 'BNB',
  dollar: { symbol: 'USDT', decimals: 18, minSupply: 1_000_000_000n, maxSupply: 100_000_000_000n },
  // Measured 2026-11-13 on a BSC fork (scripts/fork-universe.js bnb): deploy
  // 17,121,230 gas + canary 2,943,361 + hand-over and caps 2,266,262 ≈ 22.4M
  // gas — 0.0011 BNB at the live 0.05 gwei, 0.022 BNB at 1 gwei. The
  // preflight asks for 2 × LIFE_GAS at the live price, never less than this
  // floor (which alone covers a 0.07 gwei day with the ×2 margin).
  budget: { hub: eth('0.003') },
  // gas of the user actions on this chain — measured on the same fork
  // (launch 2,208,720 · buy 413,596 · sell 248,728), rounded up; the
  // preflight prints them as a cost at the live gas price, and the fork
  // suite fails if they drift under or more than 50% over the measurement
  actionGas: { launch: 2_500_000n, buy: 450_000n, sell: 300_000n },
}

/**
 * The Ethereum universe — settled in Circle's native USDC (6 decimals).
 * Same single-chain shape, same OmniUSDLocal vault (no CCTP is used: there
 * is no other vault to rebalance with). The preflight still proves the token
 * is the Circle-native USDC (isMinter(TokenMessengerV2.localMinter())) — a
 * bridged look-alike has the same symbol and decimals.
 * Every action here costs L1 gas: the preflight prints what a launch and a
 * buy cost at the live gas price.
 */
const ethereumUniverse = {
  ...singleChain,
  name: 'ethereum',
  universe: 'ethereum',
  stateFile: env('SPAWN_STATE_FILE', path.join(ROOT, 'deployments', 'mainnet-ethereum.json')),
  manifestFile: env('SPAWN_MANIFEST_FILE', path.join(ROOT, '..', 'public', 'onchain', 'mainnet-ethereum.json')),
  endpoint: '0x1a44076050125825900e736c501f859c50fE728c',
  hub: 'ethereum',
  nets: {
    ethereum: {
      eid: 30101, role: 'hub', label: 2, id: 'ethereum',
      chainId: 1, rpc: rpc('ethereum', 'https://ethereum-rpc.publicnode.com'),
      usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      // only to prove the token is Circle's (the preflight's isMinter check)
      tokenMessenger: CCTP_TOKEN_MESSENGER_V2,
    },
  },
  native: 'ETH',
  dollar: { symbol: 'USDC', decimals: 6, nativeCircle: true },
  // an L1: the budget is 2 × the life-cycle gas (LIFE_GAS: 17.7M deploy +
  // 2.6M hand-over) at the LIVE gas price (lib-net.js → deployBudget) — 0.003
  // ETH at 0.07 gwei, 0.04 ETH at 1 gwei, 1.2 ETH at 30 gwei; this is only
  // the absolute floor. The same bytecode as the BNB universe, so the same
  // gas: scripts/fork-universe.js ethereum re-measures it on a fork.
  budget: { hub: eth('0.004') },
  // measured 2026-11-13 on the forks (launch ≈ 2.21M · buy ≈ 414k · sell ≈
  // 249k), rounded up — what the preflight prices at the live gas: a launch
  // is 0.0002 ETH at 0.07 gwei and 0.075 ETH at 30 gwei
  actionGas: { launch: 2_500_000n, buy: 450_000n, sell: 300_000n },
}

/* ------------------------------- access ------------------------------- */

const PROFILES = { testnet, mainnet, bnb, ethereum: ethereumUniverse }

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
    if (!PROFILES[explicit]) {
      throw new Error(`unknown SPAWN_PROFILE "${explicit}" (${Object.keys(PROFILES).join(' | ')})`)
    }
    return PROFILES[explicit]
  }
  // a net that is DISABLED in a profile does not make that profile the
  // answer: "ethereum" is the Ethereum universe, not the core's rehearsal leg
  for (const p of Object.values(PROFILES)) {
    if (networkName && p.nets[networkName] && p.nets[networkName].enabled !== false) return p
  }
  return testnet
}

/** `amount` whole dollars of this profile's universe, in the token's own
 * smallest units. NOTHING in the tooling may assume 6 decimals. */
function dollarUnits(profile, whole) {
  return BigInt(whole) * 10n ** BigInt(profile.dollar?.decimals ?? 6)
}
/** One smallest unit of the dollar, in oUSD wei (18 decimals). */
function dollarScale(profile) {
  return 10n ** BigInt(18 - (profile.dollar?.decimals ?? 6))
}

/** Nets that take part in a deployment (ethereum is off unless enabled). */
function activeNets(profile) {
  return Object.fromEntries(Object.entries(profile.nets).filter(([, c]) => c.enabled !== false))
}

/**
 * The executor gas a spoke must buy for a hub-bound message, given how many
 * REMOTE spokes the hub SYNCs on a spawn. Measured against the real
 * EndpointV2 (test-fork/): the worst spawn the gateway admits costs 3.63M
 * gas with 2 remote spokes and ~0.27M more per extra spoke; the limit keeps
 * 15% above that and never goes below the profile's `gasToHub`. A spawn that
 * runs out of gas on the hub is a stuck message — adding a chain must raise
 * this on EVERY spoke adapter (tune-fees.js does).
 */
function hubGasFor(profile, remoteSpokes) {
  const worst = 3_630_000n + 270_000n * BigInt(Math.max(0, remoteSpokes - 2))
  const need = (worst * 115n) / 100n
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

module.exports = { PROFILES, getProfile, netKeyOf, activeNets, hubGasFor, dvnSetFor, dollarUnits, dollarScale, eth }
