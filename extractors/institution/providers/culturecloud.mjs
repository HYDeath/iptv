import { settleRequests } from './settled.mjs';
/** Official 国家公共文化云 anonymous web-player adapter. No login cookies required. */
export const provider = Object.freeze({
  id: 'culturecloud',
  name: '国家公共文化云',
  officialUrl: 'https://www.culturedc.cn/web3.0/liveHome.html',
});
const API = 'https://www.culturedc.cn/api/v1/encrypt';
const REFERER = provider.officialUrl;
const RELIGIOUS = /宗教|佛教|佛寺|寺庙|基督|天主教|教会|道教|清真|伊斯兰/;

async function api(apiKey, params = {}, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: REFERER },
    body: new URLSearchParams({ apiKey, deviceType: 'DIC_DEVICE_TYPE_1', ...params }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`公共文化云 API HTTP ${response.status}`);
  const json = await response.json();
  if (Number(json.returnCode) !== 1 || !json.returnData) throw new Error(`公共文化云 API ${apiKey} 未返回公开数据`);
  return json.returnData;
}
function stateOf(detail) {
  return Number(detail.state ?? detail.state2);
}
function mediaUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!(url.hostname === 'culturedc.cn' || url.hostname.endsWith('.culturedc.cn') || url.hostname === 'hyxklive.hanyastar.cn')) return null;
    if (!/\.(?:m3u8|mp4)$/i.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}
export function itemFromDetail(detail) {
  const state = stateOf(detail);
  if (![0, 1].includes(state) || detail.isBootleg) return null;
  // WATCH_CFG_3 is paid; WATCH_CFG_1000 is the current web player's timed login preview.
  // WATCH_CFG_1 is currently played anonymously by live-common.js; see research report.
  if (!['WATCH_CFG_1', 'WATCH_CFG_2'].includes(detail.watchCfg)) return null;
  if (RELIGIOUS.test(`${detail.title || ''} ${detail.desc || ''}`)) return null;
  const id = String(detail.logicSourceId || detail.id || '');
  if (!/^\d+$/.test(id)) return null;
  // Match getVideoOrLiveUrl()'s !isLogin() quality selection, including its VOD fallback.
  const url = mediaUrl(state === 1
    ? (detail.urlFluency || detail.urlSd || detail.url || detail.urlFhd)
    : (detail.backUrlFluency || detail.backUrlSd || detail.backUrl || detail.backUrlFhd));
  if (!url) return null;
  return {
    id,
    provider: provider.id,
    title: detail.title,
    kind: state === 1 ? 'live' : 'vod',
    pageUrl: `https://www.culturedc.cn/web3.0/liveDetail_ali.html?resId=${id}`,
    url,
    headers: { Referer: REFERER },
    description: (detail.shareDesc || detail.desc || '').replace(/<[^>]*>/g, '').slice(0, 800),
    startTime: detail.startTime || null,
    endTime: detail.endTime || null,
    access: 'official-anonymous',
    officialState: state,
    watchCfg: detail.watchCfg,
  };
}
async function getDetail(id, options) {
  if (!/^\d+$/.test(String(id))) throw new Error('无效的公共文化云活动 ID');
  return api('api_post_getLiveDetailBySourceId', {
    logicSourceId: String(id), pageNumber: '1', pageSize: '1', userId: '', isPreview: '0', showHighlights: '1',
  }, options);
}
export async function discover(options = {}) {
  const responses = await settleRequests([
    api('api_get_getLiveIndexList', {}, options),
    api('api_get_getRecommendedList', {
      pageNumber: '1', pageSize: '50', publishColumnDic: 'PUBLISH_HOME_LIVE',
      publishArea: '', showNoPublish: '', userId: '', pubChannelDic: 'PUBLISH_CHANNEL_DIC_1',
    }, options),
  ]);
  const unique = new Map();
  const notes = [];
  for (const result of responses) {
    if (result.status === 'rejected') { notes.push(result.reason.message); continue; }
    for (const row of result.value) {
      if (row.resType !== 'DIC_RESOURCE_TYPE_8') continue;
      unique.set(String(row.logicSourceId), row);
    }
  }
  const rows = [...unique.values()];
  const lives = rows.filter(row => stateOf(row) === 1).slice(0, 10);
  const vods = rows.filter(row => stateOf(row) === 0).slice(0, options.vodLimit ?? 3);
  const items = [];
  const details = await settleRequests([...lives, ...vods].map(row => getDetail(row.logicSourceId, options)));
  for (const result of details) {
    if (result.status === 'rejected') { notes.push(result.reason.message); continue; }
    const item = itemFromDetail(result.value);
    if (item) items.push(item);
    else notes.push(`${result.value.title || result.value.id}: 无公开完整播放地址、状态变化或不在收录范围`);
  }
  notes.push(`官方直播首页和首页推荐共 ${rows.length} 个不同活动：在播 ${rows.filter(row => stateOf(row) === 1).length}、回看 ${rows.filter(row => stateOf(row) === 0).length}、预告 ${rows.filter(row => stateOf(row) === 2).length}。不是全天线性频道目录。`);
  return { provider: provider.id, items, notes };
}
export async function resolve(itemId, options = {}) {
  const item = itemFromDetail(await getDetail(itemId, options));
  if (!item) throw new Error('该活动当前未提供可匿名播放的直播或回看');
  return item;
}
