import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as smartedu from '../extractors/institution/providers/smartedu.mjs'
import * as weibo from '../extractors/institution/providers/events/weibo.mjs'
import * as movie1905 from '../extractors/institution/providers/events/movie1905.mjs'
import { restrictionFor, validateFullManifest } from '../extractors/institution/providers/events/mgtv.mjs'
import * as mgtv from '../extractors/institution/providers/events/mgtv.mjs'
import { createEventAdapter } from '../extractors/institution/providers/events/index.js'
import { createMediaGateway } from '../extractors/institution/media.js'
const fixture = name => readFileSync(new URL(`./fixtures/official-events/${name}`, import.meta.url), 'utf8')
const json = name => JSON.parse(fixture(name))
const seeds = JSON.parse(readFileSync(new URL('../extractors/institution/providers/events/verified.json', import.meta.url)))
const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\npart.ts\n#EXT-X-ENDLIST\n'
const context = (path, headers = {}) => ({ path, headers, method: 'GET', accessPrefix: '/test-access' })

test('智慧高教从官方课程字段取两讲，拒绝身份、域名、接口配置变化与未验收ID', async () => {
  const body = json('smartedu.json'), calls = []
  const fetchImpl = async url => {
    calls.push(String(url))
    return new Response(String(url) === smartedu.provider.officialUrl ? 'apiUser:"https://api.chinaooc.com.cn/api/v2"' : JSON.stringify(body))
  }
  const result = await smartedu.discover({ fetchImpl })
  assert.equal(result.items.length, 6)
  assert.ok(result.items.every(item => item.kind === 'vod' && item.publicOnly))
  const seed = JSON.parse(readFileSync(new URL('../extractors/institution/providers/smartedu-verified.json', import.meta.url)))[0]
  const row = body._items.find(row => row.id === seed.courseId)
  assert.equal((await smartedu.resolve(seed.id, { fetchImpl })).url, row.videoUrl01)
  const before = calls.length
  await assert.rejects(smartedu.resolve('unverified', { fetchImpl }), /已验证/)
  assert.equal(calls.length, before)
  for (const patch of [{ university: '其他大学' }, { name: '其他教师' }, { session: '第四届' }, { videoUrl01: 'https://unidentified.example.com/video.mp4' }]) assert.throws(() => smartedu.itemFor({ ...row, ...patch }, seed))
  await assert.rejects(smartedu.discover({ fetchImpl: async () => new Response('apiUser:"https://other.example.com"') }), /配置变化/)
})

test('微博真实房间响应要求账号认证、标题、公开权限和回放状态全部一致', async () => {
  const seed = seeds.find(item => item.id === 'film-night-2026'), original = json('weibo.json')
  let body = structuredClone(original), calls = 0
  const fetchImpl = async (url, init) => {
    calls++
    assert.match(init.headers.Referer, /5308278937878564/)
    assert.equal(init.headers.Cookie, undefined)
    return Response.json(body)
  }
  assert.equal((await weibo.resolve(seed, { fetchImpl })).kind, 'replay')
  for (const patch of [{ watch_limit: 1 }, { play_switch: 0 }, { status: 5 }, { status: 1 }, { title: '另一个活动' }, { user: { ...original.data.user, verified: 0 } }, { replay_origin_url: 'https://unidentified.example.com/video.m3u8' }]) {
    body = { ...original, data: { ...original.data, ...patch } }
    await assert.rejects(weibo.resolve(seed, { fetchImpl }))
  }
  const before = calls
  await assert.rejects(weibo.resolve({ ...seed, id: 'unverified' }, { fetchImpl }))
  assert.equal(calls, before)
})

test('1905真实专题与XML只接受公开完整播放器，并在解析时拒绝加密清单', async () => {
  const seed = seeds.find(item => item.id === 'special-7847')
  let xml = fixture('1905.xml'), manifest = playlist
  const fetchImpl = async url => new Response(String(url).endsWith('.xml') ? xml : String(url).includes('/fixture/') ? manifest : fixture('1905.html'))
  const media = await movie1905.resolve(seed, { fetchImpl })
  assert.equal(media.kind, 'replay')
  assert.ok(media.allowedHosts.includes('relive.vodfile.m1905.com'))
  xml = xml.replace('isvip="0"', 'isvip="1"')
  await assert.rejects(movie1905.resolve(seed, { fetchImpl }), /会员/)
  xml = fixture('1905.xml')
  manifest = playlist.replace('#EXT-X-ENDLIST', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="license"\n#EXT-X-ENDLIST')
  await assert.rejects(movie1905.resolve(seed, { fetchImpl }), /加密/)
})

test('芒果真实免费完整权益允许默认trialtime，但排除付费、试看、DRM及截短清单', () => {
  const body = json('mgtv.json')
  assert.equal(restrictionFor(body), '')
  for (const patch of [{ paymark: 1 }, { clipLimit: 1 }, { drmFlag: 1 }, { duration: 90 }]) assert.ok(restrictionFor({ ...body, info: { ...body.info, ...patch } }))
  assert.ok(restrictionFor({ ...body, user: { purview: '0' } }))
  assert.ok(restrictionFor({ ...body, drm: { licenseUrl: 'license' } }))
  const full = '#EXTM3U\n#EXTINF:4936,\npart.ts\n#EXT-X-ENDLIST\n'
  assert.equal(validateFullManifest(full, 4936), 4936)
  for (const text of [full.replace('4936', '300'), full.replace('#EXT-X-ENDLIST', ''), full + '#EXT-X-KEY:METHOD=AES-128,URI="key"']) assert.throws(() => validateFullManifest(text, 4936))
})

test('活动接入层只发布通过验收且仍与官方目录一致的场次，播放地址不进入目录缓存', async () => {
  const [seed, other] = seeds.filter(item => item.provider === 'mgtv')
  let current = { ...seed }, resolved = 0
  const adapter = createEventAdapter({ id: seed.provider,
    discover: async () => ({ items: [current, other, { ...seed, id: 'new-unverified' }] }),
    resolve: async () => { resolved++; return { url: 'https://official.example.com/index.m3u8?token=temporary', allowedHosts: ['official.example.com'], kind: seed.kind } },
  }, [seed, other])
  assert.equal((await adapter.discover()).items.length, 2)
  assert.equal(resolved, 2)
  current = { ...seed, title: '另一场活动' }
  assert.deepEqual((await adapter.discover()).items.map(item => item.id), [other.id])
  await assert.rejects(adapter.resolve('unverified'))
})

test('微博、1905、芒果官网全部失败时抛错并带上原因，供主项目保留上一轮缓存', async () => {
  const fetchImpl = async () => new Response('temporary failure', { status: 503 })
  for (const source of [weibo, movie1905, mgtv]) {
    await assert.rejects(createEventAdapter(source).discover({ fetchImpl }), /全部未通过检查：.*503/, source.id)
  }
  const silent = createEventAdapter({ id: 'mgtv', discover: async () => ({ items: [] }) }, seeds.filter(item => item.provider === 'mgtv'))
  await assert.rejects(silent.discover(), /没有返回这些场次/)
})

test('芒果已验收场次按ID直接查官方播放信息，取流也不读活动目录，不会被新活动挤掉', async () => {
  const body = json('mgtv.json'), hosts = []
  const mgtvSeeds = seeds.filter(item => item.provider === 'mgtv')
  const lookupFetch = async url => {
    const target = new URL(url)
    hosts.push(target.hostname)
    const seed = mgtvSeeds.find(item => item.id === `mgtv-${target.searchParams.get('video_id')}`)
    return Response.json({ code: 200, data: { ...body, info: { ...body.info, partName: `${seed.title} ` } } })
  }
  const adapter = createEventAdapter({ id: 'mgtv', lookup: mgtv.lookup,
    resolve: async () => ({ url: 'https://pcvideo.titan.mgtv.com/index.m3u8', allowedHosts: ['*.mgtv.com'], kind: 'replay' }),
  }, mgtvSeeds)
  assert.deepEqual((await adapter.discover({ fetchImpl: lookupFetch })).items.map(item => item.id), mgtvSeeds.map(item => item.id))
  assert.deepEqual([...new Set(hosts)], ['pcweb.api.mgtv.com'])
  hosts.length = 0
  const media = await mgtv.resolve(mgtvSeeds.find(item => item.id === 'mgtv-23744531'), { fetchImpl: async url => {
    const target = new URL(url)
    hosts.push(target.hostname)
    if (target.pathname === '/player/video') return Response.json({ code: 200, data: { ...body, atc: { pm2: 'fixture' } } })
    if (target.pathname === '/player/getSource') return Response.json({ code: 200, data: { stream: [{ url: '/dispatch/fixture', vip: '0', videoFormat: 'H264', def: 3 }], stream_domain: ['https://web-disp.titan.mgtv.com'] } })
    if (target.pathname === '/dispatch/fixture') return Response.json({ status: 'ok', info: 'https://pcvideo.titan.mgtv.com/fixture/index.m3u8' })
    return new Response('#EXTM3U\n#EXTINF:4936,\npart.ts\n#EXT-X-ENDLIST\n')
  } })
  assert.equal(media.kind, 'replay')
  assert.ok(!hosts.includes('pwlc.bz.mgtv.com'))
})

test('直播主清单下的子清单访问即续期，轮询超过1小时不返回410；没人访问的引用照常过期', async contextTest => {
  let now = Date.now()
  contextTest.mock.method(Date, 'now', () => now)
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500\nlow.m3u8\n'
  const child = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:4,\npart.ts\n'
  const item = { id: 'live', kind: 'live', url: 'https://official.example.com/master.m3u8', allowedHosts: ['official.example.com'] }
  const gateway = createMediaGateway({ moduleId: 'inst-test', assertEnabled() {}, resolveItem: async () => item,
    fetchImpl: async url => new Response(String(url).endsWith('/master.m3u8') ? master : child) })
  const [high, low] = (await gateway.handle(context('/root'), item)).body.split('\n')
    .filter(line => line.startsWith('/test-access/')).map(line => line.replace('/test-access', ''))
  for (let minute = 30; minute <= 180; minute += 30) {
    now += 30 * 60000
    assert.equal((await gateway.handle(context(high))).status, 200, `第 ${minute} 分钟`)
  }
  assert.equal((await gateway.handle(context(low))).status, 410)
})

test('微博错误HLS MIME的TS分片保持二进制与Range，不重取或误写为清单', async () => {
  const calls = [], bytes = new Uint8Array([0x47, 0, 0xff, 1])
  const gateway = createMediaGateway({ moduleId: 'inst-test', assertEnabled() {}, fetchImpl: async (url, init) => {
    calls.push({ url, init })
    return new Response(bytes, { status: 206, headers: { 'Content-Type': 'application/x-mpegURL', 'Content-Range': 'bytes 0-3/188' } })
  } })
  const result = await gateway.handle(context('/root', { range: 'bytes=0-3' }), { id: 'weibo', kind: 'vod', url: 'https://live.video.weibocdn.com/part.ts', allowedHosts: ['live.video.weibocdn.com'] })
  assert.deepEqual(new Uint8Array(await new Response(result.body).arrayBuffer()), bytes)
  assert.equal(result.headers['content-type'], 'video/mp2t')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers.Range, 'bytes=0-3')
  result.dispose()
})

test('长活动登记6000分片后首片仍可读，10小时后有效；所有跳转在请求前校验来源', async contextTest => {
  const now = Date.now(), clock = contextTest.mock.method(Date, 'now', () => now)
  let calls = 0
  const text = '#EXTM3U\n' + Array.from({ length: 6000 }, (_, i) => `#EXTINF:6,\n${i}.ts`).join('\n') + '\n#EXT-X-ENDLIST\n'
  const item = { id: 'long', kind: 'vod', url: 'https://official.example.com/index.m3u8', allowedHosts: ['official.example.com'], publicOnly: true }
  const gateway = createMediaGateway({ moduleId: 'inst-test', assertEnabled() {}, fetchImpl: async url => { calls++; return new Response(String(url).endsWith('.m3u8') ? text : 'binary') } })
  const manifest = await gateway.handle(context('/root'), item)
  const first = manifest.body.split('\n').find(line => line.startsWith('/test-access/')).replace('/test-access', '')
  clock.mock.mockImplementation(() => now + 10 * 3600000)
  const segment = await gateway.handle(context(first))
  assert.equal(segment.status, 200)
  await segment.body.cancel(); segment.dispose()
  assert.equal(calls, 2)
  let requests = 0
  const redirected = createMediaGateway({ moduleId: 'inst-test', assertEnabled() {}, fetchImpl: async () => { requests++; return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }) } })
  await assert.rejects(redirected.handle(context('/root'), item))
  assert.equal(requests, 1)
})

test('公开活动子清单拒绝未许可CDN和加密标记', async () => {
  const item = { id: 'event', kind: 'vod', url: 'https://official.example.com/index.m3u8', allowedHosts: ['official.example.com'], publicOnly: true }
  for (const text of [playlist.replace('part.ts', 'https://unknown.example.com/part.ts'), playlist + '#EXT-X-KEY:METHOD=AES-128,URI="key"']) {
    const gateway = createMediaGateway({ moduleId: 'inst-test', assertEnabled() {}, fetchImpl: async () => new Response(text) })
    await assert.rejects(gateway.handle(context('/root'), item))
  }
})
