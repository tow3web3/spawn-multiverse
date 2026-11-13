import { loadFont as loadAnton } from '@remotion/google-fonts/Anton'
import { loadFont as loadSpaceGrotesk } from '@remotion/google-fonts/SpaceGrotesk'
import { loadFont as loadSpaceMono } from '@remotion/google-fonts/SpaceMono'

const anton = loadAnton('normal', { weights: ['400'], subsets: ['latin'] })
const mono = loadSpaceMono('normal', { weights: ['400', '700'], subsets: ['latin'] })
const grotesk = loadSpaceGrotesk('normal', { weights: ['500', '700'], subsets: ['latin'] })

export const FONT = {
  title: anton.fontFamily,
  mono: mono.fontFamily,
  sans: grotesk.fontFamily,
}

/** The product site's palette, exactly. */
export const C = {
  cream: '#f4f1e8',
  ink: '#141414',
  lime: '#c9f24b',
  candy: '#f7a8ce',
  hot: '#f06eaa',
  sky: '#9ccbf5',
  grape: '#a78bf0',
  tang: '#f7be7b',
  void: '#17161c',
  up: '#1f9d4d',
  down: '#e0245e',
  white: '#ffffff',
}

/** Neobrutalist constants at 1080p. */
export const B = {
  border: 6,
  borderThin: 4,
  shadow: (n = 10) => `${n}px ${n}px 0 ${C.ink}`,
  radius: 18,
  radiusSm: 12,
}
