import React from 'react'
import { AbsoluteFill, interpolate, random, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { ChainDisc, type ChainId, Smiley } from './logos'
import { CUTS, durFrames, f, S1, S2a, S2b, S3, S4, S5, S6, S7, S7b, S8 } from './script'
import { ShotMedia } from './Shot'
import { B, C, FONT } from './theme'
import { Check, Chip, shake, TitleBlock, Typewriter, useSlam, useSlide } from './ui'

// ───────────────────────────── S1 COLD OPEN
export const Scene1: React.FC = () => (
  <AbsoluteFill>
    <ShotMedia media={S1.media} duration={durFrames('S1')} />
    <Typewriter text={S1.stamp.text} at={f(S1.stamp.at)} cps={S1.stamp.charsPerSecond} />
    <TitleBlock text={S1.title.text} at={f(S1.title.at)} variant="lime" size={124} style={{ left: 64, bottom: 84 }} />
  </AbsoluteFill>
)

// ───────────────────────────── S2a THE OLD WAY — copies
export const Scene2a: React.FC = () => (
  <AbsoluteFill>
    <ShotMedia media={S2a.media} duration={durFrames('S2a')} />
    <TitleBlock text={S2a.title.text} at={f(S2a.title.at)} variant="ink" size={100} maxWidth={1800} style={{ left: 64, bottom: 72 }} />
  </AbsoluteFill>
)

// ───────────────────────────── S2b THE OLD WAY — three prices
// Price labels in a row at the top of the frame, one above each grey copy.
// Each ticks through its own prices (script.ts): green flash on an up-tick,
// pink on a down-tick, cream otherwise. The three never agree.
const num = (p: string) => Number(p.replace('$', ''))

const PriceChip: React.FC<{ prices: readonly string[]; x: number; at: number; i: number }> = ({ prices, x, at, i }) => {
  const frame = useCurrentFrame()
  const { visible, scale } = useSlam(at, { from: 1.6 })
  if (!visible) return null
  const every = f(S2b.tickEvery)
  const k = Math.min(prices.length - 1, Math.floor((frame - at) / every))
  const since = frame - at - k * every
  const dir = k === 0 ? 0 : Math.sign(num(prices[k]) - num(prices[k - 1]))
  const flash = since < 7 && dir !== 0
  const bg = flash ? (dir > 0 ? C.up : C.hot) : C.cream
  const fg = flash && dir > 0 ? C.white : C.ink
  const bump = flash ? interpolate(since, [0, 6], [1.08, 1], { extrapolateRight: 'clamp' }) : 1
  const rot = [-3, 2, -2][i % 3]
  return (
    <div
      style={{
        position: 'absolute',
        left: `${x * 100}%`,
        top: 140,
        transform: `translate(-50%, 0) rotate(${rot}deg) scale(${scale * bump})`,
        background: bg,
        color: fg,
        fontFamily: FONT.mono,
        fontWeight: 700,
        fontSize: 60,
        lineHeight: 1,
        letterSpacing: '0.02em',
        padding: '14px 30px 16px',
        border: `${B.border}px solid ${C.ink}`,
        borderRadius: B.radius,
        boxShadow: B.shadow(10),
      }}
    >
      {prices[k]}
    </div>
  )
}

export const Scene2b: React.FC = () => (
  <AbsoluteFill>
    <ShotMedia media={S2b.media} duration={durFrames('S2b')} />
    {S2b.tags.map((t, i) => (
      <PriceChip key={i} prices={t.prices} x={t.x} at={f(t.at)} i={i} />
    ))}
    <TitleBlock text={S2b.title.text} at={f(S2b.title.at)} variant="cream" size={96} rotate={-1} style={{ left: 64, bottom: 64 }} />
  </AbsoluteFill>
)

// ───────────────────────────── S3 THE BUTTON
/** The impact's shot-local frame: where S3.impact (the drop) falls inside S3. */
export const s3ImpactFrame = () => f(S3.impact) - f(CUTS.S3[0])

export const Scene3: React.FC<{ impactAtInClip: number }> = ({ impactAtInClip }) => {
  const frame = useCurrentFrame()
  const impact = s3ImpactFrame()
  // position the clip so its impact moment lands on the drop (clip time = clipIn + t * rate)
  const clipIn = impactAtInClip - (impact / 30) * (S3.media.rate ?? 1)
  const flash = frame >= impact && frame < impact + S3.flashFrames
  const sh = shake(frame, impact, S3.flashFrames + 10, 34)
  return (
    <AbsoluteFill style={{ transform: `translate(${sh.x}px, ${sh.y}px) rotate(${sh.r}deg)` }}>
      <ShotMedia media={S3.media} duration={durFrames('S3')} clipIn={clipIn} />
      {flash && (
        <AbsoluteFill style={{ background: C.lime, alignItems: 'center', justifyContent: 'center', transform: 'scale(1.06)' }}>
          <div
            style={{
              fontFamily: FONT.title,
              fontSize: 470,
              lineHeight: 1,
              color: C.ink,
              letterSpacing: '0.01em',
              transform: `scale(${frame - impact < 2 ? 1.12 : 1})`,
            }}
          >
            {S3.wordmark}
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  )
}

// ───────────────────────────── S4 BORN EVERYWHERE
const PANEL_W = 360
const PANEL_H = Math.round((PANEL_W * 16) / 9)
const Panel: React.FC<{ i: number; chain: ChainId; label: string; media: (typeof S4.panels)[number]['media']; at: number }> = ({
  i,
  chain,
  label,
  media,
  at,
}) => {
  const { visible, scale } = useSlam(at, { from: 1.35 })
  const chip = useSlam(at + 5, { from: 1.8 })
  if (!visible) return null
  const gap = 130
  const left = 960 + (i - 1) * (PANEL_W + gap) - PANEL_W / 2
  const rot = [-2.2, 1.2, -1.4][i]
  return (
    <div style={{ position: 'absolute', left, top: 300, width: PANEL_W, height: PANEL_H, transform: `rotate(${rot}deg) scale(${scale})` }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          border: `${B.border}px solid ${C.ink}`,
          borderRadius: B.radius,
          boxShadow: B.shadow(16),
          overflow: 'hidden',
          background: C.void,
        }}
      >
        <ShotMedia media={media} duration={durFrames('S4')} />
      </div>
      {chip.visible && (
        <div style={{ position: 'absolute', left: '50%', bottom: -34, transform: `translateX(-50%) scale(${chip.scale})` }}>
          <Chip size={34} style={{ gap: 16, padding: '10px 28px 10px 12px' }}>
            <ChainDisc id={chain} size={58} ring={4} />
            {label}
          </Chip>
        </div>
      )}
    </div>
  )
}

export const Scene4: React.FC = () => {
  const sub = useSlam(f(S4.sub.at), { from: 1.18 })
  return (
    <AbsoluteFill style={{ background: C.cream }}>
      <TitleBlock
        text={S4.title.text}
        at={f(S4.title.at)}
        variant="ink"
        size={92}
        rotate={0}
        style={{ left: '50%', top: 26, translate: '-50% 0', whiteSpace: 'nowrap', boxShadow: B.shadow(10), transformOrigin: 'center' }}
      />
      {sub.visible && (
        <div style={{ position: 'absolute', left: '50%', top: 172, transform: `translateX(-50%) rotate(-1deg) scale(${sub.scale})`, zIndex: 2 }}>
          <Chip bg={C.lime} size={44}>
            {S4.sub.text}
          </Chip>
        </div>
      )}
      {S4.panels.map((p, i) => (
        <Panel key={p.chain} i={i} chain={p.chain} label={p.label} media={p.media} at={f(p.at)} />
      ))}
    </AbsoluteFill>
  )
}

// ───────────────────────────── S5 ONE PRICE
const LAND = S5.landFrames

const currentPrice = (frame: number) => {
  let price: string = S5.startPrice
  let idx = -1
  S5.trades.forEach((t, i) => {
    if (frame >= f(t.at)) {
      price = t.price
      idx = i
    }
  })
  return { price, idx }
}

const Ticket: React.FC<{ t: (typeof S5.trades)[number] }> = ({ t }) => {
  const at = f(t.at) - LAND // starts sliding so it lands on `t.at`
  const s = useSlide(at, t.from, t.from === 'top' ? 500 : 1100)
  if (!s.visible) return null
  const pos: React.CSSProperties =
    // each ticket hugs its own pipe; KENJI sits beside the top pipe, never over the creature
    t.from === 'left' ? { left: 40, top: 300 } : t.from === 'right' ? { right: 40, top: 300 } : { right: 1080, top: 44 }
  const buy = t.side === 'BUYS'
  return (
    <div style={{ position: 'absolute', ...pos, transform: s.transform }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          background: C.cream,
          border: `${B.border}px solid ${C.ink}`,
          borderRadius: B.radiusSm,
          boxShadow: B.shadow(10),
          padding: '12px 18px 12px 12px',
          fontFamily: FONT.mono,
          fontWeight: 700,
          fontSize: 30,
          letterSpacing: '0.06em',
          color: C.ink,
          whiteSpace: 'nowrap',
          transform: `rotate(${t.from === 'left' ? -2 : t.from === 'right' ? 2 : -1}deg)`,
        }}
      >
        <ChainDisc id={t.chain} size={54} />
        <span>
          {t.who} · {t.chainLabel} ·{' '}
        </span>
        <span
          style={{
            background: buy ? C.up : C.down,
            color: C.white,
            padding: '4px 12px',
            borderRadius: 8,
            border: `3px solid ${C.ink}`,
          }}
        >
          {t.side} {t.amount}
        </span>
      </div>
    </div>
  )
}

export const Scene5: React.FC = () => {
  const frame = useCurrentFrame()
  const { price, idx } = currentPrice(frame)
  const tickAt = idx >= 0 ? f(S5.trades[idx].at) : -999
  const sinceTick = frame - tickAt
  const prev = idx > 0 ? S5.trades[idx - 1].price : S5.startPrice
  const up = idx >= 0 && price > prev
  const flashing = idx >= 0 && sinceTick < 8
  const bump = idx >= 0 ? interpolate(sinceTick, [0, 2, 8], [1.12, 1.06, 1], { extrapolateRight: 'clamp' }) : 1
  const box = useSlam(f(0.15), { from: 1.4 })
  const t2 = f(S5.title2.at)
  return (
    <AbsoluteFill>
      <ShotMedia media={S5.media} duration={durFrames('S5')} darken={S5.darken} />
      {S5.trades.map((t) => (
        <Ticket key={t.who} t={t} />
      ))}
      {box.visible && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: 566,
            transform: `translateX(-50%) scale(${box.scale})`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 20,
          }}
        >
          <div
            style={{
              background: flashing ? (up ? C.up : C.down) : C.cream,
              color: flashing ? C.white : C.ink,
              fontFamily: FONT.mono,
              fontWeight: 700,
              fontSize: 116,
              lineHeight: 1,
              letterSpacing: '-0.01em',
              padding: '18px 40px 22px',
              border: `${B.border}px solid ${C.ink}`,
              borderRadius: B.radius,
              boxShadow: B.shadow(16),
              transform: `scale(${bump})`,
            }}
          >
            {price}
          </div>
          <div style={{ display: 'flex', gap: 22 }}>
            {S5.trades.map((t) => (
              <Chip key={t.chain} size={28} shadow={6} style={{ gap: 12, padding: '6px 18px 6px 6px', background: flashing ? C.lime : C.cream }}>
                <ChainDisc id={t.chain} size={46} ring={3} />
                {price}
                <Check size={30} />
              </Chip>
            ))}
          </div>
        </div>
      )}
      <TitleBlock
        text={S5.title.text}
        at={f(S5.title.at)}
        until={t2}
        variant="ink"
        size={78}
        rotate={0}
        maxWidth={1800}
        style={{ left: '50%', bottom: 70, translate: '-50% 0', whiteSpace: 'nowrap', transformOrigin: 'center' }}
      />
      <TitleBlock
        text={S5.title2.text}
        at={t2}
        variant="lime"
        size={120}
        rotate={-1.5}
        style={{ left: '50%', bottom: 60, translate: '-50% 0', whiteSpace: 'nowrap', transformOrigin: 'center' }}
      />
    </AbsoluteFill>
  )
}

// ───────────────────────────── S6 BLOCK 0
const mmss = (s: number) => {
  const t = Math.max(0, Math.ceil(s))
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

const SnipeMeter: React.FC = () => {
  const frame = useCurrentFrame()
  const m = S6.meter
  const { visible, scale } = useSlam(f(m.at), { from: 1.35 })
  if (!visible) return null
  const p = interpolate(frame, [f(m.drainFrom), f(m.drainTo)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const pct = Math.round(m.fromPct + (m.toPct - m.fromPct) * p)
  const fill = pct / m.fromPct
  return (
    <div
      style={{
        position: 'absolute',
        left: 64,
        top: 150,
        width: 470,
        background: C.cream,
        border: `${B.border}px solid ${C.ink}`,
        borderRadius: B.radius,
        boxShadow: B.shadow(12),
        padding: '18px 26px 24px',
        transform: `rotate(-1.5deg) scale(${scale})`,
        transformOrigin: 'left top',
        color: C.ink,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ fontFamily: FONT.mono, fontWeight: 700, fontSize: 26, letterSpacing: '0.18em' }}>{m.label}</div>
        <div style={{ fontFamily: FONT.mono, fontWeight: 700, fontSize: 38, letterSpacing: '0.06em' }}>{mmss(m.fromClock * (1 - p))}</div>
      </div>
      <div style={{ fontFamily: FONT.title, fontSize: 132, lineHeight: 1, marginTop: 4 }}>{pct}%</div>
      <div style={{ marginTop: 12, height: 50, border: `${B.border}px solid ${C.ink}`, borderRadius: 10, background: C.white, overflow: 'hidden' }}>
        <div style={{ width: `${Math.max(fill * 100, 2)}%`, height: '100%', background: C.hot, borderRight: `${B.border}px solid ${C.ink}` }} />
      </div>
    </div>
  )
}

/** BOUNCED: slams in on the bounce at the impact point, then shrinks and parks top-right. */
const BouncedStamp: React.FC<{ bounce: number }> = ({ bounce }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const { visible, scale } = useSlam(bounce, { from: 1.4, stiffness: 520, damping: 18 })
  if (!visible) return null
  const move = spring({ frame: frame - bounce - f(S6.bounced.settleAfterBounce), fps, config: { stiffness: 300, damping: 20, mass: 0.7 } })
  const x = interpolate(move, [0, 1], [700, 1640])
  const y = interpolate(move, [0, 1], [290, 116])
  const k = interpolate(move, [0, 1], [1, 0.5])
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        fontFamily: FONT.title,
        fontSize: 170,
        lineHeight: 1,
        color: C.ink,
        background: C.hot,
        padding: '14px 38px 17px',
        border: `${B.border + 2}px solid ${C.ink}`,
        borderRadius: B.radiusSm,
        boxShadow: B.shadow(14),
        letterSpacing: '0.03em',
        transform: `translate(-50%, -50%) rotate(${interpolate(move, [0, 1], [-10, -6])}deg) scale(${scale * k})`,
      }}
    >
      {S6.bounced.text}
    </div>
  )
}

const SniperTag: React.FC<{ bounce: number }> = ({ bounce }) => {
  const frame = useCurrentFrame()
  const at = f(S6.sniper.at)
  const { visible, scale } = useSlam(at, { from: 1.6 })
  if (!visible || frame >= bounce + f(S6.sniper.goneAfterBounce)) return null
  // the claw shakes against the shield: the tag jitters with it
  const jx = (random(`snx${frame}`) - 0.5) * 4
  return (
    <div style={{ position: 'absolute', left: 300, top: 150, transform: `translateX(${jx}px) rotate(-4deg) scale(${scale})`, transformOrigin: 'left center' }}>
      <Chip bg={C.hot} size={34}>
        <svg width={26} height={26} viewBox="0 0 24 24" style={{ display: 'block' }}>
          <circle cx="12" cy="12" r="8" fill="none" stroke={C.ink} strokeWidth="3" />
          <path d="M12 1v6M12 17v6M1 12h6M17 12h6" stroke={C.ink} strokeWidth="3" />
        </svg>
        {S6.sniper.text}
      </Chip>
    </div>
  )
}

export const Scene6: React.FC<{ bounceAtInClip: number }> = ({ bounceAtInClip }) => {
  const frame = useCurrentFrame()
  // the bounce lands on S6.bounce (a downbeat); the clip is positioned so its
  // bounce moment falls there (clip time = clipIn + t * rate)
  const bounce = f(S6.bounce) - f(CUTS.S6[0])
  const clipIn = bounceAtInClip - (bounce / 30) * (S6.media.rate ?? 1)
  const sh = shake(frame, bounce, 10, 18)
  const sub = useSlam(f(S6.sub.at), { from: 1.12 })
  return (
    <AbsoluteFill style={{ transform: `translate(${sh.x}px, ${sh.y}px)` }}>
      <ShotMedia media={S6.media} duration={durFrames('S6')} clipIn={clipIn} />
      <Typewriter text={S6.stamp.text} at={f(S6.stamp.at)} cps={S6.stamp.charsPerSecond} />
      <SniperTag bounce={bounce} />
      <SnipeMeter />
      <TitleBlock text={S6.title.text} at={f(S6.title.at)} variant="ink" size={100} style={{ left: 64, bottom: 168 }} />
      {sub.visible && (
        <div style={{ position: 'absolute', left: 64, bottom: 56, transform: `scale(${sub.scale})`, transformOrigin: 'left center' }}>
          <Chip bg={C.lime} size={36}>
            {S6.sub.text}
          </Chip>
        </div>
      )}
      <BouncedStamp bounce={bounce} />
    </AbsoluteFill>
  )
}

// ───────────────────────────── S7 HOLDERS
const CHIP_BG = { lime: C.lime, candy: C.candy, tang: C.tang } as const

export const Scene7: React.FC = () => {
  const lock = useSlam(f(S7.lock.at), { from: 1.5 })
  return (
    <AbsoluteFill>
      <ShotMedia media={S7.media} duration={durFrames('S7')} />
      <TitleBlock text={S7.title.text} at={f(S7.title.at)} variant="ink" size={108} style={{ left: 64, top: 60 }} />
      <div style={{ position: 'absolute', left: 64, top: 246, display: 'flex', gap: 30 }}>
        {S7.chips.map((c, i) => (
          <PopChip key={c.text} at={f(c.at)} bg={CHIP_BG[c.color]} rot={[-3, 2, -1.5][i]}>
            {c.text}
          </PopChip>
        ))}
      </div>
      {lock.visible && (
        <div style={{ position: 'absolute', left: 64, top: 384, transform: `scale(${lock.scale})`, transformOrigin: 'left center' }}>
          <Chip bg={C.ink} fg={C.cream} size={36} shadow={0} style={{ border: `3px solid ${C.cream}` }}>
            <LockIcon />
            {S7.lock.text}
          </Chip>
        </div>
      )}
    </AbsoluteFill>
  )
}

const PopChip: React.FC<{ at: number; bg: string; rot: number; children: React.ReactNode }> = ({ at, bg, rot, children }) => {
  const { visible, scale } = useSlam(at, { from: 1.25 })
  if (!visible) return null
  return (
    <div style={{ transform: `rotate(${rot}deg) scale(${scale})` }}>
      <Chip bg={bg} size={46}>
        {children}
      </Chip>
    </div>
  )
}

const LockIcon: React.FC = () => (
  <svg width={26} height={30} viewBox="0 0 26 30" style={{ display: 'block' }}>
    <rect x="2" y="13" width="22" height="15" rx="3" fill={C.lime} />
    <path d="M7 13V9a6 6 0 0112 0v4" fill="none" stroke={C.lime} strokeWidth="4" />
  </svg>
)

// ───────────────────────────── S7b THE MAP
const W = 1920
const H = 1080

const DoorChip: React.FC<{ chain: ChainId; label: string; x: number; at: number }> = ({ chain, label, x, at }) => {
  const { visible, scale } = useSlam(at, { from: 1.45 })
  if (!visible) return null
  return (
    <div style={{ position: 'absolute', left: x * W, top: S7b.chipY * H, transform: `translateX(-50%) scale(${scale})` }}>
      <Chip size={26} shadow={6} style={{ gap: 10, padding: '6px 18px 6px 6px', letterSpacing: '0.08em' }}>
        <ChainDisc id={chain} size={44} ring={3} />
        {label}
      </Chip>
    </div>
  )
}

const FloorTag: React.FC<{ text: string; x: number; at: number; bg?: string }> = ({ text, x, at, bg = C.cream }) => {
  const { visible, scale } = useSlam(at, { from: 1.12 })
  if (!visible) return null
  return (
    <div style={{ position: 'absolute', left: x * W, top: 952, transform: `translateX(-50%) scale(${scale})` }}>
      <Chip bg={bg} size={28} shadow={6} style={{ letterSpacing: '0.06em', padding: '8px 18px' }}>
        {text}
      </Chip>
    </div>
  )
}

/** Lime bracket under the three doors of the omnichain universe, with its label. */
const OmniBracket: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const o = S7b.status.omni
  const at = f(o.at)
  if (frame < at) return null
  const grow = spring({ frame: frame - at, fps, config: { stiffness: 320, damping: 22, mass: 0.6 } })
  const x0 = o.from * W
  const x1 = o.to * W
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: x0,
          top: 912,
          width: x1 - x0,
          height: 30,
          borderLeft: `8px solid ${C.lime}`,
          borderRight: `8px solid ${C.lime}`,
          borderBottom: `8px solid ${C.lime}`,
          borderRadius: '0 0 6px 6px',
          transform: `scaleX(${grow})`,
          transformOrigin: 'left center',
          filter: `drop-shadow(3px 3px 0 ${C.ink})`,
        }}
      />
      <FloorTag text={o.text} x={(o.from + o.to) / 2} at={at + 3} bg={C.lime} />
    </>
  )
}

const NextTag: React.FC = () => {
  const n = S7b.status.solana
  const { visible, scale } = useSlam(f(n.at), { from: 1.4, stiffness: 520, damping: 18 })
  if (!visible) return null
  return (
    <div
      style={{
        position: 'absolute',
        left: S7b.signAt.x * W,
        top: S7b.signAt.y * H,
        transform: `translate(-50%, -50%) rotate(-7deg) scale(${scale})`,
        background: C.hot,
        color: C.ink,
        fontFamily: FONT.title,
        fontSize: 64,
        lineHeight: 1,
        padding: '6px 22px 8px',
        border: `${B.border}px solid ${C.ink}`,
        borderRadius: B.radiusSm,
        boxShadow: B.shadow(8),
        letterSpacing: '0.04em',
      }}
    >
      {n.text}
    </div>
  )
}

export const Scene7b: React.FC = () => {
  const frame = useCurrentFrame()
  const dur = durFrames('S7b')
  // the overlays follow the clip's own push-in so they stay pinned to the doors
  const k = interpolate(frame, [0, dur], S7b.follow.scale, { extrapolateRight: 'clamp' })
  const st = S7b.status
  return (
    <AbsoluteFill>
      <ShotMedia media={S7b.media} duration={dur} />
      <AbsoluteFill style={{ transform: `scale(${k})`, transformOrigin: S7b.follow.origin }}>
        {S7b.doors.map((d) => (
          <DoorChip key={d.chain} chain={d.chain} label={d.label} x={d.x} at={f(d.at)} />
        ))}
        <OmniBracket />
        <FloorTag text={st.bnb.text} x={st.bnb.x} at={f(st.bnb.at)} />
        <FloorTag text={st.ethereum.text} x={st.ethereum.x} at={f(st.ethereum.at)} />
        <NextTag />
      </AbsoluteFill>
      <TitleBlock text={S7b.title.text} at={f(S7b.title.at)} variant="lime" size={88} rotate={-1} style={{ left: 64, top: 40 }} />
    </AbsoluteFill>
  )
}

// ───────────────────────────── S8 CLOSE
export const Scene8: React.FC = () => {
  const dur = durFrames('S8')
  const freezeFrom = dur - f(S8.holdLast)
  return (
    <AbsoluteFill>
      <ShotMedia media={S8.media} duration={dur} freezeFrom={freezeFrom} />
      {/* darkened band for the end card (functional, not decorative) */}
      <AbsoluteFill style={{ background: 'linear-gradient(90deg, rgba(23,22,28,0) 34%, rgba(23,22,28,0.82) 50%, rgba(23,22,28,0.9) 100%)' }} />
      <EndCard />
    </AbsoluteFill>
  )
}

const EndCard: React.FC = () => {
  const mark = useSlam(f(S8.mark.at), { from: 1.45 })
  const word = useSlam(f(S8.wordmark.at), { from: 1.18 })
  const tag = useSlam(f(S8.tagline.at), { from: 1.3 })
  const url = useSlam(f(S8.url.at), { from: 1.3 })
  const status = useSlam(f(S8.status.at), { from: 1.2 })
  return (
    <div style={{ position: 'absolute', left: 950, top: 0, bottom: 0, width: 940, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 30, height: 230 }}>
        {mark.visible && <Smiley size={176} style={{ transform: `scale(${mark.scale}) rotate(-6deg)` }} />}
        {word.visible && (
          <div style={{ fontFamily: FONT.title, fontSize: 240, lineHeight: 1, color: C.lime, transform: `scale(${word.scale})`, transformOrigin: 'left center' }}>
            {S8.wordmark.text}
          </div>
        )}
      </div>
      <div style={{ height: 96, marginTop: 18 }}>
        {tag.visible && (
          <div
            style={{
              fontFamily: FONT.title,
              fontSize: 64,
              lineHeight: 1.1,
              color: C.cream,
              letterSpacing: '0.02em',
              transform: `scale(${tag.scale})`,
              transformOrigin: 'left center',
              whiteSpace: 'nowrap',
            }}
          >
            {S8.tagline.text}
          </div>
        )}
      </div>
      <div style={{ height: 90, marginTop: 22 }}>
        {url.visible && (
          <div style={{ display: 'inline-block', transform: `rotate(-1.5deg) scale(${url.scale})`, transformOrigin: 'left center' }}>
            <Chip bg={C.lime} size={38} shadow={0} style={{ textTransform: 'none', letterSpacing: '0.02em', boxShadow: `8px 8px 0 ${C.cream}` }}>
              {S8.url.text}
            </Chip>
          </div>
        )}
      </div>
      <div style={{ height: 80, marginTop: 30 }}>
        {status.visible && (
          <div
            style={{
              fontFamily: FONT.mono,
              fontWeight: 700,
              fontSize: 26,
              lineHeight: 1.45,
              letterSpacing: '0.02em',
              color: C.cream,
              opacity: 0.85,
              transform: `scale(${status.scale})`,
              transformOrigin: 'left center',
              whiteSpace: 'nowrap',
            }}
          >
            {S8.status.lines.map((l) => (
              <div key={l}>{l}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
