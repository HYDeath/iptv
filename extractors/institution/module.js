import { createHash } from 'node:crypto'
import { getExtractorManager } from '../../utils/extractorManager.js'
import { fetchWithTimeout, safeMediaUrl, validateLive } from './net.js'
import { createMediaGateway } from './media.js'

const RELIGIOUS = /宗教|佛教|佛寺|寺庙|基督|天主教|教会|道教|清真|伊斯兰|弘法|法会|讲经|禅修|\b(?:church|cathedral|mosque|worship|liturgy|sermon)\b/i
export function refFor(moduleId, item) {
  const hash = createHash('sha256').update(String(item.id)).digest('hex').slice(0, 24)
  return `${moduleId}-${hash}.${/\.m3u8(?:\?|$)/i.test(item.url) ? 'm3u8' : 'mp4'}`
}
export function createInstitutionModule(spec, runtime = {}) {
  let module
  const identities = new Map(), liveChecks = new Map()
  const enabled = () => runtime.isEnabled ? runtime.isEnabled() : getExtractorManager().isModuleEnabled(module)
  const assertEnabled = () => { if (!enabled()) throw new Error('该机构模块已关闭') }
  const fetchImpl = async (...args) => { assertEnabled(); return (runtime.fetchImpl || fetchWithTimeout)(...args) }
  const normalize = item => {
    if (!item || !['live', 'vod'].includes(item.kind) || !item.id || !item.title || RELIGIOUS.test(`${item.title} ${item.description || ''}`)) throw new Error('节目当前不在公开收录范围')
    if (item.institution && item.institution !== spec.selector) throw new Error('节目不属于该机构')
    if (item.provider && item.provider !== spec.providerId) throw new Error('来源不匹配')
    return { ...item, institution: spec.selector, url: safeMediaUrl(item.url, item.allowedHosts) }
  }
  async function resolveItem(id, expectedKind) {
    assertEnabled()
    const item = normalize(await spec.adapter.resolve(id, { institution: spec.selector, fetchImpl }))
    assertEnabled()
    if (expectedKind && item.kind !== expectedKind) throw new Error('节目状态已变化，请刷新目录')
    if (item.kind === 'live' && Date.now() - (liveChecks.get(id) || 0) > 30000) {
      await (runtime.validateLive || validateLive)(item, { fetchImpl })
      liveChecks.set(id, Date.now())
    }
    return item
  }
  const canonical = ref => String(ref).replace(/\.(?:mp4|m3u8)$/i, '')
  function identityFor(ref) {
    const key = canonical(ref)
    if (identities.has(key)) return identities.get(key)
    const groups = runtime.cachedGroups ? runtime.cachedGroups() : getExtractorManager().cache.modules[spec.id]?.groups || []
    for (const group of groups) for (const channel of group.dataList || []) {
      if (canonical(channel.deferredRef) !== key || !channel.institutionItemId || !['live', 'vod'].includes(channel.institutionKind)) continue
      const identity = { id: channel.institutionItemId, kind: channel.institutionKind }
      // Cached identity must match its stable namespace, even after a restart.
      const expected = canonical(refFor(spec.id, { id: identity.id, url: '' }))
      if (expected !== key) return null
      identities.set(key, identity)
      return identity
    }
    return null
  }
  const gateway = createMediaGateway({ moduleId: spec.id, fetchImpl, assertEnabled, resolveItem })
  module = {
    id: spec.id, name: spec.name, category: 'institution',
    description: `${spec.description}节目按[直播]／[回放]标注，默认关闭。`,
    // 点播录像为主、只有少数人看，且媒体全经本机转发：一律由用户自己打开。
    defaultEnabled: false,
    capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
    catalogVersion: 1, defaultRefreshMinutes: 60, minRefreshMinutes: 15, maxRefreshMinutes: 1440,
    configSchema: [],
    async fetch() {
      assertEnabled()
      const result = await spec.adapter.discover({ institution: spec.selector, fetchImpl })
      assertEnabled()
      const channels = [], skipped = []
      for (const candidate of result.items || []) {
        try {
          const item = normalize(candidate)
          if (item.kind === 'live') await (runtime.validateLive || validateLive)(item, { fetchImpl })
          const ref = refFor(spec.id, item)
          identities.set(canonical(ref), { id: item.id, kind: item.kind })
          channels.push({
            name: `[${item.kind === 'live' ? '直播' : '回放'}] ${String(item.title).replace(/[\r\n\t]/g, ' ')}`,
            deferredRef: ref, logo: '', catchup: 'none',
            institutionItemId: item.id, institutionKind: item.kind, officialPage: item.pageUrl || spec.officialUrl,
          })
        } catch { skipped.push(`${candidate.title || candidate.id || '项目'}：当前不可公开播放或不在收录范围`) }
      }
      return { groups: channels.length ? [{ name: spec.name, dataList: channels }] : [], meta: { skipped, warnings: result.notes || [] } }
    },
    claimsRef(ref) { return new RegExp(`^${spec.id}-[a-f0-9]{24}(?:\\.(?:mp4|m3u8))?$`).test(ref) },
    async resolve(ref, ctx = {}) {
      try {
        assertEnabled()
        const identity = identityFor(ref)
        if (!identity) return { url: '', desc: '节目引用不存在，请刷新目录' }
        const item = await resolveItem(identity.id, identity.kind)
        return { url: item.url, upstreamHeaders: item.headers || {}, desc: '' }
      } catch { return { url: '', desc: enabled() ? '节目暂不可播放，请查看官方页面或刷新目录' : '该机构模块已关闭' } }
    },
    claimsLocalPath(path) { return module.claimsRef(path.replace(/^\//, '')) || gateway.claims(path) },
    async handleLocalRequest(ctx) {
      try {
        assertEnabled()
        if (!['GET', 'HEAD'].includes(ctx.method)) return { status: 405, body: '仅支持 GET / HEAD' }
        if (gateway.claims(ctx.path)) return await gateway.handle(ctx)
        const ref = ctx.path.replace(/^\//, ''), identity = identityFor(ref)
        if (!identity) return { status: 404, body: '节目引用不存在，请刷新目录' }
        return await gateway.handle(ctx, await resolveItem(identity.id, identity.kind))
      } catch { return { status: enabled() ? 502 : 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, body: enabled() ? '官方节目当前不可播放，请刷新目录或查看官方页面' : '该机构模块已关闭' } }
    },
    clearResolveCache() { liveChecks.clear(); gateway.clear() },
  }
  return module
}
