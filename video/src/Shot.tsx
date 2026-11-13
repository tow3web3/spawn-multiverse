import React from 'react'
import { AbsoluteFill, Freeze, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from 'remotion'
import { CLIPS, STILLS } from './assets.gen'
import { f, type Media } from './script'
import { C, FONT } from './theme'

/** Pick what to show for a media spec: its clip, else its fallback (if that has anything), else itself. */
const resolve = (m: Media): Media => {
  if (CLIPS[m.clip]) return m
  if (m.fallback && (CLIPS[m.fallback.clip] || STILLS[m.fallback.still])) return resolve(m.fallback)
  return m
}

/**
 * A shot's picture, with a fallback chain that never errors:
 *   clip (muted, held on its first/last frame outside its range, never looped)
 *   → fallback media → still with a slow push-in → dark placeholder.
 * Whatever is shown gets a slow scale drift so a held frame never reads as a
 * dead freeze.
 */
export const ShotMedia: React.FC<{
  media: Media
  /** shot length in frames (drives the push-in) */
  duration: number
  /** 0..1 black over the picture */
  darken?: number
  /** freeze everything (picture and drift) from this shot-local frame on */
  freezeFrom?: number
  /** override media.clipIn (seconds) */
  clipIn?: number
}> = ({ media: requested, duration, darken = 0, freezeFrom, clipIn }) => {
  const frame = useCurrentFrame()
  const media = resolve(requested)
  const t = freezeFrom !== undefined ? Math.min(frame, freezeFrom) : frame
  const clip = CLIPS[media.clip]
  const stillSrc = STILLS[media.still] ?? (media.stillAlt ? STILLS[media.stillAlt] : undefined)
  const focus = media.focus ?? '50% 50%'
  const fit: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', objectPosition: focus }

  let body: React.ReactNode
  if (clip) {
    const rate = media.rate ?? 1
    const inSec = clipIn ?? media.clipIn ?? 0
    // negative in-point: the clip starts `delay` frames into the shot, holding its first frame until then
    const delay = inSec < 0 ? f(-inSec) : 0
    const trim = inSec > 0 ? f(inSec) : 0
    const playable = Math.max(1, Math.floor((clip.durationInFrames - trim) / rate) - 1)
    const lastShown = delay + playable // shot-local frame of the clip's last usable frame
    const holdEnd = Math.min(lastShown, freezeFrom ?? Infinity)
    const frozen = frame < delay || frame > holdEnd
    const at = frame < delay ? delay : holdEnd
    body = (
      <Freeze frame={at} active={frozen}>
        <Sequence from={delay} layout="none">
          <OffthreadVideo src={staticFile(clip.src)} muted trimBefore={trim || undefined} playbackRate={rate} style={fit} />
        </Sequence>
      </Freeze>
    )
  } else if (stillSrc) {
    body = <Img src={staticFile(stillSrc)} style={fit} />
  } else {
    body = (
      <AbsoluteFill style={{ background: C.void, alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontFamily: FONT.mono, fontWeight: 700, fontSize: 48, color: '#5c5a66', letterSpacing: '0.2em' }}>
          {requested.clip.toUpperCase()}
        </div>
        <div style={{ fontFamily: FONT.mono, fontSize: 22, color: '#45434e', letterSpacing: '0.2em', marginTop: 12 }}>
          MISSING: clips/{requested.clip}.mp4 · keyframes/{requested.still}.png
        </div>
      </AbsoluteFill>
    )
  }

  // stills get a stronger push-in than footage (which already moves)
  const drift = media.drift ?? (clip ? [1.0, 1.04] : [1.0, 1.08])
  const scale = interpolate(t, [0, duration], drift, { extrapolateRight: 'clamp' })

  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: C.void }}>
      <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: focus }}>{body}</AbsoluteFill>
      {darken > 0 && <AbsoluteFill style={{ background: `rgba(10,10,12,${darken})` }} />}
    </AbsoluteFill>
  )
}
