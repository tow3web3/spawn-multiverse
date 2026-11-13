const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const { ethers, network, artifacts } = require('hardhat')
const { time, impersonateAccount, setBalance } = require('@nomicfoundation/hardhat-network-helpers')

const E = (n) => ethers.parseEther(String(n))
const b32 = (a) => ethers.zeroPadValue(a, 32)
const pastGenesis = () => time.increase(601)

/** The BNB universe is ONE chain: the hub (label 0) and its only gateway. */
const LABEL = 4 // bnb
const EID = 30102 // BNB Chain's LayerZero endpoint id
const BILLION = E(1_000_000_000)

/**
 * A SEPARATE, SINGLE-CHAIN universe settled in a local dollar (BSC USDT, 18
 * decimals) instead of Circle USDC: the pad, the curve, the ledger-mode
 * OmniUSD, the LayerZero adapter (used only as a loopback — no route is ever
 * set), the gateway, the replica token and the fee distributor are the SAME
 * contracts that run the USDC universe on mainnet, unchanged. The only new
 * custody code is the vault, `OmniUSDLocal`.
 *
 * Wiring order mirrors scripts/lib-net.js for a hub and its local gateway.
 *
 * `transport` picks the messenger, both existing contracts:
 *  - 'LayerZeroOmniMessenger' (default): the production adapter, constructed
 *    against the chain's EndpointV2 and used only through its loopback;
 *  - 'LocalOmniMessenger': the same-chain messenger with no LayerZero side at
 *    all — nothing can arrive from outside the chain (see the last describe).
 */
async function deployUniverse({
  decimals = 18,
  kind = 'MockDollar',
  autoDrop = true,
  transport = 'LayerZeroOmniMessenger',
} = {}) {
  const T = (n) => ethers.parseUnits(String(n), decimals)
  const lz = transport === 'LayerZeroOmniMessenger'
  const endpoint = lz ? await ethers.deployContract('MockLZEndpointV2', [E('0.001')]) : null
  const messenger = lz
    ? await ethers.deployContract('LayerZeroOmniMessenger', [endpoint.target, EID])
    : await ethers.deployContract('LocalOmniMessenger')

  const hubUsd = await ethers.deployContract('OmniUSD', [0, ethers.ZeroAddress, ethers.ZeroAddress])
  const pad = await ethers.deployContract('SpawnPad', [messenger.target, hubUsd.target])
  const venue = await ethers.deployContract('InternalCurveVenue', [pad.target])
  await (await pad.setVenue(venue.target)).wait()
  await (await hubUsd.setAgent(pad.target)).wait()
  await (await messenger.register(pad.target, 0)).wait()
  await (await messenger.setSponsored(pad.target, true)).wait()
  if (lz) {
    // both labels live on this chain; there is no remote chain to prepay
    await (await messenger.setLocal(0, true)).wait()
    await (await messenger.setLocal(LABEL, true)).wait()
    await (await messenger.setDestination(0, 0, 0)).wait()
  }

  const dollar =
    kind === 'MockNoReturnDollar'
      ? await ethers.deployContract('MockNoReturnDollar', [decimals])
      : await ethers.deployContract('MockDollar', ['Tether USD', 'USDT', decimals])
  const usd = await ethers.deployContract('OmniUSDLocal', [LABEL, dollar.target])
  // the REAL gateway, compiled against the OmniUSD type, pointed at the vault
  const gateway = await ethers.deployContract('SpawnGateway', [messenger.target, usd.target, LABEL, pad.target])
  await (await usd.setAgent(gateway.target)).wait()
  await (await usd.setDepositCap(T(1_000_000_000))).wait()
  await (await messenger.register(gateway.target, LABEL)).wait()
  // the holder pool exists before the pad learns the gateway
  const dist = await ethers.deployContract('FeeDistributor', [usd.target])
  await (await dist.setAgent(gateway.target)).wait()
  await (await dist.sealExclusions()).wait()
  await (await gateway.setDistributor(dist.target)).wait()
  await (await pad.setGateway(LABEL, b32(gateway.target))).wait()
  if (autoDrop) await (await pad.setAutoDrop(LABEL, true)).wait()
  // nothing is ever relayed: no reply to prepay, no SYNC fan-out
  await (await gateway.setLegs(0, 0)).wait()

  const SCALE = await usd.SCALE()
  const u = { endpoint, messenger, hubUsd, pad, venue, dollar, usd, gateway, dist, SCALE, T, decimals }

  u.fund = async (who, dollars) => {
    await (await dollar.mint(who.address, T(dollars))).wait()
    await (await dollar.connect(who).approve(usd.target, ethers.MaxUint256)).wait()
  }
  u.replica = async (token) => ethers.getContractAt('SpawnToken', await gateway.replicaOf(token))
  /** Both sides of the backing invariant, in oUSD wei. */
  u.backing = async () => ({
    held: (await dollar.balanceOf(usd.target)) * SCALE,
    supply: (await usd.totalSupply()) + (await hubUsd.totalSupply()),
  })
  /** Everything `who` holds in dollars, in oUSD wei: tokens + claims. */
  u.worth = async (who) => (await dollar.balanceOf(who.address)) * SCALE + (await usd.balanceOf(who.address))
  u.lastToken = async () => pad.allTokens((await pad.tokensLength()) - 1n)
  /** Hub inventory + everything circulating on the chain. */
  u.tokenSupply = async (token) => {
    const hub = await ethers.getContractAt('SpawnToken', token)
    return (await hub.totalSupply()) + (await (await u.replica(token)).totalSupply())
  }
  /** The invariants every step must leave true. */
  u.check = async (tokens = []) => {
    const b = await u.backing()
    expect(b.supply, 'backing: oUSD supply vs dollars held').to.equal(b.held)
    if (endpoint) {
      expect(await endpoint.packetsSent(), 'LayerZero packets').to.equal(0n)
      expect(await endpoint.pending()).to.equal(0n)
    }
    // no messaging fee was ever collected: the transport holds nothing
    expect(await ethers.provider.getBalance(messenger.target), 'messenger balance').to.equal(0n)
    for (const t of tokens) {
      const burned = (await pad.feesOf(t)).burnedTokens
      expect(await u.tokenSupply(t), 'token supply').to.equal(BILLION - burned)
    }
  }
  return u
}

/** The vault on its own, with a signer standing in for the gateway. */
async function deployVault({ decimals = 18, kind = 'MockDollar', cap = true } = {}) {
  const [, , , , agent] = await ethers.getSigners()
  const T = (n) => ethers.parseUnits(String(n), decimals)
  const dollar =
    kind === 'MockNoReturnDollar'
      ? await ethers.deployContract('MockNoReturnDollar', [decimals])
      : await ethers.deployContract('MockDollar', ['Tether USD', 'USDT', decimals])
  const vault = await ethers.deployContract('OmniUSDLocal', [LABEL, dollar.target])
  await (await vault.setAgent(agent.address)).wait()
  if (cap) await (await vault.setDepositCap(T(1_000_000_000))).wait()
  const fund = async (who, dollars) => {
    await (await dollar.mint(who.address, T(dollars))).wait()
    await (await dollar.connect(who).approve(vault.target, ethers.MaxUint256)).wait()
  }
  return { dollar, vault, agent, T, fund, SCALE: await vault.SCALE() }
}

describe('BNB universe — a single-chain SPAWN! settled in a local dollar', () => {
  let admin, user, user2, stranger, operator, guardian

  beforeEach(async () => {
    // signer 4 is the stand-in agent of deployVault
    ;[admin, user, user2, stranger, , operator, guardian] = await ethers.getSigners()
  })

  // two scenarios run over both transports; each is defined where it is first used
  let tokenLife, mixedScenario

  /* ------------------------------ the vault alone ------------------------------ */

  describe('OmniUSDLocal — the vault', () => {
    for (const decimals of [18, 8, 6]) {
      it(`wraps and unwraps 1:1 at ${decimals} decimals; dust rules follow SCALE`, async () => {
        const { dollar, vault, T, fund, SCALE } = await deployVault({ decimals })
        expect(SCALE).to.equal(10n ** BigInt(18 - decimals))
        await fund(user, 100)

        await expect(vault.connect(user).wrap(T(100)))
          .to.emit(vault, 'Wrapped')
          .withArgs(user.address, T(100), E(100))
        expect(await vault.balanceOf(user)).to.equal(E(100))
        expect(await dollar.balanceOf(vault.target)).to.equal(T(100))
        expect(await vault.liquidity()).to.equal(T(100))

        if (SCALE > 1n) {
          // only whole token units burn: the half-unit of dust stays put
          await expect(vault.connect(user).unwrap(E(40) + SCALE / 2n))
            .to.emit(vault, 'Unwrapped')
            .withArgs(user.address, T(40))
          expect(await vault.balanceOf(user)).to.equal(E(60))
          await expect(vault.connect(user).unwrap(SCALE - 1n)).to.be.revertedWith('oUSD: dust')
        } else {
          // SCALE == 1: there is no dust — a single wei redeems for a single wei
          await (await vault.connect(user).unwrap(E(40))).wait()
          expect(await vault.balanceOf(user)).to.equal(E(60))
          await expect(vault.connect(user).unwrap(1n)).to.emit(vault, 'Unwrapped').withArgs(user.address, 1n)
          await (await dollar.connect(user).approve(vault.target, ethers.MaxUint256)).wait()
          await (await vault.connect(user).wrap(1n)).wait() // and a single wei wraps back
        }
        await expect(vault.connect(user).unwrap(0n)).to.be.revertedWith('oUSD: dust')
        expect(await dollar.balanceOf(user)).to.equal(T(40))
        // exact conservation
        expect((await dollar.balanceOf(vault.target)) * SCALE).to.equal(await vault.totalSupply())
      })
    }

    it('accepts a dollar of 6 to 18 decimals and nothing else', async () => {
      const F = await ethers.getContractFactory('OmniUSDLocal')
      await expect(F.deploy(LABEL, ethers.ZeroAddress)).to.be.revertedWith('oUSD: no token')
      for (const bad of [0, 5, 19, 24]) {
        const d = await ethers.deployContract('MockDollar', ['X', 'X', bad])
        await expect(F.deploy(LABEL, d.target)).to.be.revertedWith('oUSD: token decimals')
      }
      for (const [good, scale] of [[6, 10n ** 12n], [9, 10n ** 9n], [18, 1n]]) {
        const d = await ethers.deployContract('MockDollar', ['X', 'X', good])
        expect(await (await F.deploy(LABEL, d.target)).SCALE()).to.equal(scale)
      }
    })

    it('deposits are closed until the operator opens them; the cap counts what the vault holds', async () => {
      const { dollar, vault, agent, T, fund } = await deployVault({ cap: false })
      await fund(user, 1_000)
      expect(await vault.depositCap()).to.equal(0n)
      await expect(vault.connect(user).wrap(T(1))).to.be.revertedWith('oUSD: deposit cap')
      await expect(vault.connect(agent).depositFor(user.address, T(1))).to.be.revertedWith('oUSD: deposit cap')

      await expect(vault.setDepositCap(T(100))).to.emit(vault, 'DepositCapSet').withArgs(T(100))
      await (await vault.connect(user).wrap(T(60))).wait()
      await expect(vault.connect(user).wrap(T(41))).to.be.revertedWith('oUSD: deposit cap')
      await (await vault.connect(agent).depositFor(user.address, T(40))).wait()
      await expect(vault.connect(agent).depositFor(user.address, 1n)).to.be.revertedWith('oUSD: deposit cap')
      // exits are not capped
      await (await vault.connect(user).unwrap(E(10))).wait()
      // a donation fills the cap like a deposit would (the operator raises it)
      await (await dollar.mint(vault.target, T(10))).wait()
      await expect(vault.connect(user).wrap(T(1))).to.be.revertedWith('oUSD: deposit cap')
      await expect(vault.connect(user).wrap(0n)).to.be.revertedWith('oUSD: zero')
    })

    it('roles: the admin names the agent once, the operator sets the cap, the guardian only closes deposits', async () => {
      const { vault, agent, T, fund } = await deployVault()
      await (await vault.setOperator(operator.address)).wait()
      await (await vault.setGuardian(guardian.address)).wait()
      await fund(user, 500)
      await (await vault.connect(user).wrap(T(100))).wait()

      await expect(vault.setAgent(stranger.address)).to.be.revertedWith('oUSD: agent set')
      const fresh = await ethers.deployContract('OmniUSDLocal', [LABEL, await vault.usdc()])
      await expect(fresh.connect(stranger).setAgent(stranger.address)).to.be.revertedWith('ROLES: not admin')
      await expect(vault.connect(stranger).setDepositCap(1n)).to.be.revertedWith('ROLES: not operator')
      await expect(vault.connect(guardian).setDepositCap(1n)).to.be.revertedWith('ROLES: not operator')
      await expect(vault.connect(stranger).pauseDeposits()).to.be.revertedWith('ROLES: not guardian')
      for (const fn of ['depositFor', 'payout', 'bridgeMint', 'bridgeBurn']) {
        await expect(vault.connect(stranger)[fn](user.address, 1n)).to.be.revertedWith('oUSD: not agent')
        await expect(vault.connect(admin)[fn](user.address, 1n)).to.be.revertedWith('oUSD: not agent')
      }

      await expect(vault.connect(guardian).pauseDeposits()).to.emit(vault, 'DepositsPaused').withArgs(guardian.address)
      await expect(vault.connect(user).wrap(T(1))).to.be.revertedWith('oUSD: deposits paused')
      await expect(vault.connect(agent).depositFor(user.address, T(1))).to.be.revertedWith('oUSD: deposits paused')
      // exits ignore the switch
      await (await vault.connect(user).unwrap(E(10))).wait()
      await (await vault.connect(agent).payout(user2.address, E(5))).wait()
      await expect(vault.connect(guardian).unpauseDeposits()).to.be.revertedWith('ROLES: not operator')
      await (await vault.connect(operator).unpauseDeposits()).wait()
      await (await vault.connect(user).wrap(T(1))).wait()

      // the admin is two-step transferable, like every other contract
      await (await vault.transferAdmin(stranger.address)).wait()
      await (await vault.connect(stranger).acceptAdmin()).wait()
      expect(await vault.admin()).to.equal(stranger.address)

      // there is no way out of the vault but a user's own redemption or a payout
      const names = vault.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name)
      expect(names.filter((n) => /rebalance|peer|messenger|recover|sweep|rescue|withdraw/i.test(n))).to.deep.equal([])
      expect(names.filter((n) => /pause/i.test(n)).sort()).to.deep.equal(['depositsPaused', 'pauseDeposits', 'unpauseDeposits'])
    })

    it('payout never reverts: tokens when it can, a redeemable claim when it cannot', async () => {
      const { dollar, vault, agent, T, fund } = await deployVault()
      await fund(user, 5_000)
      await (await vault.connect(user).wrap(T(100))).wait()

      // liquid: straight tokens, nothing minted
      await expect(vault.connect(agent).payout(user2.address, E(30)))
        .to.emit(vault, 'PaidOut')
        .withArgs(user2.address, T(30), 0n)
      expect(await dollar.balanceOf(user2)).to.equal(T(30))
      expect(await vault.balanceOf(user2)).to.equal(0n)

      // short vault (70 left): the WHOLE payout becomes a claim, not a partial one
      await expect(vault.connect(agent).payout(user2.address, E(500)))
        .to.emit(vault, 'PaidOut')
        .withArgs(user2.address, 0n, E(500))
      expect(await vault.balanceOf(user2)).to.equal(E(500))
      expect(await dollar.balanceOf(vault.target)).to.equal(T(70))
      await expect(vault.connect(user2).unwrap(E(500))).to.be.revertedWith('oUSD: vault short')
      // the claim redeems as soon as the vault is liquid again
      await (await vault.connect(user).wrap(T(1_000))).wait()
      await (await vault.connect(user2).unwrap(E(500))).wait()
      expect(await dollar.balanceOf(user2)).to.equal(T(530))

      // the issuer froze the recipient: a claim, not a stuck payout
      await (await dollar.setFrozen(stranger.address, true)).wait()
      await expect(vault.connect(agent).payout(stranger.address, E(10)))
        .to.emit(vault, 'PaidOut')
        .withArgs(stranger.address, 0n, E(10))
      expect(await vault.balanceOf(stranger)).to.equal(E(10))
      await expect(vault.connect(stranger).unwrap(E(10))).to.be.reverted // still frozen
      await (await dollar.setFrozen(stranger.address, false)).wait()
      await (await vault.connect(stranger).unwrap(E(10))).wait()
      expect(await dollar.balanceOf(stranger)).to.equal(T(10))

      // nothing to pay is nothing to do
      await expect(vault.connect(agent).payout(user2.address, 0n)).to.emit(vault, 'PaidOut').withArgs(user2.address, 0n, 0n)
    })

    it('sub-unit dust of a payout is minted, so nothing is lost at 6 decimals — and there is none at 18', async () => {
      const six = await deployVault({ decimals: 6 })
      await six.fund(user, 100)
      await (await six.vault.connect(user).wrap(six.T(100))).wait()
      const odd = E(7) + 123_456n // 7 dollars and a sub-unit remainder
      await expect(six.vault.connect(six.agent).payout(user2.address, odd))
        .to.emit(six.vault, 'PaidOut')
        .withArgs(user2.address, six.T(7), 123_456n)
      expect(await six.dollar.balanceOf(user2)).to.equal(six.T(7))
      expect(await six.vault.balanceOf(user2)).to.equal(123_456n)
      // a payout smaller than one token unit is all dust
      await expect(six.vault.connect(six.agent).payout(user2.address, 999n))
        .to.emit(six.vault, 'PaidOut')
        .withArgs(user2.address, 0n, 999n)

      const eighteen = await deployVault({ decimals: 18 })
      await eighteen.fund(user, 100)
      await (await eighteen.vault.connect(user).wrap(E(100))).wait()
      await expect(eighteen.vault.connect(eighteen.agent).payout(user2.address, odd))
        .to.emit(eighteen.vault, 'PaidOut')
        .withArgs(user2.address, odd, 0n)
      expect(await eighteen.dollar.balanceOf(user2)).to.equal(odd)
      expect(await eighteen.vault.balanceOf(user2)).to.equal(0n)
    })

    it('a deposit that rides a message is never smaller than the USDC universe\'s smallest (1e12 oUSD wei)', async () => {
      const { vault, agent, fund } = await deployVault({ decimals: 18 })
      await fund(user, 10)
      expect(await vault.MIN_DEPOSIT()).to.equal(10n ** 12n)
      await expect(vault.connect(agent).depositFor(user.address, 10n ** 12n - 1n)).to.be.revertedWith('oUSD: dust')
      expect(await vault.connect(agent).depositFor.staticCall(user.address, 10n ** 12n)).to.equal(10n ** 12n)
      await expect(vault.connect(agent).depositFor(user.address, 10n ** 12n))
        .to.emit(vault, 'Deposited')
        .withArgs(user.address, 10n ** 12n, 10n ** 12n)
      // wrap carries no message: it has no floor
      await (await vault.connect(user).wrap(1n)).wait()

      // at 6 decimals the floor is exactly one token unit — i.e. no extra rule
      const six = await deployVault({ decimals: 6 })
      await six.fund(user, 10)
      expect(await six.vault.connect(six.agent).depositFor.staticCall(user.address, 1n)).to.equal(10n ** 12n)
    })

    it('a fee-on-transfer dollar is credited for what arrived, not for what was sent', async () => {
      const { dollar, vault, agent, T, fund, SCALE } = await deployVault()
      await (await dollar.setFeeBps(100)).wait() // 1% burned on every transfer
      await fund(user, 1_000)

      await expect(vault.connect(user).wrap(T(100)))
        .to.emit(vault, 'Wrapped')
        .withArgs(user.address, T(99), E(99))
      expect(await vault.balanceOf(user)).to.equal(E(99))
      expect(await vault.connect(agent).depositFor.staticCall(user.address, T(200))).to.equal(E(198))
      await (await vault.connect(agent).depositFor(user.address, T(200))).wait()
      // the vault's books match its balance exactly (the 198 rode "a message")
      expect((await dollar.balanceOf(vault.target)) * SCALE).to.equal(E(99) + E(198))

      // on the way out the vault debits what it sends; the token's fee is the recipient's
      await (await vault.connect(user).unwrap(E(99))).wait()
      expect(await vault.totalSupply()).to.equal(0n)
      expect(await dollar.balanceOf(vault.target)).to.equal(T(198))
      expect(await dollar.balanceOf(user)).to.equal(T(700) + (T(99) * 99n) / 100n)
    })

    it('a dollar whose transfer returns nothing (USDT on Ethereum) works on every path', async () => {
      const { dollar, vault, agent, T, fund, SCALE } = await deployVault({ decimals: 6, kind: 'MockNoReturnDollar' })
      await fund(user, 1_000)
      await (await vault.connect(user).wrap(T(100))).wait()
      await (await vault.connect(agent).depositFor(user.address, T(50))).wait()
      await expect(vault.connect(agent).payout(user2.address, E(20)))
        .to.emit(vault, 'PaidOut')
        .withArgs(user2.address, T(20), 0n)
      await (await vault.connect(user).unwrap(E(100))).wait()
      expect(await dollar.balanceOf(user2)).to.equal(T(20))
      expect(await dollar.balanceOf(user)).to.equal(T(950))
      expect((await dollar.balanceOf(vault.target)) * SCALE).to.equal(E(30))
    })

    it('a token that calls back into the vault mid-deposit is refused', async () => {
      const { dollar, vault, T, fund } = await deployVault()
      await fund(user, 100)
      await (await dollar.armReentry(vault.target)).wait()
      await expect(vault.connect(user).wrap(T(10))).to.be.revertedWithCustomError(vault, 'ReentrancyGuardReentrantCall')
      // the same hook on the agent's path is refused the same way
      const [, , , , agent] = await ethers.getSigners()
      await expect(vault.connect(agent).depositFor(user.address, T(10))).to.be.revertedWithCustomError(
        vault,
        'ReentrancyGuardReentrantCall',
      )
      expect(await vault.totalSupply()).to.equal(0n)
      expect(await dollar.balanceOf(vault.target)).to.equal(0n)
    })

    it('fits the 24,576-byte runtime limit', async () => {
      const a = await artifacts.readArtifact('OmniUSDLocal')
      expect((a.deployedBytecode.length - 2) / 2).to.be.lte(24_576)
      expect((a.bytecode.length - 2) / 2).to.be.lte(49_152)
    })
  })

  /* ------------------------- ABI compatibility with OmniUSD ------------------------- */

  describe('drop-in for OmniUSD under the immutable gateway', () => {
    /** What OmniUSDLocal deliberately does not have. */
    const REMOVED_FUNCTIONS = ['tokenMessenger', 'peers', 'setPeer', 'rebalance', 'CCTP_FINALITY_STANDARD']
    const REMOVED_EVENTS = ['PeerSet', 'Rebalanced']
    // v7.1: OmniUSD carries the same MIN_DEPOSIT floor, so the vault adds nothing
    const ADDED_FUNCTIONS = []
    let omni, local

    before(async () => {
      omni = new ethers.Interface((await artifacts.readArtifact('OmniUSD')).abi)
      local = new ethers.Interface((await artifacts.readArtifact('OmniUSDLocal')).abi)
    })
    const shape = (f) => ({
      sig: f.format('sighash'),
      outputs: (f.outputs ?? []).map((o) => o.type),
      mutability: f.stateMutability,
    })

    it('every OmniUSD function except the CCTP surface exists with the same selector, outputs and mutability', async () => {
      const fns = omni.fragments.filter((f) => f.type === 'function')
      expect(fns.length).to.be.gt(30)
      for (const f of fns) {
        if (REMOVED_FUNCTIONS.includes(f.name)) {
          expect(local.fragments.some((x) => x.type === 'function' && x.name === f.name), `${f.name} must be gone`).to.equal(false)
          continue
        }
        const mine = local.getFunction(f.selector)
        expect(mine, `missing ${f.format('sighash')}`).to.not.equal(null)
        expect(shape(mine), f.format('sighash')).to.deep.equal(shape(f))
      }
      // …and it adds nothing at all
      const extra = local.fragments
        .filter((f) => f.type === 'function' && !fns.some((o) => o.selector === f.selector))
        .map((f) => f.name)
      expect(extra).to.deep.equal(ADDED_FUNCTIONS)
    })

    it('every OmniUSD event except the CCTP ones has the same topic and indexing', async () => {
      const key = (e) => `${e.topicHash}:${e.inputs.map((i) => (i.indexed ? 'i' : 'd')).join('')}`
      const mine = new Set(local.fragments.filter((f) => f.type === 'event').map(key))
      const theirs = omni.fragments.filter((f) => f.type === 'event')
      for (const e of theirs) {
        if (REMOVED_EVENTS.includes(e.name)) {
          expect(local.fragments.some((x) => x.type === 'event' && x.name === e.name), `${e.name} must be gone`).to.equal(false)
        } else {
          expect(mine.has(key(e)), `event ${e.format('sighash')}`).to.equal(true)
        }
      }
      expect(mine.size).to.equal(theirs.length - REMOVED_EVENTS.length)
    })

    it('every call the live contracts make on the OmniUSD type resolves to the same selector here', async () => {
      // read the calls out of the SOURCE of the contracts that hold an
      // `OmniUSD` reference and will be pointed at the vault
      const src = (name) => fs.readFileSync(path.join(__dirname, '..', 'contracts', name), 'utf8')
      const callsOn = (code) => new Set([...code.matchAll(/\b_?usd\.(\w+)\s*\(/g)].map((m) => m[1]))
      const gatewayCalls = callsOn(src('SpawnGateway.sol'))
      const distributorCalls = callsOn(src('FeeDistributor.sol'))
      // (v7.1: `SCALE` and `balanceOf` are read by the `*Min` slippage checks)
      expect([...gatewayCalls].sort()).to.deep.equal([
        'SCALE',
        'balanceOf',
        'bridgeBurn',
        'bridgeMint',
        'depositFor',
        'payout',
        'usdc',
      ])
      expect([...distributorCalls].sort()).to.deep.equal(['transfer'])
      for (const name of [...gatewayCalls, ...distributorCalls]) {
        const theirs = omni.getFunction(name)
        const mine = local.getFunction(name)
        expect(mine.selector, name).to.equal(theirs.selector)
        expect(shape(mine), name).to.deep.equal(shape(theirs))
        expect(mine.inputs.map((i) => i.type), name).to.deep.equal(theirs.inputs.map((i) => i.type))
      }
    })

    it('the real gateway accepts the vault at construction and refuses a ledger', async () => {
      const u = await deployUniverse()
      expect(await u.gateway.usd()).to.equal(u.usd.target)
      expect(await u.usd.usdc()).to.equal(u.dollar.target)
      // the gateway's own guard against a ledger-mode dollar still stands
      const G = await ethers.getContractFactory('SpawnGateway')
      await expect(G.deploy(u.messenger.target, u.hubUsd.target, LABEL, u.pad.target)).to.be.revertedWith('GW: ledger usd')
    })
  })

  /* --------------------- the whole universe, from the real contracts --------------------- */

  describe('one chain, one transaction per action, no LayerZero message', () => {
    /** Launch with a dev buy, buys, a sell, holder fees, both claims, unwrap. */
    tokenLife = async (u) => {
      const { gateway, pad, dollar, usd, dist, T } = u
      await u.fund(user, 2_000)
      await u.fund(user2, 2_000)

      // no message, so no messaging fee — for anything
      expect(await gateway.quoteSpawn('BNB FROG', 'BFROG', '{}', true)).to.equal(0n)
      expect(await gateway.quoteBuy()).to.equal(0n)
      expect(await gateway.quoteSell()).to.equal(0n)
      expect(await gateway.quoteClaim()).to.equal(0n)
      expect(await gateway.quotePull()).to.equal(0n)

      // launch + dev buy: fee mode 1 (half to holders, half to the dev)
      await (await gateway.connect(user).spawnTokenUsdc('BNB FROG', 'BFROG', '{}', T(50), 1)).wait()
      expect(await pad.tokensLength()).to.equal(1n)
      const token = await pad.allTokens(0)
      const rep = await u.replica(token)
      expect(rep.target).to.not.equal(ethers.ZeroAddress)
      expect(await rep.balanceOf(user)).to.be.gt(E(8_000_000)) // ~$50 at the opening price, untaxed
      expect(await dollar.balanceOf(user)).to.equal(T(1_950))
      expect(await pad.genesisSpent(token, b32(user.address))).to.equal(0n) // the exempt genesis buy
      expect((await pad.getToken(0)).homeChain).to.equal(BigInt(LABEL))
      await u.check([token])
      await pastGenesis()

      // a buy: the bag is there before the transaction ends
      await (await gateway.connect(user2).buyTokenUsdc(token, T(300))).wait()
      const bag = await rep.balanceOf(user2)
      expect(bag).to.be.gt(0n)
      expect(await dollar.balanceOf(user2)).to.equal(T(1_700))
      await u.check([token])

      // a second buy tips the holders pot over $2: the drop lands in the pool inline
      await (await gateway.connect(user).buyTokenUsdc(token, T(300))).wait()
      const owed = await dist.withdrawable(rep.target, user2.address)
      expect(owed).to.be.gt(0n)
      await u.check([token])

      // a sell: paid in the dollar token, same transaction
      await (await gateway.connect(user2).sellToken(token, bag / 2n)).wait()
      expect(await dollar.balanceOf(user2)).to.be.gt(T(1_700))
      expect(await usd.balanceOf(user2)).to.equal(0n)
      await u.check([token])

      // holder fees: claimed as oUSD, unwrapped to the dollar token with no dust
      const before = await dollar.balanceOf(user2)
      await (await dist.connect(user2).claim(rep.target)).wait()
      const claimed = await usd.balanceOf(user2)
      expect(claimed).to.be.gte(owed)
      await (await usd.connect(user2).unwrap(claimed)).wait()
      expect(await usd.balanceOf(user2)).to.equal(0n)
      expect(await dollar.balanceOf(user2)).to.equal(before + claimed)
      await u.check([token])

      // the dev's half: a "message" to the hub and back, inside one transaction
      const devBefore = await dollar.balanceOf(user)
      await (await gateway.connect(user).claimFees(token)).wait()
      expect(await dollar.balanceOf(user)).to.be.gt(devBefore)
      expect((await pad.feesOf(token)).devClaimed).to.be.gt(0n)

      // a pull has nothing to bring (drops are inline here) and harms nothing
      await (await gateway.connect(stranger).pullFees(token)).wait()
      expect(await pad.pendingDrop(token, LABEL)).to.equal(0n)
      await u.check([token])
    }

    it('a whole token life — launch with a dev buy, buys, a sell, holder fees, both claims, unwrap', async () => {
      await tokenLife(await deployUniverse())
    })

    it('money already held as oUSD trades without a new deposit (the gateway\'s other entry path)', async () => {
      const u = await deployUniverse()
      await u.fund(user, 1_000)
      await (await u.usd.connect(user).wrap(u.T(600))).wait()
      await (await u.gateway.connect(user).spawnToken('CLAIM COIN', 'CLM', '{}', E(40), 0)).wait()
      const token = await u.lastToken()
      await pastGenesis()
      await (await u.gateway.connect(user).buyToken(token, E(100))).wait()
      expect(await u.usd.balanceOf(user)).to.equal(E(460))
      expect(await u.dollar.balanceOf(user)).to.equal(u.T(400))
      expect(await (await u.replica(token)).balanceOf(user)).to.be.gt(0n)
      await u.check([token])
    })

    it('block 0 does not exist: a buy in the launch block bounces whole, refunded in the dollar token', async () => {
      const u = await deployUniverse()
      await u.fund(user2, 100)
      // the pad's first CREATE: the snipe can name the token before it exists
      const predicted = ethers.getCreateAddress({ from: u.pad.target, nonce: 1 })

      await network.provider.send('evm_setAutomine', [false])
      const txSpawn = await u.gateway.connect(user).spawnToken('GUARDED', 'GRD', '{}', 0, 0)
      const txSnipe = await u.gateway.connect(user2).buyTokenUsdc(predicted, u.T(50), { gasLimit: 3_000_000 })
      await network.provider.send('evm_mine')
      await network.provider.send('evm_setAutomine', [true])
      await txSpawn.wait()
      const rcpt = await txSnipe.wait()

      const token = await u.pad.allTokens(0)
      expect(token).to.equal(predicted)
      expect((await rcpt.getBlock()).number).to.equal(Number(await u.pad.spawnBlock(token)))
      // pulled into the vault and paid straight back out, in one transaction
      expect(await (await u.replica(token)).balanceOf(user2)).to.equal(0n)
      expect(await u.dollar.balanceOf(user2)).to.equal(u.T(100))
      expect(await u.usd.balanceOf(user2)).to.equal(0n)
      expect(await u.dollar.balanceOf(u.usd.target)).to.equal(0n)
      await expect(txSnipe).to.emit(u.pad, 'GenesisGuard')
      expect((await u.pad.feesOf(token)).total).to.equal(0n)
      await u.check([token])
    })

    it('FAIR GENESIS clamps a wallet at $250 in the window and refunds the rest at once; the tax is real', async () => {
      const u = await deployUniverse()
      await u.fund(user2, 1_000)
      await (await u.gateway.connect(user).spawnToken('WINDOW', 'WIN', '{}', 0, 0)).wait()
      const token = await u.lastToken()

      const tx = await u.gateway.connect(user2).buyTokenUsdc(token, u.T(260))
      await expect(tx).to.emit(u.pad, 'GenesisGuard')
      expect(await u.dollar.balanceOf(user2)).to.equal(u.T(750)) // 250 spent, 10 came straight back
      expect(await u.pad.genesisSpent(token, b32(user2.address))).to.equal(E(250))
      // inside the window the fee is far above the plain 1%
      const fees = (await u.pad.feesOf(token)).total
      expect(fees).to.be.gt(E(25))
      expect(fees).to.be.lt(E(75.01))

      // at the cap: the next buy in the window bounces whole
      await (await u.gateway.connect(user2).buyTokenUsdc(token, u.T(40))).wait()
      expect(await u.dollar.balanceOf(user2)).to.equal(u.T(750))
      await u.check([token])

      await pastGenesis()
      await (await u.gateway.connect(user2).buyTokenUsdc(token, u.T(40))).wait()
      expect(await u.dollar.balanceOf(user2)).to.equal(u.T(710))
      await u.check([token])
    })

    it('burn mode: fees buy back on the curve and burn — supply shrinks, the books stay exact', async () => {
      const u = await deployUniverse()
      await u.fund(user, 5_000)
      await u.fund(user2, 5_000)
      await (await u.gateway.connect(user).spawnToken('ASHES', 'ASH', '{}', 0, 3)).wait()
      const token = await u.lastToken()
      await pastGenesis()

      await (await u.gateway.connect(user2).buyTokenUsdc(token, u.T(300))).wait()
      expect((await u.pad.feesOf(token)).burnedTokens).to.equal(0n) // $3 in the pot, trigger is $4
      await expect(u.gateway.connect(user).buyTokenUsdc(token, u.T(300))).to.emit(u.pad, 'BuybackBurn')
      const f = await u.pad.feesOf(token)
      expect(f.burnedTokens).to.be.gt(0n)
      expect(await u.tokenSupply(token)).to.equal(BILLION - f.burnedTokens)
      await u.check([token])
    })

    it('a paused gateway stops new exposure only; a paused hub bounces buys and refuses launches without reverting', async () => {
      const u = await deployUniverse()
      for (const c of [u.pad, u.gateway, u.usd]) {
        await (await c.setOperator(operator.address)).wait()
        await (await c.setGuardian(guardian.address)).wait()
      }
      await u.fund(user, 1_000)
      await u.fund(user2, 1_000)
      await (await u.gateway.connect(user).spawnToken('BRAKES', 'BRK', '{}', 0, 2)).wait() // dev-fee token
      const token = await u.lastToken()
      const rep = await u.replica(token)
      await pastGenesis()
      await (await u.gateway.connect(user2).buyTokenUsdc(token, u.T(300))).wait()
      const bag = await rep.balanceOf(user2)

      /* the gateway's switch */
      await (await u.gateway.connect(guardian).pause()).wait()
      await expect(u.gateway.connect(user2).buyTokenUsdc(token, u.T(10))).to.be.revertedWith('GW: paused')
      await expect(u.gateway.connect(user2).spawnTokenUsdc('X', 'X', '{}', u.T(5), 0)).to.be.revertedWith('GW: paused')
      expect(await u.dollar.balanceOf(user2)).to.equal(u.T(700))
      let before = await u.dollar.balanceOf(user2)
      await (await u.gateway.connect(user2).sellToken(token, bag / 4n)).wait() // exits stay open
      expect(await u.dollar.balanceOf(user2)).to.be.gt(before)
      before = await u.dollar.balanceOf(user)
      await (await u.gateway.connect(user).claimFees(token)).wait()
      expect(await u.dollar.balanceOf(user)).to.be.gt(before)
      await (await u.gateway.connect(operator).unpause()).wait()

      /* the hub's switch: nothing reverts, value goes home inside the same transaction */
      await (await u.pad.connect(guardian).pause()).wait()
      before = await u.dollar.balanceOf(user2)
      await expect(u.gateway.connect(user2).buyTokenUsdc(token, u.T(40)))
        .to.emit(u.pad, 'Refused')
        .withArgs(2, LABEL, b32(token), b32(user2.address), E(40), 1)
      expect(await u.dollar.balanceOf(user2)).to.equal(before)
      before = await u.dollar.balanceOf(user)
      await expect(u.gateway.connect(user).spawnTokenUsdc('TOO LATE', 'LATE', '{}', u.T(50), 0))
        .to.emit(u.pad, 'Refused')
        .withArgs(1, LABEL, ethers.ZeroHash, b32(user.address), E(50), 1)
      expect(await u.pad.tokensLength()).to.equal(1n)
      expect(await u.dollar.balanceOf(user)).to.equal(before)
      before = await u.dollar.balanceOf(user2)
      await (await u.gateway.connect(user2).sellToken(token, bag / 4n)).wait() // sells run through a paused hub
      expect(await u.dollar.balanceOf(user2)).to.be.gt(before)
      await (await u.pad.connect(operator).unpause()).wait()

      /* the vault's switch: no new dollars, exits untouched */
      await (await u.usd.connect(guardian).pauseDeposits()).wait()
      await expect(u.gateway.connect(user2).buyTokenUsdc(token, u.T(10))).to.be.revertedWith('oUSD: deposits paused')
      before = await u.dollar.balanceOf(user2)
      await (await u.gateway.connect(user2).sellToken(token, bag / 4n)).wait()
      expect(await u.dollar.balanceOf(user2)).to.be.gt(before)
      await (await u.usd.connect(operator).unpauseDeposits()).wait()
      await (await u.gateway.connect(user2).buyTokenUsdc(token, u.T(10))).wait()
      await u.check([token])
    })

    it('a seller the issuer froze is paid in a claim instead of failing the sale; dust buys are refused before any money moves', async () => {
      const u = await deployUniverse()
      await u.fund(user2, 1_000)
      await (await u.gateway.connect(user).spawnToken('COLD', 'COLD', '{}', 0, 0)).wait()
      const token = await u.lastToken()
      const rep = await u.replica(token)
      await pastGenesis()
      await (await u.gateway.connect(user2).buyTokenUsdc(token, u.T(200))).wait()

      await (await u.dollar.setFrozen(user2.address, true)).wait()
      const bag = await rep.balanceOf(user2)
      await (await u.gateway.connect(user2).sellToken(token, bag)).wait() // does not revert
      const claim = await u.usd.balanceOf(user2)
      expect(claim).to.be.gt(E(150))
      expect(await u.dollar.balanceOf(user2)).to.equal(u.T(800))
      await u.check([token])
      await (await u.dollar.setFrozen(user2.address, false)).wait()
      await (await u.usd.connect(user2).unwrap(claim)).wait()
      expect(await u.dollar.balanceOf(user2)).to.equal(u.T(800) + claim)

      // an 18-decimal dollar could express less than the hub has ever been
      // handed on the USDC universe: the vault refuses it, atomically
      await expect(u.gateway.connect(user2).buyTokenUsdc(token, 10n ** 12n - 1n)).to.be.revertedWith('oUSD: dust')
      await (await u.gateway.connect(user2).buyTokenUsdc(token, 10n ** 12n)).wait()
      await u.check([token])
    })

    it('holder fees also work the accrue-then-pull way when the label is not flagged autoDrop', async () => {
      const u = await deployUniverse({ autoDrop: false })
      await u.fund(user, 2_000)
      await u.fund(user2, 2_000)
      await (await u.gateway.connect(user).spawnToken('PULL ME', 'PULL', '{}', 0, 0)).wait()
      const token = await u.lastToken()
      const rep = await u.replica(token)
      await pastGenesis()
      await (await u.gateway.connect(user2).buyTokenUsdc(token, u.T(300))).wait()
      await (await u.gateway.connect(user).buyTokenUsdc(token, u.T(300))).wait()
      expect(await u.pad.pendingDrop(token, LABEL)).to.be.gt(0n)
      expect(await u.dist.withdrawable(rep.target, user2.address)).to.equal(0n)
      await (await u.gateway.connect(stranger).pullFees(token)).wait() // free here: a local call
      expect(await u.pad.pendingDrop(token, LABEL)).to.equal(0n)
      expect(await u.dist.withdrawable(rep.target, user2.address)).to.be.gt(0n)
      await u.check([token])
    })
  })

  /* ------------------------------- the invariant ------------------------------- */

  describe('backing: dollars held × SCALE == every oUSD in existence, hub ledger included', () => {
    mixedScenario = async (u) => {
      const { gateway, usd, dist, T } = u
      const tokens = []
      const step = async (fn) => {
        await (await fn()).wait()
        await u.check(tokens)
      }
      for (const who of [user, user2, stranger]) await u.fund(who, 20_000)

      await step(() => gateway.connect(user).spawnTokenUsdc('ALPHA', 'A', '{}', T(120), 1))
      tokens.push(await u.lastToken())
      await step(() => gateway.connect(user2).spawnToken('BETA', 'B', '{}', 0, 3))
      tokens.push(await u.lastToken())
      const [a, b] = tokens
      const repA = await u.replica(a)
      const repB = await u.replica(b)

      // inside the window: taxed, clamped, refunded
      await step(() => gateway.connect(user2).buyTokenUsdc(a, T(400)))
      await step(() => gateway.connect(stranger).buyTokenUsdc(b, T(90)))
      await pastGenesis()

      await step(() => gateway.connect(stranger).buyTokenUsdc(a, T(1_500)))
      await step(() => gateway.connect(user2).buyTokenUsdc(b, T(700)))
      await step(() => usd.connect(user).wrap(T(2_000)))
      await step(() => gateway.connect(user).buyToken(a, E(800)))
      await step(async () => gateway.connect(user2).sellToken(a, (await repA.balanceOf(user2)) / 3n))
      await step(async () => gateway.connect(stranger).sellToken(a, await repA.balanceOf(stranger)))
      await step(() => gateway.connect(user).buyToken(b, E(650)))
      await step(async () => gateway.connect(user2).sellToken(b, (await repB.balanceOf(user2)) / 2n))
      await step(() => dist.connect(user2).claim(repA.target))
      await step(async () => usd.connect(user2).unwrap(await usd.balanceOf(user2)))
      await step(() => gateway.connect(user).claimFees(a))
      await step(() => gateway.connect(stranger).pullFees(a))
      await step(() => usd.connect(user).unwrap(E(300)))
      await step(() => gateway.connect(stranger).buyTokenUsdc(b, T(2_500)))
      await step(async () => gateway.connect(user).sellToken(a, await repA.balanceOf(user)))
      await step(async () => gateway.connect(user).sellToken(b, await repB.balanceOf(user)))

      // the burn-mode token really burned along the way
      expect((await u.pad.feesOf(b)).burnedTokens).to.be.gt(0n)
    }

    it('holds after every step of a long mixed scenario', async () => {
      await mixedScenario(await deployUniverse())
    })

    for (const decimals of [18, 6, 8]) {
      it(`holds through a randomized trade sequence at ${decimals} decimals`, async () => {
        const u = await deployUniverse({ decimals })
        const { gateway, usd, dist, dollar, T } = u
        const people = [user, user2, stranger]
        for (const who of people) await u.fund(who, 50_000)
        await (await gateway.connect(user).spawnTokenUsdc('RANDOM ONE', 'R1', '{}', T(30), 0)).wait()
        const t1 = await u.lastToken()
        await (await gateway.connect(user2).spawnToken('RANDOM TWO', 'R2', '{}', 0, 3)).wait()
        const t2 = await u.lastToken()
        const tokens = [t1, t2]
        const reps = [await u.replica(t1), await u.replica(t2)]
        await pastGenesis()

        let seed = 0xb1b0n + BigInt(decimals)
        const rnd = (mod) => {
          seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n
          return (seed >> 24n) % BigInt(mod) // an LCG's low bits cycle; use the high ones
        }
        const steps = decimals === 18 ? 70 : 40
        let trades = 0
        for (let i = 0; i < steps; i++) {
          const who = people[Number(rnd(3))]
          const k = Number(rnd(2))
          const token = tokens[k]
          const rep = reps[k]
          const action = Number(rnd(10))
          if (action < 4) {
            // a buy in the dollar token, from cents to hundreds of dollars — odd wei included
            const amount = T(1 + Number(rnd(900))) + rnd(10n ** BigInt(decimals))
            await (await gateway.connect(who).buyTokenUsdc(token, amount)).wait()
            trades++
          } else if (action < 6) {
            // a buy with oUSD already held
            const held = await usd.balanceOf(who)
            if (held >= 10n ** 12n) {
              // the gateway's own floor on this path is 1e12 oUSD wei
              const part = held - rnd(held / 2n + 1n)
              await (await gateway.connect(who).buyToken(token, part >= 10n ** 12n ? part : held)).wait()
              trades++
            } else {
              await (await usd.connect(who).wrap(T(50 + Number(rnd(200))))).wait()
            }
          } else if (action < 9) {
            const bag = await rep.balanceOf(who)
            const part = bag / (1n + rnd(4))
            if (part >= 10n ** 12n) {
              await (await gateway.connect(who).sellToken(token, part)).wait()
              trades++
            }
          } else {
            if ((await dist.withdrawable(rep.target, who.address)) > 0n) await (await dist.connect(who).claim(rep.target)).wait()
            const held = await usd.balanceOf(who)
            if (held >= u.SCALE) await (await usd.connect(who).unwrap(held)).wait()
          }
          await u.check(tokens)
        }
        expect(trades).to.be.gt(steps / 3)

        // everyone leaves: every bag sold, every fee claimed, every claim redeemed
        for (const who of people) {
          for (const [k, rep] of reps.entries()) {
            const bag = await rep.balanceOf(who)
            if (bag >= 10n ** 12n) await (await gateway.connect(who).sellToken(tokens[k], bag)).wait()
            if ((await dist.withdrawable(rep.target, who.address)) > 0n) await (await dist.connect(who).claim(rep.target)).wait()
          }
          const held = await usd.balanceOf(who)
          if (held >= u.SCALE) await (await usd.connect(who).unwrap(held)).wait()
        }
        await u.check(tokens)
        // nobody is left holding a claim bigger than sub-unit dust (none at
        // all at 18 decimals): every dollar owed could be taken out
        for (const who of people) {
          const left = await usd.balanceOf(who)
          if (u.SCALE === 1n) expect(left).to.equal(0n)
          else expect(left).to.be.lt(u.SCALE)
        }
        // and the vault still holds, to the unit, what the hub's books and
        // the holder pool account for
        const pool = await usd.balanceOf(dist.target)
        const ledger = await u.hubUsd.totalSupply()
        const dust = (await usd.totalSupply()) - pool
        expect((await dollar.balanceOf(usd.target)) * u.SCALE).to.equal(ledger + pool + dust)
        expect(dust).to.be.lt(3n * u.SCALE)
      })
    }
  })

  /* ------------------- what can reach the vault from outside the chain ------------------- */

  describe('transport: a one-chain universe should have no outside', () => {
    const coder = ethers.AbiCoder.defaultAbiCoder()
    const FOREIGN_EID = 30184 // any chain this universe has no peer on (it has none)
    /** A PAYOUT "from the pad" to `to`, enveloped the way the adapters do. */
    const forgedPayout = (u, to, amount) => {
      const payload = coder.encode(['uint8', 'bytes'], [12, coder.encode(['bytes32', 'uint256'], [b32(to), amount])])
      const message = coder.encode(['bytes32', 'bytes32', 'bytes'], [b32(u.pad.target), b32(u.gateway.target), payload])
      return { payload, message }
    }
    async function asEndpoint(u) {
      await impersonateAccount(u.endpoint.target)
      await setBalance(u.endpoint.target, E(1))
      return ethers.getSigner(u.endpoint.target)
    }
    /** An honest user leaves 1,000 dollars in the vault. */
    async function seed(u) {
      await u.fund(user, 1_000)
      await (await u.usd.connect(user).wrap(u.T(1_000))).wait()
    }

    it('LayerZero adapter: only the endpoint delivers, and a packet from a chain with no peer is refused', async () => {
      const u = await deployUniverse()
      await seed(u)
      const { message } = forgedPayout(u, stranger.address, E(1_000))
      const origin = { srcEid: FOREIGN_EID, sender: b32(stranger.address), nonce: 1 }

      await expect(
        u.messenger.connect(stranger).lzReceive(origin, ethers.ZeroHash, message, stranger.address, '0x'),
      ).to.be.revertedWith('LZM: not endpoint')
      expect(await u.messenger.allowInitializePath(origin)).to.equal(false)
      const ep = await asEndpoint(u)
      await expect(
        u.messenger.connect(ep).lzReceive(origin, ethers.ZeroHash, message, stranger.address, '0x'),
      ).to.be.revertedWith('LZM: not a peer')
      // and nobody but a registered local contract can use the loopback
      await expect(u.messenger.connect(stranger).send(LABEL, b32(u.gateway.target), '0x', 0)).to.be.revertedWith('LZM: unknown sender')
      expect(await u.dollar.balanceOf(u.usd.target)).to.equal(u.T(1_000))
    })

    // SPEC F-11. The v7.0 adapter took this packet for the hub and paid it
    // (an unset peer is bytes32(0), an unset label is 0 — the hub's label);
    // v71.test.js replays it against a frozen copy of that adapter. It was
    // never reachable by a user: LayerZero itself would have to deliver such
    // a packet (a source chain where an OApp can have the all-zero address,
    // or the receive library / verifier set that applies to a chain we never
    // configured, i.e. LayerZero's defaults). The v7.1 adapter refuses it,
    // like LayerZero's own OApp base ("NoPeer") — and THIS universe has no
    // route at all, so every chain on earth is a chain with no peer.
    it('LayerZero adapter: a packet with an ALL-ZERO sender from a peerless chain is refused, on a chain with no route at all (F-11)', async () => {
      const u = await deployUniverse()
      await seed(u)
      const { message } = forgedPayout(u, stranger.address, E(1_000))
      const ep = await asEndpoint(u)

      for (const srcEid of [FOREIGN_EID, EID, 0, 30168]) {
        const origin = { srcEid, sender: ethers.ZeroHash, nonce: 1 }
        // the two defaults that used to line up: no peer, and the hub's label
        expect(await u.messenger.peers(srcEid)).to.equal(ethers.ZeroHash)
        expect(await u.messenger.labelOf(srcEid)).to.equal(0n)
        expect(await u.messenger.allowInitializePath(origin), `eid ${srcEid}`).to.equal(false)
        await expect(
          u.messenger.connect(ep).lzReceive(origin, ethers.ZeroHash, message, stranger.address, '0x'),
          `eid ${srcEid}`,
        ).to.be.revertedWith('LZM: not a peer')
      }
      expect(await u.dollar.balanceOf(stranger)).to.equal(0n)
      expect(await u.dollar.balanceOf(u.usd.target)).to.equal(u.T(1_000))
      // the user's claim is still backed, to the unit
      expect(await u.usd.balanceOf(user)).to.equal(E(1_000))
      await u.check()
    })

    it('LocalOmniMessenger has no LayerZero side: nothing arrives from outside, and a registered impostor is still nobody', async () => {
      const u = await deployUniverse({ transport: 'LocalOmniMessenger' })
      await seed(u)
      const names = u.messenger.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name)
      expect(names.filter((n) => /lz|peer|route|delegate|initialize|nonce/i.test(n))).to.deep.equal([])

      const { payload } = forgedPayout(u, stranger.address, E(1_000))
      await expect(u.messenger.connect(stranger).send(LABEL, b32(u.gateway.target), payload, 0)).to.be.revertedWith('LOM: unknown sender')

      // even the admin registering an impostor gains nothing: the source is
      // msg.sender, and the gateway and the pad each know exactly one address
      await (await u.messenger.register(stranger.address, 0)).wait()
      await expect(u.messenger.connect(stranger).send(LABEL, b32(u.gateway.target), payload, 0)).to.be.revertedWith('GW: not the pad')
      await (await u.messenger.register(stranger.address, LABEL)).wait()
      const buy = coder.encode(
        ['uint8', 'bytes'],
        [2, coder.encode(['bytes32', 'bytes32', 'uint256'], [ethers.ZeroHash, b32(stranger.address), E(1_000_000)])],
      )
      await expect(u.messenger.connect(stranger).send(0, b32(u.pad.target), buy, 0)).to.be.revertedWith('PAD: not a gateway')
      expect(await u.dollar.balanceOf(u.usd.target)).to.equal(u.T(1_000))
      expect(await u.hubUsd.totalSupply()).to.equal(0n)

      // its one tunable is a flat fee per message. It is 0, and it must stay
      // with the (time-locked) admin: a fee nobody attached would close exits
      expect(await u.messenger.flatFee()).to.equal(0n)
      expect(await u.messenger.operator()).to.equal(ethers.ZeroAddress)
      await expect(u.messenger.connect(stranger).setFlatFee(1n)).to.be.revertedWith('ROLES: not operator')
    })

    it('the whole universe runs unchanged over LocalOmniMessenger', async () => {
      await tokenLife(await deployUniverse({ transport: 'LocalOmniMessenger' }))
      await mixedScenario(await deployUniverse({ transport: 'LocalOmniMessenger' }))
      // and the quotes are still zero
      const u = await deployUniverse({ transport: 'LocalOmniMessenger' })
      expect(await u.gateway.quoteSpawn('X', 'X', '{}', true)).to.equal(0n)
      expect(await u.gateway.quoteSell()).to.equal(0n)
    })
  })
})
