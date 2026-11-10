export function fmtPrice(p: number): string {
  if (p >= 1) return `$${p.toFixed(2)}`
  if (p >= 0.01) return `$${p.toFixed(4)}`
  return `$${p.toFixed(7)}`
}

export function fmtMoney(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  if (n >= 1) return `$${n.toFixed(0)}`
  if (n >= 0.01) return `$${n.toFixed(2)}`
  if (n > 0) return `$${n.toFixed(4)}`
  return '$0'
}

export function fmtChange(c: number): string {
  return `${c >= 0 ? '+' : ''}${c.toFixed(2)}%`
}

export function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

export function fmtUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(0)
}

export function timeShort(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h`
}

export function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s AGO`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m AGO`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h AGO`
  return `${Math.floor(h / 24)}d AGO`
}

export function creatureNum(n: number): string {
  return `#${String(n).padStart(3, '0')}`
}

/** Narrow a bytes32 actor (protocol v5 wire identity) to its EVM address
 * when it is EVM-shaped (top 12 bytes zero); a wide Solana-style identity
 * keeps all 32 bytes. Lowercase either way. */
export function narrowActor(b: string): string {
  const h = b.toLowerCase()
  if (h.length === 66 && h.startsWith('0x' + '0'.repeat(24))) return '0x' + h.slice(26)
  return h
}

/** Display an actor from either world: EVM addresses shorten the usual way,
 * wide (Solana-style) identities wear a 🟣 marker. */
export function fmtActor(a: string): string {
  const n = narrowActor(a)
  if (n.length <= 42) return `${n.slice(0, 6)}…${n.slice(-4)}`
  return `🟣 ${n.slice(2, 6)}…${n.slice(-4)}`
}
