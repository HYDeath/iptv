import { CHANNELS, DEFAULT_CHANNEL_IDS, GROUP, channelForRef } from './channels.js'
import { clearResolveCache, fetchChannels, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'bestv-fj',
  name: '百视通',
  region: '百视通',
  description: '默认关闭。支持 64 路福建百视通频道，默认仅选择现有来源缺少的七路专业频道；每次刷新清单时检查并自动更新短效地址，视频分片直连官方 CDN。地区、运营商及平台策略可能影响播放。',
  defaultEnabled: false,
  catalogVersion: 1,
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  outputGroupName: GROUP,
  channelHlsMode: 'relay',
  relayProxyCompatible: true,
  defaultRefreshMinutes: 360,
  refreshConfigurable: false,
  refreshDescription: '每 360 分钟同步官方目录和台标；播放地址最多缓存 120 秒，每次清单刷新都检查可用性，失败时立即重新获取。',
  configSchema: [{ key: 'channels', label: '加入订阅的频道', type: 'multiselect',
    options: CHANNELS.map(c => ({ value: c.id, label: c.name })),
    default: DEFAULT_CHANNEL_IDS.join('\n'),
    hint: '默认勾选多彩文体4K、都市剧场、动漫秀场、乐游、法治天地、东方财经、生活时尚。其他央视、卫视等已有来源，按需勾选作为备用；至少选择一路。多彩文体4K 本次实际流为 1080p。' }],
  fetch: fetchChannels,
  epg,
  claimsRef: ref => !!channelForRef(ref),
  resolve: resolveChannel,
  clearResolveCache,
}
