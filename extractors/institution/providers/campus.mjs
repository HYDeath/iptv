import { settleRequests } from './settled.mjs';
/** Public, self-produced campus media. No campus login or third-party IPTV lists. */
export const provider = {
  id: 'campus',
  name: '高校融媒体（西安交大／吉林大学）',
  officialUrl: 'https://zhibo.xjtu.edu.cn/',
};

const JLU = 'https://tv.jlu.edu.cn/';
const XJTU = 'https://zhibo.xjtu.edu.cn/';
const EXCLUDED = /宗教|佛教|基督|天主教|伊斯兰|弘法|法会|讲经|禅修/;

function clean(value = '') {
  return value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

async function getText(url, fetchImpl) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`HTTP ${response.status}`);
        error.noRetry = response.status < 500;
        throw error;
      }
      return await response.text();
    } catch (error) {
      last = error;
      if (error.noRetry) break;
    }
  }
  throw new Error(`高校页面读取失败 ${url}：${last.cause?.code || last.message}`);
}

function sourceUrl(html, base) {
  const value = html.match(/\bvar\s+streamurl\s*=\s*["']([^"']+)["']/i)?.[1]
    ?? html.match(/<source\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1];
  if (!value) return null;
  const url = new URL(clean(value), base);
  return /^https?:$/.test(url.protocol) && /\.edu\.cn$/i.test(url.hostname)
    && /\.(?:m3u8|mp4)(?:$|\?)/i.test(url.href) ? url.href : null;
}

async function jluItem(pageUrl, fetchImpl, notes) {
  const html = await getText(pageUrl, fetchImpl);
  const title = clean(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1])
    .replace(/-吉林大学电视台$/, '');
  if (!title || EXCLUDED.test(title)) return null;
  let url = sourceUrl(html, pageUrl);
  if (!url) return null;
  let transportNote = '';
  // The official media host also serves HTTP. Never disable TLS verification.
  // Use that same-host endpoint only after independently checking its HEAD.
  const parsed = new URL(url);
  if (parsed.hostname === 'tvcc.jlu.edu.cn' && parsed.protocol === 'https:') {
    try {
      const response = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      // Only the observed expired certificate permits the independently tested
      // same-host HTTP transport. HTTP/rights errors and other failures stop.
      if ((error.cause?.code ?? error.code) !== 'CERT_HAS_EXPIRED') throw error;
      parsed.protocol = 'http:';
      const response = await fetchImpl(parsed.href, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
      if (!response.ok || !/video\/mp4/i.test(response.headers.get('content-type') ?? '')) {
        throw new Error(`吉林大学官方媒体 HTTPS 失败，HTTP 也未验证：${error.message}`);
      }
      url = parsed.href;
      transportNote = '官方媒体站 HTTPS 校验失败，使用已核验的同站 HTTP MP4。';
      if (!notes.includes(transportNote)) notes.push(transportNote);
    }
  }
  return {
    id: `jlu-${pageUrl.match(/\/(\d+)\.htm/)?.[1]}`,
    provider: provider.id, institution: '吉林大学电视台', title, kind: 'vod', pageUrl, url,
    description: '吉林大学电视台官方活动录像／回放。',
  };
}

async function jluEntries(fetchImpl, notes = []) {
  const results = await settleRequests([
    getText(new URL('LIVEjd.htm', JLU).href, fetchImpl),
    getText(new URL('hdsk.htm', JLU).href, fetchImpl),
  ]);
  const lists = results.flatMap(result => {
    if (result.status === 'fulfilled') return [result.value];
    notes.push(result.reason.message);
    return [];
  });
  const entries = lists.flatMap(html => [...html.matchAll(
    /<A\s+class="fl"\s+href="([^"]+)">\s*<P>\s*<SPAN\s+class="tit">([^<]+)/gi,
  )].map(match => ({ pageUrl: new URL(match[1], JLU).href, title: clean(match[2]) })));
  return [...new Map(entries.filter(item => item.pageUrl.startsWith(`${JLU}info/`)
    && !EXCLUDED.test(item.title)).map(item => [item.pageUrl, item])).values()];
}

async function discoverJlu(fetchImpl, maxVodPerInstitution, notes) {
  const eligible = await jluEntries(fetchImpl, notes);
  // Include one cultural performance when the current first page contains one.
  const performance = eligible.find(item => /音乐会|晚会|交响/.test(item.title));
  const selected = [...new Map([eligible[0], performance, ...eligible].filter(Boolean)
    .map(item => [item.pageUrl, item])).values()].slice(0, maxVodPerInstitution);
  const results = await settleRequests(selected.map(item => jluItem(item.pageUrl, fetchImpl, notes)));
  notes.push('吉林大学 LIVE 栏是活动及录像入口；本次仅输出官网明确提供的录像，不视为常驻直播频道。');
  return results.flatMap(result => {
    if (result.status === 'fulfilled') return result.value ? [result.value] : [];
    notes.push(`吉林大学：${result.reason.message}`);
    return [];
  });
}

function xjtuLiveEntries(html) {
  return [...html.matchAll(/<a\s+href="(\/live-show-detail\/\d+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(match => ({
      pageUrl: new URL(match[1], XJTU).href,
      title: clean(match[2].match(/class="notice-title[^\"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]),
      state: /已结束/.test(match[2]) ? 'ended'
        : /未开始|即将开始/.test(match[2]) ? 'upcoming'
          : /正在直播|直播中/.test(match[2]) ? 'active' : 'unknown',
    }));
}

async function xjtuItem(pageUrl, kind, fetchImpl) {
  const html = await getText(pageUrl, fetchImpl);
  if (/请登录后重试/.test(html)) return null;
  const url = sourceUrl(html, pageUrl);
  if (!url) return null;
  const title = clean(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1])
    .replace(/\s*-\s*西安交通大学思源直播平台$/, '');
  if (!title || EXCLUDED.test(title)) return null;
  const manifest = await getText(url, fetchImpl);
  if (!manifest.trimStart().startsWith('#EXTM3U')) throw new Error('西安交大播放地址未返回 HLS');
  if (kind === 'live' && /#EXT-X-ENDLIST/.test(manifest)) kind = 'vod';
  return {
    id: `xjtu-${kind}-${pageUrl.match(/\/(\d+)$/)?.[1]}`,
    provider: provider.id, institution: '西安交通大学思源直播', title, kind, pageUrl, url,
    description: kind === 'vod' ? '西安交通大学思源直播平台官方公开视频回放。'
      : '西安交通大学思源直播平台标记为正在直播；播放时重新解析官网。',
  };
}

async function discoverXjtu(fetchImpl, maxVodPerInstitution, includeVod, notes) {
  const [liveHtml, homeHtml] = await Promise.all([
    getText(new URL('live-show', XJTU).href, fetchImpl),
    includeVod ? getText(XJTU, fetchImpl) : Promise.resolve(''),
  ]);
  const liveEntries = xjtuLiveEntries(liveHtml);
  const active = liveEntries.filter(item => item.state === 'active' && !EXCLUDED.test(item.title));
  notes.push(`西安交大直播列表首屏 ${liveEntries.length} 场，其中正在直播 ${active.length} 场；已结束／预告不加入直播输出。`);
  const vodPages = [...new Set([...homeHtml.matchAll(/href="(\/vod-show-detail\/\d+)"/gi)]
    .map(match => new URL(match[1], XJTU).href))].slice(0, maxVodPerInstitution);
  const results = await settleRequests([
    ...active.map(item => xjtuItem(item.pageUrl, 'live', fetchImpl)),
    ...vodPages.map(pageUrl => xjtuItem(pageUrl, 'vod', fetchImpl)),
  ]);
  return results.flatMap(result => {
    if (result.status === 'fulfilled') return result.value ? [result.value] : [];
    notes.push(`西安交大：${result.reason.message}`);
    return [];
  });
}

export async function discover({ fetchImpl = fetch, includeVod = true, maxVodPerInstitution = 3, institution } = {}) {
  if (institution && !['西安交通大学思源直播', '吉林大学电视台'].includes(institution)) throw new Error('未知高校机构');
  const notes = [];
  const tasks = [];
  if (!institution || institution === '西安交通大学思源直播') tasks.push(discoverXjtu(fetchImpl, maxVodPerInstitution, includeVod, notes));
  if (includeVod && (!institution || institution === '吉林大学电视台')) tasks.push(discoverJlu(fetchImpl, maxVodPerInstitution, notes));
  const results = await settleRequests(tasks);
  const items = results.flatMap(result => {
    if (result.status === 'fulfilled') return result.value;
    notes.push(result.reason.message);
    return [];
  });
  return { provider: provider.id, items, notes };
}

export async function resolve(itemId, options = {}) {
  const owner = itemId.startsWith('xjtu-') ? '西安交通大学思源直播' : itemId.startsWith('jlu-') ? '吉林大学电视台' : '';
  if (options.institution && owner !== options.institution) throw new Error('节目不属于该高校机构');
  const fetchImpl = options.fetchImpl ?? fetch;
  let item;
  const xjtuVod = itemId.match(/^xjtu-vod-(\d+)$/);
  const xjtuLive = itemId.match(/^xjtu-live-(\d+)$/);
  const jlu = itemId.match(/^jlu-(\d+)$/);
  if (xjtuVod) {
    // A public detail page remains resolvable after moving off the homepage.
    // xjtuItem still observes the site's login gate and checks its HLS response.
    item = await xjtuItem(new URL(`vod-show-detail/${xjtuVod[1]}`, XJTU).href, 'vod', fetchImpl);
  } else if (xjtuLive) {
    const html = await getText(new URL('live-show', XJTU).href, fetchImpl);
    const entry = xjtuLiveEntries(html).find(candidate => candidate.state === 'active'
      && candidate.pageUrl.endsWith(`/live-show-detail/${xjtuLive[1]}`)
      && !EXCLUDED.test(candidate.title));
    if (entry) item = await xjtuItem(entry.pageUrl, 'live', fetchImpl);
    if (item?.kind !== 'live') item = null;
  } else if (jlu) {
    const entry = (await jluEntries(fetchImpl)).find(candidate =>
      candidate.pageUrl.endsWith(`/${jlu[1]}.htm`));
    if (entry) item = await jluItem(entry.pageUrl, fetchImpl, []);
  }
  if (!item) throw new Error(`高校媒体项目当前不可公开解析：${itemId}`);
  return item;
}
