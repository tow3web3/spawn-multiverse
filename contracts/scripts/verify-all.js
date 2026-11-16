/**
 * Publishes the verified source of EVERY SPAWN! contract of a deployment on
 * Sourcify and on Etherscan (V2 API: one key for Base, Optimism, Arbitrum,
 * Ethereum and BNB Chain), so each address shows the green check. Read-only
 * on every chain: it sends no transaction.
 *
 *   npx hardhat run scripts/verify-all.js                    # mainnet, both explorers
 *   VERIFY_DRY=1 npx hardhat run scripts/verify-all.js       # discover + check, submit nothing
 *   VERIFY_ONLY=sourcify …   VERIFY_ONLY=etherscan …         # one explorer
 *   VERIFY_NETS=base,bnb …                                   # some chains only
 *   VERIFY_TOKENS_ONLY=1 …                                   # only the tokens (new launches)
 *   SPAWN_PROFILE=testnet …                                  # another deployment (default mainnet)
 *
 * The Etherscan key is ETHERSCAN_API_KEY (env, else the line in contracts/.env),
 * wired through hardhat.config.js → etherscan.apiKey. Without it the
 * Etherscan column says "no key" and only Sourcify runs. The key is never
 * printed: no request URL appears in any message.
 *
 * WHAT IS VERIFIED
 * - every contract of the state file (deployments/<profile>.json), by key:
 *   adapter, usd / localUsd, pad, venue, gateway, dist / localDist, timelock
 *   (names from lib-net.js → roleKeys, the venue and the timelock added here).
 *   An address-valued key this script does not know fails the run, so a new
 *   contract is never silently left out. Third-party addresses (usdc) skipped.
 * - every token: the hub's from SpawnPad.allTokens (the pad's own list, the
 *   same set as its Spawned events), and each chain's replica from
 *   SpawnGateway.replicaOf(hubToken). Re-run it after launches (it skips what
 *   is verified), or schedule it: `VERIFY_TOKENS_ONLY=1` is cheap.
 * - NOT the ten orphans on BNB Chain (deployer nonces 0–7 and 11–12, the
 *   duplicates of failed attempts): a green check would make them look like
 *   live protocol contracts. They are in no state file, so nothing finds them.
 *
 * HOW EACH SUBMISSION IS CHECKED FIRST (a mismatch is never submitted)
 * 1. compiler input: the contract's build info in artifacts/ (what was
 *    deployed), cut down to the files it imports, RECOMPILED with the same
 *    solc and settings; the creation bytecode must equal the artifact's. (If
 *    the cut-down input compiles differently, the full input is used.)
 * 2. constructor arguments, derived from the deploy code path: each
 *    contract's own immutable getters (adapter: endpoint, localEid; vault:
 *    chainLabel, usdc[, tokenMessenger]; pad: messenger, usd; …), the
 *    timelock's bootstrap args from lib-handover.js, a token's from its
 *    getters and its creator's code (SpawnPad / SpawnGateway). Then
 *    - runtime: eth_call of (creation bytecode ‖ args) must return EXACTLY
 *      the on-chain code (immutables included) — else, if the simulation
 *      cannot run, the code with the immutables masked must match;
 *    - creation, when the creation is known (Etherscan's getcontractcreation
 *      or Sourcify's record): the creation code must be exactly
 *      (bytecode ‖ args). For a token born inside a pad / gateway call, the
 *      explorer's own trace-based creation check is the last word.
 *
 * Exit 0 when every address is verified on every explorer it ran against,
 * 1 otherwise.
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const hre = require('hardhat')
const { ethers } = hre
const {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  TASK_COMPILE_SOLIDITY_RUN_SOLC,
  TASK_COMPILE_SOLIDITY_RUN_SOLCJS,
} = require('hardhat/builtin-tasks/task-names')

process.env.SPAWN_PROFILE ??= 'mainnet'
const { getProfile } = require('../config/profiles')
const { loadState, roleKeys } = require('./lib-net')

const DRY = process.env.VERIFY_DRY === '1'
const ONLY = process.env.VERIFY_ONLY // sourcify | etherscan
const NETS = process.env.VERIFY_NETS ? process.env.VERIFY_NETS.split(',').map((s) => s.trim()) : null
const TOKENS_ONLY = process.env.VERIFY_TOKENS_ONLY === '1'
// the deployer of every contract the scripts deploy (same address on every chain)
const DEPLOYER = ethers.getAddress(process.env.SPAWN_DEPLOYER ?? '0x483E931A279B136A2C3fCA6BF5eC2c4239c1B904')

const SOURCIFY = 'https://sourcify.dev/server'
const ETHERSCAN = 'https://api.etherscan.io/v2/api'
const BROWSER = {
  1: 'https://etherscan.io', 10: 'https://optimistic.etherscan.io', 56: 'https://bscscan.com',
  8453: 'https://basescan.org', 42161: 'https://arbiscan.io',
  11155111: 'https://sepolia.etherscan.io', 11155420: 'https://sepolia-optimism.etherscan.io',
  97: 'https://testnet.bscscan.com', 84532: 'https://sepolia.basescan.org', 421614: 'https://sepolia.arbiscan.io',
}

/** state keys → contract, beyond lib-net's roleKeys */
const EXTRA_KEYS = { venue: 'InternalCurveVenue', timelock: 'SpawnTimelock' }
/** address-valued keys that are not ours */
const FOREIGN_KEYS = new Set(['usdc'])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const strip0x = (h) => (h.startsWith('0x') ? h.slice(2) : h)

/* ------------------------------ HTTP helpers ------------------------------ */

async function http(url, opts = {}, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(60_000) })
      const text = await r.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        body = { raw: text.slice(0, 300) }
      }
      if ((r.status === 429 || r.status >= 500) && i < tries) {
        await sleep(2000 * i)
        continue
      }
      return { status: r.status, body }
    } catch (e) {
      if (i >= tries) throw new Error(`network error (${e.cause?.code ?? e.name})`) // never the URL: it may hold a key
      await sleep(2000 * i)
    }
  }
}

/* --------------------------------- solc ---------------------------------- */

const CACHE_DIR = path.join(hre.config.paths.cache, 'verify-all')

/** The files `source` imports, transitively, from the build info's ASTs. */
function importClosure(buildInfo, source) {
  const seen = new Set()
  const stack = [source]
  while (stack.length) {
    const s = stack.pop()
    if (seen.has(s)) continue
    seen.add(s)
    const ast = buildInfo.output.sources[s]?.ast
    if (!ast) throw new Error(`no AST for ${s} in build info ${buildInfo.id}`)
    for (const n of ast.nodes) if (n.nodeType === 'ImportDirective') stack.push(n.absolutePath)
  }
  return seen
}

async function solc(input, version) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const key = crypto.createHash('sha256').update(version).update(JSON.stringify(input)).digest('hex')
  const file = path.join(CACHE_DIR, `${key}.json`)
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  const build = await hre.run(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, { quiet: true, solcVersion: version })
  const out = build.isSolcJs
    ? await hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLCJS, { input, solcJsPath: build.compilerPath })
    : await hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLC, { input, solcPath: build.compilerPath })
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error')
  if (errors.length) throw new Error(`solc: ${errors.map((e) => e.formattedMessage).join('\n')}`)
  // keep only what this script reads
  const slim = { contracts: {} }
  for (const [src, cs] of Object.entries(out.contracts ?? {})) {
    for (const [name, c] of Object.entries(cs)) {
      ;(slim.contracts[src] ??= {})[name] = {
        bytecode: c.evm.bytecode.object,
        deployed: c.evm.deployedBytecode.object,
        immutables: c.evm.deployedBytecode.immutableReferences ?? {},
      }
    }
  }
  fs.writeFileSync(file, JSON.stringify(slim))
  return slim
}

/** Per contract name: the artifact, the compiler input to publish, and the
 * proof by recompiling that it yields the deployed artifact's bytecode. */
const prepared = new Map()
async function prepare(name) {
  if (prepared.has(name)) return prepared.get(name)
  const p = (async () => {
    const art = await hre.artifacts.readArtifact(name)
    const fqn = `${art.sourceName}:${art.contractName}`
    const buildInfo = await hre.artifacts.getBuildInfo(fqn)
    if (!buildInfo) throw new Error(`${fqn}: no build info in artifacts/`)
    const built = buildInfo.output.contracts[art.sourceName][art.contractName]
    const want = built.evm.bytecode.object
    if (strip0x(art.bytecode) !== want) throw new Error(`${fqn}: artifact and build info disagree`)
    const notes = []

    const closure = importClosure(buildInfo, art.sourceName)
    const minimal = {
      language: buildInfo.input.language,
      sources: Object.fromEntries(Object.entries(buildInfo.input.sources).filter(([s]) => closure.has(s))),
      settings: buildInfo.input.settings,
    }
    let input = minimal
    let out = await solc(minimal, buildInfo.solcVersion)
    let got = out.contracts[art.sourceName]?.[art.contractName]
    if (got?.bytecode !== want) {
      notes.push('the cut-down input compiles differently: publishing the full build input')
      input = buildInfo.input
      out = await solc(input, buildInfo.solcVersion)
      got = out.contracts[art.sourceName]?.[art.contractName]
      if (got?.bytecode !== want) throw new Error(`${fqn}: recompiling the build input does not give the artifact`)
    }
    // the published sources vs the working tree (informative: the chain decides)
    const drift = Object.entries(input.sources).filter(([src, { content }]) => {
      const local = [path.join(hre.config.paths.root, src), path.join(hre.config.paths.root, 'node_modules', src)].find(
        (f) => fs.existsSync(f),
      )
      return !local || fs.readFileSync(local, 'utf8') !== content
    })
    if (drift.length) notes.push(`published as deployed, since edited in the tree: ${drift.map(([s]) => s).join(', ')}`)
    return {
      name,
      fqn,
      abi: art.abi,
      iface: new ethers.Interface(art.abi),
      bytecode: '0x' + got.bytecode,
      deployed: '0x' + got.deployed,
      immutables: got.immutables,
      input,
      solcLong: buildInfo.solcLongVersion,
      notes,
      files: Object.keys(input.sources).length,
    }
  })()
  prepared.set(name, p)
  return p
}

/* ------------------------- constructor arguments ------------------------- */

const call = (c, fn, ...a) => c[fn](...a)

/** The constructor arguments of `t`, from the code path that deployed it. */
async function deriveArgs(t, provider, abi) {
  const c = new ethers.Contract(t.address, abi, provider)
  switch (t.name) {
    case 'LayerZeroOmniMessenger': // lib-net deployAdapter: [profile.endpoint, cfg.eid]
      return [await call(c, 'endpoint'), await call(c, 'localEid')]
    case 'OmniUSD': // [label, usdc, tokenMessenger] (the hub ledger: [0, 0x0, 0x0])
      return [await call(c, 'chainLabel'), await call(c, 'usdc'), await call(c, 'tokenMessenger')]
    case 'OmniUSDLocal': // [label, token]
      return [await call(c, 'chainLabel'), await call(c, 'usdc')]
    case 'SpawnPad': // [adapter, usd]
      return [await call(c, 'messenger'), await call(c, 'usd')]
    case 'InternalCurveVenue': // [pad]
      return [await call(c, 'pad')]
    case 'SpawnGateway': // [adapter, vault, label, pad]
      return [await call(c, 'messenger'), await call(c, 'usd'), await call(c, 'chainLabel'), await call(c, 'pad')]
    case 'FeeDistributor': // [vault]
      return [await call(c, 'usd')]
    case 'SpawnTimelock': {
      // lib-handover.js: deploy(0, [deployer], [deployer], deployer) — the delay
      // is raised afterwards by a scheduled call, the roles handed over
      const who = t.creator ? ethers.getAddress(t.creator) : DEPLOYER
      return [0, [who], [who], who]
    }
    case 'SpawnToken': {
      const [name, symbol, controller, isHub] = await Promise.all(
        ['name', 'symbol', 'controller', 'isHub'].map((f) => call(c, f)),
      )
      if (isHub) {
        // SpawnPad._spawn: new SpawnToken(name, symbol, this, true, TOTAL_SUPPLY, this, 0x0)
        const pad = new ethers.Contract(controller, ['function TOTAL_SUPPLY() view returns (uint256)'], provider)
        return [name, symbol, controller, true, await pad.TOTAL_SUPPLY(), controller, ethers.ZeroAddress]
      }
      // SpawnGateway OP_SYNC_TOKEN: new SpawnToken(name, symbol, this, false, 0, 0x0, distributor)
      return [name, symbol, controller, false, 0n, ethers.ZeroAddress, await call(c, 'distributor')]
    }
    default:
      throw new Error(`no constructor recipe for ${t.name}`)
  }
}

/** On-chain code vs compiled runtime, with the immutable slots masked. */
function maskedEqual(onchain, prep) {
  const a = Buffer.from(strip0x(onchain), 'hex')
  const b = Buffer.from(strip0x(prep.deployed), 'hex')
  if (a.length !== b.length) return false
  for (const refs of Object.values(prep.immutables)) {
    for (const { start, length } of refs) {
      a.fill(0, start, start + length)
      b.fill(0, start, start + length)
    }
  }
  return a.equals(b)
}

async function checkOnChain(t, provider, prep) {
  const code = await provider.getCode(t.address)
  if (code === '0x') throw new Error('no code at this address')
  t.args = await deriveArgs(t, provider, prep.abi)
  t.encodedArgs = prep.iface.encodeDeploy(t.args)
  t.initcode = prep.bytecode + strip0x(t.encodedArgs)
  let runtime
  try {
    const sim = await provider.send('eth_call', [{ from: t.creator ?? DEPLOYER, data: t.initcode, gas: '0x2faf080' }, 'latest'])
    runtime = sim === code ? 'exact' : maskedEqual(code, prep) ? 'ARGS?' : 'MISMATCH'
  } catch {
    runtime = maskedEqual(code, prep) ? 'masked' : 'MISMATCH'
  }
  t.runtime = runtime
  return runtime === 'exact' || runtime === 'masked'
}

/** Creation code check against what an explorer recorded (or the tx itself). */
async function checkCreation(t, provider, prep) {
  let creation = t.creationCode
  if (!creation && t.creationTx) {
    const tx = await provider.getTransaction(t.creationTx)
    if (tx && tx.to === null) creation = tx.data
  }
  if (!creation) return (t.creation = t.creationTx ? 'factory' : 'unknown')
  if (same(creation, t.initcode)) return (t.creation = 'exact')
  return (t.creation = strip0x(creation).startsWith(strip0x(prep.bytecode)) ? 'ARGS DIFFER' : 'MISMATCH')
}

/* -------------------------------- Sourcify -------------------------------- */

/** `fresh`: a different URL, so no cache in between answers with the record
 * from before our own submission (lookups are served with max-age 3600). */
async function sourcifyStatus(chainId, address, fresh = false) {
  const fields = fresh ? 'compilation,deployment' : 'deployment,compilation'
  const { status, body } = await http(`${SOURCIFY}/v2/contract/${chainId}/${address}?fields=${fields}`, {
    headers: { 'cache-control': 'no-cache' },
  })
  if (status === 404) return { match: null }
  if (status !== 200) throw new Error(`sourcify lookup: HTTP ${status}`)
  return body
}

async function sourcifyVerify(t, prep) {
  const { status, body } = await http(`${SOURCIFY}/v2/verify/${t.chainId}/${t.address}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stdJsonInput: prep.input,
      compilerVersion: prep.solcLong,
      contractIdentifier: prep.fqn,
      ...(t.creationTx ? { creationTransactionHash: t.creationTx } : {}),
    }),
  })
  if (status === 409) return 'already'
  if (status !== 202) throw new Error(`HTTP ${status}: ${body.message ?? body.customCode ?? JSON.stringify(body).slice(0, 200)}`)
  const id = body.verificationId
  for (let i = 0; i < 120; i++) {
    await sleep(i < 5 ? 2000 : 5000)
    const job = await http(`${SOURCIFY}/v2/verify/${id}`)
    if (!job.body.isJobCompleted) continue
    if (job.body.error) throw new Error(`${job.body.error.customCode}: ${job.body.error.message}`)
    const m = job.body.contract
    return `${m.match} (creation ${m.creationMatch ?? 'none'}, runtime ${m.runtimeMatch ?? 'none'})`
  }
  throw new Error(`job ${id} still running after 10 minutes`)
}

/* -------------------------------- Etherscan ------------------------------- */

function etherscanKey() {
  const k = hre.config.etherscan?.apiKey
  return typeof k === 'string' && k.length ? k : null
}

async function etherscanGet(chainId, params) {
  const q = new URLSearchParams({ chainid: String(chainId), ...params, apikey: etherscanKey() })
  await sleep(350) // free tier: a few calls a second
  const { status, body } = await http(`${ETHERSCAN}?${q}`)
  if (status !== 200) throw new Error(`etherscan ${params.action}: HTTP ${status}`)
  return body
}

/** creation records for many addresses of one chain (5 per call) */
async function etherscanCreations(chainId, addresses) {
  const out = {}
  for (let i = 0; i < addresses.length; i += 5) {
    const body = await etherscanGet(chainId, {
      module: 'contract', action: 'getcontractcreation', contractaddresses: addresses.slice(i, i + 5).join(','),
    })
    if (body.status !== '1') throw new Error(`getcontractcreation: ${typeof body.result === 'string' ? body.result : body.message}`)
    for (const r of body.result) out[r.contractAddress.toLowerCase()] = r
  }
  return out
}

async function etherscanIsVerified(chainId, address) {
  const body = await etherscanGet(chainId, { module: 'contract', action: 'getsourcecode', address })
  if (body.status !== '1') throw new Error(`getsourcecode: ${typeof body.result === 'string' ? body.result : body.message}`)
  return Boolean(body.result?.[0]?.SourceCode)
}

async function etherscanVerify(t, prep) {
  const form = new URLSearchParams({
    apikey: etherscanKey(),
    module: 'contract',
    action: 'verifysourcecode',
    contractaddress: t.address,
    sourceCode: JSON.stringify(prep.input),
    codeformat: 'solidity-standard-json-input',
    contractname: prep.fqn,
    compilerversion: `v${prep.solcLong}`,
    constructorArguements: strip0x(t.encodedArgs), // sic: Etherscan's spelling
  })
  const { status, body } = await http(`${ETHERSCAN}?chainid=${t.chainId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (status !== 200) throw new Error(`verifysourcecode: HTTP ${status}`)
  const msg = String(body.result ?? body.message)
  if (/already verified/i.test(msg)) return 'already'
  if (body.status !== '1') throw new Error(msg)
  const guid = msg
  for (let i = 0; i < 60; i++) {
    await sleep(5000)
    const s = await etherscanGet(t.chainId, { module: 'contract', action: 'checkverifystatus', guid })
    const r = String(s.result)
    if (/pending/i.test(r)) continue
    if (/^pass/i.test(r) || /already verified/i.test(r)) return 'verified'
    throw new Error(r)
  }
  throw new Error(`still pending after 5 minutes (guid ${guid})`)
}

/* -------------------------------- discovery ------------------------------- */

const PAD_ABI = ['function tokensLength() view returns (uint256)', 'function allTokens(uint256) view returns (address)']
const GW_ABI = ['function replicaOf(address) view returns (address)']
const TOKEN_ABI = ['function symbol() view returns (string)']

async function discover(profile, state, providers) {
  const targets = []
  const nets = Object.entries(profile.nets).filter(
    ([net, cfg]) => cfg.chainId && cfg.enabled !== false && state[net] && (!NETS || NETS.includes(net)),
  )
  const add = (net, key, name, address, extra = {}) =>
    targets.push({ net, key, name, address: ethers.getAddress(address), chainId: profile.nets[net].chainId, ...extra })

  if (!TOKENS_ONLY) {
    for (const [net] of nets) {
      const entry = state[net]
      const known = Object.fromEntries([...roleKeys(profile, net), ...Object.entries(EXTRA_KEYS)])
      for (const [key, v] of Object.entries(entry)) {
        if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v) || FOREIGN_KEYS.has(key)) continue
        if (!known[key]) throw new Error(`${net}.${key} = ${v}: no contract name for this key — add it to verify-all.js`)
        add(net, key, known[key], v)
      }
    }
  }

  // tokens: the hub's from the pad's own list, replicas from each gateway
  const hub = profile.hub
  if (!state[hub]?.pad) return targets
  const pad = new ethers.Contract(state[hub].pad, PAD_ABI, providers[hub])
  const n = Number(await pad.tokensLength())
  const allNets = Object.entries(profile.nets).filter(([net, cfg]) => cfg.chainId && cfg.enabled !== false && state[net]?.gateway)
  for (let i = 0; i < n; i++) {
    const token = await pad.allTokens(i)
    const symbol = await new ethers.Contract(token, TOKEN_ABI, providers[hub]).symbol()
    if (!NETS || NETS.includes(hub)) add(hub, `token ${symbol}`, 'SpawnToken', token, { hubToken: token, bornIn: state[hub].pad })
    for (const [net] of allNets) {
      if (NETS && !NETS.includes(net)) continue
      const rep = await new ethers.Contract(state[net].gateway, GW_ABI, providers[net]).replicaOf(token)
      if (rep !== ethers.ZeroAddress) add(net, `replica ${symbol}`, 'SpawnToken', rep, { hubToken: token, bornIn: state[net].gateway })
    }
  }
  return targets
}

/** A token's creation tx, from its creator's event: SpawnPad `Spawned(token)`
 * or SpawnGateway `ReplicaDeployed(hubToken, replica)`, scanned from the
 * creator's own creation block (Sourcify's record of it) on the chain's
 * logs RPC. Only asked when no explorer knows the creation: given the hash,
 * Sourcify traces it and upgrades a runtime-only match to a creation match. */
const SPAWNED = ethers.id('Spawned(address,bytes32,uint32,string,string,string)')
const REPLICA = ethers.id('ReplicaDeployed(address,address,string,string)')
async function tokenCreationTx(t, cfg) {
  const born = (await sourcifyStatus(t.chainId, t.bornIn)).deployment?.blockNumber
  if (!born) throw new Error('the creator has no creation block on Sourcify')
  const topic = ethers.zeroPadValue(t.hubToken, 32)
  const hub = same(t.address, t.hubToken)
  let lastErr
  for (const url of [...(cfg.logsRpc ?? []), cfg.rpc]) {
    try {
      const p = new ethers.JsonRpcProvider(url, cfg.chainId, { staticNetwork: true })
      const latest = await p.getBlockNumber()
      for (let a = Number(born); a <= latest; a += 50_000) {
        const logs = await p.getLogs({
          address: t.bornIn, topics: [hub ? SPAWNED : REPLICA, topic], fromBlock: a, toBlock: Math.min(latest, a + 49_999),
        })
        const hit = logs.find((l) => hub || same(ethers.dataSlice(l.data, 12, 32), t.address))
        if (hit) return hit.transactionHash
      }
      return null
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`no RPC served the logs (${lastErr?.shortMessage ?? lastErr?.message})`)
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  const profile = getProfile()
  const state = loadState(profile.stateFile)
  const providers = {}
  for (const [net, cfg] of Object.entries(profile.nets)) {
    if (cfg.chainId) providers[net] = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId, { staticNetwork: true })
  }
  const doSourcify = ONLY !== 'etherscan'
  const key = etherscanKey()
  const doEtherscan = ONLY !== 'sourcify' && Boolean(key)
  console.log(
    `verify-all — profile ${profile.name}, state ${path.relative(process.cwd(), profile.stateFile)}` +
      `${DRY ? ', DRY (nothing submitted)' : ''}\n  Sourcify: ${doSourcify ? 'on' : 'off'}; Etherscan: ` +
      `${ONLY === 'sourcify' ? 'off' : key ? 'on (key loaded)' : 'NO KEY (ETHERSCAN_API_KEY) — skipped'}`,
  )

  const targets = await discover(profile, state, providers)
  console.log(`  ${targets.length} addresses\n`)

  // creation records: Etherscan's when there is a key (one call per 5 addresses)
  if (key) {
    const byChain = {}
    for (const t of targets) (byChain[t.chainId] ??= []).push(t)
    for (const [chainId, ts] of Object.entries(byChain)) {
      try {
        const recs = await etherscanCreations(chainId, ts.map((t) => t.address))
        for (const t of ts) {
          const r = recs[t.address.toLowerCase()]
          if (!r) continue
          t.creationTx = r.txHash
          t.creator = r.contractFactory || r.contractCreator
          if (r.creationBytecode) t.creationCode = r.creationBytecode
        }
      } catch (e) {
        for (const t of ts) t.creationNote = `etherscan: ${e.message}`
      }
    }
  }

  let failed = 0
  for (const t of targets) {
    const label = `${t.net.padEnd(9)} ${t.key.padEnd(16)} ${t.name.padEnd(23)} ${t.address}`
    process.stdout.write(`${label}\n`)
    t.sourcify = '-'
    t.etherscan = doEtherscan ? '-' : ONLY === 'sourcify' ? 'off' : 'no key'
    try {
      const prep = await prepare(t.name)
      for (const note of prep.notes) console.log(`    note: ${note}`)
      const provider = providers[t.net]

      // Sourcify's record of the creation, when it has one
      let sf = doSourcify ? await sourcifyStatus(t.chainId, t.address) : { match: null }
      if (sf.deployment?.transactionHash && !t.creationTx) {
        t.creationTx = sf.deployment.transactionHash
        if (sf.deployment.deployer) t.creator = sf.deployment.deployer
      }
      // a token Sourcify knows no creation of: find it in its creator's events
      if (doSourcify && t.bornIn && !t.creationTx && !sf.creationMatch) {
        try {
          t.creationTx = (await tokenCreationTx(t, profile.nets[t.net])) ?? undefined
          if (t.creationTx) t.creator = t.bornIn
        } catch (e) {
          t.creationNote = `creation from events: ${e.message}`
        }
      }
      // a timelock's creator is its constructor argument
      if (t.name === 'SpawnTimelock' && t.creator && !same(t.creator, DEPLOYER)) {
        console.log(`    note: created by ${t.creator}, not the configured deployer`)
      }

      const ok = await checkOnChain(t, provider, prep)
      await checkCreation(t, provider, prep)
      console.log(`    check: runtime ${t.runtime}, creation ${t.creation}${t.creationNote ? ` (${t.creationNote})` : ''}`)
      if (!ok || t.creation === 'MISMATCH' || t.creation === 'ARGS DIFFER') {
        throw new Error(`refusing to submit: runtime ${t.runtime}, creation ${t.creation}`)
      }

      if (doSourcify) {
        try {
          // Sourcify's similarity matcher may already have attached SOMEONE
          // ELSE's source with the same bytecode (a partial "match": the
          // metadata differs, and explorers then show that project's name).
          // Only an exact match of our own contract is left alone.
          const theirs = sf.compilation?.fullyQualifiedName
          const ours = !theirs || theirs === prep.fqn
          // a runtime-only match is upgraded when we know the creation tx
          const upgrade = !sf.creationMatch && Boolean(t.creationTx)
          if (sf.match === 'exact_match' && ours && !upgrade) {
            t.sourcify = `already exact_match${sf.creationMatch ? '' : ' (runtime only)'}`
          }
          else if (DRY) t.sourcify = sf.match ? `${sf.match} as ${theirs} — would replace (dry)` : 'not verified (dry)'
          else {
            const res = await sourcifyVerify(t, prep)
            sf = await sourcifyStatus(t.chainId, t.address, true)
            const now = sf.compilation?.fullyQualifiedName
            if (!sf.match) throw new Error(`job done but the lookup says ${JSON.stringify(sf).slice(0, 120)}`)
            if (res === 'already' && now !== prep.fqn) {
              throw new Error(`Sourcify keeps ${sf.match} as ${now}; ours refused as already verified`)
            }
            t.sourcify = res === 'already' ? `already ${sf.match}` : res
            // (after "already", a differing first answer was a cached one)
            if (res !== 'already' && theirs && theirs !== now) t.sourcify += ` (replaced ${theirs})`
          }
        } catch (e) {
          t.sourcify = `FAILED: ${e.message}`
          failed++
        }
        console.log(`    sourcify:  ${t.sourcify}`)
      }

      if (doEtherscan) {
        try {
          if (await etherscanIsVerified(t.chainId, t.address)) t.etherscan = 'already verified'
          else if (DRY) t.etherscan = 'not verified (dry)'
          else t.etherscan = await etherscanVerify(t, prep)
        } catch (e) {
          t.etherscan = `FAILED: ${e.message}`
          failed++
        }
        console.log(`    etherscan: ${t.etherscan}${BROWSER[t.chainId] ? `  ${BROWSER[t.chainId]}/address/${t.address}#code` : ''}`)
      }
    } catch (e) {
      t.sourcify = t.etherscan = `FAILED: ${e.message}`
      console.log(`    FAILED: ${e.message}`)
      failed++
    }
  }

  console.log('\nchain     what             contract                address                                     sourcify | etherscan')
  for (const t of targets) {
    const short = (s) => (s.length > 60 ? s.slice(0, 57) + '...' : s)
    console.log(`${t.net.padEnd(9)} ${t.key.padEnd(16)} ${t.name.padEnd(23)} ${t.address}  ${short(t.sourcify)} | ${short(t.etherscan)}`)
  }
  console.log(failed ? `\n${failed} failure(s)` : DRY ? '\ndry run: every check passed, nothing submitted' : '\nall verified')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
