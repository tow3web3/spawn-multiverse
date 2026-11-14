/**
 * The hub → Solana direction, as LayerZero's executor sees it: ask the
 * program (`lz_receive_types_info`, then `lz_receive_types_v2`, both
 * simulated) which accounts `lz_receive` needs for a verified packet, and
 * build the instruction. LayerZero's executor does this off-chain; a client
 * needs it to execute a packet itself — a dry-tank SYNC anyone may pay
 * for (V7.md §2 row 4) — and the tests need it to deliver hub messages.
 */
import { AccountMeta, AddressLookupTableAccount, PublicKey, TransactionInstruction } from '@solana/web3.js'
import { IX } from './constants'
import { BorshReader, BorshWriter, toBuffer } from './bytes'
import { GatewayPdas } from './pda'
import { GatewayRpc, getLookupTable } from './rpc'
import { assembleV0 } from './transaction'

export interface LzReceiveParams {
  srcEid: number
  sender: Uint8Array
  nonce: bigint
  guid: Uint8Array
  message: Uint8Array
  extraData: Uint8Array
}

export function encodeLzReceiveParams(p: LzReceiveParams): Uint8Array {
  return new BorshWriter()
    .u32(p.srcEid)
    .fixed(p.sender, 32)
    .u64(p.nonce)
    .fixed(p.guid, 32)
    .bytes(p.message)
    .bytes(p.extraData)
    .done()
}

async function simulateReturn(rpc: GatewayRpc, payer: PublicKey, ix: TransactionInstruction, what: string): Promise<Uint8Array> {
  const tx = assembleV0({ payer, instructions: [ix], recentBlockhash: await rpc.latestBlockhash(), computeUnits: 1_400_000 })
  const r = await rpc.simulate(tx)
  if (r.err || !r.returnData) throw new Error(`${what} failed: ${JSON.stringify(r.err)}\n${r.logs.join('\n')}`)
  return r.returnData
}

/** The `lz_receive` account list for a packet. `payer` fills the
 * `AddressLocator::Payer` slot (the executor, or a volunteer). */
export async function resolveLzReceiveAccounts(
  rpc: GatewayRpc,
  pdas: GatewayPdas,
  params: LzReceiveParams,
  payer: PublicKey,
): Promise<{ accounts: AccountMeta[]; alts: AddressLookupTableAccount[] }> {
  const args = encodeLzReceiveParams(params)
  const info = await simulateReturn(
    rpc,
    payer,
    new TransactionInstruction({
      programId: pdas.programId,
      keys: [
        { pubkey: pdas.store, isSigner: false, isWritable: false },
        { pubkey: pdas.lzReceiveTypes, isSigner: false, isWritable: false },
      ],
      data: toBuffer(new BorshWriter().raw(IX.lz_receive_types_info).raw(args).done()),
    }),
    'lz_receive_types_info',
  )
  const ri = new BorshReader(info)
  const version = ri.u8()
  if (version !== 2) throw new Error(`lz_receive_types version ${version}, expected 2`)
  const typesAccounts = Array.from({ length: ri.u32() }, () => new PublicKey(ri.fixed(32)))

  const ret = await simulateReturn(
    rpc,
    payer,
    new TransactionInstruction({
      programId: pdas.programId,
      keys: typesAccounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
      data: toBuffer(new BorshWriter().raw(IX.lz_receive_types_v2).raw(args).done()),
    }),
    'lz_receive_types_v2',
  )
  const r = new BorshReader(ret)
  r.u8() // context_version
  const altKeys = Array.from({ length: r.u32() }, () => new PublicKey(r.fixed(32)))
  const alts: AddressLookupTableAccount[] = []
  for (const k of altKeys) {
    const t = await getLookupTable(rpc, k)
    if (!t) throw new Error(`lookup table ${k.toBase58()} named by lz_receive_types_v2 does not exist`)
    alts.push(t)
  }
  const nIx = r.u32()
  if (nIx !== 1 || r.u8() !== 0) throw new Error('expected exactly one LzReceive instruction')
  const n = r.u32()
  const accounts: AccountMeta[] = []
  for (let i = 0; i < n; i++) {
    const tag = r.u8()
    let pubkey: PublicKey
    if (tag === 0) pubkey = new PublicKey(r.fixed(32))
    else if (tag === 1) {
      const t = r.u8()
      const idx = r.u8()
      pubkey = alts[t].state.addresses[idx]
    } else if (tag === 2) pubkey = payer
    else throw new Error(`unsupported AddressLocator variant ${tag}`)
    const isWritable = r.bool()
    accounts.push({ pubkey, isWritable, isSigner: tag === 2 })
  }
  return { accounts, alts }
}

/** `lz_receive` itself, executed directly (no executor): the first three
 * resolved accounts are its named ones (payer, store, peer). */
export function lzReceiveIx(pdas: GatewayPdas, params: LzReceiveParams, accounts: AccountMeta[]): TransactionInstruction {
  return new TransactionInstruction({
    programId: pdas.programId,
    keys: accounts,
    data: toBuffer(new BorshWriter().raw(IX.lz_receive).raw(encodeLzReceiveParams(params)).done()),
  })
}
