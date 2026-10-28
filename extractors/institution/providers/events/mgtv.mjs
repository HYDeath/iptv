import { fetchWithTimeout } from '../../net.js';
import { randomUUID } from 'node:crypto';

export const id = 'mgtv';
export const name = '芒果活动';
export const officialPage = 'https://www.mgtv.com/live/';
const CATALOG = 'https://pwlc.bz.mgtv.com/list/getCommonList';
const VIDEO = 'https://pcweb.api.mgtv.com/player/video';
const SOURCE = 'https://tinker.glb.mgtv.com/player/getSource';
const ALLOWED_HOSTS = ['mgtv.com', '*.mgtv.com', 'hitv.com', '*.hitv.com', 'imgo.tv', '*.imgo.tv'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
let catalogCache;

function allowedUrl(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || !['mgtv.com', 'hitv.com', 'imgo.tv'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error('芒果返回了非官方 HTTPS 媒体地址');
  }
  return url.href;
}

async function request(url, { headers = {}, json = true, fetchImpl = fetchWithTimeout } = {}) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(allowedUrl(url), {
        headers: { 'User-Agent': UA, Referer: officialPage, ...headers },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`官方请求 HTTP ${response.status}`);
      return json ? await response.json() : await response.text();
    } catch (error) { last = error; }
  }
  throw new Error(last?.message || '芒果官方请求失败');
}

function query(base, params) {
  const url = new URL(base);
  url.search = new URLSearchParams(params);
  return url.href;
}

function toTime(value) {
  return value ? `${String(value).replace(' ', 'T')}+08:00` : undefined;
}

function itemFor(row, kind = 'replay') {
  const videoId = String(row.jumpId || '');
  const activityId = String(row.activityId || '');
  return {
    id: kind === 'live' ? `mgtv-live-${activityId}` : `mgtv-${videoId}`,
    provider: id,
    title: String(row.name || ''),
    page: kind === 'live' ? `https://www.mgtv.com/z/${activityId}.html` : `https://www.mgtv.com/s/${videoId}.html`,
    kind,
    description: String(row.subName || ''),
    startAt: toTime(row.liveStartTime),
    endAt: toTime(row.liveEndTime),
    activityId,
    videoId,
  };
}

async function listRows(options = {}) {
  if (!options.fresh && catalogCache && catalogCache.until > Date.now()) return catalogCache.value;
  const pages = await Promise.all([1, 2, 3].map(pageNum => request(query(CATALOG, {
    version: '6.0.0.0', platform: '4', listType: '2', pageNum: String(pageNum), pageSize: '24', _support: '10000000',
  }), options)));
  const current = await request(query(CATALOG, { version: '6.0.0', platform: '4', listType: '4', _support: '10000000' }), options);
  for (const data of [...pages, current]) if (Number(data.code) !== 200 || !Array.isArray(data.data?.[0]?.moduleData)) throw new Error('芒果官方活动目录结构变化');
  const replay = [...new Map(pages.flatMap(p => p.data[0].moduleData).filter(r => /^\d+$/.test(String(r.jumpId || ''))).map(r => [r.jumpId, r])).values()];
  const value = { replay, current: current.data[0].moduleData };
  catalogCache = { value, until: Date.now() + 5 * 60 * 1000 };
  return value;
}

async function videoInfo(videoId, options = {}) {
  const tk2 = Buffer.from(`did=${randomUUID()}|pno=1030|ver=0.3.0301|clit=${Math.floor(Date.now() / 1000)}`).toString('base64url').split('').reverse().join('');
  const data = await request(query(VIDEO, { tk2, video_id: videoId, type: 'pch5' }), options);
  if (Number(data.code) !== 200 || !data.data?.info) {
    if (Number(data.code) === 40005) throw new Error('官方拒绝当前地区播放（40005）');
    throw new Error(`官方播放信息拒绝：${data.code || '未知状态'}`);
  }
  return { data: data.data, tk2 };
}

export function restrictionFor(data) {
  const info = data?.info || {};
  const drm = data?.drm || {};
  if (Number(info.drmFlag || 0) !== 0 || drm.licenseUrl || drm.drmType) return '官方节目采用 DRM，需要官方播放器';
  if (String(info.paymark || '0') !== '0' || String(data?.user?.purview || '') !== '200') return '官方匿名权限为会员／付费或其他受限权益';
  if (Number(info.clipLimit) !== 0) return `官方匿名仅开放试看（${Number(info.trialtime) || '未知'} 秒）`;
  if (!(Number(info.duration) >= 600)) return '未确认至少十分钟的完整活动，不作为完整活动回放';
  return '';
}

export function validateFullManifest(text, duration) {
  if (!text.startsWith('#EXTM3U') || !text.includes('#EXT-X-ENDLIST')) throw new Error('未取得完整回放媒体清单');
  if (/^#EXT-X-(?:SESSION-)?KEY:(?!.*METHOD=NONE)/m.test(text)) throw new Error('官方媒体清单要求加密许可，不输出普通 M3U');
  const actualDuration = [...text.matchAll(/^#EXTINF:([\d.]+)/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
  if (actualDuration < Number(duration) * 0.98) throw new Error(`官方返回截短／试看清单（约 ${Math.round(actualDuration)} 秒，节目 ${Math.round(duration)} 秒）`);
  return actualDuration;
}

export async function discover({ limit = 8, ...options } = {}) {
  const rows = await listRows(options);
  const items = [], blocked = [];
  let checked = 0, examined = 0, excludedNonEntertainment = 0;
  const now = Date.now();
  for (const row of rows.current) {
    const begins = Date.parse(toTime(row.streamBeginTime || row.liveStartTime));
    const ends = Date.parse(toTime(row.liveEndTime));
    if (now >= begins && now <= ends) {
      const item = itemFor(row, 'live');
      blocked.push({ ...item, reason: '发现当前活动时段；本模块尚未完成芒果活动直播的实网验收，暂不导出' });
    }
  }
  // Only recent official event replay pages. Fixed television and shopping channels are not used.
  for (const row of rows.replay) {
    if (items.length >= Math.max(1, Math.min(Number(limit) || 3, 3))) break;
    examined++;
    if (/新闻|足球/.test(String(row.name))) { excludedNonEntertainment++; continue; }
    const item = itemFor(row);
    if (/VIP|会员|付费|购买/i.test(String(row.rightCorner || ''))) {
      blocked.push({ ...item, reason: `官方目录权益标记：${row.rightCorner}` });
      continue;
    }
    checked++;
    try {
      const { data } = await videoInfo(item.videoId, options);
      const reason = restrictionFor(data);
      if (reason) blocked.push({ ...item, reason });
      else items.push({ ...item, title: String(data.info.partName || item.title).trim(), duration: Number(data.info.duration), description: item.description, access: 'public-full', quality: '最高匿名公开档；播放时再核验清单时长' });
    } catch (error) { blocked.push({ ...item, reason: error.message }); }
  }
  return {
    items,
    blocked,
    notes: [
      `直接读取芒果官网直播大事件与精彩回顾；读取前3页共 ${rows.replay.length} 个回放目录项，处理其中前 ${examined} 项（${excludedNonEntertainment} 项非娱乐活动跳过），匿名权益检查 ${checked} 项，返回 ${items.length} 个完整回放候选，排除 ${blocked.length} 项；余下 ${rows.replay.length - examined} 项未检查。`,
      '目录“未标VIP”不等于匿名全长可播；同时检查paymark、purview、clipLimit、DRM，播放时再验证HLS累计时长。',
      'trialtime字段在部分公开完整节目中仍有默认值；clipLimit=0且实际清单覆盖全长才可输出。当前活动直播取流尚未实网验收。',
    ],
  };
}

function videoIdOf(item) {
  const match = /^mgtv-(\d{1,12})$/.exec(String(item?.id || ''));
  if (!match) throw new Error('芒果活动引用不合法，或该直播类型尚未验收');
  return match[1];
}

// 已验收场次按 ID 直接查官方播放信息，不依赖活动目录的排序和翻页：
// 目录按新到旧排，新活动一多，已验收场次就会被挤出前几条或前三页。
export async function lookup(seeds, options = {}) {
  const items = [], blocked = [];
  for (const seed of seeds) {
    try {
      const videoId = videoIdOf(seed);
      const { data } = await videoInfo(videoId, options);
      const reason = restrictionFor(data);
      const item = { id: seed.id, provider: id, title: String(data.info.partName || '').trim(), page: `https://www.mgtv.com/s/${videoId}.html`, kind: 'replay', videoId };
      if (reason) blocked.push({ ...item, reason });
      else items.push({ ...item, duration: Number(data.info.duration), access: 'public-full' });
    } catch (error) { blocked.push({ id: seed.id, title: seed.title, reason: error.message }); }
  }
  return { items, blocked };
}

export async function resolve(item, options = {}) {
  const videoId = videoIdOf(item);
  const page = `https://www.mgtv.com/s/${videoId}.html`;
  const headers = { 'User-Agent': UA, Referer: page, Origin: 'https://www.mgtv.com' };
  const { data, tk2 } = await videoInfo(videoId, { ...options, headers });
  const reason = restrictionFor(data);
  if (reason) throw new Error(reason);
  const response = await request(query(SOURCE, {
    _support: '10000000', tk2, pm2: data.atc.pm2, video_id: videoId, type: 'pch5',
    auth_mode: '1', cxid: '', supportMse: '1', src: 'intelmgtv', allowedRC: '1',
  }), { ...options, headers });
  if (Number(response.code) !== 200 || !response.data) throw new Error(`官方媒体调度拒绝：${response.code || '未知状态'}`);
  const streams = (response.data.stream || []).filter(stream => stream.url && String(stream.vip) === '0' && /H264|AVC/i.test(stream.videoFormat || ''))
    .sort((a, b) => Number(b.def || 0) - Number(a.def || 0));
  if (!streams.length) throw new Error('没有匿名公开的 H.264 媒体档位');
  let lastError;
  for (const domain of response.data.stream_domain || []) {
    try {
      const dispatch = await request(allowedUrl(streams[0].url, allowedUrl(domain)), { ...options, headers });
      if (dispatch.status !== 'ok' || !dispatch.info) throw new Error('官方 CDN 调度失败');
      const url = allowedUrl(dispatch.info);
      const manifest = await request(url, { ...options, headers, json: false });
      const manifestDuration = validateFullManifest(manifest, Number(data.info.duration));
      return { url, headers, allowedHosts: ALLOWED_HOSTS, kind: 'replay', duration: Number(data.info.duration), manifestDuration, quality: streams[0].standardName || streams[0].name, expiresAt: Date.now() + 3 * 60 * 1000 };
    } catch (error) { lastError = error; }
  }
  throw new Error(lastError?.message || '所有官方调度域名均未返回可用全长媒体');
}
