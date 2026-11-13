import React from 'react'
import { AbsoluteFill, interpolate, random, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { B, C, FONT } from './theme'

/** Slam-in: nothing before `at`, then overshoot from big to rest on a stiff spring. No fades. */
export const useSlam = (at: number, opts: { from?: number; stiffness?: number; damping?: number } = {}) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const s = spring({
    frame: frame - at,
    fps,
    config: { stiffness: opts.stiffness ?? 380, damping: opts.damping ?? 15, mass: 0.7 },
  })
  return { visible: frame >= at, p: s, scale: interpolate(s, [0, 1], [opts.from ?? 1.45, 1]) }
}

/** Slide-in from a side, hard settle. Returns a CSS translate. */
export const useSlide = (at: number, from: 'left' | 'right' | 'top' | 'bottom', distance = 900) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const s = spring({ frame: frame - at, fps, config: { stiffness: 260, damping: 17, mass: 0.8 } })
  const d = interpolate(s, [0, 1], [distance, 0])
  const tr =
    from === 'left' ? `translateX(${-d}px)` : from === 'right' ? `translateX(${d}px)` : from === 'top' ? `translateY(${-d}px)` : `translateY(${d}px)`
  return { visible: frame >= at, transform: tr, p: s }
}

/** A deterministic hard shake (px) that decays over `len` frames after `at`. */
export const shake = (frame: number, at: number, len: number, amp: number) => {
  const k = frame - at
  if (k < 0 || k >= len) return { x: 0, y: 0, r: 0 }
  const decay = 1 - k / len
  return {
    x: (random(`sx${k}`) * 2 - 1) * amp * decay,
    y: (random(`sy${k}`) * 2 - 1) * amp * decay,
    r: (random(`sr${k}`) * 2 - 1) * 1.2 * decay,
  }
}

type Variant = 'ink' | 'lime' | 'cream' | 'pink' | 'void'
const VARIANT: Record<Variant, { bg: string; fg: string }> = {
  ink: { bg: C.ink, fg: C.cream },
  void: { bg: C.void, fg: C.lime },
  lime: { bg: C.lime, fg: C.ink },
  cream: { bg: C.cream, fg: C.ink },
  pink: { bg: C.hot, fg: C.ink },
}

/** Big Anton title on a solid block with an ink border and a hard shadow. */
export const TitleBlock: React.FC<{
  text: string
  at: number
  variant?: Variant
  size?: number
  maxWidth?: number
  rotate?: number
  style?: React.CSSProperties
  /** hide from this frame on (hard cut to the next title) */
  until?: number
}> = ({ text, at, variant = 'ink', size = 96, maxWidth = 1500, rotate = -1, style, until }) => {
  const frame = useCurrentFrame()
  const { visible, scale } = useSlam(at, { from: 1.25 })
  if (!visible || (until !== undefined && frame >= until)) return null
  const v = VARIANT[variant]
  return (
    <div
      style={{
        position: 'absolute',
        maxWidth,
        background: v.bg,
        color: v.fg,
        fontFamily: FONT.title,
        fontSize: size,
        lineHeight: 1.02,
        textTransform: 'uppercase',
        letterSpacing: '0.01em',
        padding: `${size * 0.16}px ${size * 0.3}px ${size * 0.2}px`,
        border: `${B.border}px solid ${C.ink}`,
        borderRadius: B.radiusSm,
        boxShadow: B.shadow(12),
        transform: `rotate(${rotate}deg) scale(${scale})`,
        transformOrigin: 'left center',
        ...style,
      }}
    >
      {text}
    </div>
  )
}

/** Flat mono chip: uppercase, wide tracking, thick border, hard shadow. */
export const Chip: React.FC<{
  children: React.ReactNode
  bg?: string
  fg?: string
  size?: number
  style?: React.CSSProperties
  shadow?: number
}> = ({ children, bg = C.cream, fg = C.ink, size = 30, style, shadow = 8 }) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: size * 0.45,
      background: bg,
      color: fg,
      fontFamily: FONT.mono,
      fontWeight: 700,
      fontSize: size,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      padding: `${size * 0.32}px ${size * 0.6}px`,
      border: `${size >= 26 ? B.border : B.borderThin}px solid ${C.ink}`,
      borderRadius: 999,
      boxShadow: B.shadow(shadow),
      whiteSpace: 'nowrap',
      ...style,
    }}
  >
    {children}
  </div>
)

/** Mono typewriter line on an ink tab (top-left timestamps). */
export const Typewriter: React.FC<{ text: string; at: number; cps: number; style?: React.CSSProperties }> = ({ text, at, cps, style }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  if (frame < at) return null
  const n = Math.min(text.length, Math.floor(((frame - at) / fps) * cps) + 1)
  const cursorOn = Math.floor(frame / 8) % 2 === 0 || n < text.length
  return (
    <div
      style={{
        position: 'absolute',
        left: 64,
        top: 56,
        background: C.ink,
        color: C.lime,
        fontFamily: FONT.mono,
        fontWeight: 700,
        fontSize: 32,
        letterSpacing: '0.14em',
        padding: '12px 20px',
        borderRadius: 8,
        border: `3px solid ${C.ink}`,
        whiteSpace: 'pre',
        ...style,
      }}
    >
      {text.slice(0, n)}
      <span style={{ opacity: cursorOn ? 1 : 0 }}>▌</span>
    </div>
  )
}

/** A rotated rubber stamp that slams in from huge. */
export const Stamp: React.FC<{ text: string; at: number; color?: string; size?: number; rotate?: number; style?: React.CSSProperties }> = ({
  text,
  at,
  color = C.hot,
  size = 150,
  rotate = -9,
  style,
}) => {
  const { visible, scale } = useSlam(at, { from: 2.6, stiffness: 520, damping: 18 })
  if (!visible) return null
  return (
    <div
      style={{
        position: 'absolute',
        fontFamily: FONT.title,
        fontSize: size,
        lineHeight: 1,
        color: C.ink,
        background: color,
        padding: `${size * 0.08}px ${size * 0.22}px ${size * 0.1}px`,
        border: `${B.border + 2}px solid ${C.ink}`,
        borderRadius: B.radiusSm,
        boxShadow: B.shadow(14),
        letterSpacing: '0.03em',
        transform: `translate(-50%, -50%) rotate(${rotate}deg) scale(${scale})`,
        ...style,
      }}
    >
      {text}
    </div>
  )
}

/** Film grain + vignette so the graphics sit in the clay world. */
export const Grain: React.FC<{ frozen?: boolean }> = ({ frozen }) => {
  const frame = useCurrentFrame()
  const seed = frozen ? 7 : frame % 24
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, mixBlendMode: 'overlay', opacity: 0.22 }}>
        <filter id={`grain${seed}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={seed} stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#grain${seed})`} />
      </svg>
      <AbsoluteFill style={{ boxShadow: 'inset 0 0 260px 40px rgba(0,0,0,0.55)' }} />
    </AbsoluteFill>
  )
}

/** A check mark drawn (Space Mono has no ✓ glyph we can trust). */
export const Check: React.FC<{ size: number; color?: string }> = ({ size, color = C.up }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block', flexShrink: 0 }}>
    <path d="M4 12.5l5 5L20 6.5" fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
