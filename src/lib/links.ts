import type { CreatureLinks } from '../store'

export type LinkKind = keyof CreatureLinks

export const LINK_META: {
  kind: LinkKind
  label: string
  chip: string
  placeholder: string
}[] = [
  { kind: 'website', label: 'WEBSITE', chip: '🌐 WEBSITE', placeholder: 'yourmeme.lol' },
  { kind: 'x', label: 'X / TWITTER', chip: '𝕏 TWITTER', placeholder: '@turbopickle' },
  { kind: 'telegram', label: 'TELEGRAM', chip: '✈ TELEGRAM', placeholder: 't.me/turbopickle' },
]

/** Turn whatever the user typed into a clickable URL. */
export function linkHref(kind: LinkKind, value: string): string {
  const v = value.trim()
  if (/^https?:\/\//i.test(v)) return v
  if (kind === 'x') return `https://x.com/${v.replace(/^@/, '')}`
  if (kind === 'telegram') return `https://t.me/${v.replace(/^t\.me\//i, '')}`
  return `https://${v}`
}

/** Trim everything; return undefined when no link was given at all. */
export function cleanLinks(links: CreatureLinks): CreatureLinks | undefined {
  const out: CreatureLinks = {}
  for (const { kind } of LINK_META) {
    const v = links[kind]?.trim()
    if (v) out[kind] = v
  }
  return Object.keys(out).length ? out : undefined
}
