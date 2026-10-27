import { settleRequests } from './settled.mjs';
export const provider = {
  id: 'knowledge', name: '图书馆与科技馆', officialUrl: 'https://www.library.sh.cn/service/video',
};
const library = 'https://www.library.sh.cn';
const science = 'https://www.cdstm.cn';
const excluded = /宗教|佛教|基督|天主教|道教|伊斯兰|弘法|法会|讲经|禅修/;
const clean = value => String(value || '').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').trim();
async function read(url, fetchImpl, init = {}) {
  const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(18000) });
  if (!r.ok) throw new Error(`知识机构 HTTP ${r.status}`);
  return r;
}
async function libraryRows(fetchImpl, { tags = '', pagesize = 12 } = {}) {
  const r = await read(`${library}/st/videocc/videoccList`, fetchImpl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Referer: `${library}/service/video` },
    body: JSON.stringify({ page: 1, pagesize, category: '', tags }),
  });
  const j = await r.json();
  if (String(j.code) !== '200' || !Array.isArray(j.data?.data)) throw new Error('上图讲座目录异常');
  return j.data.data.filter(row => /^[A-F0-9]{32}$/.test(row.ccid) && !excluded.test(clean(row.title)));
}
async function libraryItem(row, fetchImpl) {
  const html = await (await read(`${library}/service/video`, fetchImpl)).text();
  const site = html.match(/comimage(?:\\u002F|\/)([A-F0-9]{16})(?:\\u002F|\/)/)?.[1];
  if (!site) throw new Error('未识别上图官方嵌入的播放器账号');
  const params = new URLSearchParams({ vid: row.ccid, siteid: site, hlssupport: '1', version: '20140214', callback: 'lab' });
  const apiUrl = `https://p.bokecc.com/servlet/getvideofile?${params}`;
  const text = await (await read(apiUrl, fetchImpl, { headers: { Referer: `${library}/service/videoDetail?id=${row.ccid}` } })).text();
  const j = JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')));
  if (Number(j.status) !== 1 || Number(j.safeLevel) !== 0 || Number(j.freetime) > 0 || j.vid !== row.ccid) throw new Error('上图视频存在播放限制或状态变化');
  const copies = (j.copies || []).filter(c => c.mediatype === 1 && /^https?:\/\//.test(c.playurl || '')).sort((a, b) => b.quality - a.quality);
  if (!copies.length) throw new Error('上图官方播放器没有返回公开视频');
  const u = new URL(copies[0].playurl);
  if (!u.hostname.endsWith('.play.bokecc.com') || !u.pathname.endsWith('.m3u8')) throw new Error('上图媒体来源变化');
  u.protocol = 'https:';
  return {
    id: `shlib-${row.ccid}`, provider: provider.id, institution: '上海图书馆',
    title: clean(row.title), kind: 'vod', pageUrl: `${library}/service/videoDetail?id=${row.ccid}`, url: u.href,
    headers: { Referer: `${library}/service/videoDetail?id=${row.ccid}` }, duration: Number(row.duration),
    description: '上海图书馆公开讲座回放。',
  };
}
let scienceAuth;
async function scienceToken(fetchImpl) {
  if (scienceAuth && scienceAuth.until > Date.now()) return scienceAuth.token;
  const html = await (await read(`${science}/md/index.html`, fetchImpl)).text();
  const src = [...html.matchAll(/<script[^>]*\bsrc=["']([^"']+\/index1\.js)["']/g)][0]?.[1];
  if (!src) throw new Error('科技馆官方匿名客户端入口变化');
  const script = await (await read(new URL(src, science), fetchImpl)).text();
  const appId = script.match(/var app_id\s*=\s*["']([^"']+)["']/)?.[1];
  const appSecret = script.match(/var app_secret\s*=\s*["']([^"']+)["']/)?.[1];
  if (!appId || !appSecret) throw new Error('科技馆官方匿名客户端配置变化');
  // Mirrors the public website's own catalogue request; no visitor/user account is created.
  const r = await read('https://live.pili-live.com/livestreamapi/v1/account/auth-token/', fetchImpl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${science}/md/index.html` },
    body: new URLSearchParams({ app_id: appId, app_secret: appSecret }),
  });
  const j = await r.json();
  if (Number(j.code) !== 200 || !j.result?.access_token) throw new Error('科技馆匿名目录请求失败');
  scienceAuth = { token: `jwt ${j.result.access_token}`, until: Date.now() + 300000 };
  return scienceAuth.token;
}
export function scienceItem(detail) {
  if (detail.enterprise_id !== 15914 || detail.active !== 1 || detail.isOpen !== true || detail.anonymous_login !== true
    || detail.record_access !== true || detail.type !== 2 || detail.isPreview || detail.codeStatus || detail.apply_form || detail.apply_review
    || detail.limitType !== 'none'
    || excluded.test(detail.title || '')) return null;
  if (detail.record_endDate) {
    const time = detail.record_endDate.replace(' ', 'T');
    const expiry = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(time) ? time : `${time}+08:00`);
    if (!Number.isFinite(expiry) || expiry < Date.now()) return null;
  }
  const id = String(detail.id);
  if (!/^\d+$/.test(id) || !detail.m3u8_url) return null;
  const u = new URL(detail.m3u8_url);
  if (u.protocol !== 'https:' || !u.hostname.endsWith('.vod2.myqcloud.com') || !u.pathname.endsWith('.m3u8')) return null;
  return {
    id: `cdstm-${id}`, provider: provider.id, institution: '中国数字科技馆', title: clean(detail.title), kind: 'vod',
    pageUrl: `${science}/xq/index.html?liveid=${id}`, url: u.href,
    headers: { Referer: `${science}/xq/index.html?liveid=${id}` },
    description: '中国数字科技馆公开科普直播回放。',
  };
}
async function scienceDetail(id, fetchImpl) {
  const j = await (await read(`https://qncdn2.youinsh.cn/saas_pro/json/course_${id}_info.json`, fetchImpl)).json();
  const item = scienceItem(j);
  if (!item) throw new Error('科技馆节目当前未开放完整匿名回放');
  return item;
}
async function discoverScience(fetchImpl, notes) {
  const token = await scienceToken(fetchImpl);
  const j = await (await read('https://live.pili-live.com/livestreamapi/v1/course/system/third_list_course/?enterprise_id=15914&page=1&size=20&status=3', fetchImpl, { headers: { Authorization: token, Referer: `${science}/md/index.html` } })).json();
  if (Number(j.code) !== 200 || !Array.isArray(j.result)) throw new Error('科技馆活动目录异常');
  const rows = j.result.filter(row => row.isOpen === true && row.record_access === true && !row.isPreview && !excluded.test(row.title)).slice(0, 3);
  notes.push(`中国数字科技馆已结束目录前 ${j.result.length} 场，仅 ${rows.length} 场明确开放回放；record_access=false 不输出。`);
  const results = await settleRequests(rows.map(row => scienceDetail(row.id, fetchImpl)));
  return results.flatMap(r => { if (r.status === 'fulfilled') return [r.value]; notes.push(r.reason.message); return []; });
}
export async function discover({ fetchImpl = fetch, institution } = {}) {
  const notes = [];
  const jobs = [
    { name: '上海图书馆', run: () => libraryRows(fetchImpl).then(rows => settleRequests(rows.slice(0, 3).map(r => libraryItem(r, fetchImpl)))).then(results => results.flatMap(r => { if (r.status === 'fulfilled') return [r.value]; notes.push(r.reason.message); return []; })) },
    { name: '中国数字科技馆', run: () => discoverScience(fetchImpl, notes) },
  ].filter(job => !institution || job.name === institution);
  if (!jobs.length) throw new Error('未知知识机构');
  const results = await settleRequests(jobs.map(job => job.run()));
  const items = results.flatMap(r => { if (r.status === 'fulfilled') return r.value; notes.push(r.reason.message); return []; });
  if (!institution || institution === '上海图书馆') notes.push('上图仅取当前公开目录前三条非宗教讲座，重新请求其授权播放器的短效 HLS。');
  return { provider: provider.id, items, notes };
}
export async function resolve(id, { fetchImpl = fetch, institution } = {}) {
  const owner = id.startsWith('shlib-') ? '上海图书馆' : id.startsWith('cdstm-') ? '中国数字科技馆' : '';
  if (institution && owner !== institution) throw new Error('节目不属于该知识机构');
  const sh = id.match(/^shlib-([A-F0-9]{32})$/);
  if (sh) {
    const row = (await libraryRows(fetchImpl, { tags: sh[1], pagesize: 12 })).find(r => r.ccid === sh[1]);
    if (!row) throw new Error('上图节目当前不在官方公开目录');
    return libraryItem(row, fetchImpl);
  }
  const sc = id.match(/^cdstm-(\d+)$/);
  if (sc) return scienceDetail(sc[1], fetchImpl);
  throw new Error('无效知识机构节目 ID');
}
