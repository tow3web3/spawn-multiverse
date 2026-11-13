/**
 * BASE MAINNET FORK — the hub, deployed by the REAL deploy script against
 * the real LayerZero EndpointV2, the real USDC and the real Circle CCTP V2.
 *
 *   node scripts/fork-run.js base
 *
 * Everything happens in memory (an anvil fork of Base at its latest block).
 * What a fork cannot show: a packet actually crossing to another chain, the
 * DVNs signing it, the executor delivering it. Inbound messages are
 * therefore delivered by impersonating the endpoint — the same call the
 * executor makes.
 */
const { expect } = require('chai')
const { ethers } = require('hardhat')
const { time, mine } = require('@nomicfoundation/hardhat-network-helpers')
const { deployNet, loadState, b32, CCTP_MESSENGER_ABI, ENDPOINT_ABI } = require('../scripts/lib-net')
const { configureDvn, verifyDvn, ULN_ABI, ENDPOINT_CFG_ABI, dvnAddresses } = require('../scripts/lib-dvn')
const { handover } = require('../scripts/lib-handover')
const { tuneFees } = require('../scripts/lib-ops')
const h = require('./helpers')
const { U, E, SCALE, OP } = h

const { network } = require('hardhat')
const run = process.env.FORK === 'base' && network.name === 'fork' ? describe : describe.skip

run('Base mainnet fork — the hub over the real endpoint, real USDC, real CCTP', function () {
  this.timeout(900_000)

  let profile, cfg, deployer, creator, trader, owner, guardian
  let S, pad, adapter, hubUsd, vault, gateway, dist, usdc, endpoint
  let token, replica
  const report = {}

  const state = () => loadState(profile.stateFile)
  const deploy = (extra = {}) =>
    deployNet({ profile, netKey: 'base', signer: deployer, dry: false, log: h.quiet, ...extra })
  const tank = () => ethers.provider.getBalance(adapter.target)
  /** Σ vault USDC (18 decimals) vs Σ oUSD supply. `remoteIn` is the value a
   * simulated REMOTE chain holds in its (absent) vault. */
  async function backing(remoteIn = 0n) {
    const held = (await usdc.balanceOf(vault.target)) * SCALE + remoteIn
    const supply = (await hubUsd.totalSupply()) + (await vault.totalSupply())
    return { held, supply }
  }
  const expectBacked = async (remoteIn = 0n) => {
    const b = await backing(remoteIn)
    expect(b.held, 'vault USDC must equal oUSD supply').to.equal(b.supply)
  }

  before(async () => {
    ;[deployer, creator, trader, owner, guardian] = await ethers.getSigners()
    profile = h.forkProfile()
    cfg = profile.nets.base
    endpoint = new ethers.Contract(profile.endpoint, ENDPOINT_ABI, ethers.provider)
    usdc = h.usdcAt(cfg)
    expect(Number((await ethers.provider.getNetwork()).chainId)).to.equal(8453)
  })

  it('a dry run sends nothing; the preflight re-derives every external address and refuses a lie', async () => {
    const nonce = await ethers.provider.getTransactionCount(deployer.address)
    const dry = await deployNet({ profile, netKey: 'base', signer: deployer, dry: true, log: h.quiet })
    expect(dry.preflight.ok).to.equal(true)
    expect(dry.preflight.rows.length).to.be.gte(7)
    expect(dry.plan.length).to.be.gt(20)
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce)
    expect(state()).to.deep.equal({})

    const lies = [
      // WETH is an ERC20 at a well-known predeploy — and not USDC
      { usdc: '0x4200000000000000000000000000000000000006' },
      // Optimism's CCTP domain on Base
      { cctpDomain: 2 },
      // Optimism's eid on Base
      { eid: 30111 },
      { chainId: 10 },
    ]
    for (const lie of lies) {
      const lying = { ...profile, nets: { ...profile.nets, base: { ...cfg, ...lie } } }
      await expect(
        deployNet({ profile: lying, netKey: 'base', signer: deployer, dry: false, log: h.quiet }),
      ).to.be.rejectedWith(/preflight failed/)
    }
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce)
    expect(state()).to.deep.equal({})
  })

  it('the real script deploys and wires the hub + its local gateway, then the spokes; a re-run sends nothing', async () => {
    const bal0 = await ethers.provider.getBalance(deployer.address)
    const first = await deploy()
    expect(first.check.ok).to.equal(true)
    report.hubDeployGas = first.gas.used
    report.hubDeployTxs = first.gas.txs

    // the spokes "deploy" on their own chains (stand-in addresses), then the
    // hub is re-run to wire them — exactly the runbook order
    h.injectRemote(profile, 'optimism')
    h.injectRemote(profile, 'arbitrum')
    const second = await deploy()
    expect(second.check.ok).to.equal(true)
    report.hubWireGas = second.gas.used
    report.hubCostEth = bal0 - (await ethers.provider.getBalance(deployer.address))

    const third = await deploy()
    expect(third.gas.txs).to.equal(0)
    expect(third.check.ok).to.equal(true)
    expect(third.check.soft).to.deep.equal([])

    S = state().base
    pad = await ethers.getContractAt('SpawnPad', S.pad)
    adapter = await ethers.getContractAt('LayerZeroOmniMessenger', S.adapter)
    hubUsd = await ethers.getContractAt('OmniUSD', S.usd)
    vault = await ethers.getContractAt('OmniUSD', S.localUsd)
    gateway = await ethers.getContractAt('SpawnGateway', S.gateway)
    dist = await ethers.getContractAt('FeeDistributor', S.localDist)

    // the real token and the real CCTP, never a mock
    expect(await vault.usdc()).to.equal(cfg.usdc)
    expect(await vault.tokenMessenger()).to.equal(cfg.tokenMessenger)
    expect(await vault.depositCap()).to.equal(U(25_000))
    expect(await adapter.sponsored(S.gateway)).to.equal(false)
    expect(await adapter.sponsored(S.pad)).to.equal(true)
    expect(await endpoint.delegates(S.adapter)).to.equal(deployer.address)
    expect(await tank()).to.equal(profile.tank.hub)
    // CCTP peers between every pair of vaults
    for (const net of ['optimism', 'arbitrum']) {
      const p = await vault.peers(profile.nets[net].label)
      expect(p.vault).to.equal(b32(state()[net].usd))
      expect(p.domain).to.equal(BigInt(profile.nets[net].cctpDomain))
    }
    // the manifest the frontend will read
    const manifest = second.manifest
    expect(manifest.network).to.equal('mainnet')
    expect(manifest.gasDrip).to.equal(undefined)
    expect(manifest.sponsored).to.equal(false)
    expect(manifest.chains.map((c) => c.id)).to.deep.equal(['base', 'optimism', 'arbitrum'])
    expect(manifest.chains[0]).to.include({ local: true, usdc: cfg.usdc, depositCap: String(U(25_000)) })
  })

  it('local spawn → buy → sell → holder fees → claim → unwrap settles in real USDC; the SYNC fan-out leaves through the real endpoint at the quoted fee', async () => {
    await h.mintUsdc(cfg, creator.address, U(1_000))
    await h.mintUsdc(cfg, trader.address, U(1_000))
    await (await usdc.connect(creator).approve(vault.target, U(50))).wait()
    await (await usdc.connect(trader).approve(vault.target, U(200))).wait()

    // what each remote SYNC will cost, quoted before the fact
    const NAME = 'FORK CREATURE'
    const SYM = 'FORK'
    const syncData = h.payload(OP.SYNC, ['bytes32', 'string', 'string'], [ethers.ZeroHash, NAME, SYM])
    const quotes = {}
    for (const net of ['optimism', 'arbitrum']) {
      quotes[net] = await adapter.quote(profile.nets[net].label, b32(state()[net].gateway), syncData, 0)
    }
    report.syncQuoteDefaultDvn = quotes.optimism

    // spawn with a $50 dev buy, in ONE local transaction
    const fee = await gateway.quoteSpawn(NAME, SYM, '{}', true)
    expect(fee).to.equal(profile.returnUnit * 2n) // 2 remote SYNCs, the local reply is free
    const tank0 = await tank()
    const tx = await gateway.connect(creator).spawnTokenUsdc(NAME, SYM, '{}', U(50), 0, { value: fee })
    const rc = await tx.wait()
    report.localSpawnGas = rc.gasUsed

    token = await pad.allTokens(0)
    replica = await ethers.getContractAt('SpawnToken', await gateway.replicaOf(token))
    expect(await replica.balanceOf(creator.address)).to.be.gt(0n) // the dev bag, same tx
    expect(await usdc.balanceOf(creator.address)).to.equal(U(950))

    // two real packets, each at exactly the quoted fee, paid out of the tank
    const packets = h.packetsSent(profile, rc)
    expect(packets.length).to.equal(2)
    const routed = h.eventsOf(adapter, rc, 'Routed').filter((e) => !e.args.local)
    expect(routed.map((e) => e.args.nativeFee)).to.deep.equal([quotes.optimism, quotes.arbitrum])
    expect(await tank()).to.equal(tank0 + fee - quotes.optimism - quotes.arbitrum)
    await expectBacked()

    // block 0 does not exist — on the real chain too
    await mine(1)
    const buyFee = await gateway.quoteBuy()
    expect(buyFee).to.equal(0n) // at home a trade needs no message
    await (await gateway.connect(trader).buyTokenUsdc(token, U(200))).wait()
    const bag = await replica.balanceOf(trader.address)
    expect(bag).to.be.gt(0n)
    expect(await usdc.balanceOf(trader.address)).to.equal(U(800))
    await expectBacked()

    // the snipe tax (holders mode) was dropped into the local pool at once
    const owedCreator = await dist.withdrawable(replica.target, creator.address)
    expect(owedCreator).to.be.gt(E(1))

    // sell half: the payout is real USDC, straight from the vault
    await (await gateway.connect(trader).sellToken(token, bag / 2n)).wait()
    expect(await usdc.balanceOf(trader.address)).to.be.gt(U(800))
    await expectBacked()

    // the holder claims locally and unwraps to real USDC
    await (await dist.connect(creator).claim(replica.target)).wait()
    const claimed = await vault.balanceOf(creator.address)
    expect(claimed).to.be.gte(owedCreator)
    await (await vault.connect(creator).unwrap(claimed)).wait()
    expect(await usdc.balanceOf(creator.address)).to.equal(U(950) + claimed / SCALE)
    await expectBacked()
  })

  it('a send that carries a reply budget: the 33-byte executor value option is accepted and priced by the real endpoint', async () => {
    const op = profile.nets.optimism
    const dst = b32(state().optimism.gateway)
    const data = h.payload(OP.PAYOUT, ['bytes32', 'uint256'], [b32(trader.address), E(1)])
    // a test-only sender on the hub adapter (the deployer is still admin)
    await (await adapter.register(deployer.address, 0)).wait()
    const unit = E('0.00005')
    await (await adapter.setDestination(op.label, profile.gasToSpoke, unit)).wait()

    const plain = await adapter.quote(op.label, dst, data, 0)
    const withBudget = await adapter.quote(op.label, dst, data, 1)
    // the executor charges for the native it will deliver over there
    expect(withBudget - plain).to.be.gte(unit)
    expect(withBudget - plain).to.be.lt(unit * 2n)
    report.valueOptionPremium = withBudget - plain - unit

    await expect(adapter.send(op.label, dst, data, 1, { value: withBudget - 1n })).to.be.revertedWith('LZM: fee')
    const tank0 = await tank()
    const rc = await (await adapter.send(op.label, dst, data, 1, { value: withBudget })).wait()
    const [packet] = h.packetsSent(profile, rc)
    // type 3, executor worker, 33-byte lzReceive option: gas + value
    const expected = ethers.solidityPacked(
      ['uint16', 'uint8', 'uint16', 'uint8', 'uint128', 'uint128'],
      [3, 1, 33, 1, profile.gasToSpoke, unit],
    )
    expect(packet.options).to.equal(expected)
    expect(await tank()).to.equal(tank0) // paid in full by the caller

    // and without a budget: the 17-byte form
    const rc2 = await (await adapter.send(op.label, dst, data, 0, { value: plain })).wait()
    expect(h.packetsSent(profile, rc2)[0].options).to.equal(
      ethers.solidityPacked(['uint16', 'uint8', 'uint16', 'uint8', 'uint128'], [3, 1, 17, 1, profile.gasToSpoke]),
    )

    await (await adapter.setDestination(op.label, profile.gasToSpoke, 0)).wait()
    await (await adapter.unregister(deployer.address)).wait()
  })

  it('an inbound message with msg.value: the budget lands in the hub tank and pays the reply', async () => {
    const op = profile.nets.optimism
    const remote = state().optimism
    const buyer = h.fakeAddr('op/buyer')
    const usdIn = E(40)
    const budget = profile.returnUnit
    const tank0 = await tank()
    const rc = await h.lzDeliver(profile, adapter, {
      srcEid: op.eid,
      srcAdapter: remote.adapter,
      srcSender: remote.gateway,
      dst: S.pad,
      data: h.payload(OP.BUY, ['bytes32', 'bytes32', 'uint256'], [b32(token), b32(buyer), usdIn]),
      value: budget,
    })
    report.hubBuyGas = rc.gasUsed
    // the pad bought on the one curve and answered with a DELIVER to Optimism
    expect(await pad.supplyByChain(token, op.label)).to.be.gt(0n)
    const [reply] = h.eventsOf(adapter, rc, 'Routed')
    expect(reply.args.dstEid).to.equal(BigInt(op.eid))
    expect(h.packetsSent(profile, rc).length).to.equal(1)
    expect(await tank()).to.equal(tank0 + budget - reply.args.nativeFee)
    // the dollars are in the (absent) Optimism vault: backing holds with them
    await expectBacked(usdIn)

    // a message from anyone but the configured peer is refused
    await expect(
      h.lzDeliver(profile, adapter, {
        srcEid: op.eid,
        srcAdapter: h.fakeAddr('not/the/peer'),
        srcSender: remote.gateway,
        dst: S.pad,
        data: h.payload(OP.BUY, ['bytes32', 'bytes32', 'uint256'], [b32(token), b32(buyer), usdIn]),
        nonce: 2,
      }),
    ).to.be.revertedWith('LZM: not a peer')
  })

  it('configure-dvn: our own verifier set, pinned libraries, read back — and the message price drops', async () => {
    const op = profile.nets.optimism
    const dst = b32(state().optimism.gateway)
    const data = h.payload(OP.DELIVER, ['bytes32', 'bytes32', 'uint256', 'uint256'], [b32(token), b32(trader.address), E(1), 0n])
    const before = await adapter.quote(op.label, dst, data, 0)

    const res = await configureDvn({ profile, netKey: 'base', signer: deployer, log: h.quiet })
    expect(res.ok).to.equal(true)
    expect(res.pathways.map((p) => p.remote)).to.deep.equal(['optimism', 'arbitrum'])
    report.dvnGas = res.gasUsed
    const after = await adapter.quote(op.label, dst, data, 0)
    report.replyQuoteDefaultDvn = before
    report.replyQuoteOwnDvn = after
    expect(after * 3n).to.be.lt(before) // one default verifier was ~80% of the price

    // what is effective on chain is the configured set, on both libraries
    const ep = new ethers.Contract(profile.endpoint, ENDPOINT_CFG_ABI, ethers.provider)
    for (const net of ['optimism', 'arbitrum']) {
      const eid = profile.nets[net].eid
      const sendLib = await ep.getSendLibrary(S.adapter, eid)
      const [recvLib, isDefault] = await ep.getReceiveLibrary(S.adapter, eid)
      expect(await ep.isDefaultSendLibrary(S.adapter, eid)).to.equal(false) // pinned
      expect(isDefault).to.equal(false)
      const send = await new ethers.Contract(sendLib, ULN_ABI, ethers.provider).getUlnConfig(S.adapter, eid)
      const recv = await new ethers.Contract(recvLib, ULN_ABI, ethers.provider).getUlnConfig(S.adapter, eid)
      expect([...send.requiredDVNs]).to.deep.equal(dvnAddresses(profile, 'base', profile.dvn.required))
      expect([...recv.requiredDVNs]).to.deep.equal(dvnAddresses(profile, 'base', profile.dvn.required))
      expect([...send.optionalDVNs]).to.deep.equal(dvnAddresses(profile, 'base', profile.dvn.optional))
      expect(Number(send.optionalDVNThreshold)).to.equal(profile.dvn.optionalThreshold)
      expect(send.confirmations).to.equal(BigInt(profile.nets.base.confirmations))
      expect(recv.confirmations).to.equal(BigInt(profile.nets[net].confirmations))
    }

    // idempotent
    const again = await configureDvn({ profile, netKey: 'base', signer: deployer, log: h.quiet })
    expect(again.txs).to.equal(0)

    // the cross-chain check (read-only; the spokes' ends are read from the
    // LIVE chains, where the stand-in adapters have configured nothing): our
    // end names the configured set, and an unconfigured far end is flagged —
    // the mismatch that would stall messages is caught before deposits open
    const v = await verifyDvn({ profile, providers: { base: ethers.provider }, log: h.quiet })
    expect(v.ok).to.equal(false)
    expect(v.rows.length).to.equal(4)
    const out = v.rows.find((r) => r.src === 'base' && r.dst === 'optimism')
    expect(out.sReq).to.deep.equal(['Google', 'LayerZero Labs'])
    expect(out.sOpt).to.deep.equal(['Horizen', 'Twinstake'])
    // the far end still rides LayerZero's default: four required verifiers,
    // one of them outside our set (shown by address)
    expect(out.rReq.length).to.equal(4)
    expect(out.rReq.filter((n) => n.startsWith('0x')).length).to.equal(1)
    expect(out.match).to.equal(false)

    // a real send still goes through under the new set
    await (await adapter.register(deployer.address, 0)).wait()
    const rc = await (await adapter.send(op.label, dst, data, 0, { value: after })).wait()
    expect(h.packetsSent(profile, rc).length).to.equal(1)
    await (await adapter.unregister(deployer.address)).wait()

    // tune-fees re-prices the local spawn fan-out from the LIVE quotes of the new set
    const syncData = h.payload(OP.SYNC, ['bytes32', 'string', 'string'], [ethers.ZeroHash, 'N'.repeat(64), 'S'.repeat(16)])
    const sum =
      (await adapter.quote(op.label, dst, syncData, 0)) +
      (await adapter.quote(profile.nets.arbitrum.label, b32(state().arbitrum.gateway), syncData, 0))
    const tuned = await tuneFees({ profile, netKey: 'base', signer: deployer, apply: true, log: h.quiet })
    expect(tuned.applied).to.equal(true)
    // the SUM of the SYNC quotes + 25%, spread over the 2 legs a local spawn prepays (rounded up)
    expect(await adapter.returnUnit(0)).to.equal((sum * 125n - 1n) / 200n + 1n)
    report.tunedUnit = await adapter.returnUnit(0)
    // a local spawn now prepays exactly its fan-out + the margin — and that covers it
    expect(await gateway.quoteSpawn('X', 'X', '{}', false)).to.equal(report.tunedUnit * 2n)
    expect(report.tunedUnit * 2n).to.be.gte((sum * 125n) / 100n)
  })

  it('measures the real gas of a remote-origin SPAWN on the hub (2 then 3 remote SYNCs) — the hub-bound gas limit', async () => {
    const op = profile.nets.optimism
    const remote = state().optimism
    const spawnFrom = async (name, symbol, meta, devBuy, nonce) => {
      const legs = BigInt(Number(await gateway.spawnLegs()) + (devBuy > 0n ? 1 : 0))
      const rc = await h.lzDeliver(profile, adapter, {
        srcEid: op.eid,
        srcAdapter: remote.adapter,
        srcSender: remote.gateway,
        dst: S.pad,
        data: h.payload(
          OP.SPAWN,
          ['bytes32', 'string', 'string', 'string', 'uint256', 'uint8'],
          [b32(h.fakeAddr('op/creator')), name, symbol, meta, devBuy, 0],
        ),
        value: profile.returnUnit * legs,
        nonce,
      })
      return { gas: rc.gasUsed, packets: h.packetsSent(profile, rc).length }
    }
    const before = await pad.tokensLength()
    // typical: short strings, no dev buy
    const typical2 = await spawnFrom('GAS PROBE', 'GAS', '{"image":"ipfs://x"}', 0n, 10)
    // worst case the gateway admits: 64 / 16 / 1024 bytes, with a dev buy
    const worst2 = await spawnFrom('N'.repeat(64), 'S'.repeat(16), 'm'.repeat(1024), E(100), 11)
    expect(typical2.packets).to.equal(2) // SYNC to Optimism + Arbitrum
    expect(worst2.packets).to.equal(3) // + the DELIVER of the dev bag
    expect(await pad.tokensLength()).to.equal(before + 2n)

    // a third remote spoke joins (Ethereum, off by default): same script
    profile.nets.ethereum.enabled = true
    h.injectRemote(profile, 'ethereum')
    const wired = await deploy()
    expect(wired.check.ok).to.equal(true)
    expect(await gateway.spawnLegs()).to.equal(3n)
    const dvn = await configureDvn({ profile, netKey: 'base', signer: deployer, log: h.quiet })
    expect(dvn.ok).to.equal(true)
    const typical3 = await spawnFrom('GAS PROBE 3', 'GAS3', '{"image":"ipfs://x"}', 0n, 12)
    const worst3 = await spawnFrom('M'.repeat(64), 'T'.repeat(16), 'n'.repeat(1024), E(100), 13)
    expect(typical3.packets).to.equal(3)
    expect(worst3.packets).to.equal(4)

    report.spawnGas = { typical2: typical2.gas, worst2: worst2.gas, typical3: typical3.gas, worst3: worst3.gas }
    // the configured hub-bound limit must cover the worst admitted spawn on
    // the launch topology (2 remote spokes) with ≥ 25% to spare, and still
    // cover a third spoke
    expect(worst2.gas * 125n / 100n).to.be.lte(profile.gasToHub)
    expect(worst3.gas).to.be.lte(profile.gasToHub)
  })

  it('rebalance burns through Circle CCTP V2 naming exactly the peer vault — and nothing else', async () => {
    const op = profile.nets.optimism
    const peerVault = state().optimism.usd
    const amount = U(25)
    const held0 = await usdc.balanceOf(vault.target)
    expect(held0).to.be.gte(amount)
    const rc = await (await vault.rebalance(op.label, amount)).wait()
    expect(await usdc.balanceOf(vault.target)).to.equal(held0 - amount)

    const tm = new ethers.Interface(CCTP_MESSENGER_ABI)
    const burns = rc.logs
      .filter((l) => l.address.toLowerCase() === cfg.tokenMessenger.toLowerCase())
      .map((l) => {
        try {
          return tm.parseLog(l)
        } catch {
          return null
        }
      })
      .filter((e) => e?.name === 'DepositForBurn')
    expect(burns.length).to.equal(1)
    const b = burns[0].args
    expect(b.burnToken).to.equal(cfg.usdc)
    expect(b.amount).to.equal(amount)
    expect(b.depositor).to.equal(vault.target)
    expect(b.mintRecipient).to.equal(b32(peerVault))
    expect(b.destinationDomain).to.equal(BigInt(op.cctpDomain))
    expect(b.destinationCaller).to.equal(ethers.ZeroHash) // anyone may relay
    expect(b.maxFee).to.equal(0n) // the peer receives exactly what was burned
    expect(b.minFinalityThreshold).to.equal(2000n) // Standard Transfer
    report.rebalanceTx = rc.hash

    // only to a peer, only by the operator
    await expect(vault.rebalance(99, amount)).to.be.revertedWith('oUSD: no peer')
    await expect(vault.connect(trader).rebalance(op.label, amount)).to.be.revertedWith('ROLES: not operator')
  })

  it('handover.js puts every contract behind a 48h timelock; afterwards a DVN change is calldata for the timelock, executable only after the delay', async () => {
    const res = await handover({
      profile, netKey: 'base', signer: deployer, owner: owner.address, guardian: guardian.address, log: h.quiet,
    })
    const timelock = res.timelock
    report.handoverGas = res.gasUsed
    expect(await timelock.getMinDelay()).to.equal(BigInt(48 * 3600))
    for (const key of ['adapter', 'usd', 'pad', 'localUsd', 'gateway', 'localDist']) {
      const c = await ethers.getContractAt('Roles', state().base[key])
      expect(await c.admin()).to.equal(timelock.target)
      expect(await c.operator()).to.equal(owner.address)
      expect(await c.guardian()).to.equal(guardian.address)
    }
    expect(await endpoint.delegates(S.adapter)).to.equal(timelock.target)
    await expect(adapter.register(deployer.address, 0)).to.be.revertedWith('ROLES: not admin')
    await expect(pad.setGateway(9, b32(deployer.address))).to.be.revertedWith('ROLES: not admin')
    expect(state().base.handover.timelock).to.equal(timelock.target)
    // idempotent
    await handover({ profile, netKey: 'base', signer: deployer, owner: owner.address, guardian: guardian.address, log: h.quiet })

    // the deploy script still runs: nothing left that needs the admin, and
    // nothing breaks (it may top the gas tank back up — anyone can)
    const rerun = await deploy()
    expect(rerun.blocked).to.deep.equal([])
    expect(rerun.check.ok).to.equal(true)

    // changing the verifier set is now the timelock's: the script sends
    // nothing and prints the calldata
    const changed = { ...profile, dvn: { ...profile.dvn, optional: [], optionalThreshold: 0 } }
    const res2 = await configureDvn({ profile: changed, netKey: 'base', signer: deployer, log: h.quiet })
    expect(res2.txs).to.equal(0)
    expect(res2.blocked.length).to.be.gte(2)

    const first = res2.blocked[0]
    const salt = ethers.id('fork/dvn-change')
    const DELAY = 48 * 3600
    // not the deployer, not with a shorter delay
    await expect(
      timelock.schedule(first.target, 0, first.data, ethers.ZeroHash, salt, DELAY),
    ).to.be.revertedWithCustomError(timelock, 'AccessControlUnauthorizedAccount')
    await expect(
      timelock.connect(owner).schedule(first.target, 0, first.data, ethers.ZeroHash, salt, 3600),
    ).to.be.revertedWithCustomError(timelock, 'TimelockInsufficientDelay')
    await (await timelock.connect(owner).schedule(first.target, 0, first.data, ethers.ZeroHash, salt, DELAY)).wait()
    await expect(
      timelock.connect(owner).execute(first.target, 0, first.data, ethers.ZeroHash, salt),
    ).to.be.revertedWithCustomError(timelock, 'TimelockUnexpectedOperationState')
    await time.increase(DELAY + 1)
    await (await timelock.connect(owner).execute(first.target, 0, first.data, ethers.ZeroHash, salt)).wait()

    // the operator (OWNER, directly) can still tune and unpause; the guardian can stop
    await (await pad.connect(guardian).pause()).wait()
    await expect(pad.connect(guardian).unpause()).to.be.revertedWith('ROLES: not operator')
    await (await pad.connect(owner).unpause()).wait()
  })

  after(function () {
    if (!report.hubDeployGas) return
    const f = (wei) => ethers.formatEther(wei)
    console.log('\n    ── Base fork measurements ──')
    console.log(`    hub deploy: ${report.hubDeployGas} gas in ${report.hubDeployTxs} txs; wiring 2 spokes: ${report.hubWireGas} gas`)
    console.log(`    hub deploy cost on the fork (incl. the ${f(profile.tank.hub)} ETH tank float): ${f(report.hubCostEth)} ETH`)
    console.log(`    local spawn + dev buy + 2 real SYNCs (whole tx): ${report.localSpawnGas} gas`)
    console.log(`    hub BUY from a spoke (lzReceive incl. the DELIVER reply): ${report.hubBuyGas} gas`)
    if (report.spawnGas) {
      const s = report.spawnGas
      console.log(`    hub SPAWN from a spoke, 2 remote SYNCs: typical ${s.typical2} gas, worst admitted ${s.worst2} gas`)
      console.log(`    hub SPAWN from a spoke, 3 remote SYNCs: typical ${s.typical3} gas, worst admitted ${s.worst3} gas`)
      console.log(`    configured hub-bound gas limit: ${profile.gasToHub}`)
    }
    if (report.syncQuoteDefaultDvn) console.log(`    SYNC hub→OP on LayerZero's default DVN set: ${f(report.syncQuoteDefaultDvn)} ETH`)
    if (report.replyQuoteOwnDvn) {
      console.log(`    reply hub→OP: ${f(report.replyQuoteDefaultDvn)} ETH (default set) → ${f(report.replyQuoteOwnDvn)} ETH (our set)`)
    }
    if (report.tunedUnit) console.log(`    tune-fees: local spawn fan-out budget ${f(profile.returnUnit)} → ${f(report.tunedUnit)} ETH per remote chain`)
    if (report.dvnGas) console.log(`    configure-dvn (2 pathways): ${report.dvnGas} gas; handover: ${report.handoverGas} gas`)
    if (report.valueOptionPremium !== undefined) console.log(`    executor premium on a 0.00005 ETH reply budget: ${f(report.valueOptionPremium)} ETH`)
  })
})
