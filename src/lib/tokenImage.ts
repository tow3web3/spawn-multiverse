/**
 * Token images. A launch's face is resized in the creator's browser, hosted
 * by the site's own `/img` function at launch, and referenced on-chain by its
 * path only. Everything rendered from chain data is restricted to that path
 * on this origin — never an arbitrary URL someone wrote into a metaURI.
 */

const IMG_PATH_RE = /^\/img\/[0-9a-f]{64}$/
/** Raster data URLs only — what `processImage` and the SIM produce locally. */
const DATA_RASTER_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/

/** Hosted images stay well under the function's 200 KB cap. */
const TARGET_BYTES = 150 * 1024

/**
 * The hosted-image path inside `v`, or undefined. Accepts `/img/<sha256>`
 * and the same path as an absolute URL on THIS origin; refuses everything
 * else (other hosts, other paths, query strings, data URLs).
 */
export function hostedImagePath(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 200) return undefined
  if (IMG_PATH_RE.test(v)) return v
  try {
    const u = new URL(v, window.location.origin)
    if (u.origin === window.location.origin && !u.search && !u.hash && IMG_PATH_RE.test(u.pathname)) {
      return u.pathname
    }
  } catch {
    /* not a URL */
  }
  return undefined
}

/** What an <img> may load for a token: a hosted path, or a local raster. */
export function safeImageSrc(v: string | undefined): string | undefined {
  if (!v) return undefined
  return hostedImagePath(v) ?? (DATA_RASTER_RE.test(v) ? v : undefined)
}

export interface ProcessedImage {
  /** For the preview, the SIM, and the creator's own local copy. */
  dataUrl: string
  /** What gets uploaded. */
  blob: Blob
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))

const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('unreadable image'))
    r.readAsDataURL(blob)
  })

/**
 * Center-crops to a square and re-encodes small: WebP at 320px first, then
 * smaller and lossier (JPEG where the browser cannot write WebP) until the
 * result fits. Whatever the user picked — a 12 MB photo, an SVG, an animated
 * GIF — what leaves the browser is one small raster frame.
 */
export async function processImage(file: File): Promise<ProcessedImage> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('unreadable image'))
      img.src = url
    })
    const s = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height)
    if (!s) throw new Error('unreadable image')
    const sx = ((img.naturalWidth || img.width) - s) / 2
    const sy = ((img.naturalHeight || img.height) - s) / 2

    let best: Blob | null = null
    for (const size of [320, 256, 192]) {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no canvas')
      // JPEG has no alpha: flatten onto white so transparent art stays clean
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, size, size)
      ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size)
      for (const [type, quality] of [
        ['image/webp', 0.86],
        ['image/webp', 0.7],
        ['image/jpeg', 0.8],
        ['image/jpeg', 0.6],
      ] as const) {
        const blob = await toBlob(canvas, type, quality)
        // a browser that cannot encode `type` hands back a PNG instead
        if (!blob || blob.type !== type) continue
        if (!best || blob.size < best.size) best = blob
        if (blob.size <= TARGET_BYTES) return { blob, dataUrl: await toDataUrl(blob) }
      }
    }
    if (!best) throw new Error('unreadable image')
    return { blob: best, dataUrl: await toDataUrl(best) }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Hosts one processed image and returns its path (`/img/<sha256>`). Throws
 * with a short human reason when hosting is unavailable (plain `vite dev`
 * has no functions), refused, or rate-limited — the caller decides whether
 * the launch goes on without it.
 */
export async function uploadTokenImage(blob: Blob): Promise<string> {
  let r: Response
  try {
    r = await fetch('/img', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    })
  } catch {
    throw new Error('image hosting is unreachable')
  }
  let body: { path?: unknown; error?: unknown } = {}
  try {
    body = await r.json()
  } catch {
    /* not our function answering (a dev server, a 404 page) */
  }
  const path = hostedImagePath(body.path)
  if (r.ok && path) return path
  throw new Error(typeof body.error === 'string' ? body.error : 'image hosting is unavailable here')
}
