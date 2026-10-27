import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReadableStream } from 'node:stream/web'

// Imports must not read the operator's live deployment configuration.
const dataDir = mkdtempSync(join(tmpdir(), 'iptv-institution-test-'))
process.env.mdataDir = dataDir
const { createInstitutionModule, refFor } = await import('../extractors/institution/module.js')
const { createMediaGateway } = await import('../extractors/institution/media.js')
const { sendLocalMediaResponse } = await import('../utils/localMediaResponse.js')
after(() => rmSync(dataDir, { recursive: true, force: true }))

const sample = (id = 'full-lecture', extra = {}) => ({
  id, provider: 'fixture', institution: '测试大学', kind: 'vod', title: '公开讲堂',
  pageUrl: 'https://university.example.com/lecture', url: `https://media.example.com/${id}.mp4`, ...extra,
})
const context = (path, extra = {}) => ({ path, method: 'GET', headers: {}, accessPrefix: '/local-password', ...extra })
function harness(items = [sample()], runtime = {}) {
  const calls = { discover: 0, resolve: [], fetch: [], live: 0 }
  let on = true, groups = []
  const adapter = {
    async discover(options) { calls.discover++; assert.equal(options.institution, '测试大学'); return { items, notes: ['官网公开节目'] } },
    async resolve(id, options) {
      calls.resolve.push(id); assert.equal(options.institution, '测试大学')
      return items.find(item => item.id === id)
    },
  }
  const spec = { id: 'inst-fixture', name: '测试大学', selector: '测试大学', providerId: 'fixture', officialUrl: 'https://university.example.com/', description: '官方公开影像。', adapter }
  const mod = createInstitutionModule(spec, {
    isEnabled: () => on,
    cachedGroups: () => groups,
    fetchImpl: async (url, init) => { calls.fetch.push({ url: String(url), init }); return new Response('media', { headers: { 'Content-Type': 'video/mp4' } }) },
    validateLive: async () => { calls.live++ },
    ...runtime,
  })
  return { mod, spec, calls, disable: () => { on = false }, setGroups: value => { groups = value } }
}

test('按机构生成模块及直播/回放标签，仅保存稳定单段引用和公开节目身份', async () => {
  const h = harness([sample(), sample('concert', { kind: 'live', title: '校园音乐会', url: 'https://media.example.com/live.m3u8?signature=ephemeral' }), sample('excluded', { title: '宗教讲座' }), sample('peer', { institution: '其他大学' })])
  const result = await h.mod.fetch()
  assert.equal(h.mod.category, 'institution')
  assert.equal(result.groups[0].name, '测试大学')
  assert.deepEqual(result.groups[0].dataList.map(c => c.name), ['[回放] 公开讲堂', '[直播] 校园音乐会'])
  assert.equal(result.meta.skipped.length, 2)
  assert.equal(h.calls.live, 1)
  for (const channel of result.groups[0].dataList) {
    assert.match(channel.deferredRef, /^inst-fixture-[a-f0-9]{24}\.(?:mp4|m3u8)$/)
    assert.equal(h.mod.claimsRef(channel.deferredRef), true)
    assert.equal(channel.logo, '')
    assert.equal(channel.catchup, 'none')
    assert.equal(channel.url, undefined)
  }
  assert.ok(!JSON.stringify(result).includes('signature=ephemeral'))
  assert.equal(refFor(h.mod.id, sample()), refFor(h.mod.id, sample('full-lecture', { url: 'https://another.example.com/signed.mp4?token=changed' })))
})

test('重启后从主项目目录缓存恢复身份，缓存篡改与裸ID均不发解析请求', async () => {
  const first = harness(), groups = (await first.mod.fetch()).groups
  const ref = groups[0].dataList[0].deferredRef
  const restarted = harness(); restarted.setGroups(groups)
  assert.equal((await restarted.mod.resolve(ref)).url, sample().url)
  assert.deepEqual(restarted.calls.resolve, ['full-lecture'])
  const tampered = structuredClone(groups)
  tampered[0].dataList[0].institutionItemId = 'different-item'
  const invalid = harness(); invalid.setGroups(tampered)
  for (const path of [ref, 'full-lecture', 'inst-other-123', `${ref}/extra`, `${ref}?url=https://unidentified.example.com`]) {
    assert.equal((await invalid.mod.resolve(path)).url, '')
  }
  assert.equal(invalid.calls.resolve.length, 0)
  assert.equal(invalid.calls.fetch.length, 0)
})

test('解析时再次核对机构和直播状态，不把其他机构或已结束回放继续作为原直播', async () => {
  const item = sample('live-1', { kind: 'live', url: 'https://media.example.com/live.m3u8' })
  const h = harness([item]), ref = (await h.mod.fetch()).groups[0].dataList[0].deferredRef
  item.institution = '其他大学'
  assert.equal((await h.mod.resolve(ref)).url, '')
  item.institution = '测试大学'; item.kind = 'vod'
  assert.equal((await h.mod.resolve(ref)).url, '')
  assert.equal(h.calls.fetch.length, 0)
})

test('复合提供者在网络请求前拒绝跨机构ID，关闭同提供者内其他机构不会被旁路解析', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; throw new Error('unexpected upstream request') }
  for (const [provider, id, institution] of [
    ['campus', 'xjtu-vod-1011', '吉林大学电视台'],
    ['universities', `bnu-wwsd-${'a'.repeat(32)}`, '复旦大学'],
    ['regionalculture', `gd-${'a'.repeat(32)}`, '湖南省文化馆'],
    ['performingarts', 'gzy-11427', '中央音乐学院'],
    ['knowledge', `shlib-${'A'.repeat(32)}`, '中国数字科技馆'],
    ['ceremonies', 'stvf-101241203145824633644838301995013779', '上海国际电影节 · 金爵奖'],
    ['conferences', 'zgc-2026032410020870', '上海论坛组委会'],
    ['auctions', `christies-${'a'.repeat(32)}`, '富艺斯 Phillips'],
  ]) {
    const adapter = await import(`../extractors/institution/providers/${provider}.mjs`)
    await assert.rejects(adapter.resolve(id, { institution, fetchImpl }), /不属于/)
  }
  assert.equal(calls, 0)
})

test('关闭模块后目录、旧根播放引用和已登记HLS资源均零联网', async () => {
  const upstreamCalls = []
  const item = sample('hls-1', { url: 'https://media.example.com/full.m3u8' })
  const h = harness([item], { fetchImpl: async (url, init) => {
    upstreamCalls.push({ url: String(url), init })
    return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })
  } })
  const ref = (await h.mod.fetch()).groups[0].dataList[0].deferredRef
  const initial = await h.mod.handleLocalRequest(context(`/${ref}`))
  const resourcePath = initial.body.split('\n').find(line => line.startsWith('/local-password/')).slice('/local-password'.length)
  const before = { requests: upstreamCalls.length, resolves: h.calls.resolve.length, discover: h.calls.discover }
  h.disable()
  assert.equal((await h.mod.handleLocalRequest(context(`/${ref}`))).status, 403)
  assert.equal((await h.mod.handleLocalRequest(context(resourcePath))).status, 403)
  assert.equal((await h.mod.resolve(ref)).url, '')
  await assert.rejects(h.mod.fetch(), /已关闭/)
  assert.deepEqual({ requests: upstreamCalls.length, resolves: h.calls.resolve.length, discover: h.calls.discover }, before)
})

test('HLS主清单、独立音轨、密钥、初始化段与相对分片均保留鉴权前缀', async () => {
  const paths = [], initial = sample('multi', { url: 'https://media.example.com/path/master.m3u8', headers: { Referer: 'https://university.example.com/' } })
  const manifest = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",URI="audio/main.m3u8"\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="aac"\n../video/index.m3u8\n#EXTINF:4,\n../video/1.m4s\n'
  const gateway = createMediaGateway({ moduleId: 'inst-fixture', assertEnabled() {}, resolveItem: async () => initial, fetchImpl: async (url, init) => {
    paths.push({ url: String(url), init })
    const hls = String(url).endsWith('.m3u8')
    return new Response(paths.length === 1 ? manifest : hls ? '#EXTM3U\n#EXT-X-ENDLIST\n' : 'binary', { headers: { 'Content-Type': hls ? 'application/vnd.apple.mpegurl' : 'application/octet-stream' } })
  } })
  const result = await gateway.handle(context('/root'), initial)
  const references = [...result.body.matchAll(/(?:URI="|^)(\/local-password\/institution\/inst-fixture\/[a-f0-9]{36}\.[a-z0-9]+)/gm)].map(m => m[1])
  assert.equal(references.length, 5)
  assert.match(result.body, /AUDIO="aac"/)
  assert.ok(!result.body.includes('https://media.example.com'))
  const targets = ['https://media.example.com/path/audio/main.m3u8', 'https://media.example.com/path/key.bin', 'https://media.example.com/path/init.mp4', 'https://media.example.com/video/index.m3u8', 'https://media.example.com/video/1.m4s']
  for (const [index, ref] of references.entries()) {
    const response = await gateway.handle(context(ref.slice('/local-password'.length)))
    assert.equal(paths.at(-1).url, targets[index])
    assert.equal(paths.at(-1).init.headers.Referer, initial.headers.Referer)
    await response.body?.cancel?.(); response.dispose?.()
  }
  assert.equal((await gateway.handle(context('/institution/inst-fixture/not-registered.ts'))).status, 410)
})

test('清单不向上游转发 Range，改写后按播放器 Range 切片，探测能读到尾部 ENDLIST', async () => {
  // Ceau 先取 bytes=0-65535，206 带总长时再取 bytes=-65536 找 ENDLIST；上游若截断就永远判成直播。
  const segments = Array.from({ length: 3000 }, (_, i) => `#EXTINF:2,\nhttps://cdn.example.com/vod/${'x'.repeat(40)}-${i}.ts?sign=${'s'.repeat(40)}`).join('\n')
  const full = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n${segments}\n#EXT-X-ENDLIST\n`
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), range: init.headers.Range })
    const body = init.headers.Range ? full.slice(0, 65536) : full
    return new Response(body, { status: init.headers.Range ? 206 : 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })
  }
  const item = sample('long-vod', { url: 'https://media.example.com/vod/index.m3u8' })
  const gateway = createMediaGateway({ moduleId: 'inst-fixture', assertEnabled() {}, resolveItem: async () => item, fetchImpl })
  const whole = await gateway.handle(context('/root'), item)
  assert.equal(whole.status, 200)
  assert.match(whole.body, /#EXT-X-ENDLIST\n$/)
  const total = Buffer.byteLength(whole.body)
  assert.ok(total > 65536, '夹具要比探测的首段长，才能复现截断')
  const head = await gateway.handle(context('/root', { headers: { range: 'bytes=0-65535' } }), item)
  assert.equal(head.status, 206)
  assert.equal(head.headers['Content-Range'], `bytes 0-65535/${total}`)
  assert.equal(head.body.length, 65536)
  const tail = await gateway.handle(context('/root', { headers: { range: 'bytes=-65536' } }), item)
  assert.equal(tail.status, 206)
  assert.match(tail.body.toString('utf8'), /#EXT-X-ENDLIST\n$/)
  const beyond = await gateway.handle(context('/root', { headers: { range: `bytes=${total}-` } }), item)
  assert.equal(beyond.status, 416)
  assert.equal(beyond.headers['Content-Range'], `bytes */${total}`)
  assert.ok(requests.every(r => r.range === undefined), '清单请求不能带 Range 去上游')
  // 地址不像清单、上游却回了清单：先带 Range 取到后，丢掉重取整份
  requests.length = 0
  const disguised = sample('disguised', { url: 'https://media.example.com/vod/play?id=7' })
  const redo = await gateway.handle(context('/root', { headers: { range: 'bytes=0-65535' } }), disguised)
  assert.deepEqual(requests.map(r => r.range), ['bytes=0-65535', undefined])
  assert.match(Buffer.from(redo.body).toString('utf8'), /^#EXTM3U/)
  assert.equal(redo.headers['Content-Range'], `bytes 0-65535/${total}`)
})

test('MP4 Range 与 206/416 元数据直通，并保留流式响应及上游终止函数', async () => {
  let signal, requestHeaders
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('range')); controller.close() } })
  const gateway = createMediaGateway({ moduleId: 'inst-fixture', assertEnabled() {}, resolveItem: async () => sample(), fetchImpl: async (url, init) => {
    signal = init.signal; requestHeaders = init.headers
    return new Response(stream, { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Length': '5', 'Content-Range': 'bytes 10-14/1000000000', 'Accept-Ranges': 'bytes' } })
  } })
  const response = await gateway.handle(context('/root', { headers: { range: 'bytes=10-14' } }), sample())
  assert.equal(response.status, 206)
  assert.equal(response.headers['content-range'], 'bytes 10-14/1000000000')
  assert.equal(requestHeaders.Range, 'bytes=10-14')
  assert.equal(response.body, stream, '不应预先把长MP4读入内存')
  assert.equal(signal.aborted, false)
  response.dispose()
  assert.equal(signal.aborted, true)
  const badRange = createMediaGateway({ moduleId: 'inst-fixture', assertEnabled() {}, fetchImpl: async () => new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */100' } }) })
  const rejected = await badRange.handle(context('/root'), sample())
  assert.equal(rejected.status, 416)
  assert.equal(rejected.headers['content-range'], 'bytes */100')
  rejected.dispose()
})

async function withServer(handler, run) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { return await run(`http://127.0.0.1:${server.address().port}`) }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}

test('本地媒体写出支持大型流，HEAD取消正文并完成清理', async () => {
  let canceled = 0, disposed = 0
  await withServer((req, res) => {
    const body = new ReadableStream({
      start(controller) { if (req.method !== 'HEAD') { for (let n = 0; n < 8; n++) controller.enqueue(new Uint8Array(1024 * 1024).fill(n)); controller.close() } },
      cancel() { canceled++ },
    })
    void sendLocalMediaResponse(res, req.method, { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(8 * 1024 * 1024) }, body, dispose() { disposed++ } })
  }, async base => {
    const response = await fetch(base)
    assert.equal(response.status, 206)
    const data = new Uint8Array(await response.arrayBuffer())
    assert.equal(data.length, 8 * 1024 * 1024)
    assert.equal(data.at(-1), 7)
    const head = await fetch(base, { method: 'HEAD' })
    assert.equal((await head.arrayBuffer()).byteLength, 0)
  })
  assert.equal(canceled, 1)
  assert.ok(disposed >= 2)
})

test('播放器中途断开会取消上游流并调用清理函数', async () => {
  let cancelResolve, disposeResolve
  const canceled = new Promise(resolve => { cancelResolve = resolve })
  const disposed = new Promise(resolve => { disposeResolve = resolve })
  await withServer((req, res) => {
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)) },
      cancel() { cancelResolve() },
    })
    void sendLocalMediaResponse(res, req.method, { body, dispose() { disposeResolve() } })
  }, async base => {
    await new Promise((resolve, reject) => {
      const req = http.get(base, res => res.once('data', () => { res.destroy(); resolve() }))
      req.once('error', reject)
    })
    let timeout
    try {
      await Promise.race([Promise.all([canceled, disposed]), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('断开后未取消上游媒体')), 2000) })])
    } finally { clearTimeout(timeout) }
  })
})
