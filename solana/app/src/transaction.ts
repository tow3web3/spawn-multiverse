/**
 * Assembly: a v0 transaction compiled against the gateway's address lookup
 * table, with an explicit compute budget. A send is ~40 accounts — 1,500
 * bytes as a legacy transaction — and only fits Solana's 1,232 bytes with
 * a table (V7.md §1).
 */
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Message,
  MessageV0,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

export const MAX_TX_BYTES = 1232

export interface AssembleOptions {
  payer: PublicKey
  instructions: TransactionInstruction[]
  recentBlockhash: string
  lookupTables?: AddressLookupTableAccount[]
  /** Compute-unit limit (none = the runtime default of 200k per instruction). */
  computeUnits?: number
  /** Priority fee in micro-lamports per CU (none = no priority fee). */
  microLamportsPerCu?: number
}

export function computeBudgetIxs(computeUnits?: number, microLamportsPerCu?: number): TransactionInstruction[] {
  const out: TransactionInstruction[] = []
  if (computeUnits) out.push(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }))
  if (microLamportsPerCu) out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamportsPerCu }))
  return out
}

/** An unsigned v0 transaction (signature slots zero-filled). */
export function assembleV0(o: AssembleOptions): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: o.payer,
    recentBlockhash: o.recentBlockhash,
    instructions: [...computeBudgetIxs(o.computeUnits, o.microLamportsPerCu), ...o.instructions],
  }).compileToV0Message(o.lookupTables ?? [])
  return new VersionedTransaction(message)
}

const compactLen = (n: number) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3)

/** Wire size of a compiled message plus its signatures, computed from its
 * fields — web3.js refuses to serialize anything over 1,232 bytes, and the
 * point is often to measure exactly that. */
export function compiledSize(m: MessageV0 | Message): number {
  const sigs = m.header.numRequiredSignatures
  let n = compactLen(sigs) + 64 * sigs + 3 + compactLen(m.staticAccountKeys.length) + 32 * m.staticAccountKeys.length + 32
  n += compactLen(m.compiledInstructions.length)
  for (const ix of m.compiledInstructions) {
    n += 1 + compactLen(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length + compactLen(ix.data.length) + ix.data.length
  }
  if (m.version === 0) {
    n += 1 + compactLen(m.addressTableLookups.length)
    for (const l of m.addressTableLookups) {
      n += 32 + compactLen(l.writableIndexes.length) + l.writableIndexes.length + compactLen(l.readonlyIndexes.length) + l.readonlyIndexes.length
    }
  }
  return n
}

/** Wire size of a transaction, signatures included. */
export function txSize(tx: VersionedTransaction): number {
  return compiledSize(tx.message as MessageV0)
}

/** The size the same instructions would take as a legacy transaction —
 * for the record (it is what forces the table). */
export function legacySize(o: AssembleOptions): number {
  return compiledSize(
    new TransactionMessage({
      payerKey: o.payer,
      recentBlockhash: o.recentBlockhash,
      instructions: [...computeBudgetIxs(o.computeUnits, o.microLamportsPerCu), ...o.instructions],
    }).compileToLegacyMessage(),
  )
}

export function assertFits(tx: VersionedTransaction, what = 'transaction'): number {
  const n = txSize(tx)
  if (n > MAX_TX_BYTES) throw new Error(`${what} is ${n} bytes, over Solana's ${MAX_TX_BYTES}`)
  return n
}

/* ---------------------------- lookup tables ---------------------------- */

export function createLookupTableIx(authority: PublicKey, payer: PublicKey, recentSlot: number) {
  const [ix, address] = AddressLookupTableProgram.createLookupTable({ authority, payer, recentSlot })
  return { ix, address }
}

/** Extend instructions in chunks that each fit one transaction (~20
 * addresses per extend keeps a single-signer transaction well under the
 * limit). */
export function extendLookupTableIxs(
  table: PublicKey,
  authority: PublicKey,
  payer: PublicKey,
  addresses: PublicKey[],
  chunk = 20,
): TransactionInstruction[] {
  const out: TransactionInstruction[] = []
  for (let i = 0; i < addresses.length; i += chunk) {
    out.push(
      AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority, payer, addresses: addresses.slice(i, i + chunk) }),
    )
  }
  return out
}
