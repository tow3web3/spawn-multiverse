/**
 * The three v7.2 paths the launch canaries do not touch on the public
 * testnets, exercised over LIVE LayerZero with the deployer as the user:
 *
 *   move    a dollar claim leaves Optimism Sepolia and is paid on Arbitrum
 *           Sepolia (remote → remote, forwarded by the hub), then another
 *           one is paid on Base Sepolia (remote → the hub chain's gateway)
 *   open    a token launched while Arbitrum's launch ceiling is 1 wei has no
 *           replica there; `openToken` on Arbitrum brings it
 *   expire  an order from Optimism with a 2-minute lifetime lands late (a
 *           testnet message takes longer) and comes back whole
 *
 *   EXERCISE=move,open,expire npx hardhat run scripts/testnet-exercise.js --network baseSepolia
 *
 * Testnet only (it refuses any other profile): play money, mock dollars.
 * Every setting it changes (a launch ceiling, an order lifetime) is put back
 * in a `finally`.
 */
const hre = require('hardhat')
const { ethers, artifacts } = hre
const fs = require('fs')
const { PROFILES } = require('../config/profiles')

const profile = PROFILES.testnet
const state = JSON.parse(fs.readFileSync(profile.stateFile, 'utf8'))
const NETS = { base: 'baseSepolia', op: 'optimismSepolia', arb: 'arbitrumSepolia' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const b32 = (a) => ethers.zeroPadValue(a, 32)
const log = (...a) => console.log(...a)

async function ctx(net) {
  const cfg = hre.config.networks[net]
  const provider = new ethers.JsonRpcProvider(cfg.url, cfg.chainId, { staticNetwork: true })
  const dev = new ethers.Wallet(cfg.accounts[0], provider)
  const s = state[net]
  const at = async (name, addr) => new ethers.Contract(addr, (await artifacts.readArtifact(name)).abi, dev)
  return {
    net,
    provider,
    dev,
    s,
    label: profile.nets[net].label,
    gw: await at('SpawnGateway', s.gateway),
    usd: await at('OmniUSD', s.localUsd ?? s.usd),
    usdc: await at('MockUSDC', s.usdc),
  }
}

async function waitFor(what, fn, minutes = 25, everyMs = 12_000) {
  const tries = Math.ceil((minutes * 60_000) / everyMs)
  let lastErr
  for (let i = 0; i < tries; i++) {
    const v = await fn().catch((e) => {
      lastErr = e
      return undefined
    })
    if (v) return v
    if (i % 10 === 0) log(`  … waiting for ${what} (${Math.round((i * everyMs) / 1000)}s)`)
    await sleep(everyMs)
  }
  throw new Error(`${what} not observed after ${minutes} min${lastErr ? ` (last error: ${String(lastErr.shortMessage ?? lastErr.message).slice(0, 160)})` : ''}`)
}

/** One event from `from` on, scanned in small windows (public RPCs cap eth_getLogs). */
function scanner(contract, filter, from, match = () => true, win = 100) {
  let scanned = from - 1
  return async () => {
    const latest = await contract.runner.provider.getBlockNumber()
    while (scanned < latest) {
      const to = Math.min(latest, scanned + win)
      const evs = await contract.queryFilter(filter, scanned + 1, to)
      scanned = to
      const hit = evs.find(match)
      if (hit) return hit
    }
    return undefined
  }
}

async function main() {
  if (hre.network.name !== NETS.base) throw new Error('run with --network baseSepolia')
  const want = (process.env.EXERCISE ?? 'move,open,expire').split(',')
  const base = await ctx(NETS.base)
  const op = await ctx(NETS.op)
  const arb = await ctx(NETS.arb)
  const pad = new ethers.Contract(state[NETS.base].pad, (await artifacts.readArtifact('SpawnPad')).abi, base.dev)
  const me = base.dev.address
  const me32 = b32(me).toLowerCase()
  const results = {}

  /* ------------------------------ move ------------------------------ */
  if (want.includes('move')) {
    log('\n━━━ MOVE: a claim leaves Optimism Sepolia ━━━')
    // a claim on Optimism: wrap 3 mock USDC into oUSD there (USDC vaults keep `wrap`)
    const need = ethers.parseEther('3')
    if ((await op.usd.balanceOf(me)) < need) {
      await (await op.usdc.mint(me, 3_000_000n)).wait()
      await (await op.usdc.approve(op.usd.target, 3_000_000n)).wait()
      await (await op.usd.wrap(3_000_000n)).wait()
    }
    log(`  oUSD on Optimism: ${ethers.formatEther(await op.usd.balanceOf(me))}`)
    for (const dst of [arb, base]) {
      const amount = ethers.parseEther('1')
      const before = await dst.usdc.balanceOf(me)
      const claimBefore = await dst.usd.balanceOf(me)
      const hubBlock = await base.provider.getBlockNumber()
      const fee = await op.gw.quoteMove(dst.label)
      log(`  moveClaim 1.0 → ${dst.net} (label ${dst.label}), quote ${ethers.formatEther(fee)} ETH`)
      const tx = await op.gw.moveClaim(dst.label, b32(me), amount, { value: fee })
      await tx.wait()
      log(`    sent: ${tx.hash}`)
      const ev = await waitFor(
        `the hub's Moved (→ ${dst.net})`,
        scanner(pad, pad.filters.Moved(op.label, dst.label), hubBlock, (e) => e.args.from.toLowerCase() === me32 && e.args.amount === amount),
      )
      log(`    hub: Moved forwarded=${ev.args.forwarded} (block ${ev.blockNumber}, tx ${ev.transactionHash})`)
      if (!ev.args.forwarded) throw new Error(`the hub sent the move toward ${dst.net} home instead of forwarding it`)
      const got = await waitFor(`the dollars on ${dst.net}`, async () => {
        const usdc = (await dst.usdc.balanceOf(me)) - before
        const claim = (await dst.usd.balanceOf(me)) - claimBefore
        return usdc > 0n || claim > 0n ? { usdc, claim } : undefined
      })
      log(`  ✓ arrived on ${dst.net}: ${ethers.formatUnits(got.usdc, 6)} USDC, ${ethers.formatEther(got.claim)} oUSD claim`)
      results[`move→${dst.net}`] = { usdc: got.usdc.toString(), claim: got.claim.toString(), hubTx: ev.transactionHash }
    }
  }

  /* ------------------------------ open ------------------------------ */
  if (want.includes('open')) {
    log('\n━━━ OPEN: a token that skipped Arbitrum Sepolia at launch ━━━')
    const capBefore = await pad.syncCap(arb.label)
    let token
    try {
      await (await pad.setSyncCap(arb.label, 1n)).wait()
      log(`  syncCap(arbitrum) ${capBefore} → 1 wei`)
      const name = `OPEN TEST ${Date.now() % 100000}`
      const fee = await base.gw.quoteSpawn(name, 'OPENT', '{"t":"exercise"}', false)
      const rc = await (await base.gw.spawnToken(name, 'OPENT', '{"t":"exercise"}', 0n, 0, { value: fee })).wait()
      for (const l of rc.logs) {
        try {
          const p = pad.interface.parseLog(l)
          if (p?.name === 'Spawned') token = p.args.token
          if (p?.name === 'SyncFailed') log(`    hub: SyncFailed(chain ${p.args.chain}) — skipped as intended`)
        } catch {}
      }
      if (!token) throw new Error('no Spawned event')
      log(`  launched ${token} from Base (tx ${rc.hash})`)
    } finally {
      await (await pad.setSyncCap(arb.label, capBefore)).wait()
      log(`  syncCap(arbitrum) restored to ${capBefore}`)
    }
    if ((await arb.gw.replicaOf(token)) !== ethers.ZeroAddress) throw new Error('Arbitrum already has a replica: the ceiling did not skip it')
    const hubBlock = await base.provider.getBlockNumber()
    const openFee = await arb.gw.quoteOpen()
    const tx = await arb.gw.openToken(token, { value: openFee })
    await tx.wait()
    log(`  openToken on Arbitrum sent: ${tx.hash} (quote ${ethers.formatEther(openFee)} ETH)`)
    const ev = await waitFor(
      'the hub answering the open',
      scanner(pad, pad.filters.Resynced(token, arb.label), hubBlock),
    ).catch(async (e) => {
      const failed = await pad.queryFilter(pad.filters.SyncFailed(token, arb.label), hubBlock, Math.min(hubBlock + 100, await base.provider.getBlockNumber())).catch(() => [])
      throw new Error(`${e.message}${failed.length ? ' — the hub logged SyncFailed for the open (over its ceiling?)' : ''}`)
    })
    log(`    hub: Resynced (block ${ev.blockNumber}, tx ${ev.transactionHash})`)
    const rep = await waitFor('the replica on Arbitrum', async () => {
      const r = await arb.gw.replicaOf(token)
      return r !== ethers.ZeroAddress ? r : undefined
    })
    log(`  ✓ replica on Arbitrum: ${rep}`)
    results.open = { token, replica: rep, hubTx: ev.transactionHash }
  }

  /* ------------------------------ closed ----------------------------- */
  // Leaves a token with NO replica on Arbitrum Sepolia, for the site's
  // "open it" flow to be tried by hand: EXERCISE=closed
  if (want.includes('closed')) {
    log('\n━━━ CLOSED: a token left without a replica on Arbitrum Sepolia ━━━')
    const capBefore = await pad.syncCap(arb.label)
    let token
    try {
      await (await pad.setSyncCap(arb.label, 1n)).wait()
      const fee = await base.gw.quoteSpawn('OPEN ME', 'OPENME', '{"t":"exercise"}', false)
      const rc = await (await base.gw.spawnToken('OPEN ME', 'OPENME', '{"t":"exercise"}', 0n, 0, { value: fee })).wait()
      for (const l of rc.logs) {
        try {
          const p = pad.interface.parseLog(l)
          if (p?.name === 'Spawned') token = p.args.token
        } catch {}
      }
    } finally {
      await (await pad.setSyncCap(arb.label, capBefore)).wait()
    }
    if (!token) throw new Error('no Spawned event')
    const onArb = await arb.gw.replicaOf(token)
    log(`  ✓ OPEN ME = ${token}; replica on Arbitrum: ${onArb === ethers.ZeroAddress ? 'none (as intended)' : onArb}`)
    results.closed = { token }
  }

  /* ----------------------------- expire ----------------------------- */
  if (want.includes('expire')) {
    log('\n━━━ EXPIRE: an order from Optimism Sepolia with a 2-minute lifetime ━━━')
    const ttlBefore = await op.gw.orderTtl()
    // any token with a replica on Optimism: the last one the pad knows
    const n = await pad.tokensLength()
    let token
    for (let i = Number(n) - 1; i >= 0 && !token; i--) {
      const t = await pad.allTokens(i)
      if ((await op.gw.replicaOf(t)) !== ethers.ZeroAddress) token = t
    }
    if (!token) throw new Error('no token with a replica on Optimism')
    let sentAt, hubBlock, before
    try {
      await (await op.gw.setOrderTtl(120)).wait()
      log(`  orderTtl(optimism) ${ttlBefore} → 120 s`)
      await (await op.usdc.mint(me, 1_000_000n)).wait()
      await (await op.usdc.approve(op.usd.target, 1_000_000n)).wait()
      before = await op.usdc.balanceOf(me)
      hubBlock = await base.provider.getBlockNumber()
      const fee = await op.gw.quoteBuy()
      // a minimum of 1 wei of tokens: only the deadline can refuse this order
      const tx = await op.gw.buyTokenUsdcMin(token, 1_000_000n, 1n, { value: fee })
      const rc = await tx.wait()
      sentAt = (await op.provider.getBlock(rc.blockNumber)).timestamp
      log(`  $1 buy of ${token} sent at ${sentAt} (deadline ${sentAt + 120}): ${tx.hash}`)
    } finally {
      await (await op.gw.setOrderTtl(ttlBefore)).wait()
      log(`  orderTtl(optimism) restored to ${ttlBefore} s`)
    }
    const mine = (e) => e.args.trader?.toLowerCase() === me32 || e.args.actor?.toLowerCase() === me32
    const refused = scanner(pad, pad.filters.Refused(), hubBlock, (e) => Number(e.args.op) === 2 && mine(e))
    const traded = scanner(pad, pad.filters.Trade(token), hubBlock, (e) => mine(e) && Number(e.args.chain) === op.label)
    const outcome = await waitFor('the hub handling the order', async () => {
      const r = await refused()
      if (r) return { kind: 'refused', ev: r }
      const t = await traded()
      if (t) return { kind: 'filled', ev: t }
      return undefined
    })
    const landedAt = (await base.provider.getBlock(outcome.ev.blockNumber)).timestamp
    const late = landedAt - (sentAt + 120)
    if (outcome.kind === 'refused') {
      log(`    hub: Refused reason ${outcome.ev.args.reason}, landed ${landedAt} = ${late}s after its deadline (tx ${outcome.ev.transactionHash})`)
      if (late <= 0) throw new Error('refused BEFORE its deadline — not an expiry')
      await waitFor('the dollar back on Optimism', async () => ((await op.usdc.balanceOf(me)) === before ? true : undefined))
      log('  ✓ expired order: refused by the hub and the dollar came home whole')
      results.expire = { outcome: 'bounced whole', lateSeconds: late, hubTx: outcome.ev.transactionHash }
    } else {
      log(`    hub: filled at ${landedAt}, ${-late}s before its deadline — LayerZero was faster than 2 minutes this time; no expiry shown`)
      results.expire = { outcome: 'filled in time', secondsToSpare: -late, hubTx: outcome.ev.transactionHash }
    }
  }

  log('\n━━━ results ━━━')
  log(JSON.stringify(results, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
