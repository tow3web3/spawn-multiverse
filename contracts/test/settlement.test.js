const { expect } = require('chai')
const { ethers } = require('hardhat')
const { time, impersonateAccount, setBalance } = require('@nomicfoundation/hardhat-network-helpers')
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs')
const {
  deployWorld,
  deployWorldAsync,
  fundUsd,
  fundUsdc,
  worth,
  backing,
  SCALE,
  U,
} = require('../scripts/lib-deploy')

const E = (n) => ethers.parseEther(String(n))
const b32 = (a) => ethers.zeroPadValue(a, 32)
const pastGenesis = () => time.increase(601)

/**
 * Real-money settlement (protocol v7): oUSD is a 1:1 USDC-backed unit on
 * every user-facing chain and a pure ledger on the hub. The property under
 * test everywhere: Σ USDC in vaults × 1e12 == Σ oUSD supply over ALL
 * instances — and no payout on the message path can ever revert.
 */
describe('Real-money settlement (protocol v7)', () => {
  let world, admin, user, user2

  beforeEach(async () => {
    ;[admin, user, user2] = await ethers.getSigners()
    world = await deployWorld()
  })

  async function expectBacked() {
    const { usdc, supply } = await backing(world)
    expect(supply).to.equal(usdc)
  }

  async function lastToken() {
    return world.pad.allTokens((await world.pad.tokensLength()) - 1n)
  }

  async function spawnVia(chain, feeMode = 0) {
    await (await chain.gateway.connect(user).spawnToken('VAULTED', 'VLT', '{}', 0, feeMode)).wait()
    await pastGenesis()
    return lastToken()
  }

  const replica = async (chain, token) =>
    ethers.getContractAt('SpawnToken', await chain.gateway.replicaOf(token))

  async function as(address) {
    await impersonateAccount(address)
    await setBalance(address, E(1))
    return ethers.getSigner(address)
  }

  /* ------------------------------ the vault ------------------------------ */

  describe('the vault', () => {
    it('wraps and unwraps 1:1; sub-USDC dust never leaves the holder', async () => {
      const c = world.chains[2]
      await fundUsdc(c, user, 100)

      await expect(c.usd.connect(user).wrap(U(100)))
        .to.emit(c.usd, 'Wrapped')
        .withArgs(user.address, U(100), E(100))
      expect(await c.usd.balanceOf(user)).to.equal(E(100))
      expect(await c.usdc.balanceOf(user)).to.equal(0n)
      expect(await c.usd.liquidity()).to.equal(U(100))
      await expectBacked()

      // $40 + 5 wei of dust: exactly $40 burns, the 5 wei stay put
      await expect(c.usd.connect(user).unwrap(E(40) + 5n))
        .to.emit(c.usd, 'Unwrapped')
        .withArgs(user.address, U(40))
      expect(await c.usd.balanceOf(user)).to.equal(E(60))
      expect(await c.usdc.balanceOf(user)).to.equal(U(40))
      await expectBacked()

      // less than one USDC unit cannot be redeemed at all
      await expect(c.usd.connect(user).unwrap(SCALE - 1n)).to.be.revertedWith('oUSD: dust')
      await expect(c.usd.connect(user).wrap(0)).to.be.revertedWith('oUSD: zero')

      // oUSD is an ordinary ERC20: a claim can move and be redeemed by anyone
      await (await c.usd.connect(user).transfer(user2.address, E(60))).wait()
      await (await c.usd.connect(user2).unwrap(E(60))).wait()
      expect(await c.usdc.balanceOf(user2)).to.equal(U(60))
      expect(await c.usd.totalSupply()).to.equal(0n)
      expect(await c.usd.liquidity()).to.equal(0n)
      await expectBacked()
    })

    it('deposits are closed until the admin opens the cap, and never exceed it', async () => {
      // a fresh vault: cap 0 = closed (the guarded-launch default)
      const usdc = await ethers.deployContract('MockUSDC')
      const usd = await ethers.deployContract('OmniUSD', [9, usdc.target, ethers.ZeroAddress])
      await (await usdc.mint(user.address, U(500))).wait()
      await (await usdc.connect(user).approve(usd.target, ethers.MaxUint256)).wait()
      expect(await usd.depositCap()).to.equal(0n)
      await expect(usd.connect(user).wrap(U(1))).to.be.revertedWith('oUSD: deposit cap')

      await expect(usd.connect(user).setDepositCap(U(100))).to.be.revertedWith('oUSD: not admin')
      await expect(usd.setDepositCap(U(100))).to.emit(usd, 'DepositCapSet').withArgs(U(100))

      await (await usd.connect(user).wrap(U(60))).wait()
      await expect(usd.connect(user).wrap(U(41))).to.be.revertedWith('oUSD: deposit cap')
      await (await usd.connect(user).wrap(U(40))).wait() // exactly at the cap
      await expect(usd.connect(user).wrap(1)).to.be.revertedWith('oUSD: deposit cap')

      // redemptions free room; the admin can also close deposits again —
      // which never blocks anyone from getting OUT
      await (await usd.connect(user).unwrap(E(30))).wait()
      await (await usd.connect(user).wrap(U(30))).wait()
      await (await usd.setDepositCap(0)).wait()
      await expect(usd.connect(user).wrap(1)).to.be.revertedWith('oUSD: deposit cap')
      await (await usd.connect(user).unwrap(E(100))).wait()
      expect(await usdc.balanceOf(user)).to.equal(U(500))
    })

    it('the cap also binds the gateway USDC entry paths (depositFor)', async () => {
      const c = world.chains[4]
      const token = await spawnVia(c)
      await fundUsdc(c, user, 1_000)
      await (await c.usd.setDepositCap(U(100))).wait()

      await expect(c.gateway.connect(user).buyTokenUsdc(token, U(101))).to.be.revertedWith(
        'oUSD: deposit cap',
      )
      await expect(
        c.gateway.connect(user).spawnTokenUsdc('TOO BIG', 'BIG', '{}', U(101), 0),
      ).to.be.revertedWith('oUSD: deposit cap')
      expect(await c.usdc.balanceOf(user)).to.equal(U(1_000)) // nothing moved

      await (await c.gateway.connect(user).buyTokenUsdc(token, U(100))).wait()
      expect(await c.usd.liquidity()).to.equal(U(100))
      await expectBacked()
    })

    it('the hub instance is a pure ledger: no vault, no USDC paths', async () => {
      const hub = world.hubUsd
      expect(await hub.usdc()).to.equal(ethers.ZeroAddress)
      expect(await hub.liquidity()).to.equal(0n)
      const pad = await as(world.pad.target) // the hub instance's agent

      await expect(hub.connect(user).wrap(U(1))).to.be.revertedWith('oUSD: ledger only')
      await expect(hub.connect(user).unwrap(E(1))).to.be.revertedWith('oUSD: ledger only')
      await expect(hub.connect(pad).depositFor(user.address, U(1))).to.be.revertedWith('oUSD: ledger only')
      await expect(hub.connect(pad).payout(user.address, E(1))).to.be.revertedWith('oUSD: ledger only')
      await expect(hub.rebalance(1, U(1))).to.be.revertedWith('oUSD: ledger only')
      await expect(hub.setPeer(1, 6, b32(user.address))).to.be.revertedWith('oUSD: ledger only')
      await expect(hub.setDepositCap(U(1))).to.be.revertedWith('oUSD: ledger only')

      // construction refuses nonsense: a ledger with CCTP, a non-6-decimal
      // "USDC", and a gateway wired to a ledger (its payouts would revert)
      await expect(
        ethers.deployContract('OmniUSD', [0, ethers.ZeroAddress, world.chains[0].cctp.target]),
      ).to.be.revertedWith('oUSD: ledger has no CCTP')
      await expect(
        ethers.deployContract('OmniUSD', [7, hub.target, ethers.ZeroAddress]), // 18 decimals
      ).to.be.revertedWith('oUSD: usdc decimals')
      await expect(
        ethers.deployContract('SpawnGateway', [world.messenger.target, hub.target, 7, world.pad.target]),
      ).to.be.revertedWith('GW: ledger usd')
    })

    it('there is no faucet: oUSD only exists against USDC or a protocol message', async () => {
      const c = world.chains[2]
      // the complete list of state-changing functions — a new mint path
      // cannot slip in without failing this test
      const writers = c.usd.interface.fragments
        .filter((f) => f.type === 'function' && f.stateMutability !== 'view' && f.stateMutability !== 'pure')
        .map((f) => f.name)
        .sort()
      expect(writers).to.deep.equal([
        'approve', 'bridgeBurn', 'bridgeMint', 'depositFor', 'payout', 'rebalance',
        'setAgent', 'setDepositCap', 'setPeer', 'transfer', 'transferFrom', 'unwrap', 'wrap',
      ])
      expect(c.usd.interface.getFunction('faucet')).to.equal(null)

      // every mint-capable path but `wrap` is agent-only, and the agent is
      // set once (the gateway)
      await expect(c.usd.connect(user).bridgeMint(user.address, E(1))).to.be.revertedWith('oUSD: not agent')
      await expect(c.usd.connect(user).payout(user.address, E(1))).to.be.revertedWith('oUSD: not agent')
      await expect(c.usd.connect(user).depositFor(user.address, U(1))).to.be.revertedWith('oUSD: not agent')
      await expect(c.usd.bridgeMint(admin.address, E(1))).to.be.revertedWith('oUSD: not agent') // not even the admin
      await expect(c.usd.setAgent(user.address)).to.be.revertedWith('oUSD: agent set')
      expect(await c.usd.agent()).to.equal(c.gateway.target)
      expect(await c.usd.totalSupply()).to.equal(0n)
    })
  })

  /* --------------------------- the gateway paths --------------------------- */

  describe('through the gateway', () => {
    it('USDC goes in without minting oUSD; the same wire message leaves', async () => {
      const c = world.chains[2]
      const token = await spawnVia(c)
      await fundUsdc(c, user, 500)
      await fundUsd(c, user2, 500)

      await (await c.gateway.connect(user).buyTokenUsdc(token, U(100))).wait()
      await (await c.gateway.connect(user2).buyToken(token, E(100))).wait()

      // user paid USDC straight into the vault and never held oUSD
      expect(await c.usdc.balanceOf(user)).to.equal(U(400))
      expect(await c.usd.balanceOf(user)).to.equal(0n)
      expect(await c.usd.balanceOf(user2)).to.equal(E(400))
      expect(await c.usd.liquidity()).to.equal(U(600))

      // both paths hit the hub identically: $1 fee each, same curve
      expect((await world.pad.feesOf(token)).total).to.equal(E(2))
      const rep = await replica(c, token)
      expect(await rep.balanceOf(user)).to.be.gt(await rep.balanceOf(user2)) // bought first
      await expectBacked()
    })

    it('a USDC dev buy rides inside the spawn', async () => {
      const c = world.chains[5]
      await fundUsdc(c, user, 100)
      await (await c.gateway.connect(user).spawnTokenUsdc('USDC BORN', 'UBORN', '{}', U(25), 0)).wait()
      const token = await lastToken()

      expect(await c.usdc.balanceOf(user)).to.equal(U(75))
      expect(await (await replica(c, token)).balanceOf(user)).to.be.gt(0n)
      expect((await world.pad.feesOf(token)).total).to.equal(E(0.25)) // 1%, FAIR GENESIS exempt
      await expectBacked()

      // and a spawn with no dev buy touches no money at all
      await (await c.gateway.connect(user2).spawnTokenUsdc('FREE', 'FREE', '{}', 0, 0)).wait()
      await expectBacked()
    })

    it('refuses a buy for a token the hub never spawned, before any money moves', async () => {
      const c = world.chains[2]
      await spawnVia(c)
      await fundUsdc(c, user, 100)
      await fundUsd(c, user2, 100)
      const bogus = ethers.Wallet.createRandom().address

      await expect(c.gateway.connect(user).buyTokenUsdc(bogus, U(50))).to.be.revertedWith('GW: unknown token')
      await expect(c.gateway.connect(user2).buyToken(bogus, E(50))).to.be.revertedWith('GW: unknown token')
      expect(await c.usdc.balanceOf(user)).to.equal(U(100))
      expect(await c.usd.balanceOf(user2)).to.equal(E(100))
      await expect(c.gateway.connect(user).buyTokenUsdc(bogus, 0)).to.be.revertedWith('GW: zero')
    })

    it('sell payouts and buy refunds come home as USDC when the vault is liquid', async () => {
      const c = world.chains[0]
      const token = await spawnVia(c)
      await fundUsdc(c, user, 20_000)

      // $20K into a curve that can only absorb ~$17.8K: the excess is refunded
      await expect(c.gateway.connect(user).buyTokenUsdc(token, U(20_000)))
        .to.emit(c.usd, 'PaidOut')
        .withArgs(user.address, anyValue, anyValue)
      const refund = await c.usdc.balanceOf(user)
      expect(refund).to.be.gt(U(2_100))
      expect(refund).to.be.lt(U(2_400))
      // only the sub-USDC dust of the refund was minted as oUSD
      expect(await c.usd.balanceOf(user)).to.be.lt(SCALE)
      await expectBacked()

      // selling pays USDC too
      const rep = await replica(c, token)
      await (await c.gateway.connect(user).sellToken(token, (await rep.balanceOf(user)) / 4n)).wait()
      expect(await c.usdc.balanceOf(user)).to.be.gt(refund)
      expect(await c.usd.balanceOf(user)).to.be.lt(2n * SCALE)
      await expectBacked()
    })

    it('the testnet smoke path: a FAIR GENESIS-capped USDC buy refunds in USDC, then a sell pays in USDC', async () => {
      // exactly what scripts/testnet-smoke.js asserts on live LayerZero
      const w = await deployWorldAsync()
      const op = w.chains[5]
      await (await op.gateway.connect(user).spawnToken('OMNI TEST', 'OMNI', '{"smoke":true}', 0, 1)).wait()
      await w.deliverAll()
      const token = await w.pad.allTokens(0)
      await fundUsdc(op, user, 1_000)

      // still inside the 10-minute window: $260 intent meets the $250 cap
      await (await op.gateway.connect(user).buyTokenUsdc(token, U(260))).wait()
      await w.deliverAll()
      expect(await w.pad.genesisSpent(token, b32(user.address))).to.equal(E(250))
      expect(await op.usdc.balanceOf(user)).to.equal(U(750)) // the $10 came home as USDC
      expect(await op.usd.balanceOf(user)).to.equal(0n)

      const rep = await ethers.getContractAt('SpawnToken', await op.gateway.replicaOf(token))
      await (await op.gateway.connect(user).sellToken(token, (await rep.balanceOf(user)) / 2n)).wait()
      await w.deliverAll()
      expect(await op.usdc.balanceOf(user)).to.be.gt(U(750))
      expect(await op.usd.balanceOf(user)).to.be.lt(SCALE) // dust only, no oUSD claim
      const b = await backing(w)
      expect(b.supply).to.equal(b.usdc)
    })
  })

  /* ------------------------ the global backing invariant ------------------------ */

  describe('the global backing invariant', () => {
    it('holds after every step of a mixed scenario (both entry paths, sells, dev buy, fees, drops, claims)', async () => {
      const A = world.chains[2] // base
      const B = world.chains[4] // arbitrum
      const C = world.chains[5] // optimism — nobody ever deposits here
      await fundUsdc(A, user, 2_000)
      await fundUsd(B, user2, 1_000)
      await expectBacked()

      // spawn with a USDC dev buy, holders fee mode
      await (await A.gateway.connect(user).spawnTokenUsdc('INVARIANT', 'INV', '{}', U(50), 0)).wait()
      const token = await lastToken()
      await expectBacked()
      await pastGenesis()

      // USDC-path buy: $3 fee tips the holders pot over the $2 trigger -> drops fan out
      await (await A.gateway.connect(user).buyTokenUsdc(token, U(300))).wait()
      expect((await world.pad.feesOf(token)).holdersPaid).to.be.gt(0n)
      await expectBacked()

      // oUSD-path buy from another chain
      await (await B.gateway.connect(user2).buyToken(token, E(400))).wait()
      await expectBacked()

      // sells on both chains (payouts in USDC — both vaults are liquid)
      const repA = await replica(A, token)
      const repB = await replica(B, token)
      await (await A.gateway.connect(user).sellToken(token, (await repA.balanceOf(user)) / 2n)).wait()
      await expectBacked()
      await (await B.gateway.connect(user2).sellToken(token, await repB.balanceOf(user2))).wait()
      await expectBacked()

      // a holder claims their fee stream locally (oUSD), then redeems it
      const reward = await A.dist.withdrawable(repA.target, user.address)
      expect(reward).to.be.gt(0n)
      await (await A.dist.connect(user).claim(repA.target)).wait()
      await expectBacked()
      const usdcBefore = await A.usdc.balanceOf(user)
      await (await A.usd.connect(user).unwrap(await A.usd.balanceOf(user))).wait()
      expect((await A.usdc.balanceOf(user)) - usdcBefore).to.equal(reward / SCALE)
      await expectBacked()

      // a dev-fee token: the dev claims on a chain whose vault is EMPTY —
      // the payout lands as an oUSD claim, and the books still balance
      await (await A.gateway.connect(user).spawnToken('DEVFEES', 'DEVF', '{}', 0, 2)).wait()
      const token2 = await lastToken()
      await pastGenesis()
      await (await B.gateway.connect(user2).buyToken(token2, E(200))).wait()
      await expectBacked()
      await (await C.gateway.connect(user).claimFees(token2)).wait()
      expect(await C.usd.balanceOf(user)).to.equal(E(2))
      expect(await C.usd.liquidity()).to.equal(0n)
      await expectBacked()

      // and not one mock dollar was created or destroyed along the way
      let dollars = 0n
      for (const ch of world.chains) {
        dollars += await ch.usdc.balanceOf(ch.usd.target)
        dollars += (await ch.usdc.balanceOf(user)) + (await ch.usdc.balanceOf(user2))
      }
      expect(dollars).to.equal(U(3_000))
    })

    it('over async transport the only gap is value in flight — and it closes on delivery', async () => {
      const w = await deployWorldAsync()
      const base = w.chains[2]
      await (await base.gateway.connect(user).spawnToken('INFLIGHT', 'FLY', '{}', 0, 0)).wait()
      await w.deliverAll()
      await pastGenesis()
      const token = await w.pad.allTokens(0)
      await fundUsdc(base, user, 500)

      await (await base.gateway.connect(user).buyTokenUsdc(token, U(100))).wait()
      // leg 1 in flight: the USDC sits in the vault, the oUSD exists nowhere yet
      let b = await backing(w)
      expect(b.usdc - b.supply).to.equal(E(100))

      await w.deliverAll()
      b = await backing(w)
      expect(b.supply).to.equal(b.usdc)

      // a sell: the bag is burned, the dollars are in flight on the hub's books
      const rep = await ethers.getContractAt('SpawnToken', await base.gateway.replicaOf(token))
      await (await base.gateway.connect(user).sellToken(token, await rep.balanceOf(user))).wait()
      await w.deliverAll()
      b = await backing(w)
      expect(b.supply).to.equal(b.usdc)
      expect(await base.usdc.balanceOf(user)).to.be.gt(U(497)) // 500 minus two 1% fees
    })
  })

  /* ------------------------- payouts never revert ------------------------- */

  describe('payouts never revert', () => {
    it('a short vault pays in oUSD claims; CCTP rebalancing makes them redeemable', async () => {
      const A = world.chains[2] // base: where the money comes in
      const B = world.chains[4] // arbitrum: where the winner cashes out
      const token = await spawnVia(A)
      await fundUsdc(B, user2, 100)
      await fundUsdc(A, user, 6_000)

      await (await B.gateway.connect(user2).buyTokenUsdc(token, U(100))).wait()
      await (await A.gateway.connect(user).buyTokenUsdc(token, U(5_000))).wait() // pumps the curve
      expect(await B.usd.liquidity()).to.equal(U(100))

      // user2's bag is now worth far more than chain B's vault holds
      const repB = await replica(B, token)
      await expect(B.gateway.connect(user2).sellToken(token, await repB.balanceOf(user2)))
        .to.emit(B.usd, 'PaidOut')
        .withArgs(user2.address, 0n, anyValue)
      const claim = await B.usd.balanceOf(user2)
      expect(claim).to.be.gt(E(250)) // the whole payout, as oUSD
      expect(await B.usdc.balanceOf(user2)).to.equal(0n)
      expect(await B.usd.liquidity()).to.equal(U(100)) // vault untouched
      await expectBacked() // the claim is fully backed — just on another chain

      // redeemable up to local liquidity right now, not beyond
      await expect(B.usd.connect(user2).unwrap(claim)).to.be.revertedWith('oUSD: vault short')
      await (await B.usd.connect(user2).unwrap(E(100))).wait()
      expect(await B.usdc.balanceOf(user2)).to.equal(U(100))
      await expectBacked()

      // the admin rebalances A -> B over CCTP; value is in flight, then lands
      await (await A.usd.setPeer(B.label, 3, b32(B.usd.target))).wait()
      await (await A.usd.rebalance(B.label, U(500))).wait()
      let b = await backing(world)
      expect(b.supply - b.usdc).to.equal(E(500)) // burned on A, not yet minted on B
      await (await B.usdc.mint(B.usd.target, U(500))).wait() // Circle mints to the peer vault
      await expectBacked()

      // the rest of the claim redeems; only sub-USDC dust remains
      const rest = await B.usd.balanceOf(user2)
      await (await B.usd.connect(user2).unwrap(rest)).wait()
      expect(await B.usdc.balanceOf(user2)).to.equal(claim / SCALE)
      expect(await B.usd.balanceOf(user2)).to.be.lt(SCALE)
      await expectBacked()
    })

    it('a USDC-blacklisted recipient is paid in oUSD instead of stranding the message', async () => {
      const c = world.chains[5]
      const token = await spawnVia(c)
      await fundUsdc(c, user2, 300)
      await (await c.gateway.connect(user2).buyTokenUsdc(token, U(200))).wait()
      const liquidity = await c.usd.liquidity()

      await (await c.usdc.setBlacklisted(user2.address, true)).wait()
      const rep = await replica(c, token)
      await expect(c.gateway.connect(user2).sellToken(token, await rep.balanceOf(user2)))
        .to.emit(c.usd, 'PaidOut')
        .withArgs(user2.address, 0n, anyValue)
      const claim = await c.usd.balanceOf(user2)
      expect(claim).to.be.gt(E(190)) // ≈ $200 minus two 1% fees
      expect(await c.usd.liquidity()).to.equal(liquidity) // the vault kept the USDC
      await expectBacked()

      // while blacklisted the claim cannot be redeemed to that account…
      await expect(c.usd.connect(user2).unwrap(claim)).to.be.reverted
      // …and once Circle lifts it, it redeems like any other oUSD
      await (await c.usdc.setBlacklisted(user2.address, false)).wait()
      await (await c.usd.connect(user2).unwrap(claim)).wait()
      expect(await c.usdc.balanceOf(user2)).to.equal(U(100) + claim / SCALE)
      await expectBacked()
    })

    it('payout, driven directly: liquid, short, dust-only and zero amounts all settle', async () => {
      const c = world.chains[3]
      await fundUsd(c, user, 10) // vault: $10
      const gw = await as(c.gateway.target)
      const to = user2.address

      // liquid: $4.000001 + 7 wei -> 4.000001 USDC out, 7 wei of oUSD minted
      await expect(c.usd.connect(gw).payout(to, E(4.000001) + 7n))
        .to.emit(c.usd, 'PaidOut')
        .withArgs(to, U(4.000001), 7n)
      expect(await c.usdc.balanceOf(to)).to.equal(U(4.000001))
      expect(await c.usd.balanceOf(to)).to.equal(7n)

      // short: the vault holds < $50 -> all-or-nothing, the whole amount is minted
      await expect(c.usd.connect(gw).payout(to, E(50)))
        .to.emit(c.usd, 'PaidOut')
        .withArgs(to, 0n, E(50))
      expect(await c.usd.balanceOf(to)).to.equal(E(50) + 7n)

      // dust-only and zero amounts
      await expect(c.usd.connect(gw).payout(to, 999n)).to.emit(c.usd, 'PaidOut').withArgs(to, 0n, 999n)
      await expect(c.usd.connect(gw).payout(to, 0)).to.emit(c.usd, 'PaidOut').withArgs(to, 0n, 0n)
      expect(await worth(c, to)).to.equal(E(4.000001) + 7n + E(50) + 999n)
    })
  })

  /* ----------------------------- rebalancing ----------------------------- */

  describe('CCTP rebalancing', () => {
    it('is admin-only, peer-locked, and aims exactly at the configured peer vault', async () => {
      const A = world.chains[2]
      const B = world.chains[4]
      await fundUsd(A, user, 1_000)
      const peer = b32(B.usd.target)

      // no route until a peer is named
      await expect(A.usd.rebalance(B.label, U(100))).to.be.revertedWith('oUSD: no peer')
      await expect(A.usd.connect(user).setPeer(B.label, 3, peer)).to.be.revertedWith('oUSD: not admin')
      await expect(A.usd.setPeer(B.label, 3, ethers.ZeroHash)).to.be.revertedWith('oUSD: bad peer')
      await expect(A.usd.setPeer(A.label, 3, peer)).to.be.revertedWith('oUSD: bad peer') // not itself
      await expect(A.usd.setPeer(B.label, 3, peer)).to.emit(A.usd, 'PeerSet').withArgs(B.label, 3, peer)

      // a peer is set once and can never be re-aimed
      await expect(A.usd.setPeer(B.label, 3, b32(user.address))).to.be.revertedWith('oUSD: peer set')

      await expect(A.usd.connect(user).rebalance(B.label, U(100))).to.be.revertedWith('oUSD: not admin')
      await expect(A.usd.rebalance(1, U(100))).to.be.revertedWith('oUSD: no peer') // another, unset label

      await expect(A.usd.rebalance(B.label, U(400)))
        .to.emit(A.usd, 'Rebalanced')
        .withArgs(B.label, 3, peer, U(400))
      expect(await A.usd.liquidity()).to.equal(U(600))

      // exactly what Circle's TokenMessengerV2 was asked to do
      const call = await A.cctp.lastCall()
      expect(call.caller).to.equal(A.usd.target)
      expect(call.amount).to.equal(U(400))
      expect(call.destinationDomain).to.equal(3n)
      expect(call.mintRecipient).to.equal(peer) // the peer vault, nothing else
      expect(call.burnToken).to.equal(A.usdc.target)
      expect(call.destinationCaller).to.equal(ethers.ZeroHash) // anyone may relay
      expect(call.maxFee).to.equal(0n) // Standard Transfer, no fee
      expect(call.minFinalityThreshold).to.equal(2000n) // finalized
      expect(await A.cctp.calls()).to.equal(1n)
      // the allowance was consumed in full — nothing lingers for the messenger
      expect(await A.usdc.allowance(A.usd.target, A.cctp.target)).to.equal(0n)

      // it cannot move more than the vault holds
      await expect(A.usd.rebalance(B.label, U(601))).to.be.reverted
    })

    it('does not exist on a chain deployed without CCTP', async () => {
      const usdc = await ethers.deployContract('MockUSDC')
      const usd = await ethers.deployContract('OmniUSD', [9, usdc.target, ethers.ZeroAddress])
      await (await usd.setPeer(5, 3, b32(user.address))).wait()
      await expect(usd.rebalance(5, U(1))).to.be.revertedWith('oUSD: no CCTP')
    })
  })
})
