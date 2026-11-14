/**
 * The hand-written builders and decoders against the program's own IDL
 * (target/idl/spawn_gateway.json), read through Anchor's TS coder — an
 * independent implementation of the same Borsh: discriminators, every
 * account list (order, signer and writable flags), every argument
 * encoding, every account decoder.
 */
import { expect } from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
import {
  ACCOUNT_DISC,
  GatewayContext,
  GatewayPdas,
  IX,
  SENDS,
  SendContext,
  bytesToHex,
  claimParkedIx,
  claimRewardsIx,
  decodeCctpPeer,
  decodeMoveRoute,
  decodePosition,
  decodeReplica,
  decodeStore,
  decodeUserAccount,
  governIx,
  initStoreIx,
  initVaultIx,
  openUserAccountIx,
  quoteSendIx,
  rebalanceIx,
  recoverTankIx,
  redeemClaimIx,
  setCctpPeerIx,
  setMoveLegsIx,
  setPeerConfigIx,
  setReceiveTableIx,
  stakeIx,
  toBytes32,
  unstakeIx,
  LZ_ENDPOINT,
  buildSendIx,
} from '../src'
import { SOLANA_DIR } from './harness'

const idl = JSON.parse(fs.readFileSync(path.join(SOLANA_DIR, 'target', 'idl', 'spawn_gateway.json'), 'utf8'))
const coder = new BorshCoder(idl)
const byName = new Map<string, any>(idl.instructions.map((i: any) => [i.name, i]))

const pdas = new GatewayPdas()
const ctx: GatewayContext = { pdas, hubEid: 30184, usdcMint: Keypair.generate().publicKey, vault: pdas.vault }
const user = Keypair.generate().publicKey
const tok = toBytes32('0x' + '8b'.repeat(20))
const arr = (b: Uint8Array) => Array.from(b)

/** Checks the named accounts of `ix` against the IDL and its data against
 * Anchor's encoding of `args`. Returns the remaining accounts. */
function check(name: string, ix: TransactionInstruction, args: any) {
  const def = byName.get(name)
  expect(def, name).to.not.equal(undefined)
  expect(bytesToHex(IX[name as keyof typeof IX])).to.equal(bytesToHex(Uint8Array.from(def.discriminator)), `${name} discriminator`)
  def.accounts.forEach((a: any, i: number) => {
    const k = ix.keys[i]
    expect(k, `${name}.${a.name}`).to.not.equal(undefined)
    expect(k.isSigner, `${name}.${a.name} signer`).to.equal(!!a.signer)
    // optional accounts passed as None (the program id) are read-only
    if (!a.optional) expect(k.isWritable, `${name}.${a.name} writable`).to.equal(!!a.writable)
  })
  expect(bytesToHex(ix.data), `${name} data`).to.equal('0x' + coder.instruction.encode(name, args).toString('hex'))
  return ix.keys.slice(def.accounts.length)
}

describe('builders = the IDL (Anchor’s own coder as the reference)', () => {
  it('every discriminator', () => {
    for (const i of idl.instructions) expect(bytesToHex((IX as any)[i.name]), i.name).to.equal(bytesToHex(Uint8Array.from(i.discriminator)))
    for (const a of idl.accounts) {
      if ((ACCOUNT_DISC as any)[a.name]) expect(bytesToHex((ACCOUNT_DISC as any)[a.name])).to.equal(bytesToHex(Uint8Array.from(a.discriminator)))
    }
  })

  it('the seven sends: named accounts, then the 38-account LayerZero list', () => {
    const path = {
      oapp: pdas.store,
      dstEid: 30184,
      receiver: toBytes32('0x' + 'b2'.repeat(20)),
      sendLibProgram: new PublicKey('7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH'),
      msglib: Keypair.generate().publicKey,
      treasury: null,
      uln: {} as any,
      maxMessageSize: 10_000,
      executor: { program: Keypair.generate().publicKey, config: Keypair.generate().publicKey, priceFeedProgram: Keypair.generate().publicKey, priceFeedConfig: Keypair.generate().publicKey },
      dvns: [0, 1, 2, 3].map(() => ({ program: Keypair.generate().publicKey, config: Keypair.generate().publicKey, priceFeedProgram: Keypair.generate().publicKey, priceFeedConfig: Keypair.generate().publicKey })),
    }
    const sc: SendContext = { ...ctx, path }
    const fee = 123n
    const lists = [
      check('spawn_token', buildSendIx(SENDS.spawn_token, sc, user, { name: 'Né', symbol: 'S', metaUri: 'ipfs://x', devBuyUsdc: 5n, feeMode: 2 }, fee), {
        params: { name: 'Né', symbol: 'S', meta_uri: 'ipfs://x', dev_buy_usdc: new BN(5), fee_mode: 2, max_native_fee: new BN(123) },
      }),
      check('buy_token', buildSendIx(SENDS.buy_token, sc, user, { hubToken: tok, usdcIn: 9n, minTokensOut: 4n }, fee), {
        params: { hub_token: arr(tok), usdc_in: new BN(9), min_tokens_out: new BN(4), max_native_fee: new BN(123) },
      }),
      check('sell_token', buildSendIx(SENDS.sell_token, sc, user, { hubToken: tok, amount: 7n, minUsdcOut: 3n }, fee), {
        params: { hub_token: arr(tok), amount: new BN(7), min_usdc_out: new BN(3), max_native_fee: new BN(123) },
      }),
      check('claim_fees', buildSendIx(SENDS.claim_fees, sc, user, { hubToken: tok }, fee), { params: { hub_token: arr(tok), max_native_fee: new BN(123) } }),
      check('pull_fees', buildSendIx(SENDS.pull_fees, sc, user, { hubToken: tok }, fee), { params: { hub_token: arr(tok), max_native_fee: new BN(123) } }),
      check('open_token', buildSendIx(SENDS.open_token, sc, user, { hubToken: tok }, fee), { params: { hub_token: arr(tok), max_native_fee: new BN(123) } }),
      // a 20-byte recipient is an EVM address: it rides left-padded
      check('move_claim', buildSendIx(SENDS.move_claim, sc, user, { dstChain: 4, to: tok.slice(12), units: 11n }, fee), {
        params: { dst_chain: 4, to: arr(tok), units: new BN(11), max_native_fee: new BN(123) },
      }),
    ]
    for (const l of lists) {
      expect(l.length).to.equal(18 + 4 * 5)
      expect(l[0].pubkey.equals(LZ_ENDPOINT)).to.equal(true)
      expect(l[13].pubkey.equals(user) && l[13].isSigner && l[13].isWritable).to.equal(true, 'the user pays at index 13')
      expect(l[5].isWritable).to.equal(false, 'send_library_info must stay read-only')
    }
    const q = check('quote_send', quoteSendIx(sc, { op: 1, name: 'a', symbol: 'b', metaUri: 'c', withDevBuy: true, dstChain: 0 }, user), {
      params: { op: 1, name: 'a', symbol: 'b', meta_uri: 'c', with_dev_buy: true, dst_chain: 0 },
    })
    expect(q[13].isSigner).to.equal(false, 'nothing signs a quote')
    // a move is quoted with its destination and that destination's route
    const qm = quoteSendIx(sc, { op: 7, name: '', symbol: '', metaUri: '', withDevBuy: false, dstChain: 4 }, user, pdas.moveRoute(4))
    check('quote_send', qm, { params: { op: 7, name: '', symbol: '', meta_uri: '', with_dev_buy: false, dst_chain: 4 } })
    expect(qm.keys[2].pubkey.equals(pdas.moveRoute(4))).to.equal(true)
    expect(quoteSendIx(sc, { op: 2, name: '', symbol: '', metaUri: '', withDevBuy: false, dstChain: 0 }, user).keys[2].pubkey.equals(pdas.programId)).to.equal(
      true,
      'no route: the program id stands for None',
    )
    // the move's route account is the one of ITS destination
    const mv = buildSendIx(SENDS.move_claim, sc, user, { dstChain: 6, to: tok, units: 1n }, fee)
    expect(mv.keys[5].pubkey.equals(pdas.moveRoute(6))).to.equal(true)
  })

  it('the six user instructions', () => {
    check('open_user_account', openUserAccountIx(ctx, user, user), {})
    check('redeem_claim', redeemClaimIx(ctx, user, 42n), { units: new BN(42) })
    check('claim_parked', claimParkedIx(ctx, user, tok), { hub_token: arr(tok) })
    check('stake', stakeIx(ctx, user, tok, 3n), { hub_token: arr(tok), units: new BN(3) })
    check('unstake', unstakeIx(ctx, user, tok, 3n), { hub_token: arr(tok), units: new BN(3) })
    check('claim_rewards', claimRewardsIx(ctx, user, tok), { hub_token: arr(tok) })
  })

  it('the admin instructions', () => {
    const a = Keypair.generate().publicKey
    const pad = toBytes32('0x' + 'a1'.repeat(20))
    const rest = check('init_store', initStoreIx(pdas, a, { admin: a, endpoint: LZ_ENDPOINT, hubEid: 30184, hubPad: pad }, null), {
      params: { admin: a, endpoint: LZ_ENDPOINT, hub_eid: 30184, hub_pad: arr(pad) },
    })
    expect(rest.length).to.equal(7, 'register_oapp accounts')
    check('init_vault', initVaultIx(pdas, a, ctx.usdcMint), {})
    check('set_peer_config', setPeerConfigIx(pdas, a, 30184, pad), { params: { remote_eid: 30184, peer_address: arr(pad) } })
    check('transfer_admin', governIx.transferAdmin(pdas, a, user), { nominee: user })
    expect(check('accept_admin', governIx.acceptAdmin(pdas, a), {}).length).to.equal(5, 'set_delegate accounts')
    check('set_operator', governIx.setOperator(pdas, a, user), { operator: user })
    check('set_guardian', governIx.setGuardian(pdas, a, user), { guardian: user })
    check('set_sponsored', governIx.setSponsored(pdas, a, true), { on: true })
    check('pause', governIx.pause(pdas, a), {})
    check('unpause', governIx.unpause(pdas, a), {})
    check('set_fee_config', governIx.setFeeConfig(pdas, a, { gasToHub: 4_600_000n, returnUnit: 350_000_000_000_000n, tradeLegs: 1, spawnLegs: 5 }), {
      params: { gas_to_hub: new BN(4_600_000), return_unit: new BN('350000000000000'), trade_legs: 1, spawn_legs: 5 },
    })
    check('set_deposit_cap', governIx.setDepositCap(pdas, a, 1_000n), { cap: new BN(1000) })
    check('recover_tank', recoverTankIx(pdas, a, user, 5n), { lamports: new BN(5) })
  })

  it('the v7.2 settings: open legs, move legs, the executor table, CCTP peers, rebalance', () => {
    const a = Keypair.generate().publicKey
    check('set_open_legs', governIx.setOpenLegs(pdas, a, 2), { legs: 2 })
    expect(() => governIx.setOpenLegs(pdas, a, 9)).to.throw(/out of bounds/)
    // how long an order lives: two minutes to a day, never none
    check('set_order_ttl', governIx.setOrderTtl(pdas, a, 3600), { ttl: 3600 })
    for (const bad of [0, 119, 86_401, 1.5]) expect(() => governIx.setOrderTtl(pdas, a, bad), String(bad)).to.throw(/out of bounds/)
    check('set_move_legs', setMoveLegsIx(pdas, a, 4, 4096), { dst_chain: 4, legs: 4096 })
    expect(() => setMoveLegsIx(pdas, a, 4, 4097)).to.throw(/out of bounds/)
    const table = Keypair.generate().publicKey
    const set = setReceiveTableIx(pdas, a, table)
    check('set_receive_table', set, {})
    expect(set.keys[3].pubkey.equals(table)).to.equal(true)
    expect(setReceiveTableIx(pdas, a, null).keys[3].pubkey.equals(pdas.programId)).to.equal(true, 'None clears it')
    const vault = toBytes32('0x' + 'c3'.repeat(20))
    check('set_cctp_peer', setCctpPeerIx(pdas, a, 3, 6, vault.slice(12)), { label: 3, domain: 6, vault: arr(vault) })
    const ev = Keypair.generate().publicKey
    const rb = rebalanceIx(ctx, a, 3, 6, 77n, ev)
    expect(check('rebalance', rb, { label: 3, usdc: new BN(77) }).length).to.equal(0)
    expect(rb.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).to.deep.equal([a.toBase58(), ev.toBase58()])
    expect(() => rebalanceIx(ctx, a, 3, 6, 0n, ev)).to.throw(/ZeroAmount/)
  })

  it('the decoders read what Anchor encodes', async () => {
    const k = Keypair.generate().publicKey
    const enc = async (name: string, v: any) => new Uint8Array(await coder.accounts.encode(name, v))
    const store = decodeStore(
      await enc('Store', {
        admin: k, pending_admin: user, operator: k, guardian: user, bump: 254, paused: true, sponsored: false,
        endpoint_program: LZ_ENDPOINT, hub_eid: 40245, hub_pad: arr(tok), usdc_mint: k, vault: user,
        deposit_cap: new BN(9), claims_total: new BN(8), pool_total: new BN(7), usd_dust_e18: new BN('123456789012345678901'),
        gas_to_hub: new BN(4_600_000), return_unit: new BN('350000000000000'), trade_legs: 1, spawn_legs: 6, open_legs: 2,
        order_ttl: 3600,
      }),
    )
    expect([store.hubEid, store.paused, store.depositCap, store.usdDustE18, store.returnUnit, store.spawnLegs, store.openLegs, store.orderTtl]).to.deep.equal([40245, true, 9n, 123456789012345678901n, 350000000000000n, 6, 2, 3600])
    const route = decodeMoveRoute(await enc('MoveRoute', { dst_chain: 4, legs: 4096, bump: 9 }))
    expect([route.dstChain, route.legs, route.bump]).to.deep.equal([4, 4096, 9])
    const peer = decodeCctpPeer(await enc('CctpPeer', { label: 3, domain: 6, vault: arr(tok), bump: 7 }))
    expect([peer.label, peer.domain, bytesToHex(peer.vault), peer.bump]).to.deep.equal([3, 6, bytesToHex(tok), 7])
    expect(store.pendingAdmin.equals(user)).to.equal(true)
    const r = decodeReplica(
      await enc('Replica', { hub_token: arr(tok), mint: k, bump: 1, name: 'NAME', symbol: 'SYM', dust_carry: new BN(5), staked_total: new BN(6), acc_per_share: new BN('77777777777777777777'), pending_fees: new BN(8) }),
    )
    expect([r.name, r.symbol, r.dustCarry, r.stakedTotal, r.accPerShare, r.pendingFees]).to.deep.equal(['NAME', 'SYM', 5n, 6n, 77777777777777777777n, 8n])
    const ua = decodeUserAccount(
      await enc('UserAccount', { owner: k, bump: 2, usd_claim: new BN(11), parked: [{ hub_token: arr(tok), amount_e18: new BN('1000000000000000000001') }] }),
    )
    expect(ua.usdClaim).to.equal(11n)
    expect(ua.parked[0].amountE18).to.equal(1000000000000000000001n)
    const pos = decodePosition(await enc('Position', { owner: k, hub_token: arr(tok), bump: 3, staked: new BN(12), reward_debt: new BN(13), owed: new BN(14) }))
    expect([pos.staked, pos.rewardDebt, pos.owed]).to.deep.equal([12n, 13n, 14n])
  })
})
