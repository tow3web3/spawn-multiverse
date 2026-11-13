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

/**
 * THE CHAINS — one table, read by every shot. A chain marked 'soon' gets a
 * small "SOON" tag wherever it is named or shown; 'live' shows it plain.
 *
 * 2026-11-13: the owner asked for all six to be shown without any SOON tag
 * ("ça marchera"). The film is therefore AHEAD of the product until BNB Chain,
 * Ethereum and Solana are really live — put 'soon' back on a chain to tag it.
 */
export type ChainStatus = 'live' | 'soon'
const row = <I extends string>(id: I, label: string, status: ChainStatus) => ({ id, label, status })
export const CHAINS = [
  row('base', 'BASE', 'live'),
  row('arbitrum', 'ARBITRUM', 'live'),
  row('optimism', 'OPTIMISM', 'live'),
  row('bnb', 'BNB CHAIN', 'live'),
  row('ethereum', 'ETHEREUM', 'live'),
  row('solana', 'SOLANA', 'live'),
] as const
export type ChainKey = (typeof CHAINS)[number]['id']
export const chain = (id: ChainKey) => CHAINS.find((c) => c.id === id)!
/** the one status marker in the film */
export const SOON = 'SOON'

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
  S5: [bar(4), bar(7)], // 25.76 – 32.19
  S6: [bar(7), bar(10)], // 32.19 – 38.62
  S7: [bar(10), bar(12)], // 38.62 – 42.90
  S7b: [bar(12), bar(14)], // 42.90 – 47.19  THE DOORS
  S8: [bar(14), 50.0], // 47.19 (the last hit) – 50.0, still end card over the tail
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
  // s02b: clay figures wave paper copies at a porthole, the real
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
   * each change). The price ranges never overlap, so no two chips ever agree.
   */
  tickEvery: 0.5,
  tags: [
    { x: 0.2, at: 0.15, prices: ['$14.1K', '$14.3K', '$14.2K', '$14.5K', '$14.4K', '$14.1K', '$14.3K', '$14.6K'] },
    { x: 0.5, at: 0.4, prices: ['$12.9K', '$12.7K', '$12.8K', '$12.6K', '$12.9K', '$12.7K', '$12.5K', '$12.8K'] },
    { x: 0.8, at: 0.65, prices: ['$16.2K', '$16.4K', '$16.1K', '$16.3K', '$16.0K', '$16.2K', '$16.5K', '$16.3K'] },
  ],
  title: { text: 'WRAPPED. BRIDGED. DIFFERENT PRICES.', at: 1.0 },
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
  title: { text: 'ONE LAUNCH. SIX CHAINS. ALL NATIVE.', at: 0.0 }, // on the cut (19.33)
  sub: { text: 'NO BRIDGE. NO WRAPPED COPY.', at: rel('S4', 22.55) },
  /** one vertical world per chain, in CHAINS order; they pop on the kicks */
  panels: [
    { chain: 'base', media: { clip: 's04a', still: 'k04' } as Media, at: rel('S4', 19.87) },
    { chain: 'arbitrum', media: { clip: 's04b', still: 'k05' } as Media, at: rel('S4', 20.14) },
    { chain: 'optimism', media: { clip: 's04c', still: 'k06' } as Media, at: rel('S4', 20.4) },
    { chain: 'bnb', media: { clip: 's04d', still: 'k04d' } as Media, at: rel('S4', 20.69) },
    { chain: 'ethereum', media: { clip: 's04e', still: 'k04e' } as Media, at: rel('S4', 21.22) },
    { chain: 'solana', media: { clip: 's04f', still: 'k04f' } as Media, at: rel('S4', 21.48) },
  ] as const,
}

// ───────────────────────────── S5 ONE PRICE
export const S5 = {
  // rate 0.8: the 5 s clip covers 6.3 s of the 6.43 s shot
  media: { clip: 's05', still: 'k07', rate: 0.8 } as Media,
  darken: 0.35,
  /** the board shows the token's MARKET CAP in dollars (what meme traders read), not its unit price */
  boardLabel: 'MARKET CAP',
  startPrice: '$15.0K',
  /** a ticket starts sliding this many frames before it lands */
  landFrames: 7,
  /**
   * `at` = the moment the ticket LANDS: the price ticks, the coins sound.
   * On the kicks 26.73 / 27.92 / 28.98. `from` = its pipe's side.
   */
  trades: [
    { who: 'LINA', chain: 'base', chainLabel: 'BASE', side: 'BUYS', amount: '$200', from: 'left', at: rel('S5', 26.73), price: '$15.4K' },
    { who: 'KENJI', chain: 'arbitrum', chainLabel: 'ARBITRUM', side: 'BUYS', amount: '$100', from: 'top', at: rel('S5', 27.92), price: '$15.6K' },
    { who: 'ADA', chain: 'optimism', chainLabel: 'OPTIMISM', side: 'SELLS', amount: '$50', from: 'right', at: rel('S5', 28.98), price: '$15.5K' },
  ] as const,
  title: { text: 'EVERY TRADE, FROM ANY CHAIN, HITS ONE MARKET.', at: 0.3 },
  title2: { text: 'ONE PRICE. EVERYWHERE.', at: rel('S5', bar(6)) }, // 30.05
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
  /** film time of the bounce: the downbeat 34.33 (shot start + 1 bar) */
  bounce: bar(8),
  media: { clip: 's06', still: 'k08', rate: 0.75 } as Media,
  stamp: { text: '09:03:00.000 — BLOCK 0', at: 0.15, charsPerSecond: 24 },
  /** tag on the claw before the bounce (top-left, where the claw enters) */
  sniper: { text: 'SNIPER BOT', at: 0.5, goneAfterBounce: 0.25 },
  bounced: { text: 'BOUNCED', settleAfterBounce: 0.6 },
  title: { text: 'BLOCK 0 DOES NOT EXIST.', at: rel('S6', 34.61) },
  sub: { text: 'FIRST 10 MIN: SNIPE TAX 30% → 1%. MAX $250 PER WALLET.', at: rel('S6', bar(9)) }, // 36.48
  meter: {
    label: 'SNIPE TAX',
    at: rel('S6', 35.15), // appears
    drainFrom: rel('S6', 35.41),
    drainTo: rel('S6', 38.1), // 10:00 → 00:00 compressed into this
    fromPct: 30,
    toPct: 1,
    fromClock: 600, // seconds shown at the start of the countdown (10:00)
  },
}

// ───────────────────────────── S7 HOLDERS
export const S7 = {
  media: { clip: 's07', still: 'k09' } as Media,
  title: { text: '1% OF EVERY TRADE GOES BACK.', at: rel('S7', 38.63) },
  chips: [
    { text: 'TO HOLDERS', color: 'lime', at: rel('S7', 38.91) },
    { text: 'TO THE DEV', color: 'candy', at: rel('S7', 39.69) },
    { text: 'OR BURNED', color: 'tang', at: rel('S7', 39.98) },
  ] as const,
  lock: { text: 'CHOSEN AT LAUNCH. LOCKED FOREVER.', at: rel('S7', bar(11)) }, // 40.76
}

// ───────────────────────────── S7b THE DOORS
// Six OPEN doors on one rope, one per chain; each door gets its chain's logo
// chip (a 'soon' chain would also get a SOON tag at `sign`).
export const S7b = {
  // s13 is a locked-off camera: no drift, overlays pinned to the doors.
  media: { clip: 's13', still: 'k13', clipIn: 0, rate: 1, drift: [1.0, 1.0] } as Media,
  /** overlay layer scale over the shot, if the clip turns out to move */
  follow: { scale: [1.0, 1.0] as [number, number], origin: '50% 50%' },
  /** in the dark floor band, centred, clear of the creature (box ends y≈0.79) */
  title: { text: 'SIX CHAINS. ONE TOKEN. ONE PRICE.', at: 0 },
  /**
   * Measured on k13 / s13 (fractions of the frame): door centre x, the y of the
   * logo chip's top (the chips follow the arc of door tops), the blank sign.
   */
  doors: [
    { chain: 'base', x: 0.104, chipY: 0.085, at: rel('S7b', 43.2) },
    { chain: 'arbitrum', x: 0.27, chipY: 0.145, at: rel('S7b', 43.2) },
    { chain: 'optimism', x: 0.423, chipY: 0.175, at: rel('S7b', 43.2) },
    { chain: 'bnb', x: 0.577, chipY: 0.175, sign: { x: 0.577, y: 0.41 }, at: rel('S7b', 43.98) },
    { chain: 'ethereum', x: 0.73, chipY: 0.145, sign: { x: 0.73, y: 0.41 }, at: rel('S7b', 45.05) },
    { chain: 'solana', x: 0.894, chipY: 0.085, sign: { x: 0.894, y: 0.41 }, at: rel('S7b', 46.12) },
  ] as const,
}

// ───────────────────────────── S8 CLOSE
export const S8 = {
  media: { clip: 's08', still: 'k10', focus: '35% 50%' } as Media,
  mark: { at: 0 }, // slams on the cut = the music's last hit (47.19)
  wordmark: { text: 'SPAWN!', at: 0 },
  tagline: { text: 'THE OMNICHAIN MEME MACHINE', at: rel('S8', 47.6) },
  url: { text: 'spawn-multiverse.netlify.app', at: rel('S8', 48.0) },
  status: { lines: ['GUARDED BETA', 'SIX CHAINS · OPENING ONE BY ONE'], at: rel('S8', 48.4) },
  /** the last N seconds are a perfectly still frame (over the music's tail) */
  holdLast: 1.1, // still from 48.9
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
    // the end card slams on the last hit
    { sound: 'thump', frame: startFrame('S8') + f(S8.wordmark.at), volume: 0.5 },
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
  // the map: one pop per group of doors that lights up together
  for (const at of [...new Set(S7b.doors.map((d) => d.at))]) cues.push({ sound: 'pop', frame: startFrame('S7b') + f(at), volume: 0.4 })
  return cues
}
