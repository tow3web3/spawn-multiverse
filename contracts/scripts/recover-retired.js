/**
 * The v7.0 mainnet deployment is RETIRED (closed on chain: gateways paused,
 * caps 0; state in deployments/mainnet-v7_0.retired.json). What is left
 * there belongs to the deployer hot key: canary bags of replica tokens, oUSD
 * from the canary payouts and fees, and the adapters' gas tanks. This script
 * lists it on ONE network, and — with SPAWN_APPLY=1 — takes back what the
 * hot key can take back by itself:
 *   · on the hub chain: sells every canary bag (exits ignore the pause; a
 *     local sell is one synchronous transaction, no message), then unwraps
 *     the hot key's oUSD to USDC while the vault has the liquidity
 *   · on a spoke: unwraps the hot key's oUSD to USDC. Selling a spoke bag is
 *     a cross-chain round trip through the retired hub (its tank pays the
 *     reply): only with SPAWN_XCHAIN=1 — a bag of a few dollars is not worth it
 *   · the gas tanks answer to the retired timelocks: scripts/recover-tanks.js
 *     (SPAWN_RETIRED=1) prints the calldata OWNER schedules and executes
 *
 *   SPAWN_STATE_FILE=deployments/mainnet-v7_0.retired.json npx hardhat run scripts/recover-retired.js --network base
 *   … SPAWN_APPLY=1 SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY … --network base
 *
 * Nothing here touches the live v7.1 universes: the state file must be a
 * *.retired.json. See scripts/recover-retired.sh for the whole plan.
 */
const { ethers, network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { loadState, isDevNode, MAINNET_CONFIRM, cliSigner } = require('./lib-net')

// the v7.0 surfaces this script touches, spelled out: this is the OLD bytecode
const GATEWAY_ABI = [
  'function replicaOf(address) view returns (address)',
  'function paused() view returns (bool)',
  'function quoteSell() view returns (uint256)',
  'function sellToken(address hubToken, uint256 tokens) payable',
]
const VAULT_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function liquidity() view returns (uint256)',
  'function unwrap(uint256 amount18) returns (uint256)',
  'function totalSupply() view returns (uint256)',
]
const PAD_ABI = ['function tokensLength() view returns (uint256)', 'function allTokens(uint256) view returns (address)', 'function metas(address) view returns (string name, string symbol, string metaURI, bytes32 creator, uint64 spawnedAt, uint8 feeMode)']
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)']
const ADAPTER_ABI = ['function admin() view returns (address)']
const fmt = (v, d = 18) => ethers.formatUnits(v, d)

async function main() {
  const profile = getProfile(network.name)
  const NET = netKeyOf(network.name)
  if (!/retired/.test(profile.stateFile)) {
    throw new Error(`SPAWN_STATE_FILE must point at a retired state file (deployments/mainnet-v7_0.retired.json), not ${profile.stateFile}`)
  }
  const all = loadState(profile.stateFile)
  const entry = all[NET]
  const hub = all[profile.hub]
  if (!entry?.gateway || !hub?.pad) throw new Error(`${NET}: no retired entry in ${profile.stateFile}`)
  const signer = await cliSigner()
  const apply = process.env.SPAWN_APPLY === '1'
  const live = profile.mainnet && !(await isDevNode(ethers.provider))
  const canSend = apply && (!live || process.env.SPAWN_MAINNET_CONFIRM === MAINNET_CONFIRM)
  if (apply && !canSend) console.log('mainnet: listing only (SPAWN_MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_REAL_MONEY sends)')
  const isHub = NET === profile.hub
  const hubCfg = profile.nets[profile.hub]
  const hubProvider = isHub ? ethers.provider : new ethers.JsonRpcProvider(hubCfg.rpc, hubCfg.chainId, { staticNetwork: true })

  const gw = new ethers.Contract(entry.gateway, GATEWAY_ABI, signer)
  const vault = new ethers.Contract(isHub ? entry.localUsd : entry.usd, VAULT_ABI, signer)
  const usdc = new ethers.Contract(entry.usdc, ERC20_ABI, ethers.provider)
  const pad = new ethers.Contract(hub.pad, PAD_ABI, hubProvider)
  const adapter = new ethers.Contract(entry.adapter, ADAPTER_ABI, ethers.provider)

  console.log(`retired v7.0 — ${NET} (${isHub ? 'hub' : 'spoke'}) — hot key ${signer.address} — ${apply ? (canSend ? 'APPLY' : 'listing') : 'listing'}`)
  console.log(`  gateway ${entry.gateway} ${(await gw.paused()) ? 'paused (exits open)' : 'RUNNING'}`)
  const tank = await ethers.provider.getBalance(entry.adapter)
  let admin = null
  try {
    admin = await adapter.admin()
  } catch {
    /* unknown */
  }
  console.log(`  adapter ${entry.adapter} tank ${fmt(tank)} ETH — admin ${admin ?? '?'}${admin && entry.timelock && admin.toLowerCase() === entry.timelock.toLowerCase() ? ' (the retired timelock: scripts/recover-tanks.js SPAWN_RETIRED=1)' : ''}`)

  // ── the canary bags ──
  const n = Number(await pad.tokensLength())
  const bags = []
  for (let i = 0; i < n; i++) {
    const token = await pad.allTokens(i)
    const rep = await gw.replicaOf(token)
    if (rep === ethers.ZeroAddress) continue
    const bal = await new ethers.Contract(rep, ERC20_ABI, ethers.provider).balanceOf(signer.address)
    if (bal > 0n) bags.push({ token, rep, bal, symbol: (await pad.metas(token)).symbol })
  }
  for (const b of bags) console.log(`  bag: ${fmt(b.bal)} ${b.symbol} (replica ${b.rep} of ${b.token})`)
  if (!bags.length) console.log('  no replica bag')

  // ── the dollars ──
  const ousd = await vault.balanceOf(signer.address)
  const liq = await vault.liquidity()
  console.log(`  oUSD held ${fmt(ousd)} · vault liquidity ${fmt(liq, 6)} USDC · USDC in wallet ${fmt(await usdc.balanceOf(signer.address), 6)}`)

  if (!canSend) {
    if (bags.length) console.log(isHub ? '  → SPAWN_APPLY=1 sells the bags here (local, synchronous), then unwraps' : '  → spoke bags: cross-chain sells, only with SPAWN_APPLY=1 SPAWN_XCHAIN=1')
    if (ousd > 0n) console.log('  → SPAWN_APPLY=1 unwraps the oUSD to USDC')
    return
  }

  // ── apply ──
  for (const b of bags) {
    if (!isHub && process.env.SPAWN_XCHAIN !== '1') {
      console.log(`  skip ${b.symbol}: a spoke sell crosses to the retired hub — SPAWN_XCHAIN=1 to do it anyway`)
      continue
    }
    const fee = await gw.quoteSell()
    await (await gw.sellToken(b.token, b.bal, { value: fee })).wait()
    console.log(`  sold ${fmt(b.bal)} ${b.symbol}${isHub ? '' : ` (fee ${fmt(fee)} ETH; the payout arrives with the hub's reply)`} ✓`)
  }
  const after = await vault.balanceOf(signer.address)
  const SCALE = 10n ** 12n
  const can = (await vault.liquidity()) * SCALE
  const amount = after <= can ? after : can - (can % SCALE)
  if (amount >= SCALE) {
    await (await vault.unwrap(amount)).wait()
    console.log(`  unwrapped ${fmt(amount)} oUSD → USDC ✓${after > amount ? ` (${fmt(after - amount)} oUSD left: the vault lacks the liquidity right now)` : ''}`)
  } else if (after > 0n) {
    console.log(`  ${fmt(after)} oUSD not unwrapped: below one USDC unit or no liquidity in the vault`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
