import { useChainSet } from '../lib/liveChains'

export function Sparkle({
  className = '',
  size = 24,
  fill = '#fff',
  style,
}: {
  className?: string
  size?: number
  fill?: string
  style?: React.CSSProperties
}) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} style={style} aria-hidden="true">
      <path
        d="M12 1C13.1 7.9 16.1 10.9 23 12C16.1 13.1 13.1 16.1 12 23C10.9 16.1 7.9 13.1 1 12C7.9 10.9 10.9 7.9 12 1Z"
        fill={fill}
        stroke="#141414"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Asterisk({ className = '', size = 24, color = '#141414' }: { className?: string; size?: number; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <g stroke={color} strokeWidth="3.4" strokeLinecap="round">
        <line x1="12" y1="2.5" x2="12" y2="21.5" />
        <line x1="3.8" y1="7.25" x2="20.2" y2="16.75" />
        <line x1="20.2" y1="7.25" x2="3.8" y2="16.75" />
      </g>
    </svg>
  )
}

export function ChainDots({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const cls =
    size === 'sm'
      ? 'h-5 min-w-5 px-0.5 text-[8px] border-2'
      : 'h-7 min-w-7 px-1 text-[10px] border-2'
  // only the chains this mode really runs (a deployment may run fewer than six)
  const { live } = useChainSet()
  return (
    <div className="flex items-center -space-x-1">
      {live.map((c) => (
        <span
          key={c.id}
          title={c.label}
          className={`${cls} inline-flex items-center justify-center rounded-full border-ink font-mono font-bold text-ink`}
          style={{ background: c.color }}
        >
          {c.short}
        </span>
      ))}
    </div>
  )
}

export function Pill({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border-2 border-ink bg-white px-3 py-1 font-mono text-[10px] font-bold tracking-wide shadow-brutal-sm ${className}`}
    >
      {children}
    </span>
  )
}
