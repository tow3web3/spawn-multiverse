// node --test netlify/lib/
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createHandler, MAX_BYTES, RATE_MAX, RATE_WINDOW_MS, sniff } from './token-image-core.mjs'

/** A Blobs-shaped store kept in memory. */
function memStore() {
  const m = new Map()
  const calls = { set: 0 }
  return {
    m,
    calls,
    async get(key, opts) {
      const v = m.get(key)
      if (!v) return null
      return opts?.type === 'json' ? JSON.parse(v.data) : v.data
    },
    async getMetadata(key) {
      const v = m.get(key)
      return v ? { etag: 'e', metadata: v.metadata } : null
    },
    async getWithMetadata(key) {
      const v = m.get(key)
      return v ? { data: v.data, etag: 'e', metadata: v.metadata } : null
    },
    async set(key, data, opts) {
      calls.set++
      m.set(key, { data, metadata: opts?.metadata ?? {} })
    },
    async setJSON(key, data) {
      m.set(key, { data: JSON.stringify(data), metadata: {} })
    },
    async delete(key) {
      m.delete(key)
    },
  }
}

const SITE = 'https://spawn-multiverse.netlify.app'

function world({ env = {}, site = SITE } = {}) {
  const images = memStore()
  const limits = memStore()
  const clock = { t: 1_800_000_000_000 }
  const purged = []
  const handler = createHandler({
    stores: () => ({ images, limits }),
    env: { URL: SITE, ...env },
    now: () => clock.t,
    purge: async (key) => {
      purged.push(key)
      return true
    },
  })
  const post = (body, { ip = '203.0.113.7', origin, headers = {} } = {}) =>
    handler(
      new Request(`${site}/img`, {
        method: 'POST',
        body,
        headers: { ...(origin ? { origin } : {}), ...headers },
      }),
      { ip },
    )
  const get = (key, { method = 'GET', headers = {} } = {}) =>
    handler(new Request(`${site}/img/${key}`, { method, headers }), { params: { key } })
  const del = (key, adminKey) =>
    handler(
      new Request(`${site}/img/${key}`, { method: 'DELETE', headers: adminKey ? { 'x-admin-key': adminKey } : {} }),
      { params: { key } },
    )
  return { handler, images, limits, clock, purged, post, get, del }
}

const pad = (head, total = 64) => {
  const b = new Uint8Array(Math.max(total, head.length))
  b.set(head)
  return b
}
const ascii = (s) => [...s].map((c) => c.charCodeAt(0))
const PNG = (n = 64, salt = 0) => {
  const b = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], n)
  b[20] = salt
  return b
}
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF')])
const GIF = pad(ascii('GIF89a'))
const WEBP = pad([...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8 ')])
const sha = (b) => createHash('sha256').update(b).digest('hex')

test('accepts PNG, JPEG, WebP and GIF by their magic bytes and returns a content-addressed URL', async () => {
  const w = world()
  for (const [bytes, type] of [
    [PNG(), 'image/png'],
    [JPEG, 'image/jpeg'],
    [WEBP, 'image/webp'],
    [GIF, 'image/gif'],
  ]) {
    const r = await w.post(bytes, { ip: `198.51.100.${type.length}` })
    assert.equal(r.status, 201)
    const j = await r.json()
    assert.equal(j.key, sha(bytes))
    assert.equal(j.path, `/img/${j.key}`)
    assert.equal(j.url, `${SITE}/img/${j.key}`)
    assert.equal(j.type, type)
  }
  assert.equal(w.images.m.size, 4)
})

test('the declared content type is ignored: a disguised SVG, HTML or script is refused', async () => {
  const w = world()
  const enc = (s) => new TextEncoder().encode(s)
  const liars = [
    ['image/png', enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['image/svg+xml', enc('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['image/jpeg', enc('<!DOCTYPE html><html><body><script>fetch("/x")</script></body></html>')],
    ['image/webp', enc('RIFF....WAVEfmt this is audio, not an image')],
    ['image/png', enc('\x89PNG but the rest of the signature is wrong')],
    ['image/gif', enc('GIF90a is not a GIF version')],
  ]
  for (const [i, [type, body]] of liars.entries()) {
    const r = await w.post(body, { ip: `198.51.100.${i + 1}`, headers: { 'content-type': type } })
    assert.equal(r.status, 415, `${type} must be refused`)
  }
  assert.equal(w.images.m.size, 0)
  assert.equal((await w.post(new Uint8Array(0), { ip: '198.51.100.99' })).status, 400)
  assert.equal(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null) // too short to be an image
})

test('200 KB is the cap, checked on the real bytes', async () => {
  const w = world()
  assert.equal((await w.post(PNG(MAX_BYTES))).status, 201)
  assert.equal((await w.post(PNG(MAX_BYTES + 1))).status, 413)
  assert.equal(w.images.m.size, 1)
  // an oversized declared length is turned away before the body is read or
  // a rate-limit slot is spent
  const before = w.limits.m.size
  const fresh = world()
  const declared = await fresh.handler(
    {
      method: 'POST',
      url: `${SITE}/img`,
      headers: new Headers({ 'content-length': String(MAX_BYTES + 5) }),
      arrayBuffer: async () => {
        throw new Error('the body must not be read')
      },
    },
    { ip: '203.0.113.7' },
  )
  assert.equal(declared.status, 413)
  assert.equal(fresh.limits.m.size, 0)
  assert.ok(before > 0)
})

test('the same bytes are stored once and return the same key', async () => {
  const w = world()
  const a = await w.post(PNG())
  const b = await w.post(PNG())
  assert.equal(a.status, 201)
  assert.equal(b.status, 200)
  assert.equal((await a.json()).key, (await b.json()).key)
  assert.equal(w.images.calls.set, 1)
  assert.equal(w.images.m.size, 1)
})

test(`rate limit: ${RATE_MAX} uploads per client per hour, counted on a digest of the address`, async () => {
  const w = world()
  for (let i = 0; i < RATE_MAX; i++) assert.equal((await w.post(PNG(64, i))).status, 201)
  const over = await w.post(PNG(64, 200))
  assert.equal(over.status, 429)
  assert.ok(Number(over.headers.get('retry-after')) > 0)
  // refused attempts store nothing
  assert.equal(w.images.m.size, RATE_MAX)
  // another client is not affected
  assert.equal((await w.post(PNG(64, 201), { ip: '203.0.113.99' })).status, 201)
  // the window rolls over
  w.clock.t += RATE_WINDOW_MS + 1
  assert.equal((await w.post(PNG(64, 202))).status, 201)
  // the raw address never reaches the store
  for (const k of w.limits.m.keys()) assert.ok(!k.includes('203.0.113'), k)
})

test('a site-wide cap brakes a distributed flood', async () => {
  const w = world({ env: { IMAGES_MAX_PER_HOUR: '3' } })
  for (let i = 0; i < 3; i++) assert.equal((await w.post(PNG(64, i), { ip: `192.0.2.${i}` })).status, 201)
  assert.equal((await w.post(PNG(64, 9), { ip: '192.0.2.200' })).status, 429)
})

test('kill switch: uploads refused, reads still served', async () => {
  const w = world()
  const { key } = await (await w.post(PNG())).json()
  const off = world({ env: { IMAGES_DISABLED: '1' } })
  off.images.m.set(key, w.images.m.get(key))
  assert.equal((await off.post(PNG(64, 1))).status, 503)
  assert.equal((await off.get(key)).status, 200)
})

test('GET serves the bytes immutable and inert, typed from the bytes themselves', async () => {
  const w = world()
  const bytes = PNG()
  const { key } = await (await w.post(bytes)).json()
  // poison the metadata: it must not be believed
  w.images.m.get(key).metadata = { type: 'text/html' }
  const r = await w.get(key)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'image/png')
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/)
  assert.match(r.headers.get('content-security-policy'), /sandbox/)
  assert.equal(r.headers.get('content-disposition'), `inline; filename="${key}.png"`)
  assert.equal(r.headers.get('etag'), `"${key}"`)
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes)

  const head = await w.get(key, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal((await head.arrayBuffer()).byteLength, 0)
  assert.equal((await w.get(key, { headers: { 'if-none-match': `"${key}"` } })).status, 304)
  // an extension on the pretty URL is tolerated
  const ext = await w.handler(new Request(`${SITE}/img/${key}.png`), {})
  assert.equal(ext.status, 200)
})

test('GET refuses anything that is not a stored image', async () => {
  const w = world()
  const miss = await w.get('f'.repeat(64))
  assert.equal(miss.status, 404)
  assert.equal(miss.headers.get('cache-control'), 'no-store')
  assert.equal((await w.get('../../etc/passwd')).status, 404)
  assert.equal((await w.get('ABC')).status, 404)
  assert.equal((await w.handler(new Request(`${SITE}/img`), {})).status, 404)
  // bytes that are not an image are never served, even if something put them there
  const key = 'a'.repeat(64)
  w.images.m.set(key, { data: new TextEncoder().encode('<html><script>1</script></html>').buffer, metadata: { type: 'image/png' } })
  assert.equal((await w.get(key)).status, 404)
})

test('write paths answer only the site itself and localhost dev', async () => {
  const w = world()
  const evil = await w.post(PNG(), { origin: 'https://evil.example' })
  assert.equal(evil.status, 403)
  assert.equal(evil.headers.get('access-control-allow-origin'), null)
  assert.equal(w.images.m.size, 0)

  const same = await w.post(PNG(64, 1), { origin: SITE })
  assert.equal(same.status, 201)
  assert.equal(same.headers.get('access-control-allow-origin'), SITE)
  assert.equal((await w.post(PNG(64, 2), { origin: 'http://localhost:5173' })).status, 201)
  assert.equal((await w.post(PNG(64, 3))).status, 201) // no Origin header: not a browser
  // a deploy preview is the site too
  const preview = world({ env: { DEPLOY_PRIME_URL: 'https://deploy-preview-7--spawn-multiverse.netlify.app' } })
  assert.equal((await preview.post(PNG(), { origin: 'https://deploy-preview-7--spawn-multiverse.netlify.app' })).status, 201)

  const pre = await w.handler(new Request(`${SITE}/img`, { method: 'OPTIONS', headers: { origin: SITE } }), {})
  assert.equal(pre.status, 204)
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/)
  const badPre = await w.handler(new Request(`${SITE}/img`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), {})
  assert.equal(badPre.status, 403)
  assert.equal((await w.handler(new Request(`${SITE}/img`, { method: 'PUT', body: 'x' }), {})).status, 405)
})

test('the returned URL is the public site in production and the request origin on localhost', async () => {
  const local = world({ site: 'http://localhost:8888' })
  const j = await (await local.post(PNG())).json()
  assert.equal(j.url, `http://localhost:8888/img/${j.key}`)
  const prod = world({ site: 'https://deploy-preview-7--spawn-multiverse.netlify.app' })
  const k = await (await prod.post(PNG())).json()
  assert.equal(k.url, `${SITE}/img/${k.key}`)
})

test('admin take-down: off without a secret, guarded by it, final once done', async () => {
  const closed = world()
  const { key } = await (await closed.post(PNG())).json()
  assert.equal((await closed.del(key, 'anything')).status, 404)
  assert.equal((await closed.get(key)).status, 200)

  const w = world({ env: { IMAGES_ADMIN_KEY: 'correct horse' } })
  const up = await (await w.post(PNG())).json()
  assert.equal((await w.del(up.key)).status, 403)
  assert.equal((await w.del(up.key, 'wrong')).status, 403)
  assert.equal((await w.get(up.key)).status, 200)
  const done = await w.del(up.key, 'correct horse')
  assert.equal(done.status, 200)
  assert.deepEqual(await done.json(), { deleted: up.key, purged: true })
  assert.deepEqual(w.purged, [up.key])
  assert.equal((await w.get(up.key)).status, 404)
  // the same bytes cannot come back
  assert.equal((await w.post(PNG(), { ip: '192.0.2.50' })).status, 410)
  assert.equal(w.images.m.size, 0)
  // the secret is judged before the key: a wrong one learns nothing
  assert.equal((await w.del('nope', 'correct horse')).status, 404)
  assert.equal((await w.del('nope', 'wrong')).status, 403)
  assert.equal((await w.del('f'.repeat(64), 'wrong')).status, 403)
})
