/**
 * THE SCRIPT — every string, timing and impact point of the film lives here.
 * Retime or translate the film by editing this file only.
 *
 * The edit is cut to public/audio/music.mp3 (50.05 s, starts at film 0):
 *   0 – 17.19 s  music-box intro
 *   17.19 s      THE DROP (first kick) → the button impact (S3) lands here
 *   ~112 BPM after the drop: beat 0.535 s, bar 2.143 s → `bar(n)`
 *   47.19 s      last hit; the tail decays to silence by ~49 s
 *
 * CUTS are absolute seconds in the film. Inside a shot, `at` values are
 * shot-local seconds; most are written as `rel('S4', 20.14)` = "the kick at
 * film 20.14 s", so they read against the music.
 *
 * Media: each shot names a clip (public/clips/<clip>.mp4) and a still
 * (public/keyframes/<still>.png). The clip wins if it exists; else `fallback`
 * (another clip/still, used for s02b); else the still with a slow push-in;
 * else a dark placeholder. `clipIn` = seconds into the clip at the shot's
 * first frame (negative = hold the clip's first frame that long before it
 * plays). `rate` < 1 slows the clip. A clip shorter than its shot holds its
 * last frame, never loops.
 */
export const FPS = 30
export const WIDTH = 1920
export const HEIGHT = 1080

export type Media = {
  clip: string
  still: string
  /** fallback still if `still` is missing */
  stillAlt?: string
  clipIn?: number
  rate?: number
  /** CSS object-position for cover-cropping, also the push-in origin */
  focus?: string
  /** scale over the shot [from, to] */
  drift?: [number, number]
  /** used when `clip` does not exist yet */
  fallback?: Media
}

/** seconds → frames */
export const f = (s: number) => Math.round(s * FPS)

/** The music's landmarks (seconds into music.mp3 = seconds into the film). */
export const MUSIC = {
  volume: 0.9,
  /** music.mp3 starts with the film */
  startAt: 0,
  /** first kick of the drop (measured, low-passed kick detector) */
  drop: 17.19,
  /** one bar at ~112 BPM */
  bar: 2.143,
  beat: 0.535,
  /** the last hit */
  end: 47.19,
  /** 0 = no fade (the track ends by itself) */
  fadeOutSeconds: 0,
}

/** Downbeat n bars after the drop: bar(0) = 17.19, bar(1) = 19.33, … bar(14) = 47.19 */
export const bar = (n: number) => Math.round((MUSIC.drop + n * MUSIC.bar) * 100) / 100

/** Absolute cut points (seconds). Hard cuts. Post-drop cuts sit on downbeats. */
export const CUTS = {
  S1: [0.0, 5.7],
  S2a: [5.7, 10.8],
  S2b: [10.8, 15.0],
  S3: [15.0, bar(1)], // 19.33
  S4: [bar(1), bar(4)], // 19.33 – 25.76
  S5: [bar(4), bar(8)], // 25.76 – 34.33
  S6: [bar(8), bar(11)], // 34.33 – 40.76
  S7: [bar(11), bar(13)], // 40.76 – 45.05
  S8: [bar(13), 49.6], // 45.05 – 49.6 (still end card over the music's tail)
} as const

export type ShotId = keyof typeof CUTS
/** absolute film seconds → seconds inside a shot */
export const rel = (id: ShotId, abs: number) => Math.round((abs - CUTS[id][0]) * 1000) / 1000
export const startFrame = (id: ShotId) => f(CUTS[id][0])
export const durFrames = (id: ShotId) => f(CUTS[id][1]) - f(CUTS[id][0])
export const TOTAL_FRAMES = f(CUTS.S8[1])

// ───────────────────────────── S1 COLD OPEN
export const S1 = {
  media: { clip: 's01', still: 'k01', stillAlt: 'hero-a', rate: 0.9 } as Media,
  stamp: { text: '09:03:00 — BASE', at: 0.3, charsPerSecond: 16 },
  title: { text: 'A MEME COIN IS BORN.', at: 2.4 },
}

// ───────────────────────────── S2 THE OLD WAY (two beats)
export const S2a = {
  media: { clip: 's02', still: 'k02' } as Media,
  title: { text: 'EVERYWHERE ELSE, PEOPLE GET COPIES.', at: 0.6 },
}
export const S2b = {
  // s02b: three clay figures wave paper copies at a porthole, the real
  // creature glows behind the glass (centre). The figures and the camera move,
  // so the prices are clean UI chips in a fixed row, not pinned to the tags.
  // Until s02b.mp4 exists: a slow crop-in on the end of s02.
  media: {
    clip: 's02b',
    still: 'k02',
    clipIn: 0,
    rate: 1,
    drift: [1.0, 1.04],
    fallback: { clip: 's02', still: 'k02', clipIn: 3.0, rate: 0.5, focus: '22% 38%', drift: [1.55, 1.85] },
  } as Media,
  /**
   * Price labels in a row at the TOP of the frame (above each grey copy), so
   * the figures stay visible. Each chip ticks through its own `prices` every
   * `tickEvery` s from `at` (up-tick flashes green, down-tick pink, tick.mp3 on
   * each change). The three ranges never overlap, so no two chips ever agree.
   */
  tickEvery: 0.5,
  tags: [
    { x: 0.2, at: 0.15, prices: ['$0.0041', '$0.0043', '$0.0042', '$0.0045', '$0.0044', '$0.0041', '$0.0043', '$0.0046'] },
    { x: 0.5, at: 0.4, prices: ['$0.0039', '$0.0037', '$0.0038', '$0.0036', '$0.0039', '$0.0037', '$0.0035', '$0.0038'] },
    { x: 0.8, at: 0.65, prices: ['$0.0052', '$0.0054', '$0.0051', '$0.0053', '$0.0050', '$0.0052', '$0.0055', '$0.0053'] },
  ],
  title: { text: 'WRAPPED. BRIDGED. THREE PRICES.', at: 1.0 },
}

// ───────────────────────────── S3 THE BUTTON
export const S3 = {
  /**
   * Seconds into s03.mp4 where the hand hits the button. The clip is
   * positioned (taking `rate` into account) so this moment lands on
   * MUSIC.drop. Also a Studio prop. Measured: hand enters 3.2 s, lands 3.30 s.
   */
  impactAtInClip: 3.3,
  /** film time of the impact */
  impact: MUSIC.drop,
  // rate 0.8: the clip has 1.74 s after the impact, the shot needs 2.14 s
  media: { clip: 's03', still: 'k03', rate: 0.8 } as Media,
  /** frames the full-lime wordmark holds */
  flashFrames: 12,
  wordmark: 'SPAWN!',
}

// ───────────────────────────── S4 BORN EVERYWHERE
export const S4 = {
  title: { text: 'ONE LAUNCH. THREE CHAINS. ALL NATIVE.', at: 0.0 }, // on the cut (19.33)
  sub: { text: 'NO BRIDGE. NO WRAPPED COPY.', at: rel('S4', bar(2)) }, // next downbeat 21.47
  // the panels pop on the kicks 19.87 / 20.14 / 20.40
  panels: [
    { chain: 'base', label: 'BASE', media: { clip: 's04a', still: 'k04' } as Media, at: rel('S4', 19.87) },
    { chain: 'arbitrum', label: 'ARBITRUM', media: { clip: 's04b', still: 'k05' } as Media, at: rel('S4', 20.14) },
    { chain: 'optimism', label: 'OPTIMISM', media: { clip: 's04c', still: 'k06' } as Media, at: rel('S4', 20.4) },
  ] as const,
}

// ───────────────────────────── S5 ONE PRICE
export const S5 = {
  // rate 0.65: the 5 s clip covers 7.75 s of the 8.57 s shot, then holds its last frame
  media: { clip: 's05', still: 'k07', rate: 0.65 } as Media,
  darken: 0.35,
  startPrice: '$0.0000056',
  /** a ticket starts sliding this many frames before it lands */
  landFrames: 7,
  /**
   * `at` = the moment the ticket LANDS: the price ticks, the coins sound.
   * On the kicks 26.73 / 28.98 / 31.12. `from` = its pipe's side.
   */
  trades: [
    { who: 'LINA', chain: 'base', chainLabel: 'BASE', side: 'BUYS', amount: '$50', from: 'left', at: rel('S5', 26.73), price: '$0.0000061' },
    { who: 'KENJI', chain: 'arbitrum', chainLabel: 'ARBITRUM', side: 'BUYS', amount: '$20', from: 'top', at: rel('S5', 28.98), price: '$0.0000063' },
    { who: 'ADA', chain: 'optimism', chainLabel: 'OPTIMISM', side: 'SELLS', amount: '$10', from: 'right', at: rel('S5', 31.12), price: '$0.0000062' },
  ] as const,
  title: { text: 'EVERY TRADE, FROM ANY CHAIN, HITS ONE MARKET.', at: 0.3 },
  title2: { text: 'ONE PRICE. EVERYWHERE.', at: rel('S5', 32.19) },
}

// ───────────────────────────── S6 BLOCK 0
// Story order: timestamp + SNIPER BOT tag on the claw → the big burst throws
// it off (BOUNCED) → title → the snipe-tax meter drains → sub-line.
// Times marked "after bounce" are seconds after the bounce frame.
export const S6 = {
  /**
   * Seconds into s06.mp4 where the claw is thrown off the shield (the big
   * burst; the first sparks at ~1.8 s are the build-up). The clip is
   * positioned (taking `rate` into account) so this lands on `bounce`.
   * Also a Studio prop.
   */
  bounceAtInClip: 2.4,
  /** film time of the bounce: the downbeat 36.48 */
  bounce: bar(9),
  media: { clip: 's06', still: 'k08', rate: 0.75 } as Media,
  stamp: { text: '09:03:00.000 — BLOCK 0', at: 0.15, charsPerSecond: 24 },
  /** tag on the claw before the bounce (top-left, where the claw enters) */
  sniper: { text: 'SNIPER BOT', at: 0.5, goneAfterBounce: 0.25 },
  bounced: { text: 'BOUNCED', settleAfterBounce: 0.6 },
  title: { text: 'BLOCK 0 DOES NOT EXIST.', at: rel('S6', 36.76) },
  sub: { text: 'FIRST 10 MIN: SNIPE TAX 30% → 1%. MAX $250 PER WALLET.', at: rel('S6', bar(10)) }, // 38.62
  meter: {
    label: 'SNIPE TAX',
    at: rel('S6', 37.3), // appears
    drainFrom: rel('S6', 37.56),
    drainTo: rel('S6', 40.2), // 10:00 → 00:00 compressed into this
    fromPct: 30,
    toPct: 1,
    fromClock: 600, // seconds shown at the start of the countdown (10:00)
  },
}

// ───────────────────────────── S7 HOLDERS
export const S7 = {
  media: { clip: 's07', still: 'k09' } as Media,
  title: { text: '1% OF EVERY TRADE GOES BACK.', at: rel('S7', 40.78) },
  chips: [
    { text: 'TO HOLDERS', color: 'lime', at: rel('S7', 41.06) },
    { text: 'TO THE DEV', color: 'candy', at: rel('S7', 41.33) },
    { text: 'OR BURNED', color: 'tang', at: rel('S7', 41.6) },
  ] as const,
  lock: { text: 'CHOSEN AT LAUNCH. LOCKED FOREVER.', at: rel('S7', bar(12)) }, // 42.90
}

// ───────────────────────────── S8 CLOSE
export const S8 = {
  media: { clip: 's08', still: 'k10', focus: '35% 50%' } as Media,
  mark: { at: 0 }, // on the cut (45.05)
  wordmark: { text: 'SPAWN!', at: 0.03 },
  tagline: { text: 'THE OMNICHAIN MEME MACHINE', at: rel('S8', 46.12) },
  url: { text: 'spawn-multiverse.netlify.app', at: rel('S8', bar(14)) }, // 47.19, the last hit
  status: { text: 'GUARDED BETA · BASE · OPTIMISM · ARBITRUM · MORE COMING', at: rel('S8', 47.6) },
  /** the last N seconds are a perfectly still frame (over the music's tail) */
  holdLast: 1.4,
}

/** Studio-editable props (defaults from this file). */
export type FilmProps = {
  impactAtInClip: number
  bounceAtInClip: number
  musicVolume: number
}
export const DEFAULT_PROPS: FilmProps = {
  impactAtInClip: S3.impactAtInClip,
  bounceAtInClip: S6.bounceAtInClip,
  musicVolume: MUSIC.volume,
}

// ───────────────────────────── SOUND EFFECTS
/**
 * public/audio/sfx/<name>.mp3. `hit` = where the transient sits inside the
 * file (seconds); a cue places that point on its sync frame, so the file
 * starts at (sync − hit). A missing file is skipped.
 */
export const SFX_HIT: Record<string, number> = {
  riser: 2.02, // peaks at its very end → it ENDS on the impact
  thump: 0.05,
  zap: 0.75, // the big clang; the crackle before it rides the first sparks
  stamp: 0.05,
  coins: 0.25,
  tick: 0,
  pop: 0,
}

export type SfxCue = { sound: string; frame: number; volume: number }

/**
 * Every cue is derived from the same constants as the visuals (cuts, `at`
 * values, impactAtInClip / bounceAtInClip), so a retime moves both.
 * `frame` = absolute film frame of the transient.
 */
export const sfxCues = (p: FilmProps): SfxCue[] => {
  // S3 / S6 position their clips so these moments land on these film times
  // (the props only move the clip, never the sync point)
  void p
  const impact = f(S3.impact)
  const bounce = f(S6.bounce)
  const s5 = startFrame('S5')
  const cues: SfxCue[] = [
    { sound: 'riser', frame: impact, volume: 0.5 },
    { sound: 'thump', frame: impact, volume: 0.9 },
    // 0.45 each: the music itself peaks at -1.1 dBFS on this downbeat; at 0.8 the sum clipped
    { sound: 'zap', frame: bounce, volume: 0.45 },
    { sound: 'stamp', frame: bounce, volume: 0.45 },
    // S7 opens on coins: the file starts on the cut
    { sound: 'coins', frame: startFrame('S7') + f(SFX_HIT.coins), volume: 0.5 },
    { sound: 'pop', frame: startFrame('S8') + f(S8.wordmark.at), volume: 0.4 },
  ]
  for (const t of S5.trades) {
    const land = s5 + f(t.at)
    cues.push({ sound: 'coins', frame: land, volume: 0.45 })
    cues.push({ sound: 'tick', frame: land, volume: 0.35 })
  }
  // S2b: a tick on every price appearance and change
  for (const t of S2b.tags)
    t.prices.forEach((_, k) => cues.push({ sound: 'tick', frame: startFrame('S2b') + f(t.at + k * S2b.tickEvery), volume: 0.35 }))
  for (const pnl of S4.panels) cues.push({ sound: 'pop', frame: startFrame('S4') + f(pnl.at), volume: 0.4 })
  for (const c of S7.chips) cues.push({ sound: 'pop', frame: startFrame('S7') + f(c.at), volume: 0.4 })
  return cues
}
