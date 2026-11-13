/**
 * Runs a mainnet-FORK test file against a private anvil fork.
 *
 *   node scripts/fork-run.js base                 # test-fork/base.fork.test.js
 *   node scripts/fork-run.js optimism             # test-fork/optimism.fork.test.js
 *   node scripts/fork-run.js base path/to/test.js # any file, against that fork
 *   FORK_VERBOSE=1 …                              # show the deploy script's own output
 *   FORK_RPC=https://…                            # another upstream RPC (must serve history)
 *   FORK_BLOCK=12345                              # pin the fork block
 *
 * It starts `anvil --fork-url <chain>` on a private port (8546+, never
 * 8545), waits for it, runs `hardhat test --network fork`, and stops it.
 * Nothing is sent to the live chain: anvil only READS it.
 */
const { spawn } = require('child_process')
const path = require('path')
const FORKS = require('../config/forks')

const name = process.argv[2]
const fork = FORKS[name]
if (!fork) {
  console.error(`usage: node scripts/fork-run.js <${Object.keys(FORKS).join('|')}> [test file]`)
  process.exit(2)
}
const file = process.argv[3] ?? `test-fork/${name}.fork.test.js`
const port = Number(process.env.FORK_PORT ?? fork.port)
const cwd = path.join(__dirname, '..')

async function rpc(method, params = []) {
  const res = await fetch(`http://127.0.0.1:${port}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return (await res.json()).result
}

async function main() {
  const args = ['--fork-url', process.env.FORK_RPC ?? fork.url, '--port', String(port), '--silent']
  if (process.env.FORK_BLOCK) args.push('--fork-block-number', process.env.FORK_BLOCK)
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

  // wait for the fork to answer with the right chain id
  let chainId
  for (let i = 0; i < 120 && !exited; i++) {
    try {
      chainId = Number(await rpc('eth_chainId'))
      if (chainId) break
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (chainId !== fork.chainId) {
    stop()
    throw new Error(`anvil fork of ${name} did not come up on port ${port} (chain id ${chainId}, expected ${fork.chainId})`)
  }
  console.log(`anvil fork of ${name} (chain ${chainId}) at block ${Number(await rpc('eth_blockNumber'))} — port ${port}`)

  const test = spawn('npx', ['hardhat', 'test', file, '--network', 'fork'], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, FORK: name, FORK_PORT: String(port) },
  })
  const code = await new Promise((r) => test.on('exit', r))
  stop()
  process.exit(code ?? 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
