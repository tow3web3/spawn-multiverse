/**
 * The vault's outbound CCTP leg, built by the client and run against
 * Circle's REAL CCTP V2 programs and mainnet state (tests/fetch-cctp.cjs)
 * in LiteSVM: `rebalance` burns the vault's USDC through
 * TokenMessengerMinterV2.deposit_for_burn for the peer vault the wiring
 * named — `OmniUSD.rebalance` on the EVM side.
 */
import { expect } from 'chai'
import { Keypair } from '@solana/web3.js'
import {
  CCTP_DOMAIN,
  CCTP_MESSAGE_TRANSMITTER_V2,
  CHAIN_LABEL,
  GatewayClient,
  governIx,
  indexOfBytes,
  rebalanceIx,
  setCctpPeerIx,
  uintBE,
} from '../src'
import { USDC, measure } from './harness'
import { BASE_VAULT, ONE, wiredWorld } from './fixtures'

describe('CCTP: the Solana vault is levelled with a peer vault (real Circle programs)', () => {
  it('the operator burns vault USDC for the peer the admin named — and for nobody else', async () => {
    const { w, admin } = await wiredWorld()
    w.loadCctp()
    const client = await GatewayClient.load(w.rpc())
    const operator = w.newUser()
    w.send(admin, [governIx.setOperator(w.pdas, admin.publicKey, operator.publicKey)])
    w.setTokenAmount(client.store.vault, 500n * ONE)
    const peer = (await client.cctpPeer(CHAIN_LABEL.base))!
    expect(peer.domain).to.equal(CCTP_DOMAIN.base)
    const supply = () => Buffer.from(w.account(USDC)!.data).readBigUInt64LE(36)
    const supply0 = supply()

    const ev = Keypair.generate()
    const before = w.lamports(operator.publicKey)
    const sent = w.send(operator, [rebalanceIx(client.context, operator.publicKey, peer.label, peer.domain, 200n * ONE, ev.publicKey)], [ev], [client.table!])
    measure(`rebalance (CCTP V2 deposit_for_burn): ${sent.cu} CU, ${sent.size} B`)
    expect(await client.vaultBalance()).to.equal(300n * ONE)
    expect(supply0 - supply()).to.equal(200n * ONE, 'burned, not moved')
    // Circle's message account: the peer vault is the mint recipient, the
    // store the depositor, Solana (5) the source and Base (6) the destination
    const msg = w.account(ev.publicKey)!
    expect(msg.owner.equals(CCTP_MESSAGE_TRANSMITTER_V2)).to.equal(true)
    expect(indexOfBytes(msg.data, BASE_VAULT)).to.be.greaterThan(0)
    expect(indexOfBytes(msg.data, w.pdas.store.toBytes())).to.be.greaterThan(0)
    expect(indexOfBytes(msg.data, uintBE(200n * ONE, 32))).to.be.greaterThan(0)
    expect(indexOfBytes(msg.data, Uint8Array.of(0, 0, 0, 5, 0, 0, 0, 6))).to.be.greaterThan(0)
    measure(`rent of Circle's message account, paid by the operator: ${before - w.lamports(operator.publicKey) - 10_000n} lamports (${msg.data.length} bytes)`)

    // not the operator; more than the vault holds; a chain with no peer
    const stranger = w.newUser()
    const e2 = Keypair.generate()
    expect(() => w.send(stranger, [rebalanceIx(client.context, stranger.publicKey, peer.label, peer.domain, ONE, e2.publicKey)], [e2])).to.throw(/NotOperator/)
    expect(() => w.send(operator, [rebalanceIx(client.context, operator.publicKey, peer.label, peer.domain, 301n * ONE, e2.publicKey)], [e2])).to.throw(/VaultShort/)
    expect(await client.cctpPeer(CHAIN_LABEL.arbitrum)).to.equal(null)
    expect(() =>
      w.send(operator, [rebalanceIx(client.context, operator.publicKey, CHAIN_LABEL.arbitrum, CCTP_DOMAIN.arbitrum, ONE, e2.publicKey)], [e2]),
    ).to.throw(/AccountNotInitialized/)
    // naming a peer is the admin's, never the operator's — and BNB has none to name (USDT, no CCTP)
    expect(() => w.send(operator, [setCctpPeerIx(w.pdas, operator.publicKey, CHAIN_LABEL.arbitrum, CCTP_DOMAIN.arbitrum, BASE_VAULT)])).to.throw(/NotAdmin/)
    expect(await client.vaultBalance()).to.equal(300n * ONE)
  })
})
