import { fetchWithTimeout } from '../../net.js';
export const id = 'movie1905';
export const name = '1905电影活动';

const ORIGIN = 'https://www.1905.com';
const INDEX = `${ORIGIN}/special/`;
const USER_AGENT = 'Mozilla/5.0';
const REQUEST_HEADERS = { 'User-Agent': USER_AGENT, Referer: `${ORIGIN}/` };
const FALLBACK_PAGES = [
  `${ORIGIN}/special/filmfest/hdysj2026/`,
  `${ORIGIN}/special/filmfest/2026yrdfilm/`,
  `${ORIGIN}/special/filmfest/zhanfang20260922/`,
  `${ORIGIN}/special/filmfest/2026dwq/`,
  `${ORIGIN}/special/filmfest/2026sunislandfw/`,
];

function decode(value = '') {
  return value.replace(/&(?:amp|quot|apos|lt|gt|ldquo|rdquo|lsquo|rsquo|nbsp);|&#(?:x[\da-f]+|\d+);/gi, entity => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&ldquo;': '“', '&rdquo;': '”', '&lsquo;': '‘', '&rsquo;': '’', '&nbsp;': ' ' };
    if (named[entity.toLowerCase()] !== undefined) return named[entity.toLowerCase()];
    const number = entity.slice(2, -1);
    const point = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  }).trim();
}

function textOnly(value = '') {
  return decode(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

function officialPage(page) {
  const url = new URL(page);
  if (url.origin !== ORIGIN || !/^\/special\/filmfest\/[\w-]+\/$/.test(url.pathname) || url.search || url.hash) {
    throw new Error('1905活动页必须是官方电影节专题地址');
  }
  return url.href;
}

function mediaUrl(input) {
  const url = new URL(decode(input));
  if (url.protocol !== 'https:' || !/(?:^|\.)(?:1905\.com|m1905\.com|m1905\.cn)$/.test(url.hostname)) {
    throw new Error('1905接口返回了不在官方媒体域范围内的地址');
  }
  return url.href;
}

async function getText(url, referer = `${ORIGIN}/`, { fetchImpl = fetchWithTimeout } = {}) {
  const response = await fetchImpl(url, {
    headers: { ...REQUEST_HEADERS, Referer: referer },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`1905请求失败：HTTP ${response.status}`);
  if (response.url && new URL(response.url).hostname !== new URL(url).hostname) {
    mediaUrl(response.url);
  }
  return response.text();
}

function parsePage(html, page) {
  const object = html.match(/\bvar\s+liveObj\s*=\s*\{([\s\S]*?)\}\s*;/)?.[1];
  if (!object) return null; // The other template is a short-video/VIP VOD carousel, not a complete public live replay.
  const cid = object.match(/\bcid\s*:\s*(\d+)/)?.[1];
  const config = object.match(/\bconfigUrl\s*:\s*['"]([^'"]+)['"]/)?.[1]?.trim();
  const liveValue = object.match(/\blive\s*:\s*(true|false)/)?.[1];
  if (!cid || !config || liveValue === undefined) return null;
  const configUrl = new URL(config, page);
  if (configUrl.origin !== ORIGIN || !new RegExp(`^/api/live/special_${cid}_\\d+(?:_lb)?\\.xml$`).test(configUrl.pathname) || configUrl.search) {
    throw new Error('1905专题播放配置不符合官方活动接口格式');
  }
  const title = textOnly(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/_电影网_1905\.com$/, '');
  const description = textOnly(html.match(/<meta\s+content="([^"]*)"\s+name="description"/i)?.[1] || '');
  return { cid, configUrl: configUrl.href, kind: liveValue === 'true' ? 'live' : 'replay', title, description };
}

async function playlistInfo(configUrl, page, options) {
  const xml = await getText(configUrl, page, options);
  const playlist = xml.match(/<playlist\b([^>]*)>([\s\S]*?)<\/playlist>/i);
  if (!playlist) throw new Error('1905官方活动接口没有播放列表');
  // Only use content explicitly exposed as public by this official player configuration.
  if (!/\bisvip\s*=\s*["']0["']/.test(playlist[1])) {
    throw new Error('1905活动要求会员或未明确提供匿名免费完整播放');
  }
  const candidates = [...playlist[2].matchAll(/<item\b[^>]*\b(?:hdurl|url)\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(match => decode(match[1]));
  const url = candidates.find(value => /\.m3u8(?:[?#]|$)/i.test(value));
  if (!url) throw new Error('1905官方活动没有可用的公开HLS地址');
  return { url: mediaUrl(url), title: decode(playlist[1].match(/\btitle\s*=\s*"([^"]*)"/)?.[1] || '') };
}

export async function discover({ limit = 8, ...options } = {}) {
  const notes = [];
  let pages = [];
  try {
    const html = await getText(INDEX, undefined, options);
    pages = [...new Set([...html.matchAll(/https:\/\/www\.1905\.com\/special\/filmfest\/[\w-]+\//g)].map(match => match[0]))];
  } catch (error) {
    notes.push(`官方专题索引暂不可用，读取已核实的官方活动页：${error.message}`);
  }
  pages = [...new Set([...pages, ...FALLBACK_PAGES])].slice(0, 24);
  const results = await Promise.allSettled(pages.map(async page => {
    const parsed = parsePage(await getText(page, undefined, options), page);
    if (!parsed) return null;
    if (!/电影|影视|影节|音乐|红毯|首映|剧|影人|影展|颁奖|演员|演唱/.test(parsed.title) || /宗教|佛教|道教|基督|天主教/.test(parsed.title)) return null;
    const playback = await playlistInfo(parsed.configUrl, page, options);
    return {
      key: playback.url,
      item: {
        id: `special-${parsed.cid}`,
        provider: id,
        title: parsed.title,
        page,
        kind: parsed.kind,
        description: parsed.description || playback.title,
      },
    };
  }));
  const seen = new Set();
  const items = [];
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      notes.push(`${new URL(pages[index]).pathname}：${result.reason.message}`);
      return;
    }
    if (!result.value || seen.has(result.value.key)) return;
    seen.add(result.value.key);
    items.push(result.value.item);
  });
  notes.push('仅收录1905官方专题中明确isvip=0的完整活动播放器；新闻短片、会员VOD轮播和未公开播放权限的内容不加入目录。');
  notes.push('活动页与XML在每次播放时重新读取；目录不保存媒体地址、签名或登录凭据。');
  return { items: items.slice(0, Math.max(0, Math.min(24, Math.trunc(Number(limit) || 0)))), notes };
}

export async function resolve(item, options = {}) {
  if (item?.provider !== id) throw new Error('1905活动条目的provider不匹配');
  const page = officialPage(item.page);
  const parsed = parsePage(await getText(page, undefined, options), page);
  if (!parsed || item.id !== `special-${parsed.cid}`) throw new Error('1905官方专题已更换活动或未提供完整公开播放器，请刷新目录');
  const playback = await playlistInfo(parsed.configUrl, page, options);
  const manifest = await getText(playback.url, page, options);
  if (!manifest.trimStart().startsWith('#EXTM3U')) throw new Error('1905活动返回的内容不是有效HLS播放列表');
  if (/#EXT-X-(?:SESSION-)?KEY:(?![^\r\n]*METHOD=NONE)/.test(manifest)) {
    throw new Error('1905活动包含加密或DRM标记，当前公开模块不提供播放');
  }
  const allowedHosts = new Set([new URL(playback.url).hostname]);
  for (const line of manifest.split(/\r?\n/)) {
    const references = line.startsWith('#') ? [...line.matchAll(/URI="([^"]+)"/g)].map(match => match[1]) : (line.trim() ? [line.trim()] : []);
    for (const reference of references) {
      const url = mediaUrl(new URL(reference, playback.url).href);
      allowedHosts.add(new URL(url).hostname);
    }
  }
  const tm = Number(new URL(playback.url).searchParams.get('tm'));
  return {
    url: playback.url,
    headers: { ...REQUEST_HEADERS, Referer: page },
    allowedHosts: [...allowedHosts],
    kind: manifest.includes('#EXT-X-ENDLIST') ? 'replay' : parsed.kind,
    ...(tm > Date.now() / 1000 ? { expiresAt: new Date(tm * 1000).toISOString() } : {}),
  };
}
