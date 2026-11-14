// Snapshots Circle's REAL CCTP V2 programs and state from Solana mainnet into
// tests/fixtures/mainnet/ so the tests can run the vault's outbound leg
// (`rebalance` -> TokenMessengerMinterV2.deposit_for_burn) locally under
// LiteSVM: the two programs (solana program dump) and the state accounts a
// burn of USDC toward an EVM domain reads. Read-only RPC; no key is used.
// Called by fetch-fixtures.sh (mainnet only).
//
//   node fetch-cctp.cjs
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { Connection, PublicKey } = require('@solana/web3.js')

const URL = process.env.SOL_RPC ?? 'https://api.mainnet-beta.solana.com'
// Same ids on mainnet-beta and devnet (developers.circle.com/cctp/solana-programs).
const MESSAGE_TRANSMITTER = new PublicKey('CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC')
const TOKEN_MESSENGER_MINTER = new PublicKey('CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe')
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
// The EVM chains of the universe that settle in Circle USDC, by CCTP domain.
const DOMAINS = { ethereum: 0, optimism: 2, arbitrum: 3, base: 6 }

const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const conn = new Connection(URL, 'confirmed')
  const dir = path.join(__dirname, 'fixtures', 'mainnet')
  fs.mkdirSync(dir, { recursive: true })
  const get = async (pubkey) => {
    for (let i = 0; ; i++) {
      try {
        return await conn.getAccountInfo(pubkey)
      } catch (e) {
        if (i >= 5) throw e
        await sleep(1500 * (i + 1)) // public RPC rate limit
      }
    }
  }

  const wanted = [
    ['message_transmitter', pda([Buffer.from('message_transmitter')], MESSAGE_TRANSMITTER), MESSAGE_TRANSMITTER],
    ['token_messenger', pda([Buffer.from('token_messenger')], TOKEN_MESSENGER_MINTER), TOKEN_MESSENGER_MINTER],
    ['token_minter', pda([Buffer.from('token_minter')], TOKEN_MESSENGER_MINTER), TOKEN_MESSENGER_MINTER],
    ['local_token_usdc', pda([Buffer.from('local_token'), USDC_MINT.toBuffer()], TOKEN_MESSENGER_MINTER), TOKEN_MESSENGER_MINTER],
  ]
  for (const [name, domain] of Object.entries(DOMAINS)) {
    wanted.push([
      `remote_token_messenger_${name}`,
      pda([Buffer.from('remote_token_messenger'), Buffer.from(String(domain))], TOKEN_MESSENGER_MINTER),
      TOKEN_MESSENGER_MINTER,
    ])
  }

  const accounts = []
  for (const [name, pubkey, owner] of wanted) {
    const info = await get(pubkey)
    if (!info) throw new Error(`${name} (${pubkey.toBase58()}) missing on mainnet — wrong seeds?`)
    if (!info.owner.equals(owner)) throw new Error(`${name} is owned by ${info.owner.toBase58()}, not ${owner.toBase58()}`)
    accounts.push({
      name,
      pubkey: pubkey.toBase58(),
      owner: info.owner.toBase58(),
      lamports: info.lamports,
      data_b64: info.data.toString('base64'),
    })
    console.log(`✓ ${name} ${pubkey.toBase58()} (${info.data.length} bytes)`)
    await sleep(250)
  }

  const programs = [
    { name: 'cctp_message_transmitter_v2', id: MESSAGE_TRANSMITTER.toBase58(), file: 'cctp_message_transmitter_v2.so' },
    { name: 'cctp_token_messenger_minter_v2', id: TOKEN_MESSENGER_MINTER.toBase58(), file: 'cctp_token_messenger_minter_v2.so' },
  ]
  fs.writeFileSync(path.join(dir, 'cctp.json'), JSON.stringify({ domains: DOMAINS, programs, accounts }, null, 1))

  for (const p of programs) {
    const file = path.join(dir, p.file)
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      console.log(`  ${p.file} already present`)
      continue
    }
    for (let i = 0; ; i++) {
      try {
        execFileSync('solana', ['program', 'dump', p.id, file, '--url', URL], { stdio: 'pipe' })
        console.log(`  dumped ${p.name} (${p.id}) — ${fs.statSync(file).size} bytes`)
        break
      } catch (e) {
        if (i >= 4) throw new Error(`dump of ${p.id} failed: ${e.stderr?.toString() ?? e.message}`)
        await sleep(3000 * (i + 1))
      }
    }
  }
  console.log('CCTP_FIXTURES_OK', dir)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
