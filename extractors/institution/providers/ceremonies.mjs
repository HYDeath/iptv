import { settleRequests } from './settled.mjs';
export const provider = {
  id: 'ceremonies',
  name: '官方颁奖礼与盛典',
  officialUrl: 'https://www.stvf.com/list?cid=101241203064743633521357224677381478',
};

const sources = [
  { id: 'stvf', institution: '上海电视节 · 白玉兰奖', home: 'https://www.stvf.com/', list: provider.officialUrl, mediaHost: 'obs.stvf.com' },
  { id: 'siff', institution: '上海国际电影节 · 金爵奖', home: 'https://www.siff.com/', list: 'https://www.siff.com/list?cid=import-319', mediaHost: 'obs.siff.com' },
];
const excluded = /宗教|佛教|基督|天主教|道教|伊斯兰|弘法|法会|讲经|禅修/;
const fullCeremony = /颁奖典礼.*(?:全程回顾|全程回放|完整版)/;
const clean = text => String(text || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function read(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`颁奖礼主办方官网 HTTP ${response.status}`);
  return response.text();
}

export function parseCatalogue(html, sourceId) {
  const source = sources.find(s => s.id === sourceId);
  if (!source) return [];
  const seen = new Set();
  const entries = [];
  for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"']*content\?aid=\d+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = clean(match[2]);
    if (!fullCeremony.test(title) || excluded.test(title)) continue;
    const page = new URL(match[1], source.home);
    if (page.origin !== new URL(source.home).origin || page.pathname !== '/content') continue;
    const aid = page.searchParams.get('aid');
    if (!/^\d+$/.test(aid || '') || seen.has(aid)) continue;
    seen.add(aid);
    entries.push({ aid, title, pageUrl: page.href });
    if (entries.length === 3) break;
  }
  return entries;
}

export function parseDetail(html, sourceId, pageUrl) {
  const source = sources.find(s => s.id === sourceId);
  if (!source) return null;
  const page = new URL(pageUrl);
  const aid = page.searchParams.get('aid');
  if (page.origin !== new URL(source.home).origin || page.pathname !== '/content' || !/^\d+$/.test(aid || '')) return null;
  const title = clean(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
  if (!fullCeremony.test(title) || excluded.test(title)) return null;
  const block = html.match(/<video\b[\s\S]*?<\/video>/i)?.[0];
  const src = block?.match(/\bsrc=["']([^"']+)["']/i)?.[1];
  if (!src) return null;
  const url = new URL(src.replace(/&amp;/g, '&'), pageUrl);
  if (url.protocol !== 'https:' || url.hostname !== source.mediaHost || !/\.(mp4|m3u8)$/i.test(url.pathname)) return null;
  return {
    id: `${source.id}-${aid}`, provider: provider.id, institution: source.institution, category: '典礼盛典',
    title, kind: 'vod', pageUrl, url: url.href, headers: { Referer: pageUrl },
    description: '主办方官网原生播放器公开的颁奖典礼全程回顾，按点播提供。',
  };
}

async function discoverSource(source, fetchImpl, notes) {
  const entries = parseCatalogue(await read(source.list, fetchImpl), source.id);
  const results = await settleRequests(entries.map(async entry => {
    const item = parseDetail(await read(entry.pageUrl, fetchImpl), source.id, entry.pageUrl);
    if (!item) throw new Error(`${entry.title}：未找到主办方公开的完整典礼播放器。`);
    return item;
  }));
  return results.flatMap(result => {
    if (result.status === 'fulfilled') return [result.value];
    notes.push(result.reason.message);
    return [];
  });
}

export async function discover({ fetchImpl = fetch, institution } = {}) {
  const notes = [
    `仅取${institution || '上海电视节、上海国际电影节'}官网颁奖典礼栏目当前前三条“全程回顾”，不使用新闻短片或搬运视频。`,
    '仅收录已结束典礼的公开点播；没有将历史典礼标为当前直播。',
  ];
  const selected = sources.filter(source => !institution || source.institution === institution);
  if (!selected.length) throw new Error('未知典礼主办机构');
  const results = await settleRequests(selected.map(source => discoverSource(source, fetchImpl, notes)));
  const items = results.flatMap(result => {
    if (result.status === 'fulfilled') return result.value;
    notes.push(result.reason.message);
    return [];
  });
  return { provider: provider.id, items, notes };
}

export async function resolve(id, { fetchImpl = fetch, institution } = {}) {
  const match = id.match(/^(stvf|siff)-(\d+)$/);
  const source = match && sources.find(s => s.id === match[1]);
  if (!source) throw new Error('无效颁奖礼 ID');
  if (institution && source.institution !== institution) throw new Error('典礼不属于该主办机构');
  const pageUrl = `${source.home}content?aid=${match[2]}`;
  const item = parseDetail(await read(pageUrl, fetchImpl), source.id, pageUrl);
  if (!item) throw new Error('主办方当前未提供该典礼的公开完整播放地址。');
  return item;
}
