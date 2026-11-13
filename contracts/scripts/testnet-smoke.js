/**
 * Live smoke test over the real LayerZero V2 testnets, v7 paths end to end
 * with (mock) USDC. Run it on any deployed network:
 *
 *   npx hardhat run scripts/testnet-smoke.js --network optimismSepolia   # a remote chain
 *   npx hardhat run scripts/testnet-smoke.js --network baseSepolia       # the hub chain (local trading)
 *
 * On a REMOTE chain it spawns a token from this spoke, waits for LayerZero
 * to land OP_SPAWN on the hub and for the replica to sync back, then:
 *   - `buyTokenUsdc` for $260 inside the FAIR GENESIS window — the $250 cap
 *     clamps it, and the $10 REFUND leg must come home as USDC;
 *   - sells half the bag — the PAYOUT leg must come home as USDC;
 *   - pulls this chain's share of the holder fees home (`pullFees`, v7: the
 *     hub books it and waits to be asked), claims it from the local pool and
 *     unwraps it to USDC.
 * Expect minutes, not seconds.
 *
 * On the HUB chain the same sequence runs through the loopback: every step
 * settles inside its own transaction, with no LayerZero message — only the
 * spawn's SYNC fan-out to the remote chains leaves the hub.
 *
 * Fees (v7): when the gateway is not sponsored the script attaches the
 * exact `quote*` fee to every call, like a mainnet user would.
 */
const fs = require('fs')
const path = require('path')
const { ethers, network } = require('hardhat')

const FILE = path.join(__dirname, '..', 'deployments', 'testnet.json')
const HUB_NET = 'baseSepolia'
const HUB_RPC = 'https://sepolia.base.org'
const POLL_MS = Number(process.env.SMOKE_POLL_MS ?? 10_000)
const E = (n) => ethers.parseEther(String(n))
const U = (n) => ethers.parseUnits(String(n), 6)
const SCALE = 10n ** 12n // one USDC unit in oUSD wei
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(what, fn, tries = 90, everyMs = POLL_MS) {
  for (let i = 0; i < tries; i++) {
    const v = await fn().catch(() => undefined)
    if (v) return v
    if (i % 6 === 0) console.log(`  … waiting for ${what} (${(i * everyMs) / 1000}s)`)
    await sleep(everyMs)
  }
  throw new Error(`${what} not observed after ${(tries * everyMs) / 60000} min — check gas tanks and LayerZero scan`)
}

async function main() {
  const all = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const me = all[network.name]
  const hub = all[HUB_NET]
  const local = network.name === HUB_NET
  if (!hub?.pad) throw new Error(`hub not deployed on ${HUB_NET}`)
  if (!me?.gateway) throw new Error(`no gateway deployed on ${network.name}`)
  if (me.transport !== 'v7' || !me.usdc) {
    throw new Error(`${network.name} is a pre-v7 deployment — redeploy v7 first`)
  }
  const usdAddr = local ? me.localUsd : me.usd

  const [dev] = await ethers.getSigners()
  const usd = await ethers.getContractAt('OmniUSD', usdAddr)
  const usdc = await ethers.getContractAt('MockUSDC', me.usdc)
  const gw = await ethers.getContractAt('SpawnGateway', me.gateway)
  const adapter = await ethers.getContractAt('LayerZeroOmniMessenger', me.adapter)
  // on the hub network the pad is right here; from a spoke it is read over the hub RPC
  const hubProvider = local ? ethers.provider : new ethers.JsonRpcProvider(HUB_RPC)
  const padAbi = (await ethers.getContractFactory('SpawnPad')).interface
  const pad = new ethers.Contract(hub.pad, padAbi, hubProvider)

  // who pays: a sponsored gateway rides its adapter's tank, otherwise the
  // caller attaches the quoted fee
  const sponsored = await adapter.sponsored(me.gateway)
  const fee = async (quote) => (sponsored ? 0n : await quote)
  const hubTank = await hubProvider.getBalance(hub.adapter)
  const myTank = await ethers.provider.getBalance(me.adapter)
  console.log(
    `gas tanks — hub: ${ethers.formatEther(hubTank)} ETH, ${network.name}: ${ethers.formatEther(myTank)} ETH` +
      ` — gateway ${sponsored ? 'SPONSORED (tank pays)' : 'user-paid (fees attached)'}`,
  )
  if (hubTank === 0n || (sponsored && myTank === 0n)) {
    throw new Error('a gas tank is empty — fund the adapters first (deploy-testnet tops them up)')
  }

  // v7: money is (mock) USDC paid straight into this chain's vault
  if ((await usdc.balanceOf(dev.address)) < U(300)) {
    await (await usdc.mint(dev.address, U(1_000))).wait()
    console.log('✓ mock USDC minted')
  }
  if ((await usdc.allowance(dev.address, usdAddr)) < U(1_000)) {
    await (await usdc.approve(usdAddr, ethers.MaxUint256)).wait()
    console.log('✓ vault approved for USDC')
  }

  const before = await pad.tokensLength()
  const META = '{"smoke":true}'
  const spawnFee = await fee(gw.quoteSpawn('OMNI TEST', 'OMNI', META, false))
  console.log(
    `spawning OMNI TEST ($OMNI) from ${network.name}${local ? ' (hub chain — loopback)' : ''}` +
      ` — messaging fee ${ethers.formatEther(spawnFee)} ETH…`,
  )
  await (await gw.spawnToken('OMNI TEST', 'OMNI', META, 0, 1, { value: spawnFee })).wait()

  const token = await waitFor('OP_SPAWN on the hub', async () => {
    const len = await pad.tokensLength()
    return len > before ? await pad.allTokens(len - 1n) : undefined
  })
  console.log('✓ token live on the hub:', token)

  const rep = await waitFor(`replica on ${network.name}`, async () => {
    const r = await gw.replicaOf(token)
    return r !== ethers.ZeroAddress ? r : undefined
  })
  console.log('✓ replica deployed:', rep)

  const buyFee = await fee(gw.quoteBuy())
  console.log(
    `buying $260 of USDC (FAIR GENESIS caps a wallet at $250) — messaging fee ${ethers.formatEther(buyFee)} ETH…`,
  )
  const usdcBefore = await usdc.balanceOf(dev.address)
  await (await gw.buyTokenUsdc(token, U(260), { value: buyFee })).wait()
  const repC = await ethers.getContractAt('SpawnToken', rep)
  const bal = await waitFor('token delivery', async () => {
    const b = await repC.balanceOf(dev.address)
    return b > 0n ? b : undefined
  })
  console.log(`✓ delivered: ${ethers.formatEther(bal)} OMNI on ${network.name}`)

  // refund leg: tokens and refund ride the same OP_DELIVER, so it is in
  const spent = usdcBefore - (await usdc.balanceOf(dev.address))
  const capped = (await pad.genesisSpent(token, ethers.zeroPadValue(dev.address, 32))) === E(250)
  if (capped) {
    if (spent !== U(250)) {
      throw new Error(`refund leg did not come home as USDC: net spend ${ethers.formatUnits(spent, 6)}, expected 250`)
    }
    console.log('✓ FAIR GENESIS clamp refunded $10 — as USDC, straight from the vault')
  } else {
    if (spent !== U(260)) {
      throw new Error(`unexpected net spend ${ethers.formatUnits(spent, 6)} (window closed, expected 260)`)
    }
    console.log('(the genesis window had already closed on the hub — no refund leg this run)')
  }

  console.log('selling half the bag…')
  const usdcMid = await usdc.balanceOf(dev.address)
  const claimBefore = await usd.balanceOf(dev.address)
  await (await gw.sellToken(token, bal / 2n, { value: await fee(gw.quoteSell()) })).wait()
  const back = await waitFor('USDC payout', async () => {
    const b = await usdc.balanceOf(dev.address)
    return b > usdcMid ? b - usdcMid : undefined
  })
  console.log(`✓ payout arrived as USDC: $${ethers.formatUnits(back, 6)}`)
  // only sub-USDC dust may have been minted as oUSD; a real oUSD claim here
  // would mean the vault was short
  if ((await usd.balanceOf(dev.address)) - claimBefore >= SCALE) {
    throw new Error('payout fell back to an oUSD claim — the vault should be liquid')
  }

  // holder fees (v7): accrued on the hub, pulled to this chain by whoever
  // wants them, claimed locally. The pull also settles what was not split
  // yet, so it works whether or not the $2 trigger was crossed; on the hub
  // chain it is a free local call.
  const dist = await ethers.getContractAt('FeeDistributor', local ? me.localDist : me.dist)
  const pullFee = await fee(gw.quotePull())
  console.log(`pulling this chain's holder fees home — messaging fee ${ethers.formatEther(pullFee)} ETH…`)
  await (await gw.pullFees(token, { value: pullFee })).wait()
  const owed = await waitFor('holder fees in the local pool', async () => {
    const w = await dist.withdrawable(rep, dev.address)
    return w > 0n ? w : undefined
  })
  await (await dist.claim(rep)).wait()
  const usdcPre = await usdc.balanceOf(dev.address)
  await (await usd.unwrap(await usd.balanceOf(dev.address))).wait()
  console.log(
    `✓ holder fees: $${ethers.formatEther(owed)} claimed locally, ` +
      `$${ethers.formatUnits((await usdc.balanceOf(dev.address)) - usdcPre, 6)} unwrapped to USDC`,
  )

  console.log('hub spot price:', ethers.formatEther(await pad.spotPrice(token)))
  const hubTankAfter = await hubProvider.getBalance(hub.adapter)
  console.log(
    `hub tank: ${ethers.formatEther(hubTank)} → ${ethers.formatEther(hubTankAfter)} ETH` +
      ' (reply budgets in, reply fees out)',
  )
  console.log(
    local
      ? '🎉 HUB-LOCAL SPAWN + USDC BUY + USDC PAYOUT + HOLDER FEES — EVERY STEP IN ONE TRANSACTION, NO LAYERZERO MESSAGE'
      : '🎉 CROSS-CHAIN SPAWN + USDC BUY + USDC PAYOUT + HOLDER-FEE PULL OVER LIVE LAYERZERO — DONE',
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
