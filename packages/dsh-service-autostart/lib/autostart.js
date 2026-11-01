/**
 * 客户端启动时的服务自愈：QQ（NapCat）没连上就静默拉起，微心跳没在跑也静默拉起。
 *
 * 为什么放在插件里而不是外部 watchdog：
 * 外部 watchdog 若由 DSH 工具启动，会继承 agent 的沙箱，spawn 子进程直接 EPERM
 * （实测 NapCat 报 `spawn EPERM`）。插件跑在宿主进程里，没有这层限制。
 *
 * 所有拉起都用 detached + windowsHide + stdio:ignore，不弹任何窗口。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const DEFAULTS = {
  enabled: true,
  napcat: {
    enabled: true,
    root: '',
    launcher: 'start-hidden.vbs',
    port: 3001,
    webuiPort: 6099,
    cooldownMs: 30000,
    slowCooldownMs: 10 * 60 * 1000,
    fastFailures: 8,
  },
  mindLoop: {
    enabled: true,
    script: '',
    node: '',
    pidFile: '',
    cooldownMs: 10 * 60 * 1000,
  },
}

/** 只测「端口有没有人听」，不发任何协议数据。 */
export function portOpen(port, { host = '127.0.0.1', timeoutMs = 900 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ host, port })
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export function readPid(file) {
  try {
    return Number.parseInt(String(fs.readFileSync(file, 'utf8')).trim(), 10)
  } catch {
    return 0
  }
}

/** detached + 全隐藏：进程活过宿主，且永远不弹控制台。 */
export function launchHidden(file, args, options = {}) {
  const child = spawn(file, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    ...options,
  })
  child.on('error', () => {})
  child.unref()
  return child
}

function merge(base, override) {
  const out = { ...base }
  for (const [key, value] of Object.entries(override || {})) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...(base[key] || {}), ...value } : value
  }
  return out
}

/** 记一条自愈决策到 self 日志；self 不在就跳过。 */
function logDecision(entry) {
  try {
    const self = globalThis[Symbol.for('dsh-feiyu-self.service')]
    self?.record?.({ channel: 'qq', kind: 'autostart', ...entry })
  } catch {
    // 日志不可用不影响自愈
  }
}

export async function ensureNapCat({ config = {}, state = {}, note = () => {}, probe = portOpen, launch = launchHidden } = {}) {
  const merged = merge(DEFAULTS, config.autostart || {})
  const cfg = merged.napcat
  if (!merged.enabled) return { action: 'disabled' }

  // WebUI 还活着说明 NapCat 正在启动/登录中，别再拉第二个。
  if (await probe(cfg.port)) {
    state.napcatFailures = 0
    return { action: 'up' }
  }
  if (await probe(cfg.webuiPort)) {
    state.napcatFailures = 0
    return { action: 'starting' }
  }

  const failures = Number(state.napcatFailures) || 0
  const cooldown = failures >= cfg.fastFailures ? cfg.slowCooldownMs : cfg.cooldownMs
  if (Date.now() - (Number(state.napcatTriedAt) || 0) < cooldown) return { action: 'cooldown' }

  // 优先用 NapCat 自带的 node 直启：链路最短，输出能落到日志，失败才有据可查。
  // 只有找不到 node/index.js 时才退回 wscript（那条链路的重定向曾经静默失败过）。
  const nodeExe = path.join(cfg.root, 'node.exe')
  const entry = path.join(cfg.root, 'index.js')
  const launcher = path.join(cfg.root, cfg.launcher)
  const useNode = fs.existsSync(nodeExe) && fs.existsSync(entry)
  if (!useNode && !fs.existsSync(launcher)) {
    state.napcatFailures = failures + 1
    return { action: 'missing-launcher', launcher }
  }

  state.napcatTriedAt = Date.now()
  state.napcatFailures = failures + 1
  const target = useNode
    ? { file: nodeExe, args: [entry] }
    : { file: path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe'), args: [launcher] }

  const logFile = path.join(cfg.root, 'napcat-autostart.log')
  let fd
  try {
    fd = fs.openSync(logFile, 'a')
    fs.writeSync(fd, `\n=== autostart ${new Date().toISOString()} attempt=${state.napcatFailures} mode=${useNode ? 'node' : 'wscript'} ===\n`)
  } catch {
    fd = undefined
  }
  try {
    const options = { cwd: cfg.root }
    if (fd !== undefined) options.stdio = ['ignore', fd, fd]
    launch(target.file, target.args, options)
    note(`QQ 未连接，已静默拉起 NapCat（第 ${state.napcatFailures} 次，${useNode ? 'node 直启' : 'wscript'}）`)
    logDecision({ choice: 'launched', reason: `attempt=${state.napcatFailures} mode=${useNode ? 'node' : 'wscript'}` })
    return { action: 'launched', attempts: state.napcatFailures, mode: useNode ? 'node' : 'wscript' }
  } catch (error) {
    note('拉起 NapCat 失败：' + String(error?.message || error))
    logDecision({ choice: 'failed', reason: String(error?.message || error).slice(0, 120) })
    return { action: 'error', error: String(error?.message || error) }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // 子进程已继承句柄
      }
    }
  }
}

export async function ensureMindLoop({ config = {}, state = {}, note = () => {}, launch = launchHidden, exists = fs.existsSync } = {}) {
  const cfg = merge(DEFAULTS, config.autostart || {}).mindLoop
  if (!cfg.enabled) return { action: 'disabled' }

  const pid = readPid(cfg.pidFile)
  if (pidAlive(pid)) return { action: 'running', pid }
  if (Date.now() - (Number(state.mindLoopTriedAt) || 0) < cfg.cooldownMs) return { action: 'cooldown' }
  if (!exists(cfg.script)) return { action: 'missing-script', script: cfg.script }

  const node = exists(cfg.node) ? cfg.node : process.execPath
  const env = node === process.execPath ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : { ...process.env }
  state.mindLoopTriedAt = Date.now()
  try {
    launch(node, [cfg.script], { cwd: path.dirname(cfg.script), env })
    note('微心跳没在跑，已静默拉起 mind-loop')
    return { action: 'launched', pidFile: cfg.pidFile }
  } catch (error) {
    note('拉起微心跳失败：' + String(error?.message || error))
    return { action: 'error', error: String(error?.message || error) }
  }
}

export async function ensureServices({ config = {}, state = {}, note = () => {}, probe, launch } = {}) {
  const napcat = await ensureNapCat({ config, state, note, probe, launch })
  const mindLoop = await ensureMindLoop({ config, state, note, launch })
  return { napcat, mindLoop }
}
