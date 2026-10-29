#!/usr/bin/env node
/** 2026-10-29 真实目录/响应裁剪夹具；签名目录使用合成值，不保存 clientID 或播放凭据。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import module from '../extractors/bestv-fj/index.js'
import { CHANNELS, DEFAULT_CHANNEL_IDS, refOf } from '../extractors/bestv-fj/channels.js'
import { buildChannels, createResolver, mediaUrl, selectedIds, validateManifest } from '../extractors/bestv-fj/api.js'
import { API_BASE, createApiClient } from '../extractors/bestv-fj/auth.js'
import { getModule, resolverFor } from '../extractors/registry.js'
import { resolveConfig, validateConfig } from '../utils/extractorManager.js'

const catalog = JSON.parse(readFileSync(new URL('./fixtures/bestv-fj/catalog.json', import.meta.url)))
const stream = token => `http://fjnetv51.live.bestvcdn.com.cn/${token.repeat(64)}/live/program/live/hxjchd/4000000/mnf.m3u8?userid=test`
const manifest = sequence => `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:10,\n2026102922/${sequence}.ts\n`
const response = json => new Response(JSON.stringify(json))
const play = url => ({ tvid: 219, state: 'live', paid: false, contentIsFree: false, validSeconds: 300, tv_name: '多彩文体4K', playUrl: url })
let passed = 0
async function check(name, fn) { await fn(); passed++; console.log(`  ✅ ${name}`) }

await check('模块默认关，64 路可选、默认七路、旧 ID 205 不认领', () => {
  assert.equal(getModule('bestv-fj'), module)
  assert.equal(module.name, '百视通')
  assert.equal(module.region, '百视通')
  assert.equal(module.defaultEnabled, false)
  assert.equal(module.channelHlsMode, 'relay')
  assert.equal(module.relayProxyCompatible, true)
  assert.equal(module.capabilities.catchup, false)
  assert.equal(CHANNELS.length, 64)
  assert.equal(new Set(CHANNELS.map(c => c.id)).size, 64)
  assert.deepEqual(selectedIds(resolveConfig(module)), DEFAULT_CHANNEL_IDS)
  assert.equal(resolverFor(refOf('219')), module)
  for (const ref of ['bestv-fj-205', 'bestv-fj-999', 'bestv-fj-219/extra']) assert.equal(module.claimsRef(ref), false)
  assert.equal(validateConfig(module, { channels: [] }).ok, false)
  assert.equal(validateConfig(module, { channels: ['205'] }).ok, false)
  assert.equal(validateConfig(module, { channels: CHANNELS.map(c => c.id) }).ok, true)
});
await check('官方目录七路与完整 64 路可构建，台标来自平台、频道对象不含签名地址', async () => {
  const defaults = buildChannels(catalog, DEFAULT_CHANNEL_IDS)
  assert.equal(defaults.length, 7)
  assert.equal(buildChannels(catalog, CHANNELS.map(c => c.id)).length, 64)
  assert.ok(defaults.every(c => c.logo.startsWith('https://tvappstatic.bestv.com.cn/images/') && c.relayHls && !c.url && c.catchup === 'none'))
  let calls = 0
  const result = await module.fetch({}, { fetchImpl: async url => { calls++; return response(url.includes('client-id-by-region') ? { clientID: 'test' } : catalog) } })
  assert.equal(calls, 2)
  assert.deepEqual(result.groups[0].dataList, defaults)
});
await check('目录结构变化、频道消失、第三方台标不当作抓取成功', () => {
  assert.throws(() => buildChannels({}, DEFAULT_CHANNEL_IDS))
  assert.throws(() => buildChannels([], DEFAULT_CHANNEL_IDS))
  const bad = structuredClone(catalog)
  bad.flatMap(g => g.items).find(c => c.id === 219).icon = 'http://127.0.0.1/logo.png'
  assert.throws(() => buildChannels(bad, DEFAULT_CHANNEL_IDS))
  const stopped = structuredClone(catalog)
  stopped.flatMap(g => g.items).find(c => c.id === 219).enabled = 0
  assert.equal(buildChannels(stopped, DEFAULT_CHANNEL_IDS).length, 6)
});
await check('媒体与分片锁定同一 CDN、频道、签名目录，拒绝变成加密/点播/子清单', () => {
  const url = stream('A')
  assert.equal(validateManifest(manifest(10), url), manifest(10))
  for (const raw of ['http://127.0.0.1/a.ts', stream('B'), url.replace('hxjchd', 'cctv1hd'), url.replace('fjnetv51', 'evil'), url.replace('http:', 'file:')]) assert.throws(() => mediaUrl(raw, url))
  for (const text of [manifest(1) + '#EXT-X-ENDLIST', manifest(1) + '#EXT-X-KEY:METHOD=AES-128,URI="key"', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8', manifest(1).replace('2026102922/1.ts', 'http://evil.test/a.ts')]) assert.throws(() => validateManifest(text, url))
});
await check('并发只取一次票、每次读实时清单；两分钟换播放票、七分钟换 clientID', async () => {
  let time = 0, clients = 0, plays = 0, manifests = 0
  const resolver = createResolver({ now: () => time, fetchImpl: async (url, opts) => {
    assert.equal(opts.redirect, 'manual')
    if (url.includes('client-id-by-region')) { clients++; return response({ clientID: `test-${clients}` }) }
    if (url.startsWith(API_BASE)) {
      assert.match(opts.headers.timestamp, /^\d+$/)
      assert.match(opts.headers.sign, /^[a-f0-9]{32}$/)
      plays++; return response(play(stream(String.fromCharCode(64 + plays))))
    }
    manifests++; return new Response(manifest(100 + manifests))
  } })
  const first = await Promise.all([resolver.resolve(refOf('219')), resolver.resolve(refOf('219'))])
  assert.ok(first.every(r => r.url && r.relayHls && r.manifestText))
  assert.equal(clients, 1); assert.equal(plays, 1); assert.equal(manifests, 2)
  time = 121000
  assert.notEqual((await resolver.resolve(refOf('219'))).url, first[0].url)
  assert.equal(clients, 1); assert.equal(plays, 2)
  time = 421000
  assert.ok((await resolver.resolve(refOf('219'))).url)
  assert.equal(clients, 2); assert.equal(plays, 3)
});
await check('CDN 提前拒绝旧签名就重新取票；失败不返回旧流', async () => {
  let plays = 0, rejectOld = false, offline = false
  const resolver = createResolver({ fetchImpl: async url => {
    if (url.includes('client-id-by-region')) return response({ clientID: 'test' })
    if (url.startsWith(API_BASE)) { if (offline) throw new Error('secret-url'); plays++; return response(play(stream(plays === 1 ? 'A' : 'B'))) }
    if (rejectOld && url === stream('A')) return new Response('', { status: 403 })
    return new Response(manifest(100))
  } })
  assert.equal((await resolver.resolve(refOf('219'))).url, stream('A'))
  rejectOld = true
  assert.equal((await resolver.resolve(refOf('219'))).url, stream('B'))
  assert.equal(plays, 2)
  resolver.clear(); offline = true
  const result = await resolver.resolve(refOf('219'))
  assert.equal(result.url, '')
  assert.ok(!result.desc.includes('secret-url'))
});
await check('付费、错误频道、缺有效期、非直播均不放行，未知 ref 不访问上游', async () => {
  for (const override of [{ paid: true }, { paid: undefined }, { state: 'vod' }, { tvid: 220 }, { validSeconds: 0 }]) {
    let media = 0
    const resolver = createResolver({ fetchImpl: async url => {
      if (url.includes('client-id-by-region')) return response({ clientID: 'test' })
      if (url.startsWith(API_BASE)) return response({ ...play(stream('A')), ...override })
      media++; return new Response(manifest(1))
    } })
    assert.equal((await resolver.resolve(refOf('219'))).url, '')
    assert.equal(media, 0)
  }
  const resolver = createResolver({ fetchImpl: () => { throw new Error('should not run') } })
  assert.equal((await resolver.resolve('bestv-fj-205')).url, '')
});
await check('API 拒绝 clientID 时仅更新一次；超大响应与跳转失败', async () => {
  let clients = 0, attempts = 0
  const api = createApiClient({ fetchImpl: async url => {
    if (url.includes('client-id-by-region')) { clients++; return response({ clientID: `client-${clients}` }) }
    attempts++; return attempts === 1 ? new Response('', { status: 401 }) : response(catalog)
  } })
  assert.deepEqual(await api.request('/tvs'), catalog)
  assert.equal(clients, 2); assert.equal(attempts, 2)
  for (const res of [new Response('', { status: 302, headers: { Location: 'http://127.0.0.1/' } }), new Response('x', { headers: { 'Content-Length': '2000000' } })]) {
    const bad = createApiClient({ fetchImpl: async () => res })
    await assert.rejects(bad.request('/tvs'))
  }
});
console.log(`\n百视通福建：${passed} 项通过`)
