import { readFileSync, writeFileSync } from 'node:fs'
import { Agent, fetch as undiciFetch } from 'undici'
import { printYellow } from './colorOut.js'
import { dataPath } from './paths.js'
import { BLOCK_STATUSES, createEgressPool, QUIET_MS, usesCctvEgress } from './egressPool.js'

const agents = new Map()
const boundResponses = new WeakMap()

function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(dataPath('egress.json'), 'utf8'))
    const quietHours = Number(raw.quietHours)
    return {
      addresses: Array.isArray(raw.addresses) ? raw.addresses : [],
      quietMs: Number.isFinite(quietHours) && quietHours > 0 ? quietHours * 3600 * 1000 : QUIET_MS,
    }
  } catch {
    return { addresses: [], quietMs: QUIET_MS }
  }
}

const config = loadConfig()

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(dataPath('egress-state.json'), 'utf8'))
    return { active: raw.active, quietUntil: raw.quietUntil }
  } catch {
    return {}
  }
}

function agentFor(address) {
  let agent = agents.get(address)
  if (!agent) {
    // localAddress 必须放在 Agent 顶层。写进 connect 会被 undici 用空值盖掉，
    // 套接字仍走默认路由，2 号和 3 号看起来切换了，包却还从主 IP 出去。
    agent = new Agent({ localAddress: address, connect: { family: 4 } })
    agents.set(address, agent)
    printYellow(`[出口] 已绑定套接字到 ${address}`)
  }
  return agent
}

async function probeAddress(address) {
  const fetchImpl = (url, options = {}) => undiciFetch(url, { ...options, dispatcher: agentFor(address) })
  const { requestPlayUrls, selectWorkingManifest } = await import('../extractors/yangshipin/api.js')
  const { CHANNELS } = await import('../extractors/yangshipin/channels.js')
  const channel = CHANNELS.find(item => item.id === 'cctv1')
  try {
    const { urls } = await requestPlayUrls(channel, { fetchImpl, timeoutMs: 8000 })
    // 单个 CDN 回 403 只说明这一条入口不行，备用入口仍可能可用。主备都 403 才算这个出口还被封。
    await selectWorkingManifest(urls, { fetchImpl, timeoutMs: 8000 })
    return true
  } catch {
    // 主备都 403、取票被拒或超时，都不能把这个出口当成已恢复。
    return false
  }
}

const pool = createEgressPool({
  addresses: config.addresses,
  quietMs: config.quietMs,
  initial: loadState(),
  probe: probeAddress,
  log: message => printYellow(`[出口] ${message}`),
  save: state => {
    try { writeFileSync(dataPath('egress-state.json'), JSON.stringify(state)) } catch { /* 状态写失败不影响取流 */ }
  },
})

if (pool.enabled()) {
  const snap = pool.snapshot()
  const listed = snap.addresses.map((address, index) => `${index + 1}号 ${address}`).join('，')
  const quiet = snap.quietUntil > Date.now() ? `，静默到 ${new Date(snap.quietUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : ''
  printYellow(`[出口] 央视频按顺序使用 ${listed}；当前 ${snap.active + 1}号 ${snap.address}${quiet}；全部被拒后静默 ${config.quietMs / 3600000} 小时再探测`)
}

export function rememberEgress(response, address) {
  if (response && address) boundResponses.set(response, address)
}

export function egressOf(response) {
  return boundResponses.get(response) || ''
}

export function dispatcherFor(address) {
  return agentFor(address)
}

export async function prepareCctvEgress(url) {
  return pool.beforeRequest(url)
}

export async function reportCctvBlocked(address) {
  if (!address) return
  await pool.reportBlocked(address)
}

export { usesCctvEgress, BLOCK_STATUSES }
