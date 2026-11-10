/**
 * Phase-1 smoke: initialize the gateway config, ping it twice, and prove the
 * Pinged event lands in the transaction logs.
 *
 *   RPC=http://127.0.0.1:8899 node app/smoke.cjs      # localnet
 *   RPC=https://api.devnet.solana.com node app/smoke.cjs
 */
const fs = require('fs')
const path = require('path')
const anchor = require('@anchor-lang/core')
const { Connection, Keypair, PublicKey, SystemProgram } = anchor.web3

const RPC = process.env.RPC ?? 'http://127.0.0.1:8899'
const HUB_EID = 40245 // Base Sepolia — our hub
const HUB_PAD = 'c3630fa49B564031669A0c147509620AE2fB1C77' // v3 pad, left-padded below

async function main() {
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'target', 'idl', 'spawn_gateway.json'), 'utf8'))
  const key = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.keys', 'devnet.json'), 'utf8'))),
  )
  const connection = new Connection(RPC, 'confirmed')
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(key), { commitment: 'confirmed' })
  const program = new anchor.Program(idl, provider)
  console.log('cluster :', RPC)
  console.log('program :', program.programId.toBase58())
  console.log('payer   :', key.publicKey.toBase58())

  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId)
  const hubAddress = Array.from(Buffer.concat([Buffer.alloc(12), Buffer.from(HUB_PAD, 'hex')]))

  const existing = await connection.getAccountInfo(config)
  if (!existing) {
    const sig = await program.methods
      .initialize(HUB_EID, hubAddress)
      .accounts({ admin: key.publicKey, config, systemProgram: SystemProgram.programId })
      .rpc()
    console.log('initialize ✓', sig)
  } else {
    console.log('initialize — config already exists, skipping')
  }

  const sig = await program.methods.ping().accounts({ by: key.publicKey, config }).rpc()
  console.log('ping ✓', sig)

  // proof: decode the Pinged event straight from the transaction logs
  const tx = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(idl))
  let seen = false
  for (const ev of parser.parseLogs(tx.meta.logMessages)) {
    if (ev.name !== 'pinged' && ev.name !== 'Pinged') continue
    seen = true
    console.log(`event   : Pinged { by: ${ev.data.by.toBase58()}, seq: ${ev.data.seq}, hubEid: ${ev.data.hubEid ?? ev.data.hub_eid} }`)
  }
  if (!seen) throw new Error('Pinged event not found in logs')

  const cfg = await program.account.config.fetch(config)
  console.log(`config  : admin=${cfg.admin.toBase58().slice(0, 8)}… hubEid=${cfg.hubEid} pings=${cfg.pings}`)
  console.log('SMOKE_OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
