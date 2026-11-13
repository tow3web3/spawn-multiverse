// Snapshots the REAL LayerZero V2 stack of one Solana cluster into
// tests/fixtures/<cluster>/ so the integration tests can run it locally
// under LiteSVM: the state accounts (PDAs) the quote / send / receive paths
// read, and — discovered from that state, never hard-coded — every worker
// program they point at. Read-only RPC. Called by fetch-fixtures.sh.
//
//   node fetch-state.cjs mainnet     (default — hub = Base, eid 30184)
//   node fetch-state.cjs devnet      (hub = Base Sepolia, eid 40245)
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { Connection, PublicKey } = require('@solana/web3.js')

const CLUSTERS = {
  mainnet: { url: process.env.SOL_RPC ?? 'https://api.mainnet-beta.solana.com', hubEid: 30184 },
  devnet: { url: 'https://api.devnet.solana.com', hubEid: 40245 },
}
const cluster = process.argv[2] ?? 'mainnet'
const cfg = CLUSTERS[cluster]
if (!cfg) throw new Error(`unknown cluster ${cluster}`)

// Same program ids on mainnet and devnet (LayerZero metadata, `solana` /
// `solana-testnet`): https://metadata.layerzero-api.com/v1/metadata/deployments
const ENDPOINT = new PublicKey('76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6')
const ULN = new PublicKey('7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH')
const EXECUTOR = new PublicKey('6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn')
const PRICEFEED = new PublicKey('8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP')
// Circle's native USDC mint on Solana mainnet (developers.circle.com).
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
// The verifier set the EVM side runs (contracts/config/profiles.js), as
// DVN CONFIG accounts on Solana mainnet (LayerZero metadata /dvns, `solana`).
const OUR_DVNS = {
  'LayerZero Labs': '4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb',
  Google: 'F7gu9kLcpn4bSTZn183mhn2RXUuMy7zckdxJZdUjuALw',
  Horizen: 'HR9NQKK1ynW9NzgdM37dU5CBtqRHTukmbMKS7qkwSkHX',
  Twinstake: 'GPjyWr8vCotGuFubDpTxDxy9Vj1ZeEN4F2dwRmFiaGab',
}

const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0]
const eidBe = Buffer.alloc(4)
eidBe.writeUInt32BE(cfg.hubEid)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const conn = new Connection(cfg.url, 'confirmed')
  const dir = path.join(__dirname, 'fixtures', cluster)
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

  const msglib = pda([Buffer.from('MessageLib')], ULN)
  const wanted = [
    ['endpoint_settings', pda([Buffer.from('Endpoint')], ENDPOINT)],
    ['default_send_library_config', pda([Buffer.from('SendLibraryConfig'), eidBe], ENDPOINT)],
    ['default_receive_library_config', pda([Buffer.from('ReceiveLibraryConfig'), eidBe], ENDPOINT)],
    ['message_lib_info', pda([Buffer.from('MessageLib'), msglib.toBuffer()], ENDPOINT)],
    // ULN_SEED == MESSAGE_LIB_SEED: the UlnSettings PDA IS the msglib PDA.
    ['uln_settings', msglib],
    ['default_send_config', pda([Buffer.from('SendConfig'), eidBe], ULN)],
    ['default_receive_config', pda([Buffer.from('ReceiveConfig'), eidBe], ULN)],
    ['executor_config', pda([Buffer.from('ExecutorConfig')], EXECUTOR)],
    ['price_feed', pda([Buffer.from('PriceFeed')], PRICEFEED)],
  ]
  if (cluster === 'mainnet') wanted.push(['usdc_mint', USDC_MINT])

  const out = []
  const programs = new Map([
    ['endpoint', ENDPOINT],
    ['uln', ULN],
    ['executor', EXECUTOR],
    ['pricefeed', PRICEFEED],
  ])
  const snap = async (name, pubkey, extra = {}) => {
    const info = await get(pubkey)
    if (!info) throw new Error(`${name} (${pubkey.toBase58()}) missing on ${cluster}`)
    out.push({
      name,
      pubkey: pubkey.toBase58(),
      owner: info.owner.toBase58(),
      lamports: info.lamports,
      data_b64: info.data.toString('base64'),
      ...extra,
    })
    console.log(`✓ ${name} ${pubkey.toBase58()} (${info.data.length} bytes, owner ${info.owner.toBase58()})`)
    return info
  }
  let sendCfg
  for (const [name, pubkey] of wanted) {
    const info = await snap(name, pubkey)
    if (name === 'default_send_config') sendCfg = info.data
    await sleep(250)
  }

  // SendConfig: disc(8) bump(1) UlnConfig{confirmations u64, required/optional
  // counts + threshold u8×3, required_dvns Vec<Pubkey>, optional_dvns
  // Vec<Pubkey>} ExecutorConfig{max_message_size u32, executor Pubkey}
  let off = 8 + 1 + 8 + 3
  const readVec = () => {
    const n = sendCfg.readUInt32LE(off)
    off += 4
    const v = []
    for (let i = 0; i < n; i++, off += 32) v.push(new PublicKey(sendCfg.subarray(off, off + 32)))
    return v
  }
  const required = readVec()
  const optional = readVec()
  console.log(`default send config -> eid ${cfg.hubEid}: ${required.length} required DVN(s), ${optional.length} optional`)

  // every DVN the default config names, plus our own set — each is a DVN
  // CONFIG account owned by its own DVN program
  const dvns = new Map()
  required.forEach((k, i) => dvns.set(k.toBase58(), `default_required_${i}`))
  optional.forEach((k, i) => dvns.set(k.toBase58(), dvns.get(k.toBase58()) ?? `default_optional_${i}`))
  if (cluster === 'mainnet') {
    for (const [name, addr] of Object.entries(OUR_DVNS)) dvns.set(addr, `${dvns.get(addr) ?? 'extra'}|${name}`)
  }
  let n = 0
  for (const [addr, label] of dvns) {
    const info = await snap(`dvn_config_${n}`, new PublicKey(addr), { dvn: label })
    programs.set(`dvn_${info.owner.toBase58()}`, info.owner)
    n++
    await sleep(250)
  }

  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(out, null, 1))
  const progList = [...programs].map(([name, id]) => ({ name, id: id.toBase58(), file: `${name}.so` }))
  fs.writeFileSync(path.join(dir, 'programs.json'), JSON.stringify(progList, null, 1))
  console.log(`wrote ${out.length} accounts; ${progList.length} programs to dump`)

  for (const p of progList) {
    const file = path.join(dir, p.file)
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      console.log(`  ${p.file} already present`)
      continue
    }
    for (let i = 0; ; i++) {
      try {
        execFileSync('solana', ['program', 'dump', p.id, file, '--url', cfg.url], { stdio: 'pipe' })
        console.log(`  dumped ${p.name} (${p.id}) — ${fs.statSync(file).size} bytes`)
        break
      } catch (e) {
        if (i >= 4) throw new Error(`dump of ${p.id} failed: ${e.stderr?.toString() ?? e.message}`)
        await sleep(3000 * (i + 1))
      }
    }
  }
  console.log('FIXTURES_OK', dir)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
