/**
 * The organic on-chain market: bots that trade real transactions through the
 * gateways, forever. Run after deploy-local:
 *
 *   npm run bots
 */
const fs = require('fs')
const path = require('path')
const { ethers } = require('hardhat')

const E = (n) => ethers.parseEther(String(n))
const U = (n) => ethers.parseUnits(String(n), 6)
const rand = (lo, hi) => lo + Math.random() * (hi - lo)
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const manifestPath = path.join(__dirname, '..', '..', 'public', 'onchain', 'deployment.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  const signers = await ethers.getSigners()
  const bots = signers.slice(13, 19)
  const pad = await ethers.getContractAt('SpawnPad', manifest.pad)
  const chains = []
  for (const c of manifest.chains) {
    chains.push({
      ...c,
      gateway: await ethers.getContractAt('SpawnGateway', c.gateway),
      usd: await ethers.getContractAt('OmniUSD', c.usd),
      usdc: await ethers.getContractAt('MockUSDC', c.usdc),
    })
  }

  // v7: bots trade (mock) USDC through the vault, like any real user
  for (const c of chains) {
    for (const b of bots) {
      await (await c.usdc.mint(b.address, U(50_000))).wait()
      await (await c.usdc.connect(b).approve(c.usd.target, ethers.MaxUint256)).wait()
    }
  }

  async function buy(chain, bot, token, dollars) {
    const usdc = U(dollars.toFixed(2))
    if ((await chain.usdc.balanceOf(bot.address)) < usdc) {
      await (await chain.usdc.mint(bot.address, U(50_000))).wait()
    }
    await (await chain.gateway.connect(bot).buyTokenUsdc(token, usdc)).wait()
  }

  const replicaCache = new Map()
  async function replica(chain, token) {
    const key = `${chain.id}:${token}`
    if (!replicaCache.has(key)) {
      const addr = await chain.gateway.replicaOf(token)
      if (addr === ethers.ZeroAddress) return null
      replicaCache.set(key, await ethers.getContractAt('SpawnToken', addr))
    }
    return replicaCache.get(key)
  }

  console.log('Bots online — trading the multiverse. Ctrl+C to stop.')
  for (;;) {
    try {
      const len = Number(await pad.tokensLength())
      if (len > 0) {
        const token = await pad.allTokens(Math.floor(Math.random() * len))
        const chain = pick(chains)
        const bot = pick(bots)
        const wantBuy = Math.random() < 0.58

        if (!wantBuy) {
          const rep = await replica(chain, token)
          const bal = rep ? await rep.balanceOf(bot.address) : 0n
          if (bal > E(1000)) {
            const slice = (bal * BigInt(Math.floor(rand(10, 70)))) / 100n
            await (await chain.gateway.connect(bot).sellToken(token, slice)).wait()
            console.log(`SELL ${chain.id}`)
          } else {
            await buy(chain, bot, token, rand(5, 150))
            console.log(`BUY  ${chain.id}`)
          }
        } else {
          await buy(chain, bot, token, rand(5, 400))
          console.log(`BUY  ${chain.id}`)
        }
      }
    } catch (e) {
      console.error('bot trade failed:', e.shortMessage ?? e.message)
    }
    await sleep(rand(1200, 3000))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
