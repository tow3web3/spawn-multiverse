#!/usr/bin/env node
// Bundle once, render a set of review stills: node scripts/stills.mjs [frame ...]
// Output: out/stills/f<frame>.jpg. Pass BROWSER=/path/to/chrome to use a local Chromium.
import { bundle } from '@remotion/bundler'
import { renderStill, selectComposition } from '@remotion/renderer'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT = [20, 110, 160, 200, 290, 340, 420, 480, 501, 506, 520, 600, 700, 790, 830, 870, 900, 960, 1040, 1100, 1150, 1180, 1220, 1290, 1350, 1440, 1457]
const frames = process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n))
const list = frames.length ? frames : DEFAULT

const serveUrl = await bundle({ entryPoint: join(ROOT, 'src/index.ts'), publicDir: join(ROOT, 'public') })
const browserExecutable = process.env.BROWSER || null
const composition = await selectComposition({ serveUrl, id: 'Film', browserExecutable })
const outDir = join(ROOT, 'out/stills')
mkdirSync(outDir, { recursive: true })
for (const frame of list) {
  const output = join(outDir, `f${String(frame).padStart(4, '0')}.jpg`)
  await renderStill({ serveUrl, composition, frame, output, imageFormat: 'jpeg', jpegQuality: 85, browserExecutable })
  console.log(output)
}
// the bundle copies public/ (~100 MB): remove this run's copy
rmSync(serveUrl, { recursive: true, force: true })
