/**
 * The admin hand-over of one network: every contract's `admin` moves from
 * the deployer to a TimelockController owned by OWNER, exactly the bootstrap
 * proven in test/hardening.test.js:
 *
 *   0. operator = OWNER and guardian = GUARDIAN on every contract
 *      (while the deployer is still admin)
 *   1. a timelock with NO delay yet, the deployer its only proposer/executor
 *   2. every contract nominates it (transferAdmin)
 *   3. it accepts them all in one batch (possible only while the delay is 0)
 *   4. it raises its own delay to the configured 48h
 *   5. OWNER becomes proposer + executor + canceller, GUARDIAN canceller
 *      (an independent veto), and the deployer renounces every role
 *   6. everything is read back: the deployer must hold NOTHING
 *
 * Each chain has its own contracts, so each chain gets its own timelock: run
 * this once per network. Resumable — every step looks at the chain first.
 * After it, admin-only steps of the deploy script are no longer sendable by
 * the deployer: they are printed as calldata to schedule through the timelock.
 */
const { ethers } = require('hardhat')
const { loadState, saveState, roleKeys, same, isDevNode, MAINNET_CONFIRM, ENDPOINT_ABI } = require('./lib-net')

async function handover(opts) {
  const { profile, netKey, signer, log = console.log } = opts
  const stateFile = opts.stateFile ?? profile.stateFile
  const delay = opts.delay ?? profile.timelockDelay
  const provider = signer.provider
  const owner = opts.owner && ethers.getAddress(opts.owner)
  const guardian = opts.guardian && ethers.getAddress(opts.guardian)
  // The operator is OWNER unless named otherwise. Naming a hot key keeps
  // day-to-day tuning (reply budgets, legs, caps, rebalancing between the
  // protocol's own vaults, unpause) scriptable; it can never move funds out
  // of the protocol or change topology — those stay behind the timelock.
  const operator = opts.operator ? ethers.getAddress(opts.operator) : owner
  if (!owner || owner === ethers.ZeroAddress) throw new Error('OWNER is required (SPAWN_OWNER=0x…) and cannot be zero')
  if (!guardian || guardian === ethers.ZeroAddress) throw new Error('GUARDIAN is required (SPAWN_GUARDIAN=0x…)')
  if (same(owner, signer.address)) throw new Error('OWNER is the deployer — handing over to yourself is not a hand-over')
  const live = !(await isDevNode(provider))
  const dry =
    opts.dry ?? (process.env.SPAWN_DRY === '1' || (profile.mainnet && live && process.env.SPAWN_MAINNET_CONFIRM !== MAINNET_CONFIRM))
  if (profile.mainnet && live && !dry && process.env.SPAWN_MAINNET_CONFIRM !== MAINNET_CONFIRM) {
    throw new Error(`refusing a mainnet hand-over without SPAWN_MAINNET_CONFIRM=${MAINNET_CONFIRM}`)
  }

  log(`hand-over — ${profile.name}/${netKey} — deployer ${signer.address}${dry ? ' — DRY RUN' : ''}`)
  log(`  OWNER    ${owner}`)
  log(`  OPERATOR ${operator}${same(operator, owner) ? ' (OWNER)' : ''}`)
  log(`  GUARDIAN ${guardian}`)
  if (same(operator, signer.address)) {
    log('  ⚠ the deployer stays OPERATOR: a hot key that can tune fees and caps, rebalance between the')
    log('    protocol vaults and unpause — never withdraw, never rewire. OWNER can replace it through the timelock.')
  }
  log(`  delay    ${delay}s (${(delay / 3600).toFixed(1)}h)`)
  if ((await provider.getCode(owner)) === '0x') {
    log('  ⚠⚠⚠ OWNER HAS NO CODE: it is a plain key (EOA), not a multisig.')
    log('  ⚠⚠⚠ One leaked key = the timelock = every vault, after the delay. Use a Safe for real money.')
  }
  if (same(owner, guardian)) {
    log('  ⚠ GUARDIAN is OWNER: the veto on scheduled operations is not independent')
  }
  if (profile.mainnet && delay < 24 * 3600) log(`  ⚠ a ${delay}s delay gives users almost no time to exit`)

  const all = loadState(stateFile)
  const state = all[netKey]
  if (!state?.adapter) throw new Error(`${netKey}: nothing deployed in ${stateFile}`)
  const contracts = []
  for (const [key, name] of roleKeys(profile, netKey)) {
    if (!state[key]) throw new Error(`${netKey}: "${key}" is not deployed — finish the deploy first`)
    contracts.push({ key, c: await ethers.getContractAt(name, state[key], signer) })
  }
  let gasUsed = 0n
  const send = async (desc, txp) => {
    if (dry) return log(`  would: ${desc}`)
    gasUsed += (await (await txp()).wait()).gasUsed
    log(`  ${desc} ✓`)
  }

  // 0. the fast roles, while the deployer can still name them
  for (const { key, c } of contracts) {
    if (!same(await c.admin(), signer.address)) continue
    if (!same(await c.operator(), operator)) await send(`${key}.setOperator(OPERATOR)`, () => c.setOperator(operator))
    if (!same(await c.guardian(), guardian)) await send(`${key}.setGuardian(GUARDIAN)`, () => c.setGuardian(guardian))
  }

  // 1. the timelock, delay 0 for the bootstrap
  let timelock
  if (state.timelock) {
    timelock = await ethers.getContractAt('SpawnTimelock', state.timelock, signer)
    log(`  timelock = ${state.timelock} (already deployed)`)
  } else if (dry) {
    log('  would: deploy SpawnTimelock(delay 0, proposer/executor = deployer)')
  } else {
    const f = await ethers.getContractFactory('SpawnTimelock', signer)
    timelock = await f.deploy(0, [signer.address], [signer.address], signer.address)
    gasUsed += (await timelock.deploymentTransaction().wait()).gasUsed
    state.timelock = timelock.target
    const fresh = loadState(stateFile)
    fresh[netKey] = state
    saveState(stateFile, fresh)
    log(`  timelock = ${timelock.target} ✦ deployed`)
  }
  if (dry && !timelock) {
    log('  would: nominate, batch-accept, raise the delay, hand the roles to OWNER, renounce')
    return { dry: true }
  }

  // 2. every contract nominates it
  for (const { key, c } of contracts) {
    const admin = await c.admin()
    if (same(admin, timelock.target)) continue
    if (!same(admin, signer.address)) throw new Error(`${key}: admin is ${admin} — neither the deployer nor the timelock`)
    if (!same(await c.pendingAdmin(), timelock.target)) {
      await send(`${key}.transferAdmin(timelock)`, () => c.transferAdmin(timelock.target))
    }
  }

  // 3. it accepts them all in one batch (only while its delay is still 0)
  const pending = []
  for (const { key, c } of contracts) if (!dry && same(await c.pendingAdmin(), timelock.target)) pending.push({ key, c })
  if (pending.length) {
    if ((await timelock.getMinDelay()) !== 0n) {
      throw new Error('the timelock already has a delay: the remaining acceptAdmin calls must be scheduled by OWNER')
    }
    const targets = pending.map((p) => p.c.target)
    const zeros = pending.map(() => 0)
    const accepts = pending.map((p) => p.c.interface.encodeFunctionData('acceptAdmin'))
    const salt = ethers.id(`spawn/handover/${netKey}/${targets.join(',')}`)
    await send(`timelock: batch acceptAdmin on ${pending.map((p) => p.key).join(', ')}`, async () => {
      gasUsed += (await (await timelock.scheduleBatch(targets, zeros, accepts, ethers.ZeroHash, salt, 0)).wait()).gasUsed
      return timelock.executeBatch(targets, zeros, accepts, ethers.ZeroHash, salt)
    })
  }

  // 4. it raises its own delay
  if (!dry && (await timelock.getMinDelay()) !== BigInt(delay)) {
    const raise = timelock.interface.encodeFunctionData('updateDelay', [delay])
    const salt = ethers.id(`spawn/handover/${netKey}/delay/${delay}`)
    await send(`timelock.updateDelay(${delay}s) through itself`, async () => {
      gasUsed += (await (await timelock.schedule(timelock.target, 0, raise, ethers.ZeroHash, salt, 0)).wait()).gasUsed
      return timelock.execute(timelock.target, 0, raise, ethers.ZeroHash, salt)
    })
  }

  // 5. OWNER runs it, GUARDIAN can veto, the deployer keeps nothing
  const [PROPOSER, EXECUTOR, CANCELLER, ROLE_ADMIN] = await Promise.all([
    timelock.PROPOSER_ROLE(),
    timelock.EXECUTOR_ROLE(),
    timelock.CANCELLER_ROLE(),
    timelock.DEFAULT_ADMIN_ROLE(),
  ])
  const grants = [
    ['PROPOSER', PROPOSER, owner],
    ['EXECUTOR', EXECUTOR, owner],
    ['CANCELLER', CANCELLER, owner],
    ['CANCELLER', CANCELLER, guardian],
  ]
  for (const [name, role, who] of grants) {
    if (!(await timelock.hasRole(role, who))) {
      await send(`timelock.grantRole(${name}, ${who})`, () => timelock.grantRole(role, who))
    }
  }
  for (const [name, role] of [['PROPOSER', PROPOSER], ['EXECUTOR', EXECUTOR], ['CANCELLER', CANCELLER], ['DEFAULT_ADMIN', ROLE_ADMIN]]) {
    if (await timelock.hasRole(role, signer.address)) {
      await send(`deployer renounces ${name}`, () => timelock.renounceRole(role, signer.address))
    }
  }
  if (dry) return { dry: true, timelock: timelock.target }

  // 6. read it all back
  const problems = []
  const want = (what, ok) => {
    if (!ok) problems.push(what)
  }
  for (const { key, c } of contracts) {
    want(`${key}.admin is the timelock`, same(await c.admin(), timelock.target))
    want(`${key}.pendingAdmin is empty`, (await c.pendingAdmin()) === ethers.ZeroAddress)
    want(`${key}.operator is OPERATOR`, same(await c.operator(), operator))
    want(`${key}.guardian is GUARDIAN`, same(await c.guardian(), guardian))
  }
  const endpoint = new ethers.Contract(profile.endpoint, ENDPOINT_ABI, provider)
  want('the LayerZero delegate of the adapter is the timelock', same(await endpoint.delegates(state.adapter), timelock.target))
  want(`timelock delay is ${delay}s`, (await timelock.getMinDelay()) === BigInt(delay))
  for (const [name, role] of [['PROPOSER', PROPOSER], ['EXECUTOR', EXECUTOR], ['CANCELLER', CANCELLER], ['DEFAULT_ADMIN', ROLE_ADMIN]]) {
    want(`the deployer no longer holds ${name}`, !(await timelock.hasRole(role, signer.address)))
  }
  want('OWNER is proposer', await timelock.hasRole(PROPOSER, owner))
  want('OWNER is executor', await timelock.hasRole(EXECUTOR, owner))
  want('GUARDIAN can cancel', await timelock.hasRole(CANCELLER, guardian))
  // the timelock administers its own roles from now on
  want('the timelock is its own role admin', await timelock.hasRole(ROLE_ADMIN, timelock.target))
  if (problems.length) throw new Error(`hand-over incomplete:\n  - ${problems.join('\n  - ')}`)

  state.handover = { owner, operator, guardian, delay, timelock: timelock.target, at: new Date().toISOString() }
  const fresh = loadState(stateFile)
  fresh[netKey] = state
  saveState(stateFile, fresh)
  const keeps = [same(operator, signer.address) && 'operator', same(guardian, signer.address) && 'guardian'].filter(Boolean)
  log(
    `  ✓ hand-over complete: ${contracts.length} contracts answer to ${timelock.target}; the deployer holds ` +
      (keeps.length ? `no admin power (it stays ${keeps.join(' + ')})` : 'nothing'),
  )
  return { timelock, owner, operator, guardian, delay, gasUsed, contracts: contracts.map((x) => x.key) }
}

module.exports = { handover }
