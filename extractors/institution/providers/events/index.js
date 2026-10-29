import { readFileSync } from 'node:fs'
import * as movie1905 from './movie1905.mjs'
import * as weibo from './weibo.mjs'
import * as mgtv from './mgtv.mjs'
import { safeMediaUrl } from '../../net.js'

// Only stable official identities and verification dates; never persist playback grants.
const verified = JSON.parse(readFileSync(new URL('./verified.json', import.meta.url)))
const fingerprint = item => JSON.stringify([item.provider, item.id, item.title, item.page, item.kind])
export function createEventAdapter(source, seeds = verified.filter(item => item.provider === source.id)) {
  const identities = new Map(seeds.map(item => [item.id, item]))
  const fingerprints = new Set(seeds.map(fingerprint))
  async function resolve(id, options = {}) {
    const seed = identities.get(id)
    if (!seed) throw new Error('活动不属于已验证的官方目录')
    const media = await source.resolve(seed, { ...options, fresh: true })
    if (media.kind !== seed.kind || !media.allowedHosts?.length) throw new Error('活动权限或状态已变化，请刷新目录')
    return {
      id, provider: source.id, title: seed.title, pageUrl: seed.page,
      kind: seed.kind === 'replay' ? 'vod' : 'live',
      url: safeMediaUrl(media.url, media.allowedHosts), headers: media.headers || {},
      allowedHosts: media.allowedHosts, publicOnly: true,
    }
  }
  return {
    provider: { id: source.id }, resolve,
    async discover(options = {}) {
      const result = source.lookup
        ? await source.lookup(seeds, options)
        : await source.discover({ ...options, limit: 24 })
      const items = [], notes = ['首批仅收录已逐条播放验收的完整活动回放；新增场次须验证后加入。登录、付费、试看和加密内容不收录。']
      const failures = []
      for (const item of result.items || []) {
        if (!fingerprints.has(fingerprint(item))) continue
        try { items.push(await resolve(item.id, options)) }
        catch (error) {
          notes.push(`${item.title}：当前官方权限或播放链路未通过检查`)
          failures.push(`${item.title}：${error.message}`)
        }
      }
      // 只收已验收场次，一条都没通过多半是官网临时故障或限流。返回空目录会让主项目
      // 用空结果覆盖缓存、频道从订阅里消失，所以抛错保留上一轮缓存，原因写进健康状态。
      if (seeds.length && !items.length) {
        for (const entry of result.blocked || []) {
          if (identities.has(entry.id)) failures.push(`${entry.title}：${entry.reason}`)
        }
        failures.push(...(result.notes || []).filter(note => /HTTP|失败|不可用|超时/.test(note)))
        const reasons = failures.length ? `：${failures.slice(0, 3).join('；')}` : '，官方目录本轮没有返回这些场次'
        throw new Error(`${seeds.length} 场已验收活动本轮全部未通过检查${reasons}`.slice(0, 300))
      }
      return { items, notes }
    },
  }
}
export const movie1905Adapter = createEventAdapter(movie1905)
export const weiboAdapter = createEventAdapter(weibo)
export const mgtvEventsAdapter = createEventAdapter(mgtv)
