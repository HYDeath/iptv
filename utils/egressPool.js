/** 央视频一类上游按出口 IP 限流时的切换规则。不发网络请求。 */

export const QUIET_MS = 6 * 60 * 60 * 1000
export const BLOCK_STATUSES = new Set([403, 412, 451])

export function usesCctvEgress(raw) {
  try {
    const host = new URL(String(raw)).hostname.toLowerCase()
    return host === 'cctv.cn' || host.endsWith('.cctv.cn')
      || host === 'cctv.com' || host.endsWith('.cctv.com')
  } catch {
    return false
  }
}

/**
 * addresses 按 1 号、2 号、3 号排列。
 * 当前出口被拒后，先按顺序探测更早的出口，第一个恢复的就切回去；都没恢复才启用下一个。
 * 全部不可用时进入静默，静默期内不再访问；满 quietMs 才再逐个探测一次。
 */
export function createEgressPool({
  addresses = [],
  quietMs = QUIET_MS,
  now = () => Date.now(),
  probe = async () => false,
  log = () => {},
  initial = {},
  save = () => {},
} = {}) {
  const list = addresses.map(value => String(value || '').trim()).filter(Boolean)
  let active = Number.isInteger(initial.active) && initial.active >= 0 && initial.active < list.length ? initial.active : 0
  let quietUntil = Number(initial.quietUntil) > 0 ? Number(initial.quietUntil) : 0
  let gate = Promise.resolve()
  const changed = () => save({ active, quietUntil })

  const lock = fn => {
    const run = gate.then(fn, fn)
    gate = run.then(() => {}, () => {})
    return run
  }

  const label = index => `${index + 1} 号 ${list[index]}`

  async function probeEarlier(before) {
    for (let i = 0; i < before; i++) {
      log(`探测更早的出口 ${label(i)}`)
      if (await probe(list[i])) {
        active = i
        quietUntil = 0
        changed()
        log(`出口 ${label(i)} 已恢复，切回它`)
        return true
      }
    }
    return false
  }

  async function sweep() {
    for (let i = 0; i < list.length; i++) {
      log(`静默到期，探测出口 ${label(i)}`)
      if (await probe(list[i])) {
        active = i
        quietUntil = 0
        changed()
        log(`出口 ${label(i)} 可用，结束静默`)
        return true
      }
    }
    quietUntil = now() + quietMs
    changed()
    log(`出口仍全部不可用，继续静默 ${quietMs / 3600000} 小时`)
    return false
  }

  return {
    enabled: () => list.length > 0,
    snapshot: () => ({
      active,
      address: list[active] || '',
      quietUntil,
      addresses: [...list],
    }),
    beforeRequest(url) {
      if (!list.length || !usesCctvEgress(url)) return Promise.resolve({ bypass: true })
      return lock(async () => {
        const t = now()
        if (quietUntil && t < quietUntil) return { silent: true, until: quietUntil }
        if (quietUntil && t >= quietUntil) {
          const ok = await sweep()
          if (!ok) return { silent: true, until: quietUntil }
        }
        return { address: list[active] }
      })
    },
    reportBlocked(address) {
      if (!list.length) return Promise.resolve()
      return lock(async () => {
        const index = list.indexOf(address)
        if (index < 0 || index !== active || (quietUntil && now() < quietUntil)) return
        log(`出口 ${label(index)} 被上游拒绝`)
        if (await probeEarlier(index)) return
        if (index + 1 < list.length) {
          active = index + 1
          changed()
          log(`改用出口 ${label(active)}`)
          return
        }
        quietUntil = now() + quietMs
        changed()
        log(`出口全部被拒，${quietMs / 3600000} 小时内不再请求央视频`)
      })
    },
  }
}
