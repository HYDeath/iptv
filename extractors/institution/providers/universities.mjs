import { settleRequests } from './settled.mjs';
/** Anonymous, self-produced university video from the institutions' own pages. */
export const provider = {
  id: 'universities',
  name: '高校影像（复旦／北师大／华科大）',
  officialUrl: 'https://news.fudan.edu.cn/xysh/list.htm',
};

const FUDAN = 'https://news.fudan.edu.cn/';
const BNU = 'https://video.bnu.edu.cn/';
const HUST = 'https://www.hust.edu.cn/';
const EXCLUDED = /宗教|佛教|基督|天主教|道教|伊斯兰|弘法|法会|讲经|禅修/;

function clean(value = '') {
  return value.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/\s+/g, ' ').trim();
}

async function getText(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
}

function anchors(html, base) {
  return [...html.matchAll(/<a\b([^>]*?)>([\s\S]*?)<\/a>/gi)].flatMap(match => {
    const href = match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) return [];
    try { return [{ pageUrl: new URL(clean(href), base).href, title: clean(match[2]), attributes: clean(match[1]) }]; }
    catch { return []; }
  });
}

function unique(entries) {
  return [...new Map(entries.filter(entry => entry.title && !EXCLUDED.test(entry.title))
    .map(entry => [entry.pageUrl, entry])).values()];
}

function mediaFromDetail(html, pageUrl, hosts) {
  const media = [...html.matchAll(/\b(?:sudy-wp-src|src)\s*=\s*["']([^"']+\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/gi)];
  for (const match of media) {
    const url = new URL(clean(match[1]), pageUrl);
    if (url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password) return url.href;
  }
  return null;
}

async function detailItem(institution, pageUrl, fetchImpl) {
  const html = await getText(pageUrl, fetchImpl);
  const title = clean(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1])
    .replace(/-北京师范大学视频空间$/, '').replace(/\s*[-|]\s*复旦大学.*$/, '');
  if (!title || EXCLUDED.test(title)) return null;
  const hosts = institution === '复旦大学' ? ['news.fudan.edu.cn']
    : ['video.bnu.edu.cn', 'rmt.bnu.edu.cn', 'fmediaobs.bnu.edu.cn'];
  const url = mediaFromDetail(html, pageUrl, hosts);
  if (!url) return null;
  let id, description;
  if (institution === '复旦大学') {
    const match = new URL(pageUrl).pathname.match(/^\/(\d{4})\/(\d{4})\/(c\d+a\d+)\/page\.htm$/);
    if (!match) return null;
    id = `fudan-${match[1]}-${match[2]}-${match[3]}`;
    description = '复旦大学融媒体中心新闻文化网官方校园影像／原创毕业短片回放。';
  } else {
    const match = new URL(pageUrl).pathname.match(/^\/([a-z]+)\/([a-f0-9]{32})\.htm$/);
    if (!match) return null;
    id = `bnu-${match[1]}-${match[2]}`;
    description = /歌会|音乐会|晚会/.test(title)
      ? '北京师范大学视频空间官方校内文艺演出录像；按原节目分段提供，属于历史回放。'
      : '北京师范大学视频空间官方校园专题节目／影像回放。';
  }
  return { id, provider: provider.id, institution, title, kind: 'vod', pageUrl, url, description };
}

async function settleDetails(institution, entries, fetchImpl, notes) {
  const results = await settleRequests(entries.map(entry => detailItem(institution, entry.pageUrl, fetchImpl)));
  return results.flatMap((result, index) => {
    if (result.status === 'fulfilled' && result.value) return [result.value];
    const error = result.status === 'rejected' ? result.reason.message : '详情未提供允许的公开媒体地址';
    notes.push(`${institution}：${entries[index].pageUrl}，${error}`);
    return [];
  });
}

async function discoverFudan(fetchImpl, limit, notes) {
  const listUrl = new URL('xysh/list.htm', FUDAN).href;
  const html = await getText(listUrl, fetchImpl);
  const entries = unique(anchors(html, listUrl).filter(entry => entry.pageUrl.startsWith(FUDAN)
    && /^\/\d{4}\/\d{4}\/c\d+a\d+\/page\.htm$/.test(new URL(entry.pageUrl).pathname)));
  return settleDetails('复旦大学', entries.slice(0, limit), fetchImpl, notes);
}

async function discoverBnu(fetchImpl, limit, notes) {
  const concertList = new URL('bnsd/', BNU).href;
  const [homeResult, performanceResult] = await settleRequests([
    getText(BNU, fetchImpl), getText(concertList, fetchImpl),
  ]);
  if (homeResult.status === 'rejected') throw homeResult.reason;
  const home = homeResult.value;
  const performances = performanceResult.status === 'fulfilled' ? performanceResult.value : '';
  if (performanceResult.status === 'rejected') notes.push(`北京师范大学演出栏目：${performanceResult.reason.message}`);
  const eligible = (html, base) => unique(anchors(html, base).filter(entry => entry.pageUrl.startsWith(BNU)
    && /^\/[a-z]+\/[a-f0-9]{32}\.htm$/.test(new URL(entry.pageUrl).pathname)));
  const homeEntries = eligible(home, BNU);
  const performance = eligible(performances, concertList).find(entry => /歌会|音乐会|晚会/.test(entry.title));
  const entries = performance ? unique([...homeEntries.slice(0, Math.max(0, limit - 1)), performance])
    : homeEntries.slice(0, limit);
  return settleDetails('北京师范大学', entries, fetchImpl, notes);
}

async function hustItems(fetchImpl) {
  const html = await getText(HUST, fetchImpl);
  return unique(anchors(html, HUST).filter(entry => new URL(entry.pageUrl).origin === new URL(HUST).origin
    && /\.mp4(?:\?|$)/i.test(entry.pageUrl))).flatMap(entry => {
    // Homepage video cards have persistent CMS image IDs, independent of order or filename.
    const cmsId = entry.attributes.match(/wbimage["']\s*,\s*\d+\s*,\s*(\d+)/)?.[1];
    if (!cmsId) return [];
    return [{
      id: `hust-${cmsId}`, provider: provider.id, institution: '华中科技大学',
      title: entry.title, kind: 'vod', pageUrl: HUST, url: entry.pageUrl,
      description: '华中科技大学官网“华科大·影像”校园宣传与人物专题短片。',
    }];
  });
}

export async function discover({ fetchImpl = fetch, maxPerInstitution = 3, institution } = {}) {
  const limit = Math.max(1, Math.min(5, Math.floor(Number(maxPerInstitution) || 3)));
  const notes = ['本模块仅提供官网公开影像与历史回放，不把短片、已结束活动或校园 IPTV 转播列为正在直播。'];
  const jobs = [
    { name: '复旦大学', run: () => discoverFudan(fetchImpl, limit, notes) },
    { name: '北京师范大学', run: () => discoverBnu(fetchImpl, limit, notes) },
    { name: '华中科技大学', run: () => hustItems(fetchImpl).then(items => items.slice(0, limit)) },
  ].filter(job => !institution || job.name === institution);
  if (!jobs.length) throw new Error('未知高校机构');
  const results = await settleRequests(jobs.map(job => job.run()));
  const institutions = jobs.map(job => job.name);
  const items = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    notes.push(`${institutions[index]}：${result.reason.message}`);
    return [];
  });
  return { provider: provider.id, items, notes };
}

export async function resolve(id, { fetchImpl = fetch, institution } = {}) {
  const owner = id.startsWith('fudan-') ? '复旦大学' : id.startsWith('bnu-') ? '北京师范大学' : id.startsWith('hust-') ? '华中科技大学' : '';
  if (institution && owner !== institution) throw new Error('节目不属于该高校机构');
  let item;
  const fudan = id.match(/^fudan-(\d{4})-(\d{4})-(c\d+a\d+)$/);
  const bnu = id.match(/^bnu-([a-z]+)-([a-f0-9]{32})$/);
  if (fudan) item = await detailItem('复旦大学', new URL(`${fudan[1]}/${fudan[2]}/${fudan[3]}/page.htm`, FUDAN).href, fetchImpl);
  else if (bnu) item = await detailItem('北京师范大学', new URL(`${bnu[1]}/${bnu[2]}.htm`, BNU).href, fetchImpl);
  else if (/^hust-\d+$/.test(id)) item = (await hustItems(fetchImpl)).find(candidate => candidate.id === id);
  if (!item) throw new Error(`高校影像当前不可公开解析：${id}`);
  return item;
}
