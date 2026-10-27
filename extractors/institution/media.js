import { randomBytes, createHmac } from 'node:crypto'
import { safeMediaUrl, rewriteManifest } from './net.js'

// One byte range over a body generated here: null serves it whole, false is unsatisfiable.
function byteRange(header, total) {
  const m = String(header || '').match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (!m[1] && !m[2])) return null
  let start, end = total - 1
  if (!m[1]) start = Math.max(0, total - Number(m[2]))
  else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])) }
  return start <= end && start < total ? { start, end } : false
}

// Per-institution capabilities; no user-supplied upstream URL is accepted.
export function createMediaGateway({ moduleId, fetchImpl, assertEnabled, resolveItem }) {
  const secret = randomBytes(32), resources = new Map()
  const root = `/institution/${moduleId}/`
  function register(item, url, prefix) {
    const safe = safeMediaUrl(url)
    const extension = new URL(safe).pathname.match(/\.[a-z0-9]{1,8}$/i)?.[0] || '.ts'
    const key = createHmac('sha256', secret).update(`${item.id}\0${safe}`).digest('hex').slice(0, 36) + extension
    resources.delete(key)
    resources.set(key, { item: { ...item, url: safe }, until: Date.now() + 21600000 })
    while (resources.size > 5000) resources.delete(resources.keys().next().value)
    return `${prefix}${root}${key}`
  }
  return {
    claims(path) { return path.startsWith(root) },
    clear() { resources.clear() },
    async handle(ctx, initialItem) {
      assertEnabled()
      let item = initialItem
      if (!item) {
        const key = ctx.path.slice(root.length), resource = resources.get(key)
        if (!resource || resource.until < Date.now()) {
          resources.delete(key)
          return { status: 410, body: '播放引用已过期，请重新打开节目' }
        }
        item = resource.item
      }
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), 25000)
      const dispose = () => { clearTimeout(timer); abort.abort() }
      try {
        assertEnabled()
        const request = range => fetchImpl(safeMediaUrl(item.url), {
          method: ctx.method === 'HEAD' ? 'HEAD' : 'GET', signal: abort.signal,
          headers: { ...item.headers, 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) },
        })
        // Manifests are rewritten whole; a player's Range applies to the rewritten text, never
        // upstream, or a probe reading the first 64 KiB gets a cut list without ENDLIST.
        const manifestUrl = /\.m3u8(?:\?|$)/i.test(item.url)
        let upstream = await request(manifestUrl ? '' : ctx.headers?.range)
        if (!manifestUrl && ctx.headers?.range && /mpegurl/i.test(upstream.headers.get('content-type') || '')) {
          await upstream.body?.cancel()
          upstream = await request('')
        }
        clearTimeout(timer)
        safeMediaUrl(upstream.url || item.url)
        assertEnabled()
        if (!upstream.ok && upstream.status !== 416) {
          await upstream.body?.cancel()
          throw new Error(`官方媒体 HTTP ${upstream.status}`)
        }
        const type = upstream.headers.get('content-type') || ''
        const hls = /mpegurl/i.test(type) || /\.m3u8(?:\?|$)/i.test(item.url)
        if (hls && ctx.method !== 'HEAD') {
          // A past live URL must never silently turn into a replay.
          if (item.kind === 'live') await resolveItem(item.id, 'live')
          const text = await upstream.text()
          assertEnabled()
          if (text.length > 2 * 1024 * 1024) throw new Error('清单过大')
          if (item.kind === 'live' && /#EXT-X-ENDLIST/.test(text)) throw new Error('直播已结束')
          const body = rewriteManifest(text, upstream.url || item.url, url => register(item, url, ctx.accessPrefix || ''))
          dispose()
          const headers = { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' }
          const bytes = Buffer.from(body), range = byteRange(ctx.headers?.range, bytes.length)
          if (range === false) return { status: 416, headers: { ...headers, 'Content-Range': `bytes */${bytes.length}` }, body: '' }
          if (range) return { status: 206, headers: { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${bytes.length}` }, body: bytes.subarray(range.start, range.end + 1) }
          return { status: 200, headers, body }
        }
        const responseHeaders = { 'Cache-Control': 'no-store' }
        for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          if (upstream.headers.has(header)) responseHeaders[header] = upstream.headers.get(header)
        }
        // app.js streams this body; long MP4s are never buffered into memory.
        return { status: upstream.status, headers: responseHeaders, body: upstream.body, dispose }
      } catch (error) { dispose(); throw error }
    },
  }
}
