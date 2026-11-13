/**
 * Rehearses ADDING A CHAIN to the LIVE mainnet deployment — the very wrapper
 * the owner will run (scripts/add-chain.sh) — against private anvil forks of
 * every chain involved, starting from the real deployed state
 * (contracts/deployments/mainnet.json: the live pad, adapters, vaults and
 * timelocks, as they are on chain right now).
 *
 *   node scripts/fork-addchain.js                # ethereum
 *   node scripts/fork-addchain.js ethereum
 *   FORK_VERBOSE=1 …                             # the scripts' own output
 *   FORK_RPC_BASE=https://… (…_OPTIMISM, …)      # another upstream RPC per chain
 *
 * It runs, in order:
 *   add-chain.sh <net> prepare      deploy the spoke, pre-steps, schedule the batches
 *   add-chain.sh <net> finish       → must REFUSE: the batches are inside their delay
 *   (time travel: 48h + a little, on every fork)
 *   add-chain.sh <net> finish       execute, re-price, verify, hand over
 *   test-fork/addchain.fork.test.js the live pad now SYNCs the new chain; the
 *                                   existing chains are untouched; the cost table
 *
 * Nothing is sent to a live chain: anvil only READS them. No real key signs
 * anything: the recorded operator and OWNER are IMPERSONATED on the forks
 * (a transaction signed with the real key for a fork would be valid on the
 * real chain). State and manifest go to a temp dir; the repo's files are
 * not touched. What forks cannot do — deliver a LayerZero packet from one
 * chain to another — is why the canary is skipped here: it is the first
 * thing `finish` proves live.
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const FORKS = require('../config/forks')

const NEW = process.argv[2] ?? 'ethereum'
const cwd = path.join(__dirname, '..')
const live = JSON.parse(fs.readFileSync(path.join(cwd, 'deployments', 'mainnet.json'), 'utf8'))
const hub = 'base'
const chains = [hub, ...Object.keys(live).filter((n) => n !== hub && FORKS[n] && live[n].handover), NEW].filter(
  (n, i, a) => a.indexOf(n) === i,
)
for (const n of chains) if (!FORKS[n]) throw new Error(`no fork configured for "${n}" (config/forks.js)`)
if (live[NEW]) throw new Error(`${NEW} is already in deployments/mainnet.json — nothing to rehearse`)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-addchain-fork-'))
const stateFile = path.join(dir, 'mainnet.json')
fs.writeFileSync(stateFile, JSON.stringify(live, null, 2))
const url = (n) => `http://127.0.0.1:${FORKS[n].port}`

const env = {
  ...process.env,
  SPAWN_STATE_FILE: stateFile,
  SPAWN_MANIFEST_FILE: path.join(dir, 'manifest.json'),
  SPAWN_FORK_REHEARSAL: '1',
  SPAWN_SKIP_CANARY: '1',
  SPAWN_FORK_AS: live[hub].handover.operator,
  SPAWN_ENABLE: NEW,
  FORK_REPORT: path.join(dir, 'report.json'),
  ...Object.fromEntries(chains.map((n) => [`RPC_${n.toUpperCase()}`, url(n)])),
}
delete env.SPAWN_LAUNCH_PROFILE

async function rpc(n, method, params = []) {
  const res = await fetch(url(n), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await res.json()
  if (j.error) throw new Error(`${n} ${method}: ${j.error.message}`)
  return j.result
}

const anvils = []
const stop = () => anvils.forEach((a) => a.exitCode === null && a.kill('SIGTERM'))

function run(title, cmd, args, extraEnv = {}) {
  console.log(`\n━━━ ${title} ━━━`)
  const r = spawnSync(cmd, args, { cwd, env: { ...env, ...extraEnv }, stdio: 'inherit' })
  return r.status
}

async function main() {
  console.log(`rehearsing add-chain ${NEW} on forks of: ${chains.join(', ')} — state in ${dir}`)
  process.on('SIGINT', () => {
    stop()
    process.exit(130)
  })
  // One fork at a time, each retried: a public RPC answers 429 to a burst
  // (anvil then dies while building its genesis), and is fine a moment later.
  for (const n of chains) {
    const upstream = process.env[`FORK_RPC_${n.toUpperCase()}`] ?? FORKS[n].url
    let id
    for (let attempt = 1; attempt <= 6 && id !== FORKS[n].chainId; attempt++) {
      const a = spawn('anvil', ['--fork-url', upstream, '--port', String(FORKS[n].port), '--silent'], {
        stdio: ['ignore', 'inherit', 'inherit'],
      })
      a.on('error', (e) => {
        console.error(`cannot start anvil (${e.message}) — install Foundry: https://getfoundry.sh`)
        process.exit(2)
      })
      for (let i = 0; i < 120 && a.exitCode === null; i++) {
        try {
          id = Number(await rpc(n, 'eth_chainId'))
          if (id) break
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      if (id === FORKS[n].chainId) {
        anvils.push(a)
        break
      }
      if (a.exitCode === null) a.kill('SIGTERM')
      console.log(`  ${n}: the fork did not come up (attempt ${attempt}) — the upstream RPC is probably rate-limiting; retrying in 20s`)
      await new Promise((r) => setTimeout(r, 20_000))
    }
    if (id !== FORKS[n].chainId) throw new Error(`anvil fork of ${n} did not come up on port ${FORKS[n].port}`)
    console.log(`  ${n}: chain ${id}, block ${Number(await rpc(n, 'eth_blockNumber'))}, port ${FORKS[n].port}`)
  }

  if (run(`add-chain.sh ${NEW} prepare`, 'bash', ['scripts/add-chain.sh', NEW, 'prepare']) !== 0) {
    throw new Error('prepare failed')
  }
  const early = run(`add-chain.sh ${NEW} finish — BEFORE the delay: must refuse`, 'bash', ['scripts/add-chain.sh', NEW, 'finish'])
  if (early !== 3) throw new Error(`finish before the delay exited ${early}, expected 3 (still waiting)`)

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const delay = Math.max(...chains.filter((n) => state[n]?.ops?.length).map((n) => Math.max(...state[n].ops.map((o) => o.delay))))
  console.log(`\n━━━ time travel: ${delay}s (+120) on every fork ━━━`)
  for (const n of chains) {
    await rpc(n, 'evm_increaseTime', [delay + 120])
    await rpc(n, 'evm_mine')
  }

  if (run(`add-chain.sh ${NEW} finish`, 'bash', ['scripts/add-chain.sh', NEW, 'finish']) !== 0) {
    throw new Error('finish failed')
  }
  if (
    run('the live protocol on the fork, after the chain was added', 'npx', ['hardhat', 'test', 'test-fork/addchain.fork.test.js', '--network', 'fork'], {
      FORK: hub,
      SPAWN_NET: hub,
      ADDCHAIN_NEW: NEW,
    }) !== 0
  ) {
    throw new Error('post-add assertions failed')
  }
  if (fs.existsSync(env.FORK_REPORT)) console.log(`\nreport: ${env.FORK_REPORT}\n${fs.readFileSync(env.FORK_REPORT, 'utf8')}`)
  console.log(`\n✓ rehearsal complete: ${NEW} was added to forks of the live deployment through the timelocks`)
}

main()
  .catch((e) => {
    console.error(`\n✗ ${e.message}`)
    process.exitCode = 1
  })
  .finally(stop)
