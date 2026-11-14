/**
 * Mainnet FORKS for rehearsals: several anvil forks at once, and a RELAY that
 * carries LayerZero packets between them through the REAL EndpointV2 of each
 * chain — the one thing separate forks cannot do by themselves.
 *
 * What the relay does, per packet the source endpoint emitted (PacketSent):
 *   1. on the destination fork, IMPERSONATES the adapter's pinned RECEIVE
 *      LIBRARY (ULN302) and calls `endpoint.verify(origin, receiver,
 *      keccak256(guid ‖ message))` — the step the DVNs' signatures unlock on
 *      a live chain. This is the one shortcut: the verifier set is configured
 *      and cross-checked on both ends, but no DVN signs anything on a fork.
 *   2. calls `endpoint.lzReceive{value}(origin, receiver, guid, message, "")`
 *      exactly as LayerZero's executor does: with the native value and the
 *      gas the packet's own executor option bought (the tx gas is that limit
 *      plus the intrinsic cost, so a message that needs more than its sender
 *      paid for runs out of gas here as it would on the chain).
 * Every delivery is recorded (op, chains, gas used, success), which is how
 * the rehearsal measures what each op really costs on each chain.
 *
 * Nothing is ever sent to a live chain: anvil only READS its upstream.
 */
const { spawn } = require('child_process')
const { ethers } = require('ethers')
const FORKS = require('../config/forks')

const coder = ethers.AbiCoder.defaultAbiCoder()
const EP_IFACE = new ethers.Interface([
  'event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)',
  'function getReceiveLibrary(address receiver, uint32 srcEid) view returns (address lib, bool isDefault)',
  'function verify((uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver, bytes32 payloadHash)',
  'function lzReceive((uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver, bytes32 guid, bytes message, bytes extraData) payable',
  'function inboundPayloadHash(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce) view returns (bytes32)',
])
const PACKET_SENT = EP_IFACE.getEvent('PacketSent').topicHash
const EXECUTOR = ethers.getAddress(ethers.dataSlice(ethers.id('spawn/fork/executor'), 12))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------- raw JSON-RPC ------------------------------- */

async function rpc(url, method, params = [], ms = 60_000) {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: c.signal,
    })
    const j = await r.json()
    if (j.error) {
      const e = new Error(`${method}: ${j.error.message}`)
      e.data = j.error.data
      throw e
    }
    return j.result
  } finally {
    clearTimeout(t)
  }
}

/** Sends a transaction as `from` (impersonated) and waits for its receipt —
 * raw calls end to end (ethers' waitForTransaction was seen hanging on anvil). */
async function sendAs(url, from, tx) {
  await rpc(url, 'anvil_impersonateAccount', [from])
  const bal = BigInt(await rpc(url, 'eth_getBalance', [from, 'latest']))
  const need = BigInt(tx.value ?? 0) + ethers.parseEther('1')
  if (bal < need) await rpc(url, 'anvil_setBalance', [from, ethers.toQuantity(need + ethers.parseEther('1'))])
  const hash = await rpc(url, 'eth_sendTransaction', [{ from, ...tx }])
  for (let i = 0; i < 600; i++) {
    const rc = await rpc(url, 'eth_getTransactionReceipt', [hash])
    if (rc) return rc
    await sleep(100)
  }
  throw new Error(`transaction ${hash} not mined`)
}

/* --------------------------------- forks --------------------------------- */

/** The upstream a fork reads from: FORK_RPC_<NET>, or the first candidate
 * that still serves state 2,000 blocks back (config/forks.js). */
async function pickUpstream(net, probe) {
  const fork = FORKS[net]
  const own = process.env[`FORK_RPC_${net.toUpperCase()}`]
  if (own) return own
  for (const u of [fork.url, ...(fork.alt ?? [])]) {
    try {
      const latest = Number(await rpc(u, 'eth_blockNumber', [], 10_000))
      const at = ethers.toQuantity(latest - 2000)
      await rpc(u, 'eth_getBalance', [probe, at], 10_000)
      return u
    } catch (e) {
      console.log(`  ${net}: upstream ${u} has no deep state (${String(e.message).slice(0, 60)}) — next`)
    }
  }
  throw new Error(`no upstream RPC serves deep enough state for a fork of ${net}; set FORK_RPC_${net.toUpperCase()}=https://…`)
}

/**
 * Starts one anvil fork per net (ports from config/forks.js), each PINNED to
 * a recent block of its upstream, one at a time and retried (a public RPC
 * answers a burst with 429s). Returns { urls, blocks, stop }.
 */
async function startForks(nets, { probe = '0x0000000000000000000000000000000000000000', log = console.log } = {}) {
  const procs = []
  const urls = {}
  const blocks = {}
  const stop = () => procs.forEach((p) => p.exitCode === null && p.kill('SIGTERM'))
  try {
    for (const net of nets) {
      const fork = FORKS[net]
      if (!fork) throw new Error(`no fork configured for "${net}" (config/forks.js)`)
      const url = `http://127.0.0.1:${fork.port}`
      const upstream = await pickUpstream(net, probe)
      let up = false
      for (let attempt = 1; attempt <= 6 && !up; attempt++) {
        const pinned = process.env[`FORK_BLOCK_${net.toUpperCase()}`] ?? String(Number(await rpc(upstream, 'eth_blockNumber')) - 5)
        const a = spawn(
          'anvil',
          ['--fork-url', upstream, '--fork-block-number', pinned, '--port', String(fork.port), '--silent',
            '--compute-units-per-second', process.env.FORK_CUPS ?? '200', '--retries', '10', '--timeout', '60000'],
          { stdio: ['ignore', 'inherit', 'inherit'] },
        )
        a.on('error', (e) => {
          console.error(`cannot start anvil (${e.message}) — install Foundry: https://getfoundry.sh`)
          process.exit(2)
        })
        for (let i = 0; i < 240 && a.exitCode === null; i++) {
          try {
            if (Number(await rpc(url, 'eth_chainId', [], 2000)) === fork.chainId) {
              up = true
              break
            }
          } catch {
            /* not up yet */
          }
          await sleep(500)
        }
        if (up) {
          procs.push(a)
          blocks[net] = Number(await rpc(url, 'eth_blockNumber'))
          log(`  ${net}: chain ${fork.chainId}, fork of block ${pinned} from ${upstream}, port ${fork.port}`)
        } else {
          if (a.exitCode === null) a.kill('SIGTERM')
          log(`  ${net}: the fork did not come up (attempt ${attempt}) — the upstream is probably rate-limiting; retrying in 15s`)
          await sleep(15_000)
        }
      }
      if (!up) throw new Error(`anvil fork of ${net} did not come up on port ${fork.port}`)
      urls[net] = url
    }
  } catch (e) {
    stop()
    throw e
  }
  return { urls, blocks, stop }
}

/* --------------------------------- relay --------------------------------- */

/** PacketV1: version(1) nonce(8) srcEid(4) sender(32) dstEid(4) receiver(32) guid(32) message */
function decodePacket(encoded) {
  const b = ethers.getBytes(encoded)
  const hex = (from, len) => ethers.hexlify(b.slice(from, from + len))
  return {
    nonce: BigInt(hex(1, 8)),
    srcEid: Number(BigInt(hex(9, 4))),
    sender: hex(13, 32),
    dstEid: Number(BigInt(hex(45, 4))),
    receiver: ethers.getAddress(ethers.dataSlice(hex(49, 32), 12)),
    guid: hex(81, 32),
    message: ethers.hexlify(b.slice(113)),
  }
}

/** Type-3 options: the executor lzReceive option (gas [+ value]). */
function decodeOptions(options) {
  const b = ethers.getBytes(options)
  let i = 2
  let gas = 0n
  let value = 0n
  while (i < b.length) {
    const worker = b[i]
    const size = (b[i + 1] << 8) | b[i + 2]
    const type = b[i + 3]
    const body = b.slice(i + 4, i + 3 + size)
    if (worker === 1 && type === 1) {
      gas += BigInt(ethers.hexlify(body.slice(0, 16)))
      if (body.length >= 32) value += BigInt(ethers.hexlify(body.slice(16, 32)))
    }
    i += 3 + size
  }
  return { gas, value }
}

/** The protocol op inside an adapter envelope: abi.encode(bytes32, bytes32, bytes) → (uint8 op, bytes). */
function opOf(message) {
  try {
    const [, , payload] = coder.decode(['bytes32', 'bytes32', 'bytes'], message)
    const [op] = coder.decode(['uint8', 'bytes'], payload)
    return Number(op)
  } catch {
    return -1
  }
}
const OP_NAMES = { 1: 'SPAWN', 2: 'BUY', 3: 'SELL', 4: 'CLAIM', 5: 'PULL_FEES', 6: 'OPEN', 7: 'MOVE', 10: 'SYNC', 11: 'DELIVER', 12: 'PAYOUT', 13: 'FEE_DROP' }

/** Intrinsic gas of a transaction's calldata (EIP-2028), and its EIP-7623 floor. */
function intrinsic(data) {
  const b = ethers.getBytes(data)
  let zeros = 0
  for (const x of b) if (x === 0) zeros++
  const tokens = BigInt(zeros + (b.length - zeros) * 4)
  return { base: 21_000n + tokens * 4n, floor: 21_000n + tokens * 10n }
}

class Relay {
  /**
   * chains: { net: { url, eid } }, endpoint: the EndpointV2 address (same on
   * every chain). opts.hold(packet) → true keeps a packet verified but not
   * executed (the gas sweeps execute it themselves). opts.generous: deliver
   * with this much gas whatever the packet bought (measurement only).
   */
  constructor({ chains, endpoint, log = console.log, quiet = false }) {
    this.chains = chains
    this.endpoint = ethers.getAddress(endpoint)
    this.log = log
    this.quiet = quiet
    this.byEid = Object.fromEntries(Object.entries(chains).map(([net, c]) => [c.eid, net]))
    this.last = {}
    this.queue = []
    this.records = []
    this.held = []
    this.hold = null
    this.generous = 0n
    this.running = false
    this.errors = []
  }

  async start(everyMs = 400) {
    for (const [net, c] of Object.entries(this.chains)) this.last[net] = Number(await rpc(c.url, 'eth_blockNumber'))
    this.running = true
    this.loop = (async () => {
      while (this.running) {
        try {
          await this.tick()
        } catch (e) {
          this.errors.push(String(e.message ?? e))
          if (this.errors.length < 20) this.log(`  [relay] ${e.message ?? e}`)
        }
        await sleep(everyMs)
      }
    })()
  }

  async stop() {
    this.running = false
    await this.loop
  }

  /** One pass: collect new packets on every chain, deliver what is queued. */
  async tick() {
    this.busy = true
    try {
      await this.collectAndDeliver()
    } finally {
      this.busy = false
    }
  }

  async collectAndDeliver() {
    for (const [net, c] of Object.entries(this.chains)) {
      const latest = Number(await rpc(c.url, 'eth_blockNumber'))
      if (latest <= this.last[net]) continue
      const logs = await rpc(c.url, 'eth_getLogs', [
        { address: this.endpoint, topics: [PACKET_SENT], fromBlock: ethers.toQuantity(this.last[net] + 1), toBlock: ethers.toQuantity(latest) },
      ])
      this.last[net] = latest
      for (const l of logs) {
        const ev = EP_IFACE.parseLog(l)
        const p = decodePacket(ev.args.encodedPayload)
        const dst = this.byEid[p.dstEid]
        const o = decodeOptions(ev.args.options)
        const item = { ...p, src: net, dst, gasLimit: o.gas, value: o.value, op: opOf(p.message), tries: 0, verified: false, srcTx: l.transactionHash }
        if (!dst) {
          this.log(`  [relay] packet from ${net} to eid ${p.dstEid}: no fork for it — dropped`)
          continue
        }
        this.queue.push(item)
      }
    }
    const pending = this.queue
    this.queue = []
    for (const item of pending) {
      const done = await this.deliver(item)
      if (!done) {
        item.tries += 1
        if (item.tries < 5) this.queue.push(item)
        else this.errors.push(`gave up on ${OP_NAMES[item.op] ?? item.op} ${item.src} → ${item.dst} (nonce ${item.nonce})`)
      }
    }
  }

  /** Verify (once), then execute — or hold. True when finished with it. */
  async deliver(item) {
    const url = this.chains[item.dst].url
    const origin = [item.srcEid, item.sender, item.nonce]
    if (!item.verified) {
      const [lib] = EP_IFACE.decodeFunctionResult(
        'getReceiveLibrary',
        await rpc(url, 'eth_call', [{ to: this.endpoint, data: EP_IFACE.encodeFunctionData('getReceiveLibrary', [item.receiver, item.srcEid]) }, 'latest']),
      )
      const hash = ethers.keccak256(ethers.concat([item.guid, item.message]))
      const rc = await sendAs(url, lib, {
        to: this.endpoint,
        data: EP_IFACE.encodeFunctionData('verify', [origin, item.receiver, hash]),
        gas: ethers.toQuantity(400_000),
      })
      if (rc.status !== '0x1') throw new Error(`verify failed on ${item.dst} for ${OP_NAMES[item.op]} from ${item.src} (nonce ${item.nonce})`)
      item.verified = true
      if (this.hold?.(item)) {
        this.held.push(item)
        if (!this.quiet) this.log(`  [relay] ${OP_NAMES[item.op] ?? item.op} ${item.src} → ${item.dst} verified and HELD`)
        return true
      }
    }
    const rec = await this.execute(item)
    return rec.ok || rec.final
  }

  /** The executor's call, with the packet's own gas (or `gas`). */
  lzReceiveData(item) {
    return EP_IFACE.encodeFunctionData('lzReceive', [[item.srcEid, item.sender, item.nonce], item.receiver, item.guid, item.message, '0x'])
  }

  async execute(item, gasOverride) {
    const url = this.chains[item.dst].url
    const data = this.lzReceiveData(item)
    const ig = intrinsic(data)
    const limit = gasOverride ?? (this.generous > 0n ? this.generous : item.gasLimit)
    let gas = ig.base + limit
    if (gas < ig.floor) gas = ig.floor
    const rc = await sendAs(url, EXECUTOR, { to: this.endpoint, data, value: ethers.toQuantity(item.value), gas: ethers.toQuantity(gas) })
    const gasUsed = BigInt(rc.gasUsed)
    const rec = {
      op: OP_NAMES[item.op] ?? String(item.op),
      src: item.src,
      dst: item.dst,
      nonce: String(item.nonce),
      ok: rc.status === '0x1',
      gasUsed: String(gasUsed),
      exec: String(gasUsed - ig.base), // what the executor's gas limit must cover
      limit: String(limit),
      bought: String(item.gasLimit), // what the sender's executor option paid for
      value: String(item.value),
      tx: rc.transactionHash,
      srcTx: item.srcTx,
    }
    this.records.push(rec)
    if (!this.quiet || !rec.ok) {
      this.log(`  [relay] ${rec.op.padEnd(9)} ${item.src} → ${item.dst}: ${rec.ok ? '✓' : '✗ REVERTED'} ${rec.exec} gas of ${rec.limit}`)
    }
    return rec
  }

  /** Waits until nothing is queued (held packets excluded). */
  async idle(ms = 120_000) {
    const t = Date.now()
    while (Date.now() - t < ms) {
      if (!this.queue.length && !this.busy) {
        await sleep(1500)
        if (!this.queue.length && !this.busy) return true
      }
      await sleep(300)
    }
    return false
  }
}

module.exports = { rpc, sendAs, startForks, pickUpstream, Relay, decodePacket, decodeOptions, opOf, intrinsic, OP_NAMES, EP_IFACE, EXECUTOR }
