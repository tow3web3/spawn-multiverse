import { useRef, useState } from 'react'
import { useStore } from '../store'
import { fmtChange } from '../lib/format'
import { Face } from './Faces'
import { Sparkle } from './bits'

function ChainTag({
  label,
  color,
  rot,
  delay,
  className,
}: {
  label: string
  color: string
  rot: number
  delay: string
  className: string
}) {
  return (
    <div
      className={`absolute z-20 animate-floaty-sm rounded-lg border-2 border-ink px-2.5 py-1 font-mono text-[10px] font-bold shadow-brutal-sm ${className}`}
      style={{ background: color, animationDelay: delay, ['--tag-rot' as string]: `${rot}deg` }}
    >
      {label} ✓
    </div>
  )
}

export function GenesisSim() {
  const { creatures } = useStore()
  const gloop = creatures.find((c) => c.ticker === 'GLOOP')

  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const origin = useRef({ x: 0, y: 0 })

  return (
    <div className="relative flex min-h-[460px] flex-col overflow-hidden rounded-3xl border-3 border-ink bg-void p-5 text-white shadow-brutal lg:min-h-[540px]">
      <div className="dot-grid-light pointer-events-none absolute inset-0" />

      {/* perspective grid floor */}
      <div
        className="pointer-events-none absolute -inset-x-[30%] bottom-[-12%] h-[68%] opacity-35"
        style={{
          transform: 'perspective(520px) rotateX(58deg)',
          backgroundImage:
            'linear-gradient(rgba(201,242,75,.55) 1px, transparent 1px), linear-gradient(90deg, rgba(201,242,75,.55) 1px, transparent 1px)',
          backgroundSize: '46px 46px',
          maskImage: 'linear-gradient(to top, black 25%, transparent 90%)',
          WebkitMaskImage: 'linear-gradient(to top, black 25%, transparent 90%)',
        }}
      />

      {/* header */}
      <div className="relative z-10 flex items-center justify-between font-mono text-[10px] font-bold tracking-[0.15em]">
        <span className="text-lime">
          <span className="mr-1.5 inline-block h-2 w-2 animate-blink rounded-full bg-lime align-middle" />
          GENESIS SIMULATION // LIVE
        </span>
        <span className="opacity-60">01 / ∞</span>
      </div>

      {/* chain tags */}
      <ChainTag label="SOLANA" color="#f5a8c8" rot={-7} delay="0s" className="left-[6%] top-[18%]" />
      <ChainTag label="BASE" color="#c9f24b" rot={5} delay="-1.2s" className="right-[6%] top-[22%]" />
      <ChainTag label="ETHEREUM" color="#9ccbf5" rot={-4} delay="-2.1s" className="bottom-[27%] left-[7%]" />
      <ChainTag label="BNB + 2" color="#a78bf0" rot={6} delay="-3s" className="bottom-[23%] right-[8%]" />

      {/* sparkles */}
      <Sparkle size={30} className="absolute left-[24%] top-[14%] animate-twinkle" />
      <Sparkle size={18} className="absolute right-[26%] top-[38%] animate-twinkle" style={{ animationDelay: '-0.9s' }} />
      <Sparkle size={24} className="absolute bottom-[32%] left-[30%] animate-twinkle" style={{ animationDelay: '-1.7s' }} />
      <Sparkle size={14} className="absolute right-[18%] top-[14%] animate-twinkle" style={{ animationDelay: '-2.4s' }} />

      {/* the creature — draggable */}
      <div className="relative z-10 flex flex-1 items-center justify-center">
        <div
          className="touch-none"
          style={{
            transform: drag ? `translate(${drag.x}px, ${drag.y}px)` : 'translate(0px, 0px)',
            transition: drag ? 'none' : 'transform .6s cubic-bezier(.22,1.7,.36,1)',
            cursor: drag ? 'grabbing' : 'grab',
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            origin.current = { x: e.clientX, y: e.clientY }
            setDrag({ x: 0, y: 0 })
          }}
          onPointerMove={(e) => {
            if (!drag) return
            const clamp = (v: number) => Math.max(-80, Math.min(80, v))
            setDrag({
              x: clamp(e.clientX - origin.current.x),
              y: clamp(e.clientY - origin.current.y),
            })
          }}
          onPointerUp={() => setDrag(null)}
          onPointerCancel={() => setDrag(null)}
        >
          <div className={drag ? '' : 'animate-floaty'}>
            <Face id="frog" size={200} className="drop-shadow-[0_18px_0_rgba(0,0,0,0.45)]" />
          </div>
        </div>
      </div>

      {/* vertical hint */}
      <div
        className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 font-mono text-[9px] font-bold tracking-[0.3em] opacity-40 sm:block"
        style={{ writingMode: 'vertical-rl' }}
      >
        DRAG TO DISTURB REALITY →
      </div>

      {/* footer */}
      <div className="relative z-10 flex items-end justify-between">
        <div>
          <div className="font-mono text-[9px] font-bold tracking-[0.2em] opacity-60">
            GLOBAL TOKEN // EXAMPLE
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-4xl tracking-wide">$GLOOP</span>
            <span className="font-mono text-sm font-bold text-lime">
              {gloop ? fmtChange(gloop.change) : '+420.69%'}
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[9px] font-bold tracking-[0.2em] opacity-60">
            SAME GENESIS
          </div>
          <div className="font-display text-2xl tracking-wide">
            6 CHAINS <span className="text-lime">✳</span>
          </div>
        </div>
      </div>
    </div>
  )
}
