const { expect } = require('chai')
const { ethers } = require('hardhat')
const { time, impersonateAccount, setBalance, takeSnapshot } = require('@nomicfoundation/hardhat-network-helpers')
const { deployDistributor, setV72Legs, setRequestCaps, GAS_TO_SPOKE, MOCK_GAS_TO_HUB } = require('../scripts/lib-deploy')

/**
 * The mixed universe of protocol v7.2 and the small tools its tests share
 * (test/v72.test.js, test/v72-wire.test.js). Not a test file: it defines no
 * test.
 */

const E = (n) => ethers.parseEther(String(n))
const b32 = (a) => ethers.zeroPadValue(a, 32)
const coder = ethers.AbiCoder.defaultAbiCoder()
const bal = (who) => ethers.provider.getBalance(who.target ?? who.address ?? who)
const pastGenesis = () => time.increase(601)
const BILLION = E(1_000_000_000)

/** What the mock endpoint charges for one message, to any chain. */
const FEE = E('0.001')
/** A cheap chain's reply unit: one reply to it, plus a margin. */
const UNIT = E('0.0012')
const EID = (label) => 30_000 + label
/** A 32-byte identity that is not an address (a Solana key, say). */
const WIDE = '0x' + 'ab'.repeat(32)

/* Wire payloads, as the pad and the gateways build them. */
const op = (code, types, values) => coder.encode(['uint8', 'bytes'], [code, coder.encode(types, values)])
const syncOf = (token, name, symbol) => op(10, ['bytes32', 'string', 'string'], [b32(token), name, symbol])
const moveOf = (from, to, amount, dstChain) => op(7, ['bytes32', 'bytes32', 'uint256', 'uint32'], [from, to, amount, dstChain])
/** A queued packet's protocol opcode and its inner tuple. */
function unpack(pkt) {
  const [, , payload] = coder.decode(['bytes32', 'bytes32', 'bytes', 'uint256'], pkt.message)
  const [code, data] = coder.decode(['uint8', 'bytes'], payload)
  return { op: Number(code), data }
}

/** Runs `fn`, returns what it returns, and puts the chain back as it was. */
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

/** Label 3 is the hub chain's own gateway: it reaches the pad by loopback. */
const HOME = 3
const LAYOUT = [
  { label: 3, id: 'base', dollar: 'USDC' },
  { label: 6, id: 'optimism', dollar: 'USDC' },
  { label: 5, id: 'arbitrum', dollar: 'USDC' },
  { label: 2, id: 'ethereum', dollar: 'USDC' },
  { label: 4, id: 'bnb', dollar: 'USDT' },
]

/**
 * THE MIXED UNIVERSE (v7.2) — one hub, five user-facing EVM chains, two
 * dollars, in the mainnet topology and with the mainnet fee setting (nobody
 * is sponsored but the pad: every user call attaches its quoted fee):
 *
 *   label 3  base      the hub chain's own gateway (loopback)   USDC   OmniUSD
 *   label 6  optimism  remote                                   USDC   OmniUSD
 *   label 5  arbitrum  remote                                   USDC   OmniUSD
 *   label 2  ethereum  remote — the dear leg                    USDC   OmniUSD
 *   label 4  bnb       remote                                   USDT   OmniUSDLocal (18 decimals, SCALE 1, no CCTP)
 *
 * all over the mock endpoint, which charges FEE per message (plus what a
 * test adds for one destination). Every remote chain prepays UNIT per reply
 * leg; the hub's ceiling for a request toward a remote chain is that UNIT.
 * `homePool: false` leaves the hub chain's gateway without its holder pool,
 * so that its SYNC fails at launch; `homeDollar` swaps the hub chain's USDC
 * for a test token (one with a transfer hook); `venueName` swaps the curve
 * for a test venue.
 */
async function deployMixed({ homePool = true, homeDollar = 'MockUSDC', venueName = 'InternalCurveVenue' } = {}) {
  const [funder] = await ethers.getSigners()
  const endpoint = await ethers.deployContract('MockLZEndpointV2', [FEE])
  const hubMessenger = await ethers.deployContract('LayerZeroOmniMessenger', [endpoint.target, EID(0)])
  await (await endpoint.registerAdapter(hubMessenger.target, EID(0))).wait()
  // the hub tank's float
  await (await funder.sendTransaction({ to: hubMessenger.target, value: E(1) })).wait()

  const hubUsd = await ethers.deployContract('OmniUSD', [0, ethers.ZeroAddress, ethers.ZeroAddress])
  const pad = await ethers.deployContract('SpawnPad', [hubMessenger.target, hubUsd.target])
  const venue = await ethers.deployContract(venueName, [pad.target])
  await (await pad.setVenue(venue.target)).wait()
  await (await hubUsd.setAgent(pad.target)).wait()
  await (await hubMessenger.register(pad.target, 0)).wait()
  await (await hubMessenger.setSponsored(pad.target, true)).wait()
  await (await hubMessenger.setLocal(0, true)).wait()
  await (await hubMessenger.setLocal(HOME, true)).wait()
  // what a user of the hub chain's gateway prepays per leg the hub must send for them
  await (await hubMessenger.setDestination(0, 0, UNIT)).wait()

  const labels = LAYOUT.map((c) => c.label)
  const remotes = labels.filter((l) => l !== HOME).length
  const chains = []
  for (const c of LAYOUT) {
    const local = c.label === HOME
    let messenger = hubMessenger
    if (!local) {
      // a spoke adapter with an EMPTY tank: nothing here is paid by anyone but the user
      messenger = await ethers.deployContract('LayerZeroOmniMessenger', [endpoint.target, EID(c.label)])
      await (await endpoint.registerAdapter(messenger.target, EID(c.label))).wait()
    }
    let dollar, usd, decimals
    if (c.dollar === 'USDT') {
      decimals = 18
      dollar = await ethers.deployContract('MockDollar', ['Tether USD', 'USDT', decimals])
      usd = await ethers.deployContract('OmniUSDLocal', [c.label, dollar.target])
    } else {
      decimals = 6
      // (`homeDollar`: the hub chain's dollar as a token with a transfer hook — tests only)
      dollar =
        c.label === HOME && homeDollar !== 'MockUSDC'
          ? await ethers.deployContract(homeDollar, [decimals])
          : await ethers.deployContract('MockUSDC')
      const cctp = await ethers.deployContract('MockTokenMessenger')
      usd = await ethers.deployContract('OmniUSD', [c.label, dollar.target, cctp.target])
    }
    const T = (n) => ethers.parseUnits(String(n), decimals)
    await (await usd.setDepositCap(T(1_000_000_000))).wait()
    const gateway = await ethers.deployContract('SpawnGateway', [messenger.target, usd.target, c.label, pad.target])
    await (await usd.setAgent(gateway.target)).wait()
    await (await messenger.register(gateway.target, c.label)).wait()
    if (!local) {
      await (await messenger.setRoute(0, EID(0), b32(hubMessenger.target))).wait()
      await (await hubMessenger.setRoute(c.label, EID(c.label), b32(messenger.target))).wait()
      await (await messenger.setDestination(0, MOCK_GAS_TO_HUB, UNIT)).wait()
      await (await hubMessenger.setDestination(c.label, GAS_TO_SPOKE, 0)).wait()
    }
    const chain = { ...c, local, dollar, usd, gateway, messenger, decimals, T, SCALE: await usd.SCALE() }
    chain.wirePool = async () => {
      chain.dist = await deployDistributor(usd, gateway)
    }
    if (!local || homePool) await chain.wirePool()
    await (await pad.setGateway(c.label, b32(gateway.target))).wait()
    if (local) await (await pad.setAutoDrop(c.label, true)).wait()
    await (await gateway.setLegs(local ? 0 : 1, remotes)).wait()
    // v7.2: an open prepays one leg (none at home), a move one leg to any other chain;
    // on the hub, a request toward a remote chain may cost up to what it prepaid
    await setV72Legs(gateway, { local, labels, self: c.label })
    if (!local) await setRequestCaps(pad, c.label, UNIT)
    chains.push(chain)
  }

  const w = { endpoint, hubMessenger, hubUsd, pad, venue, chains, labels }
  w.at = (label) => chains.find((c) => c.label === label)
  w.tank = () => bal(hubMessenger)
  w.deliverAll = async () => {
    while ((await endpoint.pending()) > 0n) await (await endpoint.deliverAll(32)).wait()
  }
  /** Gives `who` `dollars` of `c`'s dollar token, approved to its vault. */
  w.fund = async (c, who, dollars) => {
    await (await c.dollar.mint(who.address, c.T(dollars))).wait()
    await (await c.dollar.connect(who).approve(c.usd.target, ethers.MaxUint256)).wait()
  }
  /** Leaves `who` holding `dollars` of oUSD on `c`, backed — the way a claim
   * comes to exist: the gateway took the dollars in, their value came back
   * as oUSD. (The USDT vault has no `wrap`; this works on both.) */
  w.claim = async (c, who, dollars) => {
    await w.fund(c, who, dollars)
    const agent = await as(c.gateway.target)
    await (await c.usd.connect(agent).depositFor(who.address, c.T(dollars))).wait()
    await (await c.usd.connect(agent).bridgeMint(who.address, E(dollars))).wait()
  }
  /** Everything `who` holds in `c`'s dollars, in oUSD wei: tokens + claims. */
  w.worth = async (c, who) => (await c.dollar.balanceOf(who.address)) * c.SCALE + (await c.usd.balanceOf(who.address))
  /** Both sides of the GLOBAL backing invariant: every vault's dollars at
   * that vault's SCALE, and oUSD supply over every instance, ledger included. */
  w.backing = async () => {
    let held = 0n
    let supply = await hubUsd.totalSupply()
    for (const c of chains) {
      held += (await c.dollar.balanceOf(c.usd.target)) * c.SCALE
      supply += await c.usd.totalSupply()
    }
    return { held, supply }
  }
  w.tokens = async () => {
    const n = Number(await pad.tokensLength())
    const out = []
    for (let i = 0; i < n; i++) out.push(await pad.allTokens(i))
    return out
  }
  w.lastToken = async () => pad.allTokens((await pad.tokensLength()) - 1n)
  w.replica = async (c, token) => ethers.getContractAt('SpawnToken', await c.gateway.replicaOf(token))
  /** The labels that hold a replica of `token`, sorted. */
  w.replicated = async (token) => {
    const have = []
    for (const c of chains) if ((await c.gateway.replicaOf(token)) !== ethers.ZeroAddress) have.push(c.label)
    return have.sort((a, b) => a - b)
  }
  /** What must hold whenever nothing is in flight. `parked`: tokens the hub
   * delivered that wait in a gateway for their replica. */
  w.check = async ({ parked = 0n } = {}) => {
    expect(await endpoint.pending(), 'messages in flight').to.equal(0n)
    const b = await w.backing()
    expect(b.held, 'Σ vault dollars × SCALE == Σ oUSD supply').to.equal(b.supply)
    for (const t of await w.tokens()) {
      let total = await (await ethers.getContractAt('SpawnToken', t)).totalSupply()
      for (const c of chains) {
        const rep = await c.gateway.replicaOf(t)
        const there = rep === ethers.ZeroAddress ? 0n : await (await ethers.getContractAt('SpawnToken', rep)).totalSupply()
        // S2: the hub's ledger of where the supply lives is what the chain holds
        if (parked === 0n) expect(await pad.supplyByChain(t, c.label), `supplyByChain ${c.id}`).to.equal(there)
        total += there
      }
      expect(total + parked, 'token supply').to.equal(BILLION - (await pad.feesOf(t)).burnedTokens)
    }
  }
  /** One step of a scenario: the transaction, every message it causes, then
   * the invariants — and the hub tank, which a prepaid step never lowers. */
  w.step = async (send, { tankMayFall = false, parked = 0n } = {}) => {
    const tank = await w.tank()
    const rc = await (await send()).wait()
    await w.deliverAll()
    await w.check({ parked })
    if (!tankMayFall) expect(await w.tank(), 'hub tank').to.be.gte(tank)
    return rc
  }
  /* user actions, each with its quoted fee attached */
  w.spawn = async (c, who, { name = 'GLOOP', symbol = 'GLP', meta = '{}', devBuy = 0, mode = 0 } = {}) =>
    c.gateway.connect(who).spawnTokenUsdc(name, symbol, meta, c.T(devBuy), mode, {
      value: await c.gateway.quoteSpawn(name, symbol, meta, devBuy > 0),
    })
  w.buy = async (c, who, token, dollars) =>
    c.gateway.connect(who).buyTokenUsdc(token, c.T(dollars), { value: await c.gateway.quoteBuy() })
  w.sell = async (c, who, token, tokens) =>
    c.gateway.connect(who).sellToken(token, tokens, { value: await c.gateway.quoteSell() })
  w.open = async (c, who, token) => c.gateway.connect(who).openToken(token, { value: await c.gateway.quoteOpen() })
  w.move = async (c, who, dst, to, amount) =>
    c.gateway.connect(who).moveClaim(dst, to, amount, { value: await c.gateway.quoteMove(dst) })
  /** What the hub's adapter asks the pad for `token`'s SYNC to `label` — with
   * the one leg of native value a SYNC carries (nothing toward an EVM chain,
   * whose unit on the hub adapter is 0). */
  w.syncQuote = async (token, label) => {
    const m = await pad.metas(token)
    return hubMessenger
      .connect(ethers.provider)
      .quote(label, await pad.gateways(label), syncOf(token, m.name, m.symbol), 1, { from: pad.target })
  }
  return w
}

/**
 * Makes Ethereum the dear leg it is: a message to it costs `times` what a
 * message to an L2 does. Its own users prepay their replies at that price
 * (+20%), a claim moved there prepays it in the sender's cheap units, and
 * the hub's ceiling for a request toward it follows.
 */
async function dearEthereum(w, times = 10n) {
  const eth = w.at(2)
  await (await w.endpoint.setDstFee(EID(2), FEE * (times - 1n))).wait()
  const l1 = FEE * times
  const unit = (l1 * 12n) / 10n
  await (await eth.messenger.setDestination(0, MOCK_GAS_TO_HUB, unit)).wait()
  await setRequestCaps(w.pad, 2, unit)
  for (const c of w.chains) if (c.label !== 2) await (await c.gateway.setMoveLegs(2, unit / UNIT)).wait()
  return { l1, unit }
}

/** The parsed `name` events of `contract` in a receipt. */
function events(rc, contract, name) {
  return rc.logs
    .filter((l) => l.address === contract.target)
    .map((l) => {
      try {
        return contract.interface.parseLog(l)
      } catch {
        return null
      }
    })
    .filter((e) => e?.name === name)
}

module.exports = {
  E, b32, coder, bal, pastGenesis, BILLION, FEE, UNIT, EID, WIDE, HOME, LAYOUT,
  op, syncOf, moveOf, unpack, peek, as, events, deployMixed, dearEthereum,
}
