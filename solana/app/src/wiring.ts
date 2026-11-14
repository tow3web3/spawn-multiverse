/**
 * The deployment wiring of V7.md §6, steps 2–10, as idempotent steps: each
 * one reads the chain, sends only what is missing, and says what it did.
 * Re-running after a partial run is safe. Step 1 (the program deploy) is
 * checked, never performed.
 *
 * THE LOOKUP TABLE. `init_store` records the table the executor will use
 * if it is given one, so the table is CREATED first (step 2a, empty) and
 * FILLED at step 7, once the verifier set is known. A store that names no
 * table, or another one, is re-pointed with `set_receive_table` (step 2b).
 * A table has no "transfer authority": whoever created it can extend it
 * and CLOSE it for good — and a closed table stalls every delivery by
 * LayerZero's executor until the admin names a new one. So once it is
 * full the table is FROZEN (step 7b, `freezeTable`): nobody can touch it
 * again; a later change of verifier set gets a new table (`--table` +
 * step 2b).
 *
 * THE LIBRARIES. A fresh OApp follows the endpoint's DEFAULT send and
 * receive libraries. Step 5 pins both to the library those defaults name
 * today (ULN 302), exactly as the EVM adapters do (contracts/scripts/
 * lib-dvn.js): the receive library decides whose verification is believed,
 * and the verifier set of step 6 is a setting OF that library — if
 * LayerZero re-aimed the default, an unpinned gateway would follow it to a
 * library where our set was never configured, i.e. to that library's
 * defaults. Custody must not rest on a default.
 */
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  PublicKey,
  Signer,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import {
  ATA_PROGRAM,
  Cluster,
  LZ_ENDPOINT,
  LZ_EXECUTOR,
  MAX_MOVE_LEGS,
  MAX_OPEN_LEGS,
  MAX_RETURN_UNIT,
  MAX_SPAWN_LEGS,
  MAX_TRADE_LEGS,
  PROGRAM_ID,
  SOLANA_LABEL,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from './constants'
import { bytesToHex, equalBytes } from './bytes'
import {
  Store,
  decodeCctpPeer,
  decodeLzReceiveTypesAccounts,
  decodeMoveRoute,
  decodePeerConfig,
  decodeStore,
} from './accounts'
import {
  CONFIG_TYPE,
  UlnConfig,
  compareKeys,
  decodeReceiveConfig,
  decodeReceiveLibraryConfig,
  decodeSendConfig,
  decodeSendLibraryConfig,
  encodeUlnConfig,
  initNonceIx,
  initReceiveLibraryIx,
  initSendLibraryIx,
  initUlnConfigIx,
  resolveSendPath,
  sendStaticAddresses,
  setReceiveLibraryIx,
  setSendLibraryIx,
  setUlnConfigIx,
} from './layerzero'
import {
  governIx,
  initStoreIx,
  initVaultIx,
  setCctpPeerIx,
  setMoveLegsIx,
  setPeerConfigIx,
  setReceiveTableIx,
} from './instructions'
import { GatewayPdas, lzPda } from './pda'
import { GatewayRpc, getAccount, getLookupTable } from './rpc'
import { createLookupTableIx, extendLookupTableIxs } from './transaction'

export interface VerifierSet {
  required: PublicKey[]
  optional: PublicKey[]
  threshold: number
}

export interface WiringParams {
  cluster: Cluster
  programId?: PublicKey
  /** The hub's LayerZero eid (Base 30184, Base Sepolia 40245). */
  hubEid: number
  /** The hub PAD, as its 32-byte wide identity (EVM address left-padded). */
  hubPad: Uint8Array
  /** The hub ADAPTER (the LayerZero peer), 32 bytes. */
  hubAdapter: Uint8Array
  usdcMint: PublicKey
  /** Signs and pays steps 2–9; becomes admin and LayerZero delegate. */
  admin: PublicKey
  /** null = keep the pathway's default verifiers (no `set_config`). */
  verifiers: VerifierSet | null
  sendConfirmations: bigint
  receiveConfirmations: bigint
  operator?: PublicKey
  guardian?: PublicKey
  fee: { gasToHub: bigint; returnUnit: bigint; tradeLegs: number; spawnLegs: number }
  /** Legs an `open_token` prepays (v7.2; default 1 — the program's own). */
  openLegs?: number
  /** The price of a claim moved toward each chain (v7.2): what the hub
   * pays to carry the PAYOUT there, in this chain's reply units. A chain
   * that is not listed stays closed. */
  moveLegs?: { dstChain: number; legs: number }[]
  /** Peer vaults for CCTP rebalancing (v7.2) — each set ONCE, for good. */
  cctpPeers?: { label: number; domain: number; vault: Uint8Array }[]
  depositCap: bigint
  /** Leave the store paused at the end of step 8 (V7.md: yes, until the
   * hub batch). A store is born paused; false unpauses it. */
  leavePaused: boolean
  /** Pin the send and receive libraries (step 5). Default true. */
  pinLibraries?: boolean
  /** Freeze the lookup table once it is full (step 7b). Default true. */
  freezeTable?: boolean
  /** Target lamport balance of the tank (step 9 tops it up to this). */
  tankLamports: bigint
  /** Step 10: the next admin (the multisig). Omit to skip step 10. */
  newAdmin?: PublicKey
  /** Reuse an existing lookup table instead of creating one. */
  table?: PublicKey
}

/** Carries a step's transaction: a real cluster, LiteSVM, or a printer. */
export interface StepSender {
  readonly dryRun: boolean
  send(label: string, instructions: TransactionInstruction[], extraSigners?: Signer[], tables?: AddressLookupTableAccount[]): Promise<void>
  /** Lets a just-extended table warm up (one slot) before it is used. */
  settle?(): Promise<void>
}

export type Log = (line: string) => void

export interface WiringState {
  table: PublicKey | null
}

export interface Step {
  id: string
  title: string
  run(ctx: StepContext): Promise<void>
}

export interface StepContext {
  p: WiringParams
  rpc: GatewayRpc
  sender: StepSender
  pdas: GatewayPdas
  state: WiringState
  log: Log
  /** Signers available for step 10 (the new admin, when it is a key). */
  newAdminSigner?: Signer
}

async function readStore(c: StepContext): Promise<Store | null> {
  const a = await getAccount(c.rpc, c.pdas.store)
  return a ? decodeStore(a.data) : null
}

function desiredUln(p: WiringParams, confirmations: bigint): UlnConfig | null {
  if (!p.verifiers) return null
  const sort = (v: PublicKey[]) => [...v].sort(compareKeys)
  return {
    confirmations,
    requiredDvnCount: p.verifiers.required.length,
    optionalDvnCount: p.verifiers.optional.length,
    optionalDvnThreshold: p.verifiers.threshold,
    requiredDvns: sort(p.verifiers.required),
    optionalDvns: sort(p.verifiers.optional),
  }
}

const sameUln = (a: UlnConfig, b: UlnConfig) =>
  a.confirmations === b.confirmations &&
  a.requiredDvnCount === b.requiredDvnCount &&
  a.optionalDvnCount === b.optionalDvnCount &&
  a.optionalDvnThreshold === b.optionalDvnThreshold &&
  a.requiredDvns.length === b.requiredDvns.length &&
  a.optionalDvns.length === b.optionalDvns.length &&
  a.requiredDvns.every((k, i) => k.equals(b.requiredDvns[i])) &&
  a.optionalDvns.every((k, i) => k.equals(b.optionalDvns[i]))

/** Every address that is the same for all users and tokens: the gateway's,
 * the send path's, and what the executor's delivery transaction uses. */
export async function tableAddresses(c: StepContext): Promise<PublicKey[]> {
  const { p, pdas } = c
  const path = await resolveSendPath(c.rpc, pdas.store, p.hubEid, p.hubAdapter, desiredUln(p, p.sendConfirmations) ?? undefined)
  const all = [
    pdas.programId,
    pdas.store,
    pdas.peer(p.hubEid),
    pdas.gasTank,
    pdas.vault,
    p.usdcMint,
    TOKEN_PROGRAM,
    ATA_PROGRAM,
    SYSTEM_PROGRAM,
    ...sendStaticAddresses(path),
    // the executor's delivery transaction (test_live_endpoint.rs `executor_tx_size`)
    lzPda.oappRegistry(pdas.store),
    lzPda.eventAuthority(LZ_EXECUTOR),
    LZ_EXECUTOR,
    // what a move toward each priced chain reads
    ...(p.moveLegs ?? []).map((m) => pdas.moveRoute(m.dstChain)),
  ]
  return [...new Map(all.map((k) => [k.toBase58(), k])).values()]
}

/** The message library an endpoint config account names, or null for "the
 * default" (all zeros). */
const namedLib = (k: PublicKey) => (k.equals(PublicKey.default) ? null : k)

export const STEPS: Step[] = [
  {
    id: '1-program',
    title: 'program deployed (checked, not performed)',
    async run(c) {
      const a = await getAccount(c.rpc, c.pdas.programId)
      if (a?.executable) return c.log(`program ${c.pdas.programId.toBase58()} is deployed`)
      const msg =
        `program ${c.pdas.programId.toBase58()} is NOT deployed on ${c.p.cluster}. Deploy it first:\n` +
        `  solana program deploy target/deploy/spawn_gateway.so --program-id target/deploy/spawn_gateway-keypair.json -u ${c.p.cluster}`
      if (c.sender.dryRun) return c.log(msg + '\n  (dry run: continuing with the plan)')
      throw new Error(msg)
    },
  },
  {
    id: '2a-table',
    title: 'lookup table exists (created before init_store, which records it)',
    async run(c) {
      if (c.p.table) {
        if (!(await getAccount(c.rpc, c.p.table)) && !c.sender.dryRun) throw new Error(`table ${c.p.table.toBase58()} does not exist`)
        c.state.table = c.p.table
        return c.log(`using table ${c.p.table.toBase58()}`)
      }
      const t = await getAccount(c.rpc, c.pdas.lzReceiveTypes)
      if (t) {
        const alt = decodeLzReceiveTypesAccounts(t.data).alt
        if (!alt.equals(PublicKey.default)) {
          c.state.table = alt
          return c.log(`the store already names table ${alt.toBase58()}`)
        }
        c.log('the store names no table: creating one (step 2b records it)')
      }
      const slot = await c.rpc.slot()
      const { ix, address } = createLookupTableIx(c.p.admin, c.p.admin, slot)
      await c.sender.send(`create lookup table ${address.toBase58()}`, [ix])
      c.state.table = address
    },
  },
  {
    id: '2-init-store',
    title: 'init_store + register the OApp (admin = delegate)',
    async run(c) {
      const s = await readStore(c)
      if (s) {
        const ok = s.hubEid === c.p.hubEid && equalBytes(s.hubPad, c.p.hubPad) && s.endpointProgram.equals(LZ_ENDPOINT)
        if (!ok) throw new Error(`the store exists with another hub (eid ${s.hubEid}) or endpoint: a store is created once`)
        return c.log('store already initialised')
      }
      const ix = initStoreIx(c.pdas, c.p.admin, { admin: c.p.admin, endpoint: LZ_ENDPOINT, hubEid: c.p.hubEid, hubPad: c.p.hubPad }, c.state.table)
      await c.sender.send('init_store', [ix])
    },
  },
  {
    id: '2b-table-record',
    title: 'the store names the lookup table (set_receive_table if it names none, or another)',
    async run(c) {
      if (!c.state.table) return c.log('no table: nothing to record')
      const t = await getAccount(c.rpc, c.pdas.lzReceiveTypes)
      // (dry run on a fresh cluster: init_store will have recorded it)
      if (!t) return c.log('recorded by init_store')
      if (decodeLzReceiveTypesAccounts(t.data).alt.equals(c.state.table)) return c.log('already recorded')
      await c.sender.send(`set_receive_table ${c.state.table.toBase58()}`, [setReceiveTableIx(c.pdas, c.p.admin, c.state.table)])
    },
  },
  {
    id: '3-peer',
    title: 'set_peer_config(hub eid, hub adapter)',
    async run(c) {
      const a = await getAccount(c.rpc, c.pdas.peer(c.p.hubEid))
      if (a && equalBytes(decodePeerConfig(a.data).peerAddress, c.p.hubAdapter)) return c.log('peer already set')
      await c.sender.send('set_peer_config', [setPeerConfigIx(c.pdas, c.p.admin, c.p.hubEid, c.p.hubAdapter)])
    },
  },
  {
    id: '4-vault',
    title: 'init_vault over USDC',
    async run(c) {
      const s = await readStore(c)
      if (s && !s.vault.equals(PublicKey.default)) {
        if (!s.usdcMint.equals(c.p.usdcMint)) throw new Error(`the vault is over ${s.usdcMint.toBase58()}, not ${c.p.usdcMint.toBase58()}`)
        return c.log('vault already initialised')
      }
      await c.sender.send('init_vault', [initVaultIx(c.pdas, c.p.admin, c.p.usdcMint)])
    },
  },
  {
    id: '5-endpoint',
    title: 'endpoint: send library, receive library, nonce',
    async run(c) {
      const store = c.pdas.store
      const [slc, rlc, nonce] = await c.rpc.getAccounts([
        lzPda.sendLibraryConfig(store, c.p.hubEid),
        lzPda.receiveLibraryConfig(store, c.p.hubEid),
        lzPda.nonce(store, c.p.hubEid, c.p.hubAdapter),
      ])
      const ixs: TransactionInstruction[] = []
      if (!slc) ixs.push(initSendLibraryIx(c.p.admin, store, c.p.hubEid))
      if (!rlc) ixs.push(initReceiveLibraryIx(c.p.admin, store, c.p.hubEid))
      if (!nonce) ixs.push(initNonceIx(c.p.admin, store, c.p.hubEid, c.p.hubAdapter))
      if (!ixs.length) c.log('endpoint already wired')
      else await c.sender.send('endpoint init_send_library / init_receive_library / init_nonce', ixs)

      // pin both libraries to what the endpoint's defaults name today
      if (c.p.pinLibraries === false) return c.log('libraries left on the endpoint defaults (pinLibraries = false)')
      const [dslc, drlc] = await c.rpc.getAccounts([
        lzPda.defaultSendLibraryConfig(c.p.hubEid),
        lzPda.defaultReceiveLibraryConfig(c.p.hubEid),
      ])
      if (!dslc || !drlc) throw new Error(`the endpoint has no default libraries for eid ${c.p.hubEid}: the pathway does not exist`)
      const sendLib = decodeSendLibraryConfig(dslc.data).messageLib
      const recvLib = decodeReceiveLibraryConfig(drlc.data).messageLib
      const ownSend = slc ? namedLib(decodeSendLibraryConfig(slc.data).messageLib) : null
      const ownRecv = rlc ? namedLib(decodeReceiveLibraryConfig(rlc.data).messageLib) : null
      const pins: TransactionInstruction[] = []
      if (!ownSend) pins.push(setSendLibraryIx(c.p.admin, store, c.p.hubEid, sendLib))
      else if (!ownSend.equals(sendLib)) c.log(`send library pinned to ${ownSend.toBase58()} (the default is now ${sendLib.toBase58()}): left as it is`)
      if (!ownRecv) pins.push(setReceiveLibraryIx(c.p.admin, store, c.p.hubEid, recvLib))
      else if (!ownRecv.equals(recvLib)) c.log(`receive library pinned to ${ownRecv.toBase58()} (the default is now ${recvLib.toBase58()}): left as it is`)
      if (!pins.length) return c.log('libraries already pinned')
      await c.sender.send(`endpoint set_send_library / set_receive_library (pin ${sendLib.toBase58()})`, pins)
    },
  },
  {
    id: '6-verifiers',
    title: 'the verifier set (ULN send and receive configs)',
    async run(c) {
      const send = desiredUln(c.p, c.p.sendConfirmations)
      const recv = desiredUln(c.p, c.p.receiveConfirmations)
      if (!send || !recv) return c.log('no verifier set given: the pathway default stays')
      const store = c.pdas.store
      const [sc, rc] = await c.rpc.getAccounts([lzPda.sendConfig(c.p.hubEid, store), lzPda.receiveConfig(c.p.hubEid, store)])
      const ixs: TransactionInstruction[] = []
      if (!sc || !rc) ixs.push(initUlnConfigIx(c.p.admin, c.p.admin, store, c.p.hubEid))
      const cs = sc ? decodeSendConfig(sc.data).uln : null
      const cr = rc ? decodeReceiveConfig(rc.data) : null
      if (!cs || !sameUln(cs, send)) {
        ixs.push(setUlnConfigIx(c.p.admin, store, c.p.hubEid, CONFIG_TYPE.SEND_ULN, encodeUlnConfig(send.confirmations, send.requiredDvns, send.optionalDvns, send.optionalDvnThreshold)))
      }
      if (!cr || !sameUln(cr, recv)) {
        ixs.push(setUlnConfigIx(c.p.admin, store, c.p.hubEid, CONFIG_TYPE.RECEIVE_ULN, encodeUlnConfig(recv.confirmations, recv.requiredDvns, recv.optionalDvns, recv.optionalDvnThreshold)))
      }
      if (!ixs.length) return c.log('verifier set already in place')
      // one instruction per transaction: set_config carries 4 DVN keys and
      // 12 accounts; together they would crowd the 1,232 bytes
      for (const ix of ixs) await c.sender.send(`uln ${ix === ixs[0] && (!sc || !rc) ? 'init_config' : 'set_config'}`, [ix])
    },
  },
  {
    id: '7-table-fill',
    title: 'fill the lookup table',
    async run(c) {
      if (!c.state.table) return c.log('no table: skipped (sends will not fit a transaction without one)')
      const want = await tableAddresses(c)
      const t = await getLookupTable(c.rpc, c.state.table)
      const have = new Set((t?.state.addresses ?? []).map((k) => k.toBase58()))
      const missing = want.filter((k) => !have.has(k.toBase58()))
      if (!missing.length) return c.log(`table holds all ${want.length} static addresses`)
      for (const ix of extendLookupTableIxs(c.state.table, c.p.admin, c.p.admin, missing)) {
        await c.sender.send('extend lookup table', [ix])
      }
      c.log(`table: ${have.size} → ${have.size + missing.length} addresses`)
      await c.sender.settle?.()
    },
  },
  {
    id: '7b-table-freeze',
    title: 'freeze the lookup table (nobody can extend or close it again)',
    async run(c) {
      if (!c.state.table) return c.log('no table: skipped')
      if (c.p.freezeTable === false) {
        return c.log(`table left under the authority of ${c.p.admin.toBase58()} (freezeTable = false): that key can CLOSE it and stall deliveries`)
      }
      const t = await getLookupTable(c.rpc, c.state.table)
      if (!t) {
        if (c.sender.dryRun) return c.log('(dry run: the table would be frozen once created and filled)')
        throw new Error(`table ${c.state.table.toBase58()} does not exist`)
      }
      if (!t.state.authority) return c.log('table already frozen')
      const have = new Set(t.state.addresses.map((k) => k.toBase58()))
      const missing = (await tableAddresses(c)).filter((k) => !have.has(k.toBase58()))
      if (missing.length && !c.sender.dryRun) throw new Error(`the table lacks ${missing.length} addresses: refusing to freeze it`)
      if (!t.state.authority.equals(c.p.admin)) {
        return c.log(`the table belongs to ${t.state.authority.toBase58()}, not to this admin: it must freeze it`)
      }
      await c.sender.send('freeze lookup table', [
        AddressLookupTableProgram.freezeLookupTable({ lookupTable: c.state.table, authority: c.p.admin }),
      ])
    },
  },
  {
    id: '8-roles',
    title: 'operator, guardian, fee config, deposit cap, pause',
    async run(c) {
      const f = c.p.fee
      if (f.tradeLegs > MAX_TRADE_LEGS || f.spawnLegs > MAX_SPAWN_LEGS || f.returnUnit > MAX_RETURN_UNIT || f.gasToHub <= 0n) {
        throw new Error('fee config out of the program bounds (set_fee_config would refuse it)')
      }
      const openLegs = c.p.openLegs ?? 1
      if (openLegs < 0 || openLegs > MAX_OPEN_LEGS) throw new Error(`open legs out of the program bounds (≤ ${MAX_OPEN_LEGS})`)
      for (const m of c.p.moveLegs ?? []) {
        if (m.legs < 0 || m.legs > MAX_MOVE_LEGS) throw new Error(`move legs toward chain ${m.dstChain} out of the program bounds (≤ ${MAX_MOVE_LEGS})`)
        if (m.dstChain === SOLANA_LABEL || m.dstChain === 0) throw new Error(`chain ${m.dstChain} is not a destination for a claim`)
      }
      const s = await readStore(c)
      const a = c.p.admin
      const ixs: TransactionInstruction[] = []
      if (c.p.operator && !(s && s.operator.equals(c.p.operator))) ixs.push(governIx.setOperator(c.pdas, a, c.p.operator))
      if (c.p.guardian && !(s && s.guardian.equals(c.p.guardian))) ixs.push(governIx.setGuardian(c.pdas, a, c.p.guardian))
      const feeSet =
        s && s.gasToHub === f.gasToHub && s.returnUnit === f.returnUnit && s.tradeLegs === f.tradeLegs && s.spawnLegs === f.spawnLegs
      if (!feeSet) ixs.push(governIx.setFeeConfig(c.pdas, a, f))
      if (!(s && s.depositCap === c.p.depositCap)) ixs.push(governIx.setDepositCap(c.pdas, a, c.p.depositCap))
      // (a fresh store has open_legs = 1: nothing to send for the default)
      if ((s ? s.openLegs : 1) !== openLegs) ixs.push(governIx.setOpenLegs(c.pdas, a, openLegs))
      const routes = c.p.moveLegs ?? []
      const have = await c.rpc.getAccounts(routes.map((m) => c.pdas.moveRoute(m.dstChain)))
      routes.forEach((m, i) => {
        const cur = have[i] ? decodeMoveRoute(have[i]!.data).legs : 0
        if (cur !== m.legs) ixs.push(setMoveLegsIx(c.pdas, a, m.dstChain, m.legs))
      })
      // a store is born paused
      const paused = s ? s.paused : true
      if (c.p.leavePaused && !paused) ixs.push(governIx.pause(c.pdas, a))
      if (!c.p.leavePaused && paused) ixs.push(governIx.unpause(c.pdas, a))
      if (!ixs.length) return c.log('roles and fee settings already in place')
      await c.sender.send(`roles / fee config / deposit cap / legs / ${c.p.leavePaused ? 'paused' : 'unpaused'}`, ixs)
    },
  },
  {
    id: '8b-cctp-peers',
    title: 'CCTP peer vaults (each named once, for good)',
    async run(c) {
      const peers = c.p.cctpPeers ?? []
      if (!peers.length) return c.log('no CCTP peer given: skipped (the vault cannot be levelled outward until one is named)')
      const have = await c.rpc.getAccounts(peers.map((p) => c.pdas.cctpPeer(p.label)))
      const ixs: TransactionInstruction[] = []
      peers.forEach((p, i) => {
        if (p.vault.length !== 32) throw new Error(`the peer vault of chain ${p.label} must be 32 bytes (an EVM address left-padded)`)
        if (!have[i]) return ixs.push(setCctpPeerIx(c.pdas, c.p.admin, p.label, p.domain, p.vault))
        const cur = decodeCctpPeer(have[i]!.data)
        if (cur.domain !== p.domain || !equalBytes(cur.vault, p.vault)) {
          throw new Error(`chain ${p.label} already has a CCTP peer (domain ${cur.domain}, ${bytesToHex(cur.vault)}) and a peer is never re-aimed`)
        }
      })
      if (!ixs.length) return c.log('CCTP peers already named')
      await c.sender.send(`set_cctp_peer × ${ixs.length}`, ixs)
    },
  },
  {
    id: '9-tank',
    title: 'fund the tank',
    async run(c) {
      const a = await getAccount(c.rpc, c.pdas.gasTank)
      const have = BigInt(a?.lamports ?? 0)
      if (have >= c.p.tankLamports) return c.log(`tank holds ${have} lamports`)
      const ix = SystemProgram.transfer({ fromPubkey: c.p.admin, toPubkey: c.pdas.gasTank, lamports: c.p.tankLamports - have })
      await c.sender.send(`fund tank ${c.pdas.gasTank.toBase58()} with ${c.p.tankLamports - have} lamports`, [ix])
    },
  },
  {
    id: '10-admin',
    title: 'transfer_admin to the multisig, accept_admin from it',
    async run(c) {
      const n = c.p.newAdmin
      if (!n) return c.log('no new admin given: skipped')
      const s = await readStore(c)
      if (s && s.admin.equals(n)) return c.log('admin already transferred')
      if (!(s && s.pendingAdmin.equals(n))) await c.sender.send('transfer_admin', [governIx.transferAdmin(c.pdas, c.p.admin, n)])
      const accept = governIx.acceptAdmin(c.pdas, n)
      if (c.newAdminSigner && c.newAdminSigner.publicKey.equals(n)) {
        await c.sender.send('accept_admin (signed by the new admin)', [accept], [c.newAdminSigner])
      } else {
        c.log(
          `accept_admin must be signed by ${n.toBase58()} (the multisig) — propose this instruction:\n` +
            describeIx(accept),
        )
      }
    },
  },
]

export function describeIx(ix: TransactionInstruction): string {
  const lines = [`  program ${ix.programId.toBase58()}`, `  data    ${bytesToHex(ix.data, false)}`]
  ix.keys.forEach((k, i) => lines.push(`  [${String(i).padStart(2)}] ${k.isSigner ? 's' : '-'}${k.isWritable ? 'w' : '-'} ${k.pubkey.toBase58()}`))
  return lines.join('\n')
}

export async function runWiring(
  p: WiringParams,
  rpc: GatewayRpc,
  sender: StepSender,
  log: Log,
  o: { only?: string[]; newAdminSigner?: Signer } = {},
): Promise<WiringState> {
  const c: StepContext = {
    p,
    rpc,
    sender,
    pdas: new GatewayPdas(p.programId ?? PROGRAM_ID),
    state: { table: p.table ?? null },
    log,
    newAdminSigner: o.newAdminSigner,
  }
  for (const step of STEPS) {
    if (o.only && !o.only.some((x) => step.id.startsWith(x))) continue
    log(`\n== step ${step.id}: ${step.title}`)
    await step.run(c)
  }
  return c.state
}
