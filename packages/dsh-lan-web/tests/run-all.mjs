/**
 * dsh-lan-web 回归：算法单测 + 网关端到端（用假后端模拟宿主 web 的 401/换 cookie/HTML）。
 * 跑法：tools/run-node.ps1 -Out <txt> tests/run-all.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { startGateway, ensureToken, pickLanIp, POLYFILL_SCRIPT } from '../lib/gateway.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(HERE, '..', '.tmp')
fs.mkdirSync(TMP, { recursive: true })

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) })
}

const BACKEND_TOKEN = 'BACKEND-TOKEN-abc123'
const GATE_TOKEN = 'GATE-TOKEN-xyz789'

/**
 * 假宿主：token 换 cookie，其它请求没有 cookie 就 401 —— 与真实宿主行为一致。
 * 若请求带了 accept-encoding，就真的返回 gzip 体，用来验证网关必须丢掉这个头。
 */
function startFakeBackend() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    if (url.searchParams.get('token') === BACKEND_TOKEN) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'dsh-auth-deadbeef=secret; Path=/; HttpOnly',
      })
      res.end('<html><head><title>boot</title></head><body>boot</body></html>')
      return
    }
    if (!String(req.headers.cookie || '').includes('dsh-auth-deadbeef=secret')) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh web authentication required; reopen the URL printed by dsh web.')
      return
    }
    // 复刻宿主的同源校验：Origin 不是自己这个 host 就 403
    const ownOrigin = `http://127.0.0.1:${req.socket.localPort}`
    if (req.headers.origin !== undefined && req.headers.origin !== ownOrigin) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    const html = '<!doctype html><html><head><title>DSH</title></head><body><div id=app></div></body></html>'
    if (req.headers['accept-encoding']) {
      const zipped = gzipSync(Buffer.from(html, 'utf8'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
      res.end(zipped)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function request(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', agent: false, ...options },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function main() {
  // 1. pickLanIp：跳过回环与虚拟网卡
  const ifaces = {
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    'VMware Network Adapter VMnet8': [{ family: 'IPv4', internal: false, address: '192.168.119.1' }],
    WLAN: [{ family: 'IPv4', internal: false, address: '192.168.1.8' }],
    'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.28.240.1' }],
  }
  check('pickLanIp 选真实网卡', pickLanIp(ifaces, 'auto') === '192.168.1.8', pickLanIp(ifaces, 'auto'))
  check('pickLanIp 显式值优先', pickLanIp(ifaces, '10.0.0.5') === '10.0.0.5')
  check('pickLanIp 无可用网卡回落回环', pickLanIp({ x: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] }, 'auto') === '127.0.0.1')

  // 2. ensureToken：落盘复用 + 形态合法
  const tokenPath = path.join(TMP, 'token-test.txt')
  try { fs.unlinkSync(tokenPath) } catch { /* 首次跑没文件 */ }
  const t1 = ensureToken(tokenPath)
  const t2 = ensureToken(tokenPath)
  check('ensureToken 首次生成', /^[A-Za-z0-9_-]{16,}$/.test(t1), t1.length)
  check('ensureToken 第二次复用', t1 === t2)

  // 3. polyfill 内容
  check('polyfill 覆盖 randomUUID', POLYFILL_SCRIPT.includes('randomUUID') && POLYFILL_SCRIPT.includes('getRandomValues'))

  // 4. 端到端
  const backend = await startFakeBackend()
  let gateway
  try {
    gateway = await startGateway({
      backendPort: backend.port,
      backendToken: BACKEND_TOKEN,
      lanIp: '127.0.0.1',
      lanPort: 0,
      token: GATE_TOKEN,
    })
    check('网关启动', Number.isInteger(gateway.lanPort) && gateway.lanPort > 0, `port=${gateway.lanPort}`)
    check('网关地址带口令', gateway.url.includes(`t=${GATE_TOKEN}`), gateway.url)

    const denied = await request(gateway.lanPort, { path: '/' })
    check('无口令 401', denied.status === 401, denied.status)
    check('401 页给出带口令地址', denied.body.includes(`t=${GATE_TOKEN}`))

    const login = await request(gateway.lanPort, { path: `/?t=${GATE_TOKEN}` })
    check('带口令跳转', login.status === 302, login.status)
    check('跳转目标去掉了口令', login.headers.location === '/', login.headers.location)
    check('种网关 cookie', String(login.headers['set-cookie'] || '').startsWith('dsh-lan='), login.headers['set-cookie'])

    const page = await request(gateway.lanPort, { path: '/', headers: { cookie: `dsh-lan=${GATE_TOKEN}` } })
    check('持 cookie 200', page.status === 200, page.status)
    check('HTML 注入 polyfill', page.body.includes('data-dsh-lan-polyfill'), page.body.slice(0, 80))
    check('不把宿主 cookie 透给手机', !String(page.headers['set-cookie'] || '').includes('dsh-auth-'))

    const sub = await request(gateway.lanPort, { path: '/api/ping', headers: { cookie: `dsh-lan=${GATE_TOKEN}` } })
    check('子路径也带宿主 cookie', sub.status === 200, sub.status)
    check('统计到请求数', gateway.stats.requests >= 2, gateway.stats.requests)

    // 手机浏览器一定带 accept-encoding；网关必须丢掉它，否则注入写进 gzip 体里
    const zipped = await request(gateway.lanPort, {
      path: '/',
      headers: { cookie: `dsh-lan=${GATE_TOKEN}`, 'accept-encoding': 'gzip, br' },
    })
    check('带 accept-encoding 仍拿到明文 HTML', zipped.status === 200 && zipped.body.includes('<html'), zipped.status)
    check('压缩请求下 polyfill 仍在', zipped.body.includes('data-dsh-lan-polyfill'))

    // 手机浏览器会带 Origin: http://192.168.1.8:3099，宿主只认自己的 origin
    const lanOrigin = await request(gateway.lanPort, {
      path: '/',
      headers: { cookie: `dsh-lan=${GATE_TOKEN}`, origin: 'http://192.168.1.8:3099' },
    })
    check('局域网 Origin 被改写（不再 403）', lanOrigin.status === 200, lanOrigin.status)

    const lanReferer = await request(gateway.lanPort, {
      path: '/',
      headers: { cookie: `dsh-lan=${GATE_TOKEN}`, referer: 'http://192.168.1.8:3099/index' },
    })
    check('局域网 Referer 被改写', lanReferer.status === 200, lanReferer.status)
  } finally {
    if (gateway) await gateway.stop()
    await new Promise((resolve) => backend.server.close(resolve))
  }

  const failed = results.filter((r) => !r.ok)
  const payload = { allOk: failed.length === 0, total: results.length, failed: failed.length, results }
  const out = path.join(TMP, 'lan-web-tests.json')
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8')
  console.log(JSON.stringify({ allOk: payload.allOk, total: payload.total, failed: payload.failed, out }))
  if (failed.length) {
    for (const f of failed) console.log(`FAIL ${f.name} :: ${f.detail}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ allOk: false, error: String(error && error.stack ? error.stack : error) }))
  process.exitCode = 1
})
