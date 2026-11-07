import { lifecycle } from 'dsh-plugin-kit/lifecycle'
import { toolsOrRetry } from 'dsh-plugin-kit/wait-for-tools'
import { note as kitNote } from 'dsh-plugin-kit/note'
/**
 * dsh-screenshot — 让模型自己看屏幕。
 *
 * 用 Windows 自带的 GDI+（System.Drawing）抓屏，落盘到工作区，返回路径；
 * 之后用 read_image 读这张图就行，不用用户再截图上传。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-screenshot'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'scripts', 'screenshot.ps1')
const TMP = path.join(HERE, '.tmp')
fs.mkdirSync(TMP, { recursive: true })

/** 客户端「截图」按钮用的端点：抓一张全屏 PNG，二进制直接回给浏览器。 */
const ROUTE = '/dsh-screenshot/capture'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const DEFAULTS = {
  outDir: path.join(DSH_HOME, 'screens'),
  maxWidth: 1400,
  keepFiles: 80,
}

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
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

/** 用「stdout/stderr 重定向到文件」的方式跑脚本：不用管道，受限环境也能跑。 */
function runScript(args, timeoutMs = 45000) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const outFile = path.join(TMP, `out-${stamp}.txt`)
  const errFile = path.join(TMP, `err-${stamp}.txt`)
  const fdOut = fs.openSync(outFile, 'w')
  const fdErr = fs.openSync(errFile, 'w')
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], {
    stdio: ['ignore', fdOut, fdErr],
    windowsHide: true,
  })
  fs.closeSync(fdOut)
  fs.closeSync(fdErr)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      reject(new Error('截图脚本超时'))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
      const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : ''
      try {
        fs.unlinkSync(outFile)
        fs.unlinkSync(errFile)
      } catch {
        // ignore
      }
      if (code === 0) resolve(stdout)
      else reject(new Error((stderr || stdout || `exit ${code}`).slice(0, 300)))
    })
  })
}

function prune(dir, keep) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.png'))
      .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
    for (const item of files.slice(Math.max(1, keep))) {
      fs.unlinkSync(path.join(dir, item.name))
    }
  } catch {
    // 清理失败不影响截图
  }
}

async function takeShot(config, { window = '', maxWidth = null, noScale = false } = {}) {
  const dir = String(config.outDir || DEFAULTS.outDir)
  const width = Number(maxWidth || config.maxWidth || DEFAULTS.maxWidth)
  const args = ['-OutDir', dir, '-MaxWidth', String(width)]
  if (window) args.push('-Window', String(window))
  if (noScale) args.push('-NoScale')
  const stdout = await runScript(args)
  const line = stdout.split(/\r?\n/).find((row) => row.startsWith('OK ')) || ''
  const file = line.slice(3).trim()
  if (!file) throw new Error('截图脚本没有返回路径：' + stdout.slice(0, 200))
  let meta = null
  try {
    meta = JSON.parse(fs.readFileSync(file + '.json', 'utf8'))
    fs.unlinkSync(file + '.json')
  } catch {
    meta = null
  }
  prune(dir, Number(config.keepFiles) || DEFAULTS.keepFiles)
  const stat = fs.existsSync(file) ? fs.statSync(file) : null
  return {
    path: meta?.path || file,
    width: Number(meta?.width) || 0,
    height: Number(meta?.height) || 0,
    title: String(meta?.title || ''),
    bytes: stat ? stat.size : 0,
  }
}

/**
 * 截图端点的请求处理：一次只跑一张，忙时回 429，不排队。
 *
 * 2026-11-01 审计补的两道闸：
 *   1. 来源校验 —— 只接受同源请求。恶意网页可以写 `<img src="http://127.0.0.1:<port>/dsh-screenshot/capture">`
 *      反复触发抓屏（读不到图片内容，但能耗资源、还能卡准时机），Sec-Fetch-Site 把它挡住。
 *      本机进程直接请求不带这个头，那种请求本来就有系统级抓屏能力，不算被这个端点放大。
 *   2. 频率上限 —— 60 秒内最多 20 次，防止被脚本刷。
 */
const MAX_SHOTS_PER_MINUTE = 20

function makeCaptureHandler(config, state) {
  return (req, res) => {
    const reject = (code, error) => {
      try {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error }))
      } catch {
        // ignore
      }
    }

    // 1) 来源
    const site = String(req.headers?.['sec-fetch-site'] || '')
    if (site && site !== 'same-origin' && site !== 'none') {
      reject(403, '只接受同源请求')
      return
    }

    // 2) 频率
    const now = Date.now()
    state.shotTimes = (Array.isArray(state.shotTimes) ? state.shotTimes : []).filter((t) => now - t < 60000)
    if (state.shotTimes.length >= MAX_SHOTS_PER_MINUTE) {
      reject(429, `抓屏太频繁（每分钟上限 ${MAX_SHOTS_PER_MINUTE} 次）`)
      return
    }

    if (state.capturing) {
      reject(429, '截图进行中，请稍后再试')
      return
    }
    state.capturing = true
    state.shotTimes.push(now)
    takeShot(config, {})
      .then((shot) => {
        const buf = fs.readFileSync(shot.path)
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': buf.length,
          'cache-control': 'no-store',
          'x-shot-path': encodeURIComponent(shot.path),
          'x-shot-meta': `${shot.width}x${shot.height}`,
        })
        res.end(buf)
      })
      .catch((error) => {
        try {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error).slice(0, 300) }))
        } catch {
          // ignore
        }
      })
      .finally(() => {
        state.capturing = false
      })
  }
}

/**
 * 挂上「截图」端点。webServer 可能比插件晚就绪，所以和 tools 一样按 250ms 重试，
 * 最多等 60 秒；等不到就只少一个按钮功能，宿主照常跑。
 */
function registerRoute(ctx, config, state) {
  if (state.routeRegistered) return
  let webServer = null
  try {
    webServer = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : null
  } catch {
    webServer = null
  }
  if (!webServer || typeof webServer.register !== 'function') {
    if (!state.webSince) state.webSince = Date.now()
    if (state.webWaiting) return
    if (Date.now() - state.webSince > 60000) return
    state.webWaiting = true
    state.later(() => {
      state.webWaiting = false
      try {
        registerRoute(ctx, config, state)
      } catch (error) {
        note('重试注册截图路由失败：' + String((error && error.message) || error))
      }
    }, 250)
    return
  }
  try {
    const handle = webServer.register({ kind: 'exact', path: ROUTE, handler: makeCaptureHandler(config, state) })
    state.routeRegistered = true
    // 注册结果交回宿主托管，插件卸载时跟着释放（否则 lifecycle 会留下孤儿路由）
    if (handle && typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        try {
          if (typeof handle === 'function') handle()
          else handle.dispose?.()
        } catch {
          // 释放失败不影响卸载
        }
        state.routeRegistered = false
      })
    }
    note('dsh-screenshot 路由就绪：GET ' + ROUTE)
  } catch (error) {
    note('注册截图路由失败：' + String((error && error.message) || error))
  }
}

export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const message = String((error && error.message) || error)
    safeLog(ctx, 'warn', 'dsh-screenshot 加载失败：' + message)
    note('apply 抛错：' + message)
    return undefined
  }
}

function applyInner(ctx) {
  const config = loadConfig()
  const state = lifecycle(ctx, () => ({ registered: false }))
  // 路由独立于 tools：即使 tools 还没就绪，对话框上的截图按钮也能先通
  registerRoute(ctx, config, state)
  if (state.registered) return

  const tools = toolsOrRetry(ctx, state, () => applyInner(ctx), {
    warn: (seconds) => note(`${seconds}s 内没等到 tools 服务，screenshot 未注册`),
    log: (message) => note(message),
  })
  if (!tools) return
  state.registered = true

  const shots = []
  ctx.effect(() => {
    const tool = tools.register({
      name: 'screenshot',
      description: '截屏：take 截一张（window/maxWidth/noScale），windows 列窗口；返回 PNG 路径，之后可直接读图。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['take', 'windows'], description: '要做的事' },
          window: { type: 'string', description: '窗口标题关键词；省略=全屏' },
          maxWidth: { type: 'number', description: '缩放最大宽度，默认 1400' },
          noScale: { type: 'boolean', description: 'true 不缩放（更清晰更费 token）' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' }, path: { type: 'string' }, width: { type: 'number' },
            height: { type: 'number' }, title: { type: 'string' }, error: { type: 'string' },
            windows: { type: 'array', items: { type: 'object', properties: { pid: { type: 'number' }, process: { type: 'string' }, title: { type: 'string' } } } },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.action === 'windows'
            ? (value.windows.length ? value.windows.map((w) => `${w.pid}\t${w.process}\t${w.title}`).join('\n') : '没有枚举到带标题的窗口')
            : `已截图：${value.path}（${value.width}x${value.height} ${value.title}）`,
        }],
      },
      timeoutMs: 45000,
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const action = String(args?.action || 'take')
        if (action === 'take') {
          const shot = await takeShot(config, args || {})
          shots.push({ ...shot, at: Date.now() })
          if (shots.length > 20) shots.shift()
          return { ...shot, action }
        }
        if (action === 'windows') {
          const stdout = await runScript(['-List'])
          const windows = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const [pid, processName, ...rest] = line.split('\t')
              return { pid: Number(pid) || 0, process: processName || '', title: rest.join('\t') }
            })
          return { windows, action }
        }
        return { ok: false, action, error: '未知 action：' + action }
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

  note(`dsh-screenshot ready（${config.outDir}，screenshot）`)
}

/** 测试用：直接调一次截图。 */
export async function capture(options = {}) {
  return takeShot(loadConfig(), options)
}
