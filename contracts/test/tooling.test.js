const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ethers } = require('hardhat')
const { impersonateAccount, setBalance } = require('@nomicfoundation/hardhat-network-helpers')
const { PROFILES } = require('../config/profiles')
const { deployNet, loadState, b32, GENERATION } = require('../scripts/lib-net')
const { handover } = require('../scripts/lib-handover')
const { tuneFees, keeperPull, status } = require('../scripts/lib-ops')

const U = (n) => ethers.parseUnits(String(n), 6)
const E = (n) => ethers.parseEther(String(n))
const quiet = () => {}

/**
 * The deploy and ops TOOLING, end to end, on one in-process chain: the real
 * scripts (scripts/lib-net.js, lib-handover.js, lib-ops.js) deploy a hub and
 * two spokes as three "networks" of a profile, over the mock LayerZero
 * endpoint. Same code path as testnet and mainnet — what differs there is
 * the endpoint, the dollar and the preflight (proved on mainnet forks:
 * test-fork/).
 */
describe('deploy & ops tooling (profile-driven, in-process)', function () {
  this.timeout(300_000)
  const HUB = 'baseSepolia'
  const OP = 'optimismSepolia'
  const ARB = 'arbitrumSepolia'
  const FEE = E('0.001')

  let deployer, creator, trader, owner, guardian
  let endpoint, profile, providers
  let pad, token

  const state = () => loadState(profile.stateFile)
  const at = (name, addr, signer) => ethers.getContractAt(name, addr, signer)
  /** One network's run of the real deploy script; then the mock endpoint
   * learns the new adapter (a real endpoint needs no registration). */
  async function deploy(net, extra = {}) {
    const ctx = await deployNet({
      profile, netKey: net, signer: deployer, dry: false, preflight: false, providers, log: quiet, ...extra,
    })
    const adapter = state()[net]?.adapter
    if (adapter && (await endpoint.eidOfAdapter(adapter)) === 0n) {
      await (await endpoint.registerAdapter(adapter, profile.nets[net].eid)).wait()
    }
    return ctx
  }
  const deliverAll = async () => {
    while ((await endpoint.pending()) > 0n) await (await endpoint.deliverAll(32)).wait()
  }

  before(async () => {
    ;[deployer, creator, trader, owner, guardian] = await ethers.getSigners()
    endpoint = await ethers.deployContract('MockLZEndpointV2', [FEE])
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-tooling-'))
    const t = PROFILES.testnet
    profile = {
      ...t,
      nets: { [HUB]: { ...t.nets[HUB] }, [OP]: { ...t.nets[OP] }, [ARB]: { ...t.nets[ARB] } },
      endpoint: endpoint.target,
      stateFile: path.join(dir, 'state.json'),
      manifestFile: path.join(dir, 'manifest.json'),
      // run the simulated testnet the MAINNET way: users pay their messages
      sponsored: false,
      returnUnit: E('0.002'),
      gasToHub: 6_000_000n, // the mock endpoint stores packets on-chain (~0.52M gas per send)
      tank: { mode: 'fixed', hub: E('0.01'), spoke: 0n },
      timelockDelay: 48 * 3600,
    }
    providers = { [HUB]: ethers.provider, [OP]: ethers.provider, [ARB]: ethers.provider }
  })

  it('a dry run plans everything and sends nothing', async () => {
    const nonce = await ethers.provider.getTransactionCount(deployer.address)
    const ctx = await deploy(HUB, { dry: true })
    expect(ctx.plan.length).to.be.gt(20)
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce)
    expect(state()).to.deep.equal({})
  })

  it('hub, then spokes, then the hub again: every value reads back as planned; re-runs send nothing', async () => {
    await expect(deploy(OP)).to.be.rejectedWith(/deploy the hub first/)
    expect((await deploy(HUB)).check.ok).to.equal(true)
    expect((await deploy(OP)).check.ok).to.equal(true)
    expect((await deploy(ARB)).check.ok).to.equal(true)
    const wired = await deploy(HUB)
    expect(wired.check.ok).to.equal(true)
    // the first spoke was deployed before the second existed: its spawnLegs is stale until re-run
    const opGw = await at('SpawnGateway', state()[OP].gateway)
    expect(await opGw.spawnLegs()).to.equal(1n)
    const refreshed = await deploy(OP)
    expect(await opGw.spawnLegs()).to.equal(2n)
    expect(refreshed.check.soft).to.deep.equal([])

    for (const net of [HUB, OP, ARB]) {
      const again = await deploy(net)
      expect(again.gas.txs, `${net} re-run`).to.equal(0)
      expect(again.check.ok).to.equal(true)
      expect(again.check.soft).to.deep.equal([])
    }

    const s = state()
    pad = await at('SpawnPad', s[HUB].pad)
    expect(await pad.gateways(profile.nets[OP].label)).to.equal(b32(s[OP].gateway))
    expect(await pad.autoDrop(profile.nets[HUB].label)).to.equal(true)
    expect(await pad.autoDrop(profile.nets[OP].label)).to.equal(false)
    const hubGw = await at('SpawnGateway', s[HUB].gateway)
    expect([await hubGw.tradeLegs(), await hubGw.spawnLegs()]).to.deep.equal([0n, 2n])
    expect(await ethers.provider.getBalance(s[HUB].adapter)).to.equal(E('0.01'))
    expect(await ethers.provider.getBalance(s[OP].adapter)).to.equal(0n)

    const manifest = JSON.parse(fs.readFileSync(profile.manifestFile, 'utf8'))
    expect(manifest.network).to.equal(undefined) // testnet shape
    expect(manifest.sponsored).to.equal(false)
    expect(manifest.gasDrip).to.equal('/.netlify/functions/gas-drip')
    expect(manifest.chains.map((c) => [c.id, !!c.local])).to.deep.equal([
      ['base', true], ['optimism', false], ['arbitrum', false],
    ])
    for (const c of manifest.chains) expect(c).to.include.keys('gateway', 'usd', 'usdc', 'dist', 'chainId', 'rpc')
  })

  it('a pre-v7 state entry is refused before a single transaction', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-tooling-old-'))
    const old = { ...profile, stateFile: path.join(dir, 'state.json') }
    fs.writeFileSync(old.stateFile, JSON.stringify({ [HUB]: { adapter: deployer.address, usd: deployer.address, pad: deployer.address } }))
    const nonce = await ethers.provider.getTransactionCount(deployer.address)
    await expect(
      deployNet({ profile: old, netKey: HUB, signer: deployer, dry: false, preflight: false, log: quiet }),
    ).to.be.rejectedWith(/pre-v7 deployment/)
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce)
  })

  it('a v7.1 state entry is refused the same way: v7.2 never completes or extends an older generation', async () => {
    expect(GENERATION).to.equal('v7.2')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-tooling-v71-'))
    const old = { ...profile, stateFile: path.join(dir, 'state.json') }
    const entry = { transport: 'v7.1', adapter: deployer.address, usd: deployer.address, pad: deployer.address }
    fs.writeFileSync(old.stateFile, JSON.stringify({ [HUB]: entry }))
    const nonce = await ethers.provider.getTransactionCount(deployer.address)
    for (const net of [HUB, OP]) {
      // the hub itself, and a spoke asked to join a v7.1 hub
      await expect(
        deployNet({ profile: old, netKey: net, signer: deployer, dry: false, preflight: false, log: quiet }),
      ).to.be.rejectedWith(/v7\.1 deployment/)
    }
    await expect(
      deployNet({ profile: old, netKey: HUB, signer: deployer, dry: false, preflight: false, log: quiet }),
    ).to.be.rejectedWith(/_v71_pre72/) // and it says how to archive it
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce)
    expect(loadState(old.stateFile)[HUB]).to.deep.equal(entry) // untouched
  })

  it('the deployed world trades cross-chain with user-paid fees; keeper-pull brings a remote slice home; status sees it all backed', async () => {
    const s = state()
    const opUsdc = await at('MockUSDC', s[OP].usdc)
    const arbUsdc = await at('MockUSDC', s[ARB].usdc)
    const opGw = await at('SpawnGateway', s[OP].gateway)
    const arbGw = await at('SpawnGateway', s[ARB].gateway)
    await (await opUsdc.mint(creator.address, U(100))).wait()
    await (await opUsdc.connect(creator).approve(s[OP].usd, U(100))).wait()
    await (await arbUsdc.mint(trader.address, U(500))).wait()
    await (await arbUsdc.connect(trader).approve(s[ARB].usd, U(500))).wait()

    const spawnFee = await opGw.quoteSpawn('TOOLING', 'TOOL', '{}', true)
    await (await opGw.connect(creator).spawnTokenUsdc('TOOLING', 'TOOL', '{}', U(40), 0, { value: spawnFee })).wait()
    await deliverAll()
    token = await pad.allTokens(0)
    for (const net of [HUB, OP, ARB]) {
      expect(await (await at('SpawnGateway', s[net].gateway)).replicaOf(token)).to.not.equal(ethers.ZeroAddress)
    }

    // a buy inside the genesis window: the snipe tax feeds the holders pot
    await (await arbGw.connect(trader).buyTokenUsdc(token, U(200), { value: await arbGw.quoteBuy() })).wait()
    await deliverAll()
    const opLabel = profile.nets[OP].label
    expect(await pad.pendingDrop(token, opLabel)).to.be.gt(E(1)) // Optimism's slice waits on the hub

    // below the threshold: nothing; at it: the keeper pulls, paying the round trip
    expect(await keeperPull({ profile, netKey: OP, signer: deployer, thresholdUsd: 10_000, apply: true, providers, log: quiet })).to.deep.equal([])
    const listed = await keeperPull({ profile, netKey: OP, signer: deployer, thresholdUsd: 1, providers, log: quiet })
    expect(listed.length).to.equal(1)
    expect(listed[0].pulled).to.equal(false) // listing only
    const pulled = await keeperPull({ profile, netKey: OP, signer: deployer, thresholdUsd: 1, apply: true, providers, log: quiet })
    expect(pulled[0].pulled).to.equal(true)
    await deliverAll()
    expect(await pad.pendingDrop(token, opLabel)).to.equal(0n)
    const dist = await at('FeeDistributor', s[OP].dist)
    const replica = await opGw.replicaOf(token)
    expect(await dist.withdrawable(replica, creator.address)).to.be.gt(E(1))
    // the hub chain is served inline: nothing for a keeper to do there
    expect(await keeperPull({ profile, netKey: HUB, signer: deployer, thresholdUsd: 0, apply: true, providers, log: quiet })).to.deep.equal([])

    const st = await status({ profile, providers, log: quiet })
    expect(st.ok).to.equal(true)
    expect(st.held).to.equal(st.supply) // nothing in flight: exact
    expect(st.warnings).to.deep.equal([])
    // the hub tank came out ahead: every reply was prepaid
    expect(await ethers.provider.getBalance(s[HUB].adapter)).to.be.gte(E('0.01'))
  })

  it('tune-fees re-prices the reply budget from live quotes — shown, then applied, then left alone', async () => {
    const s = state()
    const opAdapter = await at('LayerZeroOmniMessenger', s[OP].adapter)
    expect(await opAdapter.returnUnit(0)).to.equal(E('0.002'))
    const shown = await tuneFees({ profile, netKey: OP, signer: deployer, providers, log: quiet })
    expect(shown.changed).to.equal(true)
    expect(shown.applied).to.equal(false)
    expect(shown.target).to.equal((FEE * 125n) / 100n) // the hub's live quote + 25%
    expect(await opAdapter.returnUnit(0)).to.equal(E('0.002'))

    const applied = await tuneFees({ profile, netKey: OP, signer: deployer, apply: true, providers, log: quiet })
    expect(applied.applied).to.equal(true)
    expect(await opAdapter.returnUnit(0)).to.equal(E('0.00125'))
    expect(await opAdapter.gasLimit(0)).to.equal(profile.gasToHub) // gas untouched
    expect((await tuneFees({ profile, netKey: OP, signer: deployer, apply: true, providers, log: quiet })).changed).to.equal(false)

    // on the hub it prices the local spawn fan-out from the dearest SYNC
    const hubAdapter = await at('LayerZeroOmniMessenger', s[HUB].adapter)
    const hubRes = await tuneFees({ profile, netKey: HUB, signer: deployer, apply: true, providers, log: quiet })
    expect(hubRes.quotes.map((q) => q.net)).to.deep.equal([OP, ARB])
    expect(await hubAdapter.returnUnit(0)).to.equal(E('0.00125'))
    // a trade from Optimism is still fully funded at the new price
    const opGw = await at('SpawnGateway', s[OP].gateway)
    const tank0 = await ethers.provider.getBalance(s[HUB].adapter)
    await (await opGw.connect(creator).pullFees(token, { value: await opGw.quotePull() })).wait()
    await deliverAll()
    expect(await ethers.provider.getBalance(s[HUB].adapter)).to.be.gte(tank0)
  })

  it('handover.js on every network: the timelock is admin everywhere, the deployer holds nothing, and the scripts adapt', async () => {
    await expect(
      handover({ profile, netKey: HUB, signer: deployer, owner: deployer.address, guardian: guardian.address, log: quiet }),
    ).to.be.rejectedWith(/OWNER is the deployer/)
    await expect(
      handover({ profile, netKey: HUB, signer: deployer, owner: ethers.ZeroAddress, guardian: guardian.address, log: quiet }),
    ).to.be.rejectedWith(/OWNER is required/)

    const dry = await handover({ profile, netKey: HUB, signer: deployer, owner: owner.address, guardian: guardian.address, dry: true, log: quiet })
    expect(dry.dry).to.equal(true)
    expect(state()[HUB].timelock).to.equal(undefined)

    for (const net of [HUB, OP, ARB]) {
      const res = await handover({ profile, netKey: net, signer: deployer, owner: owner.address, guardian: guardian.address, log: quiet })
      expect(await res.timelock.getMinDelay()).to.equal(BigInt(48 * 3600))
      expect(state()[net].handover.owner).to.equal(owner.address)
    }
    const s = state()
    const hubAdapter = await at('LayerZeroOmniMessenger', s[HUB].adapter)
    expect(await hubAdapter.admin()).to.equal(s[HUB].timelock)
    expect(await endpoint.delegates(s[HUB].adapter)).to.equal(s[HUB].timelock)
    await expect(pad.setAutoDrop(profile.nets[OP].label, true)).to.be.revertedWith('ROLES: not admin')

    // the deploy script re-runs clean: nothing to do, nothing it wants back
    for (const net of [HUB, OP, ARB]) {
      const again = await deploy(net)
      expect(again.blocked, `${net} blocked steps`).to.deep.equal([])
      expect(again.check.ok).to.equal(true)
      expect(again.check.soft.map((r) => r.what)).to.not.include('pad.operator')
    }

    // operator work is OWNER's now: the deployer gets calldata, OWNER applies
    const asDeployer = await tuneFees({ profile, netKey: ARB, signer: deployer, apply: true, providers, log: quiet })
    expect(asDeployer.applied).to.equal(false)
    expect(asDeployer.blocked.target).to.equal(s[ARB].adapter)
    const asOwner = await tuneFees({ profile, netKey: ARB, signer: owner, apply: true, providers, log: quiet })
    expect(asOwner.applied).to.equal(true)

    // status flags nothing — and on a mainnet profile it would have flagged
    // every network before the hand-over
    const st = await status({ profile, providers, log: quiet })
    expect(st.ok).to.equal(true)
    expect(st.warnings).to.deep.equal([])
    const lines = []
    await status({ profile, providers, log: (l) => lines.push(l) })
    expect(lines.filter((l) => l.includes('(the timelock)')).length).to.equal(3)
  })

  it('status fails loudly the moment a vault holds less USDC than the oUSD it backs', async () => {
    const s = state()
    const usdc = await at('MockUSDC', s[ARB].usdc)
    // simulate the unthinkable: dollars leave a vault without oUSD being burned
    await impersonateAccount(s[ARB].usd)
    await setBalance(s[ARB].usd, E(1))
    const vault = await ethers.getSigner(s[ARB].usd)
    await (await usdc.connect(vault).transfer(deployer.address, U(30))).wait()
    const st = await status({ profile, providers, log: quiet })
    expect(st.ok).to.equal(false)
    expect(st.supply - st.held).to.equal(E(30))
    // a rebalance known to be in flight is allowed for
    expect((await status({ profile, providers, inflightUsdc: 30, log: quiet })).ok).to.equal(true)
  })
})

/**
 * The hand-over with a named OPERATOR: custody and topology go behind the
 * timelock owned by OWNER, while a hot key keeps the day-to-day tuning.
 */
describe('hand-over with a separate operator (hot ops key)', function () {
  this.timeout(300_000)
  const HUB = 'baseSepolia'

  it('the deployer stays operator and nothing more: it can tune and unpause, never rewire', async () => {
    const [deployer, , , owner, guardian] = await ethers.getSigners()
    const endpoint = await ethers.deployContract('MockLZEndpointV2', [E('0.001')])
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-operator-'))
    const t = PROFILES.testnet
    const profile = {
      ...t,
      nets: { [HUB]: { ...t.nets[HUB] } },
      endpoint: endpoint.target,
      stateFile: path.join(dir, 'state.json'),
      manifestFile: path.join(dir, 'manifest.json'),
      sponsored: false,
      gasToHub: 6_000_000n,
      tank: { mode: 'fixed', hub: E('0.01'), spoke: 0n },
      timelockDelay: 48 * 3600,
    }
    const providers = { [HUB]: ethers.provider }
    const run = (extra = {}) =>
      deployNet({ profile, netKey: HUB, signer: deployer, dry: false, preflight: false, providers, log: quiet, ...extra })
    expect((await run()).check.ok).to.equal(true)

    // the launch configuration: the hot key is operator AND guardian
    const res = await handover({
      profile, netKey: HUB, signer: deployer, owner: owner.address, operator: deployer.address, guardian: deployer.address, log: quiet,
    })
    const s = loadState(profile.stateFile)[HUB]
    expect(s.handover.operator).to.equal(deployer.address)
    expect(s.handover.guardian).to.equal(deployer.address)
    expect(s.handover.owner).to.equal(owner.address)

    const pad = await ethers.getContractAt('SpawnPad', s.pad)
    const adapter = await ethers.getContractAt('LayerZeroOmniMessenger', s.adapter)
    const vault = await ethers.getContractAt('OmniUSD', s.localUsd)
    for (const c of [pad, adapter, vault]) {
      expect(await c.admin()).to.equal(res.timelock.target)
      expect(await c.operator()).to.equal(deployer.address)
      expect(await c.guardian()).to.equal(deployer.address)
    }
    // the timelock answers to OWNER alone; the hot key keeps the veto and nothing else
    const tl = res.timelock
    expect(await tl.hasRole(await tl.PROPOSER_ROLE(), owner.address)).to.equal(true)
    expect(await tl.hasRole(await tl.EXECUTOR_ROLE(), owner.address)).to.equal(true)
    expect(await tl.hasRole(await tl.PROPOSER_ROLE(), deployer.address)).to.equal(false)
    expect(await tl.hasRole(await tl.EXECUTOR_ROLE(), deployer.address)).to.equal(false)
    expect(await tl.hasRole(await tl.DEFAULT_ADMIN_ROLE(), deployer.address)).to.equal(false)
    expect(await tl.hasRole(await tl.CANCELLER_ROLE(), deployer.address)).to.equal(true)
    // running it again changes nothing and still reads back clean
    await handover({
      profile, netKey: HUB, signer: deployer, owner: owner.address, operator: deployer.address, guardian: deployer.address, log: quiet,
    })
    expect(await tl.hasRole(await tl.CANCELLER_ROLE(), deployer.address)).to.equal(true)

    // operator powers still work from the hot key…
    await (await pad.pause()).wait()
    await (await pad.unpause()).wait()
    await (await vault.setDepositCap(U(100))).wait()
    // …admin powers do not
    await expect(pad.setAutoDrop(6, true)).to.be.revertedWith('ROLES: not admin')
    await expect(adapter.recover(deployer.address)).to.be.revertedWith('ROLES: not admin')
    await expect(vault.setPeer(6, 2, b32(deployer.address))).to.be.revertedWith('ROLES: not admin')
    await expect(pad.setOperator(owner.address)).to.be.revertedWith('ROLES: not admin')

    // the deploy script re-runs clean and does not try to move the operator
    const again = await run()
    expect(again.blocked).to.deep.equal([])
    expect(again.check.ok).to.equal(true)
    expect(await pad.operator()).to.equal(deployer.address)
  })
})

/**
 * ADDING A CHAIN to a deployment that is already handed over: every topology
 * step is the timelock's, so the real scripts collect them, OWNER schedules
 * ONE batch, the delay passes, OWNER executes, the operator finishes — and at
 * no point in between does a spawn or a trade stop working.
 */
describe('adding a chain to a handed-over deployment (through the timelock)', function () {
  this.timeout(300_000)
  const { time } = require('@nomicfoundation/hardhat-network-helpers')
  const { scheduleOps, executeOps, listOps, cancelOp, collectAdminSteps } = require('../scripts/lib-timelock')
  const { hubGasFor, dvnSetFor } = require('../config/profiles')
  const { plannedUln } = require('../scripts/lib-dvn')
  const HUB = 'baseSepolia'
  const OP = 'optimismSepolia'
  const ARB = 'arbitrumSepolia'
  const ETH = 'ethereumSepolia'
  const DELAY = 48 * 3600

  let deployer, creator, trader, ownerW
  let endpoint, profile, providers, pad, timelock
  const state = () => loadState(profile.stateFile)
  const at = (name, addr, signer) => ethers.getContractAt(name, addr, signer)
  const run = async (net, extra = {}) => {
    const ctx = await deployNet({ profile, netKey: net, signer: deployer, dry: false, preflight: false, providers, log: quiet, ...extra })
    const adapter = state()[net]?.adapter
    if (adapter && (await endpoint.eidOfAdapter(adapter)) === 0n) await (await endpoint.registerAdapter(adapter, profile.nets[net].eid)).wait()
    return ctx
  }
  const deliverAll = async () => {
    while ((await endpoint.pending()) > 0n) await (await endpoint.deliverAll(32)).wait()
  }
  let n = 0
  /** A user-paid spawn from `net`; returns how many packets left the hub
   * and whether the hub tank came out at least even. */
  const spawnFrom = async (net) => {
    const gw = await at('SpawnGateway', state()[net].gateway, creator)
    const name = `ADD ${++n}`
    const fee = await gw.quoteSpawn(name, 'ADD', '{}', false)
    const tokens0 = await pad.tokensLength()
    const tank0 = await ethers.provider.getBalance(state()[HUB].adapter)
    const sent0 = await endpoint.packetsSent()
    await (await gw.spawnToken(name, 'ADD', '{}', 0, 0, { value: fee })).wait()
    await deliverAll()
    expect(await pad.tokensLength(), `spawn from ${net}`).to.equal(tokens0 + 1n)
    const token = await pad.allTokens(tokens0)
    return {
      token,
      // every packet but the spawn itself (none for the hub's own gateway) is a SYNC
      syncs: Number((await endpoint.packetsSent()) - sent0) - (net === HUB ? 0 : 1),
      tankDelta: (await ethers.provider.getBalance(state()[HUB].adapter)) - tank0,
    }
  }
  const replicaOn = async (net, token) => (await at('SpawnGateway', state()[net].gateway)).replicaOf(token)

  before(async () => {
    ;[deployer, creator, trader] = await ethers.getSigners()
    // OWNER as it really is: a key with NO gas anywhere
    ownerW = ethers.Wallet.createRandom().connect(ethers.provider)
    endpoint = await ethers.deployContract('MockLZEndpointV2', [E('0.001')])
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-addchain-'))
    const t = PROFILES.testnet
    profile = {
      ...t,
      nets: {
        [HUB]: { ...t.nets[HUB] }, [OP]: { ...t.nets[OP] }, [ARB]: { ...t.nets[ARB] },
        [ETH]: { ...t.nets[ETH], enabled: false },
      },
      endpoint: endpoint.target,
      stateFile: path.join(dir, 'state.json'),
      manifestFile: path.join(dir, 'manifest.json'),
      sponsored: false,
      returnUnit: E('0.002'),
      gasToHub: 6_000_000n,
      tank: { mode: 'fixed', hub: E('0.01'), spoke: 0n },
      timelockDelay: DELAY,
    }
    providers = { [HUB]: ethers.provider, [OP]: ethers.provider, [ARB]: ethers.provider, [ETH]: ethers.provider }
    for (const net of [HUB, OP, ARB, HUB, OP, ARB]) expect((await run(net)).check.ok).to.equal(true)
    for (const net of [HUB, OP, ARB]) {
      expect((await tuneFees({ profile, netKey: net, signer: deployer, apply: true, providers, log: quiet })).changed).to.not.equal(undefined)
      await handover({
        profile, netKey: net, signer: deployer, owner: ownerW.address, operator: deployer.address, guardian: deployer.address, log: quiet,
      })
    }
    pad = await at('SpawnPad', state()[HUB].pad)
    timelock = await at('SpawnTimelock', state()[HUB].timelock)
  })

  it('the launch topology works, and the timelock has nothing to do', async () => {
    expect((await spawnFrom(HUB)).syncs).to.equal(2)
    const fromOp = await spawnFrom(OP)
    expect(fromOp.syncs).to.equal(2)
    expect(fromOp.tankDelta).to.be.gte(0n)
    const res = await scheduleOps({ profile, netKey: HUB, owner: ownerW, deployer, providers, log: quiet })
    expect(res.scheduled).to.equal(false)
    expect(res.calls).to.deep.equal([])
  })

  it('a new spoke deploys beside the live protocol: unwired, unlisted, and nothing else moves', async () => {
    profile.nets[ETH].enabled = true
    const ctx = await run(ETH)
    expect(ctx.check.ok).to.equal(true)
    expect(ctx.blocked).to.deep.equal([]) // its own contracts: the deployer is still their admin
    expect(state()[ETH].ready).to.equal(true)
    // not in the frontend manifest until the hub has wired it
    expect(ctx.manifest.chains.map((c) => c.id)).to.deep.equal(['base', 'optimism', 'arbitrum'])
    // the live chains are untouched: same SYNC fan-out, tank still whole
    expect((await spawnFrom(HUB)).syncs).to.equal(2)
    expect((await spawnFrom(OP)).tankDelta).to.be.gte(0n)
  })

  it('the batch is refused while the operator pre-steps are not on chain; once sent, the admin steps are queued in a safe order', async () => {
    // the hub adapter has no gas limit for the newcomer yet: pad.setGateway must not even be scheduled
    await expect(scheduleOps({ profile, netKey: HUB, owner: ownerW, deployer, providers, topUp: true, log: quiet })).to.be.rejectedWith(
      /must send BEFORE the admin batch is scheduled/,
    )
    expect(await timelock.getMinDelay()).to.equal(BigInt(DELAY))

    // the operator's part, by the real deploy script: the destination's gas limit and the spawn legs
    const hubCtx = await run(HUB)
    const hubAdapter = await at('LayerZeroOmniMessenger', state()[HUB].adapter)
    const label = profile.nets[ETH].label
    expect(await hubAdapter.gasLimit(label)).to.equal(profile.gasToSpoke)
    expect(await hubAdapter.eidOf(label)).to.equal(0n) // the route is the admin's
    expect(hubCtx.blocked.map((b) => b.fn)).to.deep.equal(['setRoute', 'setGateway'])
    expect(hubCtx.blocked.every((b) => b.role === 'admin')).to.equal(true)
    for (const net of [OP, ARB]) expect((await run(net)).blocked).to.deep.equal([])
    for (const net of [HUB, OP, ARB]) expect(await (await at('SpawnGateway', state()[net].gateway)).spawnLegs()).to.equal(3n)

    // spawns still work: 2 SYNCs go out, 3 legs are prepaid (the tank keeps the difference)
    const local = await spawnFrom(HUB)
    expect(local.syncs).to.equal(2)
    expect(local.tankDelta).to.be.gt(0n)
    expect((await spawnFrom(OP)).tankDelta).to.be.gte(0n)

    const { calls, pending } = await collectAdminSteps({ profile, netKey: HUB, signer: deployer, providers })
    expect(pending).to.deep.equal([])
    expect(calls.length).to.equal(2)
    expect(calls[0].desc).to.match(/setRoute/)
    expect(calls[1].desc).to.match(/pad\.setGateway/)
  })

  it('OWNER holds no gas: the exact top-up is named, then sent by the deployer; one batch is scheduled, once', async () => {
    expect(await ethers.provider.getBalance(ownerW.address)).to.equal(0n)
    const dry = await scheduleOps({ profile, netKey: HUB, owner: ownerW, deployer, providers, dry: true, log: quiet })
    expect(dry.dry).to.equal(true)
    expect(await timelock.isOperation(dry.id)).to.equal(false)
    await expect(scheduleOps({ profile, netKey: HUB, owner: ownerW, deployer, providers, log: quiet })).to.be.rejectedWith(
      /holds 0\.0 ETH .* Send 0\.\d+ ETH to it/,
    )

    const res = await scheduleOps({ profile, netKey: HUB, owner: ownerW, deployer, providers, topUp: true, log: quiet })
    expect(res.scheduled).to.equal(true)
    expect(res.toppedUp).to.be.gt(0n)
    expect(res.id).to.equal(dry.id) // deterministic
    expect(await timelock.isOperationPending(res.id)).to.equal(true)
    expect(res.eta).to.equal(Number((await ethers.provider.getBlock('latest')).timestamp) + DELAY)
    expect(state()[HUB].ops.map((o) => [o.id, o.status])).to.deep.equal([[res.id, 'scheduled']])

    // again: the same operation is recognised, not scheduled twice
    const again = await scheduleOps({ profile, netKey: HUB, owner: ownerW, deployer, providers, topUp: true, log: quiet })
    expect(again.scheduled).to.equal(false)
    expect(again.id).to.equal(res.id)

    // interrupted between the transaction and the state file: the chain is the truth
    const all = state()
    all[HUB].ops = []
    fs.writeFileSync(profile.stateFile, JSON.stringify(all, null, 2))
    const resumed = await scheduleOps({ profile, netKey: HUB, owner: ownerW, deployer, providers, topUp: true, log: quiet })
    expect(resumed.scheduled).to.equal(false)
    expect(state()[HUB].ops.length).to.equal(1)
    expect(state()[HUB].ops[0].eta).to.equal(res.eta)
  })

  it('nothing executes before the delay — and the guardian can veto, after which it must be scheduled (and waited for) again', async () => {
    const op = state()[HUB].ops[0]
    const early = await executeOps({ profile, netKey: HUB, owner: ownerW, deployer, providers, topUp: true, log: quiet })
    expect(early.executed).to.deep.equal([])
    expect(early.waiting.map((w) => w.id)).to.deep.equal([op.id])
    const targets = op.calls.map((c) => c.target)
    const datas = op.calls.map((c) => c.data)
    await expect(
      timelock.connect(ownerW).executeBatch(targets, targets.map(() => 0), datas, op.predecessor, op.salt),
    ).to.be.reverted
    await time.increase(DELAY - 600) // ten minutes short
    expect((await executeOps({ profile, netKey: HUB, owner: ownerW, deployer, providers, topUp: true, log: quiet })).executed).to.deep.equal([])
    expect(await pad.gateways(profile.nets[ETH].label)).to.equal(ethers.ZeroHash)
    expect((await spawnFrom(HUB)).syncs).to.equal(2) // life goes on during the wait

    // the veto: the guardian (the deployer hot key) cancels; a stranger cannot
    await expect(cancelOp({ profile, netKey: HUB, signer: trader, id: op.id, log: quiet })).to.be.rejectedWith(/holds no CANCELLER role/)
    expect((await cancelOp({ profile, netKey: HUB, signer: deployer, id: op.id, log: quiet })).cancelled).to.equal(true)
    await time.increase(3600)
    expect(state()[HUB].ops[0].status).to.equal('cancelled')
    expect(await timelock.isOperation(op.id)).to.equal(false)
    const after = await executeOps({ profile, netKey: HUB, owner: ownerW, deployer, providers, topUp: true, log: quiet })
    expect(after.executed).to.deep.equal([])
    expect(after.waiting).to.deep.equal([])
    expect(await pad.gateways(profile.nets[ETH].label)).to.equal(ethers.ZeroHash)

    // wanted after all: the same batch, a fresh 48h
    const re1 = await scheduleOps({ profile, netKey: HUB, owner: ownerW, deployer, providers, topUp: true, log: quiet })
    expect(re1.scheduled).to.equal(true)
    expect(re1.id).to.equal(op.id)
    expect(re1.eta).to.be.gt(op.eta)

    // a batch cancelled BEHIND the script's back (OWNER, straight on the timelock) is noticed too
    await deployer.sendTransaction({ to: ownerW.address, value: E('0.01') })
    await (await timelock.connect(ownerW).cancel(op.id)).wait()
    const gone = await executeOps({ profile, netKey: HUB, owner: ownerW, deployer, providers, topUp: true, log: quiet })
    expect(gone.missing).to.deep.equal([{ id: op.id }])
    expect(state()[HUB].ops[0].status).to.equal('missing')
    const re = await scheduleOps({ profile, netKey: HUB, owner: ownerW, deployer, providers, topUp: true, log: quiet })
    expect(re.scheduled).to.equal(true)
    expect(re.id).to.equal(op.id)
    const rows = await listOps({ profile, netKey: HUB, provider: ethers.provider, log: quiet })
    expect(rows.length).to.equal(1)
    expect(rows[0].chain).to.match(/^waiting 48\.0h/)
  })

  it('after the delay OWNER executes; an execution interrupted before the state file is written is recognised', async () => {
    await time.increase(DELAY + 1)
    const op = state()[HUB].ops.find((o) => o.status === 'scheduled')
    // executed on chain, but the script "died" before recording it
    const targets = op.calls.map((c) => c.target)
    const datas = op.calls.map((c) => c.data)
    // OWNER needs gas for this direct call (the script would have topped it up)
    await deployer.sendTransaction({ to: ownerW.address, value: E('0.05') })
    await (await timelock.connect(ownerW).executeBatch(targets, targets.map(() => 0), datas, op.predecessor, op.salt)).wait()
    const res = await executeOps({ profile, netKey: HUB, owner: ownerW, deployer, providers, topUp: true, log: quiet })
    expect(res.executed).to.deep.equal([{ id: op.id, already: true }])
    expect(state()[HUB].ops.find((o) => o.id === op.id).status).to.equal('executed')

    const hubAdapter = await at('LayerZeroOmniMessenger', state()[HUB].adapter)
    const eth = profile.nets[ETH]
    expect(await hubAdapter.eidOf(eth.label)).to.equal(BigInt(eth.eid))
    expect(await pad.gateways(eth.label)).to.equal(b32(state()[ETH].gateway))
    // nothing is left for the timelock
    expect((await collectAdminSteps({ profile, netKey: HUB, signer: deployer, providers })).calls).to.deep.equal([])
  })

  it('between the execution and the operator follow-ups every chain still spawns — now with a third SYNC', async () => {
    const local = await spawnFrom(HUB)
    expect(local.syncs).to.equal(3)
    expect(await replicaOn(ETH, local.token)).to.not.equal(ethers.ZeroAddress)
    const fromOp = await spawnFrom(OP)
    expect(fromOp.syncs).to.equal(3)
    expect(await replicaOn(ETH, fromOp.token)).to.not.equal(ethers.ZeroAddress)
    expect(await replicaOn(ARB, fromOp.token)).to.not.equal(ethers.ZeroAddress)
  })

  it('the operator follow-ups price the new fan-out: the hub by the SUM of its SYNCs, a spoke by padding its legs; then the newcomer trades and is handed over', async () => {
    // make a SYNC dearer than a DELIVER (it is longer), as a pricier destination would
    await (await endpoint.setByteFee(E('0.00001'))).wait()
    const hubAdapter = await at('LayerZeroOmniMessenger', state()[HUB].adapter)
    const hubRes = await tuneFees({ profile, netKey: HUB, signer: deployer, apply: true, providers, log: quiet })
    expect(hubRes.quotes.map((q) => q.net)).to.deep.equal([OP, ARB, ETH])
    const sum = hubRes.quotes.reduce((a, q) => a + q.fee, 0n)
    // Σ of the three SYNC quotes + 25%, spread over the 3 legs a local spawn prepays
    expect(await hubAdapter.returnUnit(0)).to.equal((sum * 125n - 1n) / 300n + 1n)
    const hubGw = await at('SpawnGateway', state()[HUB].gateway)
    expect(await hubGw.quoteSpawn('X', 'X', '{}', false)).to.be.gte((sum * 125n) / 100n)

    for (const net of [OP, ARB, ETH]) {
      const res = await tuneFees({ profile, netKey: net, signer: deployer, apply: true, providers, log: quiet })
      expect(res.applied, net).to.equal(true)
      const adapter = await at('LayerZeroOmniMessenger', state()[net].adapter)
      const gw = await at('SpawnGateway', state()[net].gateway)
      const unit = await adapter.returnUnit(0)
      const legs = await gw.spawnLegs()
      // legs × unit covers what the hub will pay to SYNC all three chains, with the margin
      expect(legs * unit, net).to.be.gte((sum * 125n) / 100n)
      expect(legs, net).to.be.gt(3n) // padded: a SYNC costs more than this chain's reply
      expect(await adapter.gasLimit(0), net).to.equal(hubGasFor(profile, 3))
      // the deploy script never lowers a padded value
      const again = await run(net)
      expect(again.plan).to.deep.equal([])
      expect(await gw.spawnLegs(), net).to.equal(legs)
      // settled: a second run changes nothing
      expect((await tuneFees({ profile, netKey: net, signer: deployer, apply: true, providers, log: quiet })).changed, net).to.equal(false)
    }
    // a remote spawn is now fully funded by its sender, dearer SYNCs included
    const fromArb = await spawnFrom(ARB)
    expect(fromArb.syncs).to.equal(3)
    expect(fromArb.tankDelta).to.be.gte(0n)

    // the newcomer trades: USDC in on its chain, tokens delivered there
    const s = state()[ETH]
    const usdc = await at('MockUSDC', s.usdc, trader)
    const gw = await at('SpawnGateway', s.gateway, trader)
    await (await usdc.mint(trader.address, U(500))).wait()
    await (await usdc.approve(s.usd, U(100))).wait()
    await time.increase(700) // past FAIR GENESIS
    await (await gw.buyTokenUsdc(fromArb.token, U(100), { value: await gw.quoteBuy() })).wait()
    await deliverAll()
    const replica = await at('SpawnToken', await gw.replicaOf(fromArb.token))
    expect(await replica.balanceOf(trader.address)).to.be.gt(0n)

    // …and is handed over like the others; every script then runs clean
    await handover({
      profile, netKey: ETH, signer: deployer, owner: ownerW.address, operator: deployer.address, guardian: deployer.address, log: quiet,
    })
    for (const net of [HUB, OP, ARB, ETH]) {
      const ctx = await run(net)
      expect(ctx.blocked, net).to.deep.equal([])
      expect(ctx.check.ok, net).to.equal(true)
    }
    expect((await run(HUB)).manifest.chains.map((c) => c.id)).to.deep.equal(['base', 'optimism', 'arbitrum', 'ethereum'])

    // every token launched BEFORE the newcomer joined has no replica there:
    // status says so, and the operator's last follow-up is one resync per
    // token (v7.1) — paid by the hub tank, idempotent, then status is clean
    const { resync } = require('../scripts/lib-ops')
    const before = await status({ profile, providers, log: quiet })
    expect(before.missing.length).to.be.gt(0)
    expect(before.missing.every((m) => m.net === ETH && !m.fresh)).to.equal(true)
    expect(before.warnings.some((w) => w.includes('have no replica'))).to.equal(true)
    // the tank was sized for replies, not for a backfill: resync sends what
    // it can, names the shortfall, and stops — nothing is half done
    let sent = await resync({ profile, netKey: HUB, signer: deployer, token: 'missing', apply: true, providers, log: quiet })
    expect(sent).to.have.length(before.missing.length)
    const short = sent.filter((r) => r.error === 'tank')
    expect(short.length).to.be.gt(0)
    expect(sent.filter((r) => r.sent).length + short.length).to.equal(sent.length)
    const need = short.reduce((a, r) => a + r.fee, 0n)
    await deliverAll() // the SYNCs that were sent land
    // the operator tops the hub tank up by the named amount, and runs it again
    await (await deployer.sendTransaction({ to: state()[HUB].adapter, value: (need * 11n) / 10n })).wait()
    sent = await resync({ profile, netKey: HUB, signer: deployer, token: 'missing', apply: true, providers, log: quiet })
    expect(sent).to.have.length(short.length) // the pairs already sent are no longer missing
    expect(sent.every((r) => r.sent)).to.equal(true)
    await deliverAll()
    for (const m of before.missing) expect(await replicaOn(ETH, m.token), m.token).to.not.equal(ethers.ZeroAddress)
    const st = await status({ profile, providers, log: quiet })
    expect(st.ok).to.equal(true)
    expect(st.warnings).to.deep.equal([])
    expect(st.missing).to.deep.equal([])
  })

  it('a pathway can name its own verifier set, and both ends resolve the same names', async () => {
    const p = {
      nets: { a: { confirmations: 10 }, b: { confirmations: 20 }, c: { confirmations: 5 } },
      dvn: {
        required: ['L0', 'Google'], optional: ['Horizen', 'Twinstake'], optionalThreshold: 1,
        pathways: { 'c|a': { required: ['L0', 'Horizen'], optional: ['Twinstake'], optionalThreshold: 1 } },
        addresses: {
          L0: { a: '0x' + '11'.repeat(20), b: '0x' + '12'.repeat(20), c: '0x' + '13'.repeat(20) },
          Google: { a: '0x' + '21'.repeat(20), b: '0x' + '22'.repeat(20) }, // not on c
          Horizen: { a: '0x' + '31'.repeat(20), b: '0x' + '32'.repeat(20), c: '0x' + '33'.repeat(20) },
          Twinstake: { a: '0x' + '41'.repeat(20), b: '0x' + '42'.repeat(20), c: '0x' + '43'.repeat(20) },
        },
      },
    }
    expect(dvnSetFor(p, 'a', 'b').required).to.deep.equal(['L0', 'Google'])
    expect(dvnSetFor(p, 'a', 'c')).to.deep.include({ own: true, optionalThreshold: 1 })
    expect(dvnSetFor(p, 'a', 'c').required).to.deep.equal(['L0', 'Horizen'])
    // a <-> b: the default, on both ends
    expect(plannedUln(p, 'a', 'a', 'b').requiredDVNs.map((x) => x.toLowerCase())).to.deep.equal(['0x' + '11'.repeat(20), '0x' + '21'.repeat(20)])
    expect(plannedUln(p, 'b', 'a', 'a').requiredDVNCount).to.equal(2)
    // a <-> c: its own set on BOTH ends — a's addresses on a, c's on c, same names, same thresholds
    const onA = plannedUln(p, 'a', 'a', 'c')
    const onC = plannedUln(p, 'c', 'a', 'a')
    expect(onA.requiredDVNs.map((x) => x.toLowerCase())).to.deep.equal(['0x' + '11'.repeat(20), '0x' + '31'.repeat(20)])
    expect(onC.requiredDVNs.map((x) => x.toLowerCase())).to.deep.equal(['0x' + '13'.repeat(20), '0x' + '33'.repeat(20)])
    expect([onA.optionalDVNCount, onA.optionalDVNThreshold]).to.deep.equal([onC.optionalDVNCount, onC.optionalDVNThreshold])
    expect(onA.confirmations).to.equal(onC.confirmations) // both speak of a as the source
    // the default set cannot be planned on c at all: Google has no address there
    expect(() => plannedUln(p, 'c', 'b', 'b')).to.throw(/no c address configured for DVN "Google"/)
  })
})

/**
 * SINGLE-CHAIN UNIVERSES (v7.1): the `bnb` and `ethereum` profiles deployed
 * in-process by the real scripts — one chain, hub + local gateway, vault =
 * OmniUSDLocal over a dollar of the universe's own decimals (18 like BSC
 * USDT, 6 like USDC), the fixed LayerZero adapter as a loopback only.
 * Launch (deploy + canary with the `*Min` proof), finish (hand-over +
 * launch caps), status — with ZERO LayerZero packets from start to end.
 */
describe('single-chain universes (bnb: 18-decimal dollar, ethereum: 6-decimal dollar)', function () {
  this.timeout(300_000)
  const { dollarUnits, dollarScale } = require('../config/profiles')
  const { selfCheck } = require('../scripts/lib-net')
  const { setCap } = require('../scripts/lib-ops')
  const { smoke } = require('../scripts/lib-smoke')

  for (const [name, decimals, symbol] of [
    ['bnb', 18, 'USDT'],
    ['ethereum', 6, 'USDC'],
  ]) {
    it(`${name}: launch, canary with the slippage proof, hand-over, caps, status — every amount in ${decimals} decimals, no packet`, async () => {
      const [deployer, , , owner] = await ethers.getSigners()
      const endpoint = await ethers.deployContract('MockLZEndpointV2', [E('0.001')])
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spawn-universe-${name}-`))
      const base = PROFILES[name]
      const NET = base.hub
      expect(base.singleChain).to.equal(true)
      expect(Object.keys(base.nets)).to.deep.equal([NET])
      expect(base.dollar.decimals).to.equal(decimals)
      expect(base.dollar.symbol).to.equal(symbol)
      expect(base.vault).to.equal('OmniUSDLocal')
      expect(base.dvn).to.equal(null)
      const profile = {
        ...base,
        nets: { [NET]: { ...base.nets[NET] } },
        endpoint: endpoint.target,
        stateFile: path.join(dir, 'state.json'),
        manifestFile: path.join(dir, 'manifest.json'),
        // play money of the universe's own decimals instead of the real token
        mockUsdc: true,
        dollar: { symbol, decimals },
        depositCapUsdc: 100n, // the canary cap, in WHOLE dollars
      }
      const providers = { [NET]: ethers.provider }
      const run = (extra = {}) =>
        deployNet({ profile, netKey: NET, signer: deployer, dry: false, preflight: false, providers, log: quiet, ...extra })

      // ── launch: deploy ──
      const first = await run()
      expect(first.check.ok).to.equal(true)
      expect(first.check.soft).to.deep.equal([])
      const again = await run()
      expect(again.gas.txs, 're-run sends nothing').to.equal(0)
      const s = loadState(profile.stateFile)[NET]
      const vault = await ethers.getContractAt('OmniUSDLocal', s.localUsd)
      const dollar = await ethers.getContractAt('MockUSDC', s.usdc)
      const gw = await ethers.getContractAt('SpawnGateway', s.gateway)
      const pad = await ethers.getContractAt('SpawnPad', s.pad)
      expect(await dollar.decimals()).to.equal(BigInt(decimals))
      expect(await vault.SCALE()).to.equal(10n ** BigInt(18 - decimals))
      expect(await vault.SCALE()).to.equal(dollarScale(profile))
      // the cap is 100 WHOLE dollars in the token's own units — not 100e6
      expect(await vault.depositCap()).to.equal(100n * 10n ** BigInt(decimals))
      expect(await vault.depositCap()).to.equal(dollarUnits(profile, 100))
      // nothing leaves this chain: no legs, every quote is 0, one chain on the pad
      expect(await gw.tradeLegs()).to.equal(0n)
      expect(await gw.spawnLegs()).to.equal(0n)
      expect(await gw.quoteBuy()).to.equal(0n)
      expect(await gw.quoteSpawn('N', 'S', '{}', true)).to.equal(0n)
      expect(await pad.chainsLength()).to.equal(1n)

      // ── the manifest contract the frontend codes against ──
      const m = JSON.parse(fs.readFileSync(profile.manifestFile, 'utf8'))
      expect(m.network).to.equal('mainnet')
      expect(m.universe).to.equal(name)
      expect(m.dollar).to.deep.equal({ symbol, decimals })
      expect(m.sponsored).to.equal(false)
      expect(m.gasDrip).to.equal(undefined)
      expect(m.chains).to.have.length(1)
      expect(m.chains[0].local).to.equal(true)
      expect(m.chains[0].usdc).to.equal(s.usdc)
      expect(m.chains[0].usd).to.equal(s.localUsd)
      expect(m.chains[0].depositCap).to.equal(String(100n * 10n ** BigInt(decimals)))

      // ── launch: the canary, slippage-protected, with the proof ──
      const lines = []
      const res = await smoke({ profile, netKey: NET, signer: deployer, providers, buy: 3, pollMs: 1, log: (l) => lines.push(l) })
      expect(res.local).to.equal(true)
      expect(res.single).to.equal(true)
      expect(res.minOut).to.be.gt(0n)
      expect(res.bought).to.be.gte(res.minOut)
      expect(lines.some((l) => l.includes('an impossible minimum is refused ("GW: min out")'))).to.equal(true)
      expect(lines.some((l) => l.includes('buyTokenUsdcMin'))).to.equal(true)
      expect(lines.some((l) => l.includes('sellTokenMin'))).to.equal(true)
      expect(lines.at(-1)).to.include(`HUB-LOCAL SPAWN + ${symbol} BUY`)
      // the same refusal, directly: nothing pulled, nothing delivered
      const d0 = await dollar.balanceOf(deployer.address)
      await (await dollar.approve(s.localUsd, ethers.parseUnits('3', decimals))).wait()
      await expect(
        gw.buyTokenUsdcMin(res.token, ethers.parseUnits('3', decimals), ethers.parseEther('1000000000')),
      ).to.be.revertedWith('GW: min out')
      expect(await dollar.balanceOf(deployer.address)).to.equal(d0)
      // more than the canary cap is refused at the vault
      await (await dollar.mint(deployer.address, ethers.parseUnits('500', decimals))).wait()
      await (await dollar.approve(s.localUsd, ethers.parseUnits('200', decimals))).wait()
      await expect(gw.buyTokenUsdc(res.token, ethers.parseUnits('200', decimals))).to.be.reverted

      // ── finish: hand-over (hot key = operator + guardian), then the launch caps ──
      const ho = await handover({
        profile, netKey: NET, signer: deployer, owner: owner.address, operator: deployer.address, guardian: deployer.address, log: quiet,
      })
      expect(await ho.timelock.getMinDelay()).to.equal(BigInt(48 * 3600))
      for (const key of ['adapter', 'usd', 'pad', 'localUsd', 'gateway', 'localDist']) {
        const c = await ethers.getContractAt('SpawnPad', s[key]) // Roles surface only
        expect(await c.admin(), key).to.equal(ho.timelock.target)
        expect(await c.operator(), key).to.equal(deployer.address)
      }
      const capRes = await setCap({ profile, netKey: NET, signer: deployer, wholeDollars: 25_000, apply: true, log: quiet })
      expect(capRes.applied).to.equal(true)
      expect(await vault.depositCap()).to.equal(25_000n * 10n ** BigInt(decimals))
      expect((await setCap({ profile, netKey: NET, signer: deployer, wholeDollars: 25_000, apply: true, log: quiet })).changed).to.equal(false)
      // a non-operator only gets calldata
      const blocked = await setCap({ profile, netKey: NET, signer: owner, wholeDollars: 1, apply: true, log: quiet })
      expect(blocked.applied).to.equal(false)
      expect(blocked.blocked.target).to.equal(s.localUsd)

      // ── the deploy re-runs clean after the hand-over; status is clean ──
      const after = await run()
      expect(after.blocked).to.deep.equal([])
      expect(after.check.ok).to.equal(true)
      const out = []
      const st = await status({ profile, providers, log: (l) => out.push(l) })
      expect(st.ok).to.equal(true)
      expect(st.warnings).to.deep.equal([])
      expect(st.missing).to.deep.equal([])
      expect(st.held).to.equal(st.supply) // backing exact, to the wei
      expect(out.some((l) => l.includes(`VAULTS (${symbol} held`))).to.equal(true)
      expect(out.some((l) => l.includes('(the timelock)'))).to.equal(true)

      // ── and not one LayerZero packet, from the first deploy to here ──
      expect(await endpoint.packetsSent()).to.equal(0n)
      expect(await endpoint.pending()).to.equal(0n)
    })
  }

  it('the profiles themselves: universes are separate files, and "ethereum" means the universe — never a leg of the core', async () => {
    const { getProfile, activeNets } = require('../config/profiles')
    const files = new Set(['mainnet', 'bnb', 'ethereum'].map((n) => PROFILES[n].stateFile))
    const manifests = new Set(['mainnet', 'bnb', 'ethereum'].map((n) => path.basename(PROFILES[n].manifestFile)))
    expect(files.size).to.equal(3)
    expect([...manifests].sort()).to.deep.equal(['mainnet-bnb.json', 'mainnet-ethereum.json', 'mainnet.json'])
    expect(PROFILES.mainnet.universe).to.equal('core')
    // inferred from the network name when SPAWN_PROFILE is not set
    const saved = process.env.SPAWN_PROFILE
    delete process.env.SPAWN_PROFILE
    try {
      expect(getProfile('bnb').name).to.equal('bnb')
      expect(getProfile('ethereum').name).to.equal('ethereum')
      expect(getProfile('base').name).to.equal('mainnet')
    } finally {
      if (saved !== undefined) process.env.SPAWN_PROFILE = saved
    }
    // the core's launch chains do not include Ethereum, and the deploy refuses it
    expect(Object.keys(activeNets(PROFILES.mainnet))).to.deep.equal(['base', 'optimism', 'arbitrum'])
    const [deployer] = await ethers.getSigners()
    await expect(
      deployNet({ profile: PROFILES.mainnet, netKey: 'ethereum', signer: deployer, dry: true, preflight: false, log: quiet }),
    ).to.be.rejectedWith(/must not be added to the core hub/)
    void selfCheck
  })
})

/**
 * v7.1 follow-through on a multi-chain deployment: a SYNC that cannot be
 * sent no longer undoes the launch (the token is born without a replica
 * there) — status must SHOW it and resync must repair it; and a remote
 * gateway left at tradeLegs = 0 must fail the self-check LOUDLY.
 */
describe('v7.1: a failed SYNC is seen and repaired; tradeLegs = 0 on a remote gateway is a hard failure', function () {
  this.timeout(300_000)
  const { time } = require('@nomicfoundation/hardhat-network-helpers')
  const { selfCheck } = require('../scripts/lib-net')
  const { resync, missingReplicas } = require('../scripts/lib-ops')
  const HUB = 'baseSepolia'
  const OP = 'optimismSepolia'
  let deployer, endpoint, profile, providers
  const state = () => loadState(profile.stateFile)
  const run = async (net) => {
    const ctx = await deployNet({ profile, netKey: net, signer: deployer, dry: false, preflight: false, providers, log: quiet })
    const adapter = state()[net]?.adapter
    if (adapter && (await endpoint.eidOfAdapter(adapter)) === 0n) {
      await (await endpoint.registerAdapter(adapter, profile.nets[net].eid)).wait()
    }
    return ctx
  }
  const deliverAll = async () => {
    while ((await endpoint.pending()) > 0n) await (await endpoint.deliverAll(32)).wait()
  }

  before(async () => {
    ;[deployer] = await ethers.getSigners()
    endpoint = await ethers.deployContract('MockLZEndpointV2', [E('0.001')])
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-v71-'))
    const t = PROFILES.testnet
    profile = {
      ...t,
      nets: { [HUB]: { ...t.nets[HUB] }, [OP]: { ...t.nets[OP] } },
      endpoint: endpoint.target,
      stateFile: path.join(dir, 'state.json'),
      manifestFile: path.join(dir, 'manifest.json'),
      sponsored: false,
      returnUnit: E('0.002'),
      gasToHub: 6_000_000n,
      tank: { mode: 'fixed', hub: E('0.05'), spoke: 0n },
    }
    providers = { [HUB]: ethers.provider, [OP]: ethers.provider }
    await run(HUB)
    await run(OP)
    await run(HUB)
    await run(OP)
  })

  it('a leg that refuses its SYNC: the launch still succeeds, status lists the token, resync repairs it', async () => {
    const s = state()
    const hubAdapter = await ethers.getContractAt('LayerZeroOmniMessenger', s[HUB].adapter)
    const hubGw = await ethers.getContractAt('SpawnGateway', s[HUB].gateway)
    const opGw = await ethers.getContractAt('SpawnGateway', s[OP].gateway)
    const pad = await ethers.getContractAt('SpawnPad', s[HUB].pad)
    const label = profile.nets[OP].label
    const gas = await hubAdapter.gasLimit(label)

    // break the leg the reversible way: no executor gas → the send reverts
    await (await hubAdapter.setDestination(label, 0, 0)).wait()
    const fee = await hubGw.quoteSpawn('Dead Leg', 'DEAD', '{}', false)
    const rc = await (await hubGw.spawnToken('Dead Leg', 'DEAD', '{}', 0, 1, { value: fee })).wait()
    const failed = rc.logs.map((l) => { try { return pad.interface.parseLog(l) } catch { return null } }).filter((e) => e?.name === 'SyncFailed')
    expect(failed).to.have.length(1)
    expect(failed[0].args.chain).to.equal(BigInt(label))
    const token = await pad.allTokens((await pad.tokensLength()) - 1n)
    // born on the hub chain, missing on the spoke
    expect(await hubGw.replicaOf(token)).to.not.equal(ethers.ZeroAddress)
    expect(await opGw.replicaOf(token)).to.equal(ethers.ZeroAddress)

    // fresh: listed, but as possibly in flight — not yet a warning
    let st = await status({ profile, providers, log: quiet })
    expect(st.missing.map((m) => [m.token, m.net, m.fresh])).to.deep.equal([[token, OP, true]])
    expect(st.warnings.filter((w) => w.includes('no replica'))).to.deep.equal([])
    // ten minutes on, it is a finding
    await time.increase(601)
    const lines = []
    st = await status({ profile, providers, log: (l) => lines.push(l) })
    expect(st.missing[0].fresh).to.equal(false)
    expect(st.warnings.some((w) => w.includes('have no replica'))).to.equal(true)
    expect(lines.some((l) => l.includes(token) && l.includes(`no replica on ${OP}`))).to.equal(true)

    // while the leg is still broken, resync says so and sends nothing
    let out = await resync({ profile, netKey: HUB, signer: deployer, token: 'missing', apply: true, providers, log: quiet })
    expect(out).to.have.length(1)
    expect(out[0].sent).to.equal(false)
    expect(out[0].error).to.equal('leg')
    // on the wrong network, or by a stranger: refused / calldata only
    await expect(resync({ profile, netKey: OP, signer: deployer, token: 'missing', providers, log: quiet })).to.be.rejectedWith(/sent on the hub/)
    const [, stranger] = await ethers.getSigners()
    await (await hubAdapter.setDestination(label, gas, 0)).wait() // the leg is repaired
    out = await resync({ profile, netKey: HUB, signer: stranger, token: 'missing', apply: true, providers, log: quiet })
    expect(out[0].sent).to.equal(false)
    // (v7.2: anyone may resync — by paying for the message; with nothing attached it is refused)
    await expect(pad.connect(stranger).resync(token, label)).to.be.revertedWith('PAD: fee')
    // shown first (nothing sent), then applied by the operator
    out = await resync({ profile, netKey: HUB, signer: deployer, token: 'missing', providers, log: quiet })
    expect(out[0].sent).to.equal(false)
    expect(out[0].fee).to.be.gt(0n)
    const tank0 = await ethers.provider.getBalance(s[HUB].adapter)
    out = await resync({ profile, netKey: HUB, signer: deployer, token, chain: OP, apply: true, providers, log: quiet })
    expect(out[0].sent).to.equal(true)
    expect(tank0 - (await ethers.provider.getBalance(s[HUB].adapter))).to.equal(out[0].fee) // the hub tank paid
    await deliverAll()
    expect(await opGw.replicaOf(token)).to.not.equal(ethers.ZeroAddress)
    expect(await missingReplicas({ profile, providers })).to.deep.equal([])
    st = await status({ profile, providers, log: quiet })
    expect(st.missing).to.deep.equal([])
    // a second SYNC for a replica that exists is ignored: resync is safe to repeat
    const rep = await opGw.replicaOf(token)
    await (await pad.resync(token, label)).wait()
    await deliverAll()
    expect(await opGw.replicaOf(token)).to.equal(rep)
  })

  it('a REMOTE gateway at tradeLegs = 0 fails the self-check hard — and the next deploy run puts it back', async () => {
    const s = state()
    const opGw = await ethers.getContractAt('SpawnGateway', s[OP].gateway)
    await (await opGw.setLegs(0, await opGw.spawnLegs())).wait()
    const check = await selfCheck({ profile, netKey: OP, provider: ethers.provider, log: quiet })
    expect(check.ok).to.equal(false)
    expect(check.hard.map((r) => r.what).join()).to.include('gateway.tradeLegs ≥ 1 on a REMOTE gateway')
    // the hub's own gateway is the opposite: 0 is right there (its reply is a free local call)
    const hubCheck = await selfCheck({ profile, netKey: HUB, provider: ethers.provider, log: quiet })
    expect(hubCheck.ok).to.equal(true)
    const fixed = await run(OP)
    expect(await opGw.tradeLegs()).to.equal(1n)
    expect(fixed.check.ok).to.equal(true)
  })
})
