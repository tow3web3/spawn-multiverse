// Snapshots the LayerZero devnet STATE accounts the local quote/send path
// reads, into tests/fixtures/accounts.json. Called by fetch-fixtures.sh.
const fs = require('fs')
const path = require('path')
const { Connection, PublicKey } = require('@solana/web3.js')

const URL = 'https://api.devnet.solana.com'
const HUB_EID = 40245 // Base Sepolia — our hub

const ENDPOINT = new PublicKey('76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6')
const ULN = new PublicKey('7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH')
const EXECUTOR = new PublicKey('6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn')
const PRICEFEED = new PublicKey('8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP')
const DVN = new PublicKey('HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW')

const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0]
const eidBe = Buffer.alloc(4)
eidBe.writeUInt32BE(HUB_EID)

async function main() {
  const conn = new Connection(URL)
  const msglib = pda([Buffer.from('MessageLib')], ULN)
  const wanted = [
    ['endpoint_settings', pda([Buffer.from('Endpoint')], ENDPOINT)],
    ['default_send_library_config', pda([Buffer.from('SendLibraryConfig'), eidBe], ENDPOINT)],
    ['message_lib_info', pda([Buffer.from('MessageLib'), msglib.toBuffer()], ENDPOINT)],
    // ULN_SEED == MESSAGE_LIB_SEED: the UlnSettings PDA IS the msglib PDA.
    ['uln_settings', msglib],
    ['default_send_config', pda([Buffer.from('SendConfig'), eidBe], ULN)],
    ['executor_config', pda([Buffer.from('ExecutorConfig')], EXECUTOR)],
    ['price_feed', pda([Buffer.from('PriceFeed')], PRICEFEED)],
    ['dvn_config', pda([Buffer.from('DvnConfig')], DVN)],
  ]
  const out = []
  for (const [name, pubkey] of wanted) {
    const info = await conn.getAccountInfo(pubkey)
    if (!info) throw new Error(`${name} (${pubkey.toBase58()}) missing on devnet`)
    out.push({
      name,
      pubkey: pubkey.toBase58(),
      owner: info.owner.toBase58(),
      lamports: info.lamports,
      data_b64: info.data.toString('base64'),
    })
    console.log(`✓ ${name} ${pubkey.toBase58()} (${info.data.length} bytes)`)
  }
  const file = path.join(__dirname, 'fixtures', 'accounts.json')
  fs.writeFileSync(file, JSON.stringify(out, null, 1))
  console.log(`wrote ${file}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
