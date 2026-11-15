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
