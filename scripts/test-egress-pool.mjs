#!/usr/bin/env node
/**
 * 央视频多出口切换。不联网。
 * 运行： node scripts/test-egress-pool.mjs
 */
import assert from 'node:assert/strict'
import { createEgressPool, usesCctvEgress } from '../utils/egressPool.js'

const HOUR = 60 * 60 * 1000
let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('央视频多出口切换测试')

await check('只匹配央视频域名', () => {
  assert.equal(usesCctvEgress('https://bkliveinfo.ysp.cctv.cn/x'), true)
  assert.equal(usesCctvEgress('https://live-dtocnc-cdn.ysp.cctv.cn/a.m3u8'), true)
  assert.equal(usesCctvEgress('https://example.com/a'), false)
})

await check('未配置出口时不介入', async () => {
  const pool = createEgressPool()
  assert.deepEqual(await pool.beforeRequest('https://a.ysp.cctv.cn/a'), { bypass: true })
})

await check('1 号被拒后直接启用 2 号，不回头探测 1 号', async () => {
  const probed = []
  const pool = createEgressPool({
    addresses: ['1.1.1.1', '2.2.2.2', '3.3.3.3'],
    probe: async address => { probed.push(address); return false },
  })
  assert.equal((await pool.beforeRequest('https://a.ysp.cctv.cn/a')).address, '1.1.1.1')
  await pool.reportBlocked('1.1.1.1')
  assert.deepEqual(probed, [])
  assert.equal((await pool.beforeRequest('https://a.ysp.cctv.cn/a')).address, '2.2.2.2')
})

await check('2 号被拒时先查 1 号，1 号恢复就切回', async () => {
  const pool = createEgressPool({
    addresses: ['1.1.1.1', '2.2.2.2', '3.3.3.3'],
    probe: async address => address === '1.1.1.1',
  })
  await pool.reportBlocked('1.1.1.1')
  await pool.reportBlocked('2.2.2.2')
  assert.equal(pool.snapshot().address, '1.1.1.1')
})

await check('2 号被拒且 1 号仍失败时启用 3 号', async () => {
  const probed = []
  const pool = createEgressPool({
    addresses: ['1.1.1.1', '2.2.2.2', '3.3.3.3'],
    probe: async address => { probed.push(address); return false },
  })
  await pool.reportBlocked('1.1.1.1')
  await pool.reportBlocked('2.2.2.2')
  assert.deepEqual(probed, ['1.1.1.1'])
  assert.equal(pool.snapshot().address, '3.3.3.3')
})

await check('全部被拒后静默，期间不再探测', async () => {
  let t = 0
  const probed = []
  const pool = createEgressPool({
    addresses: ['1.1.1.1', '2.2.2.2'],
    quietMs: 6 * HOUR,
    now: () => t,
    probe: async address => { probed.push(address); return false },
  })
  await pool.reportBlocked('1.1.1.1')
  await pool.reportBlocked('2.2.2.2')
  probed.length = 0
  t = 6 * HOUR - 1
  const silent = await pool.beforeRequest('https://a.ysp.cctv.cn/a')
  assert.equal(silent.silent, true)
  assert.deepEqual(probed, [])
})

await check('静默满 6 小时才逐个探测，用第一个恢复的', async () => {
  let t = 0
  const probed = []
  const pool = createEgressPool({
    addresses: ['1.1.1.1', '2.2.2.2', '3.3.3.3'],
    quietMs: 6 * HOUR,
    now: () => t,
    probe: async address => { probed.push(t + ':' + address); return t >= 6 * HOUR && address === '2.2.2.2' },
  })
  await pool.reportBlocked('1.1.1.1')
  await pool.reportBlocked('2.2.2.2')
  await pool.reportBlocked('3.3.3.3')
  probed.length = 0
  t = 6 * HOUR
  const next = await pool.beforeRequest('https://a.ysp.cctv.cn/a')
  assert.equal(next.address, '2.2.2.2')
  assert.deepEqual(probed, ['21600000:1.1.1.1', '21600000:2.2.2.2'])
})

await check('6 小时探测仍全失败就再静默一轮', async () => {
  let t = 0
  let probes = 0
  const pool = createEgressPool({
    addresses: ['1.1.1.1', '2.2.2.2'],
    quietMs: 6 * HOUR,
    now: () => t,
    probe: async () => { probes++; return false },
  })
  await pool.reportBlocked('1.1.1.1')
  await pool.reportBlocked('2.2.2.2')
  t = 6 * HOUR
  const again = await pool.beforeRequest('https://a.ysp.cctv.cn/a')
  assert.equal(again.silent, true)
  assert.equal(pool.snapshot().quietUntil, 12 * HOUR)
  const during = probes
  t = 12 * HOUR - 1
  await pool.beforeRequest('https://a.ysp.cctv.cn/a')
  assert.equal(probes, during)
})

await check('过期出口的失败报告不再改当前出口', async () => {
  const pool = createEgressPool({
    addresses: ['1.1.1.1', '2.2.2.2'],
    probe: async () => false,
  })
  await pool.reportBlocked('1.1.1.1')
  await pool.reportBlocked('1.1.1.1')
  assert.equal(pool.snapshot().address, '2.2.2.2')
})

console.log(`\n${passed} 项通过`)
