import { fetchWithTimeout } from '../../net.js';
// Public official Weibo event rooms. No cookies, login, or visitor-token generation.
export const id = 'weibo';
export const name = '微博官方活动';

const UA = 'Mozilla/5.0';
const API = 'https://weibo.com/l/!/2/wblive/room/show_pc_live.json';
const MEDIA_HOSTS = ['live.video.weibocdn.com'];

// These identities were checked against each official account's public profile.
const OFFICIAL_ACCOUNTS = new Map([
  ['6224077067', { name: '微博电影之夜', title: /微博电影之夜/ }],
  ['1677969704', { name: '微博之夜', title: /微博之夜/ }],
  ['2637571067', { name: '微博视界大会', title: /微博视界大会/ }],
  ['2482778937', { name: '潘宥诚', title: /^潘宥诚的直播间$/ }],
]);

// Only durable room IDs and public editorial metadata are stored. A new event
// needs a confirmed link from its official account before entering this list.
const ROOMS = [
  { id: 'jinwu-bujin-set-20251216', room: '1022:2321325244508983394422', uid: '2482778937', title: '《金吾不禁》神剧亮了探班直播', expectedTitle: '潘宥诚的直播间', scene: 'set', duration: 4998.84, evidence: 'https://www.sina.cn/news/detail/5244539650441518.html' },
  { id: 'film-night-2026', room: '1022:2321325308278937878564', uid: '6224077067', title: '2026微博电影之夜', evidence: 'https://www.sina.cn/media/7071514713' },
  { id: 'film-night-2025', room: '1022:2321325175760058187939', uid: '6224077067', title: '2025微博电影之夜', evidence: 'https://weibo.com/6224077067/PvS0NFc01' },
  { id: 'film-night-2024', room: '1022:2321325044090055295215', uid: '6224077067', title: '2024微博电影之夜', evidence: 'https://weibo.com/1642591402/OjfWT50na' },
  { id: 'weibo-night-2025', room: '1022:2321325262222846197969', uid: '1677969704', title: '2025微博之夜', evidence: 'https://weibo.com/1677969704/5262228898972875' },
];

const roomPage = room => `https://weibo.com/l/wblive/p/show/${room}`;

function publicMediaUrl(value) {
  const url = new URL(String(value || '').replace(/^http:/, 'https:'));
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !MEDIA_HOSTS.includes(url.hostname)) {
    throw new Error('微博官方媒体域名不在已验证白名单内');
  }
  return url.href;
}

async function fetchRoom(seed, { fetchImpl = fetchWithTimeout } = {}) {
  const url = new URL(API);
  url.searchParams.set('live_id', seed.room);
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': UA, Referer: roomPage(seed.room) },
    redirect: 'manual', signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`微博官方房间 API HTTP ${response.status}；匿名入口受限`);
  const type = response.headers.get('content-type') || '';
  if (!type.includes('json')) throw new Error('微博官方入口要求访客验证或登录；已停止该入口');
  const body = await response.json();
  if (Number(body.code) !== 100000 || !body.data) throw new Error(`微博官方房间 API 未开放此入口（代码 ${Number(body.code) || 'unknown'}）`);
  const data = body.data, account = OFFICIAL_ACCOUNTS.get(seed.uid);
  if (!account || String(data.user?.uid) !== seed.uid || Number(data.user?.verified) !== 1 || data.user?.screenName !== account.name || !account.title.test(String(data.title)) || (seed.expectedTitle && data.title !== seed.expectedTitle)) {
    throw new Error('直播间发布者或活动名称未通过官方身份白名单');
  }
  if (Number(data.watch_limit) !== 0) throw new Error('官方活动要求登录、付费或限定观看；已停止该入口');
  if (Number(data.play_switch) === 0) throw new Error('官方已关闭此活动的播放');
  const kind = Number(data.status) === 1 ? 'live' : Number(data.status) === 3 ? 'replay' : undefined;
  if (!kind) throw new Error('官方直播已结束且未开放回放，或尚未开始');
  const mediaUrl = kind === 'live' ? data.live_origin_hls_url : data.replay_origin_url;
  if (!mediaUrl) throw new Error('官方未提供公开完整直播或回放的媒体地址');
  return { data, kind, url: publicMediaUrl(mediaUrl) };
}

export async function discover({ limit = 8, ...options } = {}) {
  const items = [], blocked = [{
    id: 'vision-official-feed', title: '微博视界大会 · 官方活动目录',
    page: 'https://weibo.com/wbsjdh', kind: 'replay',
    reason: '官方主页要求登录后查看活动列表；没有复用浏览器会话或绕过限制，暂未发现可验证房间。',
  }];
  const notes = [
    '仅接收已核实的三个官方活动账号，以及演员潘宥诚本人发布的《金吾不禁》正式探班房间；每次发现与播放均复核UID、账号名称、认证、标题及观看限制。',
    '目录从已核实的正式活动房间更新状态，不代表全站搜索；包含《金吾不禁》剧组探班与电影之夜2024—2026完整官方回放。',
    '播放时重新请求官方公开房间API，无Cookie或凭证；不保存媒体签名地址。片段、付费、试看和登录受限内容不进入可播目录。',
  ];
  const results = await Promise.allSettled(ROOMS.map(async seed => ({ seed, result: await fetchRoom(seed, options) })));
  for (let n = 0; n < results.length; n++) {
    const seed = ROOMS[n], settled = results[n];
    if (settled.status === 'rejected') {
      blocked.push({ id: seed.id, title: seed.title, page: roomPage(seed.room), kind: 'replay', reason: settled.reason.message });
      continue;
    }
    const { data, kind } = settled.value.result;
    const start = Number(data.startTime);
    items.push({
      id: seed.id, provider: id, title: seed.expectedTitle ? seed.title : String(data.title), page: roomPage(seed.room), kind,
      description: seed.scene === 'set' ? '演员潘宥诚本人发布的《金吾不禁》正式探班节目长回放，包含片头及剧组片场互动。' : `${data.user.screenName}官方${kind === 'live' ? '直播' : '长时活动回放'}；按官方发布内容播放，未使用录屏或剪辑拼接。`,
      ...(seed.scene ? { scene: seed.scene } : {}),
      ...(seed.duration ? { duration: seed.duration } : {}),
      ...(Number.isFinite(start) && start > 0 ? { startAt: new Date(start).toISOString() } : {}),
    });
  }
  const count = Number.isFinite(Number(limit)) ? Math.max(0, Math.min(50, Math.floor(Number(limit)))) : 8;
  return { items: items.slice(0, count), blocked, notes };
}

export async function resolve(item, options = {}) {
  const seed = ROOMS.find(value => value.id === String(item?.id));
  if (!seed || item.provider !== id) throw new Error('活动不在已核实的微博官方房间目录中');
  const result = await fetchRoom(seed, options);
  if (item.kind && item.kind !== result.kind) throw new Error('官方活动状态已经变化，请刷新目录');
  return {
    url: result.url,
    headers: { 'User-Agent': UA, Referer: roomPage(seed.room) },
    allowedHosts: [...MEDIA_HOSTS], kind: result.kind,
  };
}
