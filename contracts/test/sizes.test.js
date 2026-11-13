const { expect } = require('chai')
const { artifacts } = require('hardhat')

/**
 * EIP-170: a contract whose runtime code exceeds 24,576 bytes cannot be
 * deployed on any target chain. Hardhat's own network enforces it too
 * (allowUnlimitedContractSize is off), but a failed deployment deep inside a
 * fixture is a poor signal — this names the contract and the margin.
 */
describe('contract sizes', () => {
  const RUNTIME_LIMIT = 24_576
  const INITCODE_LIMIT = 49_152 // EIP-3860
  // every contract a real deployment creates (mocks are test-only)
  const DEPLOYABLE = [
    'SpawnPad',
    'SpawnGateway',
    'SpawnToken',
    'OmniUSD',
    'FeeDistributor',
    'InternalCurveVenue',
    'LayerZeroOmniMessenger',
    'SpawnTimelock',
  ]

  for (const name of DEPLOYABLE) {
    it(`${name} fits the 24,576-byte runtime limit`, async () => {
      const a = await artifacts.readArtifact(name)
      const runtime = (a.deployedBytecode.length - 2) / 2
      const initcode = (a.bytecode.length - 2) / 2
      expect(runtime, `${name} runtime is ${runtime} bytes`).to.be.lte(RUNTIME_LIMIT)
      expect(initcode, `${name} initcode is ${initcode} bytes`).to.be.lte(INITCODE_LIMIT)
    })
  }

  it('SpawnPad keeps at least 512 bytes of headroom', async () => {
    const a = await artifacts.readArtifact('SpawnPad')
    expect(RUNTIME_LIMIT - (a.deployedBytecode.length - 2) / 2).to.be.gte(512)
  })
})
