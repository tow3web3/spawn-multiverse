/**
 * Rehearses the MAINNET runbook with the real command-line scripts, against
 * a private anvil fork of Base — the last stop before real money.
 *
 *   node scripts/fork-rehearsal.js
 *
 * It runs, in order and exactly as the runbook says (docs/RUNBOOK.md):
 *   deploy.js (dry) → deploy.js → configure-dvn.js → tune-fees.js →
 *   smoke.js (the canary: spawn, $3 buy, sell, holder fees — real USDC,
 *   minted on the fork by Circle's own minter) → status.js → handover.js →
 *   deploy.js again (nothing left for the deployer) → status.js
 *
 * State and manifest go to a temp dir; the repo's files are not touched and
 * nothing is sent to the live chain (anvil only reads it). Only the hub leg
 * is rehearsed here — the spokes live on other chains; their scripts are
 * proved by test-fork/optimism.fork.test.js.
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ethers } = require('ethers')
const FORKS = require('../config/forks')
const { PROFILES } = require('../config/profiles')

const fork = FORKS.base
const port = Number(process.env.FORK_PORT ?? fork.port)
const url = `http://127.0.0.1:${port}`
const cwd = path.join(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-rehearsal-'))
const cfg = PROFILES.mainnet.nets.base

const env = {
  ...process.env,
  FORK: 'base',
  FORK_PORT: String(port),
  SPAWN_PROFILE: 'mainnet',
  SPAWN_NET: 'base',
  SPAWN_STATE_FILE: path.join(dir, 'mainnet.json'),
  SPAWN_MANIFEST_FILE: path.join(dir, 'manifest.json'),
  RPC_BASE: url, // status.js reads "base" from the fork, not the live chain
}
const CONFIRM = { SPAWN_MAINNET_CONFIRM: 'I_UNDERSTAND_THIS_IS_REAL_MONEY' }

function step(title, script, extra = {}) {
  console.log(`\n━━━ ${title} ━━━`)
  const r = spawnSync('npx', ['hardhat', 'run', `scripts/${script}`, '--network', 'fork'], {
    cwd,
    stdio: 'inherit',
    env: { ...env, ...extra },
  })
  if (r.status !== 0) throw new Error(`"${title}" failed (exit ${r.status})`)
}

async function main() {
  const anvil = spawn('anvil', ['--fork-url', process.env.FORK_RPC ?? fork.url, '--port', String(port), '--silent'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const stop = () => anvil.kill('SIGTERM')
  try {
    const provider = new ethers.JsonRpcProvider(url, fork.chainId, { staticNetwork: true })
    for (let i = 0; i < 120; i++) {
      try {
        await provider.getBlockNumber()
        break
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    const [deployer, owner, guardian] = await provider.send('eth_accounts', [])
    console.log(`anvil fork of Base at block ${await provider.getBlockNumber()} — state in ${dir}`)

    step('1. deploy.js — DRY (no confirmation phrase): preflight + plan, zero transactions', 'deploy.js')
    step('2. deploy.js — for real (on the fork)', 'deploy.js', CONFIRM)
    step('3. configure-dvn.js — our verifier set on the hub adapter', 'configure-dvn.js', CONFIRM)
    step('4. tune-fees.js — reply budgets from live quotes', 'tune-fees.js', { ...CONFIRM, SPAWN_APPLY: '1' })

    // the canary needs a few real dollars: minted by Circle's own CCTP
    // minter, impersonated — only possible on a fork
    const tm = new ethers.Contract(cfg.tokenMessenger, ['function localMinter() view returns (address)'], provider)
    const minter = await tm.localMinter()
    await provider.send('anvil_impersonateAccount', [minter])
    await provider.send('anvil_setBalance', [minter, '0x56BC75E2D63100000'])
    const usdc = new ethers.Interface(['function mint(address,uint256) returns (bool)'])
    const hash = await provider.send('eth_sendTransaction', [
      { from: minter, to: cfg.usdc, data: usdc.encodeFunctionData('mint', [deployer, 10_000_000n]) },
    ])
    await provider.waitForTransaction(hash)
    console.log('\n(fork only: 10 USDC minted to the deployer for the canary)')

    step('5. smoke.js — the canary: local spawn, $3 buy, sell, holder fees, in real USDC', 'smoke.js', {
      ...CONFIRM,
      SMOKE_BUY_USDC: '3',
      SMOKE_POLL_MS: '500',
    })
    step('6. status.js — backing, tanks, roles', 'status.js')
    step('7. handover.js — every admin to a 48h timelock owned by OWNER', 'handover.js', {
      ...CONFIRM,
      SPAWN_OWNER: owner,
      SPAWN_GUARDIAN: guardian,
    })
    step('8. deploy.js again — nothing is left that the deployer may do', 'deploy.js', CONFIRM)
    step('9. status.js — the admin is the timelock', 'status.js')
    console.log('\n✓ rehearsal complete: every runbook command ran against a fork of Base mainnet')
  } finally {
    stop()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
