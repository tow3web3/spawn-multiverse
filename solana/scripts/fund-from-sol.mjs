/**
 * Turns SOL held by the project's Solana key into mainnet deploy fuel:
 * the gas coin and the test dollars on Base, Optimism, Arbitrum, BNB Chain
 * and Ethereum, delivered straight to the EVM deployer through Relay
 * (api.relay.link).
 *
 *   node scripts/fund-from-sol.mjs plan          # fresh quotes, no transaction
 *   node scripts/fund-from-sol.mjs test          # one small order (SOL -> ETH on Base)
 *   node scripts/fund-from-sol.mjs run           # every order still short of its target
 *   node scripts/fund-from-sol.mjs watch 1.2     # wait until the wallet holds >= 1.2 SOL
 *
 * Orders are TOP-UPS: each one bridges only what the deployer is missing on
 * that chain, so re-running after a partial run never over-sends.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const KEY_FILE = path.join(HERE, '..', '.keys', 'devnet.json')
const SOL_RPC = process.env.SOL_RPC ?? 'https://api.mainnet-beta.solana.com'
const RELAY = 'https://api.relay.link'
const DEPLOYER = '0x483E931A279B136A2C3fCA6BF5eC2c4239c1B904'

const SOLANA_CHAIN = 792703809
const SOL = '11111111111111111111111111111111'
const ETH = '0x0000000000000000000000000000000000000000'
const LAMPORTS = 1_000_000_000
/** SOL that must stay behind for fees and rent. */
const RESERVE_SOL = 0.005
/** Programs a Relay deposit may invoke. Anything else aborts the order. */
const PROGRAMS = new Set([
  '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2', // Relay depository
  '11111111111111111111111111111111', // System
  'ComputeBudget111111111111111111111111111111',
])

const CHAINS = {
  base: { id: 8453, rpc: 'https://mainnet.base.org', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  optimism: { id: 10, rpc: 'https://mainnet.optimism.io', usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
  arbitrum: { id: 42161, rpc: 'https://arb1.arbitrum.io/rpc', usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  // Ethereum L1: gas is ETH at L1 prices, the dollar is Circle's USDC
  ethereum: { id: 1, rpc: 'https://ethereum-rpc.publicnode.com', usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  // BNB Chain: gas is BNB, the dollar is BSC USDT (18 decimals)
  bnb: {
    id: 56,
    rpc: 'https://bsc-rpc.publicnode.com',
    usdc: '0x55d398326f99059fF775485246999027B3197955',
    usdDecimals: 18,
    native: 'BNB',
    usd: 'USDT',
  },
}

/** Gas first on every chain, test dollars last — if SOL runs short, the
 * USDC targets are the ones to miss. Targets are balances to REACH. */
const ORDERS = [
  { chain: 'base', asset: 'ETH', target: 0.015 },
  { chain: 'optimism', asset: 'ETH', target: 0.006 },
  { chain: 'arbitrum', asset: 'ETH', target: 0.006 },
  { chain: 'base', asset: 'USDC', target: 20 },
  { chain: 'optimism', asset: 'USDC', target: 10 },
  { chain: 'arbitrum', asset: 'USDC', target: 10 },
  // 'ETH' means the chain's gas coin and 'USDC' its dollar (see CHAINS.bnb)
  { chain: 'bnb', asset: 'ETH', target: 0.006 },
  { chain: 'bnb', asset: 'USDC', target: 5 },
  { chain: 'ethereum', asset: 'ETH', target: 0.02 },
  { chain: 'ethereum', asset: 'USDC', target: 5 },
]
/** What an order's asset is called on its chain. */
const nameOf = (order) => (order.asset === 'ETH' ? (CHAINS[order.chain].native ?? 'ETH') : (CHAINS[order.chain].usd ?? 'USDC'))
/** Below this shortfall an order is not worth a transaction. */
const MIN_ORDER = { ETH: 0.0003, USDC: 1 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const lc = (s) => String(s).toLowerCase()

function keypair() {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'))))
}

async function evmCall(rpc, method, params) {
  const r = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}

/** The deployer's balance of an order's asset, in whole units. */
async function balanceOf(order) {
  const c = CHAINS[order.chain]
  if (order.asset === 'ETH') {
    return Number(BigInt(await evmCall(c.rpc, 'eth_getBalance', [DEPLOYER, 'latest']))) / 1e18
  }
  const data = '0x70a08231' + DEPLOYER.slice(2).toLowerCase().padStart(64, '0')
  return Number(BigInt(await evmCall(c.rpc, 'eth_call', [{ to: c.usdc, data }, 'latest']))) / 10 ** (c.usdDecimals ?? 6)
}

async function quote(user, order, lamports) {
  const c = CHAINS[order.chain]
  const r = await fetch(`${RELAY}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user,
      recipient: DEPLOYER,
      originChainId: SOLANA_CHAIN,
      destinationChainId: c.id,
      originCurrency: SOL,
      destinationCurrency: order.asset === 'ETH' ? ETH : c.usdc,
      amount: String(lamports),
      tradeType: 'EXACT_INPUT',
    }),
  })
  const q = await r.json()
  if (!q.details || !q.steps) throw new Error(`no quote: ${JSON.stringify(q).slice(0, 300)}`)
  return q
}

/** Refuses a quote that is not exactly the order we asked for. */
function checkQuote(q, order, lamports, wantOut) {
  const c = CHAINS[order.chain]
  const d = q.details
  const out = Number(d.currencyOut.amountFormatted)
  const fail = (m) => {
    throw new Error(`quote refused (${order.chain} ${order.asset}): ${m}`)
  }
  if (lc(d.recipient) !== lc(DEPLOYER)) fail(`recipient ${d.recipient}`)
  if (d.currencyIn.currency.chainId !== SOLANA_CHAIN) fail('origin chain')
  if (String(d.currencyIn.amount) !== String(lamports)) fail(`input amount ${d.currencyIn.amount}`)
  if (d.currencyOut.currency.chainId !== c.id) fail(`destination chain ${d.currencyOut.currency.chainId}`)
  const wantCur = order.asset === 'ETH' ? ETH : c.usdc
  if (lc(d.currencyOut.currency.address) !== lc(wantCur)) fail(`currency ${d.currencyOut.currency.address}`)
  const usdIn = Number(d.currencyIn.amountUsd)
  const usdOut = Number(d.currencyOut.amountUsd)
  if (!(usdOut >= usdIn * 0.97)) fail(`cost ${(100 * (1 - usdOut / usdIn)).toFixed(2)}% > 3%`)
  if (wantOut !== undefined && !(out >= wantOut * 0.98 && out <= wantOut * 1.15)) {
    fail(`output ${out} vs wanted ${wantOut}`)
  }
  if (q.steps.length !== 1 || q.steps[0].items.length !== 1) fail('more than one transaction')
  const data = q.steps[0].items[0].data
  for (const ix of data.instructions) {
    if (!PROGRAMS.has(ix.programId)) fail(`unknown program ${ix.programId}`)
    for (const k of ix.keys) {
      if (k.isSigner && k.pubkey !== q.details.sender) fail(`foreign signer ${k.pubkey}`)
    }
  }
  return out
}

async function buildTx(conn, kp, q) {
  const data = q.steps[0].items[0].data
  const ixs = data.instructions.map(
    (i) =>
      new TransactionInstruction({
        programId: new PublicKey(i.programId),
        keys: i.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
        data: Buffer.from(i.data, 'hex'),
      }),
  )
  const alts = []
  for (const a of data.addressLookupTableAddresses ?? []) {
    const t = (await conn.getAddressLookupTable(new PublicKey(a))).value
    if (!t) throw new Error(`lookup table ${a} not found`)
    alts.push(t)
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized')
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts)
  const tx = new VersionedTransaction(msg)
  tx.sign([kp])
  return { tx, blockhash, lastValidBlockHeight }
}

/** Sizes an order from a live rate, quotes it, checks it. */
async function prepare(user, order, shortfall, maxLamports) {
  const probe = await quote(user, order, 0.05 * LAMPORTS)
  const rate = Number(probe.details.currencyOut.amountFormatted) / 0.05 // asset per SOL
  let lamports = Math.ceil((shortfall / rate) * 1.012 * LAMPORTS)
  let wantOut = shortfall
  if (lamports > maxLamports) {
    // not enough SOL for the whole shortfall: send what there is
    lamports = Math.floor(maxLamports)
    wantOut = undefined
  }
  const q = await quote(user, order, lamports)
  const out = checkQuote(q, order, lamports, wantOut)
  return { q, lamports, out }
}

async function execute(conn, kp, order, prepared) {
  const { q, lamports, out } = prepared
  const before = await balanceOf(order)
  const { tx, blockhash, lastValidBlockHeight } = await buildTx(conn, kp, q)

  // Simulate first: it must succeed and debit no more than the quoted input.
  const solBefore = await conn.getBalance(kp.publicKey)
  const sim = await conn.simulateTransaction(tx, {
    sigVerify: false,
    accounts: { encoding: 'base64', addresses: [kp.publicKey.toBase58()] },
  })
  if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`)
  const debit = solBefore - (sim.value.accounts?.[0]?.lamports ?? solBefore)
  if (debit < lamports || debit > lamports + 0.002 * LAMPORTS) {
    throw new Error(`simulation debits ${debit} lamports, quote said ${lamports}`)
  }

  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 })
  console.log(`   sent  ${sig}`)
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  if (conf.value.err) throw new Error(`transaction failed: ${JSON.stringify(conf.value.err)}`)

  // Trust the destination chain, not the bridge's word.
  const want = before + out * 0.98
  for (let i = 0; i < 60; i++) {
    await sleep(5_000)
    const now = await balanceOf(order).catch(() => before)
    if (now >= want) {
      console.log(`   ✓ arrived: ${nameOf(order)} on ${order.chain} ${before} -> ${now}`)
      return now
    }
  }
  const st = await fetch(`${RELAY}${q.steps[0].items[0].check.endpoint}`).then((r) => r.json()).catch(() => ({}))
  throw new Error(`not seen on ${order.chain} after 5 min — relay status: ${JSON.stringify(st).slice(0, 300)} — request ${q.steps[0].requestId}`)
}

async function main() {
  const [cmd, arg] = process.argv.slice(2)
  const kp = keypair()
  const user = kp.publicKey.toBase58()
  const conn = new Connection(SOL_RPC, 'confirmed')
  const sol = (await conn.getBalance(kp.publicKey)) / LAMPORTS
  console.log(`wallet ${user} — ${sol} SOL`)

  if (cmd === 'watch') {
    const min = Number(arg ?? 1)
    for (let i = 0; i < 24 * 60; i++) {
      const b = (await conn.getBalance(kp.publicKey).catch(() => 0)) / LAMPORTS
      if (b >= min) {
        console.log(`SOL_ARRIVED ${b}`)
        return
      }
      await sleep(60_000)
    }
    console.log('WATCH_TIMEOUT after 24h')
    return
  }

  if (cmd === 'test') {
    const order = { chain: 'base', asset: 'ETH' }
    const lamports = 0.02 * LAMPORTS
    if (sol < 0.02 + RESERVE_SOL) throw new Error('not enough SOL for the test order')
    const q = await quote(user, order, lamports)
    const out = checkQuote(q, order, lamports)
    console.log(`test: 0.02 SOL -> ${out} ETH on base`)
    await execute(conn, kp, order, { q, lamports, out })
    return
  }

  if (cmd !== 'plan' && cmd !== 'run') throw new Error('usage: plan [chain] | test | run [chain] | watch <minSol>')
  // `plan bnb` / `run bnb`: only that chain's orders (the targets of the
  // other chains were for their own launch and must not be topped up again)
  if (arg && !CHAINS[arg]) throw new Error(`unknown chain "${arg}" (${Object.keys(CHAINS).join(' | ')})`)

  let spendable = (sol - RESERVE_SOL) * LAMPORTS
  for (const order of ORDERS.filter((o) => !arg || o.chain === arg)) {
    const have = await balanceOf(order)
    const shortfall = order.target - have
    const label = `${order.chain.padEnd(9)} ${nameOf(order).padEnd(4)} have ${have} target ${order.target}`
    if (shortfall < MIN_ORDER[order.asset]) {
      console.log(`${label} — ok`)
      continue
    }
    if (cmd === 'plan') {
      const probe = await quote(user, order, 0.05 * LAMPORTS)
      const rate = Number(probe.details.currencyOut.amountFormatted) / 0.05
      const need = (shortfall / rate) * 1.012
      console.log(`${label} — needs ${need.toFixed(4)} SOL (cost ${(100 * (1 - Number(probe.details.currencyOut.amountUsd) / Number(probe.details.currencyIn.amountUsd))).toFixed(2)}%)`)
      spendable -= need * LAMPORTS
      continue
    }
    if (spendable < 0.01 * LAMPORTS) {
      console.log(`${label} — SKIPPED, out of SOL`)
      continue
    }
    const prepared = await prepare(user, order, shortfall, spendable)
    console.log(`${label} — bridging ${prepared.lamports / LAMPORTS} SOL -> ${prepared.out} ${nameOf(order)}`)
    await execute(conn, kp, order, prepared)
    spendable = (await conn.getBalance(kp.publicKey)) - RESERVE_SOL * LAMPORTS
  }
  if (cmd === 'plan') console.log(`SOL left after the plan: ${(spendable / LAMPORTS).toFixed(4)} (negative = send more)`)
}

main().catch((e) => {
  console.error(`ABORTED: ${e.message}`)
  process.exit(1)
})
