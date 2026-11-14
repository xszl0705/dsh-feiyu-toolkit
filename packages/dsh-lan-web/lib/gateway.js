/**
 * LAN 网关：把宿主只绑 127.0.0.1 的 web 服务暴露到局域网，并补上手机浏览器
 * 在非安全上下文里缺的 crypto.randomUUID。
 *
 * 为什么需要这一层（2026-11-08 实测）：
 *   1. dsh-desktop-host 启动宿主时硬编码 `--host 127.0.0.1 --port 0`，端口随机、
 *      只绑回环，手机无论如何连不上；
 *   2. dsh-host-webserver 明确拒绝 0.0.0.0（会 throw），只接受具体 IP 字面量；
 *   3. 裸访问 127.0.0.1:port 返回 401 `dsh web authentication required`，
 *      launchToken 是进程内随机生成、只经 IPC 交给 Electron 主进程，不落盘，
 *      外部进程拿不到 —— 所以外部代理无法自行认证，必须在宿主进程内取。
 *
 * 认证做法：插件跑在宿主进程里，用 ctx.connection.authenticatedUrl() 拿到带
 * token 的 URL，自己换一次 Set-Cookie 缓存下来，之后每个转发请求都注入它。
 * 手机侧另用网关自己的 token 做闸门（?t=xxx 或 cookie），与宿主的 token 无关。
 */
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const COOKIE_NAME = 'dsh-lan'

/** 非安全上下文缺 crypto.randomUUID；补一个，其它 Web Crypto 能力不动。 */
const POLYFILL = `<script data-dsh-lan-polyfill="1">(function(){try{var c=window.crypto;if(!c||typeof c.randomUUID==='function')return;var f=function(){var b=new Uint8Array(16);if(typeof c.getRandomValues==='function'){c.getRandomValues(b)}else{for(var i=0;i<16;i++)b[i]=Math.floor(Math.random()*256)}b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h='';for(var j=0;j<16;j++){h+=(b[j]+256).toString(16).slice(1)}return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)};try{Object.defineProperty(c,'randomUUID',{value:f,configurable:true,writable:true})}catch(e){c.randomUUID=f}}catch(e){}})()</script>`

/**
 * 手机端「僵尸页面」自愈。
 *
 * 2026-11-09 实测：HarmonyOS / 手机浏览器在切后台、锁屏、长时间不动时会把 /api/remote.mux
 * 这条 WebSocket 静默掐断，前端不一定重连 —— UI 还在，但「新会话」「历史会话」这类操作
 * 全都发不出去，用户看到的就是「点了没反应」。刷新页面就好，但没人会一直刷。
 *
 * 做法：包一层 WebSocket，只盯 remote.mux。连接断了以后持续观察 8 秒，期间如果前端自己
 * 重连成功（收到 open）就不管；一直没重连就 location.reload() 一次，并做 60 秒节流，
 * 避免后端真挂时变成无限刷新。
 */
const MUX_GUARD = `<script data-dsh-lan-mux-guard="1">(function(){try{var Native=window.WebSocket;if(!Native||Native.__lanGuard)return;var last=Date.now(),timer=null;function arm(){if(timer)return;timer=setInterval(function(){var idle=Date.now()-last;if(idle<8000)return;clearInterval(timer);timer=null;try{var k='dsh-lan-reload-at',at=Number(sessionStorage.getItem(k)||0);if(Date.now()-at>60000){sessionStorage.setItem(k,String(Date.now()));location.reload()}}catch(e){}},3000)}function Guarded(u,p){var ws=(p===undefined)?new Native(u):new Native(u,p);if(String(u).indexOf('remote.mux')>=0){ws.addEventListener('open',function(){last=Date.now()});ws.addEventListener('close',function(){last=Date.now();arm()})}return ws}Guarded.prototype=Native.prototype;Guarded.CONNECTING=0;Guarded.OPEN=1;Guarded.CLOSING=2;Guarded.CLOSED=3;Guarded.__lanGuard=1;try{Object.defineProperty(window,'WebSocket',{value:Guarded,configurable:true,writable:true})}catch(e){window.WebSocket=Guarded}}catch(e){}})()</script>`

/** 网关自己的访问 token：落盘复用，重启不变，方便手机存书签。 */
export function ensureToken(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim()
    if (/^[A-Za-z0-9_-]{16,}$/.test(value)) return value
  } catch {
    // 文件不存在，往下生成
  }
  const created = crypto.randomBytes(18).toString('base64url')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, created, 'utf8')
  } catch {
    // 落盘失败仍然用本次的 token
  }
  return created
}

/** 选一个能对外用的 IPv4：优先 192.168 / 10 / 172.16-31，跳过回环与虚拟网卡名。 */
export function pickLanIp(interfaces, preferred) {
  if (preferred && preferred !== 'auto') return preferred
  const candidates = []
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' && item.family !== 4) continue
      if (item.internal) continue
      const address = item.address
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) continue
      let score = 0
      if (address.startsWith('192.168.')) score = 30
      else if (address.startsWith('10.')) score = 20
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score = 20
      if (/vmware|virtualbox|vethernet|hyper-v|wsl|loopback|docker/i.test(name)) score -= 15
      candidates.push({ address, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates.length ? candidates[0].address : '127.0.0.1'
}

function tokenFromUrl(url) {
  try {
    return new URL(url).searchParams.get('token') || ''
  } catch {
    return ''
  }
}

/** 用宿主 launchToken 换一次认证 cookie，缓存起来给所有转发请求用。 */
export function exchangeCookie({ host = '127.0.0.1', port, token, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path: `/?token=${encodeURIComponent(token)}`, method: 'GET', timeout: timeoutMs },
      (res) => {
        const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
        const list = raw.length ? raw : [res.headers['set-cookie']].flat().filter(Boolean)
        const pairs = []
        for (const line of list) {
          for (const piece of String(line).split(/,(?=[^;]+=)/)) {
            const pair = piece.split(';')[0].trim()
            if (pair.includes('=')) pairs.push(pair)
          }
        }
        res.resume()
        if (!pairs.length) {
          reject(new Error(`exchange: no Set-Cookie (status ${res.statusCode})`))
          return
        }
        resolve({ cookie: pairs.join('; '), status: res.statusCode })
      },
    )
    req.on('timeout', () => req.destroy(new Error('exchange timeout')))
    req.on('error', reject)
    req.end()
  })
}

function parseCookies(header) {
  const out = {}
  for (const piece of String(header || '').split(';')) {
    const at = piece.indexOf('=')
    if (at < 0) continue
    out[piece.slice(0, at).trim()] = piece.slice(at + 1).trim()
  }
  return out
}

/**
 * 宿主按「自己看到的 host」做同源校验：收到 Origin 是 192.168.x 的请求，
 * /api 直接 403（2026-11-08 实测：Origin 192.168.1.8:3099 → 403，
 * Origin 127.0.0.1:53226 或无 Origin → 404 说明已过闸）。
 * 所以转发前把 Origin / Referer 改写成后端自己的 origin。
 */
function rewriteOriginHeaders(headers, backendHost, backendPort) {
  const backendOrigin = `http://${backendHost}:${backendPort}`
  if (headers.origin) headers.origin = backendOrigin
  if (headers.referer) headers.referer = String(headers.referer).replace(/^https?:\/\/[^/]+/i, backendOrigin)
  return headers
}

function authorized(req, url, token) {
  if (url.searchParams.get('t') === token) return true
  const cookies = parseCookies(req.headers.cookie)
  return cookies[COOKIE_NAME] === token
}

function injectPolyfill(html) {
  let out = html
  if (!out.includes('data-dsh-lan-polyfill')) {
    out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${POLYFILL}</head>`) : POLYFILL + out
  }
  if (!out.includes('data-dsh-lan-mux-guard')) {
    out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${MUX_GUARD}</head>`) : MUX_GUARD + out
  }
  return out
}

/**
 * 起网关。返回 { url, lanIp, lanPort, backendPort, stop(), stats }。
 * 任何一步失败都抛错，由调用方兜住，不影响宿主。
 */
export async function startGateway(options) {
  const {
    backendPort,
    backendHost = '127.0.0.1',
    backendToken,
    lanIp,
    lanPort,
    token,
    accessLog = '',
    onLog = () => {},
  } = options
  if (!backendPort || backendToken === undefined) throw new Error('gateway: backendPort/backendToken required')

  const { cookie: backendCookie } = await exchangeCookie({ host: backendHost, port: backendPort, token: backendToken })
  onLog(`backend cookie ready (${backendHost}:${backendPort})`)

  // 访问日志：没有它就无法区分「手机根本没打到网关」和「打到了被挡下」。
  // 超过 2MB 轮转一份 .1，只保留最近两代，避免无限增长。
  let accessBytes = 0
  try {
    accessBytes = accessLog ? fs.statSync(accessLog).size : 0
  } catch {
    accessBytes = 0
  }
  const writeAccess = (line) => {
    if (!accessLog) return
    const text = `${new Date().toISOString()} ${line}\n`
    accessBytes += Buffer.byteLength(text)
    if (accessBytes > 2 * 1024 * 1024) {
      try {
        fs.renameSync(accessLog, `${accessLog}.1`)
      } catch {
        // 轮转失败就继续往原文件写
      }
      accessBytes = 0
    }
    fs.appendFile(accessLog, text, () => {})
  }
  const who = (req, socket) => {
    const ip = (socket && socket.remoteAddress) || (req.socket && req.socket.remoteAddress) || '-'
    const ua = String((req.headers && req.headers['user-agent']) || '-').replace(/[\r\n]/g, ' ').slice(0, 120)
    return `${ip} "${ua}"`
  }

  const stats = { requests: 0, upgrades: 0, since: new Date().toISOString(), errors: 0 }

  const server = http.createServer((req, res) => {
    const started = Date.now()
    let label = req.url || '/'
    res.on('finish', () => {
      writeAccess(`http ${who(req)} ${req.method} ${label} -> ${res.statusCode} ${Date.now() - started}ms`)
    })
    let url
    try {
      url = new URL(req.url || '/', 'http://lan.local')
      label = `${url.pathname}${url.search}`
    } catch {
      writeAccess(`http ${who(req)} ${req.method} ${label} -> 400 bad-request`)
      res.writeHead(400).end('bad request')
      return
    }

    if (!authorized(req, url, token)) {
      const target = `http://${lanIp}:${lanPort}/?t=${encodeURIComponent(token)}`
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(
        `<!doctype html><meta charset="utf-8"><title>需要口令</title>` +
          `<body style="font:15px/1.7 system-ui;padding:8vh 6vw;color:#233"><h2>这个入口要口令</h2>` +
          `<p>点这里带上口令重新打开：</p><p><a href="${target}">${target}</a></p>` +
          `<p style="color:#777">口令保存在主机的 dsh-lan-web/token.txt，改了就重新复制。</p></body>`,
      )
      return
    }

    // 带 ?t= 的第一次访问：种自己的 cookie 并跳回干净路径，避免口令留在地址栏
    if (url.searchParams.get('t') === token) {
      url.searchParams.delete('t')
      const clean = `${url.pathname}${url.search}`
      res.writeHead(302, {
        location: clean || '/',
        'set-cookie': `${COOKIE_NAME}=${token}; Path=/; Max-Age=2592000; SameSite=Lax`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }

    stats.requests += 1
    // 诊断开关：?plain=1 跳过 HTML 注入（polyfill / mux 自愈都不加）。
    // 手机端出问题时分两次打开：带 plain 与不带 plain，哪个正常就是哪段注入的锅。
    const noInject = url.searchParams.get('plain') === '1'
    const headers = { ...req.headers }
    headers.host = `${backendHost}:${backendPort}`
    headers.cookie = backendCookie
    headers['x-forwarded-for'] = req.socket.remoteAddress || ''
    headers['x-forwarded-host'] = `${lanIp}:${lanPort}`
    headers['x-forwarded-proto'] = 'http'
    // 绝不接受压缩：HTML 要做 polyfill 注入，压缩体会把注入写坏
    delete headers['accept-encoding']
    // 宿主按自己的 host 做同源校验：手动 Origin 来自 192.168.x 一律 403（实测）
    rewriteOriginHeaders(headers, backendHost, backendPort)

    const upstream = http.request(
      { host: backendHost, port: backendPort, path: `${url.pathname}${url.search}`, method: req.method, headers },
      (upstreamRes) => {
        const type = String(upstreamRes.headers['content-type'] || '')
        const outHeaders = { ...upstreamRes.headers }
        delete outHeaders['transfer-encoding']
        // 后端种的 cookie 名按 127.0.0.1 算，直接透传会污染手机侧；只保留非 dsh-auth 的
        if (outHeaders['set-cookie']) {
          const kept = [outHeaders['set-cookie']]
            .flat()
            .filter((line) => !String(line).startsWith('dsh-auth-') && !String(line).startsWith(COOKIE_NAME + '='))
          if (kept.length) outHeaders['set-cookie'] = kept
          else delete outHeaders['set-cookie']
        }

        if (type.includes('text/html')) {
          const chunks = []
          upstreamRes.on('data', (chunk) => chunks.push(chunk))
          upstreamRes.on('end', () => {
            const body = noInject
              ? Buffer.concat(chunks).toString('utf8')
              : injectPolyfill(Buffer.concat(chunks).toString('utf8'))
            const buf = Buffer.from(body, 'utf8')
            outHeaders['content-length'] = String(buf.length)
            // 宿主重启会换端口和 boot 数据，HTML 一旦被浏览器缓存，手机就会对着旧页面死连。
            outHeaders['cache-control'] = 'no-store, must-revalidate'
            res.writeHead(upstreamRes.statusCode || 200, outHeaders)
            res.end(buf)
          })
          upstreamRes.on('error', (error) => {
            stats.errors += 1
            onLog(`html stream error: ${error.message}`)
            try { res.destroy() } catch { /* ignore */ }
          })
          return
        }

        res.writeHead(upstreamRes.statusCode || 200, outHeaders)
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      stats.errors += 1
      onLog(`upstream error: ${error.message}`)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`gateway: 后端不可达 ${error.message}`)
    })
    req.pipe(upstream)
  })

  // WebSocket / 其它 upgrade：原始 TCP 转发，Host 与 cookie 按后端需要改写
  server.on('upgrade', (req, socket, head) => {
    stats.upgrades += 1
    const tag = who(req, socket)
    let url
    try {
      url = new URL(req.url || '/', 'http://lan.local')
    } catch {
      writeAccess(`ws-bad-url ${tag} ${req.url || '/'}`)
      socket.destroy()
      return
    }
    if (!authorized(req, url, token)) {
      writeAccess(`ws-401 ${tag} ${url.pathname}`)
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const upstream = net.connect(backendPort, backendHost, () => {
      writeAccess(`ws-open ${tag} ${url.pathname}${url.search}`)
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      const headers = { ...req.headers, host: `${backendHost}:${backendPort}`, cookie: backendCookie }
      rewriteOriginHeaders(headers, backendHost, backendPort)
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue
        lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head && head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    // 只保护「建连后迟迟不回握手响应」这一小段：后端刚重启时可能接受连接却不说话，
    // 手机侧就卡在「发出去了没回音」。
    // ★不再对整条隧道挂 10 秒空闲超时 —— 长连接（/api/remote.mux）静默十几秒是常态，
    //   空闲即 destroy 等于每隔几秒掐一次线，前端只能反复重连。收到后端第一个字节就撤掉计时器。
    upstream.setTimeout(10000, () => {
      stats.errors += 1
      writeAccess(`ws-timeout ${tag} ${url.pathname}${url.search} 后端 10s 无响应`)
      try { upstream.destroy() } catch { /* ignore */ }
      try { socket.destroy() } catch { /* ignore */ }
    })
    upstream.once('data', () => {
      try { upstream.setTimeout(0) } catch { /* ignore */ }
    })
    upstream.on('error', (error) => {
      stats.errors += 1
      writeAccess(`ws-error ${tag} ${url.pathname}${url.search} ${error.message}`)
      try { socket.destroy() } catch { /* ignore */ }
    })
    socket.on('error', () => { try { upstream.destroy() } catch { /* ignore */ } })
    socket.on('close', () => { writeAccess(`ws-close ${tag} ${url.pathname}${url.search}`) })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(lanPort, lanIp, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const bound = server.address()
  const actualPort = bound && typeof bound === 'object' ? bound.port : lanPort
  const url = `http://${lanIp}:${actualPort}/?t=${encodeURIComponent(token)}`
  onLog(`gateway listening ${lanIp}:${actualPort} -> ${backendHost}:${backendPort}`)

  return {
    url,
    lanIp,
    lanPort: actualPort,
    backendPort,
    stats,
    stop: () =>
      new Promise((resolve) => {
        try {
          server.close(() => resolve(true))
        } catch {
          resolve(false)
        }
      }),
  }
}

export const POLYFILL_SCRIPT = POLYFILL
export const COOKIE_FOR_TEST = COOKIE_NAME
