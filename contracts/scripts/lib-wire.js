/**
 * THE WIRE, in one place — every protocol payload and the inter-adapter
 * envelope as the contracts encode them (v7.2, final), for the tools
 * that build or read messages themselves: the codec-vector generator, the
 * fork relay, the fork suites.
 *
 *   payload  = abi.encode(uint8 op, bytes data)
 *   envelope = abi.encode(bytes32 srcSender, bytes32 dstAddr, bytes payload, uint256 value)
 *              (`value`, v7.2: the reply budget the message must ARRIVE with)
 *
 * BUY and SELL: (token, actor, amount, minimum, deadline). The minimum is what
 * the trader must receive (0 = none); the deadline is unix seconds on the
 * hub's clock (0 = none) — a gateway always sets one (`orderTtl`), and an
 * order that lands after it comes back whole. Nothing else in the tooling
 * encodes a trade.
 */
const { AbiCoder } = require('ethers')

const coder = AbiCoder.defaultAbiCoder()

/** BUY / SELL data: (token, buyer|seller, usdIn|tokensIn, minOut, deadline). */
const TRADE_FIELDS = ['bytes32', 'bytes32', 'uint256', 'uint256', 'uint256']
/** The values of a BUY / SELL, in TRADE_FIELDS order. */
const tradeValues = (token, actor, amount, min = 0n, deadline = 0n) => [token, actor, amount, min, deadline]

const OPS = {
  SPAWN: { op: 1, types: ['bytes32', 'string', 'string', 'string', 'uint256', 'uint8'] },
  BUY: { op: 2, types: TRADE_FIELDS },
  SELL: { op: 3, types: TRADE_FIELDS },
  CLAIM: { op: 4, types: ['bytes32', 'bytes32'] },
  PULL_FEES: { op: 5, types: ['bytes32'] },
  OPEN: { op: 6, types: ['bytes32'] },
  MOVE: { op: 7, types: ['bytes32', 'bytes32', 'uint256', 'uint32'] },
  SYNC_TOKEN: { op: 10, types: ['bytes32', 'string', 'string'] },
  DELIVER: { op: 11, types: ['bytes32', 'bytes32', 'uint256', 'uint256'] },
  PAYOUT: { op: 12, types: ['bytes32', 'uint256'] },
  FEE_DROP: { op: 13, types: ['bytes32', 'uint256'] },
}
const OP_NAMES = Object.fromEntries(Object.entries(OPS).map(([name, o]) => [o.op, name]))

const ENVELOPE_FIELDS = ['bytes32', 'bytes32', 'bytes', 'uint256']

/** A protocol payload. */
const encodeOp = (name, values) => coder.encode(['uint8', 'bytes'], [OPS[name].op, coder.encode(OPS[name].types, values)])
/** A BUY / SELL payload. */
const encodeTrade = (name, token, actor, amount, min = 0n, deadline = 0n) =>
  encodeOp(name, tradeValues(token, actor, amount, min, deadline))
/** The adapter envelope. */
const encodeEnvelope = (src, dst, payload, value = 0n) => coder.encode(ENVELOPE_FIELDS, [src, dst, payload, value])
/** { src, dst, payload, value, op } of an envelope. */
function decodeEnvelope(message) {
  const [src, dst, payload, value] = coder.decode(ENVELOPE_FIELDS, message)
  let op = -1
  try {
    op = Number(coder.decode(['uint8', 'bytes'], payload)[0])
  } catch {
    /* not a protocol payload */
  }
  return { src, dst, payload, value: BigInt(value), op }
}

module.exports = { coder, OPS, OP_NAMES, TRADE_FIELDS, ENVELOPE_FIELDS, tradeValues, encodeOp, encodeTrade, encodeEnvelope, decodeEnvelope }
