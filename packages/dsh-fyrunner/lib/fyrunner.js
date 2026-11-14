/**
 * dsh-fyrunner —— FyRunner 进程托管层。
 *
 * 设计要点：
 *  1. 不起 pywebview 窗口：本机没装 pywebview，且插件场景下用浏览器打开更自然。
 *     runtime/ 里跑 run.py（纯标准库），headless。
 *  2. 日志由 Python 侧写 runtime/.python.log（run.py 里重定向 stdout/stderr）。
 *     Node 侧一律 stdio:'ignore'——沙箱下传 fd 会 EPERM，捕获管道也会 EPERM。
 *  3. 状态以「端口 + /api/health 返回的 pid」为准；pid 文件只是记录，丢了也能从服务自己问出来。
 *  4. 所有失败都返回结构化对象，不抛错（execute 抛错会让调用方拿不到诊断信息）。
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = path.join(PLUGIN_ROOT, 'runtime')
const RUN_PY = path.join(RUNTIME, 'run.py')
const STATE_FILE = path.join(RUNTIME, '.runtime.json')
const LOG_FILE = path.join(RUNTIME, '.python.log')

const DEFAULTS = {
  pythonPath: '',
  port: 8760,
  dataDir: '',
  startTimeoutMs: 20000,
}

export function runtimePaths() {
  return { pluginRoot: PLUGIN_ROOT, runtime: RUNTIME, stateFile: STATE_FILE, logFile: LOG_FILE }
}

export function readConfig() {
  try {
    const raw = fs.readFileSync(path.join(PLUGIN_ROOT, 'config.json'), 'utf8')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

/* ───────────── 进程 / 健康 ───────────── */

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // 状态文件写不了不影响服务本身
  }
}

function clearState() {
  try {
    fs.rmSync(STATE_FILE, { force: true })
  } catch {
    // ignore
  }
}

export function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** /api/health 返回 {version,time,pid,port}；拿不到返回 null。 */
export async function health(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const json = await res.json()
    return json && json.ok ? json.data : null
  } catch {
    return null
  }
}

function portListening(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (v) => {
      try {
        socket.destroy()
      } catch {
        // ignore
      }
      resolve(v)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function findFreePort(start, tries = 20) {
  for (let p = start; p < start + tries; p += 1) {
    if (!(await portListening(p))) return p
  }
  return start
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/* ───────────── Python 探测 ───────────── */

const PY_CANDIDATES = [
  () => path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
  () => path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
  () => path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'python.exe'),
  () => 'C:\\Python312\\python.exe',
  () => 'C:\\Python311\\python.exe',
  () => 'C:\\Python310\\python.exe',
]

/**
 * 用 --version 复核候选。沙箱下 execFileSync 捕获会 EPERM，
 * 所以拿不到输出时退回「文件存在即认」，真正的失败留到 start 的健康检查里暴露。
 */
function probePython(p) {
  try {
    const out = execFileSync(p, ['--version'], { encoding: 'utf8', timeout: 6000, windowsHide: true })
    const m = /Python (\d+)\.(\d+)/.exec(out || '')
    if (m) return { path: p, version: `${m[1]}.${m[2]}`, verified: true }
    return { path: p, version: String(out || '').trim(), verified: true }
  } catch {
    if (p.includes('\\') && fs.existsSync(p)) return { path: p, version: 'unknown', verified: false }
    return null
  }
}

export function findPython(cfg = readConfig()) {
  const tried = []
  const explicit = [cfg.pythonPath, process.env.FYRUNNER_PYTHON].filter(Boolean)
  for (const p of explicit) {
    tried.push(p)
    const hit = probePython(p)
    if (hit) return hit
  }
  for (const make of PY_CANDIDATES) {
    const p = make()
    if (!p || tried.includes(p)) continue
    tried.push(p)
    if (fs.existsSync(p)) {
      const hit = probePython(p)
      if (hit) return hit
    }
  }
  for (const name of ['python', 'python3', 'py']) {
    tried.push(name)
    const hit = probePython(name)
    if (hit) return hit
  }
  return { path: '', version: '', verified: false, tried }
}

/* ───────────── 日志 ───────────── */

function tailLog(maxLines = 40) {
  try {
    const text = fs.readFileSync(LOG_FILE).toString('utf8')
    return text.split(/\r?\n/).slice(-maxLines).join('\n').trim()
  } catch {
    return ''
  }
}

export function logs(lines = 40) {
  const text = tailLog(Math.max(1, Math.min(300, lines)))
  // 注意：这里不能带 undefined 字段——工具返回值必须是可无损 JSON 化的
  return { ok: true, logFile: LOG_FILE, logTail: text || '（日志为空）' }
}

/* ───────────── 启停 ───────────── */

export async function start(opts = {}) {
  const cfg = { ...readConfig(), ...opts }
  const wantPort = Number(cfg.port) || 8760

  // 已在跑：先按端口探健康，避免重复起进程
  const existingState = readState()
  const existingPort = existingState?.port || wantPort
  const alive = await health(existingPort)
  if (alive) {
    return {
      ok: true,
      running: true,
      alreadyRunning: true,
      port: existingPort,
      url: `http://127.0.0.1:${existingPort}`,
      pid: alive.pid || existingState?.pid || null,
      version: alive.version,
    }
  }

  const port = wantPort === existingPort ? await findFreePort(wantPort) : wantPort

  const py = findPython(cfg)
  if (!py.path) {
    return {
      ok: false,
      running: false,
      error: '找不到可用的 Python（3.10+）',
      hint: '在插件 config.json 里填 pythonPath，或设环境变量 FYRUNNER_PYTHON',
      tried: py.tried || [],
    }
  }

  const env = {
    ...process.env,
    FY_PORT: String(port),
    PYTHONIOENCODING: 'utf-8',
    FYRUNNER_SHARE: '',
  }
  if (cfg.dataDir) env.FYRUNNER_DATA = String(cfg.dataDir)

  let pid = null
  let spawnError = null
  try {
    // stdio:'ignore'：日志由 run.py 自己写文件，避免沙箱下的句柄/管道 EPERM
    const child = spawn(py.path, [RUN_PY], {
      cwd: RUNTIME,
      env,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    })
    pid = child.pid ?? null
    child.on('error', () => {})
    child.unref()
  } catch (error) {
    // 沙箱下可能同步抛错，但进程有时已经起来了——不立刻判死，交给健康检查裁决
    spawnError = String(error?.message || error)
  }

  const timeout = Number(cfg.startTimeoutMs) || DEFAULTS.startTimeoutMs
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    await sleep(300)
    last = await health(port)
    if (last) break
    if (pid && !pidAlive(pid)) break
  }

  if (!last) {
    return {
      ok: false,
      running: false,
      port,
      pid,
      error: spawnError
        ? '启动进程失败：' + spawnError
        : '服务在 ' + timeout + 'ms 内没应答 /api/health',
      logTail: tailLog(),
      hint: '常见原因：端口被占、Python 版本过低、runtime/server.py 起不来',
    }
  }

  const realPid = last.pid || pid
  writeState({ pid: realPid, port, startedAt: Date.now(), python: py.path })
  return {
    ok: true,
    running: true,
    alreadyRunning: false,
    port,
    pid: realPid,
    url: `http://127.0.0.1:${port}`,
    version: last.version,
    python: py.version,
  }
}

/**
 * 结束进程：先走 Node 内置 process.kill（Windows 上就是 TerminateProcess，不需要外部程序），
 * 不行再退回 taskkill 杀整棵树。不捕获任何子进程输出——沙箱下管道会 EPERM。
 */
function killTree(pid) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('error', () => resolve(false))
      child.on('exit', (code) => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}

async function terminate(pid) {
  let signalled = false
  try {
    process.kill(pid)
    signalled = true
  } catch {
    signalled = false
  }
  await sleep(1200)
  if (!pidAlive(pid)) return { ok: true, via: 'process.kill' }

  const taskkilled = await killTree(pid)
  await sleep(800)
  if (!pidAlive(pid)) return { ok: true, via: taskkilled ? 'taskkill' : 'process.kill' }

  return { ok: false, via: signalled ? 'process.kill' : 'none' }
}

export async function stop(opts = {}) {
  const cfg = { ...readConfig(), ...opts }
  const state = readState()
  const port = state?.port || Number(cfg.port) || 8760

  const alive = await health(port)
  let pid = alive?.pid || state?.pid || null
  if (pid && !pidAlive(pid)) pid = null

  if (!alive && !pid) {
    clearState()
    return { ok: true, running: false, alreadyStopped: true, port }
  }
  if (!pid) {
    return {
      ok: false,
      running: true,
      port,
      error: `端口 ${port} 有 FyRunner 在跑，但拿不到 pid；不盲杀`,
      hint: '手动结束该 python 进程，或改 config.json 的 port',
    }
  }

  const killed = await terminate(pid)

  // 进程没了还不够，要等端口真正释放
  let stillUp = true
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    await sleep(300)
    if (!(await health(port, 800))) {
      stillUp = false
      break
    }
  }

  if (stillUp) {
    // 保留 state，方便下一次 stop 继续用同一个 pid
    return {
      ok: false,
      running: true,
      port,
      pid,
      error: '结束进程失败（' + killed.via + '），端口仍应答',
      hint: '可能需要管理员权限；或手动结束该 python 进程',
    }
  }

  clearState()
  return { ok: true, running: false, port, pid, stopped: true, via: killed.via }
}

export async function status(opts = {}) {
  const cfg = { ...readConfig(), ...opts }
  const state = readState()
  const port = state?.port || Number(cfg.port) || 8760
  const h = await health(port)
  const py = findPython(cfg)

  if (!h) {
    const listening = await portListening(port)
    return {
      ok: true,
      running: false,
      port,
      portListening: listening,
      python: py.path || null,
      pythonVersion: py.version || null,
      hint: listening
        ? '端口有程序在听但不是 FyRunner，或被别的实例占用'
        : '用 fyrunner(action=start) 启动',
    }
  }

  let mods = null
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/mods`, { signal: AbortSignal.timeout(1500) })
    const json = await res.json()
    mods = Array.isArray(json?.data) ? json.data.length : null
  } catch {
    // ignore
  }

  let model = null
  let provider = null
  try {
    const rc = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'config.json'), 'utf8'))
    provider = rc.provider || null
    model = rc.provider === 'ollama' ? rc.ollama_model : rc.api_model
  } catch {
    // ignore
  }

  return {
    ok: true,
    running: true,
    port,
    pid: h.pid || state?.pid || null,
    url: `http://127.0.0.1:${port}`,
    version: h.version,
    mods,
    provider,
    model,
    startedAt: state?.startedAt || null,
  }
}

export async function openInBrowser(opts = {}) {
  const st = await start(opts)
  if (!st.ok) return st
  let opened = false
  try {
    const child = spawn('cmd.exe', ['/c', `start "" "${st.url}"`], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    })
    child.on('error', () => {})
    child.unref()
    opened = true
  } catch (error) {
    return { ...st, opened: false, error: '服务在跑，但打开浏览器失败：' + String(error?.message || error) }
  }
  return { ...st, opened }
}

/* ───────────── 工具定义 ───────────── */

const ACTIONS = ['status', 'start', 'stop', 'open', 'restart', 'logs']

export function createFyrunnerTools() {
  const tool = {
    name: 'fyrunner',
    description:
      '托管 FyRunner 跑团引擎：status 查运行状态、start 起本地服务、stop 停、open 起服务并开浏览器、restart 重启、logs 看 Python 日志。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'status=查状态；start=启动；stop=停止；open=启动并打开浏览器；restart=重启；logs=看日志',
        },
        lines: { type: 'number', description: 'logs 时返回最后多少行，默认 40' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          running: { type: 'boolean' },
          port: { type: 'number' },
          url: { type: 'string' },
          pid: { type: 'number' },
          version: { type: 'string' },
          mods: { type: 'number' },
          provider: { type: 'string' },
          model: { type: 'string' },
          opened: { type: 'boolean' },
          alreadyRunning: { type: 'boolean' },
          logTail: { type: 'string' },
          hint: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value) return [{ type: 'text', text: '（无结果）' }]
        if (value.ok === false) {
          const lines = ['失败：' + (value.error || '未知错误')]
          if (value.hint) lines.push('· ' + value.hint)
          if (value.logTail) lines.push('日志尾部：\n' + value.logTail)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (value.logTail !== undefined) {
          return [{ type: 'text', text: value.logTail || '（日志为空）' }]
        }
        if (value.running) {
          const bits = [`运行中 · ${value.url}`]
          if (value.pid) bits.push(`pid ${value.pid}`)
          if (value.mods !== undefined && value.mods !== null) bits.push(`MOD ${value.mods}`)
          if (value.model) bits.push(`模型 ${value.model}`)
          if (value.alreadyRunning) bits.push('（本来就在跑）')
          if (value.opened) bits.push('已打开浏览器')
          return [{ type: 'text', text: bits.join(' · ') }]
        }
        return [
          { type: 'text', text: '未运行（端口 ' + (value.port || '?') + '）' + (value.hint ? '，' + value.hint : '') },
        ]
      },
    },
    timeoutMs: 45000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const action = String(args?.action || 'status')
      if (action === 'status') return status()
      if (action === 'start') return start()
      if (action === 'stop') return stop()
      if (action === 'open') return openInBrowser()
      if (action === 'restart') {
        const stopped = await stop()
        const started = await start()
        return { ...started, stoppedFirst: stopped.ok }
      }
      if (action === 'logs') return logs(Number(args?.lines) || 40)
      return { ok: false, running: false, error: '未知 action：' + action }
    },
  }

  return [tool]
}
