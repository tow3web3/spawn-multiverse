const { expect } = require('chai')
const { ethers } = require('hardhat')
const { time, impersonateAccount, setBalance } = require('@nomicfoundation/hardhat-network-helpers')
const {
  deployWorld,
  deployWorldAsync,
  assignRoles,
  roleContracts,
  fundUsd,
  fundUsdc,
  worth,
  backing,
  SCALE,
  U,
} = require('../scripts/lib-deploy')

const E = (n) => ethers.parseEther(String(n))
const b32 = (a) => ethers.zeroPadValue(a, 32)
const coder = ethers.AbiCoder.defaultAbiCoder()
const bal = (who) => ethers.provider.getBalance(who.target ?? who.address ?? who)
const pastGenesis = () => time.increase(601)
const DAY = 24 * 3600
const DUST = E(0.000001)
const EID = (label) => 30_000 + label

/** A protocol payload: `abi.encode(uint8 op, bytes data)`. */
const msg = (op, types, values) => coder.encode(['uint8', 'bytes'], [op, coder.encode(types, values)])

/** The protocol opcode riding a queued packet, and its inner tuple. */
function unpack(pkt) {
  // the inter-adapter envelope: (source, target, payload, reply budget — v7.2)
  const [, , payload] = coder.decode(['bytes32', 'bytes32', 'bytes', 'uint256'], pkt.message)
  const [op, data] = coder.decode(['uint8', 'bytes'], payload)
  return { op: Number(op), data }
}
const opOf = (pkt) => unpack(pkt).op

async function as(address) {
  await impersonateAccount(address)
  await setBalance(address, E(1))
  return ethers.getSigner(address)
}

const replica = async (chain, token) => ethers.getContractAt('SpawnToken', await chain.gateway.replicaOf(token))

/**
 * Hardening (protocol v7, part 3): who can do what, what a pause stops, how
 * holder fees travel without anyone's charity, and the rule that a message
 * carrying a user's value never reverts — it is refused with a refund, or
 * parked for its owner.
 */
describe('Hardening (protocol v7)', () => {
  let admin, user, user2, stranger, operator, guardian, owner, attacker

  beforeEach(async () => {
    ;[admin, user, user2, stranger, operator, guardian, owner, attacker] = await ethers.getSigners()
  })

  /* ================================ roles ================================ */

  describe('roles', () => {
    it('admin moves in two steps on every contract; the adapter’s LayerZero delegate follows it', async () => {
      const w = await deployWorldAsync()
      const all = roleContracts(w)
      // pad, hub ledger, hub adapter + per chain: vault, gateway, holder pool (+ 5 remote adapters)
      expect(all.length).to.equal(3 + 6 * 3 + 5)

      for (const c of all) {
        expect(await c.admin()).to.equal(admin.address)
        await expect(c.connect(stranger).transferAdmin(stranger.address)).to.be.revertedWith('ROLES: not admin')

        // a typo is harmless: nothing moves until the nominee accepts, and
        // the nomination can be replaced
        await (await c.transferAdmin(stranger.address)).wait()
        expect(await c.admin()).to.equal(admin.address)
        await expect(c.transferAdmin(owner.address))
          .to.emit(c, 'AdminTransferStarted')
          .withArgs(admin.address, owner.address)
        expect(await c.pendingAdmin()).to.equal(owner.address)
        await expect(c.connect(stranger).acceptAdmin()).to.be.revertedWith('ROLES: not nominee')

        await expect(c.connect(owner).acceptAdmin())
          .to.emit(c, 'AdminTransferred')
          .withArgs(admin.address, owner.address)
        expect(await c.admin()).to.equal(owner.address)
        expect(await c.pendingAdmin()).to.equal(ethers.ZeroAddress)
        // the old admin is nobody now
        await expect(c.setOperator(admin.address)).to.be.revertedWith('ROLES: not admin')
        await expect(c.transferAdmin(admin.address)).to.be.revertedWith('ROLES: not admin')
      }

      // the DVN set is custody security: the right to choose it moved too
      expect(await w.endpoint.delegates(w.hubMessenger.target)).to.equal(owner.address)
      for (const c of w.chains) {
        expect(await w.endpoint.delegates(c.messenger.target)).to.equal(owner.address)
      }
    })

    it('a nomination can be cancelled; operator and guardian are named by the admin only', async () => {
      const w = await deployWorld()
      const c = w.chains[0].gateway
      await (await c.transferAdmin(owner.address)).wait()
      await (await c.transferAdmin(ethers.ZeroAddress)).wait()
      await expect(c.connect(owner).acceptAdmin()).to.be.revertedWith('ROLES: not nominee')

      for (const x of roleContracts(w)) {
        expect(await x.operator()).to.equal(ethers.ZeroAddress)
        expect(await x.guardian()).to.equal(ethers.ZeroAddress)
        await expect(x.connect(stranger).setOperator(stranger.address)).to.be.revertedWith('ROLES: not admin')
        await expect(x.connect(stranger).setGuardian(stranger.address)).to.be.revertedWith('ROLES: not admin')
        await expect(x.setOperator(operator.address)).to.emit(x, 'OperatorSet').withArgs(operator.address)
        await expect(x.setGuardian(guardian.address)).to.emit(x, 'GuardianSet').withArgs(guardian.address)
        // neither role can promote itself or anyone else
        await expect(x.connect(operator).setOperator(stranger.address)).to.be.revertedWith('ROLES: not admin')
        await expect(x.connect(guardian).setGuardian(stranger.address)).to.be.revertedWith('ROLES: not admin')
        await expect(x.connect(operator).transferAdmin(operator.address)).to.be.revertedWith('ROLES: not admin')
      }
    })

    it('the operator tunes prices and limits — and can touch neither topology nor custody', async () => {
      const w = await deployWorldAsync()
      await assignRoles(w, { operator, guardian })
      const op = w.chains[5] // optimism
      const arb = w.chains[4]
      const o = operator

      // ---- what the operator CAN do: every one of these leaves funds where they are
      await expect(op.messenger.connect(o).setDestination(0, 5_000_000, E(0.002)))
        .to.emit(op.messenger, 'DestinationSet')
        .withArgs(0, 5_000_000, E(0.002))
      await expect(op.gateway.connect(o).setLegs(2, 7)).to.emit(op.gateway, 'LegsSet').withArgs(2, 7)
      await expect(op.usd.connect(o).setDepositCap(U(25_000))).to.emit(op.usd, 'DepositCapSet').withArgs(U(25_000))
      // ... within hard bounds: an operator cannot make users prepay absurd budgets
      await expect(op.messenger.connect(o).setDestination(0, 5_000_000, E(0.051))).to.be.revertedWith(
        'LZM: unit too high',
      )
      await expect(op.gateway.connect(o).setLegs(5, 7)).to.be.revertedWith('GW: legs too high')
      await expect(op.gateway.connect(o).setLegs(1, 129)).to.be.revertedWith('GW: legs too high') // (128 since v7.2)

      // rebalancing: to a peer the ADMIN named, and nowhere else
      await fundUsd(op, user, 1_000)
      await expect(op.usd.connect(o).rebalance(arb.label, U(100))).to.be.revertedWith('oUSD: no peer')
      await (await op.usd.setPeer(arb.label, 3, b32(arb.usd.target))).wait()
      await (await op.usd.connect(o).rebalance(arb.label, U(400))).wait()
      expect((await op.cctp.lastCall()).mintRecipient).to.equal(b32(arb.usd.target))

      // ---- what the operator CANNOT do: everything that decides who is believed or who holds the money
      const adminOnly = [
        () => w.pad.connect(o).setGateway(9, b32(o.address)),
        () => w.pad.connect(o).setVenue(o.address),
        () => w.pad.connect(o).setAutoDrop(6, true),
        () => op.messenger.connect(o).register(o.address, 6),
        () => op.messenger.connect(o).unregister(op.gateway.target),
        () => op.messenger.connect(o).setRoute(4, 31_000, b32(o.address)),
        () => op.messenger.connect(o).repointRoute(0, 31_000, b32(o.address)),
        () => op.messenger.connect(o).setLocal(4, true),
        () => op.messenger.connect(o).setSponsored(op.gateway.target, true),
        () => op.messenger.connect(o).setDelegate(o.address),
        () => op.messenger.connect(o).recover(o.address),
        () => op.usd.connect(o).setAgent(o.address),
        () => op.usd.connect(o).setPeer(9, 3, b32(o.address)),
        () => w.hubUsd.connect(o).setAgent(o.address),
        () => op.dist.connect(o).setAgent(o.address),
        () => op.dist.connect(o).exclude(o.address),
        () => op.dist.connect(o).sealExclusions(),
        () => op.gateway.connect(o).setDistributor(o.address),
        () => op.gateway.connect(o).setGuardian(o.address),
        () => w.pad.connect(o).transferAdmin(o.address),
      ]
      for (const call of adminOnly) await expect(call()).to.be.revertedWith('ROLES: not admin')
    })

    it('the guardian can stop new exposure — and nothing else', async () => {
      const w = await deployWorldAsync()
      await assignRoles(w, { operator, guardian })
      const op = w.chains[5]
      const g = guardian

      await expect(w.pad.connect(stranger).pause()).to.be.revertedWith('ROLES: not guardian')
      await expect(op.gateway.connect(stranger).pause()).to.be.revertedWith('ROLES: not guardian')
      await expect(op.usd.connect(stranger).pauseDeposits()).to.be.revertedWith('ROLES: not guardian')

      await expect(w.pad.connect(g).pause()).to.emit(w.pad, 'Paused').withArgs(g.address)
      await expect(op.gateway.connect(g).pause()).to.emit(op.gateway, 'Paused').withArgs(g.address)
      await expect(op.usd.connect(g).pauseDeposits()).to.emit(op.usd, 'DepositsPaused').withArgs(g.address)

      // it cannot reopen anything, tune anything, or wire anything
      await expect(w.pad.connect(g).unpause()).to.be.revertedWith('ROLES: not operator')
      await expect(op.gateway.connect(g).unpause()).to.be.revertedWith('ROLES: not operator')
      await expect(op.usd.connect(g).unpauseDeposits()).to.be.revertedWith('ROLES: not operator')
      await expect(op.usd.connect(g).setDepositCap(0)).to.be.revertedWith('ROLES: not operator')
      await expect(op.usd.connect(g).rebalance(5, 1)).to.be.revertedWith('ROLES: not operator')
      await expect(op.gateway.connect(g).setLegs(0, 0)).to.be.revertedWith('ROLES: not operator')
      await expect(op.messenger.connect(g).setDestination(0, 1, 0)).to.be.revertedWith('ROLES: not operator')
      await expect(op.messenger.connect(g).recover(g.address)).to.be.revertedWith('ROLES: not admin')

      // the operator and the admin can pause too, and only they reopen
      await expect(w.pad.connect(operator).unpause()).to.emit(w.pad, 'Unpaused').withArgs(operator.address)
      await (await w.pad.connect(operator).pause()).wait()
      await (await w.pad.unpause()).wait()
      await (await op.gateway.connect(operator).unpause()).wait()
      await (await op.usd.connect(operator).unpauseDeposits()).wait()
      expect(await w.pad.paused()).to.equal(false)
      // a ledger instance has no deposits to pause
      await expect(w.hubUsd.connect(g).pauseDeposits()).to.be.revertedWith('oUSD: ledger only')
    })
  })

  /* ============================== the timelock ============================== */

  describe('admin behind a real TimelockController', () => {
    let w, timelock, all, op

    /** The mainnet hand-over, exactly as the deploy tooling will run it. */
    beforeEach(async () => {
      w = await deployWorldAsync({ sponsored: false })
      op = w.chains[5]
      all = roleContracts(w)
      // operator (the owner's Safe, acting directly) and guardian (a hot key)
      // are named while the deployer is still admin
      await assignRoles(w, { operator: owner, guardian })

      // 1. a timelock with NO delay yet, the deployer as its only proposer/executor
      timelock = await ethers.deployContract('SpawnTimelock', [0, [admin.address], [admin.address], admin.address])
      // 2. every contract nominates it...
      for (const c of all) await (await c.transferAdmin(timelock.target)).wait()
      // 3. ...and it accepts them all in one batch (possible only because the delay is still 0)
      const targets = all.map((c) => c.target)
      const zeros = all.map(() => 0)
      const accepts = all.map((c) => c.interface.encodeFunctionData('acceptAdmin'))
      const salt = ethers.id('spawn/handover')
      await (await timelock.scheduleBatch(targets, zeros, accepts, ethers.ZeroHash, salt, 0)).wait()
      await (await timelock.executeBatch(targets, zeros, accepts, ethers.ZeroHash, salt)).wait()
      // 4. it raises its own delay to 48h
      const raise = timelock.interface.encodeFunctionData('updateDelay', [2 * DAY])
      await (await timelock.schedule(timelock.target, 0, raise, ethers.ZeroHash, salt, 0)).wait()
      await (await timelock.execute(timelock.target, 0, raise, ethers.ZeroHash, salt)).wait()
      // 5. the owner's Safe proposes and executes, an independent guardian can
      //    veto, and the deployer keeps nothing
      const [PROPOSER, EXECUTOR, CANCELLER, ROLE_ADMIN] = await Promise.all([
        timelock.PROPOSER_ROLE(),
        timelock.EXECUTOR_ROLE(),
        timelock.CANCELLER_ROLE(),
        timelock.DEFAULT_ADMIN_ROLE(),
      ])
      await (await timelock.grantRole(PROPOSER, owner.address)).wait()
      await (await timelock.grantRole(EXECUTOR, owner.address)).wait()
      await (await timelock.grantRole(CANCELLER, guardian.address)).wait()
      for (const role of [PROPOSER, EXECUTOR, CANCELLER, ROLE_ADMIN]) {
        await (await timelock.renounceRole(role, admin.address)).wait()
      }
    })

    it('the bootstrap hand-over leaves the timelock as admin and LayerZero delegate everywhere, and the deployer with nothing', async () => {
      expect(await timelock.getMinDelay()).to.equal(BigInt(2 * DAY))
      for (const c of all) {
        expect(await c.admin()).to.equal(timelock.target)
        await expect(c.setOperator(admin.address)).to.be.revertedWith('ROLES: not admin')
      }
      expect(await w.endpoint.delegates(w.hubMessenger.target)).to.equal(timelock.target)
      expect(await w.endpoint.delegates(op.messenger.target)).to.equal(timelock.target)

      const call = w.pad.interface.encodeFunctionData('setGateway', [9, b32(admin.address)])
      await expect(
        timelock.schedule(w.pad.target, 0, call, ethers.ZeroHash, ethers.ZeroHash, 2 * DAY),
      ).to.be.revertedWithCustomError(timelock, 'AccessControlUnauthorizedAccount')
      await expect(
        timelock.grantRole(await timelock.PROPOSER_ROLE(), admin.address),
      ).to.be.revertedWithCustomError(timelock, 'AccessControlUnauthorizedAccount')

      // the protocol still works end to end under its new admin
      const fee = await op.gateway.quoteSpawn('STILL ALIVE', 'ALIVE', '{}', false)
      await (await op.gateway.connect(user).spawnToken('STILL ALIVE', 'ALIVE', '{}', 0, 0, { value: fee })).wait()
      await w.deliverAll()
      expect(await w.pad.tokensLength()).to.equal(1n)
    })

    it('a hostile topology change is public and not executable before the delay — and an independent key can veto it', async () => {
      // Assume the worst: the owner's Safe itself is compromised.
      const evil = b32(attacker.address)
      const hostile = [
        // a new vault "peer" that is the attacker: the way out of a vault
        { on: op.usd, fn: 'setPeer', args: [77, 3, evil] },
        // the hub's seat on a spoke re-pointed: whoever sits there can forge a PAYOUT
        { on: op.messenger, fn: 'repointRoute', args: [0, 31_337, evil] },
        // a new gateway label on the pad: it can mint value into the hub's books
        { on: w.pad, fn: 'setGateway', args: [9, evil] },
      ].map((h) => ({ ...h, data: h.on.interface.encodeFunctionData(h.fn, h.args) }))
      const salt = ethers.id('hostile')

      for (const h of hostile) {
        // not directly — the Safe is only the operator
        await expect(h.on.connect(owner)[h.fn](...h.args)).to.be.revertedWith('ROLES: not admin')
        // not with a shortened delay
        await expect(
          timelock.connect(owner).schedule(h.on.target, 0, h.data, ethers.ZeroHash, salt, DAY),
        ).to.be.revertedWithCustomError(timelock, 'TimelockInsufficientDelay')
        // only as a scheduled operation, announced on-chain for 48h
        h.id = await timelock.hashOperation(h.on.target, 0, h.data, ethers.ZeroHash, salt)
        await expect(timelock.connect(owner).schedule(h.on.target, 0, h.data, ethers.ZeroHash, salt, 2 * DAY))
          .to.emit(timelock, 'CallScheduled')
          .withArgs(h.id, 0, h.on.target, 0, h.data, ethers.ZeroHash, 2 * DAY)
        expect(await timelock.isOperationPending(h.id)).to.equal(true)
        expect(await timelock.isOperationReady(h.id)).to.equal(false)
        await expect(
          timelock.connect(owner).execute(h.on.target, 0, h.data, ethers.ZeroHash, salt),
        ).to.be.revertedWithCustomError(timelock, 'TimelockUnexpectedOperationState')
      }

      // one hour before the deadline: still nothing has changed anywhere
      await time.increase(2 * DAY - 3600)
      expect((await op.usd.peers(77)).vault).to.equal(ethers.ZeroHash)
      expect(await op.messenger.eidOf(0)).to.equal(BigInt(EID(0)))
      expect(await op.messenger.peers(EID(0))).to.equal(b32(w.hubMessenger.target))
      expect(await w.pad.gateways(9)).to.equal(ethers.ZeroHash)
      await expect(op.usd.connect(owner).rebalance(77, U(1))).to.be.revertedWith('oUSD: no peer')

      // the guardian's key is independent of the Safe: it vetoes the vault drain
      await expect(timelock.connect(owner).cancel(hostile[0].id)).to.be.revertedWithCustomError(
        timelock,
        'AccessControlUnauthorizedAccount',
      )
      await (await timelock.connect(guardian).cancel(hostile[0].id)).wait()
      await time.increase(3600 + 1)
      await expect(
        timelock.connect(owner).execute(hostile[0].on.target, 0, hostile[0].data, ethers.ZeroHash, salt),
      ).to.be.revertedWithCustomError(timelock, 'TimelockUnexpectedOperationState')
      expect((await op.usd.peers(77)).vault).to.equal(ethers.ZeroHash)

      // What nobody vetoed DOES execute once the delay has run: the timelock
      // buys users 48 public hours to leave, not immunity from a hostile admin.
      await (await timelock.connect(owner).execute(w.pad.target, 0, hostile[2].data, ethers.ZeroHash, salt)).wait()
      expect(await w.pad.gateways(9)).to.equal(evil)
    })
  })

  /* ================================= pause ================================= */

  describe('pause', () => {
    it('a paused gateway refuses new exposure only: sells, claims, pulls and unwraps stay open', async () => {
      const w = await deployWorld()
      await assignRoles(w, { operator, guardian })
      const A = w.chains[1]
      const B = w.chains[4]
      // a dev-fee token created by `user`, with `user2` holding a bag on A
      await (await A.gateway.connect(user).spawnToken('BRAKES', 'BRK', '{}', 0, 2)).wait()
      await pastGenesis()
      const token = await w.pad.allTokens(0)
      await fundUsdc(A, user2, 1_000)
      await fundUsdc(B, user2, 1_000)
      await (await A.gateway.connect(user2).buyTokenUsdc(token, U(300))).wait()
      await (await A.usd.connect(user2).wrap(U(100))).wait()
      const rep = await replica(A, token)
      const bag = await rep.balanceOf(user2)

      await (await A.gateway.connect(guardian).pause()).wait()
      expect(await A.gateway.paused()).to.equal(true)

      // NEW exposure: all four entry points refuse, atomically
      await expect(A.gateway.connect(user2).buyTokenUsdc(token, U(10))).to.be.revertedWith('GW: paused')
      await expect(A.gateway.connect(user2).buyToken(token, E(10))).to.be.revertedWith('GW: paused')
      await expect(A.gateway.connect(user2).spawnToken('X', 'X', '{}', 0, 0)).to.be.revertedWith('GW: paused')
      await expect(A.gateway.connect(user2).spawnTokenUsdc('X', 'X', '{}', U(5), 0)).to.be.revertedWith('GW: paused')
      expect(await A.usdc.balanceOf(user2)).to.equal(U(600))

      // EXITS: every one still works
      const usdcBefore = await A.usdc.balanceOf(user2)
      await (await A.gateway.connect(user2).sellToken(token, bag / 2n)).wait()
      expect(await A.usdc.balanceOf(user2)).to.be.gt(usdcBefore)
      const devBefore = await worth(A, user)
      await (await A.gateway.connect(user).claimFees(token)).wait()
      expect(await worth(A, user)).to.be.gt(devBefore)
      await (await A.gateway.connect(stranger).pullFees(token)).wait() // nothing waiting — still not blocked
      await (await A.usd.connect(user2).unwrap(E(100))).wait()

      // a pause is per gateway: the same token still trades from another chain
      await (await B.gateway.connect(user2).buyTokenUsdc(token, U(50))).wait()

      await (await A.gateway.connect(operator).unpause()).wait()
      await (await A.gateway.connect(user2).buyTokenUsdc(token, U(10))).wait()
    })

    it('paused deposits stop new USDC at the vault; unwrap and payout cannot be paused at all', async () => {
      const w = await deployWorld()
      await assignRoles(w, { operator, guardian })
      const A = w.chains[1]
      await (await A.gateway.connect(user).spawnToken('VAULT STOP', 'STOP', '{}', 0, 2)).wait()
      await pastGenesis()
      const token = await w.pad.allTokens(0)
      await fundUsdc(A, user2, 1_000)
      await (await A.gateway.connect(user2).buyTokenUsdc(token, U(200))).wait()
      await (await A.usd.connect(user2).wrap(U(100))).wait()

      await (await A.usd.connect(guardian).pauseDeposits()).wait()
      await expect(A.usd.connect(user2).wrap(U(1))).to.be.revertedWith('oUSD: deposits paused')
      await expect(A.gateway.connect(user2).buyTokenUsdc(token, U(1))).to.be.revertedWith('oUSD: deposits paused')

      // money already inside keeps moving, and keeps coming OUT
      await (await A.gateway.connect(user2).buyToken(token, E(50))).wait() // oUSD already held: no new USDC
      const rep = await replica(A, token)
      const usdcBefore = await A.usdc.balanceOf(user2)
      await (await A.gateway.connect(user2).sellToken(token, await rep.balanceOf(user2))).wait() // payout()
      expect(await A.usdc.balanceOf(user2)).to.be.gt(usdcBefore)
      await (await A.usd.connect(user2).unwrap(E(50))).wait()

      // no function named pause/unpause reaches the exits
      const names = A.usd.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name)
      expect(names.filter((n) => /pause/i.test(n)).sort()).to.deep.equal([
        'depositsPaused', 'pauseDeposits', 'unpauseDeposits',
      ])
    })

    it('a paused hub reverts nothing: an in-flight buy bounces whole, an in-flight spawn is refused and refunded, sells and claims continue', async () => {
      const w = await deployWorldAsync()
      await assignRoles(w, { operator, guardian })
      const op = w.chains[5]
      const base = w.chains[2]

      // a dev-fee token by `user`; `user2` holds a bag on Optimism
      await (await op.gateway.connect(user).spawnToken('IN FLIGHT', 'FLY', '{}', 0, 2)).wait()
      await w.deliverAll()
      await pastGenesis()
      const token = await w.pad.allTokens(0)
      await fundUsdc(op, user2, 1_000)
      await fundUsdc(op, user, 500)
      await (await op.gateway.connect(user2).buyTokenUsdc(token, U(200))).wait()
      await w.deliverAll()
      const rep = await replica(op, token)
      const bag = await rep.balanceOf(user2)
      const ledger = await w.hubUsd.totalSupply()

      // two messages leave an UNPAUSED spoke... and the hub pauses before they land
      await (await op.gateway.connect(user2).buyTokenUsdc(token, U(100))).wait()
      await (await op.gateway.connect(user).spawnTokenUsdc('TOO LATE', 'LATE', '{}', U(50), 0)).wait()
      expect(await w.endpoint.pending()).to.equal(2n)
      await (await w.pad.connect(guardian).pause()).wait()

      // the BUY: refused (reason 1 = paused), no trade, no guard event
      const buyLanding = w.endpoint.deliverNext()
      await expect(buyLanding)
        .to.emit(w.pad, 'Refused')
        .withArgs(2, op.label, b32(token), b32(user2.address), E(100), 1)
      await expect(buyLanding).to.not.emit(w.pad, 'Trade')
      await expect(buyLanding).to.not.emit(w.pad, 'GenesisGuard')
      // the SPAWN: refused, no token, its dev buy on the way home
      await expect(w.endpoint.deliverNext())
        .to.emit(w.pad, 'Refused')
        .withArgs(1, op.label, ethers.ZeroHash, b32(user.address), E(50), 1)
      expect(await w.pad.tokensLength()).to.equal(1n)
      await w.deliverAll()

      // both came home in full, as USDC; the hub's books never moved
      expect(await op.usdc.balanceOf(user2)).to.equal(U(800))
      expect(await op.usdc.balanceOf(user)).to.equal(U(500))
      expect(await rep.balanceOf(user2)).to.equal(bag)
      expect(await w.hubUsd.totalSupply()).to.equal(ledger)
      let b = await backing(w)
      expect(b.supply).to.equal(b.usdc)

      // EXITS keep working through a paused hub
      await (await op.gateway.connect(user2).sellToken(token, bag / 2n)).wait()
      await w.deliverAll()
      expect(await op.usdc.balanceOf(user2)).to.be.gt(U(800))
      await (await op.gateway.connect(user).claimFees(token)).wait()
      await w.deliverAll()
      expect(await op.usdc.balanceOf(user)).to.be.gt(U(500))

      // at home the bounce happens inside the buyer's own transaction
      await fundUsdc(base, user2, 100)
      await (await base.gateway.connect(user2).buyTokenUsdc(token, U(40))).wait()
      expect(await base.usdc.balanceOf(user2)).to.equal(U(100))
      b = await backing(w)
      expect(b.supply).to.equal(b.usdc)

      // only the operator (or the admin) reopens
      await expect(w.pad.connect(guardian).unpause()).to.be.revertedWith('ROLES: not operator')
      await (await w.pad.connect(operator).unpause()).wait()
      await (await op.gateway.connect(user2).buyTokenUsdc(token, U(100))).wait()
      await w.deliverAll()
      expect(await rep.balanceOf(user2)).to.be.gt(bag / 2n)
    })
  })

  /* ====================== holder fees: accrue, then pull ====================== */

  describe('holder fees accrue on the hub and are pulled by whoever wants them', () => {
    let w, base, arb, op

    beforeEach(async () => {
      w = await deployWorldAsync({ sponsored: false }) // the mainnet setting
      base = w.chains[2]
      arb = w.chains[4]
      op = w.chains[5]
    })

    /** Delivers everything, recording every op that crossed the wire. */
    async function drain(seen = new Set()) {
      while ((await w.endpoint.pending()) > 0n) {
        seen.add(opOf(await w.endpoint.peek(0)))
        await (await w.endpoint.deliverNext()).wait()
      }
      return seen
    }

    /** A holders-mode token spawned at home, held on Base, Arbitrum and
     * Optimism — $9 of fees, three distributions. */
    async function threeChainToken(seen) {
      const fee = await base.gateway.quoteSpawn('SPLIT ME', 'SPLIT', '{}', false)
      await (await base.gateway.connect(user).spawnToken('SPLIT ME', 'SPLIT', '{}', 0, 0, { value: fee })).wait()
      await drain(seen)
      await pastGenesis()
      const token = await w.pad.allTokens((await w.pad.tokensLength()) - 1n)
      await fundUsdc(base, user, 2_000)
      await fundUsdc(arb, stranger, 2_000)
      await fundUsdc(op, user2, 2_000)
      await (await base.gateway.connect(user).buyTokenUsdc(token, U(300))).wait()
      await (await arb.gateway.connect(stranger).buyTokenUsdc(token, U(300), { value: await arb.gateway.quoteBuy() })).wait()
      await drain(seen)
      await (await op.gateway.connect(user2).buyTokenUsdc(token, U(300), { value: await op.gateway.quoteBuy() })).wait()
      await drain(seen)
      return token
    }

    it('a trade never makes the hub ship a holder drop to a remote chain: the slice is booked, the home chain alone is paid at once', async () => {
      const seen = new Set()
      const token = await threeChainToken(seen)

      const f = await w.pad.feesOf(token)
      expect(f.holders).to.equal(E(9))
      expect(f.holdersPaid).to.be.closeTo(E(9), DUST)
      const waitingArb = await w.pad.pendingDrop(token, arb.label)
      const waitingOp = await w.pad.pendingDrop(token, op.label)
      expect(waitingArb).to.be.gt(0n)
      expect(waitingOp).to.be.gt(0n)
      // home is `autoDrop`: its slices landed in its distributor by loopback
      expect(await w.pad.pendingDrop(token, base.label)).to.equal(0n)
      const shippedHome = await base.usd.balanceOf(base.dist.target)
      expect(shippedHome).to.be.gt(0n)
      // every cent that left the pot is either home or booked — to the wei
      expect(shippedHome + waitingArb + waitingOp).to.equal(f.holdersPaid)
      // the booked part is still in the hub's books, fully backed
      expect(await w.hubUsd.balanceOf(w.pad.target)).to.be.gte(waitingArb + waitingOp)
      const b = await backing(w)
      expect(b.supply).to.equal(b.usdc)

      // not one FEE_DROP (13) crossed the wire — only the messages users paid for
      expect([...seen].sort((a, b) => a - b)).to.deep.equal([2, 10, 11])
      expect(await arb.usd.balanceOf(arb.dist.target)).to.equal(0n)
      expect(await op.usd.balanceOf(op.dist.target)).to.equal(0n)
    })

    it('anyone can pull a chain’s slice home by paying the round trip; holders then claim locally', async () => {
      const token = await threeChainToken()
      const waiting = await w.pad.pendingDrop(token, op.label)
      const rep = await replica(op, token)

      // priced like any trade: the outbound message plus one prepaid reply
      const q = await op.gateway.quotePull()
      expect(q).to.equal(w.FEE + w.RETURN_UNIT)
      await expect(op.gateway.connect(stranger).pullFees(token, { value: q - 1n })).to.be.revertedWith('LZM: fee')

      // `stranger` holds nothing on Optimism: pulling is a public service
      const hub0 = await bal(w.hubMessenger)
      const ledger0 = await w.hubUsd.totalSupply()
      await (await op.gateway.connect(stranger).pullFees(token, { value: q })).wait()
      expect(opOf(await w.endpoint.peek(0))).to.equal(5)
      await expect(w.endpoint.deliverNext()).to.emit(w.pad, 'FeesPulled').withArgs(token, op.label, waiting)
      expect(await w.pad.pendingDrop(token, op.label)).to.equal(0n)
      // the slice left the hub's books and rides one FEE_DROP toward Optimism
      expect(await w.hubUsd.totalSupply()).to.equal(ledger0 - waiting)
      expect(await w.endpoint.pending()).to.equal(1n)
      const drop = unpack(await w.endpoint.peek(0))
      expect(drop.op).to.equal(13)
      expect(coder.decode(['bytes32', 'uint256'], drop.data)[1]).to.equal(waiting)
      await (await w.endpoint.deliverNext()).wait()
      // paid for by the puller: the hub tank came out ahead
      expect(await bal(w.hubMessenger)).to.equal(hub0 + w.RETURN_UNIT - w.FEE)

      // it landed in Optimism's pool for Optimism's holders — here, user2 alone
      expect(await op.usd.balanceOf(op.dist.target)).to.equal(waiting)
      const owed = await op.dist.withdrawable(rep.target, user2.address)
      expect(owed).to.be.closeTo(waiting, DUST)
      await (await op.dist.connect(user2).claim(rep.target)).wait()
      const usdcBefore = await op.usdc.balanceOf(user2)
      await (await op.usd.connect(user2).unwrap(owed)).wait()
      expect((await op.usdc.balanceOf(user2)) - usdcBefore).to.equal(owed / SCALE)
      const b = await backing(w)
      expect(b.supply).to.equal(b.usdc)
    })

    it('a pull also settles the part of the pot not split yet', async () => {
      const token = await threeChainToken()
      await (await op.gateway.connect(stranger).pullFees(token, { value: await op.gateway.quotePull() })).wait()
      await drain()
      expect(await w.pad.pendingDrop(token, op.label)).to.equal(0n)

      // a $50 buy adds $0.50 to the pot: under the $2 trigger, so nothing is split
      await (await op.gateway.connect(user2).buyTokenUsdc(token, U(50), { value: await op.gateway.quoteBuy() })).wait()
      await drain()
      const f = await w.pad.feesOf(token)
      expect(f.holders - f.holdersPaid).to.be.closeTo(E(0.5), DUST)
      expect(await w.pad.pendingDrop(token, op.label)).to.equal(0n)

      // the puller gets everything due as of now, not as of the last trigger
      const before = await op.usd.balanceOf(op.dist.target)
      await (await op.gateway.connect(stranger).pullFees(token, { value: await op.gateway.quotePull() })).wait()
      await drain()
      const got = (await op.usd.balanceOf(op.dist.target)) - before
      expect(got).to.be.gt(0n)
      expect(got).to.be.lt(E(0.5)) // Optimism's share of it; the rest went home or waits for Arbitrum
      const f2 = await w.pad.feesOf(token)
      expect(f2.holders - f2.holdersPaid).to.be.lt(DUST)
    })

    it('a pull with nothing waiting sends nothing and reverts nothing; an unknown token never leaves the chain', async () => {
      // a dev-fee token has no holders pot at all
      await (
        await op.gateway
          .connect(user)
          .spawnToken('NO POT', 'NOPOT', '{}', 0, 2, { value: await op.gateway.quoteSpawn('NO POT', 'NOPOT', '{}', false) })
      ).wait()
      await drain()
      const token = await w.pad.allTokens(0)
      const hub0 = await bal(w.hubMessenger)

      await (await op.gateway.connect(user).pullFees(token, { value: await op.gateway.quotePull() })).wait()
      await expect(w.endpoint.deliverNext())
        .to.emit(w.pad, 'Refused')
        .withArgs(5, op.label, b32(token), ethers.ZeroHash, 0, 5)
      expect(await w.endpoint.pending()).to.equal(0n) // no reply: the prepaid budget stays in the tank
      expect(await bal(w.hubMessenger)).to.equal(hub0 + w.RETURN_UNIT)

      // a token this chain has no replica of cannot be pulled, claimed or bought here
      const bogus = ethers.Wallet.createRandom().address
      await expect(op.gateway.pullFees(bogus, { value: E(1) })).to.be.revertedWith('GW: unknown token')
      await expect(op.gateway.claimFees(bogus, { value: E(1) })).to.be.revertedWith('GW: unknown token')

      // and if one reached the hub anyway (injected as the adapter): refused, not reverted
      const hubAdapter = await as(w.hubMessenger.target)
      await expect(
        w.pad.connect(hubAdapter).onOmniMessage(op.label, b32(op.gateway.target), msg(5, ['bytes32'], [b32(bogus)])),
      )
        .to.emit(w.pad, 'Refused')
        .withArgs(5, op.label, b32(bogus), ethers.ZeroHash, 0, 2)
    })

    it('every remote message the hub sends is prepaid: through a long mixed scenario the hub tank never dips', async () => {
      const hub0 = await bal(w.hubMessenger)
      let last = hub0
      let hubSends = 0
      /** Delivers one packet at a time; the hub tank must never go down. */
      async function settle() {
        while ((await w.endpoint.pending()) > 0n) {
          const pkt = await w.endpoint.peek(0)
          if (Number(pkt.srcEid) === EID(0)) hubSends++
          await (await w.endpoint.deliverNext()).wait()
          const now = await bal(w.hubMessenger)
          expect(now).to.be.gte(last)
          last = now
        }
        // local (loopback) actions settle inside the caller's transaction
        const now = await bal(w.hubMessenger)
        expect(now).to.be.gte(last)
        last = now
      }

      const traders = [user, user2, stranger]
      const chains = [base, arb, op, w.chains[1]] // + ethereum
      for (const c of chains) for (const t of traders) await fundUsdc(c, t, 20_000)

      const tokens = []
      for (let round = 0; round < 4; round++) {
        // a spawn from a different chain each round, every fee mode, with and without a dev buy
        const home = chains[round % chains.length]
        const dev = traders[round % traders.length]
        const withDev = round % 2 === 0
        const name = `ROUND ${round}`
        const fee = await home.gateway.quoteSpawn(name, `R${round}`, '{}', withDev)
        await (
          await home.gateway
            .connect(dev)
            .spawnTokenUsdc(name, `R${round}`, '{}', withDev ? U(40) : 0, round % 4, { value: fee })
        ).wait()
        await settle()
        const token = await w.pad.allTokens((await w.pad.tokensLength()) - 1n)
        tokens.push({ token, dev, home })

        // early buys pay the snipe tax: big fees, many distributions
        for (const c of chains) {
          for (const t of traders) {
            await (await c.gateway.connect(t).buyTokenUsdc(token, U(120), { value: await c.gateway.quoteBuy() })).wait()
            await settle()
          }
        }
        await pastGenesis()
        for (const c of chains) {
          const rep = await replica(c, token)
          for (const t of traders) {
            const bag = await rep.balanceOf(t)
            if (bag === 0n) continue
            await (await c.gateway.connect(t).sellToken(token, bag / 2n, { value: await c.gateway.quoteSell() })).wait()
            await settle()
          }
        }
        // the dev claims from a chain that is not home; everyone pulls and claims
        const claimFrom = chains[(round + 1) % chains.length]
        await (await claimFrom.gateway.connect(dev).claimFees(token, { value: await claimFrom.gateway.quoteClaim() })).wait()
        await settle()
        for (const c of chains) {
          await (await c.gateway.connect(stranger).pullFees(token, { value: await c.gateway.quotePull() })).wait()
          await settle()
          const rep = await replica(c, token)
          for (const t of traders) {
            if ((await c.dist.withdrawable(rep.target, t.address)) > 0n) {
              await (await c.dist.connect(t).claim(rep.target)).wait()
            }
          }
        }
      }

      // the hub sent a lot — and every one of those messages had been paid for
      expect(hubSends).to.be.gt(80)
      expect(last).to.be.gt(hub0)
      // nothing is left waiting on the hub for the chains that pulled
      for (const { token } of tokens) {
        for (const c of chains) expect(await w.pad.pendingDrop(token, c.label)).to.equal(0n)
      }
      const b = await backing(w)
      expect(b.supply).to.equal(b.usdc)
    })

    it('the simulated network can run the mainnet way too: nothing ships until pulled', async () => {
      const sync = await deployWorld({ autoDrop: false })
      const c = sync.chains[1]
      await (await c.gateway.connect(user).spawnToken('PULL ME', 'PULL', '{}', 0, 0)).wait()
      await pastGenesis()
      const token = await sync.pad.allTokens(0)
      await fundUsdc(c, user, 1_000)
      await (await c.gateway.connect(user).buyTokenUsdc(token, U(300))).wait() // $3 of fees
      const rep = await replica(c, token)
      expect(await sync.pad.pendingDrop(token, c.label)).to.equal(E(3))
      expect(await c.dist.withdrawable(rep.target, user.address)).to.equal(0n)

      await expect(c.gateway.connect(user).pullFees(token)).to.emit(c.dist, 'FeeDropped').withArgs(rep.target, E(3))
      expect(await c.dist.withdrawable(rep.target, user.address)).to.be.closeTo(E(3), DUST)
      const b = await backing(sync)
      expect(b.supply).to.equal(b.usdc)
    })
  })

  /* ============================ ordering & parking ============================ */

  describe('a message from the hub is parked, never reverted', () => {
    it('F-2: a DELIVER that lands before its SYNC parks the bag; the owner claims it once the replica exists', async () => {
      const w = await deployWorldAsync()
      const op = w.chains[5]
      await fundUsdc(op, user, 500)
      await fundUsdc(op, user2, 500)
      // a spawn with a dev buy: the hub sends 5 SYNCs and the creator's DELIVER
      await (await op.gateway.connect(user).spawnTokenUsdc('RACE', 'RACE', '{}', U(50), 0)).wait()
      await (await w.endpoint.deliverNext()).wait()
      const token = await w.pad.allTokens(0)
      expect(await w.endpoint.pending()).to.equal(6n)

      // the network promises no order: land the DELIVER first
      let at = -1
      for (let i = 0; i < 6; i++) if (opOf(await w.endpoint.peek(i)) === 11) at = i
      expect(at).to.be.gte(0)
      const bag = coder.decode(['bytes32', 'bytes32', 'uint256', 'uint256'], unpack(await w.endpoint.peek(at)).data)[2]
      await expect(w.endpoint.deliverAt(at))
        .to.emit(op.gateway, 'DeliveryParked')
        .withArgs(token, user.address, bag)
      expect(await op.gateway.replicaOf(token)).to.equal(ethers.ZeroAddress)
      expect(await op.gateway.pendingDelivery(token, user.address)).to.equal(bag)
      await expect(op.gateway.connect(user).claimPending(token)).to.be.revertedWith('GW: no replica')

      // the SYNCs land; the bag is still parked — and only its owner can take it
      await w.deliverAll()
      const rep = await replica(op, token)
      expect(await rep.totalSupply()).to.equal(0n)
      await expect(op.gateway.connect(stranger).claimPending(token)).to.be.revertedWith('GW: nothing pending')
      await expect(op.gateway.connect(user).claimPending(token))
        .to.emit(op.gateway, 'DeliveryClaimed')
        .withArgs(token, user.address, bag)
      expect(await rep.balanceOf(user)).to.equal(bag)
      expect(await op.gateway.pendingDelivery(token, user.address)).to.equal(0n)
      await expect(op.gateway.connect(user).claimPending(token)).to.be.revertedWith('GW: nothing pending')

      // the hub's ledger matches the chain again (S2) and supply is conserved (S1)
      expect(await w.pad.supplyByChain(token, op.label)).to.equal(await rep.totalSupply())
      let total = await (await ethers.getContractAt('SpawnToken', token)).totalSupply()
      for (const c of w.chains) total += await (await replica(c, token)).totalSupply()
      expect(total).to.equal(E(1_000_000_000))

      // shares that appeared late earn from then on, like any others
      await pastGenesis()
      await (await op.gateway.connect(user2).buyTokenUsdc(token, U(300))).wait()
      await w.deliverAll()
      await (await op.gateway.connect(user2).pullFees(token)).wait()
      await w.deliverAll()
      const lateHolder = await op.dist.withdrawable(rep.target, user.address)
      const other = await op.dist.withdrawable(rep.target, user2.address)
      expect(lateHolder).to.be.gt(0n)
      expect(lateHolder + other).to.be.closeTo(await op.usd.balanceOf(op.dist.target), DUST)
    })

    /** One gateway whose "pad" is a signer, so a test can play the hub. */
    async function gatewayHarness({ brickable = false } = {}) {
      const hub = owner
      const messenger = await ethers.deployContract('LocalOmniMessenger')
      const usdc = await ethers.deployContract('MockUSDC')
      const usd = await ethers.deployContract('OmniUSD', [4, usdc.target, ethers.ZeroAddress])
      await (await usd.setDepositCap(U(1_000_000))).wait()
      const gateway = await ethers.deployContract('SpawnGateway', [messenger.target, usd.target, 4, hub.address])
      await (await usd.setAgent(gateway.target)).wait()
      await (await messenger.register(gateway.target, 4)).wait()
      await (await messenger.register(hub.address, 0)).wait()
      await (await messenger.setSponsored(hub.address, true)).wait()
      let dist
      if (brickable) {
        dist = await ethers.deployContract('BrickableDistributor')
      } else {
        dist = await ethers.deployContract('FeeDistributor', [usd.target])
        await (await dist.setAgent(gateway.target)).wait()
      }
      const fromHub = (payload) => messenger.connect(hub).send(4, b32(gateway.target), payload, 0)
      const sync = (hubToken, name = 'LATE') =>
        fromHub(msg(10, ['bytes32', 'string', 'string'], [b32(hubToken), name, name]))
      const deliver = (hubToken, to, tokens, refund = 0n) =>
        fromHub(msg(11, ['bytes32', 'bytes32', 'uint256', 'uint256'], [b32(hubToken), b32(to.address), tokens, refund]))
      const feeDrop = (hubToken, amount) => fromHub(msg(13, ['bytes32', 'uint256'], [b32(hubToken), amount]))
      return { messenger, usdc, usd, gateway, dist, fromHub, sync, deliver, feeDrop }
    }

    it('a FEE_DROP with no replica to book it under waits, and the SYNC flushes it', async () => {
      const h = await gatewayHarness()
      await (await h.gateway.setDistributor(h.dist.target)).wait()
      const hubToken = ethers.Wallet.createRandom().address

      await expect(h.feeDrop(hubToken, E(7))).to.emit(h.gateway, 'FeeDropParked').withArgs(hubToken, E(7))
      await (await h.feeDrop(hubToken, E(3))).wait() // parked drops add up
      expect(await h.gateway.pendingFeeDrop(hubToken)).to.equal(E(10))
      expect(await h.usd.totalSupply()).to.equal(0n) // not minted until it can be booked
      await expect(h.gateway.flushFeeDrop(hubToken)).to.be.revertedWith('GW: nothing to flush')

      await expect(h.sync(hubToken)).to.emit(h.gateway, 'FeeDropFlushed').withArgs(hubToken, E(10))
      const rep = await ethers.getContractAt('SpawnToken', await h.gateway.replicaOf(hubToken))
      expect(await h.gateway.pendingFeeDrop(hubToken)).to.equal(0n)
      expect(await h.usd.balanceOf(h.dist.target)).to.equal(E(10))
      expect(await h.dist.pendingOf(rep.target)).to.equal(E(10)) // no holder yet: the pool holds it

      // the first real holders receive it
      await (await h.deliver(hubToken, user, E(5_000))).wait()
      expect(await h.dist.withdrawable(rep.target, user.address)).to.be.closeTo(E(10), DUST)
    })

    it('a gateway wired without its holder pool deploys no replica (a loud, retryable wiring error) and parks fee drops', async () => {
      const h = await gatewayHarness()
      const hubToken = ethers.Wallet.createRandom().address
      // a replica born without a pool could never be given one: the SYNC
      // refuses instead — it carries no user value and stays retryable
      await expect(h.sync(hubToken)).to.be.revertedWith('GW: no distributor')
      expect(await h.gateway.replicaOf(hubToken)).to.equal(ethers.ZeroAddress)
      // value-carrying messages still never revert: they park
      await expect(h.feeDrop(hubToken, E(4))).to.emit(h.gateway, 'FeeDropParked').withArgs(hubToken, E(4))
      await expect(h.deliver(hubToken, user, E(2_000)))
        .to.emit(h.gateway, 'DeliveryParked')
        .withArgs(hubToken, user.address, E(2_000))

      // the admin fixes the wiring; the SYNC is retried and everything settles
      await (await h.gateway.setDistributor(h.dist.target)).wait()
      await expect(h.sync(hubToken)).to.emit(h.gateway, 'FeeDropFlushed').withArgs(hubToken, E(4))
      expect(await h.usd.balanceOf(h.dist.target)).to.equal(E(4))
      await (await h.gateway.connect(user).claimPending(hubToken)).wait()
      const rep = await ethers.getContractAt('SpawnToken', await h.gateway.replicaOf(hubToken))
      expect(await h.dist.withdrawable(rep.target, user.address)).to.be.closeTo(E(4), DUST)
      // anyone can flush a parked drop by hand too; here there is nothing left
      await expect(h.gateway.connect(stranger).flushFeeDrop(hubToken)).to.be.revertedWith('GW: nothing to flush')
    })

    it('a parked DELIVER still settles its refund at once; a second SYNC cannot orphan a replica', async () => {
      const h = await gatewayHarness()
      await (await h.gateway.setDistributor(h.dist.target)).wait()
      const hubToken = ethers.Wallet.createRandom().address

      await expect(h.deliver(hubToken, user, E(1_000), E(3)))
        .to.emit(h.gateway, 'DeliveryParked')
        .withArgs(hubToken, user.address, E(1_000))
      expect(await h.usd.balanceOf(user)).to.equal(E(3)) // the refund did not wait (an oUSD claim: this vault is empty)

      await expect(h.sync(hubToken, 'FIRST')).to.emit(h.gateway, 'ReplicaDeployed')
      const first = await h.gateway.replicaOf(hubToken)
      await (await h.gateway.connect(user).claimPending(hubToken)).wait()
      // a replayed SYNC is ignored: same replica, the holder's bag intact
      await expect(h.sync(hubToken, 'SECOND')).to.not.emit(h.gateway, 'ReplicaDeployed')
      expect(await h.gateway.replicaOf(hubToken)).to.equal(first)
      const rep = await ethers.getContractAt('SpawnToken', first)
      expect(await rep.name()).to.equal('FIRST')
      expect(await rep.balanceOf(user)).to.equal(E(1_000))
    })

    it('a mint or a drop that fails for ANY reason parks instead of stranding what the hub already debited', async () => {
      const h = await gatewayHarness({ brickable: true })
      await (await h.gateway.setDistributor(h.dist.target)).wait()
      const hubToken = ethers.Wallet.createRandom().address
      await (await h.sync(hubToken)).wait()
      const rep = await ethers.getContractAt('SpawnToken', await h.gateway.replicaOf(hubToken))

      // the holder pool starts reverting — the transfer hook AND drop()
      await (await h.dist.setBricked(true)).wait()
      await expect(rep.connect(user).transfer(user2.address, 0)).to.be.revertedWith('BRICK: hook')

      await expect(h.deliver(hubToken, user, E(2_000), E(5)))
        .to.emit(h.gateway, 'DeliveryParked')
        .withArgs(hubToken, user.address, E(2_000))
      expect(await rep.balanceOf(user)).to.equal(0n)
      expect(await h.usd.balanceOf(user)).to.equal(E(5))
      await expect(h.feeDrop(hubToken, E(6))).to.emit(h.gateway, 'FeeDropParked').withArgs(hubToken, E(6))
      expect(await h.usd.balanceOf(h.dist.target)).to.equal(0n)
      // while the cause lasts, the claims fail atomically and stay parked
      await expect(h.gateway.connect(user).claimPending(hubToken)).to.be.revertedWith('BRICK: hook')
      await expect(h.gateway.flushFeeDrop(hubToken)).to.be.revertedWith('GW: nothing to flush')

      // once it is fixed, nothing was lost
      await (await h.dist.setBricked(false)).wait()
      await (await h.gateway.connect(user).claimPending(hubToken)).wait()
      expect(await rep.balanceOf(user)).to.equal(E(2_000))
      await (await h.gateway.flushFeeDrop(hubToken)).wait()
      expect(await h.usd.balanceOf(h.dist.target)).to.equal(E(6))
      expect(await h.dist.dropped()).to.equal(E(6))
    })

    it('what stays a revert on the gateway is corruption only: a recipient no EVM account can be', async () => {
      const h = await gatewayHarness()
      const hubToken = ethers.Wallet.createRandom().address
      const wide = '0x11' + 'ab'.repeat(31)
      await expect(
        h.fromHub(msg(11, ['bytes32', 'bytes32', 'uint256', 'uint256'], [b32(hubToken), wide, E(1), 0])),
      ).to.be.revertedWith('GW: bad recipient')
      await expect(h.fromHub(msg(12, ['bytes32', 'uint256'], [wide, E(1)]))).to.be.revertedWith('GW: bad recipient')
      await expect(h.fromHub(msg(99, ['uint256'], [1]))).to.be.revertedWith('GW: bad op')
    })
  })

  /* ======================= refuse at the door, refund at the hub ======================= */

  describe('what the hub would refuse', () => {
    let world, A, hubSide

    beforeEach(async () => {
      world = await deployWorld()
      A = world.chains[3] // bnb, label 4
      hubSide = await as(world.messenger.target)
    })

    /** Lands a payload on the pad as if `chain`'s gateway had sent it. */
    const inject = (chain, payload) =>
      world.pad.connect(hubSide).onOmniMessage(chain.label, b32(chain.gateway.target), payload)

    it('is refused by the gateway first, where a revert costs the user nothing', async () => {
      await fundUsd(A, user, 1_000)
      // a fee mode the hub does not know
      await expect(A.gateway.connect(user).spawnToken('BAD', 'BAD', '{}', E(50), 4)).to.be.revertedWith(
        'GW: bad fee mode',
      )
      await expect(A.gateway.connect(user).spawnTokenUsdc('BAD', 'BAD', '{}', 0, 255)).to.be.revertedWith(
        'GW: bad fee mode',
      )
      // strings sized to exhaust the gas a spawn message bought
      const fits = (n) => 'x'.repeat(n)
      await expect(A.gateway.connect(user).spawnToken(fits(65), 'OK', '{}', 0, 0)).to.be.revertedWith(
        'GW: string too long',
      )
      await expect(A.gateway.connect(user).spawnToken('OK', fits(17), '{}', 0, 0)).to.be.revertedWith(
        'GW: string too long',
      )
      await expect(A.gateway.connect(user).spawnToken('OK', 'OK', fits(1025), 0, 0)).to.be.revertedWith(
        'GW: string too long',
      )
      expect(await A.usd.balanceOf(user)).to.equal(E(1_000)) // the dev buy never moved
      // ... and exactly at the limits it goes through
      await (await A.gateway.connect(user).spawnToken(fits(64), fits(16), fits(1024), 0, 3)).wait()
      const token = await world.pad.allTokens(0)
      await pastGenesis()

      // dust the curve could round to nothing
      await expect(A.gateway.connect(user).buyToken(token, 10n ** 12n - 1n)).to.be.revertedWith('GW: dust')
      await (await A.gateway.connect(user).buyToken(token, E(10))).wait()
      await expect(A.gateway.connect(user).sellToken(token, 10n ** 12n - 1n)).to.be.revertedWith('GW: dust')
      await (await A.gateway.connect(user).sellToken(token, 10n ** 12n)).wait()

      // a token this chain does not know
      const bogus = ethers.Wallet.createRandom().address
      await expect(A.gateway.connect(user).buyToken(bogus, E(1))).to.be.revertedWith('GW: unknown token')
    })

    it('the string caps keep the largest legal spawn inside the gas its message bought', async () => {
      const w = await deployWorldAsync()
      const op = w.chains[5]
      await fundUsdc(op, user, 500)
      const big = (n) => 'x'.repeat(n)
      await (await op.gateway.connect(user).spawnTokenUsdc(big(64), big(16), big(1024), U(50), 0)).wait()
      const rc = await (await w.endpoint.deliverNext()).wait()
      const landed = rc.logs.map((l) => w.endpoint.interface.parseLog(l)).find((e) => e?.name === 'PacketDelivered')
      expect(await w.pad.tokensLength()).to.equal(1n)
      // the mock burns ~0.52M per send it stores (6 here: 5 SYNCs + the dev-buy DELIVER) where the
      // real endpoint burns ~0.2M; net of that, the hub's own work must fit the 4M bought on mainnet
      const hubWork = landed.args.gasUsed - 6n * 520_000n
      if (process.env.PRINT_GAS) console.log('max-size spawn: lzReceive gas', landed.args.gasUsed, 'hub work ≈', hubWork)
      expect(hubWork + 6n * 200_000n).to.be.lt(4_000_000n)
      await w.deliverAll()
      for (const c of w.chains) expect(await c.gateway.replicaOf(await w.pad.allTokens(0))).to.not.equal(ethers.ZeroAddress)
    })

    it('a spawn the hub cannot accept creates nothing and sends its dev buy home', async () => {
      const before = await worth(A, user)
      const spawn = msg(
        1,
        ['bytes32', 'string', 'string', 'string', 'uint256', 'uint8'],
        [b32(user.address), 'BAD MODE', 'BAD', '{}', E(50), 9],
      )
      await expect(inject(A, spawn))
        .to.emit(world.pad, 'Refused')
        .withArgs(1, A.label, ethers.ZeroHash, b32(user.address), E(50), 3)
      expect(await world.pad.tokensLength()).to.equal(0n)
      expect((await worth(A, user)) - before).to.equal(E(50))
      expect(await world.hubUsd.totalSupply()).to.equal(0n)
    })

    it('a buy for a token the hub never spawned is refunded; a sell or a claim for one changes nothing', async () => {
      const ghost = ethers.Wallet.createRandom().address
      const before = await worth(A, user)
      // (v7.2: a BUY and a SELL carry two more words, the trader's minimum and the order's deadline; 0 = none)
      await expect(inject(A, msg(2, ['bytes32', 'bytes32', 'uint256', 'uint256', 'uint256'], [b32(ghost), b32(user.address), E(80), 0n, 0n])))
        .to.emit(world.pad, 'Refused')
        .withArgs(2, A.label, b32(ghost), b32(user.address), E(80), 2)
      expect((await worth(A, user)) - before).to.equal(E(80))

      await expect(inject(A, msg(3, ['bytes32', 'bytes32', 'uint256', 'uint256', 'uint256'], [b32(ghost), b32(user.address), E(5), 0n, 0n])))
        .to.emit(world.pad, 'Refused')
        .withArgs(3, A.label, b32(ghost), b32(user.address), E(5), 2)
      await expect(inject(A, msg(4, ['bytes32', 'bytes32'], [b32(ghost), b32(user.address)])))
        .to.emit(world.pad, 'Refused')
        .withArgs(4, A.label, b32(ghost), b32(user.address), 0, 2)
      expect(await worth(A, user)).to.equal(before + E(80))
      expect(await world.hubUsd.totalSupply()).to.equal(0n)
    })

    it('a sell the curve cannot price hands the bag back instead of reverting', async () => {
      await (await A.gateway.connect(user).spawnToken('DUSTY', 'DUST', '{}', 0, 2)).wait()
      await pastGenesis()
      const token = await world.pad.allTokens(0)
      const rep = await replica(A, token)
      // 1 wei of token is worth less than 1 wei of oUSD: the gateway's floor
      // stops it at the door, so land it on the hub directly
      const sell = msg(3, ['bytes32', 'bytes32', 'uint256', 'uint256', 'uint256'], [b32(token), b32(user.address), 1n, 0n, 0n])
      await expect(inject(A, sell))
        .to.emit(world.pad, 'Refused')
        .withArgs(3, A.label, b32(token), b32(user.address), 1, 6)
      expect(await rep.balanceOf(user)).to.equal(1n) // re-delivered
      expect((await world.pad.feesOf(token)).total).to.equal(0n)
    })

    it('F-5: a buy the curve caps pays the fee on what it actually spent, and the rest comes home', async () => {
      await (await A.gateway.connect(user).spawnToken('CAPPED', 'CAP', '{}', 0, 2)).wait()
      await pastGenesis()
      const token = await world.pad.allTokens(0)
      await fundUsdc(A, user2, 40_000)

      // $30,000 into a curve that sells out for ~$17.6k
      await (await A.gateway.connect(user2).buyTokenUsdc(token, U(30_000))).wait()
      const curve = await world.pad.curves(token)
      expect(curve.ascended).to.equal(true)
      const spend = curve.vBase // ascension leaves exactly the real dollars raised
      expect(spend).to.be.gt(E(17_000))
      expect(spend).to.be.lt(E(18_000))

      // the fee is 1% of the SPEND, not of the intent ($300)
      const fee = (await world.pad.feesOf(token)).total
      expect(fee).to.equal((spend * 100n) / 10_000n)
      expect(fee).to.be.lt(E(180))
      // and the buyer got back everything else, to the micro-dollar
      const paid = U(40_000) - (await A.usdc.balanceOf(user2))
      const dust = await A.usd.balanceOf(user2) // sub-USDC remainder of the refund
      expect(paid * SCALE - dust).to.equal(spend + fee)
      const b = await backing(world)
      expect(b.supply).to.equal(b.usdc)
    })
  })

  describe('a venue that says no', () => {
    let fw, c, token, rep

    beforeEach(async () => {
      fw = await deployWorld({ venueName: 'FlakyVenue' })
      c = fw.chains[1]
      await (await c.gateway.connect(user).spawnToken('FLAKY', 'FLK', '{}', 0, 3)).wait() // burn mode
      await pastGenesis()
      token = await fw.pad.allTokens(0)
      rep = await replica(c, token)
      await fundUsdc(c, user2, 2_000)
      await (await c.gateway.connect(user2).buyTokenUsdc(token, U(300))).wait() // burn pot: $3
    })

    it('bounces a buy whole and hands a sold bag back — reason 6, no revert, nothing lost', async () => {
      const bag = await rep.balanceOf(user2)
      await (await fw.venue.setRefuse(true)).wait()

      await expect(c.gateway.connect(user2).buyTokenUsdc(token, U(100)))
        .to.emit(fw.pad, 'Refused')
        .withArgs(2, c.label, b32(token), b32(user2.address), E(100), 6)
      expect(await c.usdc.balanceOf(user2)).to.equal(U(1_700))
      expect(await rep.balanceOf(user2)).to.equal(bag)

      await expect(c.gateway.connect(user2).sellToken(token, bag))
        .to.emit(fw.pad, 'Refused')
        .withArgs(3, c.label, b32(token), b32(user2.address), bag, 6)
      expect(await rep.balanceOf(user2)).to.equal(bag)
      expect(await fw.pad.supplyByChain(token, c.label)).to.equal(bag)
      expect((await fw.pad.feesOf(token)).total).to.equal(E(3))
      const b = await backing(fw)
      expect(b.supply).to.equal(b.usdc)

      await (await fw.venue.setRefuse(false)).wait()
      await (await c.gateway.connect(user2).sellToken(token, bag)).wait()
      expect(await rep.balanceOf(user2)).to.equal(0n)
    })

    it('a buyback the venue refuses does not undo the trade that triggered it; the pot waits', async () => {
      // the next buy tips the burn pot over $4 — let the user's buy through, refuse the buyback
      await (await fw.venue.setBuysLeft(1)).wait()
      const bag = await rep.balanceOf(user2)
      await (await c.gateway.connect(user2).buyTokenUsdc(token, U(200))).wait()
      expect(await rep.balanceOf(user2)).to.be.gt(bag) // the trade stood
      let f = await fw.pad.feesOf(token)
      expect(f.burnPot).to.equal(E(5))
      expect(f.burnedUsd).to.equal(0n)

      // the venue recovers: the next fee burns the whole pot
      await (await fw.venue.setBuysLeft(ethers.MaxUint256)).wait()
      await expect(c.gateway.connect(user2).buyTokenUsdc(token, U(100))).to.emit(fw.pad, 'BuybackBurn')
      f = await fw.pad.feesOf(token)
      expect(f.burnPot).to.equal(0n)
      expect(f.burnedUsd).to.equal(E(6))
    })
  })

  /* ================================ the books ================================ */

  describe('the pad is solvent to the wei', () => {
    /** What the pad owes for one token: the curve's real dollars plus every pot. */
    async function owed(world, token) {
      const f = await world.pad.feesOf(token)
      const c = await world.pad.curves(token)
      // before ascension 6,000 of vBase are virtual and may never be paid out
      if (!c.ascended) expect(c.vBase).to.be.gte(E(6_000))
      let waiting = 0n
      for (const ch of world.chains) waiting += await world.pad.pendingDrop(token, ch.label)
      return (c.ascended ? c.vBase : c.vBase - E(6_000)) + (f.dev - f.devClaimed) + (f.holders - f.holdersPaid) + f.burnPot + waiting
    }

    it('V1 holds exactly through odd-sized trades, every fee mode, drops, pulls, claims, a buyback and an ascension', async () => {
      // the mainnet way: slices wait on the hub, so they are part of what it owes
      const world = await deployWorld({ autoDrop: false })
      const chains = [world.chains[0], world.chains[2], world.chains[5]]
      const traders = [user, user2, stranger]
      for (const c of chains) for (const t of traders) await fundUsd(c, t, 60_000)

      const tokens = []
      for (const mode of [0, 1, 2, 3]) {
        await (await chains[mode % 3].gateway.connect(user).spawnToken(`BOOKS ${mode}`, `B${mode}`, '{}', E(13) + 7n, mode)).wait()
        tokens.push(await world.pad.allTokens(mode))
      }
      async function expectSolvent() {
        let total = 0n
        for (const t of tokens) total += await owed(world, t)
        expect(await world.hubUsd.balanceOf(world.pad.target)).to.equal(total)
      }
      await expectSolvent()

      // a deterministic stream of awkward numbers
      let seed = 0x5eedn
      const next = (mod) => {
        seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n
        return (seed >> 24n) % BigInt(mod) // an LCG's low bits cycle; use the high ones
      }
      for (let i = 0; i < 90; i++) {
        if (i === 30) await pastGenesis() // the first third pays the snipe tax
        const token = tokens[Number(next(4))]
        const c = chains[Number(next(3))]
        const t = traders[Number(next(3))]
        const rep = await replica(c, token)
        const bag = await rep.balanceOf(t)
        const roll = next(10)
        if (roll < 5n || bag < 10n ** 12n) {
          // odd wei on purpose: nothing here divides evenly
          await (await c.gateway.connect(t).buyToken(token, E(20) + next(180) * 10n ** 18n + next(10n ** 15n))).wait()
        } else if (roll < 8n) {
          const part = bag / (2n + next(5)) + next(10n ** 6n)
          await (await c.gateway.connect(t).sellToken(token, part < 10n ** 12n ? bag : part)).wait()
        } else if (roll < 9n) {
          await (await c.gateway.connect(t).pullFees(token)).wait()
        } else {
          await (await c.gateway.connect(user).claimFees(token)).wait() // user is every token's dev
        }
        await expectSolvent()
      }

      // a whale runs one curve through ascension; everyone left sells out completely
      await (await chains[0].gateway.connect(user2).buyToken(tokens[1], E(25_000) + 1n)).wait()
      expect((await world.pad.curves(tokens[1])).ascended).to.equal(true)
      await expectSolvent()
      for (const token of tokens) {
        for (const c of chains) {
          const rep = await replica(c, token)
          for (const t of traders) {
            const bag = await rep.balanceOf(t)
            if (bag >= 10n ** 12n) await (await c.gateway.connect(t).sellToken(token, bag)).wait()
            await expectSolvent()
          }
          await (await c.gateway.connect(stranger).pullFees(token)).wait()
          await expectSolvent()
        }
        await (await chains[0].gateway.connect(user).claimFees(token)).wait()
        await expectSolvent()
      }
      expect((await world.pad.feesOf(tokens[3])).burnedUsd).to.be.gt(0n) // the buyback ran
      const b = await backing(world)
      expect(b.supply).to.equal(b.usdc)
    })

    it('a round trip can never take out more than it put in — not even one wei at a time', async () => {
      const world = await deployWorld()
      const c = world.chains[1]
      await (await c.gateway.connect(user).spawnToken('ROUND TRIP', 'RT', '{}', 0, 2)).wait()
      await pastGenesis()
      const token = await world.pad.allTokens(0)
      await fundUsd(c, user2, 1_000)
      const rep = await replica(c, token)
      const before = await worth(c, user2)

      // in, then out in awkward slices down to the last sellable wei
      await (await c.gateway.connect(user2).buyToken(token, E(200) + 3n)).wait()
      for (let i = 0; i < 12; i++) {
        const bag = await rep.balanceOf(user2)
        await (await c.gateway.connect(user2).sellToken(token, i < 11 ? bag / 3n + 1n : bag)).wait()
      }
      expect(await rep.balanceOf(user2)).to.equal(0n)
      // the trader paid at least the two 1% fees; the curve kept its rounding
      const fees = (await world.pad.feesOf(token)).total
      expect(before - (await worth(c, user2))).to.be.gte(fees)
      const curve = await world.pad.curves(token)
      expect(curve.vBase).to.be.gte(E(6_000))
      expect(await world.hubUsd.balanceOf(world.pad.target)).to.equal(curve.vBase - E(6_000) + fees)
    })
  })

  /* ============================== the holder pool ============================== */

  describe('FeeDistributor', () => {
    it('the 2^128 edge is closed: a drop over dust shares cannot brick a token’s deliveries', async () => {
      // The trap: leave 1 wei of shares on a chain, have a fee drop land on
      // it, and before v7 the next real mint overflowed in the transfer hook —
      // every later DELIVER of that token to that chain reverted, with the
      // buyers' dollars already in the curve for the attacker to sell into.
      const w = await deployWorldAsync()
      const op = w.chains[5]
      await fundUsdc(op, attacker, 2_000)
      await fundUsdc(op, user2, 2_000)
      await (await op.gateway.connect(attacker).spawnToken('TRAP', 'TRAP', '{}', 0, 0)).wait()
      await w.deliverAll()
      const token = await w.pad.allTokens(0)
      const rep = await replica(op, token)

      // inside the genesis window the fees are fat: one round trip fills the pot
      await (await op.gateway.connect(attacker).buyTokenUsdc(token, U(200))).wait()
      await w.deliverAll()
      const bag = await rep.balanceOf(attacker)
      await (await op.gateway.connect(attacker).sellToken(token, bag - 1n)).wait() // leave 1 wei
      await w.deliverAll()
      expect(await rep.totalSupply()).to.equal(1n)
      // the whole pot is attributed to the chain holding that 1 wei
      expect(await w.pad.pendingDrop(token, op.label)).to.be.gt(E(2))
      await (await op.gateway.connect(attacker).pullFees(token)).wait()
      await w.deliverAll()
      const pot = await op.usd.balanceOf(op.dist.target) // what the pull brought home
      expect(pot).to.be.gt(E(50))

      // the drop did NOT fold onto 1 wei of shares: it waits for real holders
      expect(await op.dist.pendingOf(rep.target)).to.equal(pot)
      expect(await op.dist.magDPS(rep.target)).to.equal(0n)

      // the victim's buy is delivered and minted, not stranded
      await pastGenesis()
      await (await op.gateway.connect(user2).buyTokenUsdc(token, U(500))).wait()
      await w.deliverAll()
      const victimBag = await rep.balanceOf(user2)
      expect(victimBag).to.be.gt(E(1_000_000))
      expect(await op.gateway.pendingDelivery(token, user2.address)).to.equal(0n)
      // the waiting drop folded in for the real holder base, and the numbers stay far from the edge
      expect(await op.dist.pendingOf(rep.target)).to.equal(0n)
      expect(await op.dist.withdrawable(rep.target, user2.address)).to.be.closeTo(pot, DUST)
      expect((await op.dist.magDPS(rep.target)) * E(1_000_000_000)).to.be.lt(2n ** 255n)
      // the token still moves
      await (await rep.connect(user2).transfer(user.address, victimBag / 2n)).wait()
      await (await op.gateway.connect(user2).sellToken(token, victimBag / 2n)).wait()
      await w.deliverAll()
    })

    it('F-6: exclusions are wire-up only — refused once any share exists, and final once sealed', async () => {
      const usd = await ethers.deployContract('OmniUSD', [0, ethers.ZeroAddress, ethers.ZeroAddress])
      const dist = await ethers.deployContract('FeeDistributor', [usd.target])
      await expect(dist.setAgent(admin.address)).to.emit(dist, 'AgentSet').withArgs(admin.address)
      const tok = await ethers.deployContract('SpawnToken', [
        'T', 'T', admin.address, true, 0, ethers.ZeroAddress, dist.target,
      ])

      await expect(dist.connect(stranger).exclude(stranger.address)).to.be.revertedWith('ROLES: not admin')
      await expect(dist.exclude(user.address)).to.emit(dist, 'Excluded').withArgs(user.address)

      // a holder appears: from now on excluding anyone would leave live shares miscounted
      await (await tok.bridgeMint(user2.address, E(5_000))).wait()
      expect(await dist.liveShares()).to.equal(E(5_000))
      await expect(dist.exclude(user2.address)).to.be.revertedWith('DIST: shares live')
      await expect(dist.exclude(stranger.address)).to.be.revertedWith('DIST: shares live')
      // the counter follows mints, moves and burns across excluded and normal accounts
      await (await tok.connect(user2).transfer(user.address, E(1_000))).wait() // to an excluded account
      expect(await dist.liveShares()).to.equal(E(4_000))
      await (await tok.connect(user2).transfer(stranger.address, E(1_000))).wait()
      expect(await dist.liveShares()).to.equal(E(4_000))
      await (await tok.bridgeBurn(user2.address, E(3_000))).wait()
      await (await tok.bridgeBurn(stranger.address, E(1_000))).wait()
      expect(await dist.liveShares()).to.equal(0n)
      await (await dist.exclude(stranger.address)).wait() // legal again: nothing is live

      await expect(dist.connect(stranger).sealExclusions()).to.be.revertedWith('ROLES: not admin')
      await expect(dist.sealExclusions()).to.emit(dist, 'ExclusionsSealed')
      await expect(dist.exclude(attacker.address)).to.be.revertedWith('DIST: exclusions sealed')

      // every deployed pool is sealed at wire-up
      const world = await deployWorld()
      for (const ch of world.chains) {
        expect(await ch.dist.exclusionsSealed()).to.equal(true)
        expect(await ch.dist.excluded(ch.gateway.target)).to.equal(true)
        await expect(ch.dist.exclude(attacker.address)).to.be.revertedWith('DIST: exclusions sealed')
      }
    })
  })

  /* ============================== small findings ============================== */

  describe('small findings', () => {
    it('F-1 / S3: the write-only reverse map and the hub’s dead holder branch are gone', async () => {
      const world = await deployWorld()
      const names = world.pad.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name)
      for (const gone of ['gatewayChain', 'distributor', 'setDistributor']) expect(names).to.not.include(gone)
      // the hub token reports to no pool: it never leaves the pad's custody
      const c = world.chains[0]
      await (await c.gateway.connect(user).spawnToken('NO POOL', 'NP', '{}', 0, 0)).wait()
      const token = await ethers.getContractAt('SpawnToken', await world.pad.allTokens(0))
      expect(await token.distributor()).to.equal(ethers.ZeroAddress)
      expect(await token.balanceOf(world.pad.target)).to.equal(await token.totalSupply())
      // the hub label can never be given a gateway
      await expect(world.pad.setGateway(0, b32(stranger.address))).to.be.revertedWith('PAD: hub label')
    })

    it('a route is opened once; changing whose word is believed is a separate, explicit, logged call', async () => {
      const w = await deployWorldAsync()
      const op = w.chains[5]
      const hub = w.hubMessenger
      const evil = b32(attacker.address)

      // setRoute cannot overwrite, alias or shadow anything
      await expect(op.messenger.setRoute(0, EID(0), evil)).to.be.revertedWith('LZM: label routed')
      await expect(op.messenger.setRoute(0, 31_000, evil)).to.be.revertedWith('LZM: label routed')
      await expect(hub.setRoute(9, EID(6), evil)).to.be.revertedWith('LZM: eid taken') // two labels, one eid
      await expect(hub.setRoute(3, 31_000, evil)).to.be.revertedWith('LZM: label is local')
      await expect(hub.setLocal(6, true)).to.be.revertedWith('LZM: label routed') // local XOR routed
      await expect(hub.setRoute(9, 0, evil)).to.be.revertedWith('LZM: bad route')
      await expect(hub.setRoute(9, 31_000, ethers.ZeroHash)).to.be.revertedWith('LZM: bad route')
      await expect(hub.setRoute(9, 31_009, evil)).to.emit(hub, 'RouteSet').withArgs(9, 31_009, evil)

      // re-pointing exists — admin only, and it says what it replaced
      await expect(hub.repointRoute(8, 31_008, evil)).to.be.revertedWith('LZM: no route')
      await expect(hub.repointRoute(9, EID(6), evil)).to.be.revertedWith('LZM: eid taken')
      const oldPeer = b32(w.hubMessenger.target)
      const fresh = await ethers.deployContract('LayerZeroOmniMessenger', [w.endpoint.target, 31_500])
      await (await w.endpoint.registerAdapter(fresh.target, 31_500)).wait()
      await expect(op.messenger.repointRoute(0, 31_500, b32(fresh.target)))
        .to.emit(op.messenger, 'RouteRepointed')
        .withArgs(0, EID(0), oldPeer, 31_500, b32(fresh.target))
      expect(await op.messenger.eidOf(0)).to.equal(31_500n)
      expect(await op.messenger.peers(31_500)).to.equal(b32(fresh.target))
      // the old seat is fully vacated: the former hub adapter is no longer believed
      expect(await op.messenger.peers(EID(0))).to.equal(ethers.ZeroHash)
      await (await w.chains[4].gateway.connect(user).spawnToken('ORPHAN', 'ORPH', '{}', 0, 0)).wait()
      await (await w.endpoint.deliverNext()).wait() // SPAWN lands on the real hub; it SYNCs every chain
      let toOp = -1
      for (let i = 0; i < Number(await w.endpoint.pending()); i++) {
        if (Number((await w.endpoint.peek(i)).dstEid) === EID(6)) toOp = i
      }
      await expect(w.endpoint.deliverAt(toOp)).to.be.revertedWith('LZM: not a peer')
    })

    it('a sender can be struck off; a struck sender cannot speak', async () => {
      const w = await deployWorldAsync()
      const op = w.chains[5]
      await fundUsdc(op, user, 100)
      await expect(op.messenger.unregister(op.gateway.target))
        .to.emit(op.messenger, 'SenderUnregistered')
        .withArgs(op.gateway.target)
      expect(await op.messenger.sponsored(op.gateway.target)).to.equal(false)
      await expect(op.gateway.connect(user).spawnTokenUsdc('MUTE', 'MUTE', '{}', U(10), 0)).to.be.revertedWith(
        'LZM: unknown sender',
      )
      expect(await op.usdc.balanceOf(user)).to.equal(U(100))
    })

    it('every configuration change leaves an event', async () => {
      const usdc = await ethers.deployContract('MockUSDC')
      const ledger = await ethers.deployContract('OmniUSD', [0, ethers.ZeroAddress, ethers.ZeroAddress])
      const vault = await ethers.deployContract('OmniUSD', [4, usdc.target, ethers.ZeroAddress])
      const lom = await ethers.deployContract('LocalOmniMessenger')
      const pad = await ethers.deployContract('SpawnPad', [lom.target, ledger.target])
      const venue = await ethers.deployContract('InternalCurveVenue', [pad.target])
      const gateway = await ethers.deployContract('SpawnGateway', [lom.target, vault.target, 4, pad.target])
      const dist = await ethers.deployContract('FeeDistributor', [vault.target])
      const endpoint = await ethers.deployContract('MockLZEndpointV2', [1])
      const adapter = await ethers.deployContract('LayerZeroOmniMessenger', [endpoint.target, 30_004])
      const x = b32(stranger.address)

      await expect(pad.setVenue(venue.target)).to.emit(pad, 'VenueSet').withArgs(venue.target)
      await expect(pad.setGateway(4, b32(gateway.target))).to.emit(pad, 'GatewaySet').withArgs(4, b32(gateway.target))
      await expect(pad.setAutoDrop(4, true)).to.emit(pad, 'AutoDropSet').withArgs(4, true)
      await expect(pad.pause()).to.emit(pad, 'Paused').withArgs(admin.address)
      await expect(pad.unpause()).to.emit(pad, 'Unpaused').withArgs(admin.address)

      await expect(gateway.setDistributor(dist.target)).to.emit(gateway, 'DistributorSet').withArgs(dist.target)
      await expect(gateway.setLegs(1, 3)).to.emit(gateway, 'LegsSet').withArgs(1, 3)
      await expect(gateway.pause()).to.emit(gateway, 'Paused').withArgs(admin.address)
      await expect(gateway.unpause()).to.emit(gateway, 'Unpaused').withArgs(admin.address)

      await expect(vault.setAgent(gateway.target)).to.emit(vault, 'AgentSet').withArgs(gateway.target)
      await expect(vault.setDepositCap(5)).to.emit(vault, 'DepositCapSet').withArgs(5)
      await expect(vault.setPeer(5, 3, x)).to.emit(vault, 'PeerSet').withArgs(5, 3, x)
      await expect(vault.pauseDeposits()).to.emit(vault, 'DepositsPaused').withArgs(admin.address)
      await expect(vault.unpauseDeposits()).to.emit(vault, 'DepositsUnpaused').withArgs(admin.address)

      await expect(dist.setAgent(gateway.target)).to.emit(dist, 'AgentSet').withArgs(gateway.target)
      await expect(dist.exclude(stranger.address)).to.emit(dist, 'Excluded').withArgs(stranger.address)
      await expect(dist.sealExclusions()).to.emit(dist, 'ExclusionsSealed')

      await expect(adapter.register(gateway.target, 4))
        .to.emit(adapter, 'SenderRegistered')
        .withArgs(gateway.target, 4)
      await expect(adapter.setSponsored(gateway.target, true))
        .to.emit(adapter, 'SponsoredSet')
        .withArgs(gateway.target, true)
      await expect(adapter.setLocal(4, true)).to.emit(adapter, 'LocalSet').withArgs(4, true)
      await expect(adapter.setRoute(0, 30_000, x)).to.emit(adapter, 'RouteSet').withArgs(0, 30_000, x)
      await expect(adapter.setDestination(0, 9, 8)).to.emit(adapter, 'DestinationSet').withArgs(0, 9, 8)
      await expect(adapter.setDelegate(stranger.address)).to.emit(adapter, 'DelegateSet').withArgs(stranger.address)
      await (await admin.sendTransaction({ to: adapter.target, value: 7 })).wait()
      await expect(adapter.recover(stranger.address)).to.emit(adapter, 'Recovered').withArgs(stranger.address, 7)

      await expect(lom.register(gateway.target, 4)).to.emit(lom, 'EndpointRegistered').withArgs(gateway.target, 4)
      await expect(lom.setSponsored(pad.target, true)).to.emit(lom, 'SponsoredSet').withArgs(pad.target, true)
      await expect(lom.setFlatFee(3)).to.emit(lom, 'FlatFeeSet').withArgs(3)
    })
  })
})
