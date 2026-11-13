const { expect } = require('chai')
const { ethers } = require('hardhat')
const { time } = require('@nomicfoundation/hardhat-network-helpers')
const { deployWorld, deployWorldAsync, fundUsd, worth, backing } = require('../scripts/lib-deploy')

const E = (n) => ethers.parseEther(String(n))
// Hop past the FAIR GENESIS window (v6) — these suites test the fee stream
// at the steady-state 1%, not the anti-snipe opening.
const pastGenesis = () => time.increase(601)
const DUST = E(0.000001) // magnified-dividend rounding, a few wei per drop

describe('Holder fee distribution (protocol v3)', () => {
  /* ----------------- distributor math, driven directly ----------------- */

  describe('FeeDistributor math', () => {
    let deployer, a, b, c, usd, dist, tok

    beforeEach(async () => {
      ;[deployer, a, b, c] = await ethers.getSigners()
      // a ledger-mode oUSD driven by hand: the math under test is the
      // distributor's, not the vault's
      usd = await ethers.deployContract('OmniUSD', [0, ethers.ZeroAddress, ethers.ZeroAddress])
      await (await usd.setAgent(deployer.address)).wait()
      dist = await ethers.deployContract('FeeDistributor', [usd.target])
      await (await dist.setAgent(deployer.address)).wait() // test drives drops by hand
      tok = await ethers.deployContract('SpawnToken', [
        'TEST', 'TEST', deployer.address, true, 0, ethers.ZeroAddress, dist.target,
      ])
      await (await usd.bridgeMint(dist.target, E(1_000))).wait() // pre-fund claims
    })

    it('splits drops pro-rata and follows balances across transfers', async () => {
      await (await tok.bridgeMint(a.address, E(100))).wait()
      await (await tok.bridgeMint(b.address, E(50))).wait()

      await (await dist.drop(tok.target, E(30))).wait()
      expect(await dist.withdrawable(tok.target, a.address)).to.be.closeTo(E(20), DUST)
      expect(await dist.withdrawable(tok.target, b.address)).to.be.closeTo(E(10), DUST)

      // a sells/moves half their bag mid-stream: earned dividends stay put,
      // the NEXT drop follows the new balances
      await (await tok.connect(a).transfer(b.address, E(50))).wait()
      expect(await dist.withdrawable(tok.target, a.address)).to.be.closeTo(E(20), DUST)

      await (await dist.drop(tok.target, E(30))).wait()
      expect(await dist.withdrawable(tok.target, a.address)).to.be.closeTo(E(30), DUST)
      expect(await dist.withdrawable(tok.target, b.address)).to.be.closeTo(E(30), DUST)

      // claims pay oUSD and zero out; a second claim has nothing
      const wa = await dist.withdrawable(tok.target, a.address)
      await (await dist.connect(a).claim(tok.target)).wait()
      expect(await usd.balanceOf(a.address)).to.equal(wa)
      expect(await dist.withdrawable(tok.target, a.address)).to.equal(0n)
      await expect(dist.connect(a).claim(tok.target)).to.be.revertedWith('DIST: nothing to claim')
    })

    it('excluded protocol accounts earn nothing', async () => {
      await (await dist.exclude(c.address)).wait()
      await (await tok.bridgeMint(a.address, E(100))).wait()
      await (await tok.bridgeMint(c.address, E(900))).wait() // inventory, not a bag

      await (await dist.drop(tok.target, E(10))).wait()
      expect(await dist.withdrawable(tok.target, a.address)).to.be.closeTo(E(10), DUST)
      expect(await dist.withdrawable(tok.target, c.address)).to.equal(0n)
    })

    it('a drop with no holders waits for the first holder', async () => {
      await (await dist.drop(tok.target, E(10))).wait()
      expect(await dist.pendingOf(tok.target)).to.equal(E(10))

      await (await tok.bridgeMint(a.address, E(1))).wait()
      expect(await dist.pendingOf(tok.target)).to.equal(0n)
      expect(await dist.withdrawable(tok.target, a.address)).to.be.closeTo(E(10), DUST)
    })

    it('only the agent drops, only real claims pay', async () => {
      await expect(dist.connect(a).drop(tok.target, E(1))).to.be.revertedWith('DIST: not agent')
      await expect(dist.connect(a).claim(tok.target)).to.be.revertedWith('DIST: nothing to claim')
    })
  })

  /* ------------------- end to end on the local world ------------------- */

  describe('through the protocol (local world)', () => {
    let world, user, user2

    beforeEach(async () => {
      ;[, user, user2] = await ethers.getSigners()
      world = await deployWorld()
    })

    it('holders mode: the pot distributes to where the supply lives and a holder claims locally', async () => {
      const c = world.chains[1] // ethereum
      await (await c.gateway.connect(user).spawnToken('YIELD CAT', 'YCAT', '{}', 0, 0)).wait()
      await pastGenesis()
      const token = await world.pad.allTokens(0)
      await fundUsd(c, user, 1_000)

      // $300 buy -> $3 fee, all to holders, over the $2 trigger
      await (await c.gateway.connect(user).buyToken(token, E(300))).wait()

      // the hub knows where the supply lives
      const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
      expect(await world.pad.supplyByChain(token, c.label)).to.equal(await rep.totalSupply())

      // the whole pot landed in this chain's distributor for the sole holder
      const w = await c.dist.withdrawable(rep.target, user.address)
      expect(w).to.be.closeTo(E(3), DUST)
      const f = await world.pad.feesOf(token)
      expect(f.holdersPaid).to.equal(E(3))

      // claiming is a pure local tx and pays this chain's oUSD
      const before = await c.usd.balanceOf(user.address)
      await (await c.dist.connect(user).claim(rep.target)).wait()
      expect((await c.usd.balanceOf(user.address)) - before).to.equal(w)
      await expect(c.dist.connect(user).claim(rep.target)).to.be.revertedWith(
        'DIST: nothing to claim',
      )
    })

    it('split mode: holders stream distributes, the dev claim stays intact', async () => {
      const c = world.chains[3] // bnb
      await (await c.gateway.connect(user).spawnToken('HALFSIES', 'HALF', '{}', 0, 1)).wait()
      await pastGenesis()
      const token = await world.pad.allTokens(0)
      await fundUsd(c, user2, 1_000)
      await (await c.gateway.connect(user2).buyToken(token, E(600))).wait() // $6 fee: 3/3

      const rep = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
      expect(await c.dist.withdrawable(rep.target, user2.address)).to.be.closeTo(E(3), DUST)

      // the dev's half is untouched and claimable from any chain
      const claimChain = world.chains[5]
      const before = await worth(claimChain, user)
      await (await claimChain.gateway.connect(user).claimFees(token)).wait()
      expect((await worth(claimChain, user)) - before).to.equal(E(3))
    })

    it('oUSD is still conserved end to end with distributions in the mix', async () => {
      const a = world.chains[0]
      await (await a.gateway.connect(user).spawnToken('LEAKPROOF', 'LEAK', '{}', 0, 0)).wait()
      await pastGenesis()
      const token = await world.pad.allTokens(0)
      await fundUsd(a, user, 2_000)
      await (await a.gateway.connect(user).buyToken(token, E(900))).wait() // distributes
      const rep = await ethers.getContractAt('SpawnToken', await a.gateway.replicaOf(token))
      await (await a.gateway.connect(user).sellToken(token, (await rep.balanceOf(user)) / 3n)).wait()
      await (await a.dist.connect(user).claim(rep.target)).wait()

      // v7: every oUSD anywhere — pad books, distributor pools, claimed
      // rewards — is backed 1:1 by USDC sitting in a vault
      const { usdc, supply } = await backing(world)
      expect(supply).to.equal(usdc)
    })
  })

  /* -------------------- over async LayerZero transport -------------------- */

  describe('over async LayerZero V2 transport', () => {
    it('fee drops reach every chain; holders on two chains claim their pro-rata share locally', async () => {
      const [, user1, user2] = await ethers.getSigners()
      const world = await deployWorldAsync()
      const A = world.chains[2] // base — the hub's own chain: its drop is a loopback
      const B = world.chains[5] // optimism — its drop crosses as a packet

      await (await A.gateway.connect(user1).spawnToken('OMNIYIELD', 'OMY', '{}', 0, 0)).wait()
      await world.deliverAll()
      await time.increase(601) // past the FAIR GENESIS window
      const token = await world.pad.allTokens(0)

      await fundUsd(A, user1, 500)
      await fundUsd(B, user2, 500)

      // first buy: $1 fee, under the trigger — nothing distributes yet
      await (await A.gateway.connect(user1).buyToken(token, E(100))).wait()
      await world.deliverAll()

      // second buy tips the pot to $2: the hub splits it pro-rata to where
      // the supply lives and OP_FEE_DROP packets fan out with the delivery
      await (await B.gateway.connect(user2).buyToken(token, E(100))).wait()
      await world.deliverAll()

      const repA = await ethers.getContractAt('SpawnToken', await A.gateway.replicaOf(token))
      const repB = await ethers.getContractAt('SpawnToken', await B.gateway.replicaOf(token))
      const wA = await A.dist.withdrawable(repA.target, user1.address)
      const wB = await B.dist.withdrawable(repB.target, user2.address)
      expect(wA + wB).to.be.closeTo(E(2), DUST)
      expect(wA).to.be.gt(wB) // user1 bought first, cheaper — holds more supply

      // claiming is purely local: no new packets, oUSD lands immediately
      expect(await world.endpoint.pending()).to.equal(0n)
      const before = await A.usd.balanceOf(user1.address)
      await (await A.dist.connect(user1).claim(repA.target)).wait()
      expect((await A.usd.balanceOf(user1.address)) - before).to.equal(wA)
      expect(await world.endpoint.pending()).to.equal(0n)
    })
  })
})
