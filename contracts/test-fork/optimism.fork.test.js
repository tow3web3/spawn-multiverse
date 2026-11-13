/**
 * OPTIMISM MAINNET FORK — a spoke, deployed by the REAL deploy script
 * against the real LayerZero EndpointV2, the real USDC and the real CCTP V2.
 *
 *   node scripts/fork-run.js optimism
 *
 * The hub lives on another chain, so it is a stand-in address in the state
 * file; what the hub would send is delivered by impersonating the endpoint —
 * the same call the executor makes. Everything happens in anvil's memory.
 */
const { expect } = require('chai')
const { ethers, network } = require('hardhat')
const { deployNet, loadState, b32, ENDPOINT_ABI } = require('../scripts/lib-net')
const { configureDvn } = require('../scripts/lib-dvn')
const h = require('./helpers')
const { U, E, SCALE, OP } = h

const run = process.env.FORK === 'optimism' && network.name === 'fork' ? describe : describe.skip

run('Optimism mainnet fork — a spoke over the real endpoint and real USDC', function () {
  this.timeout(900_000)

  let profile, cfg, hubCfg, deployer, user, other
  let S, hub, adapter, vault, gateway, dist, usdc, endpoint
  const token = h.fakeAddr('hub/token/1') // a hub token id (the hub is elsewhere)
  let replica
  let nonce = 1
  const report = {}

  const state = () => loadState(profile.stateFile)
  const tank = () => ethers.provider.getBalance(adapter.target)
  /** A message from the pad, delivered as the executor would. */
  const fromHub = (data, value = 0n) =>
    h.lzDeliver(profile, adapter, {
      srcEid: hubCfg.eid,
      srcAdapter: hub.adapter,
      srcSender: hub.pad,
      dst: S.gateway,
      data,
      value,
      nonce: nonce++,
    })

  before(async () => {
    ;[deployer, user, other] = await ethers.getSigners()
    profile = h.forkProfile()
    cfg = profile.nets.optimism
    hubCfg = profile.nets.base
    endpoint = new ethers.Contract(profile.endpoint, ENDPOINT_ABI, ethers.provider)
    usdc = h.usdcAt(cfg)
    expect(Number((await ethers.provider.getNetwork()).chainId)).to.equal(10)
  })

  it('refuses to deploy a spoke before its hub; then the real script deploys and wires it; a re-run sends nothing', async () => {
    await expect(
      deployNet({ profile, netKey: 'optimism', signer: deployer, dry: false, log: h.quiet }),
    ).to.be.rejectedWith(/deploy the hub first/)

    hub = h.injectRemote(profile, 'base')
    h.injectRemote(profile, 'arbitrum') // a sibling spoke: a CCTP peer, and one more SYNC per spawn
    const first = await deployNet({ profile, netKey: 'optimism', signer: deployer, dry: false, log: h.quiet })
    expect(first.check.ok).to.equal(true)
    report.deployGas = first.gas.used
    report.deployTxs = first.gas.txs
    const again = await deployNet({ profile, netKey: 'optimism', signer: deployer, dry: false, log: h.quiet })
    expect(again.gas.txs).to.equal(0)
    expect(again.check.soft).to.deep.equal([])

    S = state().optimism
    expect(S.ready).to.equal(true) // only now may the hub wire this spoke
    adapter = await ethers.getContractAt('LayerZeroOmniMessenger', S.adapter)
    vault = await ethers.getContractAt('OmniUSD', S.usd)
    gateway = await ethers.getContractAt('SpawnGateway', S.gateway)
    dist = await ethers.getContractAt('FeeDistributor', S.dist)
    expect(await vault.usdc()).to.equal(cfg.usdc)
    expect(await gateway.pad()).to.equal(hub.pad)
    expect(await adapter.sponsored(S.gateway)).to.equal(false) // users pay
    expect(await gateway.tradeLegs()).to.equal(1n)
    expect(await gateway.spawnLegs()).to.equal(2n) // Optimism + Arbitrum
    expect(await tank()).to.equal(0n) // a spoke needs no tank: every send is paid in full
    // CCTP peers: the hub chain's vault and the sibling spoke's
    expect((await vault.peers(hubCfg.label)).vault).to.equal(b32(hub.localUsd))
    expect((await vault.peers(profile.nets.arbitrum.label)).vault).to.equal(b32(state().arbitrum.usd))
  })

  it('a SYNC from the hub deploys the replica; its gas sets the spoke-bound limit', async () => {
    const rc = await fromHub(h.payload(OP.SYNC, ['bytes32', 'string', 'string'], [b32(token), 'N'.repeat(64), 'S'.repeat(16)]))
    report.syncGas = rc.gasUsed
    replica = await ethers.getContractAt('SpawnToken', await gateway.replicaOf(token))
    expect(replica.target).to.not.equal(ethers.ZeroAddress)
    expect(rc.gasUsed * 125n / 100n).to.be.lte(profile.gasToSpoke)
    // a message that does not come from the configured hub adapter is refused
    await expect(
      h.lzDeliver(profile, adapter, {
        srcEid: hubCfg.eid, srcAdapter: h.fakeAddr('impostor'), srcSender: hub.pad, dst: S.gateway,
        data: h.payload(OP.PAYOUT, ['bytes32', 'uint256'], [b32(other.address), E(1_000)]), nonce: 99,
      }),
    ).to.be.revertedWith('LZM: not a peer')
    // …and one from the right adapter but not the pad is refused by the gateway
    await expect(
      h.lzDeliver(profile, adapter, {
        srcEid: hubCfg.eid, srcAdapter: hub.adapter, srcSender: h.fakeAddr('not/the/pad'), dst: S.gateway,
        data: h.payload(OP.PAYOUT, ['bytes32', 'uint256'], [b32(other.address), E(1_000)]), nonce: 98,
      }),
    ).to.be.revertedWith('GW: not the pad')
  })

  it('buyTokenUsdc: real USDC into the vault, a real packet out with the reply budget, paid in full by the user', async () => {
    await h.mintUsdc(cfg, user.address, U(500))
    await (await usdc.connect(user).approve(vault.target, U(100))).wait()
    const fee = await gateway.quoteBuy()
    report.buyFeeDefaultDvn = fee
    expect(fee).to.be.gt(profile.returnUnit) // the send + the prepaid reply

    // one wei short: the whole call reverts, nothing is pulled
    await expect(gateway.connect(user).buyTokenUsdc(token, U(100), { value: fee - 1n })).to.be.revertedWith('LZM: fee')
    expect(await usdc.balanceOf(user.address)).to.equal(U(500))

    const eth0 = await ethers.provider.getBalance(user.address)
    const rc = await (await gateway.connect(user).buyTokenUsdc(token, U(100), { value: fee })).wait()
    report.buyGas = rc.gasUsed
    expect(await usdc.balanceOf(user.address)).to.equal(U(400))
    expect(await usdc.balanceOf(vault.target)).to.equal(U(100))
    expect(await vault.totalSupply()).to.equal(0n) // the value rides the message, no oUSD minted
    expect(await tank()).to.equal(0n) // nothing subsidised, nothing left behind

    const [packet] = h.packetsSent(profile, rc)
    // 33-byte executor option: hub gas + the reply budget delivered to the hub tank
    expect(packet.options).to.equal(
      ethers.solidityPacked(
        ['uint16', 'uint8', 'uint16', 'uint8', 'uint128', 'uint128'],
        [3, 1, 33, 1, profile.gasToHub, profile.returnUnit],
      ),
    )
    const [routed] = h.eventsOf(adapter, rc, 'Routed')
    expect(routed.args.nativeFee).to.equal(fee)
    expect(routed.args.valueForwarded).to.equal(profile.returnUnit)
    const spent = eth0 - (await ethers.provider.getBalance(user.address))
    expect(spent).to.be.gte(fee) // the fee + gas, out of the user's pocket
  })

  it('a DELIVER and a PAYOUT from the hub settle in real USDC for the user', async () => {
    // the hub answers the buy: tokens, and a $10 refund (FAIR GENESIS clamp)
    const rc = await fromHub(
      h.payload(OP.DELIVER, ['bytes32', 'bytes32', 'uint256', 'uint256'], [b32(token), b32(user.address), E(1_000_000), E(10)]),
    )
    report.deliverGas = rc.gasUsed
    expect(await replica.balanceOf(user.address)).to.equal(E(1_000_000))
    expect(await usdc.balanceOf(user.address)).to.equal(U(410)) // the refund, as USDC
    expect(await usdc.balanceOf(vault.target)).to.equal(U(90))

    // the user sells: the replica burns here, a packet leaves, the PAYOUT comes home
    const sellFee = await gateway.quoteSell()
    const rc2 = await (await gateway.connect(user).sellToken(token, E(400_000), { value: sellFee })).wait()
    expect(h.packetsSent(profile, rc2).length).to.equal(1)
    expect(await replica.balanceOf(user.address)).to.equal(E(600_000))
    const rc3 = await fromHub(h.payload(OP.PAYOUT, ['bytes32', 'uint256'], [b32(user.address), E('25.5')]))
    report.payoutGas = rc3.gasUsed
    expect(await usdc.balanceOf(user.address)).to.equal(U('435.5'))
    expect(await usdc.balanceOf(vault.target)).to.equal(U('64.5'))
    expect(await vault.totalSupply()).to.equal(0n)

    // a payout the vault cannot cover becomes an oUSD claim instead of a revert
    await fromHub(h.payload(OP.PAYOUT, ['bytes32', 'uint256'], [b32(other.address), E(100)]))
    expect(await usdc.balanceOf(other.address)).to.equal(0n)
    expect(await vault.balanceOf(other.address)).to.equal(E(100))
    await expect(vault.connect(other).unwrap(E(100))).to.be.revertedWith('oUSD: vault short')
    // liquidity returns (as a CCTP rebalance would bring it): the claim redeems 1:1
    await h.mintUsdc(cfg, vault.target, U(50))
    await (await vault.connect(other).unwrap(E(100))).wait()
    expect(await usdc.balanceOf(other.address)).to.equal(U(100))
    // backing on this chain: vault USDC × 1e12 covers the local oUSD supply
    expect((await usdc.balanceOf(vault.target)) * SCALE).to.be.gte(await vault.totalSupply())
  })

  it('holder fees: a pull is a paid packet; the FEE_DROP lands in the local pool and is claimed and unwrapped to USDC', async () => {
    const fee = await gateway.quotePull()
    const rc = await (await gateway.connect(other).pullFees(token, { value: fee })).wait()
    expect(h.packetsSent(profile, rc).length).to.equal(1)
    // the hub burned this chain's slice from its books; value in flight
    // arrives with the message, and the vault must hold the dollars for it
    await h.mintUsdc(cfg, vault.target, U(6))
    const rc2 = await fromHub(h.payload(OP.FEE_DROP, ['bytes32', 'uint256'], [b32(token), E(6)]))
    report.feeDropGas = rc2.gasUsed
    const owed = await dist.withdrawable(replica.target, user.address)
    expect(owed).to.be.closeTo(E(6), E('0.000001')) // the only holder here
    await (await dist.connect(user).claim(replica.target)).wait()
    const before = await usdc.balanceOf(user.address)
    await (await vault.connect(user).unwrap(await vault.balanceOf(user.address))).wait()
    expect((await usdc.balanceOf(user.address)) - before).to.be.closeTo(U(6), 2n)
  })

  it('configure-dvn on the spoke: our verifier set on both libraries; a trade gets cheaper', async () => {
    const before = await gateway.quoteBuy()
    const res = await configureDvn({ profile, netKey: 'optimism', signer: deployer, log: h.quiet })
    expect(res.ok).to.equal(true)
    report.dvnGas = res.gasUsed
    expect(res.pathways.map((p) => p.remote)).to.deep.equal(['base'])
    const after = await gateway.quoteBuy()
    report.buyFeeOwnDvn = after
    expect(after).to.be.lt(before)
    expect(before - after).to.be.gt(E('0.0004')) // the default set's expensive verifier is gone
    expect((await configureDvn({ profile, netKey: 'optimism', signer: deployer, log: h.quiet })).txs).to.equal(0)
    // still sendable under the new set
    await (await usdc.connect(user).approve(vault.target, U(20))).wait()
    const rc = await (await gateway.connect(user).buyTokenUsdc(token, U(20), { value: after })).wait()
    expect(h.packetsSent(profile, rc).length).to.equal(1)
  })

  it('pause blocks new exposure only: buys stop, sells still leave', async () => {
    await (await gateway.pause()).wait()
    await (await usdc.connect(user).approve(vault.target, U(5))).wait()
    const fee = await gateway.quoteBuy()
    await expect(gateway.connect(user).buyTokenUsdc(token, U(5), { value: fee })).to.be.revertedWith('GW: paused')
    const rc = await (await gateway.connect(user).sellToken(token, E(1_000), { value: await gateway.quoteSell() })).wait()
    expect(h.packetsSent(profile, rc).length).to.equal(1)
    await (await gateway.unpause()).wait()
  })

  after(function () {
    if (!report.deployGas) return
    const f = (wei) => ethers.formatEther(wei)
    console.log('\n    ── Optimism fork measurements ──')
    console.log(`    spoke deploy: ${report.deployGas} gas in ${report.deployTxs} txs`)
    console.log(`    lzReceive on the spoke — SYNC (worst strings): ${report.syncGas} gas, DELIVER + refund: ${report.deliverGas}, PAYOUT: ${report.payoutGas}, FEE_DROP: ${report.feeDropGas}`)
    console.log(`    configured spoke-bound gas limit: ${profile.gasToSpoke}`)
    console.log(`    buyTokenUsdc (user tx, incl. the real endpoint send): ${report.buyGas} gas`)
    if (report.dvnGas) console.log(`    configure-dvn (1 pathway): ${report.dvnGas} gas`)
    if (report.buyFeeOwnDvn) {
      console.log(
        `    messaging fee of a buy from Optimism (send + ${f(profile.returnUnit)} ETH reply budget): ` +
          `${f(report.buyFeeDefaultDvn)} ETH on the default DVN set → ${f(report.buyFeeOwnDvn)} ETH on ours`,
      )
    }
  })
})
