const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ethers } = require('hardhat')
const { impersonateAccount, setBalance } = require('@nomicfoundation/hardhat-network-helpers')
const { PROFILES } = require('../config/profiles')
const { deployNet, loadState, b32 } = require('../scripts/lib-net')
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
