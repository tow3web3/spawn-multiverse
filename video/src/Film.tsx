import React from 'react'
import { AbsoluteFill, Html5Audio, interpolate, Sequence, staticFile, useCurrentFrame } from 'remotion'
import { MUSIC as MUSIC_FILE, SFX_FILES } from './assets.gen'
import { Scene1, Scene2a, Scene2b, Scene3, Scene4, Scene5, Scene6, Scene7, Scene8 } from './scenes'
import { durFrames, f, type FilmProps, MUSIC, S8, SFX_HIT, sfxCues, type ShotId, startFrame, TOTAL_FRAMES } from './script'
import { C } from './theme'
import { Grain } from './ui'

const Shot: React.FC<{ id: ShotId; children: React.ReactNode }> = ({ id, children }) => (
  <Sequence from={startFrame(id)} durationInFrames={durFrames(id)} name={id}>
    {children}
  </Sequence>
)

/** One sound effect: its transient (`hit`) lands on `frame`. Missing files render nothing. */
const Sfx: React.FC<{ sound: string; frame: number; volume: number }> = ({ sound, frame, volume }) => {
  const file = SFX_FILES[sound]
  if (!file) return null
  const start = frame - f(SFX_HIT[sound] ?? 0)
  const trim = start < 0 ? -start : 0
  const len = Math.max(1, Math.ceil(file.durationInSeconds * 30) - trim)
  return (
    <Sequence from={Math.max(0, start)} durationInFrames={len} name={`sfx ${sound}`} layout="none">
      <Html5Audio src={staticFile(file.src)} volume={volume} trimBefore={trim || undefined} />
    </Sequence>
  )
}

export const Film: React.FC<FilmProps> = (props) => {
  const { impactAtInClip, bounceAtInClip, musicVolume } = props
  const frame = useCurrentFrame()
  const holdFrom = TOTAL_FRAMES - f(S8.holdLast)
  const fadeFrames = f(MUSIC.fadeOutSeconds)
  return (
    <AbsoluteFill style={{ background: C.void }}>
      <Shot id="S1"><Scene1 /></Shot>
      <Shot id="S2a"><Scene2a /></Shot>
      <Shot id="S2b"><Scene2b /></Shot>
      <Shot id="S3"><Scene3 impactAtInClip={impactAtInClip} /></Shot>
      <Shot id="S4"><Scene4 /></Shot>
      <Shot id="S5"><Scene5 /></Shot>
      <Shot id="S6"><Scene6 bounceAtInClip={bounceAtInClip} /></Shot>
      <Shot id="S7"><Scene7 /></Shot>
      <Shot id="S8"><Scene8 /></Shot>
      <Grain frozen={frame >= holdFrom} />
      {MUSIC_FILE && (
        <Sequence from={f(MUSIC.startAt)} name="music">
          <Html5Audio
            src={staticFile(MUSIC_FILE.src)}
            volume={(fr) =>
              fadeFrames > 0
                ? musicVolume *
                  interpolate(fr, [TOTAL_FRAMES - fadeFrames, TOTAL_FRAMES], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
                : musicVolume
            }
          />
        </Sequence>
      )}
      {sfxCues(props).map((c, i) => (
        <Sfx key={`${c.sound}-${i}`} {...c} />
      ))}
    </AbsoluteFill>
  )
}
