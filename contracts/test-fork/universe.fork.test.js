/**
 * SINGLE-CHAIN UNIVERSE ON ITS MAINNET FORK — the end state after the two
 * wrappers the owner pastes (scripts/launch.sh then scripts/finish.sh) ran
 * against an anvil fork of BNB Chain or Ethereum, acting as the real
 * deployer. Started by scripts/fork-universe.js, which hands over the fork,
 * the temp state file and the block the fork began at:
 *
 *   node scripts/fork-universe.js bnb
 *   node scripts/fork-universe.js ethereum
 *
 * Asserted here, over the real USDT / USDC and the real LayerZero endpoint:
 * not one PacketSent since the fork began; backing exact to the wei; every
 * admin = the owner's 48h timelock, the hot key operator + guardian; the
 * launch cap in the dollar's own units; the manifest the site codes
 * against; a stranger launches, buys (slippage-protected) and sells — and
 * what each costs in gas, against the profile's `actionGas` figures.
 */
const { expect } = require('chai')
const { ethers, network } = require('hardhat')
const { time } = require('@nomicfoundation/hardhat-network-helpers')
const fs = require('fs')
const { PROFILES, dollarUnits, dollarScale } = require('../config/profiles')
const { loadState, GENERATION, ENDPOINT_ABI } = require('../scripts/lib-net')
const { quoteBuy, quoteSell } = require('../scripts/lib-smoke')
const h = require('./helpers')

const name = process.env.FORK
const run = ['bnb', 'ethereum'].includes(name) && network.name === 'fork' && process.env.SPAWN_STATE_FILE ? describe : describe.skip

run(`${name} universe on its mainnet fork — after launch.sh and finish.sh`, function () {
  this.timeout(900_000)
  const profile = PROFILES[name]
  const NET = profile.hub
  const cfg = profile.nets[NET]
  const DEC = profile.dollar.decimals
  const SYM = profile.dollar.symbol
  const D = (n) => ethers.parseUnits(String(n), DEC)
  const DEPLOYER = ethers.getAddress(process.env.SPAWN_FORK_AS)
  let s, pad, gw, vault, ledger, adapter, dollar, timelock, stranger
  const gas = {}

  before(async () => {
    s = loadState(profile.stateFile)[NET]
    expect(s, `state for ${NET} in ${profile.stateFile}`).to.not.equal(undefined)
    ;[, stranger] = await ethers.getSigners() // an anvil dev account: a user
    pad = await ethers.getContractAt('SpawnPad', s.pad)
    gw = await ethers.getContractAt('SpawnGateway', s.gateway)
    vault = await ethers.getContractAt('OmniUSDLocal', s.localUsd)
    ledger = await ethers.getContractAt('OmniUSD', s.usd)
    adapter = await ethers.getContractAt('LayerZeroOmniMessenger', s.adapter)
    dollar = h.usdcAt(cfg)
    timelock = await ethers.getContractAt('SpawnTimelock', s.timelock)
  })

  it('is a deployment of the current generation on the right chain, over the real dollar and the real endpoint', async () => {
    expect(Number((await ethers.provider.getNetwork()).chainId)).to.equal(cfg.chainId)
    expect(s.transport).to.equal(GENERATION)
    expect(s.usdc).to.equal(cfg.usdc)
    expect(await dollar.symbol()).to.equal(SYM)
    expect(Number(await dollar.decimals())).to.equal(DEC)
    const endpoint = new ethers.Contract(profile.endpoint, ENDPOINT_ABI, ethers.provider)
    expect(Number(await endpoint.eid())).to.equal(cfg.eid)
    expect(await vault.usdc()).to.equal(cfg.usdc)
    expect(await vault.SCALE()).to.equal(dollarScale(profile))
    expect(await vault.chainLabel()).to.equal(BigInt(cfg.label))
  })

  it('nothing leaves this chain: one chain on the pad, no legs, every quote 0 — and not one PacketSent since the fork began', async () => {
    expect(await pad.chainsLength()).to.equal(1n)
    expect(await gw.tradeLegs()).to.equal(0n)
    expect(await gw.spawnLegs()).to.equal(0n)
    expect(await gw.quoteBuy()).to.equal(0n)
    expect(await gw.quoteSell()).to.equal(0n)
    expect(await gw.quoteSpawn('Name', 'SYM', '{}', true)).to.equal(0n)
    const topic = new ethers.Interface(ENDPOINT_ABI).getEvent('PacketSent').topicHash
    // only the blocks the fork mined itself: the fork block is the upstream's
    const logs = await ethers.provider.getLogs({
      address: profile.endpoint,
      topics: [topic],
      fromBlock: Number(process.env.FORK_START_BLOCK ?? 0) + 1,
      toBlock: 'latest',
    })
    expect(logs, 'PacketSent events from the real endpoint since the fork began').to.deep.equal([])
  })

  it('the canary ran: a token was launched, bought and sold here; backing is exact to the wei', async () => {
    expect(await pad.tokensLength()).to.be.gte(1n)
    const canary = await pad.allTokens(0)
    expect(await gw.replicaOf(canary)).to.not.equal(ethers.ZeroAddress)
    const held = (await dollar.balanceOf(vault.target)) * dollarScale(profile)
    const supply = (await vault.totalSupply()) + (await ledger.totalSupply())
    expect(held, `${SYM} in the vault must equal the oUSD it backs`).to.equal(supply)
    expect(held).to.be.gt(0n) // the canary's fees stayed as oUSD
  })

  it('handed over: every admin is the owner\'s 48h timelock, the hot key is operator + guardian and nothing more', async () => {
    expect(await timelock.getMinDelay()).to.equal(BigInt(profile.timelockDelay))
    for (const key of ['adapter', 'usd', 'pad', 'localUsd', 'gateway', 'localDist']) {
      const c = await ethers.getContractAt('Roles', s[key])
      expect(await c.admin(), `${key}.admin`).to.equal(timelock.target)
      expect(await c.operator(), `${key}.operator`).to.equal(DEPLOYER)
      expect(await c.guardian(), `${key}.guardian`).to.equal(DEPLOYER)
    }
    expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), DEPLOYER)).to.equal(false)
    expect(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), DEPLOYER)).to.equal(false)
    expect(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), DEPLOYER)).to.equal(false)
    if (process.env.SPAWN_FINISH_OWNER) {
      expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), process.env.SPAWN_FINISH_OWNER)).to.equal(true)
    }
    // the hot key cannot take the contracts back: an admin-only call is refused
    const hot = await h.impersonate(DEPLOYER)
    await expect(gw.connect(hot).transferAdmin(DEPLOYER)).to.be.revertedWith('ROLES: not admin')
    await expect(pad.connect(hot).transferAdmin(DEPLOYER)).to.be.revertedWith('ROLES: not admin')
  })

  it(`open: the launch cap is 25,000 ${SYM} in the token's own units; the manifest is what the site codes against`, async () => {
    expect(await vault.depositCap()).to.equal(dollarUnits(profile, 25_000))
    expect(await vault.depositCap()).to.equal(25_000n * 10n ** BigInt(DEC))
    const m = JSON.parse(fs.readFileSync(profile.manifestFile, 'utf8'))
    expect(m.network).to.equal('mainnet')
    expect(m.universe).to.equal(name)
    expect(m.dollar).to.deep.equal({ symbol: SYM, decimals: DEC })
    expect(m.chains).to.have.length(1)
    expect(m.chains[0]).to.include({ id: NET, chainId: cfg.chainId, local: true, usdc: cfg.usdc, usd: s.localUsd, gateway: s.gateway })
    expect(m.chains[0].depositCap).to.equal(String(25_000n * 10n ** BigInt(DEC)))
  })

  it('a stranger launches a token, is refused an impossible minimum, buys with a real minimum, sells — in one transaction each, for 0 messaging fee', async () => {
    await h.fundDollars(profile, cfg, stranger.address, D(50))
    const meta = JSON.stringify({ d: 'x'.repeat(560), i: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/0.png' })
    const g = gw.connect(stranger)
    let rc = await (await g.spawnToken('Fork Universe', 'FORK', meta, 0, 1)).wait()
    gas.launch = rc.gasUsed
    const token = await pad.allTokens((await pad.tokensLength()) - 1n)
    const replica = await ethers.getContractAt('SpawnToken', await gw.replicaOf(token))
    expect(replica.target).to.not.equal(ethers.ZeroAddress)
    await time.increase(700) // past FAIR GENESIS, so the full buy lands

    await (await dollar.connect(stranger).approve(vault.target, D(20))).wait()
    const d0 = await dollar.balanceOf(stranger.address)
    // the proof: a minimum no trade can meet is refused before any money moves
    await expect(g.buyTokenUsdcMin(token, D(10), ethers.parseEther('1000000000'))).to.be.revertedWith('GW: min out')
    expect(await dollar.balanceOf(stranger.address)).to.equal(d0)
    // a real minimum from the curve, 1% under the quote
    const quoted = await quoteBuy(pad, token, stranger.address, D(10) * dollarScale(profile))
    const minOut = (quoted * 99n) / 100n
    const now = (await ethers.provider.getBlock('latest')).timestamp
    const meta2 = await pad.metas(token)
    console.log(
      `      quote for $10: ${ethers.formatEther(quoted)} tokens; chain time ${now}, spawned ${meta2.spawnedAt} ` +
        `(${now - Number(meta2.spawnedAt)}s ago, window ${await pad.GENESIS_WINDOW()}s)`,
    )
    expect(minOut).to.be.gt(0n)
    // a fresh curve: $10 buys about a million tokens of the 1.073 B on it
    expect(quoted).to.be.gt(ethers.parseEther('100000'))
    rc = await (await g.buyTokenUsdcMin(token, D(10), minOut)).wait()
    gas.buy = rc.gasUsed
    const bag = await replica.balanceOf(stranger.address)
    if (bag < minOut) {
      for (const l of rc.logs) {
        for (const c of [gw, pad, vault]) {
          try {
            const e = c.interface.parseLog(l)
            if (e) console.log(`      event ${e.name}(${e.args.map(String).join(', ')})`)
          } catch {
            /* another contract's log */
          }
        }
      }
      console.log(`      parked: ${await gw.pendingDelivery(token, stranger.address)}`)
    }
    expect(bag).to.be.gte(minOut)
    expect(await dollar.balanceOf(stranger.address)).to.equal(d0 - D(10))

    const minUsd = ((await quoteSell(pad, token, bag / 2n)) * 99n) / 100n
    expect(minUsd).to.be.gt(0n)
    await expect(g.sellTokenMin(token, bag / 2n, ethers.parseEther('1000000000'))).to.be.revertedWith('GW: min out')
    // what the seller holds in this chain's dollars, 18 decimals: the dollar
    // token itself (the vault pays it out when it has the liquidity) plus
    // oUSD claims on it — the gateway's own measure for `*Min`
    const dollarsOf = async (who) => (await dollar.balanceOf(who)) * dollarScale(profile) + (await vault.balanceOf(who))
    const had = await dollarsOf(stranger.address)
    rc = await (await g.sellTokenMin(token, bag / 2n, minUsd)).wait()
    gas.sell = rc.gasUsed
    expect(await replica.balanceOf(stranger.address)).to.equal(bag - bag / 2n)
    expect((await dollarsOf(stranger.address)) - had).to.be.gte(minUsd)

    // still backed, still no packet
    const held = (await dollar.balanceOf(vault.target)) * dollarScale(profile)
    expect(held).to.equal((await vault.totalSupply()) + (await ledger.totalSupply()))
    expect(await pad.chainsLength()).to.equal(1n)
  })

  it('what it costs: the measured gas is within the profile\'s `actionGas` (what preflight prices at live gas), and the deploy within LIFE_GAS', async () => {
    const price = (await ethers.provider.getFeeData()).gasPrice
    const coin = profile.native
    const deployGas = BigInt(process.env.SPAWN_DEPLOY_GAS ?? 0)
    const handoverGas = BigInt(process.env.SPAWN_HANDOVER_GAS ?? 0)
    const canaryGas = BigInt(process.env.SPAWN_CANARY_GAS ?? 0)
    const { LIFE_GAS } = require('../scripts/lib-net')
    const life = LIFE_GAS.hub
    console.log(
      `\n      measured on the ${name} fork — a user: launch ${gas.launch} gas, buy ${gas.buy} gas, sell ${gas.sell} gas` +
        `\n      profile.actionGas = { launch: ${profile.actionGas.launch}, buy: ${profile.actionGas.buy}, sell: ${profile.actionGas.sell} }` +
        `\n      the deployer: deploy ${deployGas} gas, canary ${canaryGas} gas, hand-over + caps ${handoverGas} gas` +
        ` (LIFE_GAS.hub deploy ${life.deploy}, handover ${life.handover}); ${ethers.formatUnits(price, 'gwei')} gwei on the fork` +
        `\n      → the deploy at 1 gwei ${ethers.formatEther(deployGas * 10n ** 9n)} ${coin}, at 30 gwei ${ethers.formatEther(deployGas * 30n * 10n ** 9n)} ${coin}`,
    )
    for (const k of ['launch', 'buy', 'sell']) {
      expect(profile.actionGas[k], `actionGas.${k} must cover the measured ${gas[k]}`).to.be.gte(gas[k])
      expect(profile.actionGas[k], `actionGas.${k} must not overstate ${gas[k]} by more than 50%`).to.be.lte((gas[k] * 15n) / 10n)
    }
    if (deployGas) {
      // LIFE_GAS prices the preflight's budget row: it must cover what the
      // fork used, without overstating it — the single-chain hub deploys the
      // same contract set as the core hub (one gateway, no routes)
      expect(life.deploy, 'LIFE_GAS.hub.deploy must cover the deploy').to.be.gte(deployGas)
      expect(life.deploy, 'LIFE_GAS.hub.deploy must not overstate the deploy by more than 50%').to.be.lte((deployGas * 15n) / 10n)
      expect(life.handover, 'LIFE_GAS.hub.handover must cover the hand-over').to.be.gte(handoverGas)
    }
  })
})
