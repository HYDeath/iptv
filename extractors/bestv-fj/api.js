import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { createApiClient, requestText } from './auth.js'
import { CHANNELS, DEFAULT_CHANNEL_IDS, GROUP, channelForRef, refOf } from './channels.js'

export function selectedIds(config = {}) {
  if (config.channels === undefined) return [...DEFAULT_CHANNEL_IDS]
  const ids = Array.isArray(config.channels) ? config.channels : String(config.channels).split(/\r?\n/)
  const unique = [...new Set(ids.map(id => String(id).trim()).filter(Boolean))]
  if (!unique.length || unique.some(id => !CHANNELS.some(c => c.id === id))) throw new Error('频道选择无效')
  return unique
}
export function officialLogo(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && url.hostname === 'tvappstatic.bestv.com.cn'
      && !url.username && !url.password && !url.port && /^\/images\/[\w/.-]+\.(png|jpe?g)$/i.test(url.pathname) ? url.href : ''
  } catch { return '' }
}
export function buildChannels(payload, ids) {
  if (!Array.isArray(payload) || payload.some(g => !Array.isArray(g?.items))) throw new Error('官方频道目录结构已变化')
  const rows = payload.flatMap(group => group.items)
  const output = []
  for (const id of ids) {
    // 官方把东南卫视同时列在「福建」「卫视」；相同元数据合并，互相矛盾的目录仍失败。
    const matches = [...new Map(rows.filter(row => String(row.id) === id)
      .map(row => [JSON.stringify([row.id, row.name, row.icon, row.enabled, row.mode, row.audio]), row])).values()]
    if (matches.length !== 1) throw new Error(`官方目录未唯一列出频道 ${id}`)
    const row = matches[0]
    if (row.enabled !== 1 || row.mode !== 'live' || row.audio !== 0) continue
    if (row.name !== CHANNELS.find(c => c.id === id).name) throw new Error(`频道 ${id} 的官方名称已变化，需要复核`)
    const logo = officialLogo(row.icon)
    if (!logo) throw new Error(`频道 ${id} 没有可识别的官方台标`)
    output.push({ name: row.name, deferredRef: refOf(id), logo,
      groupTitle: GROUP, relayHls: true, catchup: 'none' })
  }
  return output
}
export async function fetchChannels(config, ctx = {}) {
  const api = createApiClient({ fetchImpl: ctx.fetchImpl || proxyAwareFetch, timeoutMs: ctx.timeoutMs || 12000 })
  const ids = selectedIds(config)
  const channels = buildChannels(await api.request('/tvs'), ids)
  if (!channels.length) throw new Error('已选择的频道在官方目录中均已停用')
  const missing = ids.filter(id => !channels.some(c => c.deferredRef === refOf(id)))
  return { groups: [{ name: GROUP, dataList: channels }], meta: { skipped: missing, warnings: missing.length ? [`官方目录已停用 ${missing.length} 个选中频道`] : [] } }
}

/** CDN 必须处于当前频道的签名目录内；绝不把 API 凭据发给媒体主机。 */
export function mediaUrl(raw, base) {
  let url
  try { url = new URL(String(raw)) } catch { throw new Error('媒体地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || !/^fjnetv\d+\.live\.bestvcdn\.com\.cn$/.test(url.hostname)
      || url.username || url.password || url.port || url.hash
      || !/^\/[A-Za-z0-9=_-]{32,2048}\/live\/program\/live\/[a-zA-Z0-9_-]+\/\d+\/(?:mnf\.m3u8|\d{10}\/\d+\.ts)$/.test(url.pathname)) {
    throw new Error('媒体地址不在福建百视通官方直播目录')
  }
  if (base) {
    const origin = new URL(base)
    if (url.origin !== origin.origin || !url.pathname.startsWith(new URL('.', origin).pathname)) throw new Error('媒体地址不属于当前频道')
  }
  return url.href
}
export function validateManifest(text, base) {
  if (!text.startsWith('#EXTM3U') || /#EXT-X-(KEY|MAP|STREAM-INF|ENDLIST)/.test(text)
      || !/#EXT-X-MEDIA-SEQUENCE:\d+/.test(text)) throw new Error('上游不是已验证格式的未加密直播清单')
  let count = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const url = mediaUrl(new URL(line, base).href, base)
    if (!new URL(url).pathname.endsWith('.ts')) throw new Error('清单没有 TS 分片')
    count++
  }
  if (!count || !text.includes('#EXTINF:')) throw new Error('直播清单没有媒体分片')
  return text
}

export function createResolver({ fetchImpl = proxyAwareFetch, now = () => Date.now(), timeoutMs = 12000 } = {}) {
  const api = createApiClient({ fetchImpl, now, timeoutMs })
  const cache = new Map(), pending = new Map()
  let generation = 0
  async function play(channel, force = false) {
    if (!force && cache.get(channel.id)?.expiresAt > now()) return cache.get(channel.id).url
    if (force) cache.delete(channel.id)
    if (!pending.has(channel.id)) {
      const gen = generation, started = now()
      const promise = api.request(`/tv/now/${channel.id}`).then(data => {
        if (String(data?.tvid) !== channel.id || data.tv_name !== channel.name || data.state !== 'live' || data.paid !== false || !data.playUrl) throw new Error('频道不可播、需要付费或身份不匹配')
        const url = mediaUrl(data.playUrl)
        const valid = Number(data.validSeconds)
        if (!Number.isFinite(valid) || valid <= 30) throw new Error('播放地址缺少足够有效期')
        if (gen === generation) cache.set(channel.id, { url, expiresAt: started + Math.min(120, valid - 30) * 1000 })
        return url
      }).finally(() => { if (pending.get(channel.id) === promise) pending.delete(channel.id) })
      pending.set(channel.id, promise)
    }
    return pending.get(channel.id)
  }
  async function resolve(ref) {
    const channel = channelForRef(ref)
    if (!channel) return { url: '', desc: '百视通频道不存在' }
    try {
      let url = await play(channel), text
      try { text = validateManifest(await requestText(url, { fetchImpl, timeoutMs }), url) }
      catch {
        // 缓存尚未到期但 CDN 已拒绝时，立即重新取票；仍失败就结束，不回退旧地址。
        url = await play(channel, true)
        text = validateManifest(await requestText(url, { fetchImpl, timeoutMs }), url)
      }
      return { url, desc: '福建百视通直播', relayHls: true, manifestText: text, manifestUrl: url,
        upstreamUrlTransform: raw => mediaUrl(raw, url) }
    } catch (error) {
      cache.delete(channel.id)
      return { url: '', desc: `百视通取流失败：${error?.message || '上游不可用'}` }
    }
  }
  function clear() { generation++; cache.clear(); pending.clear(); api.clear() }
  return { resolve, clear }
}
const resolver = createResolver()
export const resolveChannel = resolver.resolve
export const clearResolveCache = resolver.clear
