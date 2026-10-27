import { proxyAwareFetch } from '../../utils/systemProxy.js';

export async function fetchWithTimeout(url, init = {}) {
  return proxyAwareFetch(url, { ...init, signal: init.signal || AbortSignal.timeout(25000) });
}
export function selectMediaTracks(media) {
  const streams = media.streams || [];
  const video = streams.filter(s => s.codec_type === 'video').sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
  const program = video && (media.programs || []).find(p => p.streams?.some(s => s.index === video.index));
  const audio = program?.streams.find(s => s.codec_type === 'audio') || streams.find(s => s.codec_type === 'audio');
  return { video, audio };
}
export function safeMediaUrl(value) {
  const u = new URL(value);
  const h = u.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port && !['80', '443'].includes(u.port)) throw new Error('不支持的媒体地址');
  if (!h.includes('.') || /(^|\.)(localhost|local|internal)$/.test(h) || /^[\d.]+$/.test(h) || h.includes(':')) throw new Error('媒体地址必须为公开域名');
  return u.href;
}
export function rewriteManifest(text, base, register) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('上游没有返回 HLS 清单');
  return text.split(/\r?\n/).map(line => {
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, value) => `URI="${register(safeMediaUrl(new URL(value, base)))}"`);
    if (!line.trim()) return line;
    return register(safeMediaUrl(new URL(line.trim(), base)));
  }).join('\n');
}
export function manifestFacts(text) {
  return {
    hls: text.trimStart().startsWith('#EXTM3U'), ended: /#EXT-X-ENDLIST(?:\r?\n|$)/.test(text),
    master: /#EXT-X-STREAM-INF:/.test(text), sequence: Number(text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] || 0),
    targetDuration: Number(text.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1] || 0),
    segments: [...text.matchAll(/#EXTINF:([\d.]+)/g)].map(m => Number(m[1])),
  };
}
export async function readMediaManifest(url, headers = {}, fetchImpl = fetchWithTimeout) {
  let current = safeMediaUrl(url);
  for (let depth = 0; depth < 5; depth++) {
    const r = await fetchImpl(current, { headers });
    if (!r.ok) throw new Error(`HLS HTTP ${r.status}`);
    const text = await r.text(), facts = manifestFacts(text);
    if (!facts.hls) throw new Error('无效的 HLS 清单');
    if (!facts.master) return { url: r.url || current, text, facts };
    const lines = text.split(/\r?\n/), variants = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const path = lines.slice(i + 1).find(s => s.trim() && !s.startsWith('#'));
      if (path) variants.push({ bandwidth: Number(lines[i].match(/BANDWIDTH=(\d+)/)?.[1] || 0), path });
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    if (!variants.length) throw new Error('主清单中没有视频线路');
    current = safeMediaUrl(new URL(variants[0].path, r.url || current));
  }
  throw new Error('HLS 嵌套过深');
}
export async function validateLive(item, { fetchImpl = fetchWithTimeout, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (item.kind !== 'live' || !/\.m3u8(?:\?|$)/i.test(item.url)) throw new Error('直播必须是实时 HLS');
  const first = await readMediaManifest(item.url, item.headers, fetchImpl);
  if (first.facts.ended || !first.facts.segments.length) throw new Error('直播清单已结束或没有视频分片');
  await wait(Math.min(15000, Math.max(2500, (first.facts.targetDuration || 4) * 1500)));
  const second = await readMediaManifest(item.url, item.headers, fetchImpl);
  if (second.facts.ended) throw new Error('直播已结束');
  const refs = s => s.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')).map(l => {
    const u = new URL(l.trim(), item.url);
    for (const key of [...u.searchParams.keys()]) if (/^(?:txsecret|txtime|auth(?:_?key|_?token)?|token|jwt|key|sign|signature|expires?|expiretime|exp|e|t|ts|timestamp|time|wstime|wssecret|hdnea|hdnts|policy|key-pair-id|hash|nonce|cachebuster)$/i.test(key)) u.searchParams.delete(key);
    return u.pathname + u.search;
  }).join('\n');
  if (second.facts.sequence <= first.facts.sequence && refs(second.text) === refs(first.text)) throw new Error('直播清单没有前进');
  return { sequenceBefore: first.facts.sequence, sequenceAfter: second.facts.sequence, advanced: true };
}
