// Production transport checks: every endpoint is local or the reserved .invalid
// domain, so this suite never requests an actual broadcaster or CDN.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fetchWithTimeout } from '../extractors/institution/net.js'

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}
async function close(server) {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
async function child(script, env) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script], {
      env: { ...globalThis.process.env, ...env, NODE_USE_ENV_PROXY: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { process.kill('SIGKILL'); reject(new Error('Transport fixture timed out')) }, 5000)
    process.stdout.on('data', data => { stdout += data })
    process.stderr.on('data', data => { stderr += data })
    process.on('error', error => { clearTimeout(timer); reject(error) })
    process.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

test('机构生产请求遵循 HTTPS_PROXY，代理失败不会悄悄改成直连', { timeout: 8000 }, async () => {
  const requests = []
  const proxy = http.createServer()
  proxy.on('connect', (request, socket) => {
    requests.push(request.url)
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  const address = await listen(proxy)
  try {
    const moduleUrl = new URL('../extractors/institution/net.js', import.meta.url).href
    const result = await child(`
      import { fetchWithTimeout } from ${JSON.stringify(moduleUrl)};
      try {
        await fetchWithTimeout('https://institution-network-test.invalid/catalogue', { signal: AbortSignal.timeout(1500) });
        process.exitCode = 2;
      } catch {
        console.log('EXPECTED_PROXY_FAILURE');
      }
    `, { HTTPS_PROXY: address, https_proxy: '' })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /EXPECTED_PROXY_FAILURE/)
    assert.ok(requests.length > 0, 'native fetch 忽略代理时不会产生 CONNECT')
    assert.ok(requests.every(url => url === 'institution-network-test.invalid:443'))
  } finally { await close(proxy) }
})

test('机构请求保留调用方 method、body、headers 与 Web Response 流', { timeout: 5000 }, async () => {
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const data of request) body += data
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ method: request.method, body, marker: request.headers['x-institution-test'], range: request.headers.range }))
  })
  const address = await listen(server)
  try {
    const response = await fetchWithTimeout(`${address}/request`, {
      method: 'POST', body: 'scope=public',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Institution-Test': 'preserved', Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(1500),
    })
    assert.equal(typeof response.body.getReader, 'function', '媒体链路继续收到 Web ReadableStream')
    assert.deepEqual(await response.json(), { method: 'POST', body: 'scope=public', marker: 'preserved', range: 'bytes=0-0' })
  } finally { await close(server) }
})

test('机构请求使用调用方 AbortSignal，取消时释放本机连接', { timeout: 5000 }, async () => {
  let requestStarted, requestClosed
  const started = new Promise(resolve => { requestStarted = resolve })
  const closed = new Promise(resolve => { requestClosed = resolve })
  const server = http.createServer((request, response) => {
    requestStarted()
    response.once('close', requestClosed)
  })
  const address = await listen(server), controller = new AbortController()
  try {
    const rejection = assert.rejects(fetchWithTimeout(`${address}/slow`, { signal: controller.signal }), /caller cancelled/)
    await started
    controller.abort(new Error('caller cancelled'))
    await rejection
    await Promise.race([closed, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('caller abort did not close request')), 1500)
      timer.unref()
    })])
  } finally { await close(server) }
})
