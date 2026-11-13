import type { CreatureLinks, FeeMode } from '../store'

/** The gateway refuses a launch whose metaURI is longer than this (bytes). */
export const MAX_META_BYTES = 1024

export const utf8Len = (s: string) => new TextEncoder().encode(s).length

/** What a hosted image costs in the metaURI: `/img/` + a sha256 in hex. */
export const IMAGE_PATH_SAMPLE = `/img/${'0'.repeat(64)}`

/**
 * The on-chain metaURI of a launch: its links, its fee mode, and the PATH of
 * its hosted image. The image bytes never ride on-chain — only this pointer,
 * 69 bytes — so the 1024-byte budget is left to the links.
 */
export function buildMetaURI(m: { links?: CreatureLinks; feeMode?: FeeMode; image?: string }): string {
  return JSON.stringify({ links: m.links, feeMode: m.feeMode ?? 'holders', image: m.image })
}
