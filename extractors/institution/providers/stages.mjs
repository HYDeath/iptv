import { settleRequests } from './settled.mjs';
export const provider = {
  id: 'stages',
  name: '国际音乐厅公开演出',
  officialUrl: 'https://www.elbphilharmonie.de/en/mediatheque',
};

const venueOrigin = 'https://www.elbphilharmonie.de';
const excluded = /宗教|佛教|基督|天主教|道教|伊斯兰|弘法|法会|讲经|禅修|\b(?:religious|worship|gospel|church|requiem|messe|psalms?)\b/i;
const knownPages = new Map([
  ['elb-1234', `${venueOrigin}/en/mediatheque/frank-peter-zimmermann-ndr-elbphilharmonie-orchester/1234`],
  ['elb-1229', `${venueOrigin}/en/mediatheque/alan-gilbert-and-ndr-elbphilharmonie-orchestra/1229`],
]);
const decode = value => String(value || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const clean = value => decode(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

function requestFailure(stage, url, cause) {
  const codes = new Set(), seen = new Set();
  function inspect(error, depth = 0) {
    if (!error || depth > 5 || seen.has(error)) return;
    seen.add(error);
    if (typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) codes.add(error.code);
    if (error.name === 'TimeoutError') codes.add('REQUEST_TIMEOUT');
    if (error.name === 'AbortError') codes.add('REQUEST_ABORTED');
    inspect(error.cause, depth + 1);
    for (const nested of (Array.isArray(error.errors) ? error.errors : []).slice(0, 5)) inspect(nested, depth + 1);
  }
  inspect(cause);
  const host = new URL(url).hostname;
  return new Error(`${stage}请求失败（${host}${codes.size ? `；${[...codes].slice(0, 3).join(' / ')}` : '；网络连接未完成'}）`, { cause });
}

async function read(url, fetchImpl, stage) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  } catch (error) { throw requestFailure(stage, url, error); }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch {}
    throw new Error(`${stage}（${new URL(url).hostname}）HTTP ${response.status}`);
  }
  try { return await response.text(); }
  catch (error) { throw requestFailure(stage, url, error); }
}

export function parseCatalogue(html) {
  const entries = [], seen = new Set();
  for (const block of html.split(/<div\b(?=[^>]*class="[^"]*\bblog__item\b)/i)) {
    if (!block.includes('blog__item--on-demand')) continue;
    const playerUrl = decode(block.match(/data-url="(https:\/\/www\.ndr\.de\/[^"<>]+~ardplayer\.html)"/)?.[1]);
    const path = block.match(/href="(\/en\/mediatheque\/[^"<>]+\/\d+)"/)?.[1];
    const title = clean(block.match(/<span class="inner-title">([\s\S]*?)<\/span>/)?.[1]);
    if (!playerUrl || !path || !title || excluded.test(title) || seen.has(path)) continue;
    seen.add(path);
    const id = `elb-${path.split('/').at(-1)}`;
    const pageUrl = new URL(path, venueOrigin).href;
    entries.push({ id, title, pageUrl, playerUrl });
    knownPages.set(id, pageUrl);
    if (entries.length === 2) break;
  }
  return entries;
}

export function parseNdrPlayer(html) {
  const encoded = html.match(/data-config="([^"]+)"/)?.[1];
  if (!encoded) return null;
  const config = JSON.parse(decode(encoded));
  const meta = config.mc?.meta;
  const duration = Number(meta?.durationSeconds);
  if (meta?.publicationService?.partner !== 'ard' || !Number.isFinite(duration) || duration < 1800 || meta.isGeoblocked || meta.geoBlocked) return null;
  if (excluded.test(`${meta.title || ''} ${meta.synopsis || ''}`)) return null;
  const copies = (config.mc.streams || []).filter(stream => stream.kind === 'main' && !stream.isAudioOnly)
    .flatMap(stream => stream.media || [])
    .filter(copy => copy.mimeType === 'video/mp4' && !copy.drm && !copy.licenseUrl && !/\.hevc\.mp4(?:\?|$)/i.test(copy.url || ''))
    .sort((a, b) => Number(b.maxHResolutionPx || 0) - Number(a.maxHResolutionPx || 0));
  for (const copy of copies) {
    const url = new URL(copy.url);
    if (url.protocol !== 'https:' || url.hostname !== 'ndr-progressive.ard-mcdn.de' || !url.pathname.endsWith('.mp4')) continue;
    return { url: url.href, duration, title: clean(meta.title), description: clean(meta.synopsis) };
  }
  return null;
}

async function resolveElbPage(id, pageUrl, fetchImpl) {
  const page = new URL(pageUrl);
  if (page.origin !== venueOrigin || !/^\/en\/mediatheque\/[^/]+\/\d+$/.test(page.pathname)) throw new Error('无效音乐厅演出详情');
  const html = await read(page.href, fetchImpl, '易北爱乐演出详情');
  const title = clean(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1]);
  const playerUrl = decode(html.match(/data-url="(https:\/\/www\.ndr\.de\/[^"<>]+~ardplayer\.html)"/)?.[1]);
  if (!title || !playerUrl || excluded.test(title)) throw new Error('音乐厅官网当前未公开此演出的授权长视频。');
  const media = parseNdrPlayer(await read(playerUrl, fetchImpl, 'NDR/ARD 播放器'));
  if (!media) throw new Error('NDR/ARD 官方播放器当前没有开放的非宗教长演出。');
  let response;
  try {
    response = await fetchImpl(media.url, { headers: { Referer: playerUrl, Range: 'bytes=0-0' }, signal: AbortSignal.timeout(15_000) });
  } catch (error) { throw requestFailure('NDR/ARD 演出媒体', media.url, error); }
  await response.body?.cancel();
  if (!response.ok || !/^video\/mp4/i.test(response.headers.get('content-type') || '')) throw new Error(`官方演出媒体当前不可访问（HTTP ${response.status}），不尝试绕过地区或访问限制。`);
  return {
    id, provider: provider.id, institution: '易北爱乐音乐厅 · Elbphilharmonie', category: '演出',
    title, kind: 'vod', pageUrl: page.href, url: media.url, duration: media.duration,
    headers: { Referer: playerUrl },
    description: `音乐厅官网指定的 NDR/ARD 公开长篇音乐会录像。${media.description}`,
  };
}

export async function discover({ fetchImpl = fetch } = {}) {
  const notes = [
    '易北爱乐官网现有两场点播明确链接到 NDR/ARD 原生播放器，取当前公开的 H.264 MP4，并正常检查媒体可访问状态。',
    'Bergen Phil Live 正确域名为 bergenphilive.no；官网免费档案可读，但本机两场 Vimeo 播放器返回 401、配置返回 403，本轮未接入。',
    'Kennedy Center 本机入口 HTTP 403；Lincoln Center 当前官网回看导向 YouTube，均未绕过访问限制或引入 yt-dlp。',
  ];
  const entries = parseCatalogue(await read(provider.officialUrl, fetchImpl, '易北爱乐目录'));
  const results = await settleRequests(entries.map(entry => resolveElbPage(entry.id, entry.pageUrl, fetchImpl)));
  const items = results.flatMap(result => {
    if (result.status === 'fulfilled') return [result.value];
    notes.push(result.reason.message);
    return [];
  });
  return { provider: provider.id, items, notes };
}

export async function resolve(id, { fetchImpl = fetch } = {}) {
  if (!/^elb-\d+$/.test(id)) throw new Error('无效音乐厅演出 ID');
  if (!knownPages.has(id)) parseCatalogue(await read(provider.officialUrl, fetchImpl, '易北爱乐目录'));
  const pageUrl = knownPages.get(id);
  if (!pageUrl) throw new Error('音乐厅当前公开目录中没有此演出。');
  return resolveElbPage(id, pageUrl, fetchImpl);
}
