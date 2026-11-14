/**
 * The smoke test / mainnet CANARY, as a function — `smoke.js` is its CLI and
 * the test suite drives it in-process. See scripts/smoke.js for what it does.
 *
 * ONE canary token for the whole universe (v7.2): the hub-chain canary
 * launches it (locally, one transaction); every spoke's canary REUSES it —
 * a round trip from each spoke, on that spoke's own vault and its own
 * verifier pathway, instead of one launch per chain. A spoke the launch
 * skipped (Ethereum above its launch ceiling) or that joined later OPENS the
 * token there first (`openToken`, paid by the canary).
 *
 * opts: { profile, netKey, signer, stateFile?, providers?, buy?, pollMs?, token?, log? }
 *   buy       whole dollars of this chain's dollar to buy (default: the
 *             chain's `canaryBuy`, else 20 on play money, else 3 — every
 *             canary shares ONE token, and FAIR GENESIS caps a wallet at
 *             $250 across all chains in its first 10 minutes; a buy over 250
 *             proves the clamp's refund leg instead)
 *   providers { net: provider } — overrides the profile RPCs (tests, forks)
 *   token     the canary token to reuse (default: the deployer's last
 *             CANARY on the pad; none → this canary launches one)
 *
 * Returns { token, replica, bought, minOut, local } — or { skipped: true,
 * reason } when the chain's canary budget cannot afford a round trip right
 * now (Ethereum): said plainly, nothing sent.
 */
const fs = require('fs')
const { ethers } = require('hardhat')
const { dollarScale, dollarOfNet, vaultKind } = require('../config/profiles')
const { GENERATION, vaultName, nativeOf, b32 } = require('./lib-net')

const E = (n) => ethers.parseEther(String(n))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ceilDiv = (a, b) => (a === 0n ? 0n : (a - 1n) / b + 1n)

/** What the curve gives for `usd18` right now (curve phase): the same
 * arithmetic as InternalCurveVenue (rounded against the trader) after the
 * pad's fee — 1% plus the FAIR GENESIS snipe tax of this very moment. */
async function quoteBuy(pad, token, buyer, usd18) {
  const c = await pad.curves(token)
  const fg = await pad.fairGenesisOf(token, ethers.zeroPadValue(buyer, 32))
  const feeRate = 100n + fg.snipeBpsNow
  const net = usd18 - (usd18 * feeRate) / 10_000n
  return c.vTokens - ceilDiv(c.vBase * c.vTokens, c.vBase + net)
}
/** Dollars (18 decimals) a sale of `tokens` pays the seller, net of the 1% fee. */
async function quoteSell(pad, token, tokens) {
  const c = await pad.curves(token)
  const usdOut = c.vBase - ceilDiv(c.vBase * c.vTokens, c.vTokens + tokens)
  return usdOut - (usdOut * 100n) / 10_000n
}

/** The deployer's most recent canary token on the pad (symbol + creator). */
async function findCanaryToken(pad, creator, symbol, scan = 64) {
  const n = Number(await pad.tokensLength())
  for (let i = n - 1; i >= Math.max(0, n - scan); i--) {
    const t = await pad.allTokens(i)
    const m = await pad.metas(t)
    if (m.symbol === symbol && m.creator.toLowerCase() === ethers.zeroPadValue(creator, 32).toLowerCase()) return t
  }
  return undefined
}

// gas of a canary round trip from a remote chain, rounded up from the forks
// (approve, open, the refused proof order, buy, sell, pull, claim, unwrap):
// what the budget check prices at the LIVE gas price
const ROUND_TRIP_GAS = 2_000_000n

async function smoke(opts) {
  const { profile, signer: dev } = opts
  const log = opts.log ?? console.log
  const NET = opts.netKey
  const cfg = profile.nets[NET]
  const FILE = opts.stateFile ?? profile.stateFile
  const HUB_NET = profile.hub
  // one token for every canary: FAIR GENESIS caps a wallet at $250 across
  // ALL chains for the first 10 minutes, so play money buys 20 (5 chains ×
  // 20 stays under it), real money 3
  const BUY = opts.buy ?? cfg.canaryBuy ?? (profile.mockUsdc ? 20 : 3)
  // the cross-chain proof of the protection: a small real order the hub refuses
  const PROOF = 1
  const POLL_MS = opts.pollMs ?? 10_000
  // THIS CHAIN's dollar: USDC (6 decimals) or, on BNB Chain, USDT (18)
  const dollar = dollarOfNet(profile, NET)
  const DEC = dollar.decimals
  const SYM_USD = dollar.symbol
  const COIN = nativeOf(profile, NET)
  const U = (n) => ethers.parseUnits(String(n), DEC)
  const fmtU = (v) => ethers.formatUnits(v, DEC)
  const SCALE = dollarScale(profile, NET) // one smallest unit of the dollar, in oUSD wei

  async function waitFor(what, fn, tries = 90, everyMs = POLL_MS) {
    // a poll that throws is retried — but its error is kept: a watcher that
    // can never succeed (an RPC that refuses the query) must say so at the end
    let lastErr
    for (let i = 0; i < tries; i++) {
      const v = await fn().catch((e) => {
        lastErr = e
        return undefined
      })
      if (v) return v
      if (i % 6 === 0) log(`  … waiting for ${what} (${(i * everyMs) / 1000}s)`)
      await sleep(everyMs)
    }
    const why = lastErr ? ` (last poll error: ${String(lastErr.shortMessage ?? lastErr.message).slice(0, 160)})` : ''
    throw new Error(`${what} not observed after ${(tries * everyMs) / 60000} min — check gas tanks and LayerZero scan${why}`)
  }

  /**
   * Finds one event of `contract` from block `from` on, polled by `waitFor`.
   * Public RPCs cap the range of one eth_getLogs (Base Sepolia: 200 blocks)
   * and a testnet message can take longer than that to land, so this never
   * asks for one growing range: it scans forward in small windows from
   * where the last successful poll stopped.
   */
  function eventScanner(contract, filter, from, match, windowBlocks = 100) {
    let scanned = from - 1
    return async () => {
      const latest = await contract.runner.provider.getBlockNumber()
      while (scanned < latest) {
        const to = Math.min(latest, scanned + windowBlocks)
        const evs = await contract.queryFilter(filter, scanned + 1, to)
        scanned = to
        const hit = evs.find(match)
        if (hit) return hit
      }
      return undefined
    }
  }

  const all = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const me = all[NET]
  const hub = all[HUB_NET]
  const local = NET === HUB_NET
  if (!hub?.pad) throw new Error(`hub not deployed on ${HUB_NET}`)
  if (!me?.gateway) throw new Error(`no gateway deployed on ${NET}`)
  if (me.transport !== GENERATION || !me.usdc) {
    throw new Error(`${NET} is a ${me.transport ?? 'pre-v7'} deployment — deploy ${GENERATION} first`)
  }
  const usdAddr = local ? me.localUsd : me.usd

  const usd = await ethers.getContractAt(vaultName(profile, NET), usdAddr, dev)
  // MockUSDC's ABI is the ERC20 surface the real tokens share
  const usdc = await ethers.getContractAt('MockUSDC', me.usdc, dev)
  const gw = await ethers.getContractAt('SpawnGateway', me.gateway, dev)
  const adapter = await ethers.getContractAt('LayerZeroOmniMessenger', me.adapter, dev)
  // on the hub network the pad is right here; from a spoke it is read over the hub RPC
  const hubProvider =
    opts.providers?.[HUB_NET] ??
    (local ? dev.provider : new ethers.JsonRpcProvider(profile.nets[HUB_NET].rpc, profile.nets[HUB_NET].chainId, { staticNetwork: true }))
  const padAbi = (await ethers.getContractFactory('SpawnPad')).interface
  const pad = new ethers.Contract(hub.pad, padAbi, hubProvider)

  // who pays: a sponsored gateway rides its adapter's tank, otherwise the
  // caller attaches the quoted fee
  const sponsored = await adapter.sponsored(me.gateway)
  const fee = async (quote) => (sponsored ? 0n : await quote)
  const hubTank = await hubProvider.getBalance(hub.adapter)
  const myTank = await dev.provider.getBalance(me.adapter)
  log(
    `${NET} canary — ${SYM_USD} (${DEC} decimals), gas in ${COIN} — hub tank ${ethers.formatEther(hubTank)} ETH, ${NET} tank ${ethers.formatEther(myTank)} ${COIN}` +
      ` — gateway ${sponsored ? 'SPONSORED (tank pays)' : 'user-paid (fees attached)'}`,
  )
  if (hubTank === 0n || (sponsored && myTank === 0n)) {
    throw new Error('a gas tank is empty — fund the adapters first (the deploy script tops them up)')
  }

  const [NAME, SYM] = profile.mainnet ? ['CANARY', 'CANARY'] : ['OMNI TEST', 'OMNI']
  let token = opts.token ?? (await findCanaryToken(pad, dev.address, SYM))
  let replicaNow = token ? await gw.replicaOf(token) : ethers.ZeroAddress
  // did the launch skip this chain? (a launch ceiling, a failed leg)
  let skippedHere = false
  if (token && replicaNow === ethers.ZeroAddress && !local) {
    const block = Number(await pad.spawnBlock(token))
    const evs = await pad.queryFilter(pad.filters.SyncFailed(token, cfg.label), block, block).catch(() => [])
    skippedHere = evs.length > 0
  }

  // ── what a round trip costs here, against what the deployer holds ──
  if (cfg.canaryBudget) {
    const feeData = await dev.provider.getFeeData()
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n
    const msgFees =
      2n * (await fee(gw.quoteBuy())) + (await fee(gw.quoteSell())) + (await fee(gw.quotePull())) +
      (skippedHere ? await fee(gw.quoteOpen()) : 0n) +
      (token ? 0n : await fee(gw.quoteSpawn(NAME, SYM, '{"smoke":true}', false)))
    const gasCost = ROUND_TRIP_GAS * gasPrice
    const need = msgFees + gasCost
    const coins = await dev.provider.getBalance(dev.address)
    // play money is minted below: it never runs short
    const dollars = profile.mockUsdc ? U(BUY) : await usdc.balanceOf(dev.address)
    log(
      `  a canary round trip on ${NET} costs about ${ethers.formatEther(need)} ${COIN} right now ` +
        `(messages ${ethers.formatEther(msgFees)} + gas ${ethers.formatEther(gasCost)} at ${ethers.formatUnits(gasPrice, 'gwei')} gwei)` +
        ` and ${BUY} ${SYM_USD}; the deployer holds ${ethers.formatEther(coins)} ${COIN} and ${fmtU(dollars)} ${SYM_USD}` +
        ` (set aside for it: ${ethers.formatEther(cfg.canaryBudget.coin)} ${COIN}, ${cfg.canaryBudget.dollars} ${SYM_USD})`,
    )
    if (coins < need || dollars < U(BUY) || need > cfg.canaryBudget.coin) {
      const why =
        coins < need
          ? `the deployer holds ${ethers.formatEther(coins)} ${COIN}, a round trip needs ${ethers.formatEther(need)}`
          : dollars < U(BUY)
            ? `the deployer holds ${fmtU(dollars)} ${SYM_USD}, the canary buys ${BUY}`
            : `a round trip costs ${ethers.formatEther(need)} ${COIN} right now, over the ${ethers.formatEther(cfg.canaryBudget.coin)} set aside`
      log(`✗ CANARY NOT AFFORDABLE on ${NET}: ${why}. Nothing was sent. The other chains are not affected;`)
      log(`  this chain's vault stays at the canary cap until its canary passes (run it again when gas is cheaper).`)
      return { skipped: true, reason: why }
    }
  }

  // money is the dollar paid straight into this chain's vault
  if (profile.mockUsdc) {
    if ((await usdc.balanceOf(dev.address)) < U(300)) {
      await (await usdc.mint(dev.address, U(1_000))).wait()
      log(`✓ mock ${SYM_USD} minted`)
    }
  } else if ((await usdc.balanceOf(dev.address)) < U(local ? BUY : BUY + PROOF)) {
    throw new Error(`the signer needs ${local ? BUY : BUY + PROOF} ${SYM_USD} on ${NET} (${me.usdc}) for the canary`)
  }
  // real money: approve exactly what this run spends (the proof order's
  // dollar comes back, but it is pulled first)
  const SPEND = local ? BUY : BUY + PROOF
  if ((await usdc.allowance(dev.address, usdAddr)) < U(SPEND)) {
    await (await usdc.approve(usdAddr, profile.mockUsdc ? ethers.MaxUint256 : U(SPEND))).wait()
    log(`✓ vault approved for ${SYM_USD}`)
    // a lagging public RPC may not show the allowance yet: wait for it
    await waitFor('the approval', async () => (await usdc.allowance(dev.address, usdAddr)) >= U(SPEND), 60, 2_000)
  }

  const META = '{"smoke":true}'
  if (!token) {
    const before = await pad.tokensLength()
    const spawnFee = await fee(gw.quoteSpawn(NAME, SYM, META, false))
    log(
      `spawning ${NAME} ($${SYM}) from ${NET}${local ? ' (hub chain — loopback)' : ''}` +
        ` — messaging fee ${ethers.formatEther(spawnFee)} ${COIN}…`,
    )
    await (await gw.spawnToken(NAME, SYM, META, 0, 1, { value: spawnFee })).wait()
    token = await waitFor('OP_SPAWN on the hub', async () => {
      const len = await pad.tokensLength()
      return len > before ? await pad.allTokens(len - 1n) : undefined
    })
    log('✓ token live on the hub:', token)
  } else {
    log(`reusing the canary token ${token} (launched by an earlier canary)`)
  }

  // ── the replica here: synced by the launch, or OPENED from this chain ──
  let opened = false
  const openHere = async () => {
    const openFee = await fee(gw.quoteOpen())
    log(`opening the token on ${NET} (openToken — the hub sends its SYNC here) — messaging fee ${ethers.formatEther(openFee)} ${COIN}…`)
    await (await gw.openToken(token, { value: openFee })).wait()
    opened = true
  }
  if (skippedHere) {
    log(`  the launch skipped ${NET} (SyncFailed on the hub: its launch ceiling, or a failed leg)`)
    await openHere()
  }
  let rep
  if (local || opened) {
    rep = await waitFor(`replica on ${NET}`, async () => {
      const r = await gw.replicaOf(token)
      return r !== ethers.ZeroAddress ? r : undefined
    })
  } else {
    // in flight — or never sent (a chain wired after the token): open it
    try {
      rep = await waitFor(
        `replica on ${NET}`,
        async () => {
          const r = await gw.replicaOf(token)
          return r !== ethers.ZeroAddress ? r : undefined
        },
        opts.syncTries ?? 36,
      )
    } catch {
      await openHere()
      rep = await waitFor(`replica on ${NET} (opened)`, async () => {
        const r = await gw.replicaOf(token)
        return r !== ethers.ZeroAddress ? r : undefined
      })
    }
  }
  log(`✓ replica on ${NET}${opened ? ' (opened from here)' : ''}:`, rep)

  const buyFee = await fee(gw.quoteBuy())
  const repC = await ethers.getContractAt('SpawnToken', rep, dev)
  const bag0 = await repC.balanceOf(dev.address)
  const spendUsd = BUY > 250 ? 250 : BUY
  const impossible = ethers.parseEther('1000000000') // the whole supply

  // THE PROTECTION, PROVED. Every canary trade goes through the `*Min`
  // functions (second round: the minimum rides the wire and the hub enforces
  // it, on every chain). The proof differs by where the hub answers:
  if (local) {
    // the hub answers inside the transaction: an impossible minimum reverts
    // the whole call ("GW: min out"), simulated, so it costs nothing
    let refused
    try {
      await gw.buyTokenUsdcMin.staticCall(token, U(BUY), impossible, { value: buyFee })
    } catch (e) {
      refused = e.reason ?? e.shortMessage ?? e.message
    }
    if (!refused || !String(refused).includes('GW: min out')) {
      throw new Error(`a buy with an impossible minimum was NOT refused with "GW: min out" (got: ${refused ?? 'no revert'})`)
    }
    log(`✓ slippage protection: an impossible minimum is refused ("GW: min out"), nothing moves`)
  } else {
    // across chains the order really flies: the hub must REFUSE it (Refused,
    // op 2, reason 6 — the venue would not fill it at that minimum) and send
    // every dollar home in the DELIVER. A real message, a small real order.
    const before = await usdc.balanceOf(dev.address)
    const hubBlock = await hubProvider.getBlockNumber()
    log(`proving the protection: a $${PROOF} buy that names an impossible minimum (buyTokenUsdcMin) — messaging fee ${ethers.formatEther(buyFee)} ${COIN}…`)
    await (await gw.buyTokenUsdcMin(token, U(PROOF), impossible, { value: buyFee })).wait()
    const me32 = ethers.zeroPadValue(dev.address, 32).toLowerCase()
    const ev = await waitFor(
      'the hub\'s refusal (Refused, reason 6)',
      eventScanner(
        pad,
        pad.filters.Refused(),
        hubBlock,
        (e) => Number(e.args.op) === 2 && e.args.actor.toLowerCase() === me32 && Number(e.args.reason) === 6,
      ),
    )
    const home = await waitFor(`the ${SYM_USD} back, whole`, async () => {
      const b = await usdc.balanceOf(dev.address)
      return b === before ? b : undefined
    })
    if ((await repC.balanceOf(dev.address)) !== bag0) throw new Error('the refused buy delivered tokens')
    log(`✓ slippage protection across chains: the hub refused the order (Refused, reason ${ev.args.reason}, block ${ev.blockNumber}) and every ${SYM_USD} came home (${fmtU(home)})`)
  }

  const usdcBefore = await usdc.balanceOf(dev.address)
  // local: 1% under the curve's own answer; cross-chain: 5% (the curve moves
  // while the message flies)
  const tol = local ? 99n : 95n
  const minOut = ((await quoteBuy(pad, token, dev.address, E(spendUsd))) * tol) / 100n
  if (minOut === 0n) throw new Error('could not derive a minimum from the curve')
  log(
    `buying $${BUY} of ${SYM_USD}${BUY > 250 ? ' (FAIR GENESIS caps a wallet at $250)' : ''}` +
      ` — minimum ${ethers.formatEther(minOut)} ${SYM} (buyTokenUsdcMin${local ? '' : ', enforced on the hub'})` +
      ` — messaging fee ${ethers.formatEther(buyFee)} ${COIN}…`,
  )
  await (await gw.buyTokenUsdcMin(token, U(BUY), minOut, { value: buyFee })).wait()
  const bal = await waitFor('token delivery', async () => {
    const b = (await repC.balanceOf(dev.address)) - bag0
    return b > 0n ? b : undefined
  })
  log(`✓ delivered: ${ethers.formatEther(bal)} ${SYM} on ${NET}`)
  if (bal < minOut) throw new Error(`delivered ${bal} below the minimum ${minOut} — the check did not hold`)

  // refund leg: tokens and refund ride the same OP_DELIVER, so it is in
  const spent = usdcBefore - (await usdc.balanceOf(dev.address))
  const capped = BUY > 250 && (await pad.genesisSpent(token, ethers.zeroPadValue(dev.address, 32))) === E(250)
  if (capped) {
    if (spent !== U(250)) {
      throw new Error(`refund leg did not come home as ${SYM_USD}: net spend ${fmtU(spent)}, expected 250`)
    }
    log(`✓ FAIR GENESIS clamp refunded $${BUY - 250} — as ${SYM_USD}, straight from the vault`)
  } else {
    if (spent !== U(BUY)) {
      throw new Error(`unexpected net spend ${fmtU(spent)} (expected ${BUY})`)
    }
    if (BUY > 250) log('(the genesis window had already closed on the hub — no refund leg this run)')
  }

  const usdcMid = await usdc.balanceOf(dev.address)
  const claimBefore = await usd.balanceOf(dev.address)
  const sellFee = await fee(gw.quoteSell())
  const minUsd = ((await quoteSell(pad, token, bal / 2n)) * tol) / 100n
  if (minUsd === 0n) throw new Error('could not derive a sell minimum from the curve')
  log(`selling half the bag — minimum $${ethers.formatEther(minUsd)} (sellTokenMin${local ? '' : ', enforced on the hub'})…`)
  await (await gw.sellTokenMin(token, bal / 2n, minUsd, { value: sellFee })).wait()
  const back = await waitFor(`${SYM_USD} payout`, async () => {
    const b = await usdc.balanceOf(dev.address)
    return b > usdcMid ? b - usdcMid : undefined
  })
  log(`✓ payout arrived as ${SYM_USD}: $${fmtU(back)}`)
  // only sub-unit dust may have been minted as oUSD (none at all when the
  // dollar has 18 decimals); a real oUSD claim here would mean the vault
  // was short
  if ((await usd.balanceOf(dev.address)) - claimBefore >= SCALE) {
    throw new Error('payout fell back to an oUSD claim — the vault should be liquid')
  }

  // holder fees: accrued on the hub, pulled to this chain by whoever wants
  // them, claimed locally. The pull also settles what was not split yet, so
  // it works whether or not the $2 trigger was crossed; on the hub chain it
  // is a free local call.
  const dist = await ethers.getContractAt('FeeDistributor', local ? me.localDist : me.dist, dev)
  const pullFee = await fee(gw.quotePull())
  log(`pulling this chain's holder fees home — messaging fee ${ethers.formatEther(pullFee)} ${COIN}…`)
  const owedBefore = await dist.withdrawable(rep, dev.address)
  await (await gw.pullFees(token, { value: pullFee })).wait()
  // at home a drop may already have landed with the trades (autoDrop): any
  // balance will do; on a remote chain the pull itself must bring something
  const owed = await waitFor('holder fees in the local pool', async () => {
    const w = await dist.withdrawable(rep, dev.address)
    return w > owedBefore || (local && w > 0n) ? w : undefined
  })
  const oUsdBefore = await usd.balanceOf(dev.address)
  await (await dist.claim(rep)).wait()
  // A load-balanced public RPC can serve a stale balance right after a tx
  // (seen on OP Sepolia AND on OP mainnet, where unwrapping the stale dust
  // reverted "oUSD: dust"): wait until the claim is visible.
  let claimed = await waitFor('the claimed oUSD in the wallet', async () => {
    const b = await usd.balanceOf(dev.address)
    return b >= oUsdBefore + owed ? b : undefined
  })
  log(`✓ holder fees: $${ethers.formatEther(owed)} claimed locally as oUSD`)

  // ── one portable claim (v7.2), where it costs little: from the USDT vault
  // (BNB Chain) to the hub chain, where it arrives in USDC ──
  let moved
  if (!local && vaultKind(profile, NET) === 'local' && opts.move !== false) {
    const hubCfg = profile.nets[HUB_NET]
    const amount = claimed / 2n
    if (amount < 10n ** 12n) {
      log(`(moveClaim skipped: only ${ethers.formatEther(claimed)} oUSD claimed — under the 1e12-wei minimum ×2)`)
    } else {
      const moveFee = await fee(gw.quoteMove(hubCfg.label))
      const hubUsdc = new ethers.Contract(hub.usdc, ['function balanceOf(address) view returns (uint256)'], hubProvider)
      const hubVault = new ethers.Contract(hub.localUsd, ['function balanceOf(address) view returns (uint256)'], hubProvider)
      const hubScale = dollarScale(profile, HUB_NET)
      const there = async () => (await hubUsdc.balanceOf(dev.address)) * hubScale + (await hubVault.balanceOf(dev.address))
      const there0 = await there()
      log(
        `moving $${ethers.formatEther(amount)} of the claim from ${NET} (${SYM_USD}) to ${HUB_NET} (${dollarOfNet(profile, HUB_NET).symbol}) — ` +
          `moveClaim, messaging fee ${ethers.formatEther(moveFee)} ${COIN}…`,
      )
      await (await gw.moveClaim(hubCfg.label, b32(dev.address), amount, { value: moveFee })).wait()
      const arrived = await waitFor(`the moved claim on ${HUB_NET}`, async () => {
        const d = (await there()) - there0
        return d >= amount ? d : undefined
      })
      if (arrived !== amount) throw new Error(`the moved claim arrived as ${arrived}, expected ${amount}`)
      moved = { from: NET, to: HUB_NET, amount }
      log(`✓ moveClaim: $${ethers.formatEther(amount)} left ${NET} as a claim and arrived on ${HUB_NET} in ${dollarOfNet(profile, HUB_NET).symbol}`)
      claimed = await usd.balanceOf(dev.address)
    }
  }

  // unwrap what is left of the claim, exactly, reading the result from the receipt
  if (claimed > 0n && claimed >= SCALE) {
    const unwrapRc = await (await usd.unwrap(claimed)).wait()
    const unwrapped = unwrapRc.logs
      .map((l) => {
        try {
          return usd.interface.parseLog(l)
        } catch {
          return null
        }
      })
      .find((e) => e?.name === 'Unwrapped')
    if (!unwrapped) throw new Error('unwrap emitted no Unwrapped event')
    log(`✓ $${fmtU(unwrapped.args.usdcOut)} unwrapped to ${SYM_USD}`)
  }

  log('hub spot price:', ethers.formatEther(await pad.spotPrice(token)))
  const hubTankAfter = await hubProvider.getBalance(hub.adapter)
  log(`hub tank: ${ethers.formatEther(hubTank)} → ${ethers.formatEther(hubTankAfter)} ETH (reply budgets in, reply fees out)`)
  log(
    local
      ? `🎉 HUB-LOCAL SPAWN + ${SYM_USD} BUY + ${SYM_USD} PAYOUT + HOLDER FEES — EVERY STEP IN ONE TRANSACTION, NO LAYERZERO MESSAGE`
      : `🎉 CROSS-CHAIN ${opened ? 'OPEN + ' : ''}${SYM_USD} BUY + ${SYM_USD} PAYOUT + HOLDER-FEE PULL${moved ? ' + CLAIM MOVED' : ''} FROM ${NET.toUpperCase()} OVER LIVE LAYERZERO — DONE`,
  )
  return { token, replica: rep, bought: bal, minOut, local, opened, moved }
}

module.exports = { smoke, quoteBuy, quoteSell, findCanaryToken, ROUND_TRIP_GAS }
