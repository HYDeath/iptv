import { settleRequests, throwIfAllRejected } from './settled.mjs';
import { createHash } from 'node:crypto';

export const provider = {
  id: 'conferences',
  name: '会议论坛（中关村论坛／上海论坛）',
  officialUrl: 'https://www.zgcforum.com.cn/zh2026/live',
};

const ZGC_LIST = 'https://www.zgcforum.com.cn/zh2026/live';
const ZGC_PLAYER = 'https://live.zgcforum.com.cn/activity/p1/index.html';
const SHANGHAI = 'https://shanghaiforum.fudan.edu.cn/';
const EXCLUDED = /宗教|佛教|基督|天主教|道教|伊斯兰|弘法|法会|讲经|禅修/;

const clean = (value = '') => value.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function getText(url, fetchImpl, headers) {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
}

async function getData(url, fetchImpl, headers) {
  const data = JSON.parse(await getText(url, fetchImpl, headers));
  if (data.status !== 200) throw new Error(`会议服务：${data.msg || data.status}`);
  return data.data;
}

function playerUrl(aid) {
  const url = new URL(ZGC_PLAYER);
  url.searchParams.set('aid', aid);
  url.searchParams.set('lang', 'cn');
  return url.href;
}

async function dayangEnvironment(pageUrl, fetchImpl) {
  const page = await getText(pageUrl, fetchImpl);
  const script = page.match(/<script\b[^>]*src=["']([^"']*\/js\/config\.js)["']/i)?.[1];
  if (!script) throw new Error('中关村论坛播放器未提供官方服务配置');
  const configUrl = new URL(script, pageUrl);
  if (configUrl.hostname !== 'live.zgcforum.com.cn') throw new Error('播放器配置来源发生变化');
  const scriptText = await getText(configUrl.href, fetchImpl);
  // Read only literal configuration values. Never evaluate the remote JavaScript.
  const values = new Map([...scriptText.matchAll(/^\s*var\s+(cdn_play_live_url|uc_url)\s*=\s*["']([^"']+)["']/gm)]
    .map(match => [match[1], match[2]]));
  const api = values.get('cdn_play_live_url'), uc = values.get('uc_url');
  if (!api || !uc || new URL(api).hostname !== 'public.cloud.dayang.com.cn'
    || new URL(uc).hostname !== 'live.cloud.dayang.com.cn') throw new Error('公开活动 API 配置发生变化');
  return { api, uc };
}

function chinaTime(value) {
  return Date.parse(`${String(value).replace(' ', 'T')}+08:00`);
}

async function zgcItem(aid, fetchImpl, { notes = [], upcoming = [], environment } = {}) {
  const pageUrl = playerUrl(aid);
  const { api, uc } = environment ?? await dayangEnvironment(pageUrl, fetchImpl);
  const auth = await getData(`${api}/api/v2/activity/auth?activityId=${aid}`, fetchImpl);
  const tm = Date.now();
  const sign = createHash('md5').update(String(tm) + auth).digest('hex');
  // The official player issues this activity-level guest token before any user login.
  // No account, password, attendee identity or authenticated browser session is used.
  const guest = await getData(`${uc}/login/token?uid=${aid}&sign=${sign}&tm=${tm}&vt=3&pt=1&expiredMinutes=600`, fetchImpl);
  if (!guest?.token) throw new Error('未取得官方匿名活动访问令牌');
  const headers = { Authorization: guest.token };
  const data = await getData(`${api}/api/v2/activity/page/init?aid=${aid}&_=${tm}`, fetchImpl, headers);
  const info = data?.actInfo;
  if (!info || EXCLUDED.test(info.name ?? '')) return null;
  const declaredPlayer = new URL(info.playerPageUrl || pageUrl);
  if (declaredPlayer.hostname !== 'live.zgcforum.com.cn') throw new Error('活动不属于该主办方官方播放域名');
  const menu = data.config?.menuList ?? [];
  if (Number(info.isSecurity) !== 0 || menu.some(entry => Number(entry.menuType) === 13 && Number(entry.onOff) === 1)) {
    notes.push(`${info.name}：活动有口令或额外 token 门槛，未加入。`);
    return null;
  }
  const startsAt = chinaTime(info.startTime), endsAt = chinaTime(info.endTime);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) throw new Error('活动时间格式发生变化');
  if (Date.now() < startsAt) {
    upcoming.push({ title: info.name, startsAt: new Date(startsAt).toISOString(), pageUrl, institution: '中关村论坛', category: '会议论坛' });
    return null;
  }
  if (Date.now() < endsAt) {
    notes.push(`${info.name}：活动尚在日程时段内，未用历史回放地址冒充正在直播。`);
    return null;
  }
  if (!menu.some(entry => Number(entry.menuType) === 6 && Number(entry.onOff) === 1)) {
    notes.push(`${info.name}：官方未开启公开回看。`);
    return null;
  }
  const registration = await getData(`${api}/api/v1/activity/config/single/get?activityId=${aid}&configKey=liveUserRegister&_=${tm}`, fetchImpl, headers);
  if (registration != null) {
    notes.push(`${info.name}：活动存在观众注册配置，未加入。`);
    return null;
  }
  const more = await getData(`${api}/api/v2/activity/page/init4step2?aid=${aid}&configKeys=vodMediaID&_=${tm}`, fetchImpl, headers);
  const media = more?.configMap?.vodMediaID;
  if (!media) return null;
  const url = new URL(media);
  if (url.hostname !== 'vod.cloud.dayang.com.cn' || !/^https?:$/.test(url.protocol)
    || !/\.(?:mp4|m3u8)(?:\?|$)/i.test(url.href)) throw new Error('官方回放媒体域名或格式发生变化');
  // The official player also upgrades this CDN's HTTP URLs to HTTPS.
  url.protocol = 'https:';
  return {
    id: `zgc-${aid}`, provider: provider.id, institution: '中关村论坛', category: '会议论坛',
    title: info.name, kind: 'vod', pageUrl, url: url.href,
    description: '中关村论坛官方会场公开录像／回放；仅使用主办方已启用的公开回看配置，节目以官方存档版本为准。',
  };
}

async function discoverZgc(fetchImpl, limit, notes, upcoming) {
  const list = await getText(ZGC_LIST, fetchImpl);
  const aids = [...new Set([...list.matchAll(/https:\/\/live\.zgcforum\.com\.cn\/activity\/p1\/index\.html\?aid=(\d+)/g)]
    .map(match => match[1]))];
  if (!aids.length) throw new Error('中关村论坛官方回放目录为空');
  const environment = await dayangEnvironment(playerUrl(aids[0]), fetchImpl);
  const items = [], attemptedDetails = [];
  // A listed event may have no public replay. Check the next official entries.
  for (let offset = 0; offset < Math.min(aids.length, 9) && items.length < limit; offset += 3) {
    const results = await Promise.allSettled(aids.slice(offset, offset + 3)
      .map(aid => zgcItem(aid, fetchImpl, { notes, upcoming, environment })));
    attemptedDetails.push(...results);
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) items.push(result.value);
      else if (result.status === 'rejected') notes.push(`中关村论坛：${result.reason.message}`);
    }
  }
  throwIfAllRejected(attemptedDetails);
  return items.slice(0, limit);
}

async function shanghaiItem(pageUrl, fetchImpl) {
  const html = await getText(pageUrl, fetchImpl);
  const title = clean(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]);
  if (!/^上海论坛\d{4}[：:]/.test(title) || EXCLUDED.test(title)) return null;
  const source = html.match(/\bsudy-wp-src=["']([^"']+\.mp4)["']/i)?.[1];
  if (!source) return null;
  const url = new URL(clean(source), pageUrl);
  const path = new URL(pageUrl).pathname.match(/^\/([a-f0-9]{2})\/([a-f0-9]{2})\/(c\d+a\d+)\/page\.htm$/);
  if (!path || url.origin !== new URL(SHANGHAI).origin) throw new Error('上海论坛官方视频路径发生变化');
  return {
    id: `shanghai-${path[1]}-${path[2]}-${path[3]}`, provider: provider.id,
    institution: '上海论坛组委会', category: '会议论坛', title, kind: 'vod', pageUrl, url: url.href,
    description: '上海论坛组委会官网发布的单场嘉宾演讲录像；属于会场发言回放，非整届论坛录像。',
  };
}

async function discoverShanghai(fetchImpl, limit, notes) {
  const listUrl = new URL('19462/list.htm', SHANGHAI).href;
  const html = await getText(listUrl, fetchImpl);
  const pages = [...new Set([...html.matchAll(/href=["'](\/[a-f0-9]{2}\/[a-f0-9]{2}\/c19462a\d+\/page\.htm)["']/gi)]
    .map(match => new URL(match[1], SHANGHAI).href))].slice(0, limit);
  const results = await settleRequests(pages.map(pageUrl => shanghaiItem(pageUrl, fetchImpl)));
  return results.flatMap(result => {
    if (result.status === 'fulfilled') return result.value ? [result.value] : [];
    notes.push(`上海论坛：${result.reason.message}`);
    return [];
  });
}

export async function discover({ fetchImpl = fetch, maxPerInstitution = 3, institution } = {}) {
  const limit = Math.max(1, Math.min(5, Math.floor(Number(maxPerInstitution) || 3)));
  const notes = [], upcoming = [];
  const jobs = [
    { name: '中关村论坛', run: () => discoverZgc(fetchImpl, limit, notes, upcoming) },
    { name: '上海论坛组委会', run: () => discoverShanghai(fetchImpl, limit, notes) },
  ].filter(job => !institution || job.name === institution);
  if (!jobs.length) throw new Error('未知论坛机构');
  const results = await settleRequests(jobs.map(job => job.run()));
  const items = results.flatMap(result => {
    if (result.status === 'fulfilled') return result.value;
    notes.push(result.reason.message);
    return [];
  });
  return { provider: provider.id, items, notes, upcoming };
}

export async function resolve(id, { fetchImpl = fetch, institution } = {}) {
  const owner = id.startsWith('zgc-') ? '中关村论坛' : id.startsWith('shanghai-') ? '上海论坛组委会' : '';
  if (institution && owner !== institution) throw new Error('节目不属于该论坛机构');
  const zgc = id.match(/^zgc-(\d{16})$/);
  const shanghai = id.match(/^shanghai-([a-f0-9]{2})-([a-f0-9]{2})-(c\d+a\d+)$/);
  let item;
  if (zgc) item = await zgcItem(zgc[1], fetchImpl);
  else if (shanghai) item = await shanghaiItem(new URL(`${shanghai[1]}/${shanghai[2]}/${shanghai[3]}/page.htm`, SHANGHAI).href, fetchImpl);
  if (!item) throw new Error(`会议录像当前未提供无门槛公开回看：${id}`);
  return item;
}
