/**
 * The smoke test / mainnet CANARY, as a function — `smoke.js` is its CLI and
 * the test suite drives it in-process. See scripts/smoke.js for what it does.
 *
 * opts: { profile, netKey, signer, stateFile?, providers?, buy?, pollMs?, log? }
 *   buy       whole dollars to buy (default: 260 on play money — enough to
 *             hit the FAIR GENESIS cap — else 3)
 *   providers { net: provider } — overrides the profile RPCs (tests, forks)
 */
const fs = require('fs')
const { ethers } = require('hardhat')
const { dollarScale } = require('../config/profiles')
const { GENERATION, vaultName, nativeOf, dollarOf } = require('./lib-net')

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

async function smoke(opts) {
  const { profile, signer: dev } = opts
  const log = opts.log ?? console.log
  const NET = opts.netKey
  const FILE = opts.stateFile ?? profile.stateFile
  const HUB_NET = profile.hub
  // what the smoke buys: enough to hit the genesis cap on play money, a few
  // real dollars on mainnet
  const BUY = opts.buy ?? (profile.mockUsdc ? 260 : 3)
  const POLL_MS = opts.pollMs ?? 10_000
  // the universe's dollar: USDC (6 decimals) or, on BNB Chain, USDT (18)
  const DEC = profile.dollar?.decimals ?? 6
  const SYM_USD = dollarOf(profile)
  const COIN = nativeOf(profile)
  const U = (n) => ethers.parseUnits(String(n), DEC)
  const fmtU = (v) => ethers.formatUnits(v, DEC)
  const SCALE = dollarScale(profile) // one smallest unit of the dollar, in oUSD wei

  async function waitFor(what, fn, tries = 90, everyMs = POLL_MS) {
    for (let i = 0; i < tries; i++) {
      const v = await fn().catch(() => undefined)
      if (v) return v
      if (i % 6 === 0) log(`  … waiting for ${what} (${(i * everyMs) / 1000}s)`)
      await sleep(everyMs)
    }
    throw new Error(`${what} not observed after ${(tries * everyMs) / 60000} min — check gas tanks and LayerZero scan`)
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

  const usd = await ethers.getContractAt(vaultName(profile), usdAddr, dev)
  // MockUSDC's ABI is the ERC20 surface the real token shares
  const usdc = await ethers.getContractAt('MockUSDC', me.usdc, dev)
  const gw = await ethers.getContractAt('SpawnGateway', me.gateway, dev)
  const adapter = await ethers.getContractAt('LayerZeroOmniMessenger', me.adapter, dev)
  // on the hub network the pad is right here; from a spoke it is read over the hub RPC
  const hubProvider =
    opts.providers?.[HUB_NET] ?? (local ? dev.provider : new ethers.JsonRpcProvider(profile.nets[HUB_NET].rpc))
  const padAbi = (await ethers.getContractFactory('SpawnPad')).interface
  const pad = new ethers.Contract(hub.pad, padAbi, hubProvider)

  // who pays: a sponsored gateway rides its adapter's tank, otherwise the
  // caller attaches the quoted fee
  const sponsored = await adapter.sponsored(me.gateway)
  const fee = async (quote) => (sponsored ? 0n : await quote)
  const hubTank = await hubProvider.getBalance(hub.adapter)
  const myTank = await dev.provider.getBalance(me.adapter)
  // a single-chain universe sends nothing anywhere: its tank is never used
  const single = !!profile.singleChain
  log(
    single
      ? `single-chain universe (${profile.universe}): no LayerZero message, no gas tank, every quote is 0`
      : `gas tanks — hub: ${ethers.formatEther(hubTank)} ${COIN}, ${NET}: ${ethers.formatEther(myTank)} ${COIN}` +
          ` — gateway ${sponsored ? 'SPONSORED (tank pays)' : 'user-paid (fees attached)'}`,
  )
  if (!single && (hubTank === 0n || (sponsored && myTank === 0n))) {
    throw new Error('a gas tank is empty — fund the adapters first (the deploy script tops them up)')
  }

  // money is the dollar paid straight into this chain's vault
  if (profile.mockUsdc) {
    if ((await usdc.balanceOf(dev.address)) < U(300)) {
      await (await usdc.mint(dev.address, U(1_000))).wait()
      log(`✓ mock ${SYM_USD} minted`)
    }
  } else if ((await usdc.balanceOf(dev.address)) < U(BUY)) {
    throw new Error(`the signer needs ${BUY} ${SYM_USD} on ${NET} (${me.usdc}) for the canary buy`)
  }
  if ((await usdc.allowance(dev.address, usdAddr)) < U(BUY)) {
    // real money: approve exactly what this run spends
    await (await usdc.approve(usdAddr, profile.mockUsdc ? ethers.MaxUint256 : U(BUY))).wait()
    log(`✓ vault approved for ${SYM_USD}`)
    // a lagging public RPC may not show the allowance yet: wait for it
    await waitFor('the approval', async () => (await usdc.allowance(dev.address, usdAddr)) >= U(BUY), 60, 2_000)
  }

  const before = await pad.tokensLength()
  const META = '{"smoke":true}'
  const [NAME, SYM] = profile.mainnet ? ['CANARY', 'CANARY'] : ['OMNI TEST', 'OMNI']
  const spawnFee = await fee(gw.quoteSpawn(NAME, SYM, META, false))
  log(
    `spawning ${NAME} ($${SYM}) from ${NET}${local ? ' (hub chain — loopback)' : ''}` +
      ` — messaging fee ${ethers.formatEther(spawnFee)} ${COIN}…`,
  )
  await (await gw.spawnToken(NAME, SYM, META, 0, 1, { value: spawnFee })).wait()

  const token = await waitFor('OP_SPAWN on the hub', async () => {
    const len = await pad.tokensLength()
    return len > before ? await pad.allTokens(len - 1n) : undefined
  })
  log('✓ token live on the hub:', token)

  const rep = await waitFor(`replica on ${NET}`, async () => {
    const r = await gw.replicaOf(token)
    return r !== ethers.ZeroAddress ? r : undefined
  })
  log('✓ replica deployed:', rep)

  const buyFee = await fee(gw.quoteBuy())
  const repC = await ethers.getContractAt('SpawnToken', rep, dev)
  const usdcBefore = await usdc.balanceOf(dev.address)
  // what actually reaches the curve: FAIR GENESIS caps a wallet at $250
  const spendUsd = BUY > 250 ? 250 : BUY

  // THE PROTECTION, PROVED (simulated against the live state, so it costs
  // nothing): the very buy about to be sent, but with a minimum no trade can
  // meet, must be refused with "GW: min out" — on a local gateway because
  // the trade came out below the minimum, on a remote one because the reply
  // has not happened yet. Nothing may move.
  const impossible = ethers.parseEther('1000000000') // the whole supply
  let refused
  try {
    await gw.buyTokenUsdcMin.staticCall(token, U(BUY), impossible, { value: buyFee })
  } catch (e) {
    refused = e.reason ?? e.shortMessage ?? e.message
  }
  if (!refused || !String(refused).includes('GW: min out')) {
    throw new Error(`a buy with an impossible minimum was NOT refused with "GW: min out" (got: ${refused ?? 'no revert'})`)
  }
  if ((await usdc.balanceOf(dev.address)) !== usdcBefore || (await repC.balanceOf(dev.address)) !== 0n) {
    throw new Error('the refused buy moved money')
  }
  log(`✓ slippage protection: an impossible minimum is refused ("GW: min out"), nothing moves`)

  let minOut = 0n
  if (local) {
    // 1% tolerance under the curve's own answer for what will be spent
    minOut = ((await quoteBuy(pad, token, dev.address, E(spendUsd))) * 99n) / 100n
    if (minOut === 0n) throw new Error('could not derive a minimum from the curve')
  }
  log(
    `buying $${BUY} of ${SYM_USD}${BUY > 250 ? ' (FAIR GENESIS caps a wallet at $250)' : ''}` +
      (local ? ` — minimum ${ethers.formatEther(minOut)} ${SYM} (buyTokenUsdcMin)` : '') +
      ` — messaging fee ${ethers.formatEther(buyFee)} ${COIN}…`,
  )
  if (local) await (await gw.buyTokenUsdcMin(token, U(BUY), minOut, { value: buyFee })).wait()
  else await (await gw.buyTokenUsdc(token, U(BUY), { value: buyFee })).wait()
  const bal = await waitFor('token delivery', async () => {
    const b = await repC.balanceOf(dev.address)
    return b > 0n ? b : undefined
  })
  log(`✓ delivered: ${ethers.formatEther(bal)} ${SYM} on ${NET}`)
  if (local && bal < minOut) throw new Error(`delivered ${bal} below the minimum ${minOut} — the check did not hold`)

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
  if (local) {
    const minUsd = ((await quoteSell(pad, token, bal / 2n)) * 99n) / 100n
    if (minUsd === 0n) throw new Error('could not derive a sell minimum from the curve')
    log(`selling half the bag — minimum $${ethers.formatEther(minUsd)} (sellTokenMin)…`)
    await (await gw.sellTokenMin(token, bal / 2n, minUsd, { value: sellFee })).wait()
  } else {
    log('selling half the bag…')
    await (await gw.sellToken(token, bal / 2n, { value: sellFee })).wait()
  }
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
  await (await gw.pullFees(token, { value: pullFee })).wait()
  const owed = await waitFor('holder fees in the local pool', async () => {
    const w = await dist.withdrawable(rep, dev.address)
    return w > 0n ? w : undefined
  })
  const oUsdBefore = await usd.balanceOf(dev.address)
  await (await dist.claim(rep)).wait()
  // A load-balanced public RPC can serve a stale balance right after a tx
  // (seen on OP Sepolia AND on OP mainnet, where unwrapping the stale dust
  // reverted "oUSD: dust"): wait until the claim is visible, then unwrap
  // exactly what it paid, and read the result from the receipt.
  const claimed = await waitFor('the claimed oUSD in the wallet', async () => {
    const b = await usd.balanceOf(dev.address)
    return b >= oUsdBefore + owed ? b : undefined
  })
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
  log(
    `✓ holder fees: $${ethers.formatEther(owed)} claimed locally, ` +
      `$${fmtU(unwrapped.args.usdcOut)} unwrapped to ${SYM_USD}`,
  )

  log('hub spot price:', ethers.formatEther(await pad.spotPrice(token)))
  if (!single) {
    const hubTankAfter = await hubProvider.getBalance(hub.adapter)
    log(
      `hub tank: ${ethers.formatEther(hubTank)} → ${ethers.formatEther(hubTankAfter)} ${COIN}` +
        ' (reply budgets in, reply fees out)',
    )
  }
  log(
    local
      ? `🎉 HUB-LOCAL SPAWN + ${SYM_USD} BUY + ${SYM_USD} PAYOUT + HOLDER FEES — EVERY STEP IN ONE TRANSACTION, NO LAYERZERO MESSAGE`
      : `🎉 CROSS-CHAIN SPAWN + ${SYM_USD} BUY + ${SYM_USD} PAYOUT + HOLDER-FEE PULL OVER LIVE LAYERZERO — DONE`,
  )
  return { token, replica: rep, bought: bal, minOut, local, single }
}

module.exports = { smoke, quoteBuy, quoteSell }
