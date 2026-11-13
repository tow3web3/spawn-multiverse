/**
 * Rehearses ONE single-chain universe exactly as the owner will run it —
 * the two wrappers, `bash scripts/launch.sh <universe>` then
 * `bash scripts/finish.sh <universe>` — against a private anvil fork of its
 * chain: the real dollar (BSC USDT / Ethereum USDC), the real LayerZero
 * EndpointV2, and the REAL deployer address, impersonated (no key signs
 * anything: a transaction signed for a fork would be valid on the chain).
 *
 *   node scripts/fork-universe.js bnb
 *   node scripts/fork-universe.js ethereum
 *   FORK_RPC=https://…  FORK_BLOCK=…  FORK_PORT=…   (as scripts/fork-run.js)
 *   SPAWN_DEPLOYER=0x…                              (another deployer to act as)
 *
 * Afterwards test-fork/universe.fork.test.js asserts the end state on the
 * same fork: not one PacketSent from the endpoint, backing exact to the wei,
 * every admin = the owner's 48h timelock, hot key = operator + guardian,
 * launch caps in the dollar's own units, the manifest the site codes
 * against — and measures what a launch, a buy and a sell cost a user there,
 * against the profile's `actionGas`, and the deploy against LIFE_GAS.
 *
 * State, manifest, logs and canary markers go to a temp dir: the repo's
 * deployments/ and public/onchain/ are not touched, and nothing is sent to
 * the live chain (anvil only reads it). Ports 8546+, never 8545.
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ethers } = require('ethers')
const FORKS = require('../config/forks')
const { PROFILES, dollarUnits } = require('../config/profiles')

const name = process.argv[2]
const profile = PROFILES[name]
if (!profile?.singleChain || !FORKS[name]) {
  console.error('usage: node scripts/fork-universe.js <bnb|ethereum>')
  process.exit(2)
}
const fork = FORKS[name]
const cfg = profile.nets[profile.hub]
const port = Number(process.env.FORK_PORT ?? fork.port)
const url = `http://127.0.0.1:${port}`
const cwd = path.join(__dirname, '..')
const DEPLOYER = ethers.getAddress(process.env.SPAWN_DEPLOYER ?? '0x483E931A279B136A2C3fCA6BF5eC2c4239c1B904')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spawn-universe-${name}-`))
const rpcKey = `RPC_${profile.hub.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`

const env = {
  ...process.env,
  FORK: name,
  FORK_PORT: String(port),
  [rpcKey]: url, // every read of this chain goes to the fork, not the live RPC
  SPAWN_FORK_REHEARSAL: '1', // the wrappers run every CLI on --network fork
  SPAWN_FORK_AS: DEPLOYER, // …acting as the real deployer, impersonated
  SPAWN_DEPLOYER: DEPLOYER, // …and the preflight checks that address
  SPAWN_STATE_FILE: path.join(dir, `mainnet-${name}.json`),
  SPAWN_MANIFEST_FILE: path.join(dir, `manifest-${name}.json`),
  SPAWN_LOG_DIR: path.join(dir, 'logs'),
  SPAWN_MARK_DIR: dir,
  SPAWN_RETRY_SLEEP: '1',
  SMOKE_POLL_MS: '200',
}

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function mint(address,uint256) returns (bool)', // Circle USDC: minter → anyone
  'function mint(uint256) returns (bool)', // Binance-Peg BEP20: owner → itself
  'function getOwner() view returns (address)',
]

async function rpc(u, method, params = [], ms = 10_000) {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  try {
    const r = await fetch(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: c.signal,
    })
    const j = await r.json()
    if (j.error) throw new Error(j.error.message)
    return j.result
  } finally {
    clearTimeout(t)
  }
}

/** The upstream anvil forks from: FORK_RPC, or the first candidate that
 * still serves state (balance + a storage slot) 2,000 blocks back — a node
 * that only serves recent state breaks a rehearsal halfway (config/forks.js). */
async function pickUpstream() {
  if (process.env.FORK_RPC) return process.env.FORK_RPC
  for (const u of [fork.url, ...(fork.alt ?? [])]) {
    try {
      const latest = Number(await rpc(u, 'eth_blockNumber'))
      const at = ethers.toQuantity(latest - 2000)
      await rpc(u, 'eth_getBalance', [DEPLOYER, at])
      await rpc(u, 'eth_getStorageAt', [cfg.usdc, '0x0', at])
      return u
    } catch (e) {
      console.log(`upstream ${u}: no deep state (${String(e.message).slice(0, 70)}) — next`)
    }
  }
  throw new Error(`no upstream RPC serves deep enough state for a fork of ${name}; set FORK_RPC=https://… (an archive node)`)
}

/** Every function of the protocol's contracts, by selector — to tell the
 * deploy's own transactions (creations, setters, role moves, the tank
 * top-up) from the canary's user actions in the same wrapper run. */
function selectorNames() {
  const out = new Map()
  const base = path.join(cwd, 'artifacts', 'contracts')
  const files = []
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(d, f.name))
      else if (f.name.endsWith('.json') && !f.name.endsWith('.dbg.json')) files.push(path.join(d, f.name))
    }
  }
  walk(base)
  for (const f of files) {
    const art = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (!Array.isArray(art.abi)) continue
    const iface = new ethers.Interface(art.abi)
    iface.forEachFunction((fn) => out.set(fn.selector, fn.name))
  }
  return out
}
const INFRA = /^(set|register|transferAdmin|acceptAdmin|grantRole|revokeRole|renounceRole|schedule|execute|updateDelay|pause|unpause)/

/** Σ gas of the deployer's transactions in (from, to], split into the
 * protocol's own plumbing and the user actions of the canary. */
async function deployerGas(provider, from, to, names) {
  const sum = { infra: 0n, user: 0n, txs: 0 }
  for (let n = from + 1; n <= to; n++) {
    const block = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(n), true])
    for (const tx of block?.transactions ?? []) {
      if (tx.from.toLowerCase() !== DEPLOYER.toLowerCase()) continue
      const rc = await provider.send('eth_getTransactionReceipt', [tx.hash])
      const gas = BigInt(rc.gasUsed)
      const fn = tx.input && tx.input.length >= 10 ? names.get(tx.input.slice(0, 10)) : undefined
      const infra = !tx.to || tx.input === '0x' || (fn && INFRA.test(fn))
      sum[infra ? 'infra' : 'user'] += gas
      sum.txs += 1
    }
  }
  return sum
}

async function main() {
  const upstream = await pickUpstream()
  // The fork is PINNED to a block (FORK_BLOCK, or the upstream's latest at
  // start): anvil then caches every account and slot it fetches on disk
  // (~/.foundry/cache/rpc), so a second run at the same block asks the
  // upstream for nothing; and the upstream is asked gently (public nodes
  // rate-limit at a few dozen requests a second).
  const pinned = process.env.FORK_BLOCK ?? String(Number(await rpc(upstream, 'eth_blockNumber')) - 5)
  const args = [
    '--fork-url', upstream, '--fork-block-number', pinned, '--port', String(port), '--silent',
    '--compute-units-per-second', process.env.FORK_CUPS ?? '150', '--retries', '8', '--timeout', '60000',
  ]
  const anvil = spawn('anvil', args, { stdio: ['ignore', 'inherit', 'inherit'] })
  let exited = false
  anvil.on('exit', () => (exited = true))
  anvil.on('error', (e) => {
    console.error(`cannot start anvil (${e.message}) — install Foundry: https://getfoundry.sh`)
    process.exit(2)
  })
  const stop = () => {
    if (!exited) anvil.kill('SIGTERM')
  }
  process.on('SIGINT', () => {
    stop()
    process.exit(130)
  })
  try {
    let chainId
    for (let i = 0; i < 240 && !exited; i++) {
      try {
        chainId = Number(await rpc(url, 'eth_chainId', [], 2000))
        if (chainId) break
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    if (chainId !== fork.chainId) throw new Error(`anvil fork of ${name} did not come up on port ${port} (chain id ${chainId})`)
    const provider = new ethers.JsonRpcProvider(url, fork.chainId, { staticNetwork: true })
    const startBlock = await provider.getBlockNumber()
    console.log(`anvil fork of ${name} (chain ${chainId}) at block ${startBlock}, upstream ${upstream} — port ${port} — state in ${dir}`)

    // ── the deployer, as the owner will have funded it ──
    const coin = profile.native ?? 'ETH'
    const dec = profile.dollar.decimals
    const sym = profile.dollar.symbol
    const dollar = new ethers.Contract(cfg.usdc, ERC20, provider)
    const live = { coin: await provider.getBalance(DEPLOYER), dollars: await dollar.balanceOf(DEPLOYER) }
    console.log(
      `deployer ${DEPLOYER} holds, on the live chain: ${ethers.formatEther(live.coin)} ${coin}, ${ethers.formatUnits(live.dollars, dec)} ${sym}`,
    )
    // fork only: gas for the rehearsal (the live balance is what the report
    // compares to the budget), and a few dollars for the canary if short
    await provider.send('anvil_setBalance', [DEPLOYER, ethers.toBeHex(ethers.parseEther('1'))])
    const needDollars = dollarUnits(profile, 10)
    if (live.dollars < needDollars) {
      const amount = needDollars - live.dollars
      // raw calls end to end: ethers' waitForTransaction was seen hanging on
      // an anvil fork although the block was mined
      const sendAs = async (from, data) => {
        await rpc(url, 'anvil_impersonateAccount', [from])
        await rpc(url, 'anvil_setBalance', [from, ethers.toBeHex(ethers.parseEther('1'))])
        const hash = await rpc(url, 'eth_sendTransaction', [{ from, to: cfg.usdc, data, gas: ethers.toQuantity(300_000) }])
        let receipt = null
        for (let i = 0; i < 120 && !receipt; i++) {
          receipt = await rpc(url, 'eth_getTransactionReceipt', [hash])
          if (!receipt) await new Promise((r) => setTimeout(r, 500))
        }
        if (!receipt || receipt.status !== '0x1') throw new Error(`fork funding transaction failed or not mined (${hash})`)
      }
      if (cfg.tokenMessenger) {
        // Circle's own minter, impersonated
        const tm = new ethers.Contract(cfg.tokenMessenger, ['function localMinter() view returns (address)'], provider)
        await sendAs(await tm.localMinter(), dollar.interface.encodeFunctionData('mint(address,uint256)', [DEPLOYER, amount]))
        console.log(`(fork only: ${ethers.formatUnits(amount, dec)} ${sym} minted to the deployer by Circle's minter)`)
      } else {
        // the BEP20's owner mints to itself, then pays the deployer
        const owner = await dollar.getOwner()
        await sendAs(owner, dollar.interface.encodeFunctionData('mint(uint256)', [amount]))
        await sendAs(owner, dollar.interface.encodeFunctionData('transfer', [DEPLOYER, amount]))
        console.log(`(fork only: ${ethers.formatUnits(amount, dec)} ${sym} minted to the deployer by the token's owner)`)
      }
    }
    const names = selectorNames()
    const blockNow = async () => Number(await rpc(url, 'eth_blockNumber')) // raw: no client-side cache

    // ── the two lines the owner pastes ──
    const marks = { start: await blockNow() }
    for (const script of ['launch.sh', 'finish.sh']) {
      console.log(`\n━━━ bash scripts/${script} ${name} ━━━`)
      const r = spawnSync('bash', [`scripts/${script}`, name], { cwd, stdio: 'inherit', env })
      if (r.status !== 0) throw new Error(`scripts/${script} ${name} failed (exit ${r.status}) — logs in ${env.SPAWN_LOG_DIR}`)
      marks[script] = await blockNow()
    }

    // ── what it cost, from the chain itself (every attempt included; the
    // deployer's balance is no measure: every CLI run tops it up on a fork) ──
    const launch = await deployerGas(provider, marks.start, marks['launch.sh'], names)
    const finish = await deployerGas(provider, marks['launch.sh'], marks['finish.sh'], names)
    const gasPrice = (await provider.getFeeData()).gasPrice
    console.log(
      `\nblocks ${marks.start} → ${marks['launch.sh']} → ${marks['finish.sh']}: ` +
        `launch.sh: deploy ${launch.infra} gas + canary ${launch.user} gas in ${launch.txs} tx(s); ` +
        `finish.sh: hand-over + caps ${finish.infra} gas (+ ${finish.user} user) in ${finish.txs} tx(s); ` +
        `fork gas price ${ethers.formatUnits(gasPrice, 'gwei')} gwei`,
    )

    // ── the assertions, on the same fork ──
    console.log(`\n━━━ test-fork/universe.fork.test.js (${name}) ━━━`)
    const t = spawnSync('npx', ['hardhat', 'test', 'test-fork/universe.fork.test.js', '--network', 'fork'], {
      cwd,
      stdio: 'inherit',
      env: {
        ...env,
        FORK_START_BLOCK: String(startBlock),
        SPAWN_DEPLOY_GAS: String(launch.infra),
        SPAWN_CANARY_GAS: String(launch.user),
        SPAWN_HANDOVER_GAS: String(finish.infra),
      },
    })
    if (t.status !== 0) throw new Error(`the assertions failed (exit ${t.status})`)
    console.log(`\n✓ ${name}: launch.sh then finish.sh ran end to end against a fork of ${name} — nothing crossed LayerZero`)
  } finally {
    stop()
  }
}

main().catch((e) => {
  console.error(e.message ?? e)
  process.exit(1)
})
