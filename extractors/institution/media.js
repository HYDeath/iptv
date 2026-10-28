import { randomBytes, createHmac } from 'node:crypto'
import { safeMediaUrl, rewriteManifest, isHlsResponse } from './net.js'

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
  const lifetime = item => item.kind === 'live' ? 3600000 : 86400000
  function register(item, url, prefix) {
    const safe = safeMediaUrl(url, item.allowedHosts)
    const extension = new URL(safe).pathname.match(/\.[a-z0-9]{1,8}$/i)?.[0] || '.ts'
    const key = createHmac('sha256', secret).update(`${item.id}\0${safe}`).digest('hex').slice(0, 36) + extension
    resources.delete(key)
    resources.set(key, { item: { ...item, url: safe }, until: Date.now() + lifetime(item) })
    // Several eight-hour recordings can each reference thousands of segments.
    // Do not evict the start of a programme while registering its own manifest.
    while (resources.size > 100000) resources.delete(resources.keys().next().value)
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
        // 直播主清单下的子清单只在打开时登记一次，之后播放器一直轮询同一个地址：
        // 访问即续期并挪到末尾，长直播不会到点 410，按数量淘汰也先淘汰没人用的。
        resources.delete(key)
        resources.set(key, { ...resource, until: Date.now() + lifetime(resource.item) })
        item = resource.item
      }
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), 25000)
      const dispose = () => { clearTimeout(timer); abort.abort() }
      try {
        assertEnabled()
        const request = async range => {
          let url = safeMediaUrl(item.url, item.allowedHosts)
          for (let hop = 0; hop < 6; hop++) {
            assertEnabled()
            const response = await fetchImpl(url, {
              method: ctx.method === 'HEAD' ? 'HEAD' : 'GET', signal: abort.signal, redirect: 'manual',
              headers: { ...item.headers, 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) },
            })
            if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url }
            const location = response.headers.get('location')
            await response.body?.cancel()
            if (!location) throw new Error('官方媒体跳转缺少目标')
            url = safeMediaUrl(new URL(location, url), item.allowedHosts)
          }
          throw new Error('官方媒体跳转过多')
        }
        // Manifests are rewritten whole; a player's Range applies to the rewritten text, never
        // upstream, or a probe reading the first 64 KiB gets a cut list without ENDLIST.
        const manifestUrl = /\.m3u8(?:\?|$)/i.test(item.url)
        let fetched = await request(manifestUrl ? '' : ctx.headers?.range)
        let upstream = fetched.response
        if (!manifestUrl && ctx.headers?.range && isHlsResponse(fetched.url, upstream.headers.get('content-type') || '')) {
          await upstream.body?.cancel()
          fetched = await request('')
          upstream = fetched.response
        }
        clearTimeout(timer)
        safeMediaUrl(upstream.url || fetched.url, item.allowedHosts)
        assertEnabled()
        if (!upstream.ok && upstream.status !== 416) {
          await upstream.body?.cancel()
          throw new Error(`官方媒体 HTTP ${upstream.status}`)
        }
        const type = upstream.headers.get('content-type') || ''
        const hls = isHlsResponse(fetched.url, type)
        if (hls && ctx.method !== 'HEAD') {
          // A past live URL must never silently turn into a replay.
          if (item.kind === 'live') await resolveItem(item.id, 'live')
          const text = await upstream.text()
          assertEnabled()
          if (text.length > 2 * 1024 * 1024) throw new Error('清单过大')
          if (item.publicOnly && /#EXT-X-(?:SESSION-)?KEY:(?![^\r\n]*METHOD=NONE(?:,|\s|$))/i.test(text)) throw new Error('官方清单声明加密，请使用官方播放器')
          if (item.kind === 'live' && /#EXT-X-ENDLIST/.test(text)) throw new Error('直播已结束')
          const body = rewriteManifest(text, upstream.url || fetched.url, url => register(item, url, ctx.accessPrefix || ''))
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
        if (!hls && /mpegurl/i.test(type)) responseHeaders['content-type'] = /\.ts$/i.test(new URL(fetched.url).pathname) ? 'video/mp2t' : 'application/octet-stream'
        // app.js streams this body; long MP4s are never buffered into memory.
        return { status: upstream.status, headers: responseHeaders, body: upstream.body, dispose }
      } catch (error) { dispose(); throw error }
    },
  }
}
