import { PublicKey } from '@solana/web3.js'
import {
  ATA_PROGRAM,
  CCTP_MESSAGE_TRANSMITTER_V2,
  CCTP_TOKEN_MESSENGER_MINTER_V2,
  LZ_ENDPOINT,
  LZ_ULN,
  PROGRAM_ID,
  SEED,
  TOKEN_PROGRAM,
} from './constants'
import { uintBE } from './bytes'

const pda = (seeds: Uint8Array[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0]
const enc = (x: string) => new TextEncoder().encode(x)
const eidBE = (eid: number) => uintBE(BigInt(eid), 4)

export function asBytes32(x: Uint8Array): Uint8Array {
  if (x.length !== 32) throw new Error(`expected 32 bytes, got ${x.length}`)
  return x
}

/** Every address of the gateway, derived from its program id. */
export class GatewayPdas {
  readonly store: PublicKey
  readonly vault: PublicKey
  readonly gasTank: PublicKey
  readonly lzReceiveTypes: PublicKey

  constructor(readonly programId: PublicKey = PROGRAM_ID) {
    this.store = pda([SEED.STORE], programId)
    this.vault = pda([SEED.VAULT], programId)
    this.gasTank = pda([SEED.GAS_TANK], programId)
    this.lzReceiveTypes = pda([SEED.LZ_RECEIVE_TYPES, this.store.toBytes()], programId)
  }
  peer(remoteEid: number): PublicKey {
    return pda([SEED.PEER, this.store.toBytes(), eidBE(remoteEid)], this.programId)
  }
  replica(hubToken: Uint8Array): PublicKey {
    return pda([SEED.REPLICA, asBytes32(hubToken)], this.programId)
  }
  mint(hubToken: Uint8Array): PublicKey {
    return pda([SEED.MINT, asBytes32(hubToken)], this.programId)
  }
  escrow(hubToken: Uint8Array): PublicKey {
    return pda([SEED.ESCROW, asBytes32(hubToken)], this.programId)
  }
  user(owner: PublicKey): PublicKey {
    return pda([SEED.USER, owner.toBytes()], this.programId)
  }
  position(hubToken: Uint8Array, owner: PublicKey): PublicKey {
    return pda([SEED.POSITION, asBytes32(hubToken), owner.toBytes()], this.programId)
  }
  /** What a claim moved to `dstChain` prepays (`set_move_legs`). */
  moveRoute(dstChain: number): PublicKey {
    return pda([SEED.MOVE_ROUTE, eidBE(dstChain)], this.programId)
  }
  /** The peer vault of chain `label` for CCTP rebalancing (`set_cctp_peer`). */
  cctpPeer(label: number): PublicKey {
    return pda([SEED.CCTP_PEER, eidBE(label)], this.programId)
  }
}

/** The classic SPL associated token account (no Token-2022 here: USDC and
 * the replicas are both classic Token mints). */
export function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return pda([owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ATA_PROGRAM)
}

/* ---------------------------- LayerZero PDAs --------------------------- */

export const lzPda = {
  endpointSettings: () => pda([enc('Endpoint')], LZ_ENDPOINT),
  endpointEventAuthority: () => pda([enc('__event_authority')], LZ_ENDPOINT),
  oappRegistry: (oapp: PublicKey) => pda([enc('OApp'), oapp.toBytes()], LZ_ENDPOINT),
  sendLibraryConfig: (oapp: PublicKey, eid: number) => pda([enc('SendLibraryConfig'), oapp.toBytes(), eidBE(eid)], LZ_ENDPOINT),
  defaultSendLibraryConfig: (eid: number) => pda([enc('SendLibraryConfig'), eidBE(eid)], LZ_ENDPOINT),
  receiveLibraryConfig: (oapp: PublicKey, eid: number) =>
    pda([enc('ReceiveLibraryConfig'), oapp.toBytes(), eidBE(eid)], LZ_ENDPOINT),
  defaultReceiveLibraryConfig: (eid: number) => pda([enc('ReceiveLibraryConfig'), eidBE(eid)], LZ_ENDPOINT),
  messageLibInfo: (msglib: PublicKey) => pda([enc('MessageLib'), msglib.toBytes()], LZ_ENDPOINT),
  nonce: (oapp: PublicKey, eid: number, remote: Uint8Array) =>
    pda([enc('Nonce'), oapp.toBytes(), eidBE(eid), asBytes32(remote)], LZ_ENDPOINT),
  pendingNonce: (oapp: PublicKey, eid: number, remote: Uint8Array) =>
    pda([enc('PendingNonce'), oapp.toBytes(), eidBE(eid), asBytes32(remote)], LZ_ENDPOINT),
  payloadHash: (oapp: PublicKey, eid: number, remote: Uint8Array, nonce: bigint) =>
    pda([enc('PayloadHash'), oapp.toBytes(), eidBE(eid), asBytes32(remote), uintBE(nonce, 8)], LZ_ENDPOINT),
  /** ULN_SEED == MESSAGE_LIB_SEED: the UlnSettings PDA is the msglib PDA. */
  ulnSettings: (uln: PublicKey = LZ_ULN) => pda([enc('MessageLib')], uln),
  ulnEventAuthority: (uln: PublicKey = LZ_ULN) => pda([enc('__event_authority')], uln),
  sendConfig: (eid: number, oapp: PublicKey, uln: PublicKey = LZ_ULN) =>
    pda([enc('SendConfig'), eidBE(eid), oapp.toBytes()], uln),
  defaultSendConfig: (eid: number, uln: PublicKey = LZ_ULN) => pda([enc('SendConfig'), eidBE(eid)], uln),
  receiveConfig: (eid: number, oapp: PublicKey, uln: PublicKey = LZ_ULN) =>
    pda([enc('ReceiveConfig'), eidBE(eid), oapp.toBytes()], uln),
  defaultReceiveConfig: (eid: number, uln: PublicKey = LZ_ULN) => pda([enc('ReceiveConfig'), eidBE(eid)], uln),
  eventAuthority: (program: PublicKey) => pda([enc('__event_authority')], program),
}

/* ------------------------------ CCTP PDAs ------------------------------ */

/** Circle CCTP V2 addresses a `deposit_for_burn` needs (the seeds of
 * circlefin/solana-cctp-contracts, checked against mainnet by
 * tests/fetch-cctp.cjs). */
export const cctpPda = {
  messageTransmitter: () => pda([enc('message_transmitter')], CCTP_MESSAGE_TRANSMITTER_V2),
  tokenMessenger: () => pda([enc('token_messenger')], CCTP_TOKEN_MESSENGER_MINTER_V2),
  tokenMinter: () => pda([enc('token_minter')], CCTP_TOKEN_MESSENGER_MINTER_V2),
  senderAuthority: () => pda([enc('sender_authority')], CCTP_TOKEN_MESSENGER_MINTER_V2),
  eventAuthority: () => pda([enc('__event_authority')], CCTP_TOKEN_MESSENGER_MINTER_V2),
  remoteTokenMessenger: (domain: number) => pda([enc('remote_token_messenger'), enc(String(domain))], CCTP_TOKEN_MESSENGER_MINTER_V2),
  localToken: (mint: PublicKey) => pda([enc('local_token'), mint.toBytes()], CCTP_TOKEN_MESSENGER_MINTER_V2),
  /** Exists only if Circle denylisted `owner`. */
  denylist: (owner: PublicKey) => pda([enc('denylist_account'), owner.toBytes()], CCTP_TOKEN_MESSENGER_MINTER_V2),
}
