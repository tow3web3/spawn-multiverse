import { useMemo, useRef, useState } from 'react'
import type { PricePoint } from '../store'
import { fmtPrice, timeShort } from '../lib/format'

const W = 560
const H = 160
const PAD_Y = 0.1

/**
 * Single-series global price line. The SVG carries only geometry
 * (vector-effect keeps strokes crisp under preserveAspectRatio="none");
 * all text, the hover dot and the tooltip are HTML overlays so nothing
 * stretches. Ink line + lime area; text stays in ink tokens.
 */
export function PriceChart({
  points,
  ascendedAt,
  dark = false,
  height = 'h-40',
}: {
  points: PricePoint[]
  ascendedAt?: number
  /** On dark panels the line goes lime and grid/labels go white. */
  dark?: boolean
  /** Tailwind height class for the chart box. */
  height?: string
}) {
  const inkOrLime = dark ? '#c9f24b' : '#141414'
  const gridColor = dark ? '#ffffff' : '#141414'
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)

  const now = Date.now()
  const data = useMemo(() => {
    const pts = points.length > 0 ? points : [{ ts: now, price: 0 }]
    const last = pts[pts.length - 1]
    // Extend flat to "now" so the line always reaches the right edge.
    return last.ts < now - 1500 ? [...pts, { ts: now, price: last.price }] : pts
  }, [points, now])

  const t0 = data[0].ts
  const t1 = data[data.length - 1].ts
  const span = Math.max(1, t1 - t0)
  let lo = Infinity
  let hi = -Infinity
  for (const p of data) {
    if (p.price < lo) lo = p.price
    if (p.price > hi) hi = p.price
  }
  const range = Math.max(hi - lo, hi * 0.02, 1e-12)
  const yLo = lo - range * PAD_Y
  const ySpan = range * (1 + PAD_Y * 2)

  const x = (ts: number) => ((ts - t0) / span) * W
  const y = (price: number) => H - ((price - yLo) / ySpan) * H

  const line = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)} ${y(p.price).toFixed(1)}`).join(' ')
  const area = `${line} L${W} ${H} L0 ${H} Z`

  const hovered = hover !== null ? data[hover] : null
  const hoverLeft = hovered ? (x(hovered.ts) / W) * 100 : 0
  const hoverTop = hovered ? (y(hovered.price) / H) * 100 : 0

  const onMove = (e: React.PointerEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const target = t0 + frac * span
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < data.length; i++) {
      const d = Math.abs(data[i].ts - target)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    setHover(best)
  }

  const ascLeft =
    ascendedAt && ascendedAt >= t0 && ascendedAt <= t1 ? ((ascendedAt - t0) / span) * 100 : null

  return (
    <div
      ref={wrapRef}
      className={`relative ${height} w-full cursor-crosshair touch-none select-none`}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1="0"
            x2={W}
            y1={H * f}
            y2={H * f}
            stroke={gridColor}
            strokeOpacity={dark ? 0.1 : 0.08}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path d={area} fill="#c9f24b" fillOpacity={dark ? 0.16 : 0.35} />
        <path
          d={line}
          fill="none"
          stroke={inkOrLime}
          strokeWidth="2"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {ascLeft !== null && (
          <line
            x1={(ascLeft / 100) * W}
            x2={(ascLeft / 100) * W}
            y1="0"
            y2={H}
            stroke="#a78bf0"
            strokeWidth="2"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {hovered && (
          <line
            x1={x(hovered.ts)}
            x2={x(hovered.ts)}
            y1="0"
            y2={H}
            stroke={dark ? '#ffffff' : '#141414'}
            strokeOpacity="0.35"
            strokeWidth="1"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {/* min / max labels */}
      <span className={`pointer-events-none absolute right-1 top-0.5 font-mono text-[9px] font-bold opacity-45 ${dark ? 'text-white' : ''}`}>
        {fmtPrice(hi)}
      </span>
      <span className={`pointer-events-none absolute bottom-0.5 right-1 font-mono text-[9px] font-bold opacity-45 ${dark ? 'text-white' : ''}`}>
        {fmtPrice(lo)}
      </span>
      <span className={`pointer-events-none absolute bottom-0.5 left-1 font-mono text-[9px] font-bold opacity-45 ${dark ? 'text-white' : ''}`}>
        {timeShort(t0)} AGO
      </span>

      {ascLeft !== null && (
        <span
          className="pointer-events-none absolute top-0.5 -translate-x-1/2 rounded border border-ink bg-grape px-1 font-mono text-[8px] font-bold"
          style={{ left: `${ascLeft}%` }}
        >
          ⬆ ASCENDED
        </span>
      )}

      {hovered && (
        <>
          <span
            className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink bg-lime"
            style={{ left: `${hoverLeft}%`, top: `${hoverTop}%` }}
          />
          <span
            className={`pointer-events-none absolute z-10 -translate-y-full whitespace-nowrap rounded-md border-2 border-ink bg-white px-2 py-0.5 font-mono text-[10px] font-bold shadow-brutal-sm ${
              hoverLeft > 70 ? '-translate-x-full' : ''
            }`}
            style={{ left: `${hoverLeft}%`, top: `${Math.max(hoverTop, 18)}%` }}
          >
            {fmtPrice(hovered.price)} · {timeShort(hovered.ts)} AGO
          </span>
        </>
      )}
    </div>
  )
}
