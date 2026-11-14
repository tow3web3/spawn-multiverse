/**
 * Wires a deployed gateway — V7.md §6 steps 2–10 — on devnet or mainnet-beta.
 * Every step reads the chain first and sends only what is missing, so a
 * re-run after a failure picks up where it stopped. `--dry-run` prints every
 * transaction it would send (instructions, accounts, size) and sends nothing.
 *
 *   npm run wire -- --cluster devnet --hub-eid 40245 \
 *     --hub-pad 0x… --hub-adapter 0x… --admin-keypair <file> \
 *     --verifiers default --spawn-legs 3 --tank-sol 0.3 [--dry-run]
 *
 * Hub addresses are always parameters (the ones in V7.md belong to a
 * retired deployment). Mainnet-beta without --dry-run also needs
 * --confirm-mainnet.
 *
 * Options (defaults in brackets):
 *   --cluster devnet|mainnet-beta|localnet   --rpc <url> [cluster default]
 *   --program-id <key> [3myp…H95g]           --usdc-mint <key> [Circle USDC of the cluster]
 *   --hub-eid <n> --hub-pad <0x…> --hub-adapter <0x…>        (required)
 *   --admin-keypair <file> | --admin <key> (dry run only)
 *   --verifiers ours|default|<req,req>/<opt,opt>/<threshold>  [ours on mainnet-beta; required elsewhere]
 *   --send-confirmations [32] --receive-confirmations [10]
 *   --operator <key> --guardian <key>
 *   --gas-to-hub [4600000] --return-unit-wei [350000000000000] --trade-legs [1] --spawn-legs (required)
 *   --deposit-cap-usdc [0] --no-pause --tank-sol [0.3]
 *   --new-admin <key> [--new-admin-keypair <file>]  --table <key>  --only <step-ids,…>
 */
import * as fs from 'fs'
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Signer,
  TransactionInstruction,
} from '@solana/web3.js'
import {
  CLUSTERS,
  Cluster,
  MAINNET_DVNS,
  StepSender,
  VerifierSet,
  WiringParams,
  assembleV0,
  connectionRpc,
  describeIx,
  parseUnits,
  runWiring,
  toBytes32,
  txSize,
} from '../app/src'

function args(argv: string[]) {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
    const k = a.slice(2)
    if (['dry-run', 'no-pause', 'confirm-mainnet'].includes(k)) out.set(k, 'true')
    else {
      const v = argv[++i]
      if (v === undefined) throw new Error(`--${k} needs a value`)
      out.set(k, v)
    }
  }
  return out
}

const keypair = (file: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))))

function verifierSet(spec: string | undefined, cluster: Cluster): VerifierSet | null {
  const s = spec ?? (cluster === 'mainnet-beta' ? 'ours' : undefined)
  if (!s) throw new Error('--verifiers is required off mainnet (the mainnet DVN addresses do not exist elsewhere): "default" or "<req,…>/<opt,…>/<threshold>"')
  if (s === 'default') return null
  if (s === 'ours') {
    if (cluster !== 'mainnet-beta') throw new Error('"ours" names MAINNET DVN accounts; give the devnet ones explicitly')
    return { required: [MAINNET_DVNS.layerZeroLabs, MAINNET_DVNS.google], optional: [MAINNET_DVNS.horizen, MAINNET_DVNS.twinstake], threshold: 1 }
  }
  const [req, opt, th] = s.split('/')
  const keys = (x: string | undefined) => (x ? x.split(',').filter(Boolean).map((k) => new PublicKey(k)) : [])
  return { required: keys(req), optional: keys(opt), threshold: Number(th ?? 0) }
}

async function main() {
  const a = args(process.argv.slice(2))
  const need = (k: string) => {
    const v = a.get(k)
    if (v === undefined) throw new Error(`--${k} is required`)
    return v
  }
  const cluster = need('cluster') as Cluster
  if (!CLUSTERS[cluster]) throw new Error(`unknown cluster ${cluster}`)
  const dryRun = a.has('dry-run')
  if (cluster === 'mainnet-beta' && !dryRun && !a.has('confirm-mainnet')) {
    throw new Error('mainnet-beta: run with --dry-run first, then add --confirm-mainnet to send')
  }
  const adminKey = a.get('admin-keypair') ? keypair(a.get('admin-keypair')!) : null
  const admin = adminKey?.publicKey ?? (a.get('admin') ? new PublicKey(a.get('admin')!) : null)
  if (!admin) throw new Error('--admin-keypair is required (or --admin <key> with --dry-run)')
  if (!adminKey && !dryRun) throw new Error('sending needs --admin-keypair')
  const newAdminKey = a.get('new-admin-keypair') ? keypair(a.get('new-admin-keypair')!) : undefined
  const key = (k: string) => (a.get(k) ? new PublicKey(a.get(k)!) : undefined)

  const p: WiringParams = {
    cluster,
    programId: key('program-id'),
    hubEid: Number(need('hub-eid')),
    hubPad: toBytes32(need('hub-pad')),
    hubAdapter: toBytes32(need('hub-adapter')),
    usdcMint: key('usdc-mint') ?? CLUSTERS[cluster].usdcMint,
    admin,
    verifiers: verifierSet(a.get('verifiers'), cluster),
    sendConfirmations: BigInt(a.get('send-confirmations') ?? 32),
    receiveConfirmations: BigInt(a.get('receive-confirmations') ?? 10),
    operator: key('operator'),
    guardian: key('guardian'),
    fee: {
      gasToHub: BigInt(a.get('gas-to-hub') ?? 4_600_000),
      returnUnit: BigInt(a.get('return-unit-wei') ?? 350_000_000_000_000n),
      tradeLegs: Number(a.get('trade-legs') ?? 1),
      spawnLegs: Number(need('spawn-legs')),
    },
    depositCap: parseUnits(a.get('deposit-cap-usdc') ?? '0'),
    leavePaused: !a.has('no-pause'),
    tankLamports: parseUnits(a.get('tank-sol') ?? '0.3', 9),
    newAdmin: key('new-admin') ?? newAdminKey?.publicKey,
    table: key('table'),
  }
  const url = a.get('rpc') ?? CLUSTERS[cluster].rpc
  const conn = new Connection(url, 'confirmed')
  const rpc = connectionRpc(conn)
  console.log(`cluster ${cluster} (${url})${dryRun ? ' — DRY RUN, nothing is sent' : ''}`)
  console.log(`admin ${admin.toBase58()}  hub eid ${p.hubEid}`)

  const sender: StepSender = {
    dryRun,
    async send(label: string, ixs: TransactionInstruction[], extra: Signer[] = [], tables: AddressLookupTableAccount[] = []) {
      const tx = assembleV0({ payer: admin, instructions: ixs, recentBlockhash: await rpc.latestBlockhash(), lookupTables: tables })
      console.log(`→ ${label}  (${txSize(tx)} bytes, ${ixs.length} instruction${ixs.length > 1 ? 's' : ''})`)
      if (dryRun) {
        ixs.forEach((ix) => console.log(describeIx(ix)))
        return
      }
      tx.sign([adminKey!, ...extra])
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false })
      const bh = await conn.getLatestBlockhash('confirmed')
      const r = await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed')
      if (r.value.err) throw new Error(`${label} failed: ${JSON.stringify(r.value.err)} (${sig})`)
      console.log(`  ✓ ${sig}`)
    },
    async settle() {
      if (dryRun) return
      const s = await conn.getSlot('confirmed')
      while ((await conn.getSlot('confirmed')) <= s + 1) await new Promise((r) => setTimeout(r, 400))
    },
  }
  const only = a.get('only')?.split(',')
  const state = await runWiring(p, rpc, sender, (l) => console.log(l), { only, newAdminSigner: newAdminKey })
  console.log(`\nlookup table: ${state.table?.toBase58() ?? 'none'}`)
  if (p.tankLamports) console.log(`tank target: ${Number(p.tankLamports) / LAMPORTS_PER_SOL} SOL`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
