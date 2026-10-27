/** Offline boundary checks using trimmed official responses; no upstream requests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as campus from '../extractors/institution/providers/campus.mjs';
import * as universities from '../extractors/institution/providers/universities.mjs';
import * as regionalculture from '../extractors/institution/providers/regionalculture.mjs';
import * as performingarts from '../extractors/institution/providers/performingarts.mjs';
import * as knowledge from '../extractors/institution/providers/knowledge.mjs';
import * as ceremonies from '../extractors/institution/providers/ceremonies.mjs';
import * as conferences from '../extractors/institution/providers/conferences.mjs';
import * as auctions from '../extractors/institution/providers/auctions.mjs';
import { toItem as shanghai } from '../extractors/institution/providers/shanghai.mjs';
import { toItem as zhejiang } from '../extractors/institution/providers/zhejiang.mjs';
import { itemFromDetail as culturecloud } from '../extractors/institution/providers/culturecloud.mjs';
import { parseNdrPlayer, discover as discoverStages, resolve as resolveStage } from '../extractors/institution/providers/stages.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/institution/${name}`, import.meta.url), 'utf8');
const json = name => JSON.parse(fixture(name));
const encodePlayer = value => `<div data-config="${JSON.stringify(value).replace(/"/g, '&quot;')}"></div>`;

test('上海真实录播记录保持回放；直播必须同时满足公告时段与当前状态', () => {
  const row = json('shanghai-replay.json');
  assert.equal(shanghai(row).kind, 'vod');
  assert.equal(shanghai({ ...row, ifDisable: 1 }), null);
  assert.equal(shanghai({ ...row, liveVideoTitle: '宗教频道' }), null);
  const active = { ...row, liveType: 1, liveStatus: 1 };
  const now = (row.videoStartTimestamp + row.videoEndTimestamp) / 2;
  assert.equal(shanghai(active, now).kind, 'live');
  assert.equal(shanghai({ ...active, liveStatus: null }, now).kind, 'live');
  assert.equal(shanghai({ ...active, liveStatus: 2 }, now), null);
  assert.equal(shanghai(active, row.videoEndTimestamp), null);
  assert.equal(shanghai(active, row.videoStartTimestamp - 1), null);
});

test('浙江真实回放字段与过期直播字段分开处理，不使用旧直播填补缺失回放', () => {
  const row = json('zhejiang-replay.json'), ended = row.endTime + 1;
  const replay = zhejiang(row, ended);
  assert.equal(replay.kind, 'vod');
  assert.equal(replay.url, row.hisPath);
  const stale = { ...row, pcPath: 'https://live.zjart.com/old.m3u8', hisPath: null };
  assert.equal(zhejiang(stale, ended), null);
  assert.equal(zhejiang(row, row.startTime - 1), null);
  assert.equal(zhejiang({ ...row, title: '宗教频道' }, ended), null);
});

test('文化云匿名播放分支与试看、收费、预告及非官方来源隔离', () => {
  // Minimal branch fixture follows official live-common.js response fields.
  const row = { id: 14822154, title: '公开文化活动', state: 0, watchCfg: 'WATCH_CFG_1', backUrl: 'https://imgbos.culturedc.cn/full.mp4', backUrlFluency: 'https://imgbos.culturedc.cn/anonymous.mp4' };
  assert.equal(culturecloud(row).url, row.backUrlFluency);
  for (const patch of [{ state: 2 }, { watchCfg: 'WATCH_CFG_3' }, { watchCfg: 'WATCH_CFG_1000' }, { isBootleg: true }, { title: '宗教频道' }, { backUrlFluency: 'https://unidentified.example.com/clip.mp4' }]) {
    assert.equal(culturecloud({ ...row, ...patch }), null);
  }
});

test('科技馆真实匿名回放拒绝登录、注册、试看、过期及他机构节目', () => {
  const row = json('science-public.json');
  assert.equal(knowledge.scienceItem(row).kind, 'vod');
  for (const patch of [{ enterprise_id: 1 }, { anonymous_login: false }, { record_access: false }, { isPreview: true }, { codeStatus: true }, { apply_form: true }, { apply_review: true }, { limitType: 'password' }, { record_endDate: '2020-01-01 00:00:00' }, { title: '宗教讲座' }]) {
    assert.equal(knowledge.scienceItem({ ...row, ...patch }), null);
  }
});

test('央音真实演奏分集只接受公开 scope，校内或登录权限不能凭媒体地址绕过', () => {
  const page = 'https://video.ccom.edu.cn/web/video/content_2270.shtml';
  const html = fixture('ccom-public.html');
  assert.equal(performingarts.parseCcomDetail(html, page).kind, 'vod');
  for (const scope of ['0', '2', '3']) {
    assert.equal(performingarts.parseCcomDetail(html.replace(/var scope\s*=\s*1/, `var scope=${scope}`), page), null);
  }
  assert.equal(performingarts.parseCcomDetail(html.replace('vodvideo.ccom.edu.cn', 'unidentified.example.com'), page), null);
});

test('主办方真实完整典礼的媒体域与节目类型同时校验', () => {
  const page = 'https://www.stvf.com/content?aid=101241203145824633644838301995013779';
  const html = fixture('stvf-full.html');
  assert.equal(ceremonies.parseDetail(html, 'stvf', page).kind, 'vod');
  assert.equal(ceremonies.parseDetail(html.replace('全程回顾', '新闻速递'), 'stvf', page), null);
  assert.equal(ceremonies.parseDetail(html.replace('obs.stvf.com', 'unidentified.example.com'), 'stvf', page), null);
  assert.equal(ceremonies.parseDetail(html, 'stvf', page.replace('www.stvf.com', 'unidentified.example.com')), null);
});

test('NDR 真实 ARD 音乐会配置排除地区限制、DRM、未知时长及宗教内容', () => {
  const config = json('ndr-public.json');
  assert.equal(parseNdrPlayer(encodePlayer(config)).duration, 6093);
  const mutate = fn => { const changed = structuredClone(config); fn(changed); return parseNdrPlayer(encodePlayer(changed)); };
  for (const key of ['isGeoblocked', 'geoBlocked']) assert.equal(mutate(c => { c.mc.meta[key] = true; }), null);
  for (const key of ['drm', 'licenseUrl']) assert.equal(mutate(c => { c.mc.streams[0].media[0][key] = 'restricted'; }), null);
  for (const value of [90, undefined, 'not-a-duration']) assert.equal(mutate(c => { c.mc.meta.durationSeconds = value; }), null);
  assert.equal(mutate(c => { c.mc.meta.title = 'Church worship concert'; }), null);
  assert.equal(mutate(c => { c.mc.streams[0].media[0].url = 'https://unidentified.example.com/video.mp4'; }), null);
});

test('易北爱乐目录失败保留域名与底层网络原因，不暴露请求路径或查询凭据', async () => {
  const low = Object.assign(new Error('https://private.example/path?token=do-not-log'), { code: 'ENETUNREACH' });
  const failure = new TypeError('fetch failed', { cause: new AggregateError([low, Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })]) });
  await assert.rejects(discoverStages({ fetchImpl: async () => { throw failure; } }), error => {
    assert.match(error.message, /易北爱乐目录请求失败.*www\.elbphilharmonie\.de.*ENETUNREACH.*ETIMEDOUT/);
    assert.doesNotMatch(error.message, /private\.example|do-not-log|token=|\/path/);
    return true;
  });
});

test('易北爱乐分别指出详情、NDR播放器及媒体连接失败，HTTP拒绝保持原状态', async () => {
  const detail = '<h1>Official concert</h1><div data-url="https://www.ndr.de/concert~ardplayer.html"></div>';
  const player = encodePlayer(json('ndr-public.json'));
  for (const [failHost, label] of [
    ['www.elbphilharmonie.de', '易北爱乐演出详情'],
    ['www.ndr.de', 'NDR/ARD 播放器'],
    ['ndr-progressive.ard-mcdn.de', 'NDR/ARD 演出媒体'],
  ]) {
    await assert.rejects(resolveStage('elb-1234', { fetchImpl: async url => {
      const host = new URL(url).hostname;
      if (host === failHost) throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
      return new Response(host === 'www.elbphilharmonie.de' ? detail : player);
    } }), error => {
      assert.ok(error.message.startsWith(`${label}请求失败`));
      assert.ok(error.message.includes(failHost));
      assert.match(error.message, /ECONNRESET/);
      return true;
    });
  }
  let calls = 0;
  await assert.rejects(discoverStages({ fetchImpl: async () => { calls++; return new Response('denied', { status: 403 }); } }), /易北爱乐目录.*HTTP 403/);
  assert.equal(calls, 1, 'HTTP拒绝不会改用其他入口');
});

test('易北爱乐超时和读取响应中途断开也能显示具体失败环节', async () => {
  await assert.rejects(discoverStages({ fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); } }), /易北爱乐目录请求失败.*REQUEST_TIMEOUT/);
  await assert.rejects(discoverStages({ fetchImpl: async () => ({ ok: true, text: async () => { throw new TypeError('terminated', { cause: Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }) }); } }) }), /易北爱乐目录请求失败.*UND_ERR_SOCKET/);
});

test('拍卖机构播放器仅选已核实 CDN 的无 DRM 副本，不因高画质接受未知来源', () => {
  const clear = { src: 'https://fastly-signed-us-east-1-prod.brightcovecdn.com/public/video.mp4', container: 'MP4', height: 720 };
  const unknown = { ...clear, height: 2160, src: 'https://unidentified.example.com/video.mp4' };
  const drm = { ...clear, height: 2160, key_systems: { 'com.widevine.alpha': {} } };
  assert.equal(auctions.chooseClearSource({ sources: [unknown, drm, clear] }), clear);
  assert.equal(auctions.chooseClearSource({ sources: [unknown, drm] }), undefined);
});

test('佳士得移除后不再发现或解析旧条目，富艺斯仍独立发现和取址', async () => {
  const calls = [];
  const fetchImpl = async url => {
    const target = new URL(url); calls.push(target.href);
    if (target.hostname === 'www.phillips.com' && target.pathname === '/') return new Response('<a href="/video/between-canvas-and-form">Video</a>');
    if (target.hostname === 'www.phillips.com') return new Response('<title>Between Canvas and Form</title><iframe src="//players.brightcove.net/6415663453001/default_default/index.html?videoId=123"></iframe>');
    if (target.hostname === 'players.brightcove.net') return new Response('policyKey:"public-fixture-key"');
    if (target.hostname === 'edge.api.brightcove.com') return Response.json({ duration: 60000, sources: [{ src: 'https://example.brightcovecdn.com/official/master.m3u8', type: 'application/x-mpegURL' }] });
    throw new Error(`Unexpected upstream ${target.hostname}`);
  };
  await assert.rejects(auctions.discover({ institution: '佳士得 Christie’s', fetchImpl }), /未知拍卖机构/);
  await assert.rejects(auctions.resolve(`christies-${'a'.repeat(32)}`, { fetchImpl }), /无效的拍卖机构条目/);
  assert.equal(calls.length, 0);
  const result = await auctions.discover({ fetchImpl });
  assert.deepEqual(result.items.map(i => [i.institution, i.id]), [['富艺斯 Phillips', 'phillips-between-canvas-and-form']]);
  const replay = await auctions.resolve(result.items[0].id, { institution: '富艺斯 Phillips', fetchImpl });
  assert.equal(replay.kind, 'vod');
  assert.equal(replay.url, 'https://example.brightcovecdn.com/official/master.m3u8');
  assert.ok(calls.every(url => !url.includes('christies')));
});

for (const [adapter, institution, allowedHost] of [
  [campus, '吉林大学电视台', 'tv.jlu.edu.cn'],
  [universities, '复旦大学', 'news.fudan.edu.cn'],
  [regionalculture, '广东省文化馆', 'gdweb.gdscc.cn'],
  [performingarts, '中央音乐学院', 'video.ccom.edu.cn'],
  [knowledge, '上海图书馆', 'www.library.sh.cn'],
  [ceremonies, '上海电视节 · 白玉兰奖', 'www.stvf.com'],
  [conferences, '上海论坛组委会', 'shanghaiforum.fudan.edu.cn'],
  [auctions, '富艺斯 Phillips', 'www.phillips.com'],
]) test(`${institution} 独立发现不会联网抓取同适配器的其他机构`, async () => {
  const calls = [];
  const fetchImpl = async value => {
    calls.push(new URL(value).hostname);
    throw new Error('offline fixture: stop before upstream');
  };
  await assert.rejects(adapter.discover({ institution, fetchImpl }), /offline fixture|失败/);
  assert.ok(calls.length > 0);
  assert.deepEqual([...new Set(calls)], [allowedHost]);
});

test('官方目录真实为空仍是成功空结果，不能与网络全失败混为一谈', async () => {
  const cases = [
    [campus, '吉林大学电视台', () => new Response('<html></html>')],
    [universities, '复旦大学', () => new Response('<html></html>')],
    [regionalculture, '广东省文化馆', () => Response.json({ status: 200, data: { list: [], sum: 0 } })],
    [performingarts, '中央音乐学院', url => new Response(String(url).endsWith('/content.js') ? 'if(scope==0){} if(scope==2){}' : '<html></html>')],
    [knowledge, '上海图书馆', () => Response.json({ code: '200', data: { data: [] } })],
    [ceremonies, '上海电视节 · 白玉兰奖', () => new Response('<html></html>')],
    [conferences, '上海论坛组委会', () => new Response('<html></html>')],
    [auctions, '富艺斯 Phillips', () => new Response('<html></html>')],
  ];
  for (const [adapter, institution, fetchImpl] of cases) {
    const result = await adapter.discover({ institution, fetchImpl });
    assert.deepEqual(result.items, [], institution);
  }
});

test('目录成功但候选详情全部请求失败时抛错，供主项目保留上一轮缓存', async () => {
  const cases = [
    [campus, '吉林大学电视台', url => new URL(url).pathname.endsWith('.htm') && !String(url).includes('/info/'), '<A class="fl" href="info/1005/1234.htm"><P><SPAN class="tit">校园晚会</SPAN></P></A>'],
    [universities, '复旦大学', url => new URL(url).pathname.endsWith('/list.htm'), '<a href="/2026/0707/c77a149757/page.htm">复旦毕业影像</a>'],
    [ceremonies, '上海电视节 · 白玉兰奖', url => new URL(url).pathname === '/list', '<a href="/content?aid=101241203145824633644838301995013779">白玉兰颁奖典礼全程回顾</a>'],
  ];
  for (const [adapter, institution, isCatalog, html] of cases) {
    const fetchImpl = async url => isCatalog(url) ? new Response(html) : new Response('temporary failure', { status: 503 });
    await assert.rejects(adapter.discover({ institution, fetchImpl }), /503|失败|读取/);
  }
});

test('吉林大学 HTTPS 返回拒绝时不降级 HTTP；只有已知证书过期允许同域已验证 HTTP', async () => {
  const calls = [];
  let expired = false;
  const fetchImpl = async (value, init = {}) => {
    const url = new URL(value); calls.push({ url: url.href, method: init.method || 'GET' });
    if (url.hostname === 'tv.jlu.edu.cn' && ['/LIVEjd.htm', '/hdsk.htm'].includes(url.pathname)) return new Response('<A class="fl" href="info/1005/1234.htm"><P><SPAN class="tit">校园晚会</SPAN></P></A>');
    if (url.hostname === 'tv.jlu.edu.cn' && url.pathname === '/info/1005/1234.htm') return new Response('<title>校园晚会-吉林大学电视台</title><video><source src="https://tvcc.jlu.edu.cn/public/concert.mp4"></video>');
    if (url.hostname === 'tvcc.jlu.edu.cn' && init.method === 'HEAD') {
      if (url.protocol === 'https:') {
        if (expired) throw new Error('certificate expired', { cause: { code: 'CERT_HAS_EXPIRED' } });
        return new Response(null, { status: 403 });
      }
      return new Response(null, { headers: { 'Content-Type': 'video/mp4' } });
    }
    throw new Error(`Unexpected offline fixture URL: ${url}`);
  };
  await assert.rejects(campus.resolve('jlu-1234', { fetchImpl }), /HTTP 403/);
  assert.equal(calls.some(c => c.url.startsWith('http:')), false);
  expired = true;
  const resolved = await campus.resolve('jlu-1234', { fetchImpl });
  assert.equal(resolved.url, 'http://tvcc.jlu.edu.cn/public/concert.mp4');
  assert.ok(calls.some(c => c.url === resolved.url && c.method === 'HEAD'));
});
