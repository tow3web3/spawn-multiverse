/**
 * The little the client needs from a cluster, behind one interface, so the
 * same code runs against an RPC node (devnet, mainnet-beta reads, a local
 * validator) and against LiteSVM in the tests.
 */
import { AddressLookupTableAccount, Commitment, Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'

export interface AccountData {
  owner: PublicKey
  data: Uint8Array
  lamports: number
  executable: boolean
}

export interface SimResult {
  err: unknown | null
  logs: string[]
  unitsConsumed?: number
  /** The program's return data (`set_return_data`), if any. */
  returnData?: Uint8Array
}

export interface GatewayRpc {
  getAccounts(keys: PublicKey[]): Promise<(AccountData | null)[]>
  simulate(tx: VersionedTransaction): Promise<SimResult>
  latestBlockhash(): Promise<string>
  /** A recent slot, for `createLookupTable`. */
  slot(): Promise<number>
}

export async function getAccount(rpc: GatewayRpc, key: PublicKey): Promise<AccountData | null> {
  return (await rpc.getAccounts([key]))[0]
}

export async function getLookupTable(rpc: GatewayRpc, key: PublicKey): Promise<AddressLookupTableAccount | null> {
  const acc = await getAccount(rpc, key)
  if (!acc) return null
  return new AddressLookupTableAccount({ key, state: AddressLookupTableAccount.deserialize(acc.data) })
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Wraps a web3.js Connection. Only reads and simulations: sending is the
 * caller's business (a wallet adapter in the site, `Sender` in scripts). */
export function connectionRpc(conn: Connection, commitment: Commitment = 'confirmed'): GatewayRpc {
  return {
    async getAccounts(keys) {
      const out: (AccountData | null)[] = []
      for (let i = 0; i < keys.length; i += 100) {
        const infos = await conn.getMultipleAccountsInfo(keys.slice(i, i + 100), commitment)
        for (const a of infos) {
          out.push(
            a ? { owner: a.owner, data: new Uint8Array(a.data), lamports: a.lamports, executable: a.executable } : null,
          )
        }
      }
      return out
    },
    async simulate(tx) {
      const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment })
      const v = r.value
      return {
        err: v.err,
        logs: v.logs ?? [],
        unitsConsumed: v.unitsConsumed,
        returnData: v.returnData?.data ? fromBase64(v.returnData.data[0]) : undefined,
      }
    },
    async latestBlockhash() {
      return (await conn.getLatestBlockhash(commitment)).blockhash
    },
    async slot() {
      return conn.getSlot('finalized')
    },
  }
}
