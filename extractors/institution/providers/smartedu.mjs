import { readFileSync } from 'node:fs'
import { fetchWithTimeout, safeMediaUrl } from '../net.js'

export const provider = { id: 'smartedu', officialUrl: 'https://higher.smartedu.cn/teacher' }
const API = 'https://api.chinaooc.com.cn/api/v2'
const HOSTS = ['jsjy-video.oss-cn-beijing.aliyuncs.com']
const verified = JSON.parse(readFileSync(new URL('./smartedu-verified.json', import.meta.url)))
const seeds = new Map(verified.map(item => [item.id, item]))

async function rows(keyword, { fetchImpl = fetchWithTimeout } = {}) {
  const page = await fetchImpl(provider.officialUrl)
  if (!page.ok || (await page.text()).match(/apiUser:"([^"]+)"/)?.[1] !== API) throw new Error('智慧高教官方接口配置变化')
  const url = new URL(`${API}/CompetitionAwardCourse/search`)
  url.search = new URLSearchParams({ pageSize: '20', page: '1', session: '第五届', keyword })
  const response = await fetchImpl(url, { headers: { Referer: provider.officialUrl } })
  if (!response.ok) throw new Error(`智慧高教官方目录 HTTP ${response.status}`)
  const result = await response.json()
  if (result._status !== 'OK' || !Array.isArray(result._items)) throw new Error('智慧高教官方目录结构变化')
  return result._items
}

export function itemFor(row, seed) {
  if (!row || row.id !== seed.courseId || row.session !== seed.session || row.university !== seed.school || row.name !== seed.teacher || `${row.courseName} · 第${seed.id.endsWith('-1') ? 1 : 2}讲` !== seed.title) throw new Error('智慧高教课程身份变化')
  const url = safeMediaUrl(seed.id.endsWith('-1') ? row.videoUrl01 : row.videoUrl02, HOSTS)
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.search || !parsed.pathname.endsWith('.mp4')) throw new Error('智慧高教公开媒体形式变化')
  return { id: seed.id, provider: provider.id, title: `${seed.school} · ${seed.title} · ${seed.teacher}`, kind: 'vod', pageUrl: provider.officialUrl, url, allowedHosts: HOSTS, publicOnly: true }
}

export async function resolve(id, options = {}) {
  const seed = seeds.get(id)
  if (!seed) throw new Error('课程不属于已验证的智慧高教目录')
  const current = await rows(seed.title.split(' · ')[0], options)
  return itemFor(current.find(row => row.id === seed.courseId), seed)
}

export async function discover(options = {}) {
  const items = []
  // One official search per course, with both lectures taken from its current row.
  for (const courseId of new Set(verified.map(item => item.courseId))) {
    const course = verified.filter(item => item.courseId === courseId)
    const current = await rows(course[0].title.split(' · ')[0], options)
    const row = current.find(item => item.id === courseId)
    for (const seed of course) items.push(itemFor(row, seed))
  }
  return { items, notes: ['智慧高教教创赛第五届课堂实录，首批三个学科六讲已逐条验证；115门课程目录不等于全部已验收。中小学登录课程尚未接入。'] }
}
