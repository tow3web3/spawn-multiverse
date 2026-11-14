/**
 * The profile-driven network deploy — one code path for testnets, mainnet
 * and mainnet forks. `deploy.js` (and the `deploy-testnet.js` wrapper) is the
 * CLI; the fork tests call `deployNet` directly, so what they prove is the
 * script that will run for real.
 *
 * Guarantees:
 *  - RESUMABLE + IDEMPOTENT: every address lands in the state file at once;
 *    every wiring step reads the chain first and only acts on a difference.
 *  - PREFLIGHT (mainnet): refuses to send anything unless every external
 *    address was re-derived from the live chain (see `preflight`).
 *  - DRY by default on mainnet: plan + preflight, zero transactions, unless
 *    SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY.
 *  - NEVER BRICKS: a holder pool exists before its gateway is wired to it,
 *    an adapter destination exists before the pad learns the gateway that
 *    sits behind it, and the hub only wires a spoke whose own run finished.
 *  - SELF-CHECK: after the run every wired value is read back from the chain
 *    and compared with the plan.
 *  - ROLE-AWARE: a step the signer is not entitled to (after the timelock
 *    hand-over) is not attempted — it is printed with its calldata, to be
 *    scheduled through the timelock or executed by the operator.
 */
const fs = require('fs')
const path = require('path')
const { ethers, network } = require('hardhat')
const {
  activeNets, dollarUnits, dollarScale, dollarOfNet, nativeOfNet, vaultKind, vaultContract, deployCapOf,
} = require('../config/profiles')
const { requestSolvency, hubUnits, providerFor, PAD_ABI, OP_SYNC, OP_PAYOUT } = require('./lib-prices')

const MAINNET_CONFIRM = 'I_UNDERSTAND_THIS_IS_REAL_MONEY'
/** The contract generation a state entry was deployed from. A deployment is
 * never "resumed" across generations: v7.1 fixed the adapter (an unset peer
 * matched a zero sender — SPEC F-11), so a `v7` entry (v7.0 bytecode) must
 * be archived and the network deployed fresh. v7.2 is a new pad, gateway
 * and USDT vault (two wire ops, a payable `resync`, ceilings, no `wrap` on
 * `OmniUSDLocal` — SPEC §1): a pad is immutable and a gateway is forever, so
 * a `v7.1` entry cannot be completed or extended with v7.2 bytecode either. */
const GENERATION = 'v7.2'
const b32 = (addr) => ethers.zeroPadValue(addr, 32)
const fmt = (wei) => ethers.formatEther(wei)
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

/* ------------------------------ ABIs (read) ------------------------------ */

const ENDPOINT_ABI = [
  'function eid() view returns (uint32)',
  'function delegates(address) view returns (address)',
  'function getSendLibrary(address,uint32) view returns (address)',
  'function getReceiveLibrary(address,uint32) view returns (address lib, bool isDefault)',
  'function getConfig(address oapp, address lib, uint32 eid, uint32 configType) view returns (bytes)',
  'function setConfig(address oapp, address lib, (uint32 eid, uint32 configType, bytes config)[] params)',
  'function quote((uint32 dstEid, bytes32 receiver, bytes message, bytes options, bool payInLzToken) p, address sender) view returns ((uint256 nativeFee, uint256 lzTokenFee))',
  'event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)',
]
const USDC_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function isMinter(address) view returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function mint(address,uint256) returns (bool)',
]
const CCTP_MESSENGER_ABI = [
  'function localMinter() view returns (address)',
  'function localMessageTransmitter() view returns (address)',
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
]
const CCTP_TRANSMITTER_ABI = [
  'function localDomain() view returns (uint32)',
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
  'function usedNonces(bytes32) view returns (uint256)',
]

/* --------------------------------- state --------------------------------- */

function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(state, null, 2))
}

/** Executor gas the hub buys for a message to this spoke: the chain's own
 * figure when it has one (an L1 pays for every unit), else the profile's. */
const spokeGas = (profile, cfg) => cfg.gasToSpoke ?? profile.gasToSpoke

/** The vault users pay into on a net: the hub chain's is `localUsd`. */
const vaultOf = (profile, net, entry) => (net === profile.hub ? entry?.localUsd : entry?.usd)
const distOf = (profile, net, entry) => (net === profile.hub ? entry?.localDist : entry?.dist)

/** The contract users' dollars sit in, PER CHAIN (v7.2: one universe, two
 * dollars): `OmniUSD` over Circle's USDC on a 'cctp' chain (vaults level each
 * other through CCTP V2), `OmniUSDLocal` over BSC USDT on a 'local' one (no
 * CCTP, no peer, no wrap). Both answer the same calls wherever the gateway,
 * the pad, the pool and these scripts touch them; only OmniUSD has
 * `tokenMessenger` / `peers` / `rebalance`. `net` defaults to the hub. */
const vaultName = (profile, net) => vaultContract(profile, net ?? profile.hub)
const hasCctp = (profile, net) => vaultKind(profile, net ?? profile.hub) === 'cctp' && !profile.mockUsdc
const nativeOf = (profile, net) => nativeOfNet(profile, net ?? profile.hub)
const dollarOf = (profile, net) => dollarOfNet(profile, net ?? profile.hub).symbol

/** Every contract of one net that answers to the three Roles, by state key. */
function roleKeys(profile, net) {
  return net === profile.hub
    ? [
        ['adapter', 'LayerZeroOmniMessenger'],
        ['usd', 'OmniUSD'],
        ['pad', 'SpawnPad'],
        ['localUsd', vaultName(profile, net)],
        ['gateway', 'SpawnGateway'],
        ['localDist', 'FeeDistributor'],
      ]
    : [
        ['adapter', 'LayerZeroOmniMessenger'],
        ['usd', vaultName(profile, net)],
        ['gateway', 'SpawnGateway'],
        ['dist', 'FeeDistributor'],
      ]
}

/* -------------------------------- context -------------------------------- */

function makeCtx(opts) {
  const { profile, netKey } = opts
  const cfg = profile.nets[netKey]
  if (!cfg) throw new Error(`"${netKey}" is not a network of the ${profile.name} profile`)
  if (cfg.enabled === false) {
    throw new Error(
      cfg.rehearsalOnly
        ? `${netKey} is not a network of the ${profile.name} profile: ${cfg.rehearsalOnly}`
        : `${netKey} is disabled in the ${profile.name} profile — SPAWN_ENABLE=${netKey} switches it on`,
    )
  }
  const stateFile = opts.stateFile ?? profile.stateFile
  const all = loadState(stateFile)
  const state = all[netKey] ?? {}
  all[netKey] = state
  const dry =
    opts.dry ??
    (process.env.SPAWN_DRY === '1' || (profile.mainnet && process.env.SPAWN_MAINNET_CONFIRM !== MAINNET_CONFIRM))
  return {
    profile,
    netKey,
    cfg,
    nets: activeNets(profile),
    stateFile,
    manifestFile: opts.manifestFile ?? profile.manifestFile,
    all,
    state,
    dry,
    signer: opts.signer,
    providers: opts.providers, // { net: provider } — overrides the profile RPCs (tests)
    log: opts.log ?? console.log,
    plan: [], // what a dry run would do
    blocked: [], // steps the signer has no role for (calldata for the timelock / operator)
    gas: { used: 0n, txs: 0 },
    save() {
      const fresh = loadState(stateFile)
      fresh[netKey] = state
      saveState(stateFile, fresh)
      this.all = fresh
    },
  }
}

const isStub = (c) => !c || c.__stub === true

/** True on a development node (hardhat's in-process network, or an anvil /
 * hardhat fork): a place where nothing sent is real. A live RPC never
 * reports one of these client versions. */
async function isDevNode(provider) {
  try {
    return /^(anvil|hardhatnetwork)/i.test(await provider.send('web3_clientVersion', []))
  } catch {
    return false
  }
}

/**
 * The signer a CLI acts as: hardhat's first signer (the deployer / operator
 * key from contracts/.env). On a DEVELOPMENT node only — an anvil fork —
 * SPAWN_FORK_AS=0x… impersonates that address instead, so a rehearsal
 * against forked LIVE state can act as the real operator without the real
 * key ever signing anything (a transaction signed for a fork is valid on the
 * real chain). Ignored on a live network.
 */
async function cliSigner() {
  const [first] = await ethers.getSigners()
  const as = process.env.SPAWN_FORK_AS
  if (as && (await isDevNode(ethers.provider))) {
    await ethers.provider.send('hardhat_setBalance', [as, '0x8AC7230489E80000']) // 10 ETH, fork only
    return ethers.getImpersonatedSigner(as)
  }
  return first
}

function track(ctx, receipt) {
  ctx.gas.txs += 1
  ctx.gas.used += receipt.gasUsed
}

/** Deploys `name` once and records it under `key`; attaches on a re-run. In
 * a dry run a missing contract becomes a stub that later steps plan around. */
async function deployOnce(ctx, key, name, argsFn) {
  if (ctx.state[key]) {
    ctx.log(`  ${key.padEnd(9)} = ${ctx.state[key]} (already deployed)`)
    return ethers.getContractAt(name, ctx.state[key], ctx.signer)
  }
  if (ctx.dry) {
    ctx.plan.push(`deploy ${name} as "${key}"`)
    ctx.log(`  ${key.padEnd(9)} — would deploy ${name}`)
    return { __stub: true, target: `<<${key}>>` }
  }
  const factory = await ethers.getContractFactory(name, ctx.signer)
  const c = await factory.deploy(...argsFn())
  track(ctx, await c.deploymentTransaction().wait())
  ctx.state[key] = c.target
  ctx.save()
  ctx.log(`  ${key.padEnd(9)} = ${c.target} ✦ deployed`)
  return c
}

async function hasRole(contract, role, who) {
  if (!role) return true
  const admin = await contract.admin()
  if (same(admin, who)) return true
  if (role === 'admin') return false
  if (same(await contract.operator(), who)) return true
  return role === 'guardian' && same(await contract.guardian(), who)
}

/**
 * One wiring step. `needed` reads the chain and says whether there is
 * anything to do; `args` may be a thunk (evaluated only when executing).
 * `uses` lists the contracts whose addresses the step depends on.
 */
async function ensure(ctx, { desc, on, fn, args = [], needed, role = 'admin', uses = [] }) {
  // ctx.last: what became of this step — 'noop' (nothing to do), 'planned'
  // (a dry run would send it), 'blocked' (another key must), 'sent'
  ctx.last = 'noop'
  if (isStub(on) || uses.some(isStub)) {
    if (!ctx.dry) throw new Error(`internal: stub contract outside a dry run (${desc})`)
    ctx.plan.push(desc)
    ctx.log(`  would: ${desc}`)
    ctx.last = 'planned'
    return false
  }
  if (!(await needed())) return false
  const callArgs = typeof args === 'function' ? args() : args
  // The role is judged BEFORE the dry-run exit: after the hand-over a dry
  // run is how the admin-only steps are COLLECTED (target + calldata) to be
  // scheduled on the timelock — see scripts/lib-timelock.js.
  if (!(await hasRole(on, role, ctx.signer.address))) {
    const data = on.interface.encodeFunctionData(fn, callArgs)
    ctx.blocked.push({ desc, role, fn, target: on.target, data })
    ctx.log(`  ⏳ ${desc} — needs the ${role}: target ${on.target} data ${data}`)
    ctx.last = 'blocked'
    return false
  }
  if (ctx.dry) {
    ctx.plan.push(desc)
    ctx.log(`  would: ${desc}`)
    ctx.last = 'planned'
    return false
  }
  const tx = await on.connect(ctx.signer)[fn](...callArgs)
  track(ctx, await tx.wait())
  ctx.log(`  ${desc} ✓`)
  ctx.last = 'sent'
  return true
}

/* --------------------------------- budget --------------------------------- */

// Execution gas of a network's whole life-cycle, measured on mainnet forks
// (test-fork/, 2026-11-13): deploy + wiring, the DVN config per pathway,
// the hand-over. Re-measure after any contract change.
const LIFE_GAS = {
  hub: { deploy: 17_700_000n, dvnPerPathway: 570_000n, handover: 2_600_000n },
  spoke: { deploy: 9_200_000n, dvnPerPathway: 570_000n, handover: 2_300_000n },
}

/**
 * What the deployer must hold before a FRESH deploy of this network: twice
 * the life-cycle gas at the chain's CURRENT gas price, plus the tank float,
 * never below the configured floor. The floor carries what the gas price
 * cannot see on a rollup (the L1 data fee); on an L1 the gas term is the
 * whole story — a flat number there is either absurd at 0.1 gwei or
 * dangerously short at 30.
 */
async function deployBudget(ctx) {
  const { profile, cfg, signer } = ctx
  const floor = cfg.budgetFloor ?? cfg.budget ?? profile.budget[cfg.role]
  const spokes = Object.values(activeNets(profile)).filter((c) => c.role === 'spoke').length
  const g = LIFE_GAS[cfg.role]
  const pathways = profile.dvn ? BigInt(cfg.role === 'hub' ? spokes : 1) : 0n
  const gas = g.deploy + g.dvnPerPathway * pathways + g.handover
  let gasPrice = 0n
  try {
    // what a transaction really pays (base fee + tip), not the 1559 CEILING
    // a wallet signs for — the ×2 below is the margin
    const fee = await signer.provider.getFeeData()
    gasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? 0n
  } catch {
    /* an RPC without fee data: the floor decides */
  }
  const tank = profile.tank?.mode === 'fixed' ? (profile.tank[cfg.role] ?? 0n) : 0n
  const byGas = gas * gasPrice * 2n + tank
  const need = byGas > floor ? byGas : floor
  const how =
    byGas > floor
      ? `2 × ${gas} gas at ${ethers.formatUnits(gasPrice, 'gwei')} gwei${tank ? ' + tank float' : ''}`
      : `floor; 2 × gas at ${ethers.formatUnits(gasPrice, 'gwei')} gwei would be ${fmt(byGas)}`
  return { need, how, gas, gasPrice, floor }
}

/* ------------------------------- preflight ------------------------------- */

/**
 * Re-derives every external dependency from the chain the script is about
 * to deploy on, and throws on the first lie. Prints every check.
 */
async function preflight(ctx) {
  const { profile, cfg, netKey, log, signer } = ctx
  const provider = signer.provider
  const rows = []
  const check = (what, ok, detail) => {
    rows.push({ what, ok, detail })
    log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`)
  }
  log(`preflight — ${profile.name}/${netKey}`)

  const chainId = Number((await provider.getNetwork()).chainId)
  check('chain id', chainId === cfg.chainId, `${chainId} (expected ${cfg.chainId})`)

  const endpoint = new ethers.Contract(profile.endpoint, ENDPOINT_ABI, provider)
  let eid
  try {
    eid = Number(await endpoint.eid())
  } catch (e) {
    eid = `call failed: ${e.shortMessage ?? e.message}`
  }
  check('LayerZero EndpointV2.eid()', eid === cfg.eid, `${eid} (expected ${cfg.eid}) at ${profile.endpoint}`)

  if (!profile.mockUsdc) {
    const usdc = new ethers.Contract(cfg.usdc, USDC_ABI, provider)
    const get = async (p) => {
      try {
        return await p
      } catch (e) {
        return `call failed: ${e.shortMessage ?? e.message}`
      }
    }
    // the dollar of THIS CHAIN: USDC/6 on the CCTP chains, USDT/18 on BNB Chain
    const want = dollarOfNet(profile, netKey)
    const symbol = await get(usdc.symbol())
    check(`${want.symbol} symbol()`, symbol === want.symbol, `"${symbol}" at ${cfg.usdc}`)
    const decimals = await get(usdc.decimals())
    check(`${want.symbol} decimals()`, Number(decimals) === want.decimals, `${decimals} (expected ${want.decimals})`)
    if (want.minSupply !== undefined) {
      // No issuer registry to ask on this chain: a look-alike token has the
      // name and the decimals, not billions of dollars outstanding.
      const supply = await get(usdc.totalSupply())
      const whole = typeof supply === 'bigint' ? supply / 10n ** BigInt(want.decimals) : -1n
      check(
        `${want.symbol} totalSupply() within the sanity bound`,
        whole >= want.minSupply && (want.maxSupply === undefined || whole <= want.maxSupply),
        `${typeof supply === 'bigint' ? whole : supply} whole ${want.symbol} (expected ${want.minSupply}–${want.maxSupply ?? '∞'})`,
      )
    }
    if (cfg.tokenMessenger) {
      const tm = new ethers.Contract(cfg.tokenMessenger, CCTP_MESSENGER_ABI, provider)
      const minter = await get(tm.localMinter())
      const isMinter = ethers.isAddress(minter) ? await get(usdc.isMinter(minter)) : false
      check(
        'USDC is the Circle-native token (isMinter(TokenMessengerV2.localMinter()))',
        isMinter === true,
        `minter ${minter} → ${isMinter}`,
      )
      if (hasCctp(profile, netKey)) {
        // only where CCTP is actually used (vault-to-vault rebalancing)
        const transmitter = await get(tm.localMessageTransmitter())
        const domain = ethers.isAddress(transmitter)
          ? await get(new ethers.Contract(transmitter, CCTP_TRANSMITTER_ABI, provider).localDomain())
          : 'no transmitter'
        check(
          'CCTP domain (TokenMessengerV2.localMessageTransmitter().localDomain())',
          Number(domain) === cfg.cctpDomain,
          `${domain} (expected ${cfg.cctpDomain}) via ${transmitter}`,
        )
      }
    }
  }

  let budget
  if (profile.budget) {
    budget = await deployBudget(ctx)
    const { need, how } = budget
    const bal = await provider.getBalance(signer.address)
    // a finished deployment re-runs for a few wiring txs: no full budget needed
    const fresh = !ctx.state.gateway
    const coin = nativeOf(profile, netKey)
    check(
      'deployer balance covers the deploy budget',
      !fresh || bal >= need,
      `${fmt(bal)} ${coin}, budget ${fmt(need)} ${coin} (${how})${fresh ? '' : ' (already deployed — not required)'}`,
    )
  }

  // the USDT vault is never anybody's CCTP peer and names none: a profile
  // that gives it CCTP plumbing is refused before anything is deployed
  if (vaultKind(profile, netKey) === 'local') {
    check('a "local" (non-USDC) vault: no CCTP domain, no TokenMessenger', cfg.cctpDomain === undefined && !cfg.tokenMessenger, cfg.vault)
  }

  const failed = rows.filter((r) => !r.ok)
  return { rows, ok: failed.length === 0, failed }
}

/* -------------------------------- deploying -------------------------------- */

async function setRoles(ctx, contract, what, roles) {
  await ensure(ctx, {
    desc: `${what}.setOperator(${roles.operator})`,
    on: contract, fn: 'setOperator', args: [roles.operator],
    needed: async () => !same(await contract.operator(), roles.operator),
  })
  await ensure(ctx, {
    desc: `${what}.setGuardian(${roles.guardian})`,
    on: contract, fn: 'setGuardian', args: [roles.guardian],
    needed: async () => !same(await contract.guardian(), roles.guardian),
  })
}

async function deployAdapter(ctx) {
  const { state, profile, cfg, netKey } = ctx
  if (state.adapter && state.transport !== GENERATION) {
    throw new Error(
      `${netKey}: the state holds a ${state.transport ?? 'pre-v7'} deployment — ${GENERATION} never resumes an older ` +
        `generation. Archive this network's entry first (node scripts/archive-state.js ${profile.name} ` +
        `_${String(state.transport ?? 'old').replace(/\W/g, '')}_pre${GENERATION.replace(/\D/g, '')} ${netKey}); ` +
        `its gas tank is recoverable with scripts/recover-tanks.js (through the timelock if it was handed over)`,
    )
  }
  const adapter = await deployOnce(ctx, 'adapter', 'LayerZeroOmniMessenger', () => [profile.endpoint, cfg.eid])
  if (!isStub(adapter) && state.transport !== GENERATION) {
    state.transport = GENERATION
    ctx.save()
  }
  return adapter
}

/** One chain's dollar stack + gateway + holder pool, wired to `adapter`. */
async function deployUserSide(ctx, adapter, padAddr, keys, roles) {
  const { profile, cfg, netKey } = ctx
  let usdcAddr = cfg.usdc
  let usdc
  const dollar = dollarOfNet(profile, netKey)
  if (profile.mockUsdc) {
    // play money: MockUSDC (6 decimals), or a MockDollar of the universe's
    // own decimals when the profile's dollar is not a 6-decimal one
    usdc =
      dollar.decimals === 6
        ? await deployOnce(ctx, 'usdc', 'MockUSDC', () => [])
        : await deployOnce(ctx, 'usdc', 'MockDollar', () => [`Mock ${dollar.symbol}`, dollar.symbol, dollar.decimals])
    usdcAddr = usdc.target
  } else if (ctx.state.usdc !== cfg.usdc) {
    // recorded for the frontend manifest; the real token is never deployed
    ctx.state.usdc = cfg.usdc
    if (!ctx.dry) ctx.save()
  }
  const usd =
    vaultName(profile, netKey) === 'OmniUSDLocal'
      ? // a dollar of any decimals, no CCTP surface at all
        await deployOnce(ctx, keys.usd, 'OmniUSDLocal', () => [cfg.label, usdcAddr])
      : await deployOnce(ctx, keys.usd, 'OmniUSD', () => [
          cfg.label,
          usdcAddr,
          profile.mockUsdc ? ethers.ZeroAddress : cfg.tokenMessenger,
        ])
  const gateway = await deployOnce(ctx, 'gateway', 'SpawnGateway', () => [
    adapter.target,
    usd.target,
    cfg.label,
    padAddr,
  ])
  await ensure(ctx, {
    desc: `${keys.usd}.setAgent(gateway)`,
    on: usd, fn: 'setAgent', args: () => [gateway.target], uses: [gateway],
    needed: async () => (await usd.agent()) === ethers.ZeroAddress,
  })
  // the cap is in THIS CHAIN's dollar's own smallest units (6 decimals for
  // USDC, 18 for BSC USDT) — the canary cap under launch.sh, else the chain's
  // launch cap
  const whole = deployCapOf(profile, netKey)
  const cap = dollarUnits(profile, whole, netKey)
  if (profile.openDeposits) {
    await ensure(ctx, {
      desc: `${keys.usd}.setDepositCap(${whole} ${dollarOf(profile, netKey)}) — deposits open`,
      on: usd, fn: 'setDepositCap', args: [cap], role: 'operator',
      needed: async () => (await usd.depositCap()) === 0n,
    })
  } else {
    ctx.log(`  (${keys.usd}: deposits left CLOSED — SPAWN_OPEN_DEPOSITS=0; the operator opens them with setDepositCap)`)
  }
  await ensure(ctx, {
    desc: `adapter.register(gateway, ${cfg.label})`,
    on: adapter, fn: 'register', args: () => [gateway.target, cfg.label], uses: [gateway],
    needed: async () => !(await adapter.senders(gateway.target)),
  })
  await ensure(ctx, {
    desc: `adapter.setSponsored(gateway, ${profile.sponsored})`,
    on: adapter, fn: 'setSponsored', args: () => [gateway.target, profile.sponsored], uses: [gateway],
    needed: async () => (await adapter.sponsored(gateway.target)) !== profile.sponsored,
  })
  const dist = await deployOnce(ctx, keys.dist, 'FeeDistributor', () => [usd.target])
  await ensure(ctx, {
    desc: `${keys.dist}.setAgent(gateway)`,
    on: dist, fn: 'setAgent', args: () => [gateway.target], uses: [gateway],
    needed: async () => (await dist.agent()) === ethers.ZeroAddress,
  })
  // the excluded set (the gateway, the pool itself) is final from here on
  await ensure(ctx, {
    desc: `${keys.dist}.sealExclusions()`,
    on: dist, fn: 'sealExclusions',
    needed: async () => !(await dist.exclusionsSealed()),
  })
  // BEFORE any pad.setGateway for this chain: a replica cannot be born
  // without its holder pool (the SYNC would revert)
  await ensure(ctx, {
    desc: 'gateway.setDistributor(dist)',
    on: gateway, fn: 'setDistributor', args: () => [dist.target], uses: [dist],
    needed: async () => (await gateway.distributor()) === ethers.ZeroAddress,
  })
  await setRoles(ctx, usd, keys.usd, roles)
  await setRoles(ctx, gateway, 'gateway', roles)
  await setRoles(ctx, dist, keys.dist, roles)
  return { usd, gateway, dist }
}

/** Labels of every chain whose vault is NOT a USDC/CCTP vault (BNB Chain's
 * USDT vault). Such a vault is never anybody's CCTP peer. */
const localLabels = (profile) =>
  Object.entries(profile.nets).filter(([n]) => vaultKind(profile, n) === 'local').map(([, c]) => c.label)

/** Refuses, loudly, any state in which a non-USDC vault (its label) is a
 * CCTP peer of `usd`. A rebalance there would burn USDC toward a chain
 * where Circle mints nothing. */
async function refuseLocalPeers(ctx, usd, what) {
  const { profile, all } = ctx
  if (isStub(usd)) return
  for (const label of localLabels(profile)) {
    const p = await usd.peers(label)
    if (p.vault !== ethers.ZeroHash) {
      throw new Error(
        `✗✗ REFUSED — ${ctx.netKey} ${what} names label ${label} (a USDT vault, no CCTP) as a CCTP peer (${p.vault}). ` +
          'This must never happen: a rebalance there burns USDC for good. Stop, do not open deposits, tell the owner.',
      )
    }
  }
  // (Not by address: one deployer at the same nonce on two chains deploys
  // the same address on both — a CCTP peer is a (domain, vault) pair, and
  // every peer of a USDC chain is checked against that chain's own vault and
  // domain by the self-check.)
  void all
}

/** CCTP rebalancing routes: this chain's vault may only ever send USDC to
 * the vault of another USDC (CCTP) chain of the deployment. Set once per
 * peer. The USDT vault has no CCTP: it is never named and names nobody. */
async function setCctpPeers(ctx, usd, what) {
  const { profile, netKey, nets, all } = ctx
  if (vaultKind(profile, netKey) !== 'cctp') return // the USDT vault: no CCTP, names nobody
  await refuseLocalPeers(ctx, usd, what)
  if (!hasCctp(profile, netKey)) return // play money: no CCTP to rebalance with
  for (const [net, c] of Object.entries(nets)) {
    if (net === netKey) continue
    if (vaultKind(profile, net) !== 'cctp') continue // BNB Chain: never a peer
    const peerVault = vaultOf(profile, net, all[net])
    if (!peerVault) {
      ctx.log(`  (CCTP peer for ${net}: its vault is not deployed yet — re-run this network afterwards)`)
      continue
    }
    await ensure(ctx, {
      desc: `${what}.setPeer(${net}: label ${c.label}, CCTP domain ${c.cctpDomain}, vault ${peerVault})`,
      on: usd, fn: 'setPeer', args: [c.label, c.cctpDomain, b32(peerVault)],
      needed: async () => (await usd.peers(c.label)).vault === ethers.ZeroHash,
    })
  }
}

const ceilDiv = (a, b) => (a === 0n ? 0n : (a - 1n) / b + 1n)

/** The hub pad, readable from any network of the deployment. */
async function padView(ctx) {
  const hub = ctx.all[ctx.profile.hub]
  if (!hub?.pad) return null
  const provider =
    ctx.netKey === ctx.profile.hub
      ? ctx.signer.provider
      : ctx.providers?.[ctx.profile.hub] ?? providerFor(ctx.profile, ctx.profile.hub)
  return new ethers.Contract(hub.pad, PAD_ABI, provider)
}

/**
 * v7.2 — what a `moveClaim` from this chain prepays, per destination: every
 * other deployed chain gets a price (0 = closed, "GW: route closed"). The
 * initial price is the way home (`tradeLegs`) and never less than what the
 * hub lets a MOVE toward that chain cost its tank (`requestCap[D][12]`): the
 * tank must never front more than a move brought. tune-fees.js re-prices it
 * from live quotes; this only opens a route that has none.
 */
async function setMoveRoutes(ctx, gateway, adapter, tradeLegs) {
  const { nets, all, netKey } = ctx
  const pad = await padView(ctx)
  const unit = isStub(adapter) ? 0n : BigInt(await adapter.returnUnit(0))
  for (const [net, c] of Object.entries(nets)) {
    if (net === netKey || !all[net]?.gateway) continue
    let legs = Math.max(1, tradeLegs)
    if (c.role === 'spoke' && pad && unit > 0n) {
      let cap
      try {
        cap = BigInt(await pad.requestCap(c.label, OP_PAYOUT))
      } catch (e) {
        // the hub cannot be read: the route stays CLOSED (a move there would
        // be refused at the gateway) — the next run, or tune-fees.js, opens it
        ctx.log(`  (moves toward ${net} left closed: the hub's requestCap could not be read — ${e.shortMessage ?? e.message})`)
        continue
      }
      legs = Math.max(legs, Number(ceilDiv(cap, unit)))
    }
    legs = Math.min(legs, 4096)
    await ensure(ctx, {
      desc: `gateway.setMoveLegs(${c.label} = ${net}, ${legs}) — claims may move there`,
      on: gateway, fn: 'setMoveLegs', args: [c.label, legs], role: 'operator',
      needed: async () => Number(await gateway.moveLegs(c.label)) === 0,
    })
  }
}

/** v7.2 — the pad's two ceilings on what a REQUEST toward each remote chain
 * may cost the tank, per kind of message: `requestCap[D][10]` for the SYNC of
 * an open from D (set to what an open there prepays), `requestCap[D][12]`
 * for the PAYOUT a move toward D forwards (the smallest prepay of any move
 * toward it — scripts/lib-prices.js). Set where none is; 0 would leave that
 * chain closed to that kind of request. tune-fees.js keeps them priced. */
async function setRequestCaps(ctx, pad) {
  const { profile, nets, all, netKey, signer } = ctx
  if (isStub(pad)) {
    ctx.plan.push('pad.setRequestCap(<every remote chain>, 10 | 12)')
    ctx.log('  would: pad.setRequestCap(<every remote chain>, SYNC | PAYOUT) — once the gateways exist')
    return
  }
  const ready = Object.keys(nets).filter((n) => n === profile.hub || (all[n]?.gateway && all[n]?.ready))
  let solv
  try {
    solv = await requestSolvency({
      profile, all, providers: { ...ctx.providers, [netKey]: signer.provider }, quotes: false, only: ready,
    })
  } catch (e) {
    // a chain whose gateway cannot be read: no ceiling is set (0 = closed to
    // requests — the safe side); tune-fees.js sets them once every chain answers
    ctx.log(`  (request ceilings not set: a chain could not be read — ${e.shortMessage ?? e.message}; tune-fees.js sets them)`)
    return
  }
  for (const r of solv.rows) {
    for (const [op, kind, cap] of [[OP_SYNC, 'an open from it', r.open], [OP_PAYOUT, 'a move toward it', r.minMove]]) {
      if (!cap) continue
      await ensure(ctx, {
        desc: `pad.setRequestCap(${r.label} = ${r.net}, op ${op}, ${fmt(cap)} ${nativeOf(profile)}) — what ${kind} prepays`,
        on: pad, fn: 'setRequestCap', args: [r.label, op, cap], role: 'operator',
        needed: async () => BigInt(await pad.requestCap(r.label, op)) === 0n,
      })
    }
  }
}

/** Second round — executor gas per KIND of message (`setGasForOp`), from the
 * profile's `opGas` (measured on the forks; scripts/fork-rehearsal.js). On a
 * spoke: toward the hub, every op but the SPAWN (which buys the destination's
 * own limit, hubGasFor). On the hub: toward each spoke, its SYNC, DELIVER,
 * PAYOUT and FEE_DROP. Only where none is set (tune-fees.js keeps them). An
 * adapter without `setGasForOp` (first-round bytecode) is skipped. */
async function setOpGas(ctx, adapter) {
  const { profile, netKey, nets } = ctx
  const table = profile.opGas
  if (!table || isStub(adapter) || !adapter.interface.getFunction('setGasForOp')) return
  const plan = []
  if (netKey === profile.hub) {
    for (const [net, c] of Object.entries(nets)) {
      if (c.role !== 'spoke' || !ctx.all[net]?.ready) continue
      for (const [op, g] of Object.entries({ ...table.toSpoke, ...(c.opGasToSpoke ?? {}) })) plan.push([c.label, Number(op), BigInt(g), net])
    }
  } else {
    for (const [op, g] of Object.entries(table.toHub)) if (BigInt(g) > 0n) plan.push([0, Number(op), BigInt(g), profile.hub])
  }
  for (const [label, op, gas, net] of plan) {
    await ensure(ctx, {
      desc: `adapter.setGasForOp(${label} = ${net}, op ${op}, ${gas})`,
      on: adapter, fn: 'setGasForOp', args: [label, op, gas], role: 'operator',
      needed: async () => BigInt(await adapter.gasForOp(label, op)) === 0n,
    })
  }
}

/** v7.2 — the launch ceiling (`syncCap`) of every chain whose profile entry
 * asks for one (Ethereum): above it a launch skips that chain. Set BEFORE the
 * pad learns that chain's gateway, or the first launches would pay its full
 * SYNC. Kept equal to the profile (SPAWN_SYNC_CAP_<NET> overrides). */
async function setSyncCaps(ctx, pad) {
  for (const [net, c] of Object.entries(ctx.nets)) {
    if (c.syncCap === undefined || c.role === 'hub') continue
    await ensure(ctx, {
      desc: `pad.setSyncCap(${c.label} = ${net}, ${fmt(c.syncCap)} ${nativeOf(ctx.profile)}) — launches skip ${net} above it`,
      on: pad, fn: 'setSyncCap', args: [c.label, c.syncCap], role: 'operator',
      needed: async () => BigInt(await pad.syncCap(c.label)) !== BigInt(c.syncCap),
    })
  }
}

async function setDestination(ctx, adapter, label, gas, unit, what) {
  await ensure(ctx, {
    desc: `${what}: adapter.setDestination(${label}, gas ${gas}, reply budget ${fmt(unit)} ${nativeOf(ctx.profile)}/leg)`,
    on: adapter, fn: 'setDestination', args: [label, gas, unit], role: 'operator',
    // an existing destination is the operator's to tune (tune-fees.js): only
    // a missing one is set here
    needed: async () => (await adapter.gasLimit(label)) === 0n && (await adapter.returnUnit(label)) === 0n,
  })
}

/** `spawn` is the FLOOR (one leg per remote chain): the deploy never lowers
 * spawnLegs, because tune-fees.js may have padded it so a spawn from this
 * chain prepays a dearer destination's SYNC (an L1 leg costs several L2
 * legs at this chain's reply price). */
async function setLegs(ctx, gateway, trade, spawn) {
  let cur = { trade: -1, spawn: -1 }
  if (!isStub(gateway)) cur = { trade: Number(await gateway.tradeLegs()), spawn: Number(await gateway.spawnLegs()) }
  const want = Math.max(spawn, cur.spawn)
  await ensure(ctx, {
    desc: `gateway.setLegs(trade ${trade}, spawn ${want})`,
    on: gateway, fn: 'setLegs', args: [trade, want], role: 'operator',
    needed: async () => cur.trade !== trade || cur.spawn < spawn,
  })
}

/** Remote spokes in the state — the FLOOR of what a spawn prepays in SYNC
 * replies (one leg per chain). A spoke counts from the moment its gateway is
 * deployed (slightly early: the hub only SYNCs it once wired), so a spawn
 * never underpays. A chain with a launch ceiling (Ethereum) is not counted:
 * launches skip it whenever its SYNC is dear, and when it is not,
 * tune-fees.js prices it in from the live quote. */
function remoteSpokes(ctx) {
  return Object.entries(ctx.nets).filter(
    ([net, c]) => c.role === 'spoke' && c.syncCap === undefined && loadState(ctx.stateFile)[net]?.gateway,
  ).length
}

async function topUpTank(ctx, adapter) {
  if (ctx.dry || isStub(adapter)) return
  const { profile, cfg, signer } = ctx
  const provider = signer.provider
  const tank = await provider.getBalance(adapter.target)
  let amount = 0n
  if (profile.tank.mode === 'fixed') {
    const want = profile.tank[cfg.role] ?? 0n
    if (tank < want) amount = want - tank
  } else {
    if (tank >= profile.tank.floor) return
    const mine = await provider.getBalance(signer.address)
    const reserve = ethers.parseEther('0.00003')
    const spare = mine > ethers.parseEther('0.00005') ? (mine - reserve) / 3n : 0n
    amount = spare > profile.tank.max ? profile.tank.max : spare
  }
  if (amount <= 0n) {
    if (profile.tank.mode !== 'fixed') ctx.log('  (gas tank left as is — deployer balance too low)')
    return
  }
  const mine = await provider.getBalance(signer.address)
  if (mine <= amount) {
    ctx.log(`  ⚠ gas tank NOT funded: needs ${fmt(amount)} ETH, deployer has ${fmt(mine)}`)
    return
  }
  track(ctx, await (await signer.sendTransaction({ to: adapter.target, value: amount })).wait())
  ctx.log(`  gas tank +${fmt(amount)} ETH`)
}

async function deployHub(ctx, roles) {
  const { profile, cfg, netKey, nets } = ctx
  const adapter = await deployAdapter(ctx)
  // the hub holds no dollars, only the books: ledger-mode oUSD
  const usd = await deployOnce(ctx, 'usd', 'OmniUSD', () => [0, ethers.ZeroAddress, ethers.ZeroAddress])
  const pad = await deployOnce(ctx, 'pad', 'SpawnPad', () => [adapter.target, usd.target])
  const venue = await deployOnce(ctx, 'venue', 'InternalCurveVenue', () => [pad.target])

  await ensure(ctx, {
    desc: 'pad.setVenue(venue)', on: pad, fn: 'setVenue', args: () => [venue.target], uses: [venue],
    needed: async () => (await pad.venue()) === ethers.ZeroAddress,
  })
  await ensure(ctx, {
    desc: 'usd.setAgent(pad)', on: usd, fn: 'setAgent', args: () => [pad.target], uses: [pad],
    needed: async () => (await usd.agent()) === ethers.ZeroAddress,
  })
  await ensure(ctx, {
    desc: 'adapter.register(pad, 0)', on: adapter, fn: 'register', args: () => [pad.target, 0], uses: [pad],
    needed: async () => !(await adapter.senders(pad.target)),
  })
  // the pad's messages are replies, prepaid into this tank — always sponsored
  await ensure(ctx, {
    desc: 'adapter.setSponsored(pad, true)', on: adapter, fn: 'setSponsored', args: () => [pad.target, true],
    uses: [pad],
    needed: async () => !(await adapter.sponsored(pad.target)),
  })
  await setRoles(ctx, adapter, 'adapter', roles)
  await setRoles(ctx, usd, 'usd', roles)
  await setRoles(ctx, pad, 'pad', roles)

  // The hub chain's own user side: vault + gateway + holder pool, reached by
  // loopback. Labels 0 (the pad) and the chain's own label both live here.
  for (const label of [0, cfg.label]) {
    await ensure(ctx, {
      desc: `adapter.setLocal(${label})`, on: adapter, fn: 'setLocal', args: [label, true],
      needed: async () => !(await adapter.isLocal(label)),
    })
  }
  // a locally-initiated spawn prepays the hub's remote SYNC fan-out — in a
  // single-chain universe there is none (and a zero budget is not a step)
  if (profile.returnUnit > 0n) {
    await ensure(ctx, {
      desc: `local fan-out budget: adapter.setDestination(0, 0, ${fmt(profile.returnUnit)} ${nativeOf(profile)}/leg)`,
      on: adapter, fn: 'setDestination', args: [0, 0n, profile.returnUnit], role: 'operator',
      needed: async () => (await adapter.returnUnit(0)) === 0n,
    })
  }
  const local = await deployUserSide(ctx, adapter, pad.target, { usd: 'localUsd', dist: 'localDist' }, roles)
  await ensure(ctx, {
    desc: `pad.setGateway(${cfg.label}, ${netKey} — local)`,
    on: pad, fn: 'setGateway', args: () => [cfg.label, b32(local.gateway.target)], uses: [local.gateway],
    needed: async () => (await pad.gateways(cfg.label)) === ethers.ZeroHash,
  })
  // holder fees ship at once only here, where shipping is a free loopback;
  // every remote chain's slice waits on the hub for a user-paid pull
  await ensure(ctx, {
    desc: `pad.setAutoDrop(${cfg.label})`, on: pad, fn: 'setAutoDrop', args: [cfg.label, true],
    needed: async () => !(await pad.autoDrop(cfg.label)),
  })
  await setCctpPeers(ctx, local.usd, 'localUsd')
  await topUpTank(ctx, adapter)
  // before ANY gateway of a chain with a launch ceiling is wired
  await setSyncCaps(ctx, pad)

  // Wire every spoke whose own run FINISHED (state.ready) and isn't routed.
  for (const [net, c] of Object.entries(nets)) {
    const s = ctx.all[net]
    if (c.role !== 'spoke' || !s?.adapter || !s?.gateway) continue
    if (!s.ready) {
      ctx.log(`  (${net}: its own deploy has not finished — not wired; re-run it, then this network)`)
      continue
    }
    await ensure(ctx, {
      desc: `route hub -> ${net}: adapter.setRoute(${c.label}, ${c.eid}, ${s.adapter})`,
      on: adapter, fn: 'setRoute', args: [c.label, c.eid, b32(s.adapter)],
      needed: async () => (await adapter.eidOf(c.label)) === 0n,
    })
    // the route is the admin's: after the hand-over it is not sent here but
    // queued (blocked) for the timelock, with pad.setGateway right behind it
    const routeQueued = ctx.last === 'blocked' || ctx.last === 'planned'
    // BEFORE the pad learns the gateway: from that moment every spawn SYNCs
    // this chain, and a send without a gas limit fails. Since v7.1 a failed
    // SYNC no longer undoes the spawn (the pad logs SyncFailed and goes on) —
    // but every token launched meanwhile is born WITHOUT a replica there and
    // has to be repaired one by one (scripts/resync.js, paid by the hub
    // tank). So the order still matters. Hub -> spoke messages are replies:
    // they carry no further budget.
    await ensure(ctx, {
      desc: `options hub -> ${net}: adapter.setDestination(${c.label}, gas ${spokeGas(profile, c)}, 0)`,
      on: adapter, fn: 'setDestination', args: [c.label, spokeGas(profile, c), 0n], role: 'operator',
      needed: async () => (await adapter.gasLimit(c.label)) === 0n,
    })
    const gasQueued = ctx.last === 'planned'
    if (!isStub(adapter)) {
      const gasSet = (await adapter.gasLimit(c.label)) !== 0n
      const routeSet = (await adapter.eidOf(c.label)) !== 0n
      // The gas limit is the OPERATOR's and must be ON CHAIN (or, in a dry
      // run, about to be sent by this very key) before pad.setGateway is
      // even queued: the timelock batch is setRoute then setGateway, and the
      // moment it executes every spawn SYNCs this chain.
      if (!(gasSet || gasQueued) || !(routeSet || routeQueued)) {
        ctx.log(`  (${net}: route or options missing — pad.setGateway withheld: tokens would be launched without a replica there)`)
        continue
      }
    }
    await ensure(ctx, {
      desc: `pad.setGateway(${c.label}, ${net})`,
      on: pad, fn: 'setGateway', args: [c.label, b32(s.gateway)],
      needed: async () => (await pad.gateways(c.label)) === ethers.ZeroHash,
    })
  }
  // at home a trade's reply is a free local call; a spawn SYNCs every spoke
  await setLegs(ctx, local.gateway, 0, remoteSpokes(ctx))
  // v7.2: an open here is answered by a local call — it prepays nothing
  await ensure(ctx, {
    desc: 'gateway.setOpenLegs(0) — an open on the hub chain is a local call',
    on: local.gateway, fn: 'setOpenLegs', args: [0], role: 'operator',
    needed: async () => Number(await local.gateway.openLegs()) !== 0,
  })
  await setRequestCaps(ctx, pad)
  await setMoveRoutes(ctx, local.gateway, adapter, 0)
  await setOpGas(ctx, adapter)
}

async function deploySpoke(ctx, roles) {
  const { profile, cfg, netKey } = ctx
  const hubCfg = profile.nets[profile.hub]
  const hub = ctx.all[profile.hub]
  if (!hub?.pad || !hub?.adapter) throw new Error(`deploy the hub first (${profile.hub})`)
  if (hub.transport !== GENERATION) {
    throw new Error(`the hub (${profile.hub}) is a ${hub.transport ?? 'pre-v7'} deployment — redeploy it as ${GENERATION} first`)
  }
  const adapter = await deployAdapter(ctx)
  await setRoles(ctx, adapter, 'adapter', roles)
  const side = await deployUserSide(ctx, adapter, hub.pad, { usd: 'usd', dist: 'dist' }, roles)

  await ensure(ctx, {
    desc: `route spoke -> hub: adapter.setRoute(0, ${hubCfg.eid}, ${hub.adapter})`,
    on: adapter, fn: 'setRoute', args: [0, hubCfg.eid, b32(hub.adapter)],
    needed: async () => (await adapter.eidOf(0)) === 0n,
  })
  await setDestination(ctx, adapter, 0, profile.gasToHub, profile.returnUnit, 'options spoke -> hub')
  await setOpGas(ctx, adapter)
  // a trade prepays its one reply; a spawn the SYNC to every spoke
  await setLegs(ctx, side.gateway, 1, remoteSpokes(ctx))
  // v7.2: a claim may move from here to every other deployed chain
  await setMoveRoutes(ctx, side.gateway, adapter, 1)
  await setCctpPeers(ctx, side.usd, 'usd')
  await topUpTank(ctx, adapter)
  if (!ctx.dry && !ctx.blocked.length && !ctx.state.ready) {
    // from here the hub may wire this spoke
    ctx.state.ready = true
    ctx.save()
  }
  ctx.log(`  ➜ re-run on ${profile.hub} to wire hub -> ${netKey}`)
  ctx.log('  ➜ then on every OTHER spoke already deployed (refreshes spawnLegs, move routes and CCTP peers)')
}

/* ------------------------------- self-check ------------------------------- */

/**
 * Reads every wired value of `netKey` back from the chain and compares it
 * with the plan. `soft` rows are values the operator may tune later (fee
 * budgets, gas limits, caps): a difference there is reported, not fatal.
 */
async function selfCheck({ profile, netKey, stateFile, provider, providers, roles, log = console.log }) {
  const cfg = profile.nets[netKey]
  const nets = activeNets(profile)
  const all = loadState(stateFile ?? profile.stateFile)
  const s = all[netKey]
  const rows = []
  const row = (what, actual, expected, soft = false) => {
    const ok = same(actual, expected)
    rows.push({ what, actual: String(actual), expected: String(expected), ok, soft })
  }
  if (!s?.adapter) return { rows, ok: false, missing: true }
  const at = (name, addr) => ethers.getContractAt(name, addr, provider)
  const hubSide = netKey === profile.hub
  const adapter = await at('LayerZeroOmniMessenger', s.adapter)
  const endpoint = new ethers.Contract(profile.endpoint, ENDPOINT_ABI, provider)
  const vaultKey = hubSide ? 'localUsd' : 'usd'
  const distKey = hubSide ? 'localDist' : 'dist'
  const need = hubSide ? ['usd', 'pad', 'venue', 'localUsd', 'gateway', 'localDist'] : ['usd', 'gateway', 'dist']
  for (const k of need) if (!s[k]) rows.push({ what: `${k} deployed`, actual: 'missing', expected: 'deployed', ok: false })
  if (rows.some((r) => !r.ok)) return { rows, ok: false }

  row('adapter.endpoint', await adapter.endpoint(), profile.endpoint)
  row('adapter.localEid', await adapter.localEid(), cfg.eid)
  row('endpoint.delegates(adapter) == adapter.admin', await endpoint.delegates(s.adapter), await adapter.admin())

  const vault = await at(vaultName(profile, netKey), s[vaultKey])
  const gateway = await at('SpawnGateway', s.gateway)
  const dist = await at('FeeDistributor', s[distKey])
  row(`${vaultKey}.chainLabel`, await vault.chainLabel(), cfg.label)
  if (!profile.mockUsdc) row(`${vaultKey}.usdc`, await vault.usdc(), cfg.usdc)
  if (hasCctp(profile, netKey)) row(`${vaultKey}.tokenMessenger`, await vault.tokenMessenger(), cfg.tokenMessenger)
  // the vault and the dollar must agree on the scale: SCALE × 10^decimals = 1e18
  row(`${vaultKey}.SCALE`, await vault.SCALE(), dollarScale(profile, netKey))
  row(`${vaultKey}.agent`, await vault.agent(), s.gateway)
  row(
    `${vaultKey}.depositCap`,
    await vault.depositCap(),
    profile.openDeposits ? dollarUnits(profile, deployCapOf(profile, netKey), netKey) : 0n,
    true,
  )
  row('gateway.messenger', await gateway.messenger(), s.adapter)
  row('gateway.usd', await gateway.usd(), s[vaultKey])
  row('gateway.chainLabel', await gateway.chainLabel(), cfg.label)
  row('gateway.pad', await gateway.pad(), all[profile.hub].pad)
  row('gateway.distributor', await gateway.distributor(), s[distKey])
  row('adapter.senders(gateway)', await adapter.senders(s.gateway), true)
  row('adapter.labelOfSender(gateway)', await adapter.labelOfSender(s.gateway), cfg.label)
  row('adapter.sponsored(gateway)', await adapter.sponsored(s.gateway), profile.sponsored)
  row(`${distKey}.agent`, await dist.agent(), s.gateway)
  row(`${distKey}.exclusionsSealed`, await dist.exclusionsSealed(), true)
  const spokes = Object.entries(nets).filter(([n, c]) => c.role === 'spoke' && all[n]?.gateway)
  const tradeLegs = await gateway.tradeLegs()
  if (hubSide) {
    row('gateway.tradeLegs', tradeLegs, 0, true)
  } else {
    // HARD, not operator-tunable: tradeLegs defaults to 0 and nothing on
    // chain enforces it. A REMOTE gateway left at 0 lets every buy, sell,
    // claim and pull from that chain ride the HUB TANK for its reply — a
    // drain anyone can run. (How MANY legs is the operator's to tune.)
    rows.push({
      what: 'gateway.tradeLegs ≥ 1 on a REMOTE gateway (0 = replies paid by the hub tank)',
      actual: String(tradeLegs),
      expected: '≥ 1',
      ok: tradeLegs >= 1n,
      soft: false,
    })
  }
  // the floor: one leg per remote chain that launches always reach
  // (a chain with a launch ceiling is priced in by tune-fees when it is cheap)
  const floorLegs = spokes.filter(([, c]) => c.syncCap === undefined).length
  const spawnLegs = await gateway.spawnLegs()
  rows.push({
    what: 'gateway.spawnLegs ≥ one per remote chain without a launch ceiling',
    actual: String(spawnLegs), expected: `≥ ${floorLegs}`, ok: spawnLegs >= BigInt(floorLegs), soft: true,
  })

  // ── v7.2: opens and moves ──
  const openLegs = await gateway.openLegs()
  if (hubSide) {
    row('gateway.openLegs (an open on the hub chain is a local call)', openLegs, 0)
  } else {
    // HARD: openLegs = 0 on a remote gateway lets anyone make the hub tank
    // pay a SYNC toward this chain, as often as they like
    rows.push({
      what: 'gateway.openLegs ≥ 1 on a REMOTE gateway (0 = opens paid by the hub tank)',
      actual: String(openLegs), expected: '≥ 1', ok: openLegs >= 1n, soft: false,
    })
  }
  for (const [net, c] of Object.entries(nets)) {
    if (net === netKey || !all[net]?.gateway) continue
    const legs = await gateway.moveLegs(c.label)
    rows.push({
      what: `gateway.moveLegs(${net}) priced (0 = moves there refused)`,
      actual: String(legs), expected: '≥ 1', ok: legs >= 1n, soft: true,
    })
  }

  if (vaultKind(profile, netKey) === 'cctp') {
    for (const [net, c] of Object.entries(hasCctp(profile, netKey) ? nets : {})) {
      if (net === netKey) continue
      if (vaultKind(profile, net) !== 'cctp') continue
      const peerVault = vaultOf(profile, net, all[net])
      if (!peerVault) continue
      const p = await vault.peers(c.label)
      row(`${vaultKey}.peers(${net}).vault`, p.vault, b32(peerVault))
      row(`${vaultKey}.peers(${net}).domain`, p.domain, c.cctpDomain)
    }
    // HARD: the USDT vault is never a CCTP peer (every USDC peer is checked
    // above against its own chain's vault and domain)
    for (const [n, c] of Object.entries(profile.nets)) {
      if (n === netKey || vaultKind(profile, n) !== 'local') continue
      const p = await vault.peers(c.label)
      const bad = p.vault !== ethers.ZeroHash
      rows.push({
        what: `${vaultKey}: the USDT vault is NOT a CCTP peer (label ${c.label} = ${n})`,
        actual: bad ? `PEER ${p.vault}` : 'not a peer', expected: 'not a peer', ok: !bad, soft: false,
      })
    }
  }

  if (hubSide) {
    const pad = await at('SpawnPad', s.pad)
    const hubUsd = await at('OmniUSD', s.usd)
    row('pad.messenger', await pad.messenger(), s.adapter)
    row('pad.usd', await pad.usd(), s.usd)
    row('pad.venue', await pad.venue(), s.venue)
    row('usd (ledger).agent', await hubUsd.agent(), s.pad)
    row('usd (ledger).usdc', await hubUsd.usdc(), ethers.ZeroAddress)
    row('adapter.senders(pad)', await adapter.senders(s.pad), true)
    row('adapter.labelOfSender(pad)', await adapter.labelOfSender(s.pad), 0)
    row('adapter.sponsored(pad)', await adapter.sponsored(s.pad), true)
    row('adapter.isLocal(0)', await adapter.isLocal(0), true)
    row(`adapter.isLocal(${cfg.label})`, await adapter.isLocal(cfg.label), true)
    row('adapter.returnUnit(0)', await adapter.returnUnit(0), profile.returnUnit, true)
    row(`pad.gateways(${cfg.label})`, await pad.gateways(cfg.label), b32(s.gateway))
    row(`pad.autoDrop(${cfg.label})`, await pad.autoDrop(cfg.label), true)
    for (const [net, c] of Object.entries(nets)) {
      if (c.role !== 'spoke') continue
      // the launch ceiling is a policy figure of the profile (0 = none)
      row(`pad.syncCap(${net})`, await pad.syncCap(c.label), c.syncCap ?? 0n, true)
    }
    // THE RULES (v7.2), from on-chain values on every chain: no request
    // toward a chain may cost the tank more than it prepaid — per kind
    try {
      const solv = await requestSolvency({ profile, all, providers: { ...providers, [netKey]: provider }, quotes: false })
      for (const r of solv.rows) {
        rows.push({
          what: `pad.requestCap(${r.net}, SYNC) ≤ what an open from it prepays`,
          actual: `${r.capSync}`, expected: `≤ ${r.open}`, ok: r.syncOk, soft: false,
        })
        rows.push({
          what: `pad.requestCap(${r.net}, PAYOUT) ≤ what every move toward it prepays`,
          actual: `${r.capPayout}`, expected: `≤ ${r.minMove ?? 'any (no route toward it)'}`, ok: r.payoutOk, soft: false,
        })
        if (all[r.net]?.ready && (r.capSync === 0n || (r.minMove !== undefined && r.capPayout === 0n))) {
          rows.push({ what: `pad.requestCap(${r.net}) set for both kinds (0 = closed to opens / incoming moves)`, actual: `${r.capSync} / ${r.capPayout}`, expected: '> 0', ok: false, soft: true })
        }
      }
    } catch (e) {
      rows.push({ what: 'request ceilings readable on every chain', actual: e.shortMessage ?? e.message, expected: 'readable', ok: false, soft: true })
    }
    // HARD (second round): the pad's skippable messages carry one return
    // leg, so the hub adapter would attach returnUnit[dst] to every SYNC and
    // forwarded PAYOUT. On an EVM label it must be 0 — the hub chain's own
    // gateway included (a move toward it would stop fitting under its zero
    // ceiling, a local SYNC would stop being free), and every remote one (each
    // SYNC would gift the unit to that spoke's tank out of the hub's).
    const units = await hubUnits({ profile, all, providers: { ...providers, [netKey]: provider } })
    for (const u of units.rows) {
      rows.push(
        u.evm
          ? { what: `hub adapter.returnUnit(${u.label} = ${u.net}) is 0 (an EVM label)`, actual: String(u.unit), expected: '0', ok: u.ok, soft: false }
          : { what: `hub adapter.returnUnit(1 = solana) in LAMPORTS, within ${u.expected}`, actual: String(u.unit), expected: u.expected, ok: u.ok, soft: false },
      )
    }
    // SOLANA (label 1), once recorded: a WIDE gateway there and only there,
    // its route, compute units within Solana's ceiling, no EVM per-op gas
    if (profile.solana && all.solana?.store) {
      const { SOLANA_BOUNDS } = require('../config/profiles')
      const sol = profile.solana
      const gw1 = await pad.gateways(1)
      if (gw1 !== ethers.ZeroHash) {
        row('pad.gateways(1 = solana) is the recorded store', gw1, all.solana.store)
        rows.push({ what: 'pad.gateways(1) is WIDE (a Solana key, not an address)', actual: BigInt(gw1) >> 160n !== 0n ? 'wide' : 'ADDRESS-SHAPED', expected: 'wide', ok: BigInt(gw1) >> 160n !== 0n, soft: false })
        row('pad.autoDrop(1 = solana)', await pad.autoDrop(1), false)
      }
      if ((await adapter.eidOf(1)) !== 0n) {
        row('adapter.eidOf(1 = solana)', await adapter.eidOf(1), sol.eid)
        row('adapter.peers(solana eid)', await adapter.peers(sol.eid), all.solana.peer)
      }
      const g1 = BigInt(await adapter.gasLimit(1))
      rows.push({ what: `adapter.gasLimit(1) in COMPUTE UNITS, ${SOLANA_BOUNDS.minGas}–${SOLANA_BOUNDS.maxGas}`, actual: String(g1), expected: String(sol.gas), ok: g1 === 0n ? gw1 === ethers.ZeroHash : g1 >= SOLANA_BOUNDS.minGas && g1 <= SOLANA_BOUNDS.maxGas, soft: false })
      for (const op of [1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13]) {
        const g = BigInt(await adapter.gasForOp(1, op))
        if (g !== 0n) rows.push({ what: `adapter.gasForOp(1, op ${op}) is 0 — label 1 never gets the EVM per-op gas`, actual: String(g), expected: '0', ok: false, soft: false })
      }
    }
    // an EVM gateway is never wide (only label 1 may be)
    for (const [net, c] of Object.entries(nets)) {
      const g = await pad.gateways(c.label)
      if (g !== ethers.ZeroHash && BigInt(g) >> 160n !== 0n) rows.push({ what: `pad.gateways(${c.label} = ${net}) is address-shaped (an EVM gateway)`, actual: g, expected: 'an address', ok: false, soft: false })
    }
    for (const [net, c] of spokes) {
      const sp = all[net]
      if (!sp.ready) continue
      row(`adapter.eidOf(${net})`, await adapter.eidOf(c.label), c.eid)
      row(`adapter.peers(${net})`, await adapter.peers(c.eid), b32(sp.adapter))
      row(`adapter.gasLimit(${net})`, await adapter.gasLimit(c.label), spokeGas(profile, c), true)
      row(`pad.gateways(${net})`, await pad.gateways(c.label), b32(sp.gateway))
      row(`pad.autoDrop(${net})`, await pad.autoDrop(c.label), false)
    }
  } else {
    const hubCfg = profile.nets[profile.hub]
    row('adapter.eidOf(hub)', await adapter.eidOf(0), hubCfg.eid)
    row('adapter.peers(hub)', await adapter.peers(hubCfg.eid), b32(all[profile.hub].adapter))
    row('adapter.gasLimit(hub)', await adapter.gasLimit(0), profile.gasToHub, true)
    row('adapter.returnUnit(hub)', await adapter.returnUnit(0), profile.returnUnit, true)
  }

  if (roles) {
    for (const [key, name] of roleKeys(profile, netKey)) {
      const c = await at(name, s[key])
      row(`${key}.operator`, await c.operator(), roles.operator, true)
      row(`${key}.guardian`, await c.guardian(), roles.guardian, true)
    }
  }

  const hard = rows.filter((r) => !r.ok && !r.soft)
  const softDiff = rows.filter((r) => !r.ok && r.soft)
  log(`self-check — ${profile.name}/${netKey}: ${rows.length} values read back`)
  for (const r of rows) {
    if (r.ok) continue
    log(`  ${r.soft ? '~' : '✗'} ${r.what}: on chain ${r.actual}, plan ${r.expected}${r.soft ? ' (operator-tunable)' : ''}`)
  }
  if (!hard.length && !softDiff.length) log('  ✓ everything on chain matches the plan')
  else if (!hard.length) log('  ✓ topology and custody wiring match the plan')
  return { rows, ok: hard.length === 0, hard, soft: softDiff }
}

/* -------------------------------- manifest -------------------------------- */

/**
 * The frontend manifest: what the site needs to talk to this deployment.
 * Testnet → public/onchain/testnet.json; mainnet → public/onchain/mainnet.json
 * with `"network": "mainnet"`, `"universe"`, the top-level `"dollar": {
 * symbol, decimals }`, `"generation": "v7.2"`, `"hubMessenger"` (the hub
 * adapter), a per-chain `depositCap` in that chain's dollar's OWN smallest
 * units (read from the vault), and no gasDrip. Per chain: `"vault": "cctp" |
 * "local"`, and — when it differs from the top-level one — its own `"dollar":
 * { symbol, decimals }` (BNB Chain: USDT, 18). The per-chain field `usdc`
 * keeps its name and holds THAT chain's dollar token.
 */
async function buildManifest({ profile, stateFile, hubProvider, previous, providers }) {
  const all = loadState(stateFile ?? profile.stateFile)
  const hub = all[profile.hub]
  if (!hub?.pad) return null
  const hubCfg = profile.nets[profile.hub]
  let fromBlock = previous?.pad === hub.pad ? previous.fromBlock : undefined
  if (!fromBlock) fromBlock = Math.max(0, Number(await hubProvider.getBlockNumber()) - 300)
  // in the chain's dollar's own smallest units (USDC: 6 decimals; BSC USDT:
  // 18) — read from the vault itself (set-cap.js moves it after the deploy:
  // canary cap, launch cap, 0 when closed); the profile's figure only when
  // the chain cannot be asked
  const planned = (net) => (profile.openDeposits ? String(dollarUnits(profile, deployCapOf(profile, net), net)) : '0')
  const capOf = async (net, vault, provider) => {
    try {
      const v = new ethers.Contract(vault, ['function depositCap() view returns (uint256)'], provider)
      return String(await v.depositCap())
    } catch {
      return planned(net)
    }
  }
  const top = { symbol: dollarOf(profile), decimals: dollarOfNet(profile, profile.hub).decimals }
  /** what is per chain about money: its vault kind, and its own dollar when
   * it is not the top-level one */
  const money = (net) => {
    const d = dollarOfNet(profile, net)
    return {
      vault: vaultKind(profile, net),
      ...(d.symbol !== top.symbol || d.decimals !== top.decimals ? { dollar: { symbol: d.symbol, decimals: d.decimals } } : {}),
    }
  }
  const spokeProvider = (net, cfg) =>
    providers?.[net] ?? new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId, { staticNetwork: true })
  const chains = []
  // the hub chain is a user-facing chain too — trades there are local (one
  // transaction, no LayerZero message, no messaging fee)
  if (hub.gateway) {
    chains.push({
      label: hubCfg.label, id: hubCfg.id,
      gateway: hub.gateway, usd: hub.localUsd, usdc: hub.usdc, dist: hub.localDist,
      chainId: hubCfg.chainId, rpc: hubCfg.rpc,
      local: true,
      ...money(profile.hub),
      ...(profile.mainnet ? { depositCap: await capOf(profile.hub, hub.localUsd, hubProvider) } : {}),
    })
  }
  // A spoke is listed only once the hub has WIRED it. A spoke that joins a
  // live deployment sits deployed-but-unwired for the timelock delay (48h):
  // listed early, the site would send users to a chain whose messages the
  // hub still rejects.
  const padView = new ethers.Contract(hub.pad, ['function gateways(uint32) view returns (bytes32)'], hubProvider)
  const wiredOnHub = async (label) => {
    for (let i = 0; i < 4; i++) {
      try {
        return await padView.gateways(label)
      } catch {
        await new Promise((r) => setTimeout(r, 1500 * i))
      }
    }
    return undefined // the hub RPC would not answer
  }
  for (const [net, cfg] of Object.entries(activeNets(profile))) {
    if (cfg.role !== 'spoke' || !all[net]?.gateway) continue
    const wired = await wiredOnHub(cfg.label)
    // An unreachable hub must never silently DROP a live chain from the
    // site: when the hub cannot be asked, the previous manifest decides.
    const listed =
      wired === undefined
        ? !!previous?.chains?.some((c) => c.label === cfg.label && same(c.gateway, all[net].gateway))
        : same(wired, b32(all[net].gateway))
    if (!listed) continue
    chains.push({
      label: cfg.label, id: cfg.id,
      gateway: all[net].gateway, usd: all[net].usd, usdc: all[net].usdc, dist: all[net].dist,
      chainId: cfg.chainId, rpc: cfg.rpc,
      ...money(net),
      ...(profile.mainnet ? { depositCap: await capOf(net, all[net].usd, spokeProvider(net, cfg)) } : {}),
    })
  }
  return {
    ...(profile.mainnet ? { network: 'mainnet' } : {}),
    ...(profile.universe ? { universe: profile.universe } : {}),
    // the contract generation the site codes against
    generation: GENERATION,
    // the hub chain's dollar, and every chain's that names no other — the
    // site reads symbols and decimals from here, never assumes 6
    dollar: top,
    chainId: hubCfg.chainId,
    rpc: hubCfg.rpc,
    pad: hub.pad,
    venue: hub.venue,
    hubUsd: hub.usd,
    // the hub adapter: the pad's messenger (quotes for resync, tank level)
    hubMessenger: hub.adapter,
    fromBlock,
    ...(profile.gasDrip ? { gasDrip: profile.gasDrip } : {}),
    // fees: when false, every gateway call must attach its `quote*` fee
    sponsored: profile.sponsored,
    chains,
    deployedAt: Date.now(),
  }
}

async function writeManifest(ctx) {
  const { profile, manifestFile, stateFile, netKey, signer } = ctx
  let previous
  try {
    previous = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch {
    /* first write */
  }
  const hubCfg = profile.nets[profile.hub]
  const hubProvider =
    ctx.providers?.[profile.hub] ??
    (netKey === profile.hub
      ? signer.provider
      : new ethers.JsonRpcProvider(hubCfg.rpc, hubCfg.chainId, { staticNetwork: true }))
  const manifest = await buildManifest({ profile, stateFile, hubProvider, previous, providers: ctx.providers })
  if (!manifest) return null
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  ctx.log(`frontend manifest: ${manifestFile} (${manifest.chains.length} chain(s))`)
  return manifest
}

/* ---------------------------------- main ---------------------------------- */

/**
 * Deploys / resumes / re-wires one network of a profile.
 * opts: { profile, netKey, signer, dry?, stateFile?, manifestFile?, log?, roles?, manifest?, providers?, preflight? }
 * Returns the context (gas totals, plan, blocked steps, self-check result).
 */
async function deployNet(opts) {
  const ctx = makeCtx(opts)
  const { profile, netKey, cfg, signer, log } = ctx
  const provider = signer.provider
  const bal0 = await provider.getBalance(signer.address)
  const coin = nativeOf(profile, netKey)
  log(
    `${profile.name}/${netKey} (${cfg.role}) — deployer ${signer.address} — ${fmt(bal0)} ${coin}` +
      (ctx.dry ? ' — DRY RUN: nothing will be sent' : ''),
  )
  // a programmatic `dry: false` is only honoured on a development node (a
  // local fork); against a live chain the confirmation phrase is the only way in
  const devNode = await isDevNode(provider)
  // a net kept in a profile only so the tooling can be rehearsed on forks
  if (cfg.rehearsalOnly && !devNode) throw new Error(`${netKey}: ${cfg.rehearsalOnly}`)
  if (profile.mainnet && !ctx.dry && !devNode && process.env.SPAWN_MAINNET_CONFIRM !== MAINNET_CONFIRM) {
    throw new Error(`refusing to send mainnet transactions without SPAWN_MAINNET_CONFIRM=${MAINNET_CONFIRM}`)
  }
  if (profile.mainnet && !ctx.dry) log('  ⚠ REAL MONEY: transactions will be sent')

  // skipping the preflight is a test-only convenience for the in-process
  // simulated network (mock endpoint); it is ignored anywhere else
  const skipPreflight = opts.preflight === false && network.name === 'hardhat'
  const pre = skipPreflight ? { ok: true, rows: [], failed: [] } : await preflight(ctx)
  ctx.preflight = pre
  if (!pre.ok) {
    const msg = `preflight failed: ${pre.failed.map((f) => f.what).join('; ')}`
    if (!ctx.dry) throw new Error(msg)
    log(`  ✗ ${msg} — a real run would stop here`)
  }

  // who holds the fast roles: an explicit choice, else what a completed
  // hand-over recorded (re-running the deploy must never try to take the
  // roles back), else the deployer
  const handed = ctx.state.handover
  const roles = opts.roles ?? {
    operator: ethers.getAddress(process.env.SPAWN_OPERATOR ?? handed?.operator ?? handed?.owner ?? signer.address),
    guardian: ethers.getAddress(process.env.SPAWN_GUARDIAN ?? handed?.guardian ?? signer.address),
  }
  ctx.roles = roles
  if (handed) log(`  (admin handed to the timelock ${handed.timelock} — admin-only steps are printed, not sent)`)
  if (profile.mainnet && (same(roles.operator, signer.address) || same(roles.guardian, signer.address))) {
    log('  ⚠ operator and/or guardian is the deployer — handover.js must replace them before deposits matter')
  }

  if (cfg.role === 'hub') await deployHub(ctx, roles)
  else await deploySpoke(ctx, roles)

  const bal1 = await provider.getBalance(signer.address)
  log(
    `cost: ${fmt(bal0 - bal1)} ${coin} (gas tank top-up and L1 data fees included) in ${ctx.gas.txs} tx(s), ` +
      `${ctx.gas.used} gas — ${fmt(bal1)} ${coin} left`,
  )
  if (ctx.dry) {
    log(ctx.plan.length ? `plan: ${ctx.plan.length} step(s) to run` : 'plan: nothing to do — already deployed and wired')
  }
  if (ctx.blocked.length) {
    log(`⏳ ${ctx.blocked.length} step(s) need another key (schedule admin steps through the timelock):`)
    for (const b of ctx.blocked) log(`   [${b.role}] ${b.desc}\n     target ${b.target}\n     data   ${b.data}`)
  }
  // read everything back (a dry run checks whatever already exists)
  if (ctx.state.gateway) {
    ctx.check = await selfCheck({ profile, netKey, stateFile: ctx.stateFile, provider, providers: ctx.providers, roles, log })
    if (!ctx.dry && !ctx.check.ok && !ctx.blocked.length) {
      throw new Error(`self-check failed: ${ctx.check.hard.map((r) => r.what).join('; ')}`)
    }
  }
  if (!ctx.dry && opts.manifest !== false) ctx.manifest = await writeManifest(ctx)
  return ctx
}

module.exports = {
  MAINNET_CONFIRM,
  GENERATION,
  ENDPOINT_ABI,
  USDC_ABI,
  CCTP_MESSENGER_ABI,
  CCTP_TRANSMITTER_ABI,
  b32,
  same,
  loadState,
  saveState,
  vaultOf,
  vaultName,
  hasCctp,
  nativeOf,
  dollarOf,
  distOf,
  spokeGas,
  localLabels,
  refuseLocalPeers,
  roleKeys,
  preflight,
  deployBudget,
  LIFE_GAS,
  deployNet,
  selfCheck,
  buildManifest,
  writeManifest,
  hasRole,
  isDevNode,
  cliSigner,
}
