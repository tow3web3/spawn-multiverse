/**
 * The deployment wiring of V7.md §6, steps 2–10, as idempotent steps: each
 * one reads the chain, sends only what is missing, and says what it did.
 * Re-running after a partial run is safe. Step 1 (the program deploy) is
 * checked, never performed.
 *
 * ORDER CHANGE vs V7.md §6: `init_store` (step 2) stores the lookup table
 * the executor will use and requires the table to exist (owner check), and
 * the program has no instruction to set it later. So the table is CREATED
 * first (step 2a, empty) and FILLED at step 7, once the verifier set is
 * known.
 */
import {
  AddressLookupTableAccount,
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
  MAX_RETURN_UNIT,
  MAX_SPAWN_LEGS,
  MAX_TRADE_LEGS,
  PROGRAM_ID,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from './constants'
import { bytesToHex, equalBytes } from './bytes'
import { Store, decodeLzReceiveTypesAccounts, decodePeerConfig, decodeStore } from './accounts'
import {
  CONFIG_TYPE,
  UlnConfig,
  compareKeys,
  decodeReceiveConfig,
  decodeSendConfig,
  encodeUlnConfig,
  initNonceIx,
  initReceiveLibraryIx,
  initSendLibraryIx,
  initUlnConfigIx,
  resolveSendPath,
  sendStaticAddresses,
  setUlnConfigIx,
} from './layerzero'
import { governIx, initStoreIx, initVaultIx, setPeerConfigIx } from './instructions'
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
  depositCap: bigint
  /** Leave the store paused at the end of step 8 (V7.md: yes, until the hub batch). */
  leavePaused: boolean
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
  ]
  return [...new Map(all.map((k) => [k.toBase58(), k])).values()]
}

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
        c.state.table = alt.equals(PublicKey.default) ? null : alt
        return c.log(
          c.state.table
            ? `the store already names table ${alt.toBase58()}`
            : 'WARNING: the store was initialised WITHOUT a table and the program cannot set one later',
        )
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
      if (!ixs.length) return c.log('endpoint already wired')
      await c.sender.send('endpoint init_send_library / init_receive_library / init_nonce', ixs)
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
    id: '8-roles',
    title: 'operator, guardian, fee config, deposit cap, pause',
    async run(c) {
      const f = c.p.fee
      if (f.tradeLegs > MAX_TRADE_LEGS || f.spawnLegs > MAX_SPAWN_LEGS || f.returnUnit > MAX_RETURN_UNIT || f.gasToHub <= 0n) {
        throw new Error('fee config out of the program bounds (set_fee_config would refuse it)')
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
      if (c.p.leavePaused && !(s && s.paused)) ixs.push(governIx.pause(c.pdas, a))
      if (!ixs.length) return c.log('roles and fee settings already in place')
      await c.sender.send('roles / fee config / deposit cap / pause', ixs)
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
