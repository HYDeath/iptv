import { settleRequests } from './settled.mjs';
export const provider = {
  id: 'performingarts',
  name: '剧院与音乐院校',
  officialUrl: 'https://gdm.gzdjy.org/local/86_36/cloudtheater.html',
};

const ccomHome = 'https://video.ccom.edu.cn/';
const gzyHome = provider.officialUrl;
const excluded = /宗教|佛教|基督|天主教|伊斯兰|道教|弘法|法会|讲经|禅修|妈祖/;
const clean = s => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const decode = s => clean(decodeURIComponent(String(s || '')).replace(/\+/g, ' '));

async function read(fetchImpl, url, init = {}) {
  const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`演艺机构官方入口 HTTP ${r.status}`);
  return r.text();
}

async function gzyApi(method, body, fetchImpl) {
  const text = await read(fetchImpl, `https://gdm.gzdjy.org/MService.asmx/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Referer: gzyHome }, body: JSON.stringify(body),
  });
  const outer = JSON.parse(text);
  return JSON.parse(outer.d);
}

async function gzyItem(ticketId, fetchImpl) {
  const data = await gzyApi('GetCloundTicket', { ticketid: ticketId }, fetchImpl);
  if (String(data.errcode) !== '0' || String(data.isallow) !== '1') return null;
  const title = decode(data.title);
  if (excluded.test(title)) return null;
  const video = data.videos?.find(v => /^https?:\/\//.test(decode(v.url)) && /^\d+$/.test(String(v.fileid)));
  if (!video) return null;
  // Reproduce the official TCPlayer fileID/appID/psign flow. The catalogue's
  // bare source URL is not the current signed playback address.
  const playInfoUrl = new URL(`https://playvideo.qcloud.com/getplayinfo/v4/${data.appid}/${video.fileid}`);
  if (video.token) playInfoUrl.searchParams.set('psign', video.token);
  const info = JSON.parse(await read(fetchImpl, playInfoUrl, { headers: { Referer: gzyHome } }));
  if (info.code !== 0) throw new Error(`广州大剧院官方播放器未授权媒体：${info.message || info.code}`);
  const candidates = (info.videoInfo?.transcodeList || []).filter(v => /\.mp4(?:\?|$)/i.test(v.url || ''));
  candidates.sort((a, b) => b.height - a.height || a.bitrate - b.bitrate);
  const plain = info.media?.streamingInfo?.plainOutput;
  const source = candidates[0] || info.videoInfo?.sourceVideo || (plain?.type === 'plain' ? plain : null);
  if (!source?.url) return null;
  const url = new URL(source.url);
  if (url.hostname !== 'vod.gzdjy.org' || !/\.(mp4|m3u8)$/i.test(url.pathname)) return null;
  const check = async () => {
    const response = await fetchImpl(url, { headers: { Referer: gzyHome, Range: 'bytes=0-0' }, signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`广州大剧院公开媒体 HTTP ${response.status}`);
  };
  try { await check(); }
  catch (error) {
    // The official VOD host currently has an expired HTTPS certificate. Only
    // this exact TLS failure admits its tested same-host HTTP transport; TLS
    // verification remains enabled and 403/rights errors never downgrade.
    if (url.protocol !== 'https:' || error.cause?.code !== 'CERT_HAS_EXPIRED') throw error;
    url.protocol = 'http:';
    await check();
  }
  const section = decode(video.section);
  return {
    id: `gzy-${ticketId}`, provider: provider.id, institution: '广州大剧院',
    title: `${title}${section && section !== '回放' ? ` · ${section}` : ''}`, kind: 'vod',
    pageUrl: `https://gdm.gzdjy.org/local/86_36/cloudtheater_inner.html?id=${ticketId}`, url: url.href,
    headers: { Referer: gzyHome },
    description: `官方云剧院公开的歌谣夜或艺术导赏回放。${url.protocol === 'http:' ? '该媒体域证书过期，使用同官方域 HTTP 传输。' : '使用官方 HTTPS 媒体。'}`,
  };
}

export function parseCcomDetail(html, pageUrl) {
  const scope = Number(html.match(/\bvar\s+scope\s*=\s*(\d+)/)?.[1] ?? -1);
  // Current official content.js blocks anonymous scope 0 and campus-only scope 2.
  // Only the observed public scope 1 is admitted; other values fail closed.
  if (scope !== 1) return null;
  const sources = [...html.matchAll(/\bvar\s+videourl\s*=\s*["']([^"']+)["']/g)];
  const source = sources.at(-1)?.[1];
  const title = clean(html.match(/<h4\b[^>]*class=["']titles?["'][^>]*>([\s\S]*?)<\/h4>/i)?.[1] || '');
  if (!source || !title || excluded.test(title) || !title.includes('国乐琼思音乐会')) return null;
  const url = new URL(source);
  if (url.hostname !== 'vodvideo.ccom.edu.cn' || !/\.mp4$/i.test(url.pathname)) return null;
  const article = pageUrl.match(/content_(\d+)\.shtml/)?.[1];
  if (!article) return null;
  return {
    id: `ccom-${article}`, provider: provider.id, institution: '中央音乐学院', title, kind: 'vod', pageUrl, url: url.href,
    headers: { Referer: pageUrl },
    description: '中央音乐学院国乐琼思音乐会演奏分集，保留原分集名称。',
  };
}

async function ccomAccessStillPublic(fetchImpl) {
  const script = (await read(fetchImpl, 'https://video.ccom.edu.cn/js/pc/content.js')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (!/if\s*\(\s*scope\s*==\s*0\s*\)/.test(script) || !/if\s*\(\s*scope\s*==\s*2\s*\)/.test(script) || /if\s*\(\s*scope\s*==\s*1\s*\)/.test(script)) {
    throw new Error('央音视频公开权限规则已变化，需要重新核验。');
  }
}

async function discoverCcom(fetchImpl) {
  const [home] = await Promise.all([read(fetchImpl, ccomHome), ccomAccessStillPublic(fetchImpl)]);
  const seen = new Set();
  const pages = [...home.matchAll(/<a\b[^>]*href=["']([^"']*\/web\/video\/content_\d+\.shtml)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .filter(m => clean(m[2]).includes('国乐琼思音乐会'))
    .map(m => new URL(m[1], ccomHome).href)
    .filter(url => !seen.has(url) && seen.add(url))
    .slice(0, 2);
  return (await Promise.all(pages.map(async pageUrl => parseCcomDetail(await read(fetchImpl, pageUrl), pageUrl)))).filter(Boolean);
}

async function discoverGzy(fetchImpl) {
  const data = await gzyApi('GetWxTicketList', {
    jsondata: JSON.stringify({ OrgId: '86', SiteId: '36', producttypeids: '8', PageIndex: '0', PageSize: '70', SortBy: '2' }),
  }, fetchImpl);
  const candidates = (data?.[0]?.[5] || []).filter(row => /歌谣夜|漫游经典/.test(decode(row[1])) && !excluded.test(decode(row[1]))).slice(0, 2);
  return (await Promise.all(candidates.map(row => gzyItem(String(row[16]), fetchImpl)))).filter(Boolean);
}

export async function discover({ fetchImpl = fetch, institution } = {}) {
  const jobs = [
    { name: '广州大剧院', run: () => discoverGzy(fetchImpl) },
    { name: '中央音乐学院', run: () => discoverCcom(fetchImpl) },
  ].filter(job => !institution || job.name === institution);
  if (!jobs.length) throw new Error('未知演艺机构');
  const results = await settleRequests(jobs.map(job => job.run()));
  const notes = [];
  if (!institution || institution === '广州大剧院') notes.push('广州大剧院只纳入匿名接口 isallow=1 的公开项目，经官方 TCPlayer 接口动态取当前媒体；付费/无权限及仅返回 # 的整场演出排除。当前官方媒体域 HTTPS 证书过期，验证同域 HTTP 可播后使用 HTTP；未关闭证书验证。');
  if (!institution || institution === '中央音乐学院') notes.push('中央音乐学院只取官网当前首页前两条国乐琼思演奏分集，并重新检查官方匿名权限逻辑。');
  const items = [];
  for (const result of results) {
    if (result.status === 'fulfilled') items.push(...result.value);
    else notes.push(result.reason.message);
  }
  return { provider: provider.id, items, notes };
}

export async function resolve(id, { fetchImpl = fetch, institution } = {}) {
  const owner = id.startsWith('gzy-') ? '广州大剧院' : id.startsWith('ccom-') ? '中央音乐学院' : '';
  if (institution && owner !== institution) throw new Error('节目不属于该演艺机构');
  let item;
  if (/^gzy-\d+$/.test(id)) item = await gzyItem(id.slice(4), fetchImpl);
  else if (/^ccom-\d+$/.test(id)) {
    await ccomAccessStillPublic(fetchImpl);
    const pageUrl = `${ccomHome}web/video/content_${id.slice(5)}.shtml`;
    item = parseCcomDetail(await read(fetchImpl, pageUrl), pageUrl);
  }
  if (!item) throw new Error('该演艺节目已不可匿名公开观看，或不属于本轮已核验的演奏/艺术导赏。');
  return item;
}
