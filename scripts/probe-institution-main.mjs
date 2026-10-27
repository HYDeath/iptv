// Explicit live-network acceptance against an already isolated main instance.
// Not in npm test. No extractor implementation or upstream URL is used here.
import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { selectMediaTracks } from '../extractors/institution/net.js'
const arg = key => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3)
const base = (arg('base') || 'http://127.0.0.1:1947').replace(/\/$/, '')
const out = arg('out') || '/tmp/institution-main-verification.json'
const only = arg('only')?.split(',')
const seconds = 15
function titleFromInfo(info) {
  let quoted = false
  for (let i = 0; i < info.length; i++) {
    if (info[i] === '"') quoted = !quoted
    else if (info[i] === ',' && !quoted) return info.slice(i + 1)
  }
  return ''
}
async function run(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args), started = Date.now()
    let stdout = '', stderr = '', timedOut = false
    child.stdout.on('data', b => { stdout = (stdout + b).slice(-100000) })
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-5000) })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 80000)
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: e.message }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut, elapsedMs: Date.now() - started }) })
  })
}
const state = await fetch(`${base}/api/extractors`).then(r => r.json())
if (!state.success) throw new Error('主项目模块接口未成功')
const modules = state.data.modules.filter(m => m.category === 'institution')
const playlist = await fetch(`${base}/m3u`).then(r => r.text())
const items = []
let info = ''
for (const line of playlist.split(/\r?\n/)) {
  if (line.startsWith('#EXTINF:')) info = line
  else if (/^https?:/.test(line)) {
    const url = new URL(line), ref = url.pathname.split('/').at(-1)
    const id = modules.find(m => ref.startsWith(`${m.id}-`))?.id
    if (id && (!only || only.includes(id))) items.push({ module: id, institution: modules.find(m => m.id === id).name, title: titleFromInfo(info), kind: titleFromInfo(info).startsWith('[直播]') ? 'live' : 'vod', url: line, ref })
  }
}
const results = [], queue = [...items]
await Promise.all(Array.from({ length: Math.min(queue.length, 3) }, async () => {
  while (queue.length) {
    const item = queue.shift()
    const probe = await run('ffprobe', ['-v', 'error', '-rw_timeout', '25000000', '-show_programs', '-show_streams', '-show_format', '-of', 'json', item.url])
    let media = {}
    try { media = JSON.parse(probe.stdout) } catch {}
    const tracks = selectMediaTracks(media), maps = ['-map', tracks.video ? `0:${tracks.video.index}` : '0:v:0']
    if (tracks.audio) maps.push('-map', `0:${tracks.audio.index}`)
    const decode = probe.code === 0 ? await run('ffmpeg', ['-hide_banner', '-v', 'error', '-rw_timeout', '25000000', '-i', item.url, '-t', String(seconds), ...maps, '-progress', 'pipe:1', '-f', 'null', '-']) : { code: -1, stderr: '未取得媒体信息' }
    const decodedSeconds = Math.max(0, ...[...(decode.stdout || '').matchAll(/out_time_us=(\d+)/g)].map(m => Number(m[1]) / 1000000))
    const frames = Math.max(0, ...[...(decode.stdout || '').matchAll(/frame=(\d+)/g)].map(m => Number(m[1])))
    const ok = probe.code === 0 && decode.code === 0 && tracks.video && tracks.audio && decodedSeconds >= 14.75 && frames > 0
    const result = { ...item, checkedAt: new Date().toISOString(), ok: !!ok, decodedSeconds, ffprobeCode: probe.code, decodeCode: decode.code, selectedVideo: tracks.video, selectedAudio: tracks.audio, duration: Number(media.format?.duration) || null, warnings: [probe.stderr, decode.stderr].filter(Boolean) }
    results.push(result)
    console.log(`${ok ? 'PASS' : 'FAIL'} ${item.module} / ${item.title} · ${decodedSeconds.toFixed(2)}s`)
  }
}))
await mkdir(dirname(out), { recursive: true })
const report = { checkedAt: new Date().toISOString(), base, scope: 'main-project-subscription-and-local-media', decodeTargetSeconds: seconds, modules: modules.map(m => ({ id: m.id, name: m.name, enabled: m.enabled, health: m.health })), tested: results.length, passed: results.filter(i => i.ok).length, failed: results.filter(i => !i.ok).length, live: items.filter(i => i.kind === 'live').length, items: results.sort((a, b) => a.ref.localeCompare(b.ref)) }
await writeFile(out, JSON.stringify(report, null, 2) + '\n')
await writeFile(out.replace(/\.json$/, '.m3u'), playlist)
console.log(`${report.passed}/${report.tested} passed; report ${out}`)
if (!results.length || report.failed) process.exitCode = 1
