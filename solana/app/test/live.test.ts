/**
 * The client's transactions, end to end, against the gateway and the REAL
 * mainnet LayerZero programs loaded in LiteSVM: every send goes endpoint →
 * ULN → executor → price feed → DVNs and is paid by the user; hub replies
 * come back through LayerZero's real executor program and the real
 * endpoint `clear`. Run twice: over the verifier set the wiring installs
 * (ours, V7.md §6) and over the pathway's default set (what V7.md §5
 * measured).
 */
import { expect } from 'chai'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  GatewayClient,
  OP,
  SENDS,
  SendSpec,
  VerifierSet,
  assembleV0,
  buildSendIx,
  claimableRewards,
  decodeNonce,
  decodeStore,
  findSentToHub,
  governIx,
  indexOfBytes,
  legacySize,
  lzPda,
  lzReceiveOptions,
  parkedUnits,
  splToE18,
  toBytes32,
  txSize,
  ata,
} from '../src'
import { Sent, USDC, World, measure, measurements } from './harness'
import { GAS_TO_HUB, HUB_ADAPTER, HUB_EID, HUB_PAD, ONE, RETURN_UNIT, SPAWN_LEGS, wiredWorld } from './fixtures'

const TOK = toBytes32('0x' + '8b'.repeat(20))
const TOK2 = toBytes32('0x' + '5e'.repeat(20))
const E18 = 10n ** 18n
const SIG_FEE = 5_000n

function scenario(label: string, verifiers: VerifierSet | null | undefined) {
  describe(`client sends over ${label}`, function () {
    let w: World
    let admin: Keypair
    let client: GatewayClient
    let user: Keypair
    let nonceIn = 0n
    const execute = (msg: Parameters<World['execute']>[4]) => w.execute(HUB_EID, HUB_PAD, HUB_ADAPTER, ++nonceIn, msg)
    const outbound = () => decodeNonce(w.account(lzPda.nonce(w.pdas.store, HUB_EID, HUB_ADAPTER))!.data).outbound
    const rows: string[] = []

    /** Sends a client-built send and checks what every send must satisfy. */
    async function send<P>(spec: SendSpec<P>, params: P, legs: number, firstTime = false): Promise<Sent> {
      const before = w.lamports(user.publicKey)
      const n0 = outbound()
      const built = await client.buildSend(spec, user.publicKey, params)
      expect(built.size).to.be.at.most(1232)
      const sent = w.sendTx(built.tx, [user])
      const ev = findSentToHub(sent.logs)!
      expect(ev, 'SentToHub event').to.not.equal(null)
      expect(ev.user.equals(user.publicKey)).to.equal(true)
      expect(ev.legs).to.equal(legs)
      expect(ev.sponsored).to.equal(false)
      expect(ev.nativeFee).to.equal(built.quotedFee, 'quote_send (simulated by the client) = what the send cost')
      expect(built.maxNativeFee).to.equal((built.quotedFee * 11_000n) / 10_000n)
      // the packet carries the client's bytes, and the reply budget
      expect(sent.innerData.some((d) => indexOfBytes(d, built.message) >= 0), 'packet = client-encoded message').to.equal(true)
      const options = lzReceiveOptions(GAS_TO_HUB, RETURN_UNIT * BigInt(legs))
      expect(sent.innerData.some((d) => indexOfBytes(d, options) >= 0), 'executor option').to.equal(true)
      expect(outbound()).to.equal(n0 + 1n)
      const paid = before - w.lamports(user.publicKey)
      if (!firstTime) expect(paid).to.equal(ev.nativeFee + SIG_FEE, 'the user paid the LayerZero fee + the signature, nothing else')
      const ix = buildSendIx(spec, client.context, user.publicKey, params, built.maxNativeFee)
      const legacy = legacySize({ payer: user.publicKey, instructions: [ix], recentBlockhash: w.svm.latestBlockhash(), computeUnits: 700_000 })
      const m = built.tx.message
      const unique = m.staticAccountKeys.length + m.addressTableLookups.reduce((a, l) => a + l.writableIndexes.length + l.readonlyIndexes.length, 0)
      rows.push(
        `${spec.name.padEnd(12)}${firstTime ? ' (first)' : '        '}  ${unique} accounts (${m.staticAccountKeys.length} static)  v0 ${built.size} B (legacy ${legacy} B)  CU ${sent.cu}  fee ${ev.nativeFee}`,
      )
      return sent
    }

    before(async () => {
      ;({ w, admin } = await wiredWorld(verifiers === undefined ? {} : { verifiers }))
      w.send(admin, [governIx.unpause(w.pdas, admin.publicKey)])
      w.enlistExecutor()
      const s = await execute({ op: 'SYNC_TOKEN', hubToken: TOK, name: 'CANARY', symbol: 'CANARY' })
      measure(`[${label}] executor→lz_receive SYNC: ${s.cu} CU, ${s.size} B (v0 + the store's table)`)
      client = await GatewayClient.load(w.rpc())
      user = w.newUser()
      w.giveUsdc(user.publicKey, 1_000n * ONE)
    })

    after(() => {
      measure(`[${label}] sends built by the client:`)
      rows.forEach((r) => measure('  ' + r))
    })

    it('buy: USDC into the vault, OP_BUY out, the user pays; the reply lands in accounts the user opened', async () => {
      await send(SENDS.buy_token, { hubToken: TOK, usdcIn: 250n * ONE }, 1, true)
      expect(await client.vaultBalance()).to.equal(250n * ONE)
      expect(await client.tokenBalance(user.publicKey, USDC)).to.equal(750n * ONE)
      const ua = (await client.userAccount(user.publicKey))!
      expect(ua.owner.equals(user.publicKey)).to.equal(true)
      expect(w.account(ata(user.publicKey, w.pdas.mint(TOK)))).to.not.equal(null)
      await send(SENDS.buy_token, { hubToken: TOK, usdcIn: ONE }, 1)
      // the hub's DELIVER, through the real executor, into the account the buy opened
      const d = await execute({ op: 'DELIVER', hubToken: TOK, to: user.publicKey.toBytes(), tokens: 1_000_000n * E18, refund: 0n })
      measure(`[${label}] executor→lz_receive DELIVER: ${d.cu} CU, ${d.size} B`)
      expect(await client.tokenBalance(user.publicKey, w.pdas.mint(TOK))).to.equal(1_000_000n * ONE)
    })

    it('a fee ceiling below the price is refused by the ULN', async () => {
      const b = await client.buy(user.publicKey, { hubToken: TOK, usdcIn: ONE }, { maxNativeFee: 1n })
      expect(() => w.sendTx(b.tx, [user])).to.throw(/InsufficientFee/)
    })

    it('sell: the replicas burn, OP_SELL out', async () => {
      await send(SENDS.sell_token, { hubToken: TOK, amount: 400_000n * ONE }, 1)
      expect(await client.tokenBalance(user.publicKey, w.pdas.mint(TOK))).to.equal(600_000n * ONE)
      const p = await execute({ op: 'PAYOUT', to: user.publicKey.toBytes(), usdOut: 87_997_407n * 10n ** 12n })
      measure(`[${label}] executor→lz_receive PAYOUT: ${p.cu} CU, ${p.size} B`)
      expect(await client.tokenBalance(user.publicKey, USDC)).to.equal(749n * ONE + 87_997_407n)
    })

    it('claim and pull: pure messages', async () => {
      await send(SENDS.claim_fees, { hubToken: TOK }, 1)
      await send(SENDS.pull_fees, { hubToken: TOK }, 1)
    })

    it('spawn with a dev buy: 3 SYNC legs + the DELIVER leg prepaid; the dev bag is parked, then claimed', async () => {
      const p = { name: 'SOLANA BORN', symbol: 'SOLB', metaUri: '{"image":"/img/00"}', devBuyUsdc: 50n * ONE, feeMode: 1 }
      const vault0 = await client.vaultBalance()
      await send(SENDS.spawn_token, p, SPAWN_LEGS + 1)
      expect(await client.vaultBalance()).to.equal(vault0 + 50n * ONE)
      // the hub SYNCs the new token, then delivers the dev buy: no token
      // account yet, so it parks in the creator's user account
      await execute({ op: 'SYNC_TOKEN', hubToken: TOK2, name: p.name, symbol: p.symbol })
      const amount = 123_456_789_123_456_789_123n
      const d = await execute({ op: 'DELIVER', hubToken: TOK2, to: user.publicKey.toBytes(), tokens: amount, refund: 0n })
      measure(`[${label}] executor→lz_receive DELIVER (parked): ${d.cu} CU`)
      const ua = (await client.userAccount(user.publicKey))!
      expect(ua.parked.length).to.equal(1)
      expect(ua.parked[0].amountE18).to.equal(amount)
      const expected = parkedUnits(ua.parked[0], (await client.replica(TOK2))!)
      const tx = await client.claimParked(user.publicKey, TOK2)
      const s = w.sendTx(tx, [user])
      measure(`[${label}] claim_parked: ${s.cu} CU, ${s.size} B`)
      expect(await client.tokenBalance(user.publicKey, w.pdas.mint(TOK2))).to.equal(expected)
      expect((await client.userAccount(user.publicKey))!.parked.length).to.equal(0)
    })

    it('stake, a fee drop, claim_rewards, unstake', async () => {
      const units = 200_000n * ONE
      let s = w.sendTx(await client.stake(user.publicKey, TOK, units), [user])
      measure(`[${label}] stake (first): ${s.cu} CU, ${s.size} B`)
      expect((await client.position(TOK, user.publicKey))!.staked).to.equal(units)
      await execute({ op: 'FEE_DROP', hubToken: TOK, amount: 37_819_431n * 10n ** 12n })
      const owed = claimableRewards((await client.position(TOK, user.publicKey))!, (await client.replica(TOK))!)
      expect(owed >= 37_819_430n && owed <= 37_819_431n, `owed ${owed}`).to.equal(true)
      const usdc0 = await client.tokenBalance(user.publicKey, USDC)
      s = w.sendTx(await client.claimRewards(user.publicKey, TOK), [user])
      measure(`[${label}] claim_rewards: ${s.cu} CU, ${s.size} B`)
      expect(await client.tokenBalance(user.publicKey, USDC)).to.equal(usdc0 + owed)
      s = w.sendTx(await client.unstake(user.publicKey, TOK, units), [user])
      measure(`[${label}] unstake: ${s.cu} CU, ${s.size} B`)
      expect(await client.tokenBalance(user.publicKey, w.pdas.mint(TOK))).to.equal(600_000n * ONE)
    })

    it('a payout the vault cannot make becomes a claim; redeem_claim turns it into USDC', async () => {
      const vault = await client.vaultBalance()
      const over = vault + 5n * ONE
      await execute({ op: 'PAYOUT', to: user.publicKey.toBytes(), usdOut: splToE18(over) })
      const ua = (await client.userAccount(user.publicKey))!
      expect(ua.usdClaim).to.equal(over)
      w.setTokenAmount(client.store.vault, over) // liquidity rebalanced in
      const usdc0 = await client.tokenBalance(user.publicKey, USDC)
      const s = w.sendTx(await client.redeemClaim(user.publicKey, over), [user])
      measure(`[${label}] redeem_claim: ${s.cu} CU, ${s.size} B`)
      expect(await client.tokenBalance(user.publicKey, USDC)).to.equal(usdc0 + over)
      expect((await client.userAccount(user.publicKey))!.usdClaim).to.equal(0n)
    })

    it('open_user_account: anyone may open (and pay for) someone else’s', async () => {
      const someone = Keypair.generate().publicKey
      const s = w.sendTx(await client.openUserAccount(user.publicKey, someone), [user])
      measure(`[${label}] open_user_account: ${s.cu} CU, ${s.size} B`)
      expect((await client.userAccount(someone))!.owner.equals(someone)).to.equal(true)
    })

    it('a paused store refuses buys and spawns but never exits', async () => {
      w.send(admin, [governIx.pause(w.pdas, admin.publicKey)])
      const b = await client.buy(user.publicKey, { hubToken: TOK, usdcIn: ONE }, { maxNativeFee: 0n })
      expect(() => w.sendTx(b.tx, [user])).to.throw(/Paused/)
      const s = await client.sell(user.publicKey, { hubToken: TOK, amount: ONE })
      w.sendTx(s.tx, [user])
      w.send(admin, [governIx.unpause(w.pdas, admin.publicKey)])
      expect(decodeStore(w.account(w.pdas.store)!.data).paused).to.equal(false)
    })

    it('without the lookup table a send does not fit a transaction', async () => {
      const ix = buildSendIx(SENDS.buy_token, client.context, user.publicKey, { hubToken: TOK, usdcIn: ONE }, 0n)
      const tx = assembleV0({ payer: user.publicKey, instructions: [ix], recentBlockhash: w.svm.latestBlockhash(), computeUnits: 700_000 })
      expect(txSize(tx)).to.be.greaterThan(1232)
      expect(() => tx.serialize()).to.throw()
    })
  })
}

scenario('our verifier set (LZ Labs + Google, 1 of Horizen/Twinstake)', undefined)
scenario('the pathway default (4 required DVNs)', null)

describe('client entry checks (refused before signing)', () => {
  it('mirrors the program’s limits', () => {
    const ctx = {} as any
    const u = PublicKey.default
    expect(() => buildSendIx(SENDS.spawn_token, ctx, u, { name: 'X', symbol: 'X', metaUri: '', devBuyUsdc: 0n, feeMode: 4 }, 0n)).to.throw(/fee mode/)
    expect(() => buildSendIx(SENDS.spawn_token, ctx, u, { name: 'N'.repeat(65), symbol: 'X', metaUri: '', devBuyUsdc: 0n, feeMode: 0 }, 0n)).to.throw(/name/)
    expect(() => buildSendIx(SENDS.spawn_token, ctx, u, { name: 'X', symbol: 'S'.repeat(17), metaUri: '', devBuyUsdc: 0n, feeMode: 0 }, 0n)).to.throw(/symbol/)
    expect(() => buildSendIx(SENDS.buy_token, ctx, u, { hubToken: TOK, usdcIn: 0n }, 0n)).to.throw(/ZeroAmount/)
    expect(() => buildSendIx(SENDS.sell_token, ctx, u, { hubToken: TOK, amount: 0n }, 0n)).to.throw(/ZeroAmount/)
    expect(OP.PULL_FEES).to.equal(5)
  })
})

after(() => {
  if (measurements.length) console.log('\n  measurements:\n' + measurements.map((m) => '    ' + m).join('\n'))
})
