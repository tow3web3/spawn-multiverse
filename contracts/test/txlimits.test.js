const { expect } = require('chai')
const { ethers, network } = require('hardhat')
const { limits } = require('../scripts/lib-txlimits')

// scripts/lib-txlimits.js — installed by hardhat.config.js for every script.
describe('transaction time limits', () => {
  const saved = { ...limits }
  afterEach(async () => {
    Object.assign(limits, saved)
    await network.provider.send('evm_setAutomine', [true])
  })

  it('a transaction is sent, seen and mined as before', async () => {
    const [a, b] = await ethers.getSigners()
    const tx = await a.sendTransaction({ to: b.address, value: 1n })
    const receipt = await tx.wait()
    expect(receipt.status).to.equal(1)
    expect(tx.hash).to.match(/^0x[0-9a-f]{64}$/)
  })

  it('a transaction the node never shows: the send gives up at its deadline, it does not poll for ever', async () => {
    const [a, b] = await ethers.getSigners()
    limits.seenMs = 300
    const provider = a.provider
    const getTransaction = provider.getTransaction
    let polls = 0
    provider.getTransaction = async () => {
      polls += 1
      return null // what a load-balanced RPC answers for a transaction it dropped
    }
    const started = Date.now()
    try {
      await expect(a.sendTransaction({ to: b.address, value: 1n })).to.be.rejectedWith(
        /accepted by the RPC but no node shows it after 0 s.*safe to run again/,
      )
    } finally {
      provider.getTransaction = getTransaction
    }
    expect(polls).to.be.greaterThan(1) // it did poll, as hardhat-ethers does
    expect(Date.now() - started).to.be.lessThan(5_000)
  })

  it('a transaction that is never mined: wait() gives up, and still works once it is mined', async () => {
    const [a, b] = await ethers.getSigners()
    await network.provider.send('evm_setAutomine', [false])
    const tx = await a.sendTransaction({ to: b.address, value: 1n }) // seen (pending), not mined
    limits.minedMs = 300
    let err
    try {
      await tx.wait()
    } catch (e) {
      err = e
    }
    expect(err, 'wait() must not hang').to.be.an('error')
    expect(err.code).to.equal('TIMEOUT')
    expect(err.message).to.match(/is not in a block after 0 s.*safe to run again/)

    Object.assign(limits, saved)
    await network.provider.send('evm_mine', [])
    expect((await tx.wait()).status).to.equal(1)
  })

  describe('an RPC that answers a contract creation with to: "" (bsc-rpc.publicnode.com)', () => {
    let restore
    let answers
    beforeEach(() => {
      const inner = ethers.provider._hardhatProvider
      const send = inner.send
      answers = 0
      inner.send = async function (method, params) {
        const result = await send.call(this, method, params)
        if (method === 'eth_getTransactionByHash' && result && result.to === null) {
          answers += 1
          return { ...result, to: '' } // the shape that RPC gives, pending and mined
        }
        return result
      }
      restore = () => {
        inner.send = send
      }
    })
    afterEach(() => restore())

    it('a deploy is read as a deploy: it does not fail after it was mined', async () => {
      const [a] = await ethers.getSigners()
      const factory = new ethers.ContractFactory([], '0x00', a) // creation code: STOP
      const before = await ethers.provider.getTransactionCount(a.address)
      const c = await factory.deploy()
      const receipt = await c.deploymentTransaction().wait()
      expect(receipt.status).to.equal(1)
      expect(receipt.contractAddress).to.equal(c.target)
      expect(c.deploymentTransaction().to).to.equal(null)
      expect(answers).to.be.greaterThan(0) // the odd answer really was served
      // ONE transaction, not one per attempt: what cost eight orphans on BNB Chain
      expect(await ethers.provider.getTransactionCount(a.address)).to.equal(before + 1)
    })

    it('looking a creation up by its hash works too, and an ordinary call is untouched', async () => {
      const [a, b] = await ethers.getSigners()
      const c = await new ethers.ContractFactory([], '0x00', a).deploy()
      const created = await ethers.provider.getTransaction(c.deploymentTransaction().hash)
      expect(created.to).to.equal(null)
      const call = await a.sendTransaction({ to: b.address, value: 1n })
      expect((await ethers.provider.getTransaction(call.hash)).to).to.equal(b.address)
    })
  })

  it('an explicit timeout still wins over the default', async () => {
    const [a, b] = await ethers.getSigners()
    await network.provider.send('evm_setAutomine', [false])
    const tx = await a.sendTransaction({ to: b.address, value: 1n })
    limits.minedMs = 60_000
    const started = Date.now()
    let err
    try {
      await tx.wait(1, 200)
    } catch (e) {
      err = e
    }
    expect(err?.code).to.equal('TIMEOUT')
    expect(Date.now() - started).to.be.lessThan(5_000)
    await network.provider.send('evm_mine', [])
  })
})
