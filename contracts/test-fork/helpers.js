/**
 * Helpers for the mainnet-FORK suite. Everything here runs in memory on a
 * hardhat fork: nothing is ever sent to a live chain.
 *
 *   node scripts/fork-run.js base       # anvil fork of Base + test-fork/base.fork.test.js
 *   node scripts/fork-run.js optimism
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ethers } = require('hardhat')
const { impersonateAccount, setBalance } = require('@nomicfoundation/hardhat-network-helpers')
const { PROFILES } = require('../config/profiles')
const { USDC_ABI, CCTP_MESSENGER_ABI, ENDPOINT_ABI, GENERATION, b32, loadState, saveState } = require('../scripts/lib-net')

const coder = ethers.AbiCoder.defaultAbiCoder()
const U = (n) => ethers.parseUnits(String(n), 6)
const E = (n) => ethers.parseEther(String(n))
const SCALE = 10n ** 12n

// wire opcodes (SpawnPad / SpawnGateway)
const OP = { SPAWN: 1, BUY: 2, SELL: 3, CLAIM: 4, PULL: 5, SYNC: 10, DELIVER: 11, PAYOUT: 12, FEE_DROP: 13 }

/** A private copy of the mainnet profile whose state and manifest live in a
 * temp dir — the real deploy code, pointed away from the repo's files.
 * `off`: nets left out (enabled: false) — a single-chain fork suite only
 * stands in for the spokes it names. `plain`: nets whose launch ceiling is
 * dropped (these suites measure the plain fan-out; the five-chain rehearsal,
 * scripts/fork-rehearsal.js, measures the ceilings). */
function forkProfile({ off = ['ethereum', 'bnb'], plain = ['ethereum'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-fork-'))
  const m = PROFILES.mainnet
  return {
    ...m,
    nets: Object.fromEntries(
      Object.entries(m.nets).map(([k, v]) => [
        k,
        { ...v, ...(off.includes(k) ? { enabled: false } : {}), ...(plain.includes(k) ? { syncCap: undefined } : {}) },
      ]),
    ),
    dvn: { ...m.dvn, addresses: JSON.parse(JSON.stringify(m.dvn.addresses)) },
    stateFile: path.join(dir, 'mainnet.json'),
    manifestFile: path.join(dir, 'manifest.json'),
  }
}

/** A deterministic stand-in address for a contract that lives on ANOTHER
 * chain (the fork only has one). */
const fakeAddr = (tag) => ethers.getAddress(ethers.dataSlice(ethers.id(`spawn/fork/${tag}`), 12))

/** Records a remote network in the state file as its own deploy script
 * would have: adapter + vault + gateway + pool, finished (`ready`). */
function injectRemote(profile, net, extra = {}) {
  const all = loadState(profile.stateFile)
  const hubSide = net === profile.hub
  all[net] = {
    adapter: fakeAddr(`${net}/adapter`),
    transport: GENERATION,
    usdc: profile.nets[net].usdc,
    gateway: fakeAddr(`${net}/gateway`),
    ...(hubSide
      ? { usd: fakeAddr(`${net}/ledger`), pad: fakeAddr(`${net}/pad`), venue: fakeAddr(`${net}/venue`), localUsd: fakeAddr(`${net}/vault`), localDist: fakeAddr(`${net}/dist`) }
      : { usd: fakeAddr(`${net}/vault`), dist: fakeAddr(`${net}/dist`), ready: true }),
    ...extra,
  }
  saveState(profile.stateFile, all)
  return all[net]
}

async function impersonate(addr) {
  await impersonateAccount(addr)
  await setBalance(addr, E(10))
  return ethers.getSigner(addr)
}

/** Real USDC for a test account: minted by Circle's own CCTP minter (the
 * account the preflight proves is a USDC minter), impersonated on the fork. */
async function mintUsdc(cfg, to, amount) {
  const tm = new ethers.Contract(cfg.tokenMessenger, CCTP_MESSENGER_ABI, ethers.provider)
  const minter = await impersonate(await tm.localMinter())
  const usdc = new ethers.Contract(cfg.usdc, USDC_ABI, minter)
  await (await usdc.mint(to, amount)).wait()
}

const usdcAt = (cfg, signer) => new ethers.Contract(cfg.usdc, USDC_ABI, signer ?? ethers.provider)

const BEP20_OWNER_ABI = ['function getOwner() view returns (address)', 'function mint(uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)']
/** Real dollars of a universe for a test account, in the token's own units:
 * Circle's minter for USDC, the BEP20 owner (mints to itself, then pays) for
 * Binance-Peg USDT on BNB Chain. Fork only, by impersonation. */
async function fundDollars(profile, cfg, to, amount) {
  if (cfg.tokenMessenger) return mintUsdc(cfg, to, amount)
  const token = new ethers.Contract(cfg.usdc, BEP20_OWNER_ABI, ethers.provider)
  const owner = await impersonate(await token.getOwner())
  await (await token.connect(owner).mint(amount)).wait()
  await (await token.connect(owner).transfer(to, amount)).wait()
}

/** op payload as the pad and gateways encode it */
const payload = (op, types, values) => coder.encode(['uint8', 'bytes'], [op, coder.encode(types, values)])

/** Delivers a LayerZero message into `adapter` the way the executor does:
 * from the endpoint's address, with the prepaid reply budget as msg.value. */
async function lzDeliver(profile, adapter, { srcEid, srcAdapter, srcSender, dst, data, value = 0n, nonce = 1 }) {
  const endpoint = await impersonate(profile.endpoint)
  const message = coder.encode(['bytes32', 'bytes32', 'bytes'], [b32(srcSender), b32(dst), data])
  const tx = await adapter
    .connect(endpoint)
    .lzReceive({ srcEid, sender: b32(srcAdapter), nonce }, ethers.id(`guid/${nonce}/${Date.now()}`), message, ethers.ZeroAddress, '0x', { value })
  return tx.wait()
}

const endpointIface = new ethers.Interface(ENDPOINT_ABI)
/** The PacketSent events the REAL endpoint emitted in a receipt. */
function packetsSent(profile, receipt) {
  const topic = endpointIface.getEvent('PacketSent').topicHash
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === profile.endpoint.toLowerCase() && l.topics[0] === topic)
    .map((l) => endpointIface.parseLog(l).args)
}

/** Decoded events of `contract` in a receipt. */
function eventsOf(contract, receipt, name) {
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === contract.target.toLowerCase())
    .map((l) => {
      try {
        return contract.interface.parseLog(l)
      } catch {
        return null
      }
    })
    .filter((e) => e && e.name === name)
}

/** A logger that stays quiet unless FORK_VERBOSE=1. */
const quiet = process.env.FORK_VERBOSE === '1' ? console.log : () => {}

module.exports = {
  coder, U, E, SCALE, OP,
  forkProfile, fakeAddr, injectRemote, impersonate, mintUsdc, fundDollars, usdcAt, payload, lzDeliver, packetsSent, eventsOf, quiet,
}
