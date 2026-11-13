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
const { activeNets } = require('../config/profiles')

const MAINNET_CONFIRM = 'I_UNDERSTAND_THIS_IS_REAL_MONEY'
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

/** Every contract of one net that answers to the three Roles, by state key. */
function roleKeys(profile, net) {
  return net === profile.hub
    ? [
        ['adapter', 'LayerZeroOmniMessenger'],
        ['usd', 'OmniUSD'],
        ['pad', 'SpawnPad'],
        ['localUsd', 'OmniUSD'],
        ['gateway', 'SpawnGateway'],
        ['localDist', 'FeeDistributor'],
      ]
    : [
        ['adapter', 'LayerZeroOmniMessenger'],
        ['usd', 'OmniUSD'],
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
    throw new Error(`${netKey} is disabled in the ${profile.name} profile — SPAWN_ENABLE=${netKey} switches it on`)
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
  const gas = g.deploy + g.dvnPerPathway * BigInt(cfg.role === 'hub' ? spokes : 1) + g.handover
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
    const tm = new ethers.Contract(cfg.tokenMessenger, CCTP_MESSENGER_ABI, provider)
    const get = async (p) => {
      try {
        return await p
      } catch (e) {
        return `call failed: ${e.shortMessage ?? e.message}`
      }
    }
    const symbol = await get(usdc.symbol())
    check('USDC symbol()', symbol === 'USDC', `"${symbol}" at ${cfg.usdc}`)
    const decimals = await get(usdc.decimals())
    check('USDC decimals()', Number(decimals) === 6, String(decimals))
    const minter = await get(tm.localMinter())
    const isMinter = ethers.isAddress(minter) ? await get(usdc.isMinter(minter)) : false
    check(
      'USDC is the Circle-native token (isMinter(TokenMessengerV2.localMinter()))',
      isMinter === true,
      `minter ${minter} → ${isMinter}`,
    )
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

  if (profile.budget) {
    const { need, how } = await deployBudget(ctx)
    const bal = await provider.getBalance(signer.address)
    // a finished deployment re-runs for a few wiring txs: no full budget needed
    const fresh = !ctx.state.gateway
    check(
      'deployer balance covers the deploy budget',
      !fresh || bal >= need,
      `${fmt(bal)} ETH, budget ${fmt(need)} ETH (${how})${fresh ? '' : ' (already deployed — not required)'}`,
    )
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
  if (state.adapter && state.transport !== 'v7') {
    throw new Error(
      `${netKey}: pre-v7 deployment in the state — archive this network's entry before deploying v7 ` +
        `(node scripts/archive-state.js; the old gas tank is recoverable with scripts/recover-tanks.js)`,
    )
  }
  const adapter = await deployOnce(ctx, 'adapter', 'LayerZeroOmniMessenger', () => [profile.endpoint, cfg.eid])
  if (!isStub(adapter) && state.transport !== 'v7') {
    state.transport = 'v7'
    ctx.save()
  }
  return adapter
}

/** One chain's dollar stack + gateway + holder pool, wired to `adapter`. */
async function deployUserSide(ctx, adapter, padAddr, keys, roles) {
  const { profile, cfg } = ctx
  let usdcAddr = cfg.usdc
  let usdc
  if (profile.mockUsdc) {
    usdc = await deployOnce(ctx, 'usdc', 'MockUSDC', () => [])
    usdcAddr = usdc.target
  } else if (ctx.state.usdc !== cfg.usdc) {
    // recorded for the frontend manifest; the real token is never deployed
    ctx.state.usdc = cfg.usdc
    if (!ctx.dry) ctx.save()
  }
  const usd = await deployOnce(ctx, keys.usd, 'OmniUSD', () => [
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
  const cap = profile.depositCapUsdc * 10n ** 6n
  if (profile.openDeposits) {
    await ensure(ctx, {
      desc: `${keys.usd}.setDepositCap(${profile.depositCapUsdc} USDC) — deposits open`,
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

/** CCTP rebalancing routes: this chain's vault may only ever send USDC to
 * the vault of another chain of the deployment. Set once per peer. */
async function setCctpPeers(ctx, usd, what) {
  const { profile, netKey, nets, all } = ctx
  if (profile.mockUsdc) return
  for (const [net, c] of Object.entries(nets)) {
    if (net === netKey) continue
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

async function setDestination(ctx, adapter, label, gas, unit, what) {
  await ensure(ctx, {
    desc: `${what}: adapter.setDestination(${label}, gas ${gas}, reply budget ${fmt(unit)} ETH/leg)`,
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

/** Remote spokes in the state — what a spawn must prepay in SYNC replies. A
 * spoke counts from the moment its gateway is deployed (slightly early: the
 * hub only SYNCs it once wired), so a spawn never underpays. */
function remoteSpokes(ctx) {
  return Object.entries(ctx.nets).filter(([net, c]) => c.role === 'spoke' && loadState(ctx.stateFile)[net]?.gateway)
    .length
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
  // a locally-initiated spawn prepays the hub's remote SYNC fan-out
  await ensure(ctx, {
    desc: `local fan-out budget: adapter.setDestination(0, 0, ${fmt(profile.returnUnit)} ETH/leg)`,
    on: adapter, fn: 'setDestination', args: [0, 0n, profile.returnUnit], role: 'operator',
    needed: async () => (await adapter.returnUnit(0)) === 0n,
  })
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
    // this chain, and a send without a gas limit reverts. Hub -> spoke
    // messages are replies: they carry no further budget.
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
        ctx.log(`  (${net}: route or options missing — pad.setGateway withheld so spawns cannot break)`)
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
}

async function deploySpoke(ctx, roles) {
  const { profile, cfg, netKey } = ctx
  const hubCfg = profile.nets[profile.hub]
  const hub = ctx.all[profile.hub]
  if (!hub?.pad || !hub?.adapter) throw new Error(`deploy the hub first (${profile.hub})`)
  if (hub.transport !== 'v7') throw new Error(`the hub (${profile.hub}) is pre-v7 — redeploy it first`)
  const adapter = await deployAdapter(ctx)
  await setRoles(ctx, adapter, 'adapter', roles)
  const side = await deployUserSide(ctx, adapter, hub.pad, { usd: 'usd', dist: 'dist' }, roles)

  await ensure(ctx, {
    desc: `route spoke -> hub: adapter.setRoute(0, ${hubCfg.eid}, ${hub.adapter})`,
    on: adapter, fn: 'setRoute', args: [0, hubCfg.eid, b32(hub.adapter)],
    needed: async () => (await adapter.eidOf(0)) === 0n,
  })
  await setDestination(ctx, adapter, 0, profile.gasToHub, profile.returnUnit, 'options spoke -> hub')
  // a trade prepays its one reply; a spawn the SYNC to every spoke
  await setLegs(ctx, side.gateway, 1, remoteSpokes(ctx))
  await setCctpPeers(ctx, side.usd, 'usd')
  await topUpTank(ctx, adapter)
  if (!ctx.dry && !ctx.blocked.length && !ctx.state.ready) {
    // from here the hub may wire this spoke
    ctx.state.ready = true
    ctx.save()
  }
  ctx.log(`  ➜ re-run on ${profile.hub} to wire hub -> ${netKey}`)
  ctx.log('  ➜ then on every OTHER spoke already deployed (refreshes spawnLegs and CCTP peers)')
}

/* ------------------------------- self-check ------------------------------- */

/**
 * Reads every wired value of `netKey` back from the chain and compares it
 * with the plan. `soft` rows are values the operator may tune later (fee
 * budgets, gas limits, caps): a difference there is reported, not fatal.
 */
async function selfCheck({ profile, netKey, stateFile, provider, roles, log = console.log }) {
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

  const vault = await at('OmniUSD', s[vaultKey])
  const gateway = await at('SpawnGateway', s.gateway)
  const dist = await at('FeeDistributor', s[distKey])
  row(`${vaultKey}.chainLabel`, await vault.chainLabel(), cfg.label)
  if (!profile.mockUsdc) {
    row(`${vaultKey}.usdc`, await vault.usdc(), cfg.usdc)
    row(`${vaultKey}.tokenMessenger`, await vault.tokenMessenger(), cfg.tokenMessenger)
  }
  row(`${vaultKey}.agent`, await vault.agent(), s.gateway)
  row(
    `${vaultKey}.depositCap`,
    await vault.depositCap(),
    profile.openDeposits ? profile.depositCapUsdc * 10n ** 6n : 0n,
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
  row('gateway.tradeLegs', await gateway.tradeLegs(), hubSide ? 0 : 1, true)
  row('gateway.spawnLegs', await gateway.spawnLegs(), spokes.length, true)

  if (!profile.mockUsdc) {
    for (const [net, c] of Object.entries(nets)) {
      if (net === netKey) continue
      const peerVault = vaultOf(profile, net, all[net])
      if (!peerVault) continue
      const p = await vault.peers(c.label)
      row(`${vaultKey}.peers(${net}).vault`, p.vault, b32(peerVault))
      row(`${vaultKey}.peers(${net}).domain`, p.domain, c.cctpDomain)
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
 * Testnet → public/onchain/testnet.json. Mainnet → public/onchain/mainnet.json
 * with `"network": "mainnet"`, a per-chain `depositCap` (USDC units, as
 * planned at deploy — the live value is `usd.depositCap()`), and no gasDrip.
 */
async function buildManifest({ profile, stateFile, hubProvider, previous }) {
  const all = loadState(stateFile ?? profile.stateFile)
  const hub = all[profile.hub]
  if (!hub?.pad) return null
  const hubCfg = profile.nets[profile.hub]
  let fromBlock = previous?.pad === hub.pad ? previous.fromBlock : undefined
  if (!fromBlock) fromBlock = Math.max(0, Number(await hubProvider.getBlockNumber()) - 300)
  const cap = profile.openDeposits ? String(profile.depositCapUsdc * 10n ** 6n) : '0'
  const chains = []
  // the hub chain is a user-facing chain too — trades there are local (one
  // transaction, no LayerZero message, no messaging fee)
  if (hub.gateway) {
    chains.push({
      label: hubCfg.label, id: hubCfg.id,
      gateway: hub.gateway, usd: hub.localUsd, usdc: hub.usdc, dist: hub.localDist,
      chainId: hubCfg.chainId, rpc: hubCfg.rpc,
      local: true,
      ...(profile.mainnet ? { depositCap: cap } : {}),
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
      ...(profile.mainnet ? { depositCap: cap } : {}),
    })
  }
  return {
    ...(profile.mainnet ? { network: 'mainnet' } : {}),
    chainId: hubCfg.chainId,
    rpc: hubCfg.rpc,
    pad: hub.pad,
    venue: hub.venue,
    hubUsd: hub.usd,
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
  const manifest = await buildManifest({ profile, stateFile, hubProvider, previous })
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
  log(
    `${profile.name}/${netKey} (${cfg.role}) — deployer ${signer.address} — ${fmt(bal0)} ETH` +
      (ctx.dry ? ' — DRY RUN: nothing will be sent' : ''),
  )
  // a programmatic `dry: false` is only honoured on a development node (a
  // local fork); against a live chain the confirmation phrase is the only way in
  const devNode = await isDevNode(provider)
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
    `cost: ${fmt(bal0 - bal1)} ETH (gas tank top-up and L1 data fees included) in ${ctx.gas.txs} tx(s), ` +
      `${ctx.gas.used} gas — ${fmt(bal1)} ETH left`,
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
    ctx.check = await selfCheck({ profile, netKey, stateFile: ctx.stateFile, provider, roles, log })
    if (!ctx.dry && !ctx.check.ok && !ctx.blocked.length) {
      throw new Error(`self-check failed: ${ctx.check.hard.map((r) => r.what).join('; ')}`)
    }
  }
  if (!ctx.dry && opts.manifest !== false) ctx.manifest = await writeManifest(ctx)
  return ctx
}

module.exports = {
  MAINNET_CONFIRM,
  ENDPOINT_ABI,
  USDC_ABI,
  CCTP_MESSENGER_ABI,
  CCTP_TRANSMITTER_ABI,
  b32,
  same,
  loadState,
  saveState,
  vaultOf,
  distOf,
  spokeGas,
  roleKeys,
  preflight,
  deployBudget,
  LIFE_GAS,
  deployNet,
  selfCheck,
  buildManifest,
  hasRole,
  isDevNode,
  cliSigner,
}
