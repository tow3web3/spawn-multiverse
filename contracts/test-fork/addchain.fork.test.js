/**
 * After `add-chain.sh <net> prepare` + 48h + `finish` ran on forks of the
 * LIVE chains (scripts/fork-addchain.js starts the forks, runs the wrapper,
 * then this file against the Base fork): the REAL deployed pad now SYNCs the
 * new chain on every spawn, the chains that were already live are untouched,
 * the hub-bound gas limit still covers the worst spawn, and what the new
 * chain costs every launch is measured — at today's L1 gas and at 5 and 30
 * gwei, by moving LayerZero's own price feed on the fork.
 *
 *   node scripts/fork-addchain.js ethereum
 */
const { expect } = require('chai')
const fs = require('fs')
const { ethers } = require('hardhat')
const { PROFILES, hubGasFor } = require('../config/profiles')
const { loadState, b32, same } = require('../scripts/lib-net')
const { verifyDvn } = require('../scripts/lib-dvn')
const { SAMPLE_SYNC, SAMPLE_DELIVER } = require('../scripts/lib-ops')
const h = require('./helpers')

const { U, E, OP } = h
const NEW = process.env.ADDCHAIN_NEW ?? 'ethereum'

describe(`the live deployment, after ${NEW} was added through the timelocks (forks)`, function () {
  this.timeout(900_000)
  const profile = PROFILES.mainnet
  const hubKey = profile.hub
  const cfg = profile.nets[hubKey]
  const neu = profile.nets[NEW]
  let all, S, N
  let pad, adapter, gateway, vault, usdc
  let creator, trader
  const report = {}
  const remote = (net) => new ethers.JsonRpcProvider(profile.nets[net].rpc, profile.nets[net].chainId, { staticNetwork: true })
  const spokes = () => Object.keys(all).filter((n) => n !== hubKey && all[n].gateway)

  before(async () => {
    expect(process.env.SPAWN_STATE_FILE, 'run through scripts/fork-addchain.js').to.be.a('string')
    all = loadState(profile.stateFile)
    S = all[hubKey]
    N = all[NEW]
    expect(N?.gateway, `${NEW} deployed by the wrapper`).to.be.a('string')
    ;[, creator, trader] = await ethers.getSigners()
    pad = await ethers.getContractAt('SpawnPad', S.pad)
    adapter = await ethers.getContractAt('LayerZeroOmniMessenger', S.adapter)
    gateway = await ethers.getContractAt('SpawnGateway', S.gateway)
    vault = await ethers.getContractAt('OmniUSD', S.localUsd)
    usdc = h.usdcAt(cfg)
  })

  after(() => {
    if (process.env.FORK_REPORT) {
      fs.writeFileSync(
        process.env.FORK_REPORT,
        JSON.stringify(report, (k, v) => (typeof v === 'bigint' ? ethers.formatEther(v) : v), 2),
      )
    }
  })

  it('the LIVE hub is wired to the new chain: route, gateway, CCTP peer, verifier set — and the newcomer is handed over', async () => {
    expect(await adapter.eidOf(neu.label)).to.equal(BigInt(neu.eid))
    expect(await adapter.peers(neu.eid)).to.equal(b32(N.adapter))
    expect(await adapter.gasLimit(neu.label)).to.equal(neu.gasToSpoke ?? profile.gasToSpoke)
    expect(await pad.gateways(neu.label)).to.equal(b32(N.gateway))
    expect(await pad.autoDrop(neu.label)).to.equal(false)
    const peer = await vault.peers(neu.label)
    expect(peer.vault).to.equal(b32(N.usd))
    expect(peer.domain).to.equal(BigInt(neu.cctpDomain))
    // every pathway, both ends, read from the forks of each chain
    const v = await verifyDvn({ profile, log: h.quiet })
    expect(v.rows.length).to.equal(spokes().length * 2)
    expect(v.ok, JSON.stringify(v.rows.filter((r) => !r.match || !r.planned))).to.equal(true)

    // the operations are recorded as executed, and nothing is left on the hub timelock
    expect(S.ops.every((o) => o.status === 'executed')).to.equal(true)
    const timelock = await ethers.getContractAt('SpawnTimelock', S.timelock)
    for (const o of S.ops) expect(await timelock.isOperationDone(o.id)).to.equal(true)

    // the new spoke, on ITS fork: open, capped, answering to its own 48h timelock
    const p = remote(NEW)
    const gw = await ethers.getContractAt('SpawnGateway', N.gateway, p)
    const nv = await ethers.getContractAt('OmniUSD', N.usd, p)
    const tl = await ethers.getContractAt('SpawnTimelock', N.timelock, p)
    expect(await gw.paused()).to.equal(false)
    expect(await nv.depositCap()).to.equal(U(25_000))
    expect(await gw.admin()).to.equal(N.timelock)
    expect(await tl.getMinDelay()).to.equal(BigInt(48 * 3600))
    expect(same(await gw.operator(), S.handover.operator)).to.equal(true)
    expect(await tl.hasRole(await tl.PROPOSER_ROLE(), S.handover.owner)).to.equal(true)
    for (const net of spokes()) {
      if (net === NEW) continue
      expect((await nv.peers(profile.nets[net].label)).vault, `${NEW} vault peer ${net}`).to.equal(b32(all[net].usd))
    }
    expect((await nv.peers(cfg.label)).vault).to.equal(b32(S.localUsd))
  })

  it('a launch from Base now SYNCs every chain, the new one included, and is fully prepaid by the creator', async () => {
    const n = spokes().length
    const fee = await gateway.quoteSpawn('ADDED CHAIN', 'ADD', '{"image":"/img/x"}', false)
    const tank0 = await ethers.provider.getBalance(S.adapter)
    const before = await pad.tokensLength()
    const rc = await (await gateway.connect(creator).spawnToken('ADDED CHAIN', 'ADD', '{"image":"/img/x"}', 0, 0, { value: fee })).wait()
    expect(await pad.tokensLength()).to.equal(before + 1n)
    const packets = h.packetsSent(profile, rc)
    expect(packets.length).to.equal(n) // one SYNC per remote chain
    const tankDelta = (await ethers.provider.getBalance(S.adapter)) - tank0
    expect(tankDelta, 'the launch fee covers its own fan-out').to.be.gte(0n)
    report.launchFromBase = { fee, tankDelta, syncs: n, gas: rc.gasUsed.toString() }
    report.token = await pad.allTokens(before)
  })

  it('trading on the chains that were already live is untouched: a Base buy and sell in real USDC, an Optimism buy answered', async () => {
    const token = report.token
    await ethers.provider.send('evm_increaseTime', [700]) // past FAIR GENESIS
    await ethers.provider.send('evm_mine', [])
    await h.mintUsdc(cfg, trader.address, U(40))
    await (await usdc.connect(trader).approve(vault.target, U(20))).wait()
    const held0 = await usdc.balanceOf(vault.target)
    await (await gateway.connect(trader).buyTokenUsdc(token, U(20), { value: await gateway.quoteBuy() })).wait()
    const replica = await ethers.getContractAt('SpawnToken', await gateway.replicaOf(token))
    const bag = await replica.balanceOf(trader.address)
    expect(bag).to.be.gt(0n)
    expect(await usdc.balanceOf(vault.target)).to.equal(held0 + U(20))
    const usdc0 = await usdc.balanceOf(trader.address)
    await (await gateway.connect(trader).sellToken(token, bag / 2n, { value: await gateway.quoteSell() })).wait()
    expect(await usdc.balanceOf(trader.address)).to.be.gt(usdc0)

    // a buy arriving from Optimism (delivered as the executor would): the hub answers with ONE packet, to Optimism
    const op = profile.nets.optimism
    const opState = all.optimism
    const opAdapter = await ethers.getContractAt('LayerZeroOmniMessenger', opState.adapter, remote('optimism'))
    const unit = await opAdapter.returnUnit(0)
    const rc = await h.lzDeliver(profile, adapter, {
      srcEid: op.eid, srcAdapter: opState.adapter, srcSender: opState.gateway, dst: S.pad,
      data: h.encodeTrade('BUY', b32(token), b32(h.fakeAddr('op/buyer')), E(5)),
      value: unit, nonce: 901,
    })
    const out = h.packetsSent(profile, rc)
    expect(out.length).to.equal(1)
    expect(await pad.supplyByChain(token, op.label)).to.be.gt(0n)
  })

  it('the hub-bound gas limit still covers the WORST spawn a spoke can send, with the new chain count', async () => {
    const op = profile.nets.optimism
    const opState = all.optimism
    const p = remote('optimism')
    const opAdapter = await ethers.getContractAt('LayerZeroOmniMessenger', opState.adapter, p)
    const opGw = await ethers.getContractAt('SpawnGateway', opState.gateway, p)
    const n = spokes().length
    const limit = await opAdapter.gasLimit(0)
    const unit = await opAdapter.returnUnit(0)
    const legs = (await opGw.spawnLegs()) + (await opGw.tradeLegs())
    // worst case the gateway admits: 64 / 16 / 1024 bytes, with a dev buy
    const rc = await h.lzDeliver(profile, adapter, {
      srcEid: op.eid, srcAdapter: opState.adapter, srcSender: opState.gateway, dst: S.pad,
      data: h.payload(
        OP.SPAWN,
        ['bytes32', 'string', 'string', 'string', 'uint256', 'uint8'],
        [b32(h.fakeAddr('op/creator')), 'W'.repeat(64), 'X'.repeat(16), 'm'.repeat(1024), E(100), 0],
      ),
      value: unit * legs, nonce: 902,
    })
    expect(h.packetsSent(profile, rc).length).to.equal(n + 1) // every SYNC + the DELIVER of the dev bag
    report.worstSpawn = { remoteSpokes: n, gas: rc.gasUsed.toString(), limitOnOptimism: limit.toString(), configured: hubGasFor(profile, n).toString() }
    // what the spoke buys (on chain, on its fork) and what the config says must both cover it with 10% to spare
    expect((rc.gasUsed * 110n) / 100n, 'on-chain hub-bound gas limit on Optimism').to.be.lte(limit)
    expect((rc.gasUsed * 110n) / 100n, 'configured hub-bound gas').to.be.lte(hubGasFor(profile, n))
    // and the spawn was fully prepaid: legs × unit ≥ what the hub just paid
    const paid = h.packetsSent(profile, rc).length
    expect(paid).to.be.lte(Number(legs) + n) // sanity on the leg arithmetic
  })

  it('what the new chain costs: per SYNC, per reply, per launch — today and at higher L1 gas', async () => {
    const quoteAll = async () => {
      const out = { sync: {}, deliver: {} }
      for (const net of spokes()) {
        const c = profile.nets[net]
        out.sync[net] = await adapter.quote(c.label, b32(all[net].gateway), SAMPLE_SYNC, 0)
        out.deliver[net] = await adapter.quote(c.label, b32(all[net].gateway), SAMPLE_DELIVER, 0)
      }
      const sum = Object.values(out.sync).reduce((a, x) => a + x, 0n)
      out.launchFromBase = (sum * 125n) / 100n // what tune-fees makes a local launch prepay
      out.launchWithoutNew = ((sum - out.sync[NEW]) * 125n) / 100n
      return out
    }
    const feedAddr = await new ethers.Contract(
      await (async () => {
        const ep = new ethers.Contract(profile.endpoint, ['function getSendLibrary(address,uint32) view returns (address)'], ethers.provider)
        const lib = await ep.getSendLibrary(S.adapter, neu.eid)
        const uln = new ethers.Contract(lib, ['function getExecutorConfig(address,uint32) view returns ((uint32 maxMessageSize,address executor))'], ethers.provider)
        return (await uln.getExecutorConfig(S.adapter, neu.eid)).executor
      })(),
      ['function priceFeed() view returns (address)'],
      ethers.provider,
    ).priceFeed()
    const feedAbi = [
      'function getPrice(uint32) view returns ((uint128 priceRatio,uint64 gasPriceInUnit,uint32 gasPerByte))',
      'function owner() view returns (address)',
      'function setPrice((uint32 eid,(uint128 priceRatio,uint64 gasPriceInUnit,uint32 gasPerByte) price)[] _price)',
    ]
    const feed = new ethers.Contract(feedAddr, feedAbi, ethers.provider)
    const key = neu.eid % 30000 // the feed is keyed by the v1-style id
    const now = await feed.getPrice(key)
    report.l1GasInFeed = ethers.formatUnits(now.gasPriceInUnit, 'gwei')
    const table = {}
    table[`today (${Number(report.l1GasInFeed).toFixed(3)} gwei)`] = await quoteAll()
    // the same quotes with LayerZero's own price feed told another L1 gas price
    const owner = await h.impersonate(await feed.owner())
    for (const gwei of [5, 30]) {
      await (
        await feed.connect(owner).setPrice([
          { eid: key, price: { priceRatio: now.priceRatio, gasPriceInUnit: ethers.parseUnits(String(gwei), 'gwei'), gasPerByte: now.gasPerByte } },
        ])
      ).wait()
      table[`${gwei} gwei`] = await quoteAll()
    }
    await (await feed.connect(owner).setPrice([{ eid: key, price: { priceRatio: now.priceRatio, gasPriceInUnit: now.gasPriceInUnit, gasPerByte: now.gasPerByte } }])).wait()
    report.costs = table
    const today = Object.values(table)[0]
    // the point of the table: the newcomer's SYNC, not the L2s', is what moves with L1 gas
    expect(table['30 gwei'].sync[NEW]).to.be.gt(today.sync[NEW])
    expect(table['30 gwei'].sync.optimism).to.equal(today.sync.optimism)
    console.log(`\n      ${NEW} leg — hub-side cost in ETH (our verifier set, real endpoint quotes on a Base fork)`)
    for (const [k, t] of Object.entries(table)) {
      console.log(
        `      L1 gas ${k.padEnd(22)} SYNC→${NEW} ${ethers.formatEther(t.sync[NEW])} | reply→${NEW} ${ethers.formatEther(t.deliver[NEW])}` +
          ` | launch from Base ${ethers.formatEther(t.launchFromBase)} (without ${NEW}: ${ethers.formatEther(t.launchWithoutNew)})`,
      )
    }
  })
})
