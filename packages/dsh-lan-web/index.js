import { lifecycle } from 'dsh-plugin-kit/lifecycle'
import { toolsOrRetry } from 'dsh-plugin-kit/wait-for-tools'
import { note as kitNote } from 'dsh-plugin-kit/note'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureToken, pickLanIp, startGateway } from './lib/gateway.js'

/**
 * dsh-lan-web — 把桌面客户端的 web 界面开到局域网，手机/平板直接用浏览器跟进同一个会话。
 *
 * 背景（2026-11-08 实测）：
 *   - dsh-desktop-host 启动宿主时写死 `--host 127.0.0.1 --port 0`，端口随机且只绑回环；
 *   - dsh-host-webserver 拒绝 0.0.0.0，只接受具体 IP 字面量；
 *   - 宿主 web 口对裸请求返回 401，launchToken 只存在于宿主进程内存里。
 * 所以对外暴露必须由宿主进程内的插件来做：拿端口、拿 token、换 cookie，
 * 再用一个独立监听在局域网 IP 上的网关转发。
 */

export const name = 'dsh-lan-web'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  lanIp: 'auto',
  lanPort: 3099,
  autoStart: true,
  bootTimeoutMs: 120000,
}

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function tokenFile() {
  return path.join(HERE, 'token.txt')
}

function note(message) {
  kitNote(HERE, message)
}

function safeLog(ctx, level, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
  } catch {
    // ignore
  }
}

/** 等宿主把 webServer / connection 两个服务挂上（首次启动要几秒）。 */
function waitForServices(ctx, timeoutMs, onGiveUp) {
  return new Promise((resolve) => {
    const started = Date.now()
    const probe = () => {
      try {
        const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
        const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
        if (
          webServer &&
          connection &&
          typeof webServer.port === 'number' &&
          webServer.port > 0 &&
          typeof connection.authenticatedUrl === 'function'
        ) {
          return { webServer, connection }
        }
      } catch {
        // 服务未就绪时 get 可能抛错，下一轮再试
      }
      return undefined
    }
    const first = probe()
    if (first) {
      resolve(first)
      return
    }
    const timer = setInterval(() => {
      const hit = probe()
      if (hit) {
        clearInterval(timer)
        resolve(hit)
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        onGiveUp?.()
        resolve(undefined)
      }
    }, 400)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function backendTokenOf(connection, port) {
  const url = connection.authenticatedUrl(`http://127.0.0.1:${port}`)
  const token = new URL(url).searchParams.get('token')
  if (!token) throw new Error('authenticatedUrl 里没有 token')
  return token
}

export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const message = String((error && error.message) || error)
    safeLog(ctx, 'warn', 'dsh-lan-web 加载失败：' + message)
    note('apply 抛错：' + message)
    return undefined
  }
}

function applyInner(ctx) {
  const config = loadConfig()
  const state = lifecycle(ctx, () => ({ registered: false, gateway: undefined, lastError: '', starting: false }))

  const snapshot = () => ({
    running: Boolean(state.gateway),
    url: state.gateway?.url || '',
    lanIp: state.gateway?.lanIp || '',
    lanPort: state.gateway?.lanPort || config.lanPort,
    backendPort: state.gateway?.backendPort || 0,
    requests: state.gateway?.stats?.requests ?? 0,
    upgrades: state.gateway?.stats?.upgrades ?? 0,
    lastError: state.lastError || '',
  })

  const ensureStarted = async () => {
    if (state.gateway || state.starting) return snapshot()
    state.starting = true
    try {
      const services = await waitForServices(ctx, config.bootTimeoutMs, () => {
        note(`${config.bootTimeoutMs / 1000}s 内没等到 webServer/connection`)
      })
      if (!services) {
        state.lastError = 'webServer/connection 未就绪'
        return snapshot()
      }
      const port = services.webServer.port
      const backendToken = backendTokenOf(services.connection, port)
      // 宿主可能绑回环（桌面壳）也可能绑局域网 IP（dsh web --host）；按实际绑定地址连
      const bindHost = String(services.webServer.host || '')
      const backendHost = !bindHost || /^(127\.|::1$|localhost$)/.test(bindHost) ? '127.0.0.1' : bindHost
      const lanIp = pickLanIp(os.networkInterfaces(), config.lanIp)
      const token = ensureToken(tokenFile())
      const gateway = await startGateway({
        backendPort: port,
        backendHost,
        backendToken,
        lanIp,
        lanPort: config.lanPort,
        token,
        accessLog: path.join(HERE, 'access.log'),
        onLog: (message) => note(message),
      })
      state.gateway = gateway
      state.lastError = ''
      note(`局域网入口就绪：${gateway.url}`)
      return snapshot()
    } catch (error) {
      state.lastError = String((error && error.message) || error)
      note('网关启动失败：' + state.lastError)
      return snapshot()
    } finally {
      state.starting = false
    }
  }

  if (config.autoStart) {
    // 不阻塞 apply：宿主启动期间服务还没挂上，异步等
    ensureStarted().catch(() => {})
  }

  if (state.registered) return
  const tools = toolsOrRetry(ctx, state, () => applyInner(ctx), {
    warn: (seconds) => note(`${seconds}s 内没等到 tools 服务，lan_web 未注册`),
    log: (message) => note(message),
  })
  if (!tools) return
  state.registered = true

  ctx.effect(() => {
    const tool = tools.register({
      name: 'lan_web',
      description: '局域网入口：把桌面客户端的 web 界面开放到手机浏览器。status 看地址与状态，start 起网关，stop 停。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'start', 'stop'], description: '要做的事' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            running: { type: 'boolean' },
            url: { type: 'string' },
            lanIp: { type: 'string' },
            lanPort: { type: 'number' },
            backendPort: { type: 'number' },
            requests: { type: 'number' },
            upgrades: { type: 'number' },
            lastError: { type: 'string' },
            hint: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const lines = []
          if (value.running) {
            lines.push(`局域网入口：${value.url}`)
            lines.push(`监听 ${value.lanIp}:${value.lanPort} → 本机 127.0.0.1:${value.backendPort}`)
            lines.push(`请求 ${value.requests ?? 0} 次，WebSocket 升级 ${value.upgrades ?? 0} 次`)
            lines.push('手机连同一个 WiFi，直接打开上面这个地址（带 ?t= 口令，首次打开后会跳成干净地址并记住一个月）。')
            lines.push('打不开先看防火墙：Windows 防火墙没放行这个端口时，手机侧会一直转圈。')
          } else {
            lines.push('局域网入口没起：' + (value.lastError || '未启动'))
            lines.push('先确认宿主 web 服务活着，再 action=start 重试。')
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      timeoutMs: 30000,
      isConcurrencySafe: true,
      execute: async (args) => {
        const action = args && args.action
        if (action === 'stop') {
          const gateway = state.gateway
          state.gateway = undefined
          if (gateway) {
            await gateway.stop().catch(() => {})
            note('网关已停止')
          }
          return { action, ...snapshot() }
        }
        if (action === 'start') {
          const snap = await ensureStarted()
          return { action, ...snap }
        }
        const snap = await ensureStarted()
        return { action: 'status', ...snap }
      },
    })
    return () => {
      try {
        tool?.dispose?.()
      } catch {
        // ignore
      }
    }
  })
}
