/**
 * Completes a vault rebalance: after `OmniUSD.rebalance` burned USDC on the
 * source chain, Circle attests the burn and ANYONE may present that
 * attestation on the destination chain, where the USDC is minted to the peer
 * vault (the only possible recipient — it is inside the attested message).
 *
 *   SRC=base TX=0x<rebalance tx hash> npx hardhat run scripts/relay-cctp.js --network optimism
 *   SPAWN_APPLY=1 SRC=base TX=0x… npx hardhat run scripts/relay-cctp.js --network optimism
 *
 * Attestations come from Circle's Iris API, CCTP V2
 * (https://developers.circle.com/api-reference/cctp/all/get-messages-v2):
 *   GET https://iris-api.circle.com/v2/messages/{sourceDomainId}?transactionHash=…
 *   (testnets: https://iris-api-sandbox.circle.com)
 * A Standard Transfer is attested at source-chain FINALITY: ~15-20 minutes
 * from an L2, during which `attestation` is "PENDING". The script waits.
 * Without SPAWN_APPLY=1 it only shows what it would relay.
 */
const { ethers, network } = require('hardhat')
const { getProfile, netKeyOf } = require('../config/profiles')
const { loadState, vaultOf, b32, CCTP_MESSENGER_ABI, CCTP_TRANSMITTER_ABI } = require('./lib-net')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const profile = getProfile(network.name)
  const NET = netKeyOf(network.name)
  if (profile.mockUsdc) throw new Error(`the ${profile.name} profile has no CCTP (MockUSDC)`)
  const dst = profile.nets[NET]
  const srcKey = process.env.SRC
  const src = profile.nets[srcKey]
  const tx = process.env.TX
  if (!src || !/^0x[0-9a-fA-F]{64}$/.test(tx ?? '')) throw new Error('usage: SRC=<source net> TX=<0x rebalance tx hash> … --network <destination net>')
  const host = profile.mainnet ? 'https://iris-api.circle.com' : 'https://iris-api-sandbox.circle.com'
  const url = `${host}/v2/messages/${src.cctpDomain}?transactionHash=${tx}`
  const myVault = vaultOf(profile, NET, loadState(profile.stateFile)[NET])
  console.log(`relay-cctp — ${srcKey} (domain ${src.cctpDomain}) -> ${NET} (domain ${dst.cctpDomain})`)

  let ready = []
  for (let i = 0; i < 120; i++) {
    const res = await fetch(url)
    const body = res.ok ? await res.json() : { messages: [] }
    const mine = (body.messages ?? []).filter((m) => Number(m.decodedMessage?.destinationDomain) === dst.cctpDomain)
    ready = mine.filter((m) => m.status === 'complete' && m.attestation && m.attestation !== 'PENDING')
    if (mine.length && ready.length === mine.length) break
    console.log(
      `  … ${mine.length ? `${ready.length}/${mine.length} attested` : `no message for this destination yet (HTTP ${res.status})`} — waiting`,
    )
    await sleep(30_000)
  }
  if (!ready.length) throw new Error('no attested message for this destination — check the tx hash, SRC and the destination network')

  const [signer] = await ethers.getSigners()
  const tm = new ethers.Contract(dst.tokenMessenger, CCTP_MESSENGER_ABI, signer)
  const transmitter = new ethers.Contract(await tm.localMessageTransmitter(), CCTP_TRANSMITTER_ABI, signer)
  for (const m of ready) {
    const body = m.decodedMessage?.decodedMessageBody ?? {}
    const recipient = body.mintRecipient
    const toVault = myVault && recipient && b32(recipient.length === 42 ? recipient : ethers.dataSlice(recipient, 12)) === b32(myVault)
    console.log(`  message nonce ${m.decodedMessage?.nonce}: ${ethers.formatUnits(body.amount ?? '0', 6)} USDC -> ${recipient}${toVault ? ' (this chain\'s vault ✓)' : ' (NOT this deployment\'s vault)'}`)
    if (process.env.SPAWN_APPLY !== '1') {
      console.log('    (not relayed — SPAWN_APPLY=1 presents the attestation)')
      continue
    }
    try {
      const rc = await (await transmitter.receiveMessage(m.message, m.attestation)).wait()
      console.log(`    relayed ✓ ${rc.hash}`)
    } catch (e) {
      console.log(`    not relayed: ${e.shortMessage ?? e.message} (already relayed by someone else?)`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
