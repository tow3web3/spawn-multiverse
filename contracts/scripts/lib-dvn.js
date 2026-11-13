/**
 * LayerZero verifier (DVN) configuration for the adapters of a deployment.
 *
 * Why it matters: an adapter that configures nothing rides LayerZero's
 * DEFAULT set — today four required DVNs, one of which charges ~0.0005 ETH
 * per message (docs/MAINNET-ADDRESSES.md) — and whoever controls the DVN set
 * controls what the hub and the vaults believe. So the set is explicit,
 * pinned and identical on both ends of every pathway:
 *
 *   on the SOURCE chain   send library  → executor config + ULN config
 *   on the DEST chain     receive library → ULN config
 *
 * Both libraries are also PINNED for the adapter (setSendLibrary /
 * setReceiveLibrary), so a change of LayerZero's default library can never
 * silently swap the configuration underneath.
 *
 * Only the adapter's endpoint delegate may configure it: the deployer before
 * the hand-over, the timelock after (then the calldata is printed instead).
 */
const { ethers } = require('hardhat')
const { activeNets, dvnSetFor } = require('../config/profiles')
const { loadState, same } = require('./lib-net')

const CONFIG_TYPE_EXECUTOR = 1
const CONFIG_TYPE_ULN = 2
const ULN_TUPLE =
  'tuple(uint64 confirmations,uint8 requiredDVNCount,uint8 optionalDVNCount,uint8 optionalDVNThreshold,address[] requiredDVNs,address[] optionalDVNs)'
const EXEC_TUPLE = 'tuple(uint32 maxMessageSize,address executor)'
const coder = ethers.AbiCoder.defaultAbiCoder()

const ENDPOINT_CFG_ABI = [
  'function delegates(address) view returns (address)',
  'function getSendLibrary(address,uint32) view returns (address)',
  'function getReceiveLibrary(address,uint32) view returns (address lib, bool isDefault)',
  'function isDefaultSendLibrary(address,uint32) view returns (bool)',
  'function setSendLibrary(address oapp, uint32 eid, address newLib)',
  'function setReceiveLibrary(address oapp, uint32 eid, address newLib, uint256 gracePeriod)',
  'function getConfig(address oapp, address lib, uint32 eid, uint32 configType) view returns (bytes)',
  'function setConfig(address oapp, address lib, (uint32 eid, uint32 configType, bytes config)[] params)',
  'function quote((uint32 dstEid, bytes32 receiver, bytes message, bytes options, bool payInLzToken) p, address sender) view returns ((uint256 nativeFee, uint256 lzTokenFee))',
]
const ULN_ABI = [
  `function getUlnConfig(address oapp, uint32 remoteEid) view returns (${ULN_TUPLE})`,
  `function getExecutorConfig(address oapp, uint32 remoteEid) view returns (${EXEC_TUPLE})`,
]
const DVN_ABI = ['function getFee(uint32,uint64,address,bytes) view returns (uint256)']

const sortAddrs = (list) => [...list].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))

/** The DVN addresses of `names` on `net`, checksummed and sorted ascending
 * (the ULN rejects an unsorted or duplicated list). */
function dvnAddresses(profile, net, names) {
  return sortAddrs(
    names.map((n) => {
      const a = profile.dvn.addresses[n]?.[net]
      if (!a) throw new Error(`no ${net} address configured for DVN "${n}"`)
      return ethers.getAddress(a)
    }),
  )
}

/** The ULN config this deployment wants on `net`, for its pathway with
 * `remote`, when the SOURCE chain is `srcNet` (confirmations are a property
 * of the source chain). The verifier set is the pathway's own
 * (`dvn.pathways`) or the profile default — the SAME names on both ends,
 * resolved to each chain's addresses. */
function plannedUln(profile, net, srcNet, remote) {
  const set = dvnSetFor(profile, net, remote ?? (srcNet === net ? undefined : srcNet))
  const required = dvnAddresses(profile, net, set.required)
  const optional = dvnAddresses(profile, net, set.optional)
  return {
    confirmations: BigInt(profile.nets[srcNet].confirmations),
    requiredDVNCount: required.length,
    optionalDVNCount: optional.length,
    optionalDVNThreshold: set.optionalThreshold,
    requiredDVNs: required,
    optionalDVNs: optional,
  }
}

const ulnEq = (a, b) =>
  BigInt(a.confirmations) === BigInt(b.confirmations) &&
  Number(a.requiredDVNCount) === Number(b.requiredDVNCount) &&
  Number(a.optionalDVNCount) === Number(b.optionalDVNCount) &&
  Number(a.optionalDVNThreshold) === Number(b.optionalDVNThreshold) &&
  JSON.stringify([...a.requiredDVNs].map((x) => x.toLowerCase())) ===
    JSON.stringify([...b.requiredDVNs].map((x) => x.toLowerCase())) &&
  JSON.stringify([...a.optionalDVNs].map((x) => x.toLowerCase())) ===
    JSON.stringify([...b.optionalDVNs].map((x) => x.toLowerCase()))

const encodeUln = (u) =>
  coder.encode(
    [ULN_TUPLE],
    [[u.confirmations, u.requiredDVNCount, u.optionalDVNCount, u.optionalDVNThreshold, u.requiredDVNs, u.optionalDVNs]],
  )
const decodeUln = (bytes) => coder.decode([ULN_TUPLE], bytes)[0]

/** The OApp-level (not effective) config stored for an adapter, or null. */
async function storedUln(endpoint, oapp, lib, eid) {
  try {
    return decodeUln(await endpoint.getConfig(oapp, lib, eid, CONFIG_TYPE_ULN))
  } catch {
    return null
  }
}

/** Who this network's adapter exchanges messages with: a hub with every
 * active spoke, a spoke with the hub only. */
function remotesOf(profile, netKey) {
  const nets = activeNets(profile)
  return netKey === profile.hub
    ? Object.keys(nets).filter((n) => nets[n].role === 'spoke')
    : [profile.hub]
}

/**
 * Configures (or, already configured, verifies) the DVN set of `netKey`'s
 * adapter for every pathway it takes part in, then reads it back.
 * opts: { profile, netKey, signer, stateFile?, dry?, collect?, log? }
 */
async function configureDvn(opts) {
  const { profile, netKey, signer, log = console.log } = opts
  if (!profile.dvn) throw new Error(`the ${profile.name} profile configures no DVN set (it rides LayerZero's defaults)`)
  const dry = opts.dry ?? false
  const state = loadState(opts.stateFile ?? profile.stateFile)[netKey]
  if (!state?.adapter) throw new Error(`${netKey}: no adapter in the state — deploy first`)
  const oapp = state.adapter
  const provider = signer.provider
  const endpoint = new ethers.Contract(profile.endpoint, ENDPOINT_CFG_ABI, signer)
  const delegate = await endpoint.delegates(oapp)
  const canConfigure = same(delegate, signer.address)
  const cfg = profile.nets[netKey]
  const result = { netKey, pathways: [], blocked: [], txs: 0, gasUsed: 0n }
  log(
    `DVN config — ${profile.name}/${netKey} — adapter ${oapp} — delegate ${delegate}` +
      (canConfigure ? '' : ' (NOT the signer: calldata is printed, nothing is sent)') +
      (dry ? ' — DRY RUN' : ''),
  )
  const d = profile.dvn
  const setText = (set) =>
    `required ${set.required.join(' + ')}` +
    (set.optional.length ? ` | optional ${set.optionalThreshold}-of ${set.optional.join(', ')}` : '')
  log(`  default set: ${setText(dvnSetFor(profile, netKey, undefined))}`)

  // `collect`: gather what is needed as calldata and send NOTHING, whoever
  // the signer is (scripts/lib-timelock.js batches it for the timelock)
  const act = async (desc, fn, args) => {
    if (dry) return log(`  would: ${desc}`)
    if (!canConfigure || opts.collect) {
      const data = endpoint.interface.encodeFunctionData(fn, args)
      result.blocked.push({ desc, target: profile.endpoint, data })
      return log(`  ⏳ ${desc} — needs the delegate: target ${profile.endpoint} data ${data}`)
    }
    const rc = await (await endpoint[fn](...args)).wait()
    result.gasUsed += rc.gasUsed
    result.txs += 1
    log(`  ${desc} ✓`)
  }

  for (const remote of remotesOf(profile, netKey)) {
    const r = profile.nets[remote]
    const sendLib = await endpoint.getSendLibrary(oapp, r.eid)
    const [recvLib, recvIsDefault] = await endpoint.getReceiveLibrary(oapp, r.eid)
    const set = dvnSetFor(profile, netKey, remote)
    if (set.own) log(`  ${netKey} <-> ${remote} has its OWN set: ${setText(set)}`)
    const sendUln = plannedUln(profile, netKey, netKey, remote) // we are the source
    const recvUln = plannedUln(profile, netKey, remote, remote) // the remote is the source

    // never configure a verifier that will not quote this pathway: with a
    // DVN that refuses the job, every send on it reverts
    for (const name of [...set.required, ...set.optional]) {
      const addr = ethers.getAddress(d.addresses[name][netKey])
      try {
        await new ethers.Contract(addr, DVN_ABI, provider).getFee(r.eid, sendUln.confirmations, oapp, '0x')
      } catch (e) {
        throw new Error(
          `DVN "${name}" (${addr}) does not quote ${netKey} -> ${remote}: ${e.shortMessage ?? e.message} — refusing to configure it`,
        )
      }
    }

    // pin both libraries: a default-library migration must not swap our config
    if (await endpoint.isDefaultSendLibrary(oapp, r.eid)) {
      await act(`pin send library ${netKey} -> ${remote} (${sendLib})`, 'setSendLibrary', [oapp, r.eid, sendLib])
    }
    if (recvIsDefault) {
      await act(`pin receive library ${remote} -> ${netKey} (${recvLib})`, 'setReceiveLibrary', [oapp, r.eid, recvLib, 0])
    }

    const sendC = new ethers.Contract(sendLib, ULN_ABI, provider)
    const curExec = await sendC.getExecutorConfig(oapp, r.eid)
    const curSend = await storedUln(endpoint, oapp, sendLib, r.eid)
    if (!curSend || !ulnEq(curSend, sendUln) || Number(curExec.maxMessageSize) !== d.maxMessageSize) {
      await act(`send config ${netKey} -> ${remote}`, 'setConfig', [
        oapp,
        sendLib,
        [
          // keep LayerZero's executor for the pathway; fix the message size
          { eid: r.eid, configType: CONFIG_TYPE_EXECUTOR, config: coder.encode([EXEC_TUPLE], [[d.maxMessageSize, curExec.executor]]) },
          { eid: r.eid, configType: CONFIG_TYPE_ULN, config: encodeUln(sendUln) },
        ],
      ])
    }
    const curRecv = await storedUln(endpoint, oapp, recvLib, r.eid)
    if (!curRecv || !ulnEq(curRecv, recvUln)) {
      await act(`receive config ${remote} -> ${netKey}`, 'setConfig', [
        oapp,
        recvLib,
        [{ eid: r.eid, configType: CONFIG_TYPE_ULN, config: encodeUln(recvUln) }],
      ])
    }

    // read back what is EFFECTIVE for the adapter (what messages will use)
    const recvC = new ethers.Contract(recvLib, ULN_ABI, provider)
    const effSend = await sendC.getUlnConfig(oapp, r.eid)
    const effRecv = await recvC.getUlnConfig(oapp, r.eid)
    const okSend = ulnEq(effSend, sendUln)
    const okRecv = ulnEq(effRecv, recvUln)
    result.pathways.push({ remote, sendLib, recvLib, okSend, okRecv, effSend, effRecv })
    log(
      `  ${okSend ? '✓' : dry || !canConfigure ? '·' : '✗'} ${netKey} -> ${remote} send: ` +
        `${effSend.requiredDVNCount} required + ${effSend.optionalDVNThreshold}-of-${effSend.optionalDVNCount} optional, ` +
        `${effSend.confirmations} confirmations`,
    )
    log(
      `  ${okRecv ? '✓' : dry || !canConfigure ? '·' : '✗'} ${remote} -> ${netKey} receive: ` +
        `${effRecv.requiredDVNCount} required + ${effRecv.optionalDVNThreshold}-of-${effRecv.optionalDVNCount} optional, ` +
        `${effRecv.confirmations} confirmations`,
    )
    if (!dry && canConfigure && !opts.collect && (!okSend || !okRecv)) {
      throw new Error(`${netKey} <-> ${remote}: the DVN config read back from the chain does not match the plan`)
    }
  }
  result.ok = result.pathways.every((p) => p.okSend && p.okRecv)
  return result
}

/** Reverse lookup: a DVN address on `net` → its configured name. */
function dvnName(profile, net, addr) {
  for (const [name, m] of Object.entries(profile.dvn?.addresses ?? {})) {
    if (m[net] && m[net].toLowerCase() === addr.toLowerCase()) return name
  }
  return addr
}

/**
 * CROSS-CHAIN verification, read-only, over each network's RPC: for every
 * pathway between deployed adapters, the source's effective send config and
 * the destination's effective receive config must name the same verifiers
 * with the same thresholds and confirmations — otherwise messages stall.
 */
async function verifyDvn({ profile, stateFile, providers, log = console.log }) {
  const all = loadState(stateFile ?? profile.stateFile)
  const nets = activeNets(profile)
  const rows = []
  const provider = (net) =>
    providers?.[net] ?? new ethers.JsonRpcProvider(nets[net].rpc, nets[net].chainId, { staticNetwork: true })
  const names = (net, list) => [...list].map((a) => dvnName(profile, net, a)).sort()
  for (const [net, c] of Object.entries(nets)) {
    if (c.role !== 'spoke' || !all[net]?.adapter || !all[profile.hub]?.adapter) continue
    for (const [src, dst] of [
      [net, profile.hub],
      [profile.hub, net],
    ]) {
      const [ps, pd] = [provider(src), provider(dst)]
      const eS = new ethers.Contract(profile.endpoint, ENDPOINT_CFG_ABI, ps)
      const eD = new ethers.Contract(profile.endpoint, ENDPOINT_CFG_ABI, pd)
      const sendLib = await eS.getSendLibrary(all[src].adapter, nets[dst].eid)
      const [recvLib] = await eD.getReceiveLibrary(all[dst].adapter, nets[src].eid)
      const s = await new ethers.Contract(sendLib, ULN_ABI, ps).getUlnConfig(all[src].adapter, nets[dst].eid)
      const r = await new ethers.Contract(recvLib, ULN_ABI, pd).getUlnConfig(all[dst].adapter, nets[src].eid)
      const sReq = names(src, s.requiredDVNs)
      const rReq = names(dst, r.requiredDVNs)
      const sOpt = names(src, s.optionalDVNs)
      const rOpt = names(dst, r.optionalDVNs)
      const match =
        JSON.stringify(sReq) === JSON.stringify(rReq) &&
        JSON.stringify(sOpt) === JSON.stringify(rOpt) &&
        Number(s.optionalDVNThreshold) === Number(r.optionalDVNThreshold) &&
        BigInt(s.confirmations) >= BigInt(r.confirmations)
      const want = profile.dvn ? dvnSetFor(profile, src, dst) : null
      const planned =
        want &&
        JSON.stringify(sReq) === JSON.stringify([...want.required].sort()) &&
        JSON.stringify(sOpt) === JSON.stringify([...want.optional].sort()) &&
        Number(s.optionalDVNThreshold) === want.optionalThreshold
      rows.push({ src, dst, sReq, rReq, sOpt, rOpt, match, planned: !!planned, confirmations: [s.confirmations, r.confirmations] })
      log(
        `  ${match && planned ? '✓' : '✗'} ${src} -> ${dst}: send [${sReq.join(' + ')}${sOpt.length ? ` | ${s.optionalDVNThreshold}-of ${sOpt.join(', ')}` : ''}]` +
          ` / receive [${rReq.join(' + ')}${rOpt.length ? ` | ${r.optionalDVNThreshold}-of ${rOpt.join(', ')}` : ''}]` +
          (match ? '' : ' — MISMATCH: messages on this pathway will stall') +
          (match && !planned ? ' — not the configured set' : ''),
      )
    }
  }
  return { rows, ok: rows.every((r) => r.match && r.planned) }
}

module.exports = {
  configureDvn,
  verifyDvn,
  plannedUln,
  dvnAddresses,
  dvnName,
  remotesOf,
  ENDPOINT_CFG_ABI,
  ULN_ABI,
}
