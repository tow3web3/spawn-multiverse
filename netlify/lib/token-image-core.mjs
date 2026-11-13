// Token image hosting — the logic behind netlify/functions/token-image.mjs,
// kept free of the Netlify runtime so it can be unit-tested with plain
// in-memory stores (see token-image.test.mjs).
//
// What it stores is decided by the BYTES, never by what the client says they
// are: only PNG / JPEG / WebP / GIF, recognized by their magic numbers, up to
// 200 KB, content-addressed by sha256. What it serves can never run as a
// document: the type is re-derived from the bytes, sniffing is off, and the
// response carries a sandboxing CSP.
import { createHash, timingSafeEqual } from 'node:crypto'

export const MAX_BYTES = 200 * 1024
/** Uploads per client per window, and across all clients per window. */
export const RATE_MAX = 10
export const GLOBAL_MAX = 300
export const RATE_WINDOW_MS = 60 * 60 * 1000

const KEY_RE = /^[0-9a-f]{64}$/
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

const startsWith = (b, sig, at = 0) => sig.every((v, i) => b[at + i] === v)
const ascii = (s) => [...s].map((c) => c.charCodeAt(0))

/** The image type of `bytes`, from its magic number — or null. */
export function sniff(bytes) {
  if (bytes.length < 12) return null
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: 'image/png', ext: 'png' }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { type: 'image/jpeg', ext: 'jpg' }
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return { type: 'image/gif', ext: 'gif' }
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return { type: 'image/webp', ext: 'webp' }
  return null
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

function originOf(u) {
  try {
    return new URL(u).origin
  } catch {
    return null
  }
}

/** Origins allowed to call the write paths from a browser: the site itself
 * (as the request sees it and as Netlify names it) and localhost dev. */
function originAllowed(origin, reqOrigin, env) {
  if (origin === reqOrigin || LOCAL_ORIGIN_RE.test(origin)) return true
  return [env.URL, env.DEPLOY_PRIME_URL, env.DEPLOY_URL].some((u) => u && originOf(u) === origin)
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  })
}

/** One fixed window per counter key: { start, n }. Read-modify-write is not
 * atomic; a burst can slip a few past the limit, which is fine for a brake. */
async function take(limits, key, max, now) {
  let rec = null
  try {
    rec = await limits.get(key, { type: 'json' })
  } catch {
    rec = null
  }
  if (!rec || typeof rec.start !== 'number' || now - rec.start >= RATE_WINDOW_MS) rec = { start: now, n: 0 }
  if (rec.n >= max) return { ok: false, retryIn: Math.ceil((rec.start + RATE_WINDOW_MS - now) / 1000) }
  rec.n += 1
  await limits.setJSON(key, rec)
  return { ok: true }
}

function sameSecret(given, expected) {
  // compare digests: equal length, constant time
  const a = createHash('sha256').update(String(given)).digest()
  const b = createHash('sha256').update(String(expected)).digest()
  return timingSafeEqual(a, b)
}

/**
 * @param stores  () => ({ images, limits }) — Blobs-shaped stores, resolved lazily
 * @param env     process.env-shaped object
 * @param now     () => ms
 * @param purge   async (key) => boolean — drops the CDN copies of one image
 */
export function createHandler({ stores, env = process.env, now = Date.now, purge = async () => false }) {
  const imageKey = (req, context) => {
    const url = new URL(req.url)
    const candidate =
      context?.params?.key ?? url.searchParams.get('key') ?? url.pathname.split('/').filter(Boolean).pop() ?? ''
    const key = String(candidate).replace(/\.(png|jpe?g|gif|webp)$/i, '')
    return KEY_RE.test(key) ? key : null
  }

  async function upload(req, context, reqOrigin, cors) {
    if (env.IMAGES_DISABLED === '1') return json({ error: 'image uploads are switched off' }, 503, cors)
    const declared = Number(req.headers.get('content-length') ?? 0)
    if (declared > MAX_BYTES) return json({ error: 'image too large (200 KB max)' }, 413, cors)

    const { images, limits } = stores()
    const ip = context?.ip ?? req.headers.get('x-nf-client-connection-ip') ?? 'unknown'
    const t = now()
    // the raw address is never stored — only a digest of it
    const mine = await take(limits, `ip/${sha256(String(ip)).slice(0, 32)}`, RATE_MAX, t)
    if (!mine.ok) {
      return json({ error: 'too many uploads from here — try again later' }, 429, { ...cors, 'Retry-After': String(mine.retryIn) })
    }
    const all = await take(limits, 'global', Number(env.IMAGES_MAX_PER_HOUR) || GLOBAL_MAX, t)
    if (!all.ok) {
      return json({ error: 'image hosting is busy — try again later' }, 429, { ...cors, 'Retry-After': String(all.retryIn) })
    }

    const bytes = new Uint8Array(await req.arrayBuffer())
    if (bytes.length === 0) return json({ error: 'empty body' }, 400, cors)
    if (bytes.length > MAX_BYTES) return json({ error: 'image too large (200 KB max)' }, 413, cors)
    const kind = sniff(bytes)
    if (!kind) return json({ error: 'not a PNG, JPEG, WebP or GIF image' }, 415, cors)

    const key = sha256(bytes)
    if (await limits.get(`blocked/${key}`, { type: 'json' }).catch(() => null)) {
      return json({ error: 'this image was removed' }, 410, cors)
    }
    // content-addressed: the same bytes are the same key, stored once
    const existed = (await images.getMetadata(key).catch(() => null)) !== null
    if (!existed) {
      await images.set(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
        metadata: { type: kind.type, size: bytes.length, at: t },
      })
    }
    const site = env.URL && !LOCAL_ORIGIN_RE.test(reqOrigin) ? (originOf(env.URL) ?? reqOrigin) : reqOrigin
    const path = `/img/${key}`
    return json({ url: site + path, path, key, type: kind.type, size: bytes.length }, existed ? 200 : 201, cors)
  }

  async function serve(req, key) {
    const { images } = stores()
    const hit = await images.getWithMetadata(key, { type: 'arrayBuffer' }).catch(() => null)
    const bytes = hit?.data ? new Uint8Array(hit.data) : null
    // the type comes from the bytes again — metadata is never trusted
    const kind = bytes ? sniff(bytes) : null
    if (!kind) return new Response('not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
    const headers = {
      'Content-Type': kind.type,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Netlify-Cache-Tag': `token-image,img-${key}`,
      ETag: `"${key}"`,
      // an uploaded file must never run as a document, whatever it contains
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `inline; filename="${key}.${kind.ext}"`,
      'Cross-Origin-Resource-Policy': 'cross-origin',
    }
    if (req.headers.get('if-none-match') === `"${key}"`) return new Response(null, { status: 304, headers })
    return new Response(req.method === 'HEAD' ? null : bytes, { status: 200, headers })
  }

  async function remove(req, key, cors) {
    // no secret configured → the path does not exist
    if (!env.IMAGES_ADMIN_KEY) return json({ error: 'not found' }, 404, cors)
    // the secret is judged before the key, so a wrong secret learns nothing
    // about which images exist
    if (!sameSecret(req.headers.get('x-admin-key') ?? '', env.IMAGES_ADMIN_KEY)) {
      return json({ error: 'forbidden' }, 403, cors)
    }
    if (!key) return json({ error: 'not found' }, 404, cors)
    const { images, limits } = stores()
    await images.delete(key)
    // the same bytes cannot be uploaded again
    await limits.setJSON(`blocked/${key}`, { at: now() })
    const purged = await purge(key).catch(() => false)
    return json({ deleted: key, purged }, 200, cors)
  }

  return async function handler(req, context = {}) {
    const reqOrigin = new URL(req.url).origin
    const origin = req.headers.get('origin')
    const allowed = !origin || originAllowed(origin, reqOrigin, env)
    const cors = origin && allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}
    const method = req.method.toUpperCase()

    if (method === 'GET' || method === 'HEAD') {
      const key = imageKey(req, context)
      if (!key) return new Response('not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
      return serve(req, key)
    }

    // every write path refuses a browser on a foreign origin
    if (!allowed) return json({ error: 'origin not allowed' }, 403)
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
          'Access-Control-Max-Age': '86400',
        },
      })
    }
    if (method === 'POST') return upload(req, context, reqOrigin, cors)
    if (method === 'DELETE') return remove(req, imageKey(req, context), cors)
    return json({ error: 'method not allowed' }, 405, { ...cors, Allow: 'GET, HEAD, POST, DELETE, OPTIONS' })
  }
}
