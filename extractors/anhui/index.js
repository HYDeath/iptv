/** 安徽广电：「安徽视讯」App 公开的七路电视频道，播放时按 App 算法签名并以兼容 UA 全代理。 */
import {
  buildChannels,
  claimsRef,
  clearCache,
  resolveChannel,
} from './api.js'

export default {
  id: 'anhui',
  name: '安徽',
  description: '安徽视讯 App 公开的 7 路电视频道；无需登录，播放时读取官方频道详情中的当前域名与流 ID，按 App 算法签名，清单与分片使用各 CDN 的兼容标识全代理。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  catalogVersion: 1,
  outputGroupName: '安徽',
  // CDN 按 User-Agent 放行，统一经全代理保证清单与分片使用相同的兼容标识。
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道引用保持不变；播放时从官方详情读取当前域名与流 ID，刷新 App 密钥与两小时签名，旧源失效时重新读取配置。每次轮询都拉取实时清单，清单与分片全代理。seclive 证书主机名不匹配时仅对该域名兼容 HTTP。',

  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '安徽', dataList: buildChannels() }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
