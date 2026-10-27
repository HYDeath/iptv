import { createHash, randomBytes } from 'node:crypto';
export const provider = {
  id: 'zhejiang', name: '浙江省数字文化馆', officialUrl: 'https://www.zjart.com/zjspc/live',
};
// 官网公开前端的匿名请求封装：Base64 插入随机填充及时间戳签名，不使用用户票据。
function encode(params) {
  const s = Buffer.from(JSON.stringify(params)).toString('base64');
  const pad = () => randomBytes(16).toString('hex').slice(0, 15);
  return pad() + s.slice(0, 4) + pad() + s.slice(4) + pad();
}
async function api(path, params, fetchImpl) {
  const timestamp = String(Date.now());
  const u = new URL(`https://www.zjart.com/live/${path}.show`);
  u.search = new URLSearchParams({ data: encode(params), requestTime: timestamp });
  const r = await fetchImpl(u, {
    headers: {
      timestamp, sign: createHash('md5').update(`Hnszwhg${timestamp}hNsZwhg@2019`).digest('hex'),
      neditor: 'neditor', project: 'zjspc', refererer: provider.officialUrl,
    }, signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`浙江文化馆 API HTTP ${r.status}`);
  const text = await r.text();
  const j = JSON.parse(Buffer.from(text.slice(15, -15), 'base64').toString());
  if (j.status?.returnCode !== 100 || !Array.isArray(j.data?.list)) throw new Error('浙江文化馆目录返回异常');
  return j.data.list;
}
export function toItem(row, now = Date.now()) {
  if (/宗教|佛教|基督教|天主教|道教|伊斯兰/.test(row.title)) return null;
  const live = now >= row.startTime && now < row.endTime;
  const url = live ? row.pcPath : now >= row.endTime ? row.hisPath : null;
  if (!/^https?:\/\//.test(url || '') || !/\.(m3u8|mp4)(?:\?|$)/i.test(url)) return null;
  return {
    id: String(row.substanceId), provider: provider.id, title: row.title, kind: live ? 'live' : 'vod',
    pageUrl: `https://www.zjart.com/zjspc/live_detail/${row.substanceId}`, url,
    headers: { Referer: provider.officialUrl }, startsAt: row.startTime, endsAt: row.endTime,
    description: live ? '按官方公告时段开放的活动直播。' : '浙江省数字文化馆公开演出回放。',
  };
}
export async function discover({ fetchImpl = fetch } = {}) {
  const rows = await api('getFrontKaLiveList', { menusId: 12, pageNum: 1, pageSize: 12 }, fetchImpl);
  return {
    provider: provider.id, items: rows.map(r => toItem(r)).filter(Boolean),
    upcoming: rows.filter(r => r.startTime > Date.now()).map(r => ({ title: r.title, startsAt: r.startTime, pageUrl: `https://www.zjart.com/zjspc/live_detail/${r.substanceId}` })),
    notes: ['只检查本馆官方目录前十二项；回放使用独立 hisPath，过期活动直播地址不作为直播。', '官网播放器无需登录即可播放这些公开回放。'],
  };
}
export async function resolve(id, { fetchImpl = fetch } = {}) {
  if (!/^\d+$/.test(id)) throw new Error('无效活动 ID');
  const rows = await api('getKaLive', { id }, fetchImpl);
  const item = rows[0] && toItem(rows[0]);
  if (!item) throw new Error('该活动尚未开播、已结束且无回放，或无公开媒体地址');
  return item;
}
