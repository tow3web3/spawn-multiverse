/**
 * READ-ONLY: what the hub-side tooling needs to know about the Solana
 * gateway, through the gateway's own client (solana/app) — printed as ONE
 * line of JSON on stdout. Run by scripts/lib-solana.js → readSolana (status,
 * tune-fees, add-solana) with the Solana package's ts-node:
 *
 *   node -r <solana>/node_modules/ts-node/register contracts/scripts/solana-read.ts \
 *        --rpc https://api.devnet.solana.com [--program-id KEY] [--labels 2,3,4,5,6]
 *
 * Out: { ok: true, store, vault, vaultUsdc, claimsTotal, poolTotal,
 * usdDustE18, returnUnit, tradeLegs, spawnLegs, openLegs, moveLegs: {label:
 * legs}, paused, hubEid, hubPad, peer, hubUnit: {replicaRent,
 * userAccountRent, suggested}, tank } — every amount a decimal string (USDC
 * amounts in 6-decimal units, the return unit in hub-native wei, rents and
 * the tank in lamports) — or { ok: false, error }.
 */
import * as path from 'path'

// the client lives beside the program; its dependencies in solana/node_modules
const SOLANA_DIR = process.env.SPAWN_SOLANA_DIR ?? path.join(__dirname, '..', '..', 'solana')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const web3 = require(require.resolve('@solana/web3.js', { paths: [SOLANA_DIR] }))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require(path.join(SOLANA_DIR, 'app', 'src'))

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex')

async function main(): Promise<void> {
  const rpcUrl = arg('rpc')
  if (!rpcUrl) throw new Error('--rpc URL is required')
  const programId = arg('program-id') ? new web3.PublicKey(arg('program-id')) : undefined
  const labels = (arg('labels') ?? '2,3,4,5,6').split(',').map(Number)
  const conn = new web3.Connection(rpcUrl, 'confirmed')
  const client = await app.GatewayClient.load(app.connectionRpc(conn), { programId })
  const s = client.store
  const moveLegs: Record<string, number> = {}
  for (const l of labels) {
    const r = await client.moveRoute(l)
    moveLegs[String(l)] = r ? r.legs : 0
  }
  const unit = await client.hubUnit()
  const out = {
    ok: true,
    store: hex(client.pdas.store.toBytes()),
    vault: hex(s.vault.toBytes()),
    vaultUsdc: String(await client.vaultBalance()),
    claimsTotal: String(s.claimsTotal),
    poolTotal: String(s.poolTotal),
    usdDustE18: String(s.usdDustE18),
    returnUnit: String(s.returnUnit),
    tradeLegs: s.tradeLegs,
    spawnLegs: s.spawnLegs,
    openLegs: s.openLegs,
    moveLegs,
    paused: !!s.paused,
    hubEid: s.hubEid,
    hubPad: hex(s.hubPad),
    peer: hex(client.peerAddress),
    hubUnit: { replicaRent: String(unit.replicaRent), userAccountRent: String(unit.userAccountRent), suggested: String(unit.suggested) },
    tank: String(await client.tankBalance()),
  }
  process.stdout.write(JSON.stringify(out) + '\n')
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e) }) + '\n')
  process.exit(0)
})
