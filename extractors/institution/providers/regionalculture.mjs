import { settleRequests, throwIfAllRejected } from './settled.mjs';
/** Two independently extracted official provincial cultural-center catalogs. */
import { setTimeout as delay } from 'node:timers/promises';
export const provider = Object.freeze({
  id: 'regionalculture',
  name: '地方文化馆',
  officialUrl: 'https://www.gdscc.cn/whzx/web/index.html',
});
const GD_HOME = 'https://www.gdscc.cn/whzx/web';
const HN_HOME = 'https://hns-whg.cn/Cloud/index.html';
const RELIGIOUS = /宗教|佛教|佛寺|寺庙|基督|天主教|教会|道教|清真|伊斯兰/;
const PLACEHOLDER = /直播已结束|直播结束|暂无直播|暂无回放|暂未开播|未开始|defaultVideo/i;
function strip(value = '') { return String(value).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&ldquo;|&rdquo;/g, '“').replace(/&mdash;/g, '—').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); }
function validUrl(value, { relativeBase, hosts } = {}) {
  if (!value || /\s/.test(value)) return null;
  try {
    const url = new URL(value, relativeBase);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || url.hostname.includes(':') || /^\d+(?:\.\d+){3}$/.test(url.hostname)) return null;
    if (PLACEHOLDER.test(decodeURIComponent(url.pathname))) return null;
    if (hosts && !hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    return url.href;
  } catch { return null; }
}
async function jsonRequest(url, init = {}, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${new URL(url).host}`);
  return response.json();
}
async function gdApi(path, params, options) {
  const data = await jsonRequest(`https://gdweb.gdscc.cn/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', sysPlatform: 'web', Referer: `${GD_HOME}/index.html` },
    body: new URLSearchParams({ shopPath: 'whzx', shopProvince: 'guangdong', ...params }),
  }, options);
  if (Number(data.status) !== 200 || !data.data) throw new Error('广东文化馆未返回公开资料');
  return data.data;
}
async function hnApi(path, params, options) {
  const url = new URL(`https://api.hns-whg.cn/${path}`);
  url.search = new URLSearchParams(params).toString();
  const data = await jsonRequest(url.href, { headers: { Referer: `${HN_HOME}#/` } }, options);
  if (data.sucFlag !== true || !data.data) throw new Error('湖南文化馆未返回公开资料');
  return data.data;
}
function gdBase(detail) {
  const id = String(detail.liveActivityId || '');
  if (!/^[a-f0-9]{32}$/i.test(id) || RELIGIOUS.test(`${detail.liveTitle} ${detail.liveIntroduction || ''}`)) return null;
  return {
    id: `gd-${id}`, provider: provider.id, institution: '广东省文化馆',
    title: detail.liveTitle,
    pageUrl: `${GD_HOME}/video/detail.html?id=${id}`,
    description: strip(detail.liveIntroduction || '').slice(0, 800),
    startTime: detail.liveStartTime || null, endTime: detail.liveEndTime || null,
    officialState: Number(detail.liveActivityTimeStatus),
  };
}
export function gdItemFromDetail(detail) {
  const base = gdBase(detail);
  if (!base || Number(detail.mustLogin) !== 0 || Number(detail.platformType) === 2) return null;
  let candidate;
  if (base.officialState === 1) {
    candidate = Number(detail.liveIsTranscoding)
      ? detail.transcodeTemplateList?.find(row => row.outputResolution === '720p')?.linkUrl || detail.transcodeTemplateList?.[0]?.linkUrl
      : detail.liveLink?.m3u8;
  } else if (base.officialState === 3) {
    if (Number(detail.useAutoRecord) !== 1 || (detail.liveVideoUrl && Number(detail.livePlaybackCheck) !== 2)) return null;
    candidate = detail.liveVideoUrl || (Number(detail.liveIsTranscoding) ? detail.transcodeTemplateList?.[0]?.linkUrl : detail.streamEvent?.recordUrl);
  } else return null;
  const url = validUrl(candidate);
  if (!url) return null;
  return { ...base, kind: base.officialState === 1 ? 'live' : 'vod', url, headers: { Referer: `${GD_HOME}/index.html` } };
}
function hnBase(detail) {
  const id = String(detail.id || '');
  if (!/^\d+$/.test(id) || detail.enable === false || detail.removed === true || RELIGIOUS.test(`${detail.livingName || detail.name} ${detail.introduce || ''}`)) return null;
  return {
    id: `hn-${id}`, provider: provider.id, institution: '湖南省文化馆',
    title: detail.livingName || detail.name,
    pageUrl: `${HN_HOME}#/Live/Detail?id=${id}`,
    description: strip(detail.introduce || detail.content || '').slice(0, 800),
    startTime: detail.startTime ? new Date(detail.startTime).toISOString() : null,
    endTime: detail.endTime ? new Date(detail.endTime).toISOString() : null,
    officialState: Number(detail.status),
  };
}
export function hnItemFromDetail(detail) {
  const base = hnBase(detail);
  if (!base) return null;
  // Official detail component prepends IMAGEPATH=https://cdn.hns-whg.cn/ to native VOD object keys.
  if (base.officialState === 2 && String(detail.livingTypeId) === '1' && Number(detail.duration) > 0) {
    const url = validUrl(detail.videoUrl, { relativeBase: 'https://cdn.hns-whg.cn/', hosts: ['cdn.hns-whg.cn'] });
    return url ? { ...base, kind: 'vod', url, headers: { Referer: `${HN_HOME}#/` } } : null;
  }
  if (base.officialState === 1 && String(detail.livingTypeId) === '2') {
    const url = validUrl(detail.videoUrl);
    return url ? { ...base, kind: 'live', url, headers: { Referer: `${HN_HOME}#/` } } : null;
  }
  // Ended external live URLs are not assumed to contain a replay.
  return null;
}
function segmentSignature(manifest, base) {
  return manifest.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => new URL(line, base).pathname).join('\n');
}
async function requireAdvancingLive(item, { fetchImpl = fetch } = {}) {
  const read = async () => {
    const response = await fetchImpl(item.url, { headers: item.headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`直播媒体 HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trimStart().startsWith('#EXTM3U') || /#EXT-X-ENDLIST|#EXT-X-STREAM-INF/.test(text) || !/#EXTINF:/.test(text)) throw new Error('未取得有效的单层实时HLS');
    return text;
  };
  const first = await read();
  const target = Number(first.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1] || 4);
  await delay(Math.min(10000, Math.max(2000, target * 1000 + 500)));
  const second = await read();
  const sequence1 = first.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1];
  const sequence2 = second.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1];
  if ((sequence1 != null && sequence2 != null && Number(sequence2) <= Number(sequence1)) || segmentSignature(first, item.url) === segmentSignature(second, item.url)) throw new Error('直播清单未前进');
  return { ...item, manifestProgressVerified: true };
}
async function gdDetail(id, options) { return gdApi('apiLive/liveActivityDetail.do', { liveActivityId: id }, options); }
async function hnDetail(id, options) { return hnApi('front/live/findOneById', { id }, options); }
export async function resolve(itemId, options = {}) {
  const owner = itemId.startsWith('gd-') ? '广东省文化馆' : itemId.startsWith('hn-') ? '湖南省文化馆' : '';
  if (options.institution && owner !== options.institution) throw new Error('节目不属于该文化馆');
  let item;
  if (/^gd-[a-f0-9]{32}$/i.test(itemId)) item = gdItemFromDetail(await gdDetail(itemId.slice(3), options));
  else if (/^hn-\d+$/.test(itemId)) item = hnItemFromDetail(await hnDetail(itemId.slice(3), options));
  else throw new Error('无效的地方文化馆节目ID');
  if (!item) throw new Error('该节目当前未公开播放、已结束、需登录或为占位视频');
  return item.kind === 'live' ? requireAdvancingLive(item, options) : item;
}
async function discoverGd(options) {
  const catalog = await gdApi('apiLive/getLiveActivityList.do', { resultIndex: '1', resultSize: '36', liveCheck: '2', liveActivityTimeStatus: '5', sortType: 'multiple' }, options);
  const items = [], upcoming = [], notes = [];
  const rows = catalog.list || [];
  let placeholders = 0, inspected = 0;
  const attemptedDetails = [];
  for (let offset = 0; offset < rows.length; offset += 6) {
    const details = await Promise.allSettled(rows.slice(offset, offset + 6).map(row => gdDetail(row.liveActivityId, options)));
    attemptedDetails.push(...details);
    inspected += details.length;
    for (const result of details) {
      if (result.status === 'rejected') { notes.push(result.reason.message); continue; }
      const detail = result.value;
      const base = gdBase(detail);
      if (base?.officialState === 2 && Number(detail.mustLogin) === 0) { upcoming.push(base); continue; }
      const item = gdItemFromDetail(detail);
      if (!item) { if (PLACEHOLDER.test(detail.liveVideoUrl || '')) placeholders++; continue; }
      if (item.kind === 'live') {
        try { items.push(await requireAdvancingLive(item, options)); } catch (error) { notes.push(`${item.title}：${error.message}`); }
      } else if (items.filter(row => row.kind === 'vod').length < (options.vodLimit ?? 3)) items.push(item);
    }
    if (items.filter(row => row.kind === 'vod').length >= (options.vodLimit ?? 3) && offset >= 12) break;
  }
  throwIfAllRejected(attemptedDetails);
  notes.push(`广东省文化馆目录共${catalog.sum}场；检查近期${inspected}条候选，排除“直播已结束”等占位片${placeholders}条。预告单独展示。`);
  return { items, upcoming, notes };
}
async function discoverHn(options) {
  const rows = await hnApi('front/live/largeCollection', { currentPage: '1', lineSize: '48' }, options);
  const items = [], upcoming = [], notes = [];
  const chosen = rows.filter(row => Number(row.status) === 0 || Number(row.status) === 1 || (Number(row.status) === 2 && String(row.livingTypeId) === '1')).slice(0, 12);
  const details = await settleRequests(chosen.map(row => hnDetail(String(row.id), options)));
  for (const result of details) {
    if (result.status === 'rejected') { notes.push(result.reason.message); continue; }
    const detail = result.value;
    const base = hnBase(detail);
    if (base?.officialState === 0) { upcoming.push(base); continue; }
    const item = hnItemFromDetail(detail);
    if (!item) continue;
    if (item.kind === 'live') {
      try { items.push(await requireAdvancingLive(item, options)); } catch (error) { notes.push(`${item.title}：官方标在播，但${error.message}，未收录直播。`); }
    } else if (items.filter(row => row.kind === 'vod').length < (options.vodLimit ?? 3)) items.push(item);
  }
  notes.push('湖南省文化馆使用新站公开API；仅收录官网原生回看，不将已结束的外部直播URL当回看。');
  return { items, upcoming, notes };
}
export async function discover(options = {}) {
  const jobs = [
    { name: '广东省文化馆', run: () => discoverGd(options) },
    { name: '湖南省文化馆', run: () => discoverHn(options) },
  ].filter(job => !options.institution || job.name === options.institution);
  if (!jobs.length) throw new Error('未知文化馆机构');
  const results = await settleRequests(jobs.map(job => job.run()));
  const items = [], upcoming = [], notes = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status === 'fulfilled') { items.push(...result.value.items); upcoming.push(...result.value.upcoming); notes.push(...result.value.notes); }
    else notes.push(`${jobs[index].name}：${result.reason.message}`);
  }
  return { provider: provider.id, items, upcoming, notes };
}
