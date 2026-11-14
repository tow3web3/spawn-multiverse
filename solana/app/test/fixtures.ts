/**
 * The deployment every live test starts from: a fresh LiteSVM world wired
 * by the wiring steps themselves (app/src/wiring.ts), with the parameters
 * V7.md §6 gives — a FICTITIOUS hub (the V7 hub addresses belong to a
 * retired deployment and are parameters anyway).
 */
import { Keypair, PublicKey } from '@solana/web3.js'
import { CLUSTERS, EID, WiringParams, hexToBytes, runWiring, toBytes32 } from '../src'
import { World, fixtureDvn } from './harness'

export const HUB_EID = EID.BASE
/** Fictitious hub pad / adapter (EVM addresses), left-padded. */
export const HUB_PAD = toBytes32('0x' + 'a1'.repeat(20))
export const HUB_ADAPTER = toBytes32('0x' + 'b2'.repeat(20))
export const GAS_TO_HUB = 4_600_000n
/** 0.0002 ETH, the reply leg the Rust tests price. */
export const RETURN_UNIT = 200_000_000_000_000n
export const SPAWN_LEGS = 3
export const ONE = 1_000_000n

export function ourVerifiers() {
  return {
    required: [fixtureDvn('LayerZero Labs'), fixtureDvn('Google')],
    optional: [fixtureDvn('Horizen'), fixtureDvn('Twinstake')],
    threshold: 1,
  }
}

export function wiringParams(admin: PublicKey, o: Partial<WiringParams> = {}): WiringParams {
  return {
    cluster: 'localnet',
    hubEid: HUB_EID,
    hubPad: HUB_PAD,
    hubAdapter: HUB_ADAPTER,
    usdcMint: CLUSTERS['mainnet-beta'].usdcMint,
    admin,
    verifiers: ourVerifiers(),
    sendConfirmations: 32n,
    receiveConfirmations: 10n,
    operator: Keypair.generate().publicKey,
    guardian: Keypair.generate().publicKey,
    fee: { gasToHub: GAS_TO_HUB, returnUnit: RETURN_UNIT, tradeLegs: 1, spawnLegs: SPAWN_LEGS },
    depositCap: 25_000n * ONE,
    leavePaused: true,
    tankLamports: 1_000_000_000n,
    ...o,
  }
}

export async function wiredWorld(o: Partial<WiringParams> = {}) {
  const w = new World()
  const admin = w.newUser(100_000_000_000n)
  const params = wiringParams(admin.publicKey, o)
  const sent: string[] = []
  const lines: string[] = []
  const state = await runWiring(params, w.rpc(), w.sender(admin, sent), (l) => lines.push(l))
  return { w, admin, params, sent, lines, state }
}

export { hexToBytes }
