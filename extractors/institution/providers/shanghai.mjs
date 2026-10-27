export const provider = {
  id: 'shanghai', name: '上海市群众艺术馆',
  officialUrl: 'https://www.shqyg.com/live/index.html',
};

const endpoint = 'https://www.shqyg.com/api/proxy/new';
async function api(path, params, fetchImpl) {
  const r = await fetchImpl(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: provider.officialUrl },
    body: new URLSearchParams({ _url: `apiLiveVideo/${path}.do`, ...params }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`上海群艺馆 API HTTP ${r.status}`);
  const j = await r.json();
  if (j.status !== 200 || !j.data) throw new Error('上海群艺馆目录返回异常');
  return j.data;
}
function mediaUrl(row) {
  return [row.liveVideoUrl, row.liveVideoUrl720, row.liveVideoUrl480, row.liveVideoUrl360]
    .find(u => /^https?:\/\//.test(u || '') && /\.(m3u8|mp4)(?:\?|$)/i.test(u));
}
export function toItem(row, now = Date.now()) {
  if (row.ifDisable || /宗教|佛教|基督教|天主教|道教|伊斯兰/.test(row.liveVideoTitle)) return null;
  // 详情 API 不返回列表中计算的 liveStatus；与官方详情播放器一致，用活动时段再核验。
  const live = row.liveType === 1 && (row.liveStatus == null || row.liveStatus === 1) && now >= row.videoStartTimestamp && now < row.videoEndTimestamp;
  const vod = row.liveType === 3 && (row.liveStatus == null || row.liveStatus === 4);
  const url = mediaUrl(row);
  if ((!live && !vod) || !url) return null;
  return {
    id: String(row.liveVideoId), provider: provider.id, title: row.liveVideoTitle.trim(), kind: live ? 'live' : 'vod',
    pageUrl: `https://www.shqyg.com/live/detail.html?id=${row.liveVideoId}`, url,
    headers: { Referer: provider.officialUrl },
    startsAt: row.videoStartTimestamp, endsAt: row.videoEndTimestamp,
    description: live ? '官方状态为直播中，且处于公告时间内' : '官方录播栏目；按点播提供',
  };
}
export async function discover({ fetchImpl = fetch } = {}) {
  const [live, vod] = await Promise.all([
    api('queryLiveVideoList', { liveType: 1, pageIndex: 0, pageNum: 100, sortRule: 1 }, fetchImpl),
    api('queryLiveVideoList', { liveType: 3, pageIndex: 0, pageNum: 4, sortRule: 1 }, fetchImpl),
  ]);
  const now = Date.now();
  return {
    provider: provider.id, items: [...live, ...vod].map(r => toItem(r, now)).filter(Boolean),
    upcoming: live.filter(r => r.liveStatus === 2 && r.videoStartTimestamp > now).map(r => ({ title: r.liveVideoTitle, startsAt: r.videoStartTimestamp, pageUrl: `https://www.shqyg.com/live/detail.html?id=${r.liveVideoId}` })),
    notes: ['直播须同时满足官方状态、开始及结束时间；已结束的历史直播地址不输出。', '点播仅取官方录播栏目前四条。'],
  };
}
export async function resolve(id, { fetchImpl = fetch } = {}) {
  const row = await api('queryLiveVideoById', { liveVideoId: id }, fetchImpl);
  const item = toItem(row);
  if (!item) throw new Error('该活动尚未开播、已结束或没有公开播放地址');
  return item;
}
