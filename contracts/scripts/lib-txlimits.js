/**
 * Time limits on the two places where a hardhat script waits with none.
 *
 * 1. HardhatEthersSigner.sendTransaction (hardhat-ethers 3.1) sends, then
 *    polls eth_getTransactionByHash every 4 s UNTIL the node shows the
 *    transaction. A public RPC that accepts a transaction and then drops it
 *    never shows it, and the script polls for ever: on the mainnet launch of
 *    2026-11-15 the Ethereum deploy sat 45 minutes on a transaction no node
 *    had. Here: the same send and the same poll, with a deadline.
 * 2. TransactionResponse.wait() has no timeout unless one is passed. Here: a
 *    default one.
 *
 * Past either limit the step throws. launch.sh, finish.sh and the add-a-chain
 * scripts run a failed step again, and every step resumes: what is on chain
 * is read back, only what is missing is sent.
 *
 * Installed by hardhat.config.js, so it holds for every script and test.
 */
const { TransactionResponse } = require('ethers')
const { HardhatEthersSigner } = require('@nomicfoundation/hardhat-ethers/signers')

function ms(name, dflt) {
  const v = Number(process.env[name] ?? dflt)
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number of milliseconds`)
  return v
}

/** Mutable on purpose: the tests shorten them. */
const limits = {
  // from "the RPC took it" to "a node shows it": seconds on a healthy RPC
  seenMs: ms('SPAWN_TX_SEEN_MS', 180_000),
  // from "a node shows it" to "it is in a block"
  minedMs: ms('SPAWN_TX_MINED_MS', 300_000),
}

const sleep = (t) => new Promise((r) => setTimeout(r, t))
const secs = (t) => `${Math.round(t / 1000)} s`

function install() {
  const signer = HardhatEthersSigner.prototype
  if (signer.__spawnTxLimits) return
  if (typeof signer._sendUncheckedTransaction !== 'function' || typeof signer.sendTransaction !== 'function') {
    throw new Error('lib-txlimits: hardhat-ethers changed shape — re-read its sendTransaction before any launch')
  }

  // As hardhat-ethers 3.1.3 writes it (same send, same pauses), plus the deadline.
  signer.sendTransaction = async function (tx) {
    const blockNumber = await this.provider.getBlockNumber()
    const hash = await this._sendUncheckedTransaction(tx)
    const deadline = Date.now() + limits.seenMs
    const pauses = [100, 1000]
    for (;;) {
      const polled = await this.provider.getTransaction(hash)
      if (polled !== null) return polled.replaceableTransaction(blockNumber)
      if (Date.now() >= deadline) {
        throw new Error(
          `transaction ${hash} was accepted by the RPC but no node shows it after ${secs(limits.seenMs)}: ` +
            'dropped before it reached the network. Nothing was spent; the step is safe to run again.',
        )
      }
      await sleep(pauses.shift() ?? 4000)
    }
  }

  const wait = TransactionResponse.prototype.wait
  TransactionResponse.prototype.wait = async function (confirms, timeout) {
    try {
      return await wait.call(this, confirms, timeout ?? limits.minedMs)
    } catch (e) {
      if (e?.code !== 'TIMEOUT') throw e
      const err = new Error(
        `transaction ${this.hash} (nonce ${this.nonce}) is not in a block after ${secs(timeout ?? limits.minedMs)}: ` +
          'lost, or its fee is under the market. The step is safe to run again.',
        { cause: e },
      )
      err.code = 'TIMEOUT'
      throw err
    }
  }

  signer.__spawnTxLimits = true
}

module.exports = { install, limits }
