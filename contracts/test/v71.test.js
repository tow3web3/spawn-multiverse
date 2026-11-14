const { expect } = require('chai')
const { ethers, network } = require('hardhat')
const { time, impersonateAccount, setBalance, takeSnapshot } = require('@nomicfoundation/hardhat-network-helpers')
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs')
const { deployWorld, deployWorldAsync, fundUsd, fundUsdc, backing, worth, U, GAS_TO_SPOKE } = require('../scripts/lib-deploy')

const E = (n) => ethers.parseEther(String(n))
const b32 = (a) => ethers.zeroPadValue(a, 32)
const coder = ethers.AbiCoder.defaultAbiCoder()
const bal = (who) => ethers.provider.getBalance(who.target ?? who.address ?? who)
const pastGenesis = () => time.increase(601)
const BILLION = E(1_000_000_000)
/** OpenZeppelin ReentrancyGuard's `ReentrancyGuardReentrantCall()`. */
const REENTRANT = ethers.id('ReentrancyGuardReentrantCall()').slice(0, 10)

/** Runs `fn`, returns what it returns, and puts the chain back as it was —
 * the way to ask "what WOULD this trade give" without making it. */
async function peek(fn) {
  const snap = await takeSnapshot()
  try {
    return await fn()
  } finally {
    await snap.restore()
  }
}

async function as(address) {
  await impersonateAccount(address)
  await setBalance(address, E(10))
  return ethers.getSigner(address)
}

/* Wire payloads, as the pad and the gateways build them. */
const op = (code, types, values) => coder.encode(['uint8', 'bytes'], [code, coder.encode(types, values)])
const payout = (to, amount) => op(12, ['bytes32', 'uint256'], [b32(to), amount])
const buy = (token, buyer, usdIn) => op(2, ['bytes32', 'bytes32', 'uint256', 'uint256'], [token, buyer, usdIn, 0n])
/** The inter-adapter envelope: (source contract, local target, payload, the
 * reply budget it must arrive with — v7.2). */
const envelope = (srcSender, dst, payload, value = 0n) =>
  coder.encode(['bytes32', 'bytes32', 'bytes', 'uint256'], [srcSender, b32(dst), payload, value])
/** The same before v7.2 — what the frozen v7.0 adapter reads. */
const envelopeV70 = (srcSender, dst, payload) => coder.encode(['bytes32', 'bytes32', 'bytes'], [srcSender, b32(dst), payload])

/**
 * A SINGLE-CHAIN universe built from the real contracts: the hub (pad, curve,
 * ledger oUSD) and its only gateway on one chain, reached through the
 * production adapter's loopback — the hub chain of the USDC universe in
 * miniature, and the whole of a BNB-style universe. `vault` picks the dollar:
 * 'OmniUSD' over a 6-decimal token, or 'OmniUSDLocal' over one of `decimals`.
 */
async function universe({
  vault = 'OmniUSD',
  decimals = 6,
  dollarKind,
  dist = 'FeeDistributor',
  venue = 'InternalCurveVenue',
  label = 4,
} = {}) {
  if (vault === 'OmniUSD') decimals = 6
  const T = (n) => ethers.parseUnits(String(n), decimals)
  const endpoint = await ethers.deployContract('MockLZEndpointV2', [E('0.001')])
  const messenger = await ethers.deployContract('LayerZeroOmniMessenger', [endpoint.target, 30_000 + label])
  const hubUsd = await ethers.deployContract('OmniUSD', [0, ethers.ZeroAddress, ethers.ZeroAddress])
  const pad = await ethers.deployContract('SpawnPad', [messenger.target, hubUsd.target])
  const curve = await ethers.deployContract(venue, [pad.target])
  await (await pad.setVenue(curve.target)).wait()
  await (await hubUsd.setAgent(pad.target)).wait()
  await (await messenger.register(pad.target, 0)).wait()
  await (await messenger.setSponsored(pad.target, true)).wait()
  await (await messenger.setLocal(0, true)).wait()
  await (await messenger.setLocal(label, true)).wait()
  await (await messenger.setDestination(0, 0, 0)).wait()

  let dollar
  if (dollarKind === 'ReentrantDollar') dollar = await ethers.deployContract('ReentrantDollar', [decimals])
  else if (dollarKind === 'MockDollar' || vault === 'OmniUSDLocal') {
    dollar = await ethers.deployContract('MockDollar', ['Tether USD', 'USDT', decimals])
  } else dollar = await ethers.deployContract('MockUSDC')
  const cctp = vault === 'OmniUSD' ? await ethers.deployContract('MockTokenMessenger') : null
  const usd =
    vault === 'OmniUSD'
      ? await ethers.deployContract('OmniUSD', [label, dollar.target, cctp.target])
      : await ethers.deployContract('OmniUSDLocal', [label, dollar.target])
  const gateway = await ethers.deployContract('SpawnGateway', [messenger.target, usd.target, label, pad.target])
  await (await usd.setAgent(gateway.target)).wait()
  await (await usd.setDepositCap(T(1_000_000_000))).wait()
  await (await messenger.register(gateway.target, label)).wait()

  const u = { endpoint, messenger, hubUsd, pad, curve, dollar, cctp, usd, gateway, label, T, decimals }
  u.SCALE = await usd.SCALE()
  /** The holder pool — wired now, or later by a test that starts without one. */
  u.wirePool = async (name = 'FeeDistributor') => {
    const d = await ethers.deployContract(name, name === 'FeeDistributor' ? [usd.target] : [])
    if (name === 'FeeDistributor') {
      await (await d.setAgent(gateway.target)).wait()
      await (await d.sealExclusions()).wait()
    }
    await (await gateway.setDistributor(d.target)).wait()
    u.dist = d
    return d
  }
  if (dist) await u.wirePool(dist)
  await (await pad.setGateway(label, b32(gateway.target))).wait()
  await (await pad.setAutoDrop(label, true)).wait()
  await (await gateway.setLegs(0, 0)).wait()

  u.fund = async (who, dollars) => {
    await (await dollar.mint(who.address, T(dollars))).wait()
    await (await dollar.connect(who).approve(usd.target, ethers.MaxUint256)).wait()
  }
  /** Leaves `who` holding `dollars` of oUSD, backed: the vault's agent (the
   * gateway) takes the dollars in and hands their value back as a claim.
   * (v7.2: `OmniUSDLocal` has no `wrap`; this works on both vaults.) */
  u.claim = async (who, dollars) => {
    const agent = await as(gateway.target)
    await (await usd.connect(agent).depositFor(who.address, T(dollars))).wait()
    await (await usd.connect(agent).bridgeMint(who.address, T(dollars) * u.SCALE)).wait()
  }
  u.lastToken = async () => pad.allTokens((await pad.tokensLength()) - 1n)
  u.spawn = async (dev, { devBuy = 0, mode = 0, name = 'GLOOP', symbol = 'GLP' } = {}) => {
    await (await gateway.connect(dev).spawnTokenUsdc(name, symbol, '{}', T(devBuy), mode)).wait()
    return u.lastToken()
  }
  u.replica = async (token) => ethers.getContractAt('SpawnToken', await gateway.replicaOf(token))
  /** Everything `who` holds in dollars, in oUSD wei: tokens + claims. */
  u.worth = async (who) => (await dollar.balanceOf(who.address)) * u.SCALE + (await usd.balanceOf(who.address))
  /** What a trade must leave untouched when it reverts. */
  u.state = async (who, token) => ({
    worth: await u.worth(who),
    bag: (await gateway.replicaOf(token)) === ethers.ZeroAddress ? 0n : await (await u.replica(token)).balanceOf(who.address),
    vault: await dollar.balanceOf(usd.target),
    hubBooks: await hubUsd.totalSupply(),
    vBase: (await pad.curves(token)).vBase,
    spent: await pad.genesisSpent(token, b32(who.address)),
  })
  /** The invariants every step must leave true. `parked`: tokens delivered
   * to this chain that wait in the gateway instead of being minted. */
  u.check = async (tokens = [], parked = 0n) => {
    expect((await usd.totalSupply()) + (await hubUsd.totalSupply()), 'backing').to.equal(
      (await dollar.balanceOf(usd.target)) * u.SCALE,
    )
    expect(await endpoint.packetsSent(), 'LayerZero packets').to.equal(0n)
    for (const t of tokens) {
      const hub = await ethers.getContractAt('SpawnToken', t)
      const rep = await gateway.replicaOf(t)
      const circulating = rep === ethers.ZeroAddress ? 0n : await (await u.replica(t)).totalSupply()
      const burned = (await pad.feesOf(t)).burnedTokens
      expect((await hub.totalSupply()) + circulating + parked, 'token supply').to.equal(BILLION - burned)
    }
  }
  return u
}

/** What `who` would get for a plain buy of `units` dollar-token units. */
const buyOut = (u, who, token, units) =>
  peek(async () => {
    const rep = await u.replica(token)
    const before = await rep.balanceOf(who.address)
    await (await u.gateway.connect(who).buyTokenUsdc(token, units)).wait()
    return (await rep.balanceOf(who.address)) - before
  })
/** What `who` would receive, in 18-decimal dollars, for a plain sell. */
const sellOut = (u, who, token, tokens) =>
  peek(async () => {
    const before = await u.worth(who)
    await (await u.gateway.connect(who).sellToken(token, tokens)).wait()
    return (await u.worth(who)) - before
  })

describe('Protocol v7.1', () => {
  let admin, user, user2, stranger, dev

  beforeEach(async () => {
    ;[admin, user, user2, stranger, dev] = await ethers.getSigners()
  })

  /* ====================================================================== */
  /*  F-11 — an unset peer is never a match                                  */
  /* ====================================================================== */

  describe('F-11 — an unset peer is never a match', () => {
    const OP_EID = 30111
    const HUB_EID = 30184
    const FOREIGN_EID = 30101 // a chain this spoke was never told about
    const PAD = ethers.getAddress('0x' + '11'.repeat(20)) // the hub's pad, on another chain
    const HUB_ADAPTER = ethers.getAddress('0x' + '22'.repeat(20))

    /** A spoke exactly as on mainnet: one adapter with ONE route (to the
     * hub), a USDC vault with an honest user's 1,000 dollars in it, a
     * gateway that believes (chain 0, PAD). `adapterName` picks the adapter:
     * the v7.1 one, or the frozen copy of what ran the v7.0 deployment. */
    async function spoke(adapterName) {
      const endpoint = await ethers.deployContract('MockLZEndpointV2', [E('0.001')])
      const adapter = await ethers.deployContract(adapterName, [endpoint.target, OP_EID])
      await (await endpoint.registerAdapter(adapter.target, OP_EID)).wait()
      const usdc = await ethers.deployContract('MockUSDC')
      const cctp = await ethers.deployContract('MockTokenMessenger')
      const usd = await ethers.deployContract('OmniUSD', [6, usdc.target, cctp.target])
      await (await usd.setDepositCap(U(1_000_000))).wait()
      const gateway = await ethers.deployContract('SpawnGateway', [adapter.target, usd.target, 6, PAD])
      await (await usd.setAgent(gateway.target)).wait()
      await (await adapter.register(gateway.target, 6)).wait()
      await (await adapter.setRoute(0, HUB_EID, b32(HUB_ADAPTER))).wait()
      await (await adapter.setDestination(0, 4_600_000, E('0.0002'))).wait()
      await (await usdc.mint(user.address, U(1_000))).wait()
      await (await usdc.connect(user).approve(usd.target, ethers.MaxUint256)).wait()
      await (await usd.connect(user).wrap(U(1_000))).wait()
      const make = adapterName === 'LayerZeroOmniMessengerV70' ? envelopeV70 : envelope
      const forged = make(b32(PAD), gateway.target, payout(stranger.address, E(1_000)))
      return { endpoint, adapter, usdc, usd, gateway, forged }
    }

    it('BEFORE (frozen v7.0 adapter): a zero-sender packet from a chain it was never told about is taken for the hub — and empties the vault', async () => {
      const s = await spoke('LayerZeroOmniMessengerV70')
      // the two defaults that line up: no peer is bytes32(0), no label is 0 — the hub's
      expect(await s.adapter.peers(FOREIGN_EID)).to.equal(ethers.ZeroHash)
      expect(await s.adapter.labelOf(FOREIGN_EID)).to.equal(0n)
      expect(await s.adapter.allowInitializePath({ srcEid: FOREIGN_EID, sender: ethers.ZeroHash, nonce: 1 })).to.equal(true)

      // the endpoint is handed a "verified" packet from (FOREIGN_EID, 0x00…00)
      await (await s.endpoint.inject(FOREIGN_EID, ethers.ZeroHash, s.adapter.target, s.forged)).wait()

      expect(await s.usdc.balanceOf(stranger.address)).to.equal(U(1_000))
      expect(await s.usdc.balanceOf(s.usd.target)).to.equal(0n)
      // the honest user's claim is still on the books, backed by nothing
      expect(await s.usd.balanceOf(user.address)).to.equal(E(1_000))
    })

    it('AFTER (v7.1): the same packet is refused at both doors, from any chain that has no peer', async () => {
      const s = await spoke('LayerZeroOmniMessenger')
      const ep = await as(s.endpoint.target)
      for (const srcEid of [FOREIGN_EID, 30102, 30168, OP_EID, 0]) {
        const origin = { srcEid, sender: ethers.ZeroHash, nonce: 1 }
        expect(await s.adapter.peers(srcEid)).to.equal(ethers.ZeroHash)
        // door 1: the endpoint may not even open the path
        expect(await s.adapter.allowInitializePath(origin), `eid ${srcEid}`).to.equal(false)
        await expect(s.endpoint.inject(srcEid, ethers.ZeroHash, s.adapter.target, s.forged)).to.be.revertedWith(
          'ENDPOINT: path not initializable',
        )
        // door 2: and if a packet were delivered anyway, lzReceive refuses it
        await expect(
          s.adapter.connect(ep).lzReceive(origin, ethers.ZeroHash, s.forged, stranger.address, '0x'),
        ).to.be.revertedWith('LZM: not a peer')
      }
      expect(await s.usdc.balanceOf(stranger.address)).to.equal(0n)
      expect(await s.usdc.balanceOf(s.usd.target)).to.equal(U(1_000))
    })

    it('a SET peer is still believed — and only it: a stranger, or nobody, speaking for the hub\'s chain is refused', async () => {
      const s = await spoke('LayerZeroOmniMessenger')
      const hub = { srcEid: HUB_EID, nonce: 1 }
      expect(await s.adapter.allowInitializePath({ ...hub, sender: b32(HUB_ADAPTER) })).to.equal(true)
      expect(await s.adapter.allowInitializePath({ ...hub, sender: b32(stranger.address) })).to.equal(false)
      expect(await s.adapter.allowInitializePath({ ...hub, sender: ethers.ZeroHash })).to.equal(false)
      await expect(s.endpoint.inject(HUB_EID, b32(stranger.address), s.adapter.target, s.forged)).to.be.revertedWith(
        'ENDPOINT: path not initializable',
      )

      // the real hub adapter's word still pays (here: an honest PAYOUT)
      const honest = envelope(b32(PAD), s.gateway.target, payout(user2.address, E(40)))
      await (await s.endpoint.inject(HUB_EID, b32(HUB_ADAPTER), s.adapter.target, honest)).wait()
      expect(await s.usdc.balanceOf(user2.address)).to.equal(U(40))

      // …but even the hub adapter must name who is speaking
      const nobody = envelope(ethers.ZeroHash, s.gateway.target, payout(stranger.address, E(40)))
      await expect(s.endpoint.inject(HUB_EID, b32(HUB_ADAPTER), s.adapter.target, nobody)).to.be.revertedWith('LZM: no sender')
      expect(await s.usdc.balanceOf(stranger.address)).to.equal(0n)
    })

    it('a route moved to another eid leaves the old eid with no peer — which matches nothing', async () => {
      const s = await spoke('LayerZeroOmniMessenger')
      const NEW_EID = 30999
      await (await s.adapter.repointRoute(0, NEW_EID, b32(HUB_ADAPTER))).wait()
      expect(await s.adapter.peers(HUB_EID)).to.equal(ethers.ZeroHash)
      for (const sender of [ethers.ZeroHash, b32(HUB_ADAPTER)]) {
        expect(await s.adapter.allowInitializePath({ srcEid: HUB_EID, sender, nonce: 1 })).to.equal(false)
        await expect(s.endpoint.inject(HUB_EID, sender, s.adapter.target, s.forged)).to.be.revertedWith(
          'ENDPOINT: path not initializable',
        )
      }
      expect(await s.adapter.allowInitializePath({ srcEid: NEW_EID, sender: b32(HUB_ADAPTER), nonce: 1 })).to.equal(true)
      expect(await s.usdc.balanceOf(s.usd.target)).to.equal(U(1_000))
    })

    it('the hub side: nobody speaks for chain 0 — not through the adapter, not to the pad itself', async () => {
      const w = await deployWorldAsync()
      const base = w.chains[2]
      await fundUsdc(base, user, 500)
      await (await base.gateway.connect(user).spawnTokenUsdc('GLOOP', 'GLP', '{}', 0, 0)).wait()
      await w.deliverAll()
      const token = await w.pad.allTokens(0)
      const books = await w.hubUsd.totalSupply()

      // a BUY "from chain 0, sender 0": the pair that no gateway can ever be
      const forgedBuy = buy(b32(token), b32(stranger.address), E(1_000_000))
      const message = envelope(ethers.ZeroHash, w.pad.target, forgedBuy)
      expect(await w.hubMessenger.allowInitializePath({ srcEid: 30101 + 5000, sender: ethers.ZeroHash, nonce: 1 })).to.equal(false)
      await expect(w.endpoint.inject(35_101, ethers.ZeroHash, w.hubMessenger.target, message)).to.be.revertedWith(
        'ENDPOINT: path not initializable',
      )

      // and the pad's own check no longer rests on the reply failing later:
      // (chain 0, sender 0) and (any unwired chain, sender 0) are refused outright
      const messenger = await as(w.hubMessenger.target)
      expect(await w.pad.gateways(0)).to.equal(ethers.ZeroHash)
      for (const chain of [0, 7, 99]) {
        await expect(w.pad.connect(messenger).onOmniMessage(chain, ethers.ZeroHash, forgedBuy)).to.be.revertedWith(
          'PAD: not a gateway',
        )
      }
      // a wired chain still needs ITS gateway
      await expect(
        w.pad.connect(messenger).onOmniMessage(6, b32(stranger.address), forgedBuy),
      ).to.be.revertedWith('PAD: not a gateway')
      expect(await w.hubUsd.totalSupply()).to.equal(books)
    })

    it('the rest of the class: no contract can be built or wired so that "nobody" is somebody', async () => {
      const u = await universe()
      const G = await ethers.getContractFactory('SpawnGateway')
      await expect(G.deploy(u.messenger.target, u.usd.target, 5, ethers.ZeroAddress)).to.be.revertedWith('GW: zero address')
      await expect(G.deploy(ethers.ZeroAddress, u.usd.target, 5, u.pad.target)).to.be.revertedWith('GW: zero address')
      // label 0 is the hub: a gateway carrying it could never be told apart
      await expect(G.deploy(u.messenger.target, u.usd.target, 0, u.pad.target)).to.be.revertedWith('GW: hub label')
      await expect(u.pad.setGateway(0, b32(stranger.address))).to.be.revertedWith('PAD: hub label')
      await expect(u.pad.setGateway(9, ethers.ZeroHash)).to.be.revertedWith('PAD: gateway set')
      // the adapter admits no zero sender, and an unregistered caller has no label to borrow
      await expect(u.messenger.register(ethers.ZeroAddress, 0)).to.be.revertedWith('LZM: zero sender')
      expect(await u.messenger.labelOfSender(stranger.address)).to.equal(0n) // the hub's label, by default…
      await expect(u.messenger.connect(stranger).send(u.label, b32(u.gateway.target), '0x', 0)).to.be.revertedWith(
        'LZM: unknown sender', // …which is why `senders` is checked first
      )
      // a loopback target must be a REGISTERED contract of that very label
      const padSigner = await as(u.pad.target)
      await expect(u.messenger.connect(padSigner).send(u.label, b32(stranger.address), '0x', 0)).to.be.revertedWith('LZM: bad target')
      await expect(u.messenger.connect(padSigner).send(0, ethers.ZeroHash, '0x', 0)).to.be.revertedWith('LZM: bad target')
      // an eid that was never routed cannot be sent to either
      await expect(u.messenger.connect(padSigner).send(6, b32(stranger.address), '0x', 0)).to.be.revertedWith('LZM: no route')
    })
  })

  /* ====================================================================== */
  /*  A deposit that credits nothing rides no message                        */
  /* ====================================================================== */

  describe('MIN_DEPOSIT on both vaults', () => {
    it('OmniUSD refuses a deposit that credited nothing instead of sending the hub a zero-dollar buy', async () => {
      const u = await universe({ dollarKind: 'MockDollar' })
      expect(await u.usd.MIN_DEPOSIT()).to.equal(10n ** 12n)
      const token = await u.spawn(dev)
      await pastGenesis()
      await u.fund(user, 100)
      // one real unit is exactly the floor: it passes
      await (await u.gateway.connect(user).buyTokenUsdc(token, 1n)).wait()
      // a dollar that takes everything on the way in credits nothing
      await (await u.dollar.setFeeBps(10_000)).wait()
      const before = await u.state(user, token)
      await expect(u.gateway.connect(user).buyTokenUsdc(token, u.T(10))).to.be.revertedWith('oUSD: dust')
      await expect(u.gateway.connect(user).spawnTokenUsdc('X', 'X', '{}', u.T(10), 0)).to.be.revertedWith('oUSD: dust')
      expect(await u.state(user, token)).to.deep.equal(before)
      await u.check([token])
    })
  })

  /* ====================================================================== */
  /*  Slippage protection where the hub answers in the same transaction      */
  /* ====================================================================== */

  for (const cfg of [
    { name: 'USDC universe — OmniUSD, 6 decimals', opts: {} },
    { name: 'BNB-style universe — OmniUSDLocal, 18 decimals', opts: { vault: 'OmniUSDLocal', decimals: 18 } },
  ]) {
    describe(`*Min: all-or-nothing trades on the synchronous path (${cfg.name})`, () => {
      let u, token

      beforeEach(async () => {
        u = await universe(cfg.opts)
        token = await u.spawn(dev)
        await pastGenesis()
        await u.fund(user, 5_000)
        await u.fund(user2, 5_000)
      })

      it('a buy fills at the minimum it names, to the wei — and one wei more undoes everything', async () => {
        const out = await buyOut(u, user, token, u.T(100))
        expect(out).to.be.gt(0n)
        const before = await u.state(user, token)

        await expect(u.gateway.connect(user).buyTokenUsdcMin(token, u.T(100), out + 1n)).to.be.revertedWith('GW: min out')
        expect(await u.state(user, token)).to.deep.equal(before)

        await (await u.gateway.connect(user).buyTokenUsdcMin(token, u.T(100), out)).wait()
        const after = await u.state(user, token)
        expect(after.bag - before.bag).to.equal(out)
        expect(before.worth - after.worth).to.equal(E(100))
        await u.check([token])
      })

      it('the oUSD-denominated buy has the same guarantee', async () => {
        await u.claim(user, 300)
        const out = await peek(async () => {
          const rep = await u.replica(token)
          await (await u.gateway.connect(user).buyToken(token, E(120))).wait()
          return rep.balanceOf(user.address)
        })
        const before = await u.state(user, token)
        await expect(u.gateway.connect(user).buyTokenMin(token, E(120), out + 1n)).to.be.revertedWith('GW: min out')
        expect(await u.state(user, token)).to.deep.equal(before)
        expect(await u.usd.balanceOf(user.address)).to.equal(E(300))
        await (await u.gateway.connect(user).buyTokenMin(token, E(120), out)).wait()
        expect(await (await u.replica(token)).balanceOf(user.address)).to.equal(out)
        expect(await u.usd.balanceOf(user.address)).to.equal(E(180))
        await u.check([token])
      })

      it('a sell pays at least the dollars it names — or the bag is not sold', async () => {
        await (await u.gateway.connect(user).buyTokenUsdc(token, u.T(400))).wait()
        const rep = await u.replica(token)
        const half = (await rep.balanceOf(user.address)) / 2n
        const dollars = await sellOut(u, user, token, half)
        expect(dollars).to.be.gt(0n)
        const before = await u.state(user, token)

        await expect(u.gateway.connect(user).sellTokenMin(token, half, dollars + 1n)).to.be.revertedWith('GW: min out')
        expect(await u.state(user, token)).to.deep.equal(before)

        await (await u.gateway.connect(user).sellTokenMin(token, half, dollars)).wait()
        const after = await u.state(user, token)
        expect(before.bag - after.bag).to.equal(half)
        expect(after.worth - before.worth).to.equal(dollars)
        await u.check([token])
      })

      it('a sandwich is refused: the front-run moves the price, the protected buy reverts, the victim keeps every dollar', async () => {
        // what the victim was quoted, with a 1% tolerance
        const quoted = await buyOut(u, user, token, u.T(300))
        const min = (quoted * 99n) / 100n

        // unprotected, this is what the attack takes
        const { filled, profit } = await peek(async () => {
          const attackerBefore = await u.worth(user2)
          await (await u.gateway.connect(user2).buyTokenUsdc(token, u.T(2_000))).wait()
          const rep = await u.replica(token)
          await (await u.gateway.connect(user).buyTokenUsdc(token, u.T(300))).wait()
          const filled = await rep.balanceOf(user.address)
          await (await u.gateway.connect(user2).sellToken(token, await rep.balanceOf(user2.address))).wait()
          return { filled, profit: (await u.worth(user2)) - attackerBefore }
        })
        expect(filled).to.be.lt(min) // the victim got far fewer tokens than quoted…
        expect(profit).to.be.gt(0n) // …and the attacker kept the difference, fees paid

        // protected: the front-run lands first, the victim's buy simply does not happen
        await (await u.gateway.connect(user2).buyTokenUsdc(token, u.T(2_000))).wait()
        const before = await u.state(user, token)
        await expect(u.gateway.connect(user).buyTokenUsdcMin(token, u.T(300), min)).to.be.revertedWith('GW: min out')
        expect(await u.state(user, token)).to.deep.equal(before)
        expect(before.bag).to.equal(0n)
        await u.check([token])
      })

      it('a minimum of zero is not a minimum; an unknown token is refused before any money moves', async () => {
        await expect(u.gateway.connect(user).buyTokenUsdcMin(token, u.T(10), 0)).to.be.revertedWith('GW: zero min')
        await expect(u.gateway.connect(user).buyTokenMin(token, E(10), 0)).to.be.revertedWith('GW: zero min')
        await expect(u.gateway.connect(user).sellTokenMin(token, E(10), 0)).to.be.revertedWith('GW: zero min')
        await expect(u.gateway.connect(user).buyTokenUsdcMin(stranger.address, u.T(10), 1)).to.be.revertedWith('GW: unknown token')
        await expect(u.gateway.connect(user).buyTokenMin(stranger.address, E(10), 1)).to.be.revertedWith('GW: unknown token')
        await expect(u.gateway.connect(user).sellTokenMin(stranger.address, E(10), 1)).to.be.revertedWith('GW: no replica')
        await expect(u.gateway.connect(user).buyTokenUsdcMin(token, 0, 1)).to.be.revertedWith('GW: zero')
        await expect(u.gateway.connect(user).buyTokenMin(token, 10n ** 11n, 1)).to.be.revertedWith('GW: dust')
        expect(await u.dollar.balanceOf(user.address)).to.equal(u.T(5_000))
      })

      it('a dev buy paid in oUSD has the same dust floor as a buy (and zero still means "no dev buy")', async () => {
        await u.claim(user, 50)
        const held = await u.usd.balanceOf(user.address)
        expect(held).to.equal(E(50))
        const count = await u.pad.tokensLength()
        for (const dust of [1n, 10n ** 11n, 10n ** 12n - 1n])
          await expect(u.gateway.connect(user).spawnToken('DUSTY', 'DST', '{}', dust, 0)).to.be.revertedWith('GW: dust')
        expect(await u.usd.balanceOf(user.address)).to.equal(held)
        expect(await u.pad.tokensLength()).to.equal(count)
        // zero is still "no dev buy"; the floor itself is accepted and spent
        await (await u.gateway.connect(user).spawnToken('NO DEV', 'NDV', '{}', 0, 0)).wait()
        await (await u.gateway.connect(user).spawnToken('FLOOR', 'FLR', '{}', 10n ** 12n, 0)).wait()
        expect(await u.pad.tokensLength()).to.equal(count + 2n)
        expect(await u.usd.balanceOf(user.address)).to.equal(held - 10n ** 12n)
        await u.check([token, await u.pad.allTokens(count), await u.pad.allTokens(count + 1n)])
      })

      it('a pause stops protected buys like any buy — and never a protected sell', async () => {
        await (await u.gateway.connect(user).buyTokenUsdc(token, u.T(200))).wait()
        const bag = await (await u.replica(token)).balanceOf(user.address)
        await (await u.gateway.pause()).wait()
        await expect(u.gateway.connect(user).buyTokenUsdcMin(token, u.T(10), 1)).to.be.revertedWith('GW: paused')
        await expect(u.gateway.connect(user).buyTokenMin(token, E(10), 1)).to.be.revertedWith('GW: paused')
        const dollars = await sellOut(u, user, token, bag)
        await (await u.gateway.connect(user).sellTokenMin(token, bag, dollars)).wait()
        expect(await (await u.replica(token)).balanceOf(user.address)).to.equal(0n)
        await u.check([token])
      })

      it('a paused hub bounces a plain buy with a full refund — a protected one just does not happen', async () => {
        await (await u.pad.pause()).wait()
        const before = await u.state(user, token)
        // plain: the dollars go to the hub and come straight back
        await (await u.gateway.connect(user).buyTokenUsdc(token, u.T(100))).wait()
        expect(await u.state(user, token)).to.deep.equal(before)
        await expect(u.gateway.connect(user).buyTokenUsdcMin(token, u.T(100), 1)).to.be.revertedWith('GW: min out')
        expect(await u.state(user, token)).to.deep.equal(before)
        await u.check([token])
      })

      it('a sell the venue refuses comes back as tokens, which is not dollars: the protected sell reverts', async () => {
        const f = await universe({ ...cfg.opts, venue: 'FlakyVenue' })
        const t = await f.spawn(dev)
        await pastGenesis()
        await f.fund(user, 500)
        await (await f.gateway.connect(user).buyTokenUsdc(t, f.T(100))).wait()
        const bag = await (await f.replica(t)).balanceOf(user.address)
        await (await f.curve.setRefuse(true)).wait() // any venue may say no (a paused pool, its own guard)
        const before = await f.state(user, t)
        // unprotected: the hub refuses the sale and re-delivers the bag — the seller is whole
        await (await f.gateway.connect(user).sellToken(t, bag)).wait()
        expect(await f.state(user, t)).to.deep.equal(before)
        // protected: tokens back are not dollars — it reverts, with the same outcome
        await expect(f.gateway.connect(user).sellTokenMin(t, bag, 1)).to.be.revertedWith('GW: min out')
        expect(await f.state(user, t)).to.deep.equal(before)
        // and the smallest sale the gateway admits (1e12 token wei) is worth less than a
        // dollar unit: a protected sell cannot be talked into it for a real minimum
        await (await f.curve.setRefuse(false)).wait()
        await expect(f.gateway.connect(user).sellTokenMin(t, 10n ** 12n, E('0.000001'))).to.be.revertedWith('GW: min out')
        expect(await f.state(user, t)).to.deep.equal(before)
        await f.check([t])
      })

      it('fee side effects ride the same transaction: a holders drop and a buyback both land, the minimum still holds', async () => {
        // holders mode: $300 of volume is $3 of fees — over the $2 trigger, dropped locally at once
        const out = await buyOut(u, user, token, u.T(300))
        await (await u.gateway.connect(user).buyTokenUsdcMin(token, u.T(300), out)).wait()
        expect(await u.usd.balanceOf(u.dist.target)).to.be.gt(E(2))
        expect((await u.pad.feesOf(token)).holdersPaid).to.be.gt(E(2))

        // burn mode: $500 is $5 of fees — the $4 buyback fires inside the buy
        const burner = await u.spawn(dev, { mode: 3, name: 'ASH', symbol: 'ASH' })
        await pastGenesis()
        const out2 = await buyOut(u, user, burner, u.T(500))
        await (await u.gateway.connect(user).buyTokenUsdcMin(burner, u.T(500), out2)).wait()
        expect((await u.pad.feesOf(burner)).burnedTokens).to.be.gt(0n)
        expect(await (await u.replica(burner)).balanceOf(user.address)).to.equal(out2)
        await u.check([token, burner])
      })

      it('FAIR GENESIS: a fill cut to the $250 cap is under the minimum — the whole buy unwinds, the cap is not consumed', async () => {
        const fresh = await u.spawn(dev, { name: 'NEW', symbol: 'NEW' })
        const t0 = Number((await u.pad.metas(fresh)).spawnedAt)
        // what $300 gets 100 seconds in: $250 on the curve, $50 back
        const clamped = await peek(async () => {
          await time.setNextBlockTimestamp(t0 + 100)
          const rep = await u.replica(fresh)
          await (await u.gateway.connect(user).buyTokenUsdc(fresh, u.T(300))).wait()
          return rep.balanceOf(user.address)
        })
        const before = await u.state(user, fresh)

        await time.setNextBlockTimestamp(t0 + 100)
        await expect(u.gateway.connect(user).buyTokenUsdcMin(fresh, u.T(300), clamped + 1n)).to.be.revertedWith('GW: min out')
        expect(await u.state(user, fresh)).to.deep.equal(before)
        expect(before.spent).to.equal(0n)

        // a minimum the capped fill meets goes through, and the $50 comes back in the same transaction
        await (await u.gateway.connect(user).buyTokenUsdcMin(fresh, u.T(300), clamped)).wait()
        const after = await u.state(user, fresh)
        expect(after.bag).to.be.gte(clamped)
        expect(before.worth - after.worth).to.equal(E(250))
        expect(after.spent).to.equal(E(250))
        await u.check([token, fresh])
      })

      it('block 0: in the launch block a plain buy bounces whole, a protected buy reverts — neither gets a token', async () => {
        const predicted = ethers.getCreateAddress({ from: u.pad.target, nonce: await ethers.provider.getTransactionCount(u.pad.target) })
        const before = { user: await u.worth(user), user2: await u.worth(user2) }
        await network.provider.send('evm_setAutomine', [false])
        let launch, guarded, plain
        try {
          launch = await u.gateway.connect(dev).spawnTokenUsdc('ZERO', 'ZERO', '{}', 0, 0, { gasLimit: 6_000_000 })
          guarded = await u.gateway.connect(user).buyTokenUsdcMin(predicted, u.T(50), 1, { gasLimit: 3_000_000 })
          plain = await u.gateway.connect(user2).buyTokenUsdc(predicted, u.T(50), { gasLimit: 3_000_000 })
          await network.provider.send('evm_mine')
        } finally {
          await network.provider.send('evm_setAutomine', [true])
        }
        const receipt = (tx) => ethers.provider.getTransactionReceipt(tx.hash)
        const [r0, r1, r2] = await Promise.all([receipt(launch), receipt(guarded), receipt(plain)])
        expect(r0.blockNumber).to.equal(r1.blockNumber).and.to.equal(r2.blockNumber)
        expect(r0.status).to.equal(1)
        expect(r1.status, 'the protected buy').to.equal(0)
        expect(r2.status, 'the plain buy').to.equal(1)
        expect(await u.lastToken()).to.equal(predicted)
        const rep = await u.replica(predicted)
        expect(await rep.totalSupply()).to.equal(0n)
        expect(await u.worth(user)).to.equal(before.user)
        expect(await u.worth(user2)).to.equal(before.user2)
        await u.check([token, predicted])
      })
    })
  }

  describe('*Min: payouts that come as claims, deliveries that park, and tokens with hooks', () => {
    it('a sell paid in an oUSD claim (the vault is short) counts for what it is worth', async () => {
      const u = await universe()
      const token = await u.spawn(dev)
      await pastGenesis()
      await u.fund(user, 1_000)
      await (await u.gateway.connect(user).buyTokenUsdc(token, u.T(500))).wait()
      const bag = await (await u.replica(token)).balanceOf(user.address)
      const dollars = await sellOut(u, user, token, bag)
      // the operator moves the vault's whole liquidity to a peer vault (CCTP)
      await (await u.usd.setPeer(9, 0, b32(stranger.address))).wait()
      await (await u.usd.rebalance(9, await u.dollar.balanceOf(u.usd.target))).wait()
      expect(await u.dollar.balanceOf(u.usd.target)).to.equal(0n)

      const usdcBefore = await u.dollar.balanceOf(user.address)
      await expect(u.gateway.connect(user).sellTokenMin(token, bag, dollars + 1n)).to.be.revertedWith('GW: min out')
      await (await u.gateway.connect(user).sellTokenMin(token, bag, dollars)).wait()
      expect(await u.dollar.balanceOf(user.address)).to.equal(usdcBefore) // not a single USDC moved…
      expect(await u.usd.balanceOf(user.address)).to.equal(dollars) // …the seller holds the claim
    })

    it('a seller the issuer froze is paid in a claim on the 18-decimal vault too', async () => {
      const u = await universe({ vault: 'OmniUSDLocal', decimals: 18 })
      const token = await u.spawn(dev)
      await pastGenesis()
      await u.fund(user, 1_000)
      await (await u.gateway.connect(user).buyTokenUsdc(token, u.T(500))).wait()
      const bag = await (await u.replica(token)).balanceOf(user.address)
      const dollars = await sellOut(u, user, token, bag)
      await (await u.dollar.setFrozen(user.address, true)).wait()
      await (await u.gateway.connect(user).sellTokenMin(token, bag, dollars)).wait()
      expect(await u.usd.balanceOf(user.address)).to.equal(dollars)
      await u.check([token])
    })

    it('a delivery that had to be parked is not a balance: the protected buy reverts instead of leaving tokens in limbo', async () => {
      const u = await universe({ dist: 'BrickableDistributor' })
      const token = await u.spawn(dev)
      await pastGenesis()
      await u.fund(user, 1_000)
      await u.fund(user2, 1_000)
      await (await u.dist.setBricked(true)).wait() // every mint of this replica now fails

      // plain: the hub sold the tokens, the gateway could only park them
      await (await u.gateway.connect(user2).buyTokenUsdc(token, u.T(100))).wait()
      const parked = await u.gateway.pendingDelivery(token, user2.address)
      expect(parked).to.be.gt(0n)
      expect(await (await u.replica(token)).balanceOf(user2.address)).to.equal(0n)

      // protected: nothing at all happens
      const before = await u.state(user, token)
      await expect(u.gateway.connect(user).buyTokenUsdcMin(token, u.T(100), 1)).to.be.revertedWith('GW: min out')
      expect(await u.state(user, token)).to.deep.equal(before)
      expect(await u.gateway.pendingDelivery(token, user.address)).to.equal(0n)
      await u.check([token], parked)
    })

    it('a dollar token with a transfer hook cannot get back into the gateway — in the deposit or in the payout', async () => {
      const u = await universe({ dollarKind: 'ReentrantDollar' })
      const token = await u.spawn(dev)
      await pastGenesis()
      await u.fund(user, 2_000)
      const gw = u.gateway.interface
      const forgedPayout = payout(stranger.address, E(1_000))
      const attempts = [
        ['buyTokenUsdcMin', u.gateway.target, gw.encodeFunctionData('buyTokenUsdcMin', [token, u.T(1), 1]), REENTRANT],
        ['buyTokenUsdc', u.gateway.target, gw.encodeFunctionData('buyTokenUsdc', [token, u.T(1)]), REENTRANT],
        ['sellTokenMin', u.gateway.target, gw.encodeFunctionData('sellTokenMin', [token, E(1), 1]), REENTRANT],
        ['claimPending', u.gateway.target, gw.encodeFunctionData('claimPending', [token]), REENTRANT],
        ['flushFeeDrop', u.gateway.target, gw.encodeFunctionData('flushFeeDrop', [token]), REENTRANT],
        ['onOmniMessage', u.gateway.target, gw.encodeFunctionData('onOmniMessage', [0, b32(u.pad.target), forgedPayout]), null],
        ['vault.wrap', u.usd.target, u.usd.interface.encodeFunctionData('wrap', [u.T(1)]), REENTRANT],
      ]
      for (const [name, target, data, reason] of attempts) {
        // 1. during the DEPOSIT of a protected buy (the first transfer: user -> vault)
        const out = await buyOut(u, user, token, u.T(100))
        await (await u.dollar.arm(target, data, 0)).wait()
        const bag = await (await u.replica(token)).balanceOf(user.address)
        await (await u.gateway.connect(user).buyTokenUsdcMin(token, u.T(100), out)).wait()
        expect(await u.dollar.fired(), `${name} in the deposit`).to.equal(true)
        expect(await u.dollar.ok(), `${name} in the deposit`).to.equal(false)
        if (reason) expect((await u.dollar.ret()).slice(0, 10)).to.equal(reason)
        expect((await (await u.replica(token)).balanceOf(user.address)) - bag).to.equal(out)

        // 2. during the PAYOUT of a protected sell (the first transfer: vault -> seller)
        const dollars = await sellOut(u, user, token, out)
        await (await u.dollar.arm(target, data, 0)).wait()
        await (await u.gateway.connect(user).sellTokenMin(token, out, dollars)).wait()
        expect(await u.dollar.fired(), `${name} in the payout`).to.equal(true)
        expect(await u.dollar.ok(), `${name} in the payout`).to.equal(false)
      }
      // the forged message was refused for what it is
      expect(await u.dollar.balanceOf(stranger.address)).to.equal(0n)
      await u.check([token])
    })
  })

  // v7.1 could only protect a trade where the hub answers in the same transaction: on a remote
  // chain these three calls always reverted. Since v7.2 the minimum rides the wire and the hub
  // enforces it (test/v72-wire.test.js has the whole story); what is pinned here is the change
  // of behaviour itself, on the six-label world this file has always used.
  describe('*Min on a REMOTE chain (v7.2): the call goes through, and the HUB fills at the minimum or sends everything home', () => {
    for (const sponsored of [false, true]) {
      it(`an impossible minimum bounces whole, the exact one fills (${sponsored ? 'sponsored gateway' : 'user-paid messages'})`, async () => {
        const w = await deployWorldAsync({ sponsored })
        const opc = w.chains[5] // optimism: a remote chain
        const value = async (q) => (sponsored ? 0n : await q)
        await fundUsdc(opc, user, 2_000)
        await (
          await opc.gateway.connect(user).spawnTokenUsdc('GLOOP', 'GLP', '{}', 0, 0, {
            value: await value(opc.gateway.quoteSpawn('GLOOP', 'GLP', '{}', false)),
          })
        ).wait()
        await w.deliverAll()
        const token = await w.pad.allTokens(0)
        await pastGenesis()
        await (await opc.gateway.connect(user).buyTokenUsdc(token, U(200), { value: await value(opc.gateway.quoteBuy()) })).wait()
        await w.deliverAll()
        await fundUsd(opc, user, 300) // some oUSD too, for the oUSD-denominated buy
        const rep = await ethers.getContractAt('SpawnToken', await opc.gateway.replicaOf(token))
        const bag = await rep.balanceOf(user.address)
        expect(bag).to.be.gt(0n)

        const snapshot = async () => ({
          worth: await worth(opc, user),
          bag: await rep.balanceOf(user.address),
          books: await w.hubUsd.totalSupply(),
          vBase: (await w.pad.curves(token)).vBase,
          queued: await w.endpoint.pending(),
        })
        const before = await snapshot()
        const whole = E(1_000_000_000) // more than any trade can give
        const fee = await value(opc.gateway.quoteBuy())

        // the calls no longer revert here: the message leaves with the minimum in it…
        await (await opc.gateway.connect(user).buyTokenUsdcMin(token, U(100), whole, { value: fee })).wait()
        expect((await worth(opc, user)) - before.worth).to.equal(-E(100)) // …and the dollars with it
        // …and the hub refuses the trade whole (reason 6: the market would not fill it)
        await expect(w.endpoint.deliverNext())
          .to.emit(w.pad, 'Refused')
          .withArgs(2, 6, b32(token), b32(user.address), E(100), 6)
        await w.deliverAll()
        expect(await snapshot()).to.deep.equal(before) // every dollar is home

        await (await opc.gateway.connect(user).buyTokenMin(token, E(100), whole, { value: fee })).wait()
        await w.deliverAll()
        expect(await snapshot()).to.deep.equal(before)

        await (
          await opc.gateway.connect(user).sellTokenMin(token, bag, whole, { value: await value(opc.gateway.quoteSell()) })
        ).wait()
        expect(await rep.balanceOf(user.address)).to.equal(0n) // burned here…
        await expect(w.endpoint.deliverNext())
          .to.emit(w.pad, 'Refused')
          .withArgs(3, 6, b32(token), b32(user.address), bag, 6)
        await w.deliverAll()
        expect(await snapshot()).to.deep.equal(before) // …and delivered back

        // a minimum the curve does meet: filled, to the wei
        const out = await peek(async () => {
          await (await opc.gateway.connect(user).buyTokenUsdc(token, U(100), { value: fee })).wait()
          await w.deliverAll()
          return (await rep.balanceOf(user.address)) - bag
        })
        await (await opc.gateway.connect(user).buyTokenUsdcMin(token, U(100), out, { value: fee })).wait()
        await w.deliverAll()
        expect((await rep.balanceOf(user.address)) - bag).to.equal(out)
        // zero is still not a minimum, and nothing leaves for a token this chain does not have
        await expect(opc.gateway.connect(user).buyTokenUsdcMin(token, U(100), 0, { value: fee })).to.be.revertedWith('GW: zero min')
        await expect(opc.gateway.connect(user).sellTokenMin(token, bag, 0, { value: fee })).to.be.revertedWith('GW: zero min')
        await expect(opc.gateway.connect(user).buyTokenUsdcMin(stranger.address, U(100), 1, { value: fee })).to.be.revertedWith('GW: unknown token')
        const b = await backing(w)
        expect(b.supply).to.equal(b.usdc)
      })
    }

    it('on the hub chain of the six-chain world the same functions work, next to cross-chain traders on the same curve', async () => {
      const w = await deployWorldAsync()
      const base = w.chains[2] // the hub chain's own gateway: a loopback
      const opc = w.chains[5]
      await fundUsdc(base, user, 3_000)
      await fundUsdc(opc, user2, 3_000)
      await (await base.gateway.connect(user).spawnTokenUsdc('GLOOP', 'GLP', '{}', 0, 0)).wait()
      await w.deliverAll()
      const token = await w.pad.allTokens(0)
      await pastGenesis()
      const rep = await ethers.getContractAt('SpawnToken', await base.gateway.replicaOf(token))

      const out = await peek(async () => {
        await (await base.gateway.connect(user).buyTokenUsdc(token, U(400))).wait()
        return rep.balanceOf(user.address)
      })
      // a cross-chain buy is in flight when the local trader signs…
      await (await opc.gateway.connect(user2).buyTokenUsdc(token, U(1_500))).wait()
      await (await base.gateway.connect(user).buyTokenUsdcMin(token, U(400), out)).wait() // …but has not landed: same price
      expect(await rep.balanceOf(user.address)).to.equal(out)
      // once it lands, the price has moved and the same order is refused
      await w.deliverAll()
      await expect(base.gateway.connect(user).buyTokenUsdcMin(token, U(400), out)).to.be.revertedWith('GW: min out')

      const dollars = await peek(async () => {
        const before = await worth(base, user)
        await (await base.gateway.connect(user).sellToken(token, out)).wait()
        return (await worth(base, user)) - before
      })
      await (await base.gateway.connect(user).sellTokenMin(token, out, dollars)).wait()
      await w.deliverAll()

      const b = await backing(w)
      expect(b.supply).to.equal(b.usdc)
      let circulating = 0n
      for (const c of w.chains) {
        const r = await ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
        circulating += await r.totalSupply()
      }
      const hub = await ethers.getContractAt('SpawnToken', token)
      expect((await hub.totalSupply()) + circulating).to.equal(BILLION)
    })
  })

  /* ====================================================================== */
  /*  One dead leg must not brick every launch                               */
  /* ====================================================================== */

  describe('one dead leg must not brick every launch', () => {
    const ARB = 5
    const OPT = 6
    const eid = (label) => 30_000 + label
    const SYNC_FAILED = ethers.id('SyncFailed(address,uint32)')

    async function supplyOf(w, token, parked = 0n) {
      let circulating = 0n
      for (const c of w.chains) {
        const rep = await c.gateway.replicaOf(token)
        if (rep !== ethers.ZeroAddress) circulating += await (await ethers.getContractAt('SpawnToken', rep)).totalSupply()
      }
      return (await (await ethers.getContractAt('SpawnToken', token)).totalSupply()) + circulating + parked
    }
    const replicated = async (w, token) => {
      const have = []
      for (const c of w.chains) if ((await c.gateway.replicaOf(token)) !== ethers.ZeroAddress) have.push(c.label)
      return have
    }

    it('a leg whose send reverts costs that chain its replica — not everyone their launch; `resync` repairs it', async () => {
      const w = await deployWorldAsync()
      const [base, arb, opc] = [w.chains[2], w.chains[4], w.chains[5]]
      // the hub can no longer send to Arbitrum (no executor gas configured = the adapter refuses)
      await (await w.hubMessenger.setDestination(ARB, 0, 0)).wait()

      // a launch from the hub chain: one transaction, and it goes through
      await fundUsdc(base, user, 2_000)
      const local = await base.gateway.connect(user).spawnTokenUsdc('GLOOP', 'GLP', '{}', U(50), 0)
      const token = await w.pad.allTokens(0)
      await expect(local).to.emit(w.pad, 'SyncFailed').withArgs(token, ARB)
      await w.deliverAll()
      expect(await replicated(w, token)).to.deep.equal([1, 2, 3, 4, 6])
      expect(await (await ethers.getContractAt('SpawnToken', await base.gateway.replicaOf(token))).balanceOf(user.address)).to.be.gt(0n)

      // a launch from another remote chain: its SPAWN lands on the hub and goes through too
      await fundUsdc(opc, user2, 2_000)
      await (await opc.gateway.connect(user2).spawnTokenUsdc('BORK', 'BORK', '{}', U(40), 0)).wait()
      const landed = await w.endpoint.deliverNext()
      const token2 = await w.pad.allTokens(1)
      await expect(landed).to.emit(w.pad, 'SyncFailed').withArgs(token2, ARB)
      await w.deliverAll()
      expect(await replicated(w, token2)).to.deep.equal([1, 2, 3, 4, 6])

      // on the dead leg the tokens simply do not exist: every entry is refused before anything moves
      await fundUsdc(arb, stranger, 500)
      await expect(arb.gateway.connect(stranger).buyTokenUsdc(token, U(10))).to.be.revertedWith('GW: unknown token')
      await expect(arb.gateway.connect(stranger).buyTokenUsdcMin(token, U(10), 1)).to.be.revertedWith('GW: unknown token')
      await expect(arb.gateway.connect(stranger).sellToken(token, E(1))).to.be.revertedWith('GW: no replica')
      await expect(arb.gateway.connect(stranger).claimFees(token)).to.be.revertedWith('GW: unknown token')
      await expect(arb.gateway.connect(stranger).pullFees(token)).to.be.revertedWith('GW: unknown token')
      await expect(arb.gateway.connect(stranger).claimPending(token)).to.be.revertedWith('GW: no replica')
      expect(await arb.usdc.balanceOf(stranger.address)).to.equal(U(500))

      // …while everyone else trades
      await pastGenesis()
      await (await opc.gateway.connect(user2).buyTokenUsdc(token, U(300))).wait()
      await (await base.gateway.connect(user).buyTokenUsdc(token2, U(300))).wait()
      await w.deliverAll()
      let b = await backing(w)
      expect(b.supply).to.equal(b.usdc)
      expect(await supplyOf(w, token)).to.equal(BILLION)
      expect(await supplyOf(w, token2)).to.equal(BILLION)

      // a resync is only for a real token on a real chain
      await expect(w.pad.resync(stranger.address, ARB)).to.be.revertedWith('PAD: unknown')
      await expect(w.pad.resync(token, 9)).to.be.revertedWith('PAD: unknown')
      await expect(w.pad.resync(token, 0)).to.be.revertedWith('PAD: unknown')
      // while the leg is still dead, a resync fails loudly — the operator's, or anyone's
      await expect(w.pad.resync(token, ARB)).to.be.revertedWith('LZM: no gas limit')
      await expect(w.pad.connect(stranger).resync(token, ARB, { value: E(1) })).to.be.revertedWith('LZM: no gas limit')

      // the leg is repaired. Only the operator may spend the hub tank on a SYNC: anyone else
      // pays for theirs (v7.2 — test/v72.test.js); the operator re-sends both, on the tank
      await (await w.hubMessenger.setDestination(ARB, GAS_TO_SPOKE, 0)).wait()
      await expect(w.pad.connect(stranger).resync(token, ARB)).to.be.revertedWith('PAD: fee')
      await (await w.pad.setOperator(dev.address)).wait()
      const tank = await bal(w.hubMessenger)
      await expect(w.pad.connect(dev).resync(token, ARB)).to.emit(w.pad, 'Resynced').withArgs(token, ARB)
      await (await w.pad.connect(dev).resync(token2, ARB)).wait()
      expect(tank - (await bal(w.hubMessenger))).to.equal(2n * w.FEE)
      await w.deliverAll()
      expect(await replicated(w, token)).to.deep.equal([1, 2, 3, 4, 5, 6])
      expect(await replicated(w, token2)).to.deep.equal([1, 2, 3, 4, 5, 6])

      // a second SYNC is ignored: the replica is the same contract
      const rep = await arb.gateway.replicaOf(token)
      await (await w.pad.connect(dev).resync(token, ARB)).wait()
      await w.deliverAll()
      expect(await arb.gateway.replicaOf(token)).to.equal(rep)

      // and the chain is a chain like the others
      await (await arb.gateway.connect(stranger).buyTokenUsdc(token, U(100))).wait()
      await w.deliverAll()
      expect(await (await ethers.getContractAt('SpawnToken', rep)).balanceOf(stranger.address)).to.be.gt(0n)
      b = await backing(w)
      expect(b.supply).to.equal(b.usdc)
      expect(await supplyOf(w, token)).to.equal(BILLION)
    })

    it('the launcher\'s OWN chain: a SYNC its executor will not carry — the dev buy is parked there, and claimed after `resync`', async () => {
      const w = await deployWorldAsync()
      const opc = w.chains[5]
      const name = 'N'.repeat(64) // the longest name a gateway admits
      await fundUsdc(opc, user, 1_000)

      // LayerZero's executor config has a max message size per pathway: size it
      // between the DELIVER (which must pass) and the SYNC of this token
      const anyToken = b32(stranger.address)
      const sync = envelope(b32(w.pad.target), opc.gateway.target, op(10, ['bytes32', 'string', 'string'], [anyToken, name, 'NNN']))
      const deliver = envelope(
        b32(w.pad.target),
        opc.gateway.target,
        op(11, ['bytes32', 'bytes32', 'uint256', 'uint256'], [anyToken, anyToken, 1n, 0n]),
      )
      const size = (hex) => (hex.length - 2) / 2
      expect(size(sync)).to.be.gt(size(deliver))
      await (await w.endpoint.setMaxMessageSize(eid(OPT), size(deliver))).wait()

      await (await opc.gateway.connect(user).spawnTokenUsdc(name, 'NNN', '{}', U(60), 0)).wait()
      const landed = await w.endpoint.deliverNext() // the SPAWN lands on the hub
      const token = await w.pad.allTokens(0)
      await expect(landed).to.emit(w.pad, 'SyncFailed').withArgs(token, OPT)
      await w.deliverAll() // the other SYNCs, and the dev buy's DELIVER to Optimism

      // every other chain has the token; the launcher's chain has the BAG, parked
      expect(await replicated(w, token)).to.deep.equal([1, 2, 3, 4, 5])
      const parked = await opc.gateway.pendingDelivery(token, user.address)
      expect(parked).to.be.gt(0n)
      expect(await w.pad.supplyByChain(token, OPT)).to.equal(parked)
      expect(await supplyOf(w, token, parked)).to.equal(BILLION)
      await expect(opc.gateway.connect(user).claimPending(token)).to.be.revertedWith('GW: no replica')
      await expect(opc.gateway.connect(user).buyTokenUsdc(token, U(10))).to.be.revertedWith('GW: unknown token')
      let b = await backing(w)
      expect(b.supply).to.equal(b.usdc)

      // the leg is repaired, the operator re-sends the SYNC, the launcher takes the bag
      await (await w.endpoint.setMaxMessageSize(eid(OPT), 0)).wait()
      await (await w.pad.resync(token, OPT)).wait()
      await w.deliverAll()
      expect(await replicated(w, token)).to.deep.equal([1, 2, 3, 4, 5, 6])
      await (await opc.gateway.connect(user).claimPending(token)).wait()
      const rep = await ethers.getContractAt('SpawnToken', await opc.gateway.replicaOf(token))
      expect(await rep.balanceOf(user.address)).to.equal(parked)
      expect(await supplyOf(w, token)).to.equal(BILLION)

      // …and can sell it there
      await pastGenesis()
      const usdc = await opc.usdc.balanceOf(user.address)
      await (await opc.gateway.connect(user).sellToken(token, parked)).wait()
      await w.deliverAll()
      expect(await opc.usdc.balanceOf(user.address)).to.be.gt(usdc)
      b = await backing(w)
      expect(b.supply).to.equal(b.usdc)
      expect(await supplyOf(w, token)).to.equal(BILLION)
    })

    it('a reply the dead leg cannot carry still reverts the message — and LayerZero keeps it until the leg is repaired', async () => {
      const w = await deployWorldAsync()
      const arb = w.chains[4]
      await (await w.hubMessenger.setDestination(ARB, 0, 0)).wait()
      await fundUsdc(arb, user, 1_000)
      // a launch FROM the dead leg with a dev buy: the SYNC is skipped, but the
      // bag's DELIVER is a reply to that same chain — it cannot be skipped
      await (await arb.gateway.connect(user).spawnTokenUsdc('GLOOP', 'GLP', '{}', U(50), 0)).wait()
      await expect(w.endpoint.deliverNext()).to.be.revertedWith('LZM: no gas limit')
      expect(await w.endpoint.pending()).to.equal(1n)
      expect(await w.pad.tokensLength()).to.equal(0n)

      await (await w.hubMessenger.setDestination(ARB, GAS_TO_SPOKE, 0)).wait()
      await w.deliverAll()
      const token = await w.pad.allTokens(0)
      expect(await replicated(w, token)).to.deep.equal([1, 2, 3, 4, 5, 6])
      const rep = await ethers.getContractAt('SpawnToken', await arb.gateway.replicaOf(token))
      expect(await rep.balanceOf(user.address)).to.be.gt(0n)
      const b = await backing(w)
      expect(b.supply).to.equal(b.usdc)
    })

    it('single-chain universe: the home SYNC fails (no holder pool yet) — the launch stands, the bag waits, `resync` delivers it', async () => {
      const u = await universe({ dist: null })
      await u.fund(dev, 1_000)
      await u.fund(user, 1_000)
      const launch = await u.gateway.connect(dev).spawnTokenUsdc('GLOOP', 'GLP', '{}', u.T(50), 0)
      const token = await u.lastToken()
      await expect(launch).to.emit(u.pad, 'SyncFailed').withArgs(token, u.label)
      expect(await u.gateway.replicaOf(token)).to.equal(ethers.ZeroAddress)
      const parked = await u.gateway.pendingDelivery(token, dev.address)
      expect(parked).to.be.gt(0n)
      await expect(u.gateway.connect(user).buyTokenUsdc(token, u.T(10))).to.be.revertedWith('GW: unknown token')
      await expect(u.gateway.connect(dev).claimPending(token)).to.be.revertedWith('GW: no replica')
      await u.check([token], parked)

      // a resync before the cause is fixed fails like the first SYNC did
      await expect(u.pad.resync(token, u.label)).to.be.revertedWith('GW: no distributor')
      await u.wirePool()
      await (await u.pad.resync(token, u.label)).wait()
      await (await u.gateway.connect(dev).claimPending(token)).wait()
      expect(await (await u.replica(token)).balanceOf(dev.address)).to.equal(parked)
      await pastGenesis()
      await (await u.gateway.connect(user).buyTokenUsdc(token, u.T(100))).wait()
      await u.check([token])
    })

    it('gas cannot be used to skip a chain: whatever gas a spawn is delivered with, it reverts or it SYNCs every live leg', async () => {
      const w = await deployWorldAsync()
      const opc = w.chains[5]
      await fundUsdc(opc, user, 500)
      await (await opc.gateway.connect(user).spawnTokenUsdc('GLOOP', 'GLP', '{}', 0, 0)).wait()
      expect(await w.endpoint.pending()).to.equal(1n) // the SPAWN, waiting for an executor

      /** Delivers the SPAWN with `gas`; 'reverted', or the SyncFailed count. */
      const tryWith = (gas) =>
        peek(async () => {
          let rc
          try {
            rc = await (await w.endpoint.deliverAtWithGas(0, gas, { gasLimit: 15_000_000 })).wait()
          } catch {
            return 'reverted'
          }
          const failed = rc.logs.filter((l) => l.address === w.pad.target && l.topics[0] === SYNC_FAILED).length
          expect(await w.pad.tokensLength()).to.equal(1n)
          return failed
        })

      // find the least gas that lands it
      let lo = 200_000
      let hi = 8_000_000
      expect(await tryWith(hi)).to.equal(0)
      expect(await tryWith(lo)).to.equal('reverted')
      while (hi - lo > 2_000) {
        const mid = Math.floor((lo + hi) / 2)
        if ((await tryWith(mid)) === 'reverted') lo = mid
        else hi = mid
      }
      // sweep densely below the threshold (where a starved last send would be) and around it
      const outcomes = new Set()
      for (let gas = hi - 700_000; gas <= hi + 60_000; gas += 9_500) {
        const r = await tryWith(gas)
        outcomes.add(r)
        expect(r === 'reverted' || r === 0, `gas ${gas}: delivered with ${r} SYNC(s) skipped`).to.equal(true)
      }
      expect([...outcomes].sort()).to.deep.equal([0, 'reverted'])

      // the same holds for a launch signed on the hub chain, where the first SYNC is a
      // replica deployment by loopback (the most expensive send of all)
      const u = await universe()
      await u.fund(dev, 100)
      const call = () => u.gateway.connect(dev).spawnTokenUsdc
      const estimate = Number(await u.gateway.connect(dev).spawnTokenUsdc.estimateGas('GLOOP', 'GLP', '{}', 0, 0))
      for (let gas = estimate - 400_000; gas <= estimate + 20_000; gas += 10_000) {
        const r = await peek(async () => {
          try {
            await (await call()('GLOOP', 'GLP', '{}', 0, 0, { gasLimit: gas })).wait()
          } catch {
            return 'reverted'
          }
          return (await u.gateway.replicaOf(await u.lastToken())) === ethers.ZeroAddress ? 'skipped' : 'synced'
        })
        expect(r, `gas ${gas}`).to.not.equal('skipped')
      }
      // and what a wallet estimates is enough for the real thing
      await (await call()('GLOOP', 'GLP', '{}', 0, 0, { gasLimit: estimate })).wait()
      expect(await u.gateway.replicaOf(await u.lastToken())).to.not.equal(ethers.ZeroAddress)
    })

    it('the simulated transport behaves the same: a refused SYNC is logged, not fatal', async () => {
      const w = await deployWorld()
      const [base, arb] = [w.chains[2], w.chains[4]]
      // the simulated messenger refuses a destination that is no longer registered on its label
      await (await w.messenger.register(arb.gateway.target, 77)).wait()
      await fundUsdc(base, user, 500)
      const launch = await base.gateway.connect(user).spawnTokenUsdc('GLOOP', 'GLP', '{}', U(20), 0)
      const token = await w.pad.allTokens(0)
      await expect(launch).to.emit(w.pad, 'SyncFailed').withArgs(token, ARB)
      expect(await arb.gateway.replicaOf(token)).to.equal(ethers.ZeroAddress)
      expect(await base.gateway.replicaOf(token)).to.not.equal(ethers.ZeroAddress)
      await (await w.messenger.register(arb.gateway.target, ARB)).wait()
      await expect(w.pad.resync(token, ARB)).to.emit(w.pad, 'Resynced').withArgs(token, ARB)
      expect(await arb.gateway.replicaOf(token)).to.not.equal(ethers.ZeroAddress)
      const b = await backing(w)
      expect(b.supply).to.equal(b.usdc)
    })
  })
})
