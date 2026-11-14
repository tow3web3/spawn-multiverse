/**
 * A command line for the gateway — made for the devnet rehearsal: every
 * user action, and what a user (or an operator watching) needs to read.
 *
 * DRY RUN BY DEFAULT. A command builds its transaction, quotes it, simulates
 * it against the cluster and prints what it would do; nothing is signed or
 * sent unless `--send` is given (with `--keypair`). `mainnet-beta --send`
 * also needs `--confirm-mainnet`.
 *
 *   npm run cli -- <command> [options]
 *
 * Reading
 *   status                          the store: roles, pause, prices, vault, tank, routes, peers
 *   balances [--token 0x…,0x…]      SOL, USDC, claim, parked deliveries; per token: bag, stake, rewards
 *   pending  [--token 0x…,0x…]      what waits for the owner, and what to run to get it
 *   quote                           what each message costs right now
 *
 * Messages to the hub (each prepays its replies)
 *   spawn      --name N --symbol S [--meta URI] [--dev-buy USDC] [--fee-mode 0..3]
 *   buy        --token 0x… --usdc A --min-tokens M     (M is required: "any" = one unit)
 *   sell       --token 0x… --tokens A --min-usdc M     (same)
 *   claim-fees --token 0x…
 *   pull-fees  --token 0x…
 *   open       --token 0x…                             (also pays the replica's rent)
 *   move       --to-chain ethereum|base|bnb|arbitrum|optimism|<label> --to 0x… --usdc A
 *
 * Local
 *   redeem --usdc A | claim-parked --token 0x… | open-account [--for KEY]
 *
 * Options (defaults in brackets)
 *   --cluster devnet|mainnet-beta|localnet [devnet]   --rpc URL [the cluster's]
 *   --program-id KEY [3myp…H95g]
 *   --keypair FILE          the user (never printed); or --owner KEY for a dry run / a read
 *   --send                  sign and send (default: dry run)   --confirm-mainnet
 *   --max-fee LAMPORTS      fee ceiling [the quote + 10%]      --priority MICROLAMPORTS_PER_CU
 *   --tx                    print the unsigned transaction (base64)
 *
 * Amounts are decimal (6 decimals: "12.5"). A token is its hub address.
 */
import * as fs from 'fs'
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import {
  ANY_FILL,
  BuiltSend,
  CCTP_DOMAIN,
  CHAIN_LABEL,
  CLUSTERS,
  Cluster,
  GatewayClient,
  GatewayRpc,
  OP,
  QuoteSendParams,
  SENDS,
  SendSpec,
  bytes32ToEvmAddress,
  bytesToHex,
  claimableRewards,
  connectionRpc,
  findSentToHub,
  formatUnits,
  hexToBytes,
  parkedUnits,
  parseUnits,
  quoteSendIx,
  assembleV0,
  readUintLE,
  toBytes32,
} from '../app/src'

/* ------------------------------ plumbing ------------------------------ */

export interface CliIo {
  rpc: GatewayRpc
  out(line: string): void
  /** Signs with `signer`, sends, confirms; returns the signature and the
   * transaction's logs. Absent = this run cannot send. */
  send?(tx: VersionedTransaction, signer: Keypair): Promise<{ signature: string; logs: string[] }>
  loadKeypair(file: string): Keypair
}

const FLAGS = new Set(['send', 'confirm-mainnet', 'tx', 'help'])

export function parseArgs(argv: string[]): { command: string; opt: Map<string, string> } {
  const opt = new Map<string, string>()
  let command = ''
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      if (command) throw new Error(`unexpected argument "${a}" (the command is "${command}")`)
      command = a
      continue
    }
    const k = a.slice(2)
    if (FLAGS.has(k)) opt.set(k, 'true')
    else {
      const v = argv[++i]
      if (v === undefined) throw new Error(`--${k} needs a value`)
      opt.set(k, v)
    }
  }
  return { command, opt }
}

const NAME_OF_LABEL = new Map<number, string>(Object.entries(CHAIN_LABEL).map(([n, l]) => [l, n]))

export function chainLabel(x: string): number {
  const named = (CHAIN_LABEL as Record<string, number>)[x.toLowerCase()]
  if (named !== undefined) return named
  if (!/^\d+$/.test(x)) throw new Error(`unknown chain "${x}" (ethereum, base, bnb, arbitrum, optimism, or a label)`)
  return Number(x)
}

/** A token as its 32-byte wire id: the hub address, left-padded. */
function token(x: string): Uint8Array {
  const id = toBytes32(x)
  if (bytes32ToEvmAddress(id) === null) throw new Error(`a token is its hub address (20 bytes): ${x}`)
  return id
}
const tokens = (x: string | undefined) => (x ? x.split(',').filter(Boolean).map(token) : [])
const short = (id: Uint8Array) => bytes32ToEvmAddress(id) ?? bytesToHex(id)

/** A recipient on another chain: 0x + 20 bytes (an EVM address), 0x + 32
 * bytes, or a base58 key. */
function recipient(x: string): Uint8Array {
  if (/^0x/i.test(x)) {
    const b = hexToBytes(x)
    if (b.length !== 20 && b.length !== 32) throw new Error(`a recipient is 20 or 32 bytes, got ${b.length}`)
    return b
  }
  return new PublicKey(x).toBytes()
}

const sol = (lamports: bigint) => `${formatUnits(lamports, 9)} SOL`
const usd = (units: bigint) => `${formatUnits(units)} USDC`
const eth = (wei: bigint) => `${formatUnits(wei, 18)} ETH`

/* ------------------------------- the run ------------------------------ */

export async function runCli(argv: string[], io: CliIo): Promise<void> {
  const { command, opt } = parseArgs(argv)
  const say = io.out
  if (!command || opt.has('help')) throw new Error('usage: cli <status|balances|pending|quote|spawn|buy|sell|claim-fees|pull-fees|open|move|redeem|claim-parked|open-account> [options] — see the header of scripts/cli.ts')
  const need = (k: string) => {
    const v = opt.get(k)
    if (v === undefined) throw new Error(`--${k} is required for "${command}"`)
    return v
  }
  const cluster = (opt.get('cluster') ?? 'devnet') as Cluster
  const send = opt.has('send')
  if (send && cluster === 'mainnet-beta' && !opt.has('confirm-mainnet')) {
    throw new Error('mainnet-beta: look at the dry run first, then add --confirm-mainnet to send')
  }
  const signer = opt.get('keypair') ? io.loadKeypair(opt.get('keypair')!) : null
  const owner = signer?.publicKey ?? (opt.get('owner') ? new PublicKey(opt.get('owner')!) : null)
  if (send && !signer) throw new Error('--send needs --keypair')
  if (send && !io.send) throw new Error('this run cannot send')

  const programId = opt.get('program-id') ? new PublicKey(opt.get('program-id')!) : undefined
  const client = await GatewayClient.load(io.rpc, {
    programId,
    microLamportsPerCu: opt.get('priority') ? Number(opt.get('priority')) : undefined,
  })
  const s = client.store
  const me = () => {
    if (!owner) throw new Error(`"${command}" needs --keypair (or --owner KEY for a dry run)`)
    return owner
  }

  /* ------------------------------ reading ----------------------------- */

  /** What each message costs right now (simulated `quote_send`). */
  async function quotes(): Promise<void> {
    // any funded account can pay a simulation; the tank always exists
    const payer = owner ?? client.pdas.gasTank
    const q = async (what: string, p: QuoteSendParams, legs: number, route: PublicKey | null = null) => {
      const tx = assembleV0({
        payer,
        instructions: [quoteSendIx(client.context, p, payer, route)],
        recentBlockhash: await io.rpc.latestBlockhash(),
        lookupTables: client.table ? [client.table] : [],
        computeUnits: 700_000,
      })
      const r = await io.rpc.simulate(tx)
      const fee = !r.err && r.returnData && r.returnData.length >= 8 ? sol(readUintLE(r.returnData, 0, 8)) : `unavailable (${JSON.stringify(r.err)})`
      say(`  ${what.padEnd(26)} ${fee}   (${legs} leg${legs === 1 ? '' : 's'} = ${eth(s.returnUnit * BigInt(legs))} of reply budget)`)
    }
    const none = { name: '', symbol: '', metaUri: '', withDevBuy: false, dstChain: 0 }
    say('fees right now:')
    await q('buy / sell / claim / pull', { op: OP.BUY, ...none }, s.tradeLegs)
    await q('spawn (short strings)', { op: OP.SPAWN, ...none, name: 'NAME', symbol: 'SYM' }, s.spawnLegs)
    await q('spawn + dev buy', { op: OP.SPAWN, ...none, name: 'NAME', symbol: 'SYM', withDevBuy: true }, s.spawnLegs + s.tradeLegs)
    await q('open', { op: OP.OPEN, ...none }, s.openLegs)
    for (const [label, name] of NAME_OF_LABEL) {
      if (label === CHAIN_LABEL.hub || label === CHAIN_LABEL.solana) continue
      const route = await client.moveRoute(label)
      if (!route || route.legs === 0) {
        say(`  ${`move → ${name}`.padEnd(26)} closed (no price set)`)
        continue
      }
      const legs = Math.max(route.legs, s.tradeLegs)
      await q(`move → ${name}`, { op: OP.MOVE, ...none, dstChain: label }, legs, client.pdas.moveRoute(label))
    }
  }

  async function status(): Promise<void> {
    say(`gateway ${client.pdas.programId.toBase58()} on ${cluster}`)
    say(`  store        ${client.pdas.store.toBase58()}  (${bytesToHex(client.pdas.store.toBytes())})`)
    say(`  state        ${s.paused ? 'PAUSED (no spawn, buy or open; exits stay open)' : 'open'}${s.sponsored ? ', SPONSORED (the tank pays every send)' : ''}`)
    say(`  admin        ${s.admin.toBase58()}${s.pendingAdmin.equals(PublicKey.default) ? '' : `  (nominee ${s.pendingAdmin.toBase58()})`}`)
    say(`  operator     ${s.operator.toBase58()}`)
    say(`  guardian     ${s.guardian.toBase58()}`)
    say(`  hub          eid ${s.hubEid}, pad ${bytesToHex(s.hubPad)}, adapter ${bytesToHex(client.peerAddress)}`)
    say(`  verifiers    ${client.path.uln.requiredDvnCount} required + ${client.path.uln.optionalDvnThreshold} of ${client.path.uln.optionalDvnCount} optional, ${client.path.uln.confirmations} confirmations`)
    say(`  prices       gas to hub ${s.gasToHub}, reply unit ${eth(s.returnUnit)}; legs: trade ${s.tradeLegs}, spawn ${s.spawnLegs}, open ${s.openLegs}`)
    const vault = await client.vaultBalance()
    say(`  vault        ${usd(vault)} of a ${usd(s.depositCap)} cap; owed: claims ${usd(s.claimsTotal)}, fee pool ${usd(s.poolTotal)}${vault >= s.claimsTotal + s.poolTotal ? '' : '  ← SHORT: payouts become claims'}`)
    say(`  tank         ${sol(await client.tankBalance())}  (rent of what a hub message creates: a replica ${sol((await io.rpc.rent(201)) + (await io.rpc.rent(82)))}, a stranger's account ${sol(await io.rpc.rent(245))})`)
    say(`  lookup table ${client.table ? `${client.table.key.toBase58()} (${client.table.state.addresses.length} addresses, ${client.table.state.authority ? `authority ${client.table.state.authority.toBase58()}` : 'frozen'})` : 'NONE — sends will not fit a transaction'}`)
    for (const [label, name] of NAME_OF_LABEL) {
      if (label === CHAIN_LABEL.hub || label === CHAIN_LABEL.solana) continue
      const route = await client.moveRoute(label)
      const peer = await client.cctpPeer(label)
      const domain = (CCTP_DOMAIN as Record<string, number>)[name]
      say(
        `  → ${name.padEnd(9)} move: ${route && route.legs ? `${Math.max(route.legs, s.tradeLegs)} legs` : 'closed'};  CCTP peer: ${
          peer ? `${bytesToHex(peer.vault)} (domain ${peer.domain})` : domain === undefined ? 'n/a (no Circle USDC there)' : 'none'
        }`,
      )
    }
    await quotes()
  }

  async function balances(pendingOnly: boolean): Promise<void> {
    const who = me()
    const [acc] = await io.rpc.getAccounts([who])
    const ua = await client.userAccount(who)
    const vault = await client.vaultBalance()
    if (!pendingOnly) {
      say(`${who.toBase58()}`)
      say(`  SOL    ${sol(BigInt(acc?.lamports ?? 0))}`)
      say(`  USDC   ${usd(await client.tokenBalance(who, s.usdcMint))}`)
    }
    let waiting = 0
    if (!ua) say(pendingOnly ? '' : '  no user account here yet (the first send opens it)')
    if (ua && ua.usdClaim > 0n) {
      waiting++
      const can = ua.usdClaim <= vault
      say(`  claim  ${usd(ua.usdClaim)} — ${can ? `redeemable now:  cli redeem --usdc ${formatUnits(ua.usdClaim)}` : `the vault holds ${usd(vault)}: redeem that much, wait, or move it:  cli move --to-chain … --to 0x… --usdc …`}`)
    }
    const listed = tokens(opt.get('token'))
    const parkedIds = (ua?.parked ?? []).map((p) => p.hubToken)
    const all = [...new Map([...listed, ...parkedIds].map((t) => [bytesToHex(t), t])).values()]
    for (const t of all) {
      const replica = await client.replica(t)
      const parked = ua?.parked.find((p) => bytesToHex(p.hubToken) === bytesToHex(t))
      if (!replica) {
        const rent = await client.openRent(t)
        say(`  ${short(t)}  not open on this chain${parked ? ` — ${formatUnits(parked.amountE18, 18)} tokens parked behind it` : ''}:  cli open --token ${short(t)}   (rent still due: ${sol(rent)})`)
        if (parked) waiting++
        continue
      }
      const bag = await client.tokenBalance(who, replica.mint)
      const pos = await client.position(t, who)
      const earned = pos ? claimableRewards(pos, replica) : 0n
      if (!pendingOnly) say(`  ${short(t)}  ${replica.symbol}: ${formatUnits(bag)} held, ${formatUnits(pos?.staked ?? 0n)} staked`)
      if (parked) {
        waiting++
        say(`  ${short(t)}  ${formatUnits(parkedUnits(parked, replica))} ${replica.symbol} parked:  cli claim-parked --token ${short(t)}`)
      }
      if (earned > 0n) {
        waiting++
        say(`  ${short(t)}  ${usd(earned)} of holder fees earned (claim_rewards)`)
      }
    }
    if (pendingOnly && waiting === 0) say('nothing is waiting')
  }

  /* ------------------------------ sending ----------------------------- */

  async function finish(what: string, tx: VersionedTransaction, built?: BuiltSend): Promise<void> {
    if (opt.has('tx')) say(`  unsigned transaction (base64): ${Buffer.from(tx.serialize()).toString('base64')}`)
    if (!send) {
      const r = await io.rpc.simulate(tx)
      if (r.err) {
        say(`  simulation: FAILS — ${JSON.stringify(r.err)}`)
        r.logs.slice(-6).forEach((l) => say(`    ${l}`))
      } else {
        say(`  simulation: ok, ${r.unitsConsumed ?? '?'} compute units`)
      }
      say(`DRY RUN — nothing was sent. Add --send to sign and send this ${what}.`)
      return
    }
    const { signature, logs } = await io.send!(tx, signer!)
    say(`  sent: ${signature}`)
    const ev = built ? findSentToHub(logs) : null
    if (ev) say(`  LayerZero charged ${sol(ev.nativeFee)}${ev.sponsored ? ' (refunded by the tank)' : ''}; ${ev.legs} repl${ev.legs === 1 ? 'y' : 'ies'} prepaid`)
    if (built) say(`  follow it: https://${cluster === 'mainnet-beta' ? '' : 'testnet.'}layerzeroscan.com/tx/${signature}`)
  }

  async function message<P>(what: string, spec: SendSpec<P>, params: P, lines: string[]): Promise<void> {
    const max = opt.get('max-fee')
    const built = await client.buildSend(spec, me(), params, max === undefined ? {} : { maxNativeFee: BigInt(max) })
    say(`${what}`)
    lines.forEach((l) => say(`  ${l}`))
    say(`  fee          ${max === undefined ? `${sol(built.quotedFee)} quoted, ceiling ${sol(built.maxNativeFee)}` : `ceiling ${sol(built.maxNativeFee)} (not quoted)`}`)
    say(`  reply budget ${built.legs} leg${built.legs === 1 ? '' : 's'} × ${eth(s.returnUnit)} = ${eth(built.value)}, in the executor option and in the envelope`)
    say(`  message      ${bytesToHex(built.message)}`)
    say(`  transaction  ${built.size} bytes (limit 1232)`)
    if (s.paused && (spec.name === 'spawn_token' || spec.name === 'buy_token' || spec.name === 'open_token')) say('  NOTE: the store is paused — this will be refused')
    await finish(what.split(' ')[0], built.tx, built)
  }

  switch (command) {
    case 'status':
      return status()
    case 'quote':
      return quotes()
    case 'balances':
      return balances(false)
    case 'pending':
      return balances(true)

    case 'spawn': {
      const p = {
        name: need('name'),
        symbol: need('symbol'),
        metaUri: opt.get('meta') ?? '',
        devBuyUsdc: parseUnits(opt.get('dev-buy') ?? '0'),
        feeMode: Number(opt.get('fee-mode') ?? 0),
      }
      return message(`spawn "${p.name}" (${p.symbol}), fee mode ${p.feeMode}`, SENDS.spawn_token, p, [
        p.devBuyUsdc > 0n ? `dev buy      ${usd(p.devBuyUsdc)} into the vault (the bag is parked until the SYNC lands: cli claim-parked)` : 'no dev buy',
      ])
    }
    case 'buy': {
      const p = { hubToken: token(need('token')), usdcIn: parseUnits(need('usdc')), minTokensOut: minimum(need('min-tokens')) }
      return message(`buy ${short(p.hubToken)} with ${usd(p.usdcIn)}`, SENDS.buy_token, p, [
        `minimum      ${formatUnits(p.minTokensOut)} tokens — the hub fills for at least that, or sends every dollar home`,
      ])
    }
    case 'sell': {
      const p = { hubToken: token(need('token')), amount: parseUnits(need('tokens')), minUsdcOut: minimum(need('min-usdc')) }
      return message(`sell ${formatUnits(p.amount)} of ${short(p.hubToken)}`, SENDS.sell_token, p, [
        `minimum      ${usd(p.minUsdcOut)} net — under it the hub delivers the bag back`,
      ])
    }
    case 'claim-fees':
      return message(`claim-fees of ${short(token(need('token')))} (the creator's share)`, SENDS.claim_fees, { hubToken: token(need('token')) }, [])
    case 'pull-fees':
      return message(`pull-fees of ${short(token(need('token')))} (this chain's holder fees, into the token's pool)`, SENDS.pull_fees, { hubToken: token(need('token')) }, [])
    case 'open': {
      const t = token(need('token'))
      if (await client.replica(t)) throw new Error(`${short(t)} is already open on this chain`)
      return message(`open ${short(t)} on this chain`, SENDS.open_token, { hubToken: t }, [
        `rent         ${sol(await client.openRent(t))} left at the replica's two addresses for the hub's SYNC (on top of the fee)`,
        'the hub answers only for a token it spawned, and only if the SYNC costs it no more than its ceiling for this chain',
      ])
    }
    case 'move': {
      const p = { dstChain: chainLabel(need('to-chain')), to: recipient(need('to')), units: parseUnits(need('usdc')) }
      const ua = await client.userAccount(me())
      return message(`move ${usd(p.units)} of claim to chain ${p.dstChain} (${NAME_OF_LABEL.get(p.dstChain) ?? 'unnamed'})`, SENDS.move_claim, p, [
        `recipient    ${bytesToHex(p.to)}`,
        `claim        ${usd(ua?.usdClaim ?? 0n)} held here${(ua?.usdClaim ?? 0n) < p.units ? '  ← NOT ENOUGH: this will be refused' : ''}`,
        'if the hub cannot hand it on, it comes back here as USDC or as the same claim',
      ])
    }

    case 'redeem': {
      const units = parseUnits(need('usdc'))
      say(`redeem ${usd(units)} of claim (the vault holds ${usd(await client.vaultBalance())})`)
      return finish('redemption', await client.redeemClaim(me(), units))
    }
    case 'claim-parked': {
      const t = token(need('token'))
      say(`claim the delivery of ${short(t)} parked for ${me().toBase58()}`)
      return finish('claim', await client.claimParked(me(), t))
    }
    case 'open-account': {
      const forWhom = opt.get('for') ? new PublicKey(opt.get('for')!) : me()
      say(`open the user account of ${forWhom.toBase58()} (paid by ${me().toBase58()})`)
      return finish('account opening', await client.openUserAccount(me(), forWhom))
    }
    default:
      throw new Error(`unknown command "${command}"`)
  }

  /** A trade's minimum: a decimal amount, or "any" (one unit). */
  function minimum(x: string): bigint {
    return x === 'any' ? ANY_FILL : parseUnits(x)
  }
}

/* -------------------------------- main -------------------------------- */

async function main() {
  const argv = process.argv.slice(2)
  const { opt } = parseArgs(argv)
  const cluster = (opt.get('cluster') ?? 'devnet') as Cluster
  if (!CLUSTERS[cluster]) throw new Error(`unknown cluster ${cluster}`)
  const conn = new Connection(opt.get('rpc') ?? CLUSTERS[cluster].rpc, 'confirmed')
  await runCli(argv, {
    rpc: connectionRpc(conn),
    out: (l) => console.log(l),
    loadKeypair: (file) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8')))),
    async send(tx, signer) {
      tx.sign([signer])
      const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false })
      const bh = await conn.getLatestBlockhash('confirmed')
      const r = await conn.confirmTransaction({ signature, ...bh }, 'confirmed')
      if (r.value.err) throw new Error(`failed: ${JSON.stringify(r.value.err)} (${signature})`)
      const t = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      return { signature, logs: t?.meta?.logMessages ?? [] }
    },
  })
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
