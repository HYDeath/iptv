import { settleRequests } from './settled.mjs';
export const provider = {
  id: 'museum',
  name: '国家博物馆 · 国博云播',
  officialUrl: 'https://www.chnmuseum.cn/sp/gbjt_150/',
};

const unescapeHtml = (text) => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const excluded = /佛教|佛法|寺院|寺庙|基督|教会|弥撒|礼拜|伊斯兰|清真|道教|宗教/;

async function read(fetchImpl, url) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`National Museum page returned HTTP ${response.status}`);
  return response.text();
}

export function parseCatalogue(html) {
  const seen = new Set();
  return [...html.matchAll(/<a\b[^>]*\bhref=["']([^"']+\.shtml)["'][^>]*\btitle=["']([^"']+)["']/gi)]
    .map((match) => ({ pageUrl: new URL(unescapeHtml(match[1]), provider.officialUrl).href, title: unescapeHtml(match[2]) }))
    .filter((item) => {
      if (!item.title.includes('国博讲堂') || excluded.test(item.title) || seen.has(item.pageUrl)) return false;
      const page = new URL(item.pageUrl);
      if (page.hostname !== 'www.chnmuseum.cn' || !page.pathname.startsWith('/sp/gbjt_150/')) return false;
      seen.add(item.pageUrl);
      return true;
    })
    .slice(0, 4);
}

export function parseDetail(html, candidate) {
  const player = html.match(/<video\b[^>]*>[\s\S]*?<\/video>/i)?.[0];
  if (!player) return null;
  const source = player.match(/<(?:source|video)\b[^>]*\bsrc=["']([^"']+\.mp4(?:\?[^"']*)?)["']/i)?.[1];
  if (!source) return null;
  const url = new URL(unescapeHtml(source), candidate.pageUrl);
  if (url.hostname !== 'www.chnmuseum.cn' || !url.pathname.startsWith('/masvod/public/')) return null;
  // The official detail page performs this same HTTP -> HTTPS replacement in
  // its video player. HTTPS was range-tested successfully, with normal TLS.
  url.protocol = 'https:';
  const articleTitle = html.match(/<meta\b[^>]*\bname=["']ArticleTitle["'][^>]*\bcontent=["']([^"']*)["']/i)?.[1];
  const title = unescapeHtml(articleTitle || candidate.title).trim();
  if (excluded.test(title)) return null;
  return {
    id: `museum-${new URL(candidate.pageUrl).pathname.split('/').at(-1).replace(/\.shtml$/, '')}`,
    provider: provider.id,
    title,
    kind: 'vod',
    pageUrl: candidate.pageUrl,
    url: url.href,
    headers: { Referer: candidate.pageUrl },
    description: '国家博物馆讲堂回放，公开点播。',
  };
}

export async function discover({ fetchImpl = fetch } = {}) {
  const html = await read(fetchImpl, provider.officialUrl);
  const notes = ['仅扫描“国博云播”栏目当前首页的前四条国博讲堂；预告不作为在播频道。'];
  const results = await settleRequests(parseCatalogue(html).map(async (candidate) => parseDetail(await read(fetchImpl, candidate.pageUrl), candidate)));
  const items = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) items.push(result.value);
    else if (result.status === 'rejected') notes.push(result.reason.message);
  }
  return { provider: provider.id, items, notes };
}

export async function resolve(itemId, options = {}) {
  const result = await discover(options);
  const item = result.items.find((entry) => entry.id === itemId);
  if (!item) throw new Error('The requested National Museum lecture is no longer in the current catalogue.');
  return item;
}
