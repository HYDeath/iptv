import { settleRequests } from './settled.mjs';
/** Anonymous official auction-house editorial video extraction; viewing only. */
export const provider = Object.freeze({ id: 'auctions', name: '拍卖与艺术预展', officialUrl: 'https://www.phillips.com/' });
const RELIGIOUS = /佛教|佛像|佛造像|藏传|梵像|宗教|基督|天主|清真|buddh|religio|devotional|sacred|holy\s|islamic/i;
const PHILLIPS_ACCOUNT = '6415663453001';
const policies = new Map();
function clean(value = '') {
  return String(value).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#(?:x27|39);/g, "'").replace(/&rsquo;|&#x2019;/g, '’').replace(/&lsquo;/g, '‘').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
async function request(url, options = {}, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${new URL(url).hostname}`);
  return response;
}
function playerReference(value, expectedAccount) {
  try {
    const url = new URL(clean(value), 'https://www.phillips.com/');
    const match = url.pathname.match(/^\/(\d+)\/([\w-]+)_([\w-]+)\/index\.html$/);
    const videoId = url.searchParams.get('videoId');
    if (url.hostname !== 'players.brightcove.net' || match?.[1] !== expectedAccount || !/^\d+$/.test(videoId || '')) return null;
    return { accountId: match[1], videoId, scriptUrl: `https://players.brightcove.net/${match[1]}/${match[2]}_${match[3]}/index.min.js` };
  } catch { return null; }
}
export function chooseClearSource(video) {
  const allowed = (video.sources || []).filter(source => {
    if (!source.src?.startsWith('https://') || source.key_systems || source.drm) return false;
    try {
      const url = new URL(source.src);
      return ['brightcovecdn.com', 'boltdns.net', 'brightcove.com', 'akamaihd.net'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
    } catch { return false; }
  });
  return allowed.filter(source => source.container === 'MP4').sort((a, b) => (b.height || 0) - (a.height || 0) || (b.avg_bitrate || 0) - (a.avg_bitrate || 0))[0]
    || allowed.find(source => /mpegurl/i.test(source.type || ''));
}
async function publicVideo(reference, options) {
  const cache = policies.get(reference.scriptUrl);
  let key = cache?.expiresAt > Date.now() ? cache.key : null;
  if (!key) {
    const script = await (await request(reference.scriptUrl, {}, options)).text();
    key = script.match(/policyKey\s*:\s*["']([^"']+)["']/)?.[1];
    if (!key) throw new Error('官方公开播放器未声明可复现的播放配置');
    policies.set(reference.scriptUrl, { key, expiresAt: Date.now() + 10 * 60 * 1000 });
  }
  // Public read-only player catalog key, extracted from the exact player embedded by the house.
  const url = `https://edge.api.brightcove.com/playback/v1/accounts/${reference.accountId}/videos/${reference.videoId}`;
  const video = await (await request(url, { headers: { Accept: `application/json;pk=${key}` } }, options)).json();
  const source = chooseClearSource(video);
  if (!source || Number(video.duration) <= 0 || video.custom_fields?.live === 'true') throw new Error('当前视频没有公开无DRM的回看媒体');
  return { video, source };
}
async function resolvePhillips(slug, options) {
  if (!/^[a-z0-9][a-z0-9-]{0,160}$/.test(slug)) throw new Error('无效的富艺斯视频详情');
  const pageUrl = `https://www.phillips.com/video/${slug}`;
  const html = await (await request(pageUrl, {}, options)).text();
  const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || slug);
  const description = clean(html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i)?.[1] || '富艺斯官方预展、拍卖回顾或机构介绍短片。');
  if (RELIGIOUS.test(`${title} ${description}`)) throw new Error('宗教专题不收录');
  const ref = [...html.matchAll(/<iframe\b[^>]*\bsrc="([^"]+)"/gi)].map(match => playerReference(match[1], PHILLIPS_ACCOUNT)).find(Boolean);
  if (!ref) throw new Error('该富艺斯详情没有公开Brightcove播放器');
  const { video, source } = await publicVideo(ref, options);
  const contentLabel = /highlights|sold|post.?sale/i.test(`${title} ${description}`) ? '拍后回顾短片' : /abcs|world of Phillips/i.test(`${title} ${description}`) ? '拍卖机构介绍短片' : '拍卖预展短片';
  return {
    id: `phillips-${slug}`, provider: provider.id, institution: '富艺斯 Phillips', category: '拍卖', kind: 'vod',
    title, pageUrl, description: `富艺斯官方${contentLabel}。${description}`,
    url: source.src, headers: { Referer: 'https://www.phillips.com/' },
    duration: Number(video.duration) / 1000, format: source.container === 'MP4' ? 'mp4' : 'hls',
    videoId: ref.videoId,
  };
}
export async function resolve(itemId, options = {}) {
  const owner = itemId.startsWith('phillips-') ? '富艺斯 Phillips' : '';
  if (options.institution && owner !== options.institution) throw new Error('节目不属于该拍卖机构');
  if (itemId.startsWith('phillips-')) return resolvePhillips(itemId.slice(9), options);
  throw new Error('无效的拍卖机构条目');
}
async function discoverPhillips(options) {
  const html = await (await request('https://www.phillips.com/', {}, options)).text();
  const slugs = [...new Set([...html.matchAll(/href="(?:https:\/\/www\.phillips\.com)?\/video\/([a-z0-9-]+)"/g)].map(match => match[1]))].filter(slug => !RELIGIOUS.test(slug) && !/abcs-of-phillips|^dialogues$|how-to|about-phillips/i.test(slug)).slice(0, Math.min(options.vodLimit ?? 2, 2));
  return settleRequests(slugs.map(slug => resolvePhillips(slug, options)));
}
export async function discover(options = {}) {
  const jobs = [
    { name: '富艺斯 Phillips', run: () => discoverPhillips(options) },
  ].filter(job => !options.institution || job.name === options.institution);
  if (!jobs.length) throw new Error('未知拍卖机构');
  const results = await settleRequests(jobs.map(job => job.run()));
  const items = [], notes = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status === 'rejected') { notes.push(`${jobs[index].name}：${result.reason.message}`); continue; }
    for (const row of result.value) {
      if (row.status === 'fulfilled') items.push(row.value);
      else notes.push(row.reason.message);
    }
  }
  notes.push('当前收录官方预展、艺术介绍和拍卖回顾短片，均为VOD；未验证到当前在播的拍卖现场。仅提供观看，不操作竞买、注册、出价或交易。');
  return { provider: provider.id, items, notes, upcoming: [] };
}
