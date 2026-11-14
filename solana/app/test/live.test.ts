/**
 * The client's transactions, end to end, against the gateway and the REAL
 * mainnet LayerZero programs loaded in LiteSVM: every send goes endpoint →
 * ULN → executor → price feed → DVNs and is paid by the user; hub replies
 * come back through LayerZero's real executor program and the real
 * endpoint `clear`. Run twice: over the verifier set the wiring installs
 * (ours, V7.md §6) and over the pathway's default set (what V7.md §5
 * measured). Protocol v7.2 (final): every trade names its minimum and
 * leaves with a deadline stamped from the cluster clock, the reply budget
 * rides the envelope, a token is opened and a claim moved from here, and
 * the hub's SYNCs and moved PAYOUTs arrive with the lamports that pay for
 * what they create — for a recipient this chain never saw, too.
 */
import { expect } from 'chai'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  ANY_FILL,
  CHAIN_LABEL,
  GatewayClient,
  OP,
  SENDS,
  SendSpec,
  VerifierSet,
  assembleV0,
  buildSendIx,
  claimableRewards,
  decodeEnvelope,
  decodeNonce,
  decodeStore,
  findPaidOut,
  findSentToHub,
  findUserAccountOpened,
  findValueReceived,
  governIx,
  hexToBytes,
  indexOfBytes,
  legacySize,
  lzPda,
  lzReceiveOptions,
  parkedUnits,
  splToE18,
  suggestedHubUnit,
  toBytes32,
  txSize,
  ata,
} from '../src'
import { NOW, Sent, USDC, World, measure, measurements } from './harness'
import { GAS_TO_HUB, HUB_ADAPTER, HUB_EID, HUB_PAD, ONE, ORDER_TTL, RETURN_UNIT, SPAWN_LEGS, wiredWorld } from './fixtures'

const TOK = toBytes32('0x' + '8b'.repeat(20))
const TOK2 = toBytes32('0x' + '5e'.repeat(20))
/** A token the hub spawned and never synced here (left out of the launch). */
const TOK3 = toBytes32('0x' + '3c'.repeat(20))
/** An EVM recipient on another chain. */
const EVM_TO = hexToBytes('0x' + 'd0'.repeat(20))
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
    /** A hub message that BRINGS lamports: a SYNC, a moved PAYOUT — its
     * envelope names them and LayerZero's executor delivers with them. */
    const executeWith = (msg: Parameters<World['execute']>[4], lamports: bigint) =>
      w.execute(HUB_EID, HUB_PAD, HUB_ADAPTER, ++nonceIn, msg, lamports, lamports)
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
      expect(built.legs).to.equal(legs)
      expect(ev.sponsored).to.equal(false)
      // a trade leaves with a deadline — the cluster clock plus the store's
      // lifetime — and nothing else does
      const deadline = spec.trade ? w.now() + ORDER_TTL : 0n
      expect([built.deadline, ev.deadline]).to.deep.equal([deadline, deadline])
      expect(ev.nativeFee).to.equal(built.quotedFee, 'quote_send (simulated by the client) = what the send cost')
      expect(built.maxNativeFee).to.equal((built.quotedFee * 11_000n) / 10_000n)
      // the packet carries the client's bytes, and the reply budget
      expect(sent.innerData.some((d) => indexOfBytes(d, built.message) >= 0), 'packet = client-encoded message').to.equal(true)
      const options = lzReceiveOptions(GAS_TO_HUB, RETURN_UNIT * BigInt(legs))
      expect(sent.innerData.some((d) => indexOfBytes(d, options) >= 0), 'executor option').to.equal(true)
      // …and the envelope names the same budget (the hub adapter refuses a
      // delivery that brings less)
      expect(decodeEnvelope(built.message).value).to.equal(RETURN_UNIT * BigInt(legs))
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
      // …for at least 900,000 tokens: the minimum rides the wire and the
      // hub fills at that or sends the dollars home
      const first = await send(SENDS.buy_token, { hubToken: TOK, usdcIn: 250n * ONE, minTokensOut: 900_000n * ONE }, 1, true)
      expect(first.innerData.some((d) => indexOfBytes(d, toBytes32(splToE18(900_000n * ONE).toString(16).padStart(64, '0'))) >= 0)).to.equal(true)
      expect(await client.vaultBalance()).to.equal(250n * ONE)
      expect(await client.tokenBalance(user.publicKey, USDC)).to.equal(750n * ONE)
      const ua = (await client.userAccount(user.publicKey))!
      expect(ua.owner.equals(user.publicKey)).to.equal(true)
      expect(w.account(ata(user.publicKey, w.pdas.mint(TOK)))).to.not.equal(null)
      await send(SENDS.buy_token, { hubToken: TOK, usdcIn: ONE, minTokensOut: ANY_FILL }, 1)
      // the hub's DELIVER, through the real executor, into the account the buy opened
      const d = await execute({ op: 'DELIVER', hubToken: TOK, to: user.publicKey.toBytes(), tokens: 1_000_000n * E18, refund: 0n })
      measure(`[${label}] executor→lz_receive DELIVER: ${d.cu} CU, ${d.size} B`)
      expect(await client.tokenBalance(user.publicKey, w.pdas.mint(TOK))).to.equal(1_000_000n * ONE)
    })

    it('a fee ceiling below the price is refused by the ULN', async () => {
      const b = await client.buy(user.publicKey, { hubToken: TOK, usdcIn: ONE, minTokensOut: ANY_FILL }, { maxNativeFee: 1n })
      expect(() => w.sendTx(b.tx, [user])).to.throw(/InsufficientFee/)
    })

    it('sell: the replicas burn, OP_SELL out', async () => {
      await send(SENDS.sell_token, { hubToken: TOK, amount: 400_000n * ONE, minUsdcOut: 87_500_000n }, 1)
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

    it('v7.2 deadline: every buy and sell is five words on the wire, stamped from the cluster clock; the operator sets the lifetime', async () => {
      expect([w.now(), client.store.orderTtl]).to.deep.equal([NOW, 3600])
      expect(await client.clusterTime()).to.equal(NOW)
      const b = await client.buy(user.publicKey, { hubToken: TOK, usdcIn: ONE, minTokensOut: ANY_FILL })
      expect(b.deadline).to.equal(NOW + 3600n)
      expect(b.payload).to.include({ op: 'BUY', deadline: NOW + 3600n })
      // the enveloped trade: 4 head words, a length, 3 + 5 words of payload
      expect(b.message.length).to.equal(13 * 32)
      // the clock moves on while the wallet signs: the program stamps what
      // the clock says when the order EXECUTES, not what the client saw
      w.setNow(NOW + 90n)
      const sent = w.sendTx(b.tx, [user])
      expect(findSentToHub(sent.logs)!.deadline).to.equal(NOW + 90n + 3600n)
      expect(sent.innerData.some((d) => indexOfBytes(d, b.message) >= 0)).to.equal(false, 'the client’s guess was 90 s short')
      const now = { ...b.payload, deadline: NOW + 90n + 3600n } as typeof b.payload
      const { outboundMessage } = require('../src')
      expect(sent.innerData.some((d) => indexOfBytes(d, outboundMessage(w.pdas.store, client.store.hubPad, now, b.value)) >= 0)).to.equal(true)

      // the operator lengthens it — a clock that lags, a slow pathway
      w.send(admin, [governIx.setOrderTtl(w.pdas, admin.publicKey, 86_400)])
      await client.refresh()
      const s = await client.sell(user.publicKey, { hubToken: TOK, amount: ONE, minUsdcOut: ANY_FILL })
      expect(s.deadline).to.equal(NOW + 90n + 86_400n)
      expect(findSentToHub(w.sendTx(s.tx, [user]).logs)!.deadline).to.equal(s.deadline)
      // never without one: the program refuses a lifetime outside two minutes to a day
      for (const bad of [0, 119, 86_401]) {
        const ix = governIx.setOrderTtl(w.pdas, admin.publicKey, 3600)
        ix.data.writeUInt32LE(bad, 8)
        expect(() => w.send(admin, [ix]), String(bad)).to.throw(/BadOrderTtl/)
      }
      const stranger = w.newUser()
      expect(() => w.send(stranger, [governIx.setOrderTtl(w.pdas, stranger.publicKey, 3600)])).to.throw(/NotOperator/)
      w.send(admin, [governIx.setOrderTtl(w.pdas, admin.publicKey, 3600)])
      w.setNow(NOW)
      await client.refresh()
    })

    it('v7.2 open: a token the hub left out is asked for from here; the hub’s SYNC brings the replica’s rent', async () => {
      expect(await client.replica(TOK3)).to.equal(null)
      const unit = await client.hubUnit()
      const rent = (bytes: number) => w.svm.minimumBalanceForRentExemption(BigInt(bytes))
      expect(unit.replicaRent).to.equal(rent(201) + rent(82))
      expect(unit.userAccountRent).to.equal(rent(245))
      expect(unit.suggested).to.equal(4_100_000n, 'the dearer rent plus about a tenth, rounded — at this cluster’s rent')
      // …and at mainnet's and devnet's (5,080 lamports a byte): 2,738,120 of rent → 3,000,000
      expect(suggestedHubUnit((128n + 201n + 128n + 82n) * 5_080n)).to.equal(3_000_000n)
      // the opener pays the message — and no rent: `send` checks the user
      // paid the LayerZero fee and the signature, nothing else
      const sent = await send(SENDS.open_token, { hubToken: TOK3 }, 1)
      expect(findSentToHub(sent.logs)!.op).to.equal(OP.OPEN)
      expect(w.lamports(w.pdas.replica(TOK3))).to.equal(0n, 'an open leaves nothing behind')
      expect(await client.replica(TOK3)).to.equal(null, 'only the hub’s SYNC creates the replica')

      // the hub answers with a SYNC that brings one unit of lamports: the
      // real executor delivers it with exactly that, the message pays for
      // the replica, and what it did not need is the tank's
      const [exec0, tank0] = [w.lamports(w.exec.publicKey), await client.tankBalance()]
      const s = await executeWith({ op: 'SYNC_TOKEN', hubToken: TOK3, name: 'LATECOMER', symbol: 'LATE' }, unit.suggested)
      measure(`[${label}] executor→lz_receive SYNC that brings its rent: ${s.cu} CU, ${s.size} B (unit ${unit.suggested}, rent ${unit.replicaRent} lamports)`)
      expect(exec0 - w.lamports(w.exec.publicKey)).to.equal(SIG_FEE + unit.suggested, 'the executor spent its signature and what the packet bought')
      expect((await client.tankBalance()) - tank0).to.equal(unit.suggested - unit.replicaRent)
      expect(findValueReceived(s.logs)).to.deep.equal([{ lamports: unit.suggested, toTank: unit.suggested - unit.replicaRent }])
      expect((await client.replica(TOK3))!.name).to.equal('LATECOMER')
      // it is open now: asking again is refused before anything is paid
      const again = await client.openToken(user.publicKey, { hubToken: TOK3 }, { maxNativeFee: 0n })
      expect(() => w.sendTx(again.tx, [user])).to.throw(/AlreadyOpen/)
    })

    it('v7.2 move: a claim the vault cannot pay leaves for another chain at that chain’s price', async () => {
      const short = (await client.vaultBalance()) + 40n * ONE
      await execute({ op: 'PAYOUT', to: user.publicKey.toBytes(), usdOut: splToE18(short) })
      const claim0 = (await client.userAccount(user.publicKey))!.usdClaim
      expect(claim0).to.equal(short)
      const total0 = decodeStore(w.account(w.pdas.store)!.data).claimsTotal

      // BNB is priced at 6 legs (fixtures.MOVE_LEGS): six reply budgets ride the message
      const sent = await send(SENDS.move_claim, { dstChain: CHAIN_LABEL.bnb, to: EVM_TO, units: 10n * ONE }, 6)
      const bnbFee = findSentToHub(sent.logs)!.nativeFee
      expect(findSentToHub(sent.logs)!.op).to.equal(OP.MOVE)
      expect((await client.userAccount(user.publicKey))!.usdClaim).to.equal(claim0 - 10n * ONE)
      expect(decodeStore(w.account(w.pdas.store)!.data).claimsTotal).to.equal(total0 - 10n * ONE)
      // the hub's own chain is one reply away; an L1 costs forty
      await send(SENDS.move_claim, { dstChain: CHAIN_LABEL.base, to: EVM_TO, units: ONE }, 1)
      const eth = await client.moveClaim(user.publicKey, { dstChain: CHAIN_LABEL.ethereum, to: EVM_TO, units: ONE })
      expect(eth.legs).to.equal(40)
      expect(eth.value).to.equal(RETURN_UNIT * 40n)
      expect(eth.quotedFee > bnbFee).to.equal(true, 'a dearer destination costs more')

      // a chain the operator never priced is closed: the client says so,
      // and so does the program
      let refused = ''
      await client.moveClaim(user.publicKey, { dstChain: CHAIN_LABEL.optimism, to: EVM_TO, units: ONE }).catch((e) => (refused = String(e)))
      expect(refused).to.match(/route is closed/)
      const ix = buildSendIx(SENDS.move_claim, client.context, user.publicKey, { dstChain: CHAIN_LABEL.optimism, to: EVM_TO, units: ONE }, 0n)
      expect(() => w.sendTx(assembleV0({ payer: user.publicKey, instructions: [ix], recentBlockhash: w.svm.latestBlockhash(), lookupTables: [client.table!], computeUnits: 700_000 }), [user])).to.throw(/RouteClosed/)
      // more than the claim: nothing is burned
      const all = (await client.userAccount(user.publicKey))!.usdClaim
      const over = await client.moveClaim(user.publicKey, { dstChain: CHAIN_LABEL.bnb, to: EVM_TO, units: all + 1n }, { maxNativeFee: 0n })
      expect(() => w.sendTx(over.tx, [user])).to.throw(/ClaimTooSmall/)
      expect((await client.userAccount(user.publicKey))!.usdClaim).to.equal(all)

      // the hub could not hand one on: it comes home as an ordinary PAYOUT
      // (a reply: no lamports) — a claim again while the vault is short
      const home = (await client.vaultBalance()) + ONE
      await execute({ op: 'PAYOUT', to: user.publicKey.toBytes(), usdOut: splToE18(home) })
      expect((await client.userAccount(user.publicKey))!.usdClaim).to.equal(all + home)
    })

    it('v7.2: a claim moved HERE for a recipient this chain never saw is booked for them — and brings what their account costs', async () => {
      const unit = (await client.hubUnit()).suggested
      const rent = w.svm.minimumBalanceForRentExemption(245n)
      const stranger = Keypair.generate().publicKey
      const [exec0, tank0] = [w.lamports(w.exec.publicKey), await client.tankBalance()]
      const p = await executeWith({ op: 'PAYOUT', to: stranger.toBytes(), usdOut: 25n * E18 }, unit)
      measure(`[${label}] executor→lz_receive moved PAYOUT to a recipient with no account: ${p.cu} CU, ${p.size} B (it brought ${unit} lamports; the account cost ${rent})`)
      const [paid] = findPaidOut(p.logs)
      expect([paid.to.toBase58(), paid.usdc, paid.claim]).to.deep.equal([stranger.toBase58(), 0n, 25n * ONE])
      const [opened] = findUserAccountOpened(p.logs)
      expect([opened.owner.toBase58(), opened.rentFrom]).to.deep.equal([stranger.toBase58(), 'message'])
      const ua = (await client.userAccount(stranger))!
      expect([ua.owner.toBase58(), ua.usdClaim]).to.deep.equal([stranger.toBase58(), 25n * ONE])
      expect(exec0 - w.lamports(w.exec.publicKey)).to.equal(SIG_FEE + unit, 'the executor spent its signature and what the packet bought')
      expect((await client.tankBalance()) - tank0).to.equal(unit - rent, 'the tank kept what the account did not cost')
      // not a wallet, not even an account: the executor resolves and
      // delivers each the same way
      for (const to of [w.pdas.store, client.store.vault, lzPda.endpointSettings()]) {
        await executeWith({ op: 'PAYOUT', to: to.toBytes(), usdOut: 25n * E18 }, unit)
        expect((await client.userAccount(to))!.usdClaim).to.equal(25n * ONE)
      }
      // a PAYOUT that brings nothing (a reply: a sale, a claim sent back —
      // or a hub whose unit for this chain was never set) for someone with
      // no account: the tank pays, as long as it can
      const other = Keypair.generate().publicKey
      const tank1 = await client.tankBalance()
      const q0 = await execute({ op: 'PAYOUT', to: other.toBytes(), usdOut: 25n * E18 })
      expect(findUserAccountOpened(q0.logs)[0].rentFrom).to.equal('tank')
      expect(tank1 - (await client.tankBalance())).to.equal(rent)
      // a recipient who holds a USDC account is simply paid (once the vault
      // can); the lamports the message brought and did not need are the tank's
      w.setTokenAmount(client.store.vault, 100n * ONE)
      const holder = Keypair.generate().publicKey
      w.giveUsdc(holder, 0n)
      const tank2 = await client.tankBalance()
      const q = await executeWith({ op: 'PAYOUT', to: holder.toBytes(), usdOut: 25n * E18 }, unit)
      expect(findPaidOut(q.logs)[0].usdc).to.equal(25n * ONE)
      expect(await client.userAccount(holder)).to.equal(null)
      expect((await client.tankBalance()) - tank2).to.equal(unit)
      w.setTokenAmount(client.store.vault, 0n)
    })

    it('a paused store refuses buys and spawns but never exits', async () => {
      w.send(admin, [governIx.pause(w.pdas, admin.publicKey)])
      const b = await client.buy(user.publicKey, { hubToken: TOK, usdcIn: ONE, minTokensOut: ANY_FILL }, { maxNativeFee: 0n })
      expect(() => w.sendTx(b.tx, [user])).to.throw(/Paused/)
      // an open is new exposure too…
      const o = await client.openToken(user.publicKey, { hubToken: toBytes32('0x' + '77'.repeat(20)) }, { maxNativeFee: 0n })
      expect(() => w.sendTx(o.tx, [user])).to.throw(/Paused/)
      // …a sale and a claim leaving for another chain are exits
      const s = await client.sell(user.publicKey, { hubToken: TOK, amount: ONE, minUsdcOut: ANY_FILL })
      w.sendTx(s.tx, [user])
      const m = await client.moveClaim(user.publicKey, { dstChain: CHAIN_LABEL.base, to: EVM_TO, units: ONE })
      w.sendTx(m.tx, [user])
      w.send(admin, [governIx.unpause(w.pdas, admin.publicKey)])
      expect(decodeStore(w.account(w.pdas.store)!.data).paused).to.equal(false)
    })

    it('without the lookup table a send does not fit a transaction', async () => {
      const ix = buildSendIx(SENDS.buy_token, client.context, user.publicKey, { hubToken: TOK, usdcIn: ONE, minTokensOut: ANY_FILL }, 0n)
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
    expect(() => buildSendIx(SENDS.buy_token, ctx, u, { hubToken: TOK, usdcIn: 0n, minTokensOut: 1n }, 0n)).to.throw(/ZeroAmount/)
    expect(() => buildSendIx(SENDS.sell_token, ctx, u, { hubToken: TOK, amount: 0n, minUsdcOut: 1n }, 0n)).to.throw(/ZeroAmount/)
    // v7.2: a trade names what it accepts
    expect(() => buildSendIx(SENDS.buy_token, ctx, u, { hubToken: TOK, usdcIn: 1n, minTokensOut: 0n }, 0n)).to.throw(/ZeroMinimum/)
    expect(() => buildSendIx(SENDS.sell_token, ctx, u, { hubToken: TOK, amount: 1n, minUsdcOut: 0n }, 0n)).to.throw(/ZeroMinimum/)
    expect(() => buildSendIx(SENDS.open_token, ctx, u, { hubToken: u.toBytes().fill(1) }, 0n)).to.throw(/BadTokenId/)
    for (const dstChain of [CHAIN_LABEL.solana, CHAIN_LABEL.hub]) {
      expect(() => buildSendIx(SENDS.move_claim, ctx, u, { dstChain, to: EVM_TO, units: 1n }, 0n)).to.throw(/BadDestination/)
    }
    expect(() => buildSendIx(SENDS.move_claim, ctx, u, { dstChain: 4, to: new Uint8Array(32), units: 1n }, 0n)).to.throw(/BadDestination/)
    expect(() => buildSendIx(SENDS.move_claim, ctx, u, { dstChain: 4, to: EVM_TO, units: 0n }, 0n)).to.throw(/ZeroAmount/)
    // a Solana-shaped key toward an EVM chain would only make the round trip
    expect(() => buildSendIx(SENDS.move_claim, ctx, u, { dstChain: 4, to: new Uint8Array(32).fill(7), units: 1n }, 0n)).to.throw(/20-byte address/)
    expect([OP.PULL_FEES, OP.OPEN, OP.MOVE]).to.deep.equal([5, 6, 7])
  })
})

after(() => {
  if (measurements.length) console.log('\n  measurements:\n' + measurements.map((m) => '    ' + m).join('\n'))
})
