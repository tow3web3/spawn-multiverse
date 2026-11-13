// Token images: a launch's face, hosted where every visitor can see it.
// The on-chain metaURI is capped at 1024 bytes, so it carries only the path
// this function returns (`/img/<sha256>`); the bytes live in Netlify Blobs.
//
//   POST   /img          raw image bytes → { url, path, key }
//   GET    /img/<key>    the image, immutable, never executable
//   DELETE /img/<key>    take-down (header x-admin-key = IMAGES_ADMIN_KEY)
//
// Env: IMAGES_DISABLED=1 refuses uploads (reads stay up); IMAGES_ADMIN_KEY
// enables the take-down path; IMAGES_MAX_PER_HOUR caps uploads site-wide.
// The rules themselves are in ../lib/token-image-core.mjs.
import { getStore } from '@netlify/blobs'
import { createHandler } from '../lib/token-image-core.mjs'

/** Drops the CDN copies of one image after a take-down. Browsers that
 * already fetched it keep their copy until their cache expires. */
async function purge(key) {
  const token = process.env.NETLIFY_PURGE_API_TOKEN
  const siteId = process.env.SITE_ID
  if (!token || !siteId) return false
  const r = await fetch('https://api.netlify.com/api/v1/purge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ site_id: siteId, cache_tags: [`img-${key}`] }),
  })
  return r.ok
}

export default createHandler({
  // strong consistency: an image must be readable the instant its upload
  // returns (the launch that references it follows within seconds), and
  // the rate counters must see each other's writes
  stores: () => ({
    images: getStore({ name: 'token-images', consistency: 'strong' }),
    limits: getStore({ name: 'token-image-limits', consistency: 'strong' }),
  }),
  purge,
})

export const config = { path: ['/img', '/img/:key'] }
