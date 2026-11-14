const { expect } = require('chai')
const { ethers, network } = require('hardhat')
const { time } = require('@nomicfoundation/hardhat-network-helpers')
const {
  deployWorld,
  deployWorldAsync,
  fundUsd,
  fundUsdc,
  backing,
  U,
  GAS_TO_SPOKE,
  MOCK_GAS_TO_HUB,
} = require('../scripts/lib-deploy')

const E = (n) => ethers.parseEther(String(n))
const b32 = (a) => ethers.zeroPadValue(a, 32)
const coder = ethers.AbiCoder.defaultAbiCoder()
const bal = (who) => ethers.provider.getBalance(who.target ?? who.address ?? who)
const pastGenesis = () => time.increase(601)

/** The exact type-3 executor option the adapter must build. */
const opts = (gas, value = 0n) =>
  value > 0n
    ? ethers.solidityPacked(['uint16', 'uint8', 'uint16', 'uint8', 'uint128', 'uint128'], [3, 1, 33, 1, gas, value])
    : ethers.solidityPacked(['uint16', 'uint8', 'uint16', 'uint8', 'uint128'], [3, 1, 17, 1, gas])

/** The protocol opcode riding a queued packet. */
function opOf(pkt) {
  const [, , payload] = coder.decode(['bytes32', 'bytes32', 'bytes', 'uint256'], pkt.message)
  return Number(coder.decode(['uint8', 'bytes'], payload)[0])
}

/**
 * Transport economics (protocol v7): whoever causes a message pays for it and
 * for the replies it triggers; the hub tank funds itself from those prepaid
 * reply budgets; and the hub chain's own gateway trades by loopback, with no
 * LayerZero message at all.
 */
describe('Transport economics (protocol v7)', () => {
  let admin, user, user2, stranger

  beforeEach(async () => {
    ;[admin, user, user2, stranger] = await ethers.getSigners()
  })

  /* --------------------------- who pays for a message --------------------------- */

  describe('user-paid messages (the mainnet setting: nobody is sponsored but the pad)', () => {
    let w, op

    beforeEach(async () => {
      w = await deployWorldAsync({ sponsored: false })
      op = w.chains[5] // optimism — a remote chain
    })

    async function spawnFrom(chain, { dev = 0n, mode = 0, meta = '{}' } = {}) {
      const fee = await chain.gateway.quoteSpawn('GLOOP SUPREME', 'GLOOP', meta, dev > 0n)
      await (
        await chain.gateway.connect(user).spawnTokenUsdc('GLOOP SUPREME', 'GLOOP', meta, dev, mode, { value: fee })
      ).wait()
      await w.deliverAll()
      return w.pad.allTokens((await w.pad.tokensLength()) - 1n)
    }

    it('a buy and a sell are paid entirely by the user — no tank shrinks, the hub tank grows', async () => {
      const token = await spawnFrom(op)
      await pastGenesis()
      await fundUsdc(op, user, 1_000)
      const hub0 = await bal(w.hubMessenger)
      const spoke0 = await bal(op.messenger)

      // the fee is the outbound message plus one prepaid reply
      const fee = await op.gateway.quoteBuy()
      expect(fee).to.equal(w.FEE + w.RETURN_UNIT)
      await (await op.gateway.connect(user).buyTokenUsdc(token, U(100), { value: fee })).wait()
      // the user's value went straight to the endpoint: the spoke tank is untouched
      expect(await bal(op.messenger)).to.equal(spoke0)

      // leg 1 lands: the reply budget arrives WITH the message and pays the reply
      await (await w.endpoint.deliverNext()).wait()
      expect(await bal(w.hubMessenger)).to.equal(hub0 + w.RETURN_UNIT - w.FEE)
      await w.deliverAll()
      const rep = await ethers.getContractAt('SpawnToken', await op.gateway.replicaOf(token))
      const bag = await rep.balanceOf(user)
      expect(bag).to.be.gt(0n)

      const usdcMid = await op.usdc.balanceOf(user)
      await (await op.gateway.connect(user).sellToken(token, bag / 2n, { value: await op.gateway.quoteSell() })).wait()
      await w.deliverAll()
      expect(await op.usdc.balanceOf(user)).to.be.gt(usdcMid)

      // two round trips later: the spoke tank never moved, the hub tank is richer
      expect(await bal(op.messenger)).to.equal(spoke0)
      expect(await bal(w.hubMessenger)).to.equal(hub0 + 2n * (w.RETURN_UNIT - w.FEE))
    })

    it('a short fee reverts the whole call — nothing burned, nothing pulled, nothing sent', async () => {
      const token = await spawnFrom(op, { mode: 2 })
      await pastGenesis()
      await fundUsdc(op, user, 1_000)
      const fee = await op.gateway.quoteBuy()

      // USDC path: the vault pull is undone
      await expect(
        op.gateway.connect(user).buyTokenUsdc(token, U(100), { value: fee - 1n }),
      ).to.be.revertedWith('LZM: fee')
      expect(await op.usdc.balanceOf(user)).to.equal(U(1_000))
      expect(await op.usdc.balanceOf(op.usd.target)).to.equal(0n)

      // oUSD path: the burn is undone
      await (await op.usd.connect(user).wrap(U(200))).wait()
      await expect(op.gateway.connect(user).buyToken(token, E(100), { value: 0 })).to.be.revertedWith('LZM: fee')
      expect(await op.usd.balanceOf(user)).to.equal(E(200))

      // a spawn with a dev buy: the dev-buy pull is undone
      const spawnFee = await op.gateway.quoteSpawn('X', 'X', '{}', true)
      await expect(
        op.gateway.connect(user).spawnTokenUsdc('X', 'X', '{}', U(50), 0, { value: spawnFee - 1n }),
      ).to.be.revertedWith('LZM: fee')
      expect(await op.usdc.balanceOf(user)).to.equal(U(800))

      // a sell: the bag burn is undone
      await (await op.gateway.connect(user).buyTokenUsdc(token, U(100), { value: fee })).wait()
      await w.deliverAll()
      const rep = await ethers.getContractAt('SpawnToken', await op.gateway.replicaOf(token))
      const bag = await rep.balanceOf(user)
      await expect(op.gateway.connect(user).sellToken(token, bag, { value: 0 })).to.be.revertedWith('LZM: fee')
      expect(await rep.balanceOf(user)).to.equal(bag)

      // and a claim is a message like any other
      await expect(op.gateway.connect(user).claimFees(token)).to.be.revertedWith('LZM: fee')
      expect(await w.endpoint.pending()).to.equal(0n)
    })

    it('a surplus stays in the tank; a sponsored sender rides it', async () => {
      const token = await spawnFrom(op)
      await pastGenesis()
      await fundUsdc(op, user, 1_000)
      const fee = await op.gateway.quoteBuy()
      const spoke0 = await bal(op.messenger)

      await (await op.gateway.connect(user).buyTokenUsdc(token, U(10), { value: fee + E(0.005) })).wait()
      expect(await bal(op.messenger)).to.equal(spoke0 + E(0.005))
      await w.deliverAll()

      // the admin sponsors this gateway (how testnets run): value becomes
      // optional and the fee comes out of the tank
      await (await op.messenger.setSponsored(op.gateway.target, true)).wait()
      const spoke1 = await bal(op.messenger)
      await (await op.gateway.connect(user).buyTokenUsdc(token, U(10))).wait()
      expect(await bal(op.messenger)).to.equal(spoke1 - fee)
      await w.deliverAll()

      // sponsorship is a tank, not magic: empty it and the send fails
      await (await op.messenger.recover(admin.address)).wait()
      await expect(op.gateway.connect(user).buyTokenUsdc(token, U(10))).to.be.revertedWith('LZM: gas tank empty')
      expect(await op.usdc.balanceOf(user)).to.equal(U(980))
    })

    it('builds the exact executor options: gas only for a reply, gas + budget for 1 and N legs', async () => {
      await fundUsdc(op, user, 1_000)
      // a spawn with a dev buy prepays 5 SYNCs + 1 DELIVER
      const fee = await op.gateway.quoteSpawn('GLOOP SUPREME', 'GLOOP', '{}', true)
      expect(fee).to.equal(w.FEE + 6n * w.RETURN_UNIT)
      await (
        await op.gateway.connect(user).spawnTokenUsdc('GLOOP SUPREME', 'GLOOP', '{}', U(50), 0, { value: fee })
      ).wait()
      let pkt = await w.endpoint.peek(0)
      expect(opOf(pkt)).to.equal(1)
      expect(pkt.options).to.equal(opts(MOCK_GAS_TO_HUB, 6n * w.RETURN_UNIT))
      expect(pkt.value).to.equal(6n * w.RETURN_UNIT)

      // the hub's replies: five SYNCs and the dev-buy DELIVER, all gas-only
      await (await w.endpoint.deliverNext()).wait()
      expect(await w.endpoint.pending()).to.equal(6n)
      const ops = []
      for (let i = 0; i < 6; i++) {
        pkt = await w.endpoint.peek(i)
        ops.push(opOf(pkt))
        expect(pkt.options).to.equal(opts(GAS_TO_SPOKE))
        expect(pkt.options.length).to.equal(2 + 22 * 2) // 22 bytes
        expect(pkt.value).to.equal(0n)
      }
      expect(ops.sort((a, b) => a - b)).to.deep.equal([10, 10, 10, 10, 10, 11])
      await w.deliverAll()

      // a spawn without a dev buy prepays the 5 SYNCs only
      await (
        await op.gateway
          .connect(user)
          .spawnToken('PLAIN', 'PLN', '{}', 0, 0, { value: await op.gateway.quoteSpawn('PLAIN', 'PLN', '{}', false) })
      ).wait()
      pkt = await w.endpoint.peek(0)
      expect(pkt.options).to.equal(opts(MOCK_GAS_TO_HUB, 5n * w.RETURN_UNIT))
      await w.deliverAll()

      // a trade prepays exactly one reply
      const token = await w.pad.allTokens(0)
      await (await op.gateway.connect(user).buyTokenUsdc(token, U(10), { value: await op.gateway.quoteBuy() })).wait()
      pkt = await w.endpoint.peek(0)
      expect(opOf(pkt)).to.equal(2)
      expect(pkt.options).to.equal(opts(MOCK_GAS_TO_HUB, w.RETURN_UNIT))
      expect(pkt.options.length).to.equal(2 + 38 * 2) // 38 bytes
      await w.deliverAll()
    })

    it('a spawn prepays its whole SYNC fan-out: the hub tank comes out ahead', async () => {
      const hub0 = await bal(w.hubMessenger)
      await spawnFrom(op)
      // 5 reply budgets in, 5 SYNC fees out
      expect(await bal(w.hubMessenger)).to.equal(hub0 + 5n * (w.RETURN_UNIT - w.FEE))
      for (const c of w.chains) {
        expect(await c.gateway.replicaOf(await w.pad.allTokens(0))).to.not.equal(ethers.ZeroAddress)
      }
    })

    it('every quote is exactly what send requires — including a spawn, whose size depends on its strings', async () => {
      // make the endpoint charge per byte, like the real one
      await (await w.endpoint.setByteFee(ethers.parseUnits('1', 'gwei'))).wait()
      await fundUsdc(op, user, 1_000)

      const short = '{}'
      const long = JSON.stringify({ face: 'frog', lore: 'x'.repeat(400) })
      const qShort = await op.gateway.quoteSpawn('GLOOP SUPREME', 'GLOOP', short, false)
      const qLong = await op.gateway.quoteSpawn('GLOOP SUPREME', 'GLOOP', long, false)
      expect(qLong).to.be.gt(qShort)
      // the short quote does not cover the long spawn; one wei under fails; exact passes
      await expect(
        op.gateway.connect(user).spawnToken('GLOOP SUPREME', 'GLOOP', long, 0, 2, { value: qShort }),
      ).to.be.revertedWith('LZM: fee')
      await expect(
        op.gateway.connect(user).spawnToken('GLOOP SUPREME', 'GLOOP', long, 0, 2, { value: qLong - 1n }),
      ).to.be.revertedWith('LZM: fee')
      await (await op.gateway.connect(user).spawnToken('GLOOP SUPREME', 'GLOOP', long, 0, 2, { value: qLong })).wait()
      await w.deliverAll()
      const token = await w.pad.allTokens(0)
      await pastGenesis()

      const qBuy = await op.gateway.quoteBuy()
      await expect(
        op.gateway.connect(user).buyTokenUsdc(token, U(500), { value: qBuy - 1n }),
      ).to.be.revertedWith('LZM: fee')
      await (await op.gateway.connect(user).buyTokenUsdc(token, U(500), { value: qBuy })).wait()
      await w.deliverAll()

      const rep = await ethers.getContractAt('SpawnToken', await op.gateway.replicaOf(token))
      const bag = await rep.balanceOf(user)
      const qSell = await op.gateway.quoteSell()
      await expect(op.gateway.connect(user).sellToken(token, bag / 2n, { value: qSell - 1n })).to.be.revertedWith(
        'LZM: fee',
      )
      await (await op.gateway.connect(user).sellToken(token, bag / 2n, { value: qSell })).wait()
      await w.deliverAll()

      // fee mode 2: the creator has a dev pot to claim
      const qClaim = await op.gateway.quoteClaim()
      await expect(op.gateway.connect(user).claimFees(token, { value: qClaim - 1n })).to.be.revertedWith('LZM: fee')
      const before = await op.usdc.balanceOf(user)
      await (await op.gateway.connect(user).claimFees(token, { value: qClaim })).wait()
      await w.deliverAll()
      expect(await op.usdc.balanceOf(user)).to.be.gt(before)
    })

    it('an empty hub tank reverts the reply; the message stays queued and lands once refilled', async () => {
      const token = await spawnFrom(op)
      await pastGenesis()
      await fundUsdc(op, user, 1_000)
      // a mis-set reply budget (0) and a drained hub tank: the worst case
      await (await op.messenger.setDestination(0, MOCK_GAS_TO_HUB, 0)).wait()
      await (await w.hubMessenger.recover(admin.address)).wait()
      expect(await bal(w.hubMessenger)).to.equal(0n)

      await (await op.gateway.connect(user).buyTokenUsdc(token, U(100), { value: await op.gateway.quoteBuy() })).wait()
      await expect(w.endpoint.deliverNext()).to.be.revertedWith('LZM: gas tank empty')
      // nothing was consumed: the BUY is still queued, the money still in the vault
      expect(await w.endpoint.pending()).to.equal(1n)
      expect(await op.usdc.balanceOf(op.usd.target)).to.equal(U(100))

      await (await admin.sendTransaction({ to: w.hubMessenger.target, value: E(0.01) })).wait()
      await w.deliverAll()
      const rep = await ethers.getContractAt('SpawnToken', await op.gateway.replicaOf(token))
      expect(await rep.balanceOf(user)).to.be.gt(0n)
    })

    it('every op lands inside the executor gas it was sold, with headroom', async () => {
      await fundUsdc(op, user, 5_000)
      const used = {} // op -> max lzReceive gas seen
      async function drain() {
        while ((await w.endpoint.pending()) > 0n) {
          const op_ = opOf(await w.endpoint.peek(0))
          const rc = await (await w.endpoint.deliverNext()).wait()
          const ev = rc.logs
            .map((l) => {
              try {
                return w.endpoint.interface.parseLog(l)
              } catch {
                return null
              }
            })
            .find((e) => e?.name === 'PacketDelivered')
          used[op_] = ev.args.gasUsed > (used[op_] ?? 0n) ? ev.args.gasUsed : (used[op_] ?? 0n)
        }
      }
      // fee mode 0 (holders): the buys fill this chain's slice of the pot
      const fee = await op.gateway.quoteSpawn('GLOOP SUPREME', 'GLOOP', '{"face":"frog"}', true)
      await (
        await op.gateway
          .connect(user)
          .spawnTokenUsdc('GLOOP SUPREME', 'GLOOP', '{"face":"frog"}', U(50), 0, { value: fee })
      ).wait()
      await drain()
      const token = await w.pad.allTokens(0)
      await pastGenesis()
      for (let i = 0; i < 2; i++) {
        await (await op.gateway.connect(user).buyTokenUsdc(token, U(150), { value: await op.gateway.quoteBuy() })).wait()
        await drain()
      }
      const rep = await ethers.getContractAt('SpawnToken', await op.gateway.replicaOf(token))
      await (
        await op.gateway
          .connect(user)
          .sellToken(token, (await rep.balanceOf(user)) / 2n, { value: await op.gateway.quoteSell() })
      ).wait()
      await drain()
      // the holder-fee slice comes home when someone pulls it (v7)
      expect(await w.pad.pendingDrop(token, op.label)).to.be.gt(0n)
      await (await op.gateway.connect(user).pullFees(token, { value: await op.gateway.quotePull() })).wait()
      await drain()

      // spoke side (real work, no mock overhead): a replica deploy and three payouts
      expect(used[10]).to.be.lt(GAS_TO_SPOKE / 2n) // SYNC
      expect(used[11]).to.be.lt(GAS_TO_SPOKE / 4n) // DELIVER
      expect(used[12]).to.be.lt(GAS_TO_SPOKE / 4n) // PAYOUT
      expect(used[13]).to.be.lt(GAS_TO_SPOKE / 4n) // FEE_DROP
      // hub side (each includes the mock endpoint's ~0.5M per reply sent)
      expect(used[2]).to.be.lt(1_500_000n) // BUY
      expect(used[3]).to.be.lt(1_500_000n) // SELL
      expect(used[5]).to.be.lt(1_500_000n) // PULL_FEES
      // PRINT_GAS=1 npx hardhat test --grep "executor gas" prints the table SPEC §3 quotes
      if (process.env.PRINT_GAS) console.log('lzReceive gas by op:', used)
      expect(used[1]).to.be.lt(MOCK_GAS_TO_HUB) // SPAWN: 5 SYNCs + the dev-buy DELIVER
    })
  })

  /* ------------------------------ configuration ------------------------------ */

  describe('adapter configuration', () => {
    it('names the admin as LayerZero delegate at construction; only the admin can move it', async () => {
      const w = await deployWorldAsync()
      expect(await w.endpoint.delegates(w.hubMessenger.target)).to.equal(admin.address)
      for (const c of w.chains) {
        expect(await w.endpoint.delegates(c.messenger.target)).to.equal(admin.address)
      }
      await expect(w.hubMessenger.connect(stranger).setDelegate(stranger.address)).to.be.revertedWith('ROLES: not admin')
      await (await w.hubMessenger.setDelegate(user2.address)).wait()
      expect(await w.endpoint.delegates(w.hubMessenger.target)).to.equal(user2.address)
    })

    it('no setter is open: topology is the admin\'s, prices the operator\'s', async () => {
      const w = await deployWorldAsync()
      const m = w.hubMessenger.connect(stranger)
      await expect(m.register(stranger.address, 0)).to.be.revertedWith('ROLES: not admin')
      await expect(m.unregister(w.pad.target)).to.be.revertedWith('ROLES: not admin')
      await expect(m.setSponsored(stranger.address, true)).to.be.revertedWith('ROLES: not admin')
      await expect(m.setLocal(6, true)).to.be.revertedWith('ROLES: not admin')
      await expect(m.setRoute(6, 30_006, b32(stranger.address))).to.be.revertedWith('ROLES: not admin')
      await expect(m.repointRoute(6, 30_006, b32(stranger.address))).to.be.revertedWith('ROLES: not admin')
      await expect(m.recover(stranger.address)).to.be.revertedWith('ROLES: not admin')
      await expect(m.setDestination(6, 1, 1)).to.be.revertedWith('ROLES: not operator')
      await expect(w.chains[5].gateway.connect(stranger).setLegs(0, 0)).to.be.revertedWith('ROLES: not operator')

      const sync = await deployWorld()
      await expect(sync.messenger.connect(stranger).setFlatFee(1)).to.be.revertedWith('ROLES: not operator')
      await expect(sync.messenger.connect(stranger).setSponsored(stranger.address, true)).to.be.revertedWith(
        'ROLES: not admin',
      )
    })

    it('refuses to send over an unconfigured destination', async () => {
      const w = await deployWorldAsync()
      const fresh = await ethers.deployContract('LayerZeroOmniMessenger', [w.endpoint.target, 31_500])
      await (await w.endpoint.registerAdapter(fresh.target, 31_500)).wait()
      await (await fresh.register(user.address, 9)).wait()
      await expect(fresh.connect(user).send(0, b32(w.pad.target), '0x', 0)).to.be.revertedWith('LZM: no route')
      await (await fresh.setRoute(0, 30_000, b32(w.hubMessenger.target))).wait()
      await expect(fresh.connect(user).send(0, b32(w.pad.target), '0x', 0)).to.be.revertedWith('LZM: no gas limit')
    })
  })

  /* ------------------------- the simulated transport ------------------------- */

  describe('the simulated transport charges the same way', () => {
    it('a flat fee per message: users pay for the send and its replies, the pad rides free', async () => {
      const w = await deployWorld()
      const flat = E(0.001)
      await (await w.messenger.setFlatFee(flat)).wait()
      const c = w.chains[0]
      await fundUsdc(c, user, 1_000)

      // a spawn prepays the SYNC to all six chains; a trade one reply
      const qSpawn = await c.gateway.quoteSpawn('GLOOP SUPREME', 'GLOOP', '{}', false)
      expect(qSpawn).to.equal(flat * 7n)
      await expect(c.gateway.connect(user).spawnToken('GLOOP SUPREME', 'GLOOP', '{}', 0, 0)).to.be.revertedWith(
        'LOM: fee',
      )
      await (await c.gateway.connect(user).spawnToken('GLOOP SUPREME', 'GLOOP', '{}', 0, 0, { value: qSpawn })).wait()
      const token = await w.pad.allTokens(0)
      await pastGenesis()

      const qBuy = await c.gateway.quoteBuy()
      expect(qBuy).to.equal(flat * 2n)
      await expect(
        c.gateway.connect(user).buyTokenUsdc(token, U(100), { value: qBuy - 1n }),
      ).to.be.revertedWith('LOM: fee')
      expect(await c.usdc.balanceOf(user)).to.equal(U(1_000)) // nothing pulled
      await (await c.gateway.connect(user).buyTokenUsdc(token, U(100), { value: qBuy })).wait()
      const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
      expect(await rep.balanceOf(user)).to.be.gt(0n)

      // the pad's six SYNCs and its DELIVER cost it nothing: they were prepaid
      expect(await bal(w.messenger)).to.equal(qSpawn + qBuy)
    })
  })

  /* ------------------------------ hub-local trading ------------------------------ */

  describe('hub-local trading (Base rides the loopback)', () => {
    let w, base, op

    beforeEach(async () => {
      w = await deployWorldAsync({ sponsored: false })
      base = w.chains[2] // label 3 — lives on the hub chain
      op = w.chains[5]
      expect(base.local).to.equal(true)
      expect(base.messenger.target).to.equal(w.hubMessenger.target)
    })

    async function supplyAcrossChains(token) {
      let total = await (await ethers.getContractAt('SpawnToken', token)).totalSupply()
      for (const c of w.chains) {
        total += await (await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))).totalSupply()
      }
      return total
    }

    it('a whole token life on Base — spawn, buys, sell, holder drop, both claims — and not one packet after genesis', async () => {
      await fundUsdc(base, user, 2_000)
      await fundUsdc(base, user2, 2_000)

      // the only fee of a local spawn is the remote SYNC fan-out it causes
      const fee = await base.gateway.quoteSpawn('HOME TEAM', 'HOME', '{}', false)
      expect(fee).to.equal(5n * w.RETURN_UNIT)
      // fee mode 1: half to holders, half to the dev — both claim paths get used
      await (await base.gateway.connect(user).spawnToken('HOME TEAM', 'HOME', '{}', 0, 1, { value: fee })).wait()

      // genesis happened INSIDE that transaction: hub token and Base replica exist
      expect(await w.pad.tokensLength()).to.equal(1n)
      const token = await w.pad.allTokens(0)
      const rep = await ethers.getContractAt('SpawnToken', await base.gateway.replicaOf(token))
      expect(rep.target).to.not.equal(ethers.ZeroAddress)
      // the five remote chains get their SYNC packet — and nothing else flies
      expect(await w.endpoint.pending()).to.equal(5n)
      await w.deliverAll()
      const sent = await w.endpoint.packetsSent()
      await pastGenesis()

      // trading at home is free of messaging fees and settles in ONE transaction
      expect(await base.gateway.quoteBuy()).to.equal(0n)
      expect(await base.gateway.quoteSell()).to.equal(0n)
      expect(await base.gateway.quoteClaim()).to.equal(0n)
      await (await base.gateway.connect(user2).buyTokenUsdc(token, U(300))).wait()
      const bag = await rep.balanceOf(user2)
      expect(bag).to.be.gt(0n)

      // a second buy tips the holders pot over the $2 trigger: the drop lands
      // in Base's distributor by loopback, in the buyer's own transaction
      await (await base.gateway.connect(user).buyTokenUsdc(token, U(300))).wait()
      const owed = await base.dist.withdrawable(rep.target, user2.address)
      expect(owed).to.be.gt(0n)

      // sell: the USDC is back before the transaction ends
      const usdcBefore = await base.usdc.balanceOf(user2)
      await (await base.gateway.connect(user2).sellToken(token, bag / 2n)).wait()
      expect(await base.usdc.balanceOf(user2)).to.be.gt(usdcBefore)

      // holder claim (local by design) and dev claim (a message — here a loopback)
      const claimBefore = await base.usd.balanceOf(user2)
      await (await base.dist.connect(user2).claim(rep.target)).wait()
      expect(await base.usd.balanceOf(user2)).to.be.gt(claimBefore)
      const devBefore = await base.usdc.balanceOf(user)
      await (await base.gateway.connect(user).claimFees(token)).wait()
      expect(await base.usdc.balanceOf(user)).to.be.gt(devBefore)

      expect(await w.endpoint.packetsSent()).to.equal(sent)
      expect(await w.endpoint.pending()).to.equal(0n)
      const b = await backing(w)
      expect(b.supply).to.equal(b.usdc)
      expect(await supplyAcrossChains(token)).to.equal(E(1_000_000_000))
    })

    it('block 0 is now reachable on the hub chain: a same-block local buy bounces with a full USDC refund', async () => {
      await fundUsdc(base, user2, 100)
      const fee = await base.gateway.quoteSpawn('GUARDED', 'GRD', '{}', false)
      // the pad's first CREATE: the snipe can name the token before it exists
      const predicted = ethers.getCreateAddress({ from: w.pad.target, nonce: 1 })

      await network.provider.send('evm_setAutomine', [false])
      const txSpawn = await base.gateway.connect(user).spawnToken('GUARDED', 'GRD', '{}', 0, 0, { value: fee })
      const txSnipe = await base.gateway.connect(user2).buyTokenUsdc(predicted, U(50), { gasLimit: 3_000_000 })
      await network.provider.send('evm_mine')
      await network.provider.send('evm_setAutomine', [true])
      await txSpawn.wait()
      const rcpt = await txSnipe.wait()

      const token = await w.pad.allTokens(0)
      expect(token).to.equal(predicted)
      expect((await rcpt.getBlock()).number).to.equal(Number(await w.pad.spawnBlock(token)))

      // pulled into the vault and paid straight back out, in one transaction
      const rep = await ethers.getContractAt('SpawnToken', await base.gateway.replicaOf(token))
      expect(await rep.balanceOf(user2)).to.equal(0n)
      expect(await base.usdc.balanceOf(user2)).to.equal(U(100))
      expect(await base.usd.balanceOf(user2)).to.equal(0n)
      expect(await base.usdc.balanceOf(base.usd.target)).to.equal(0n)
      await expect(txSnipe).to.emit(w.pad, 'GenesisGuard')
      expect((await w.pad.feesOf(token)).total).to.equal(0n)
    })

    it('a local spawn with a dev buy hands the creator their bag in the same transaction', async () => {
      await fundUsdc(base, user, 500)
      // the dev buy adds no leg at home: its DELIVER is a local call
      const fee = await base.gateway.quoteSpawn('DEV BAG', 'DEV', '{}', true)
      expect(fee).to.equal(5n * w.RETURN_UNIT)
      await (await base.gateway.connect(user).spawnTokenUsdc('DEV BAG', 'DEV', '{}', U(50), 0, { value: fee })).wait()

      const token = await w.pad.allTokens(0)
      const rep = await ethers.getContractAt('SpawnToken', await base.gateway.replicaOf(token))
      expect(await rep.balanceOf(user)).to.be.gt(E(8_000_000)) // ~$50 at the opening price, untaxed
      expect(await base.usdc.balanceOf(user)).to.equal(U(450))
      expect(await w.pad.genesisSpent(token, b32(user.address))).to.equal(0n) // the exempt genesis buy
    })

    it('a locally-initiated spawn pays for the remote SYNCs it triggers', async () => {
      const hub0 = await bal(w.hubMessenger)
      const fee = await base.gateway.quoteSpawn('FAN OUT', 'FAN', '{}', false)
      await expect(
        base.gateway.connect(user).spawnToken('FAN OUT', 'FAN', '{}', 0, 0, { value: fee - 1n }),
      ).to.be.revertedWith('LZM: fee')
      expect(await w.pad.tokensLength()).to.equal(0n)

      await (await base.gateway.connect(user).spawnToken('FAN OUT', 'FAN', '{}', 0, 0, { value: fee })).wait()
      // five budgets in, five SYNC fees out — within the same transaction
      expect(await bal(w.hubMessenger)).to.equal(hub0 + 5n * (w.RETURN_UNIT - w.FEE))
      expect(await w.endpoint.pending()).to.equal(5n)
      for (let i = 0; i < 5; i++) expect(opOf(await w.endpoint.peek(i))).to.equal(10)

      const token = await w.pad.allTokens(0)
      await w.deliverAll()
      for (const c of w.chains) {
        expect(await c.gateway.replicaOf(token)).to.not.equal(ethers.ZeroAddress)
      }
    })

    it('a local buyer and a remote buyer move one curve; supply and backing stay exact across both', async () => {
      await (
        await base.gateway
          .connect(user)
          .spawnToken('ONE CURVE', 'ONE', '{}', 0, 0, { value: await base.gateway.quoteSpawn('ONE CURVE', 'ONE', '{}', false) })
      ).wait()
      await w.deliverAll()
      await pastGenesis()
      const token = await w.pad.allTokens(0)
      await fundUsdc(base, user, 1_000)
      await fundUsdc(op, user2, 1_000)
      const p0 = await w.pad.spotPrice(token)

      // local: the price moves in the buyer's own transaction
      await (await base.gateway.connect(user).buyTokenUsdc(token, U(200))).wait()
      const p1 = await w.pad.spotPrice(token)
      expect(p1).to.be.gt(p0)

      // remote: in flight until delivered, then the SAME curve moves again
      await (await op.gateway.connect(user2).buyTokenUsdc(token, U(200), { value: await op.gateway.quoteBuy() })).wait()
      expect(await w.pad.spotPrice(token)).to.equal(p1)
      await w.deliverAll()
      const p2 = await w.pad.spotPrice(token)
      expect(p2).to.be.gt(p1)

      const repBase = await ethers.getContractAt('SpawnToken', await base.gateway.replicaOf(token))
      const repOp = await ethers.getContractAt('SpawnToken', await op.gateway.replicaOf(token))
      const bagLocal = await repBase.balanceOf(user)
      const bagRemote = await repOp.balanceOf(user2)
      expect(bagLocal).to.be.gt(bagRemote) // same dollars, later = pricier
      expect(await w.pad.supplyByChain(token, 3)).to.equal(bagLocal)
      expect(await w.pad.supplyByChain(token, 6)).to.equal(bagRemote)
      expect(await supplyAcrossChains(token)).to.equal(E(1_000_000_000))
      let b = await backing(w)
      expect(b.supply).to.equal(b.usdc)

      // both exit: the remote seller's dollars come out of ITS chain's vault
      await (await op.gateway.connect(user2).sellToken(token, bagRemote, { value: await op.gateway.quoteSell() })).wait()
      await w.deliverAll()
      await (await base.gateway.connect(user).sellToken(token, bagLocal)).wait()
      expect(await w.pad.spotPrice(token)).to.be.lt(p1)
      expect(await supplyAcrossChains(token)).to.equal(E(1_000_000_000))
      b = await backing(w)
      expect(b.supply).to.equal(b.usdc)
    })

    it('the loopback vouches for exactly what a peered adapter would: a registered sender and its own label', async () => {
      const payload = coder.encode(
        ['uint8', 'bytes'],
        [2, coder.encode(['bytes32', 'bytes32', 'uint256', 'uint256'], [ethers.ZeroHash, b32(user.address), E(100), 0n])],
      )
      // not registered: cannot send at all
      await expect(w.hubMessenger.connect(stranger).send(0, b32(w.pad.target), payload, 0)).to.be.revertedWith(
        'LZM: unknown sender',
      )

      // registered under an unused label: the pad sees that label and refuses
      await (await w.hubMessenger.register(stranger.address, 9)).wait()
      await (await w.hubMessenger.setSponsored(stranger.address, true)).wait()
      await expect(w.hubMessenger.connect(stranger).send(0, b32(w.pad.target), payload, 0)).to.be.revertedWith(
        'PAD: not a gateway',
      )
      // even registered under Base's own label it is not Base's gateway
      await (await w.hubMessenger.register(stranger.address, 3)).wait()
      await expect(w.hubMessenger.connect(stranger).send(0, b32(w.pad.target), payload, 0)).to.be.revertedWith(
        'PAD: not a gateway',
      )

      // a loopback only ever calls a registered endpoint of the label named
      await expect(w.hubMessenger.connect(stranger).send(3, b32(user2.address), payload, 0)).to.be.revertedWith(
        'LZM: bad target',
      )
      await expect(w.hubMessenger.connect(stranger).send(0, b32(base.gateway.target), payload, 0)).to.be.revertedWith(
        'LZM: bad target',
      )
      await expect(
        w.hubMessenger.connect(stranger).send(3, '0x33' + 'ef'.repeat(31), payload, 0),
      ).to.be.revertedWith('LZM: bad target')

      // and nobody but the messenger reaches the pad or the gateway directly
      await expect(w.pad.connect(stranger).onOmniMessage(3, b32(base.gateway.target), payload)).to.be.revertedWith(
        'PAD: not messenger',
      )
      await expect(base.gateway.connect(stranger).onOmniMessage(0, b32(w.pad.target), payload)).to.be.revertedWith(
        'GW: not messenger',
      )
    })
  })
})
