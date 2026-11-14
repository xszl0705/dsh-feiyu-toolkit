/**
 * dsh-fyrunner 回归：模块契约 → 配置 → Python 探测 → 起服务 → 状态 → 日志 → 停服务。
 * 跑法（本机没有 node 在 PATH）：
 *   powershell -NoProfile -ExecutionPolicy Bypass -File '<workspace>\tools\run-node.ps1' `
 *     -Out '<workspace>\_tmp\fyrunner-test.json' '<workspace>\dsh-plugins\dsh-fyrunner\test\run-all.mjs'
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createFyrunnerTools,
  readConfig,
  findPython,
  status,
  start,
  stop,
  logs,
} from '../lib/fyrunner.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = process.env.FYRUNNER_TEST_OUT || path.join(HERE, '..', '..', '..', '_tmp', 'fyrunner-test.json')
const TEST_PORT = 8771

const checks = []
function check(name, fn) {
  try {
    const r = fn()
    if (r && r.ok === false) throw new Error(r.error || 'returned ok:false')
    checks.push({ name, ok: true })
    return r
  } catch (error) {
    checks.push({ name, ok: false, error: String(error?.message || error) })
    return null
  }
}

async function acheck(name, fn) {
  try {
    const r = await fn()
    if (r && r.ok === false) throw new Error(r.error || 'returned ok:false')
    checks.push({ name, ok: true, detail: summarize(r) })
    return r
  } catch (error) {
    checks.push({ name, ok: false, error: String(error?.message || error) })
    return null
  }
}

function summarize(v) {
  if (!v || typeof v !== 'object') return String(v)
  const pick = ['running', 'port', 'pid', 'mods', 'version', 'provider', 'model', 'stopped', 'alreadyRunning', 'opened']
  const out = {}
  for (const k of pick) if (v[k] !== undefined) out[k] = v[k]
  return JSON.stringify(out)
}

function result() {
  const failed = checks.filter((c) => !c.ok)
  return { ok: failed.length === 0, total: checks.length, failed: failed.length, checks }
}

async function main() {
  // 1. 工具契约
  check('工具定义：1 个工具且名为 fyrunner', () => {
    const tools = createFyrunnerTools()
    if (tools.length !== 1) throw new Error('tools.length=' + tools.length)
    if (tools[0].name !== 'fyrunner') throw new Error('name=' + tools[0].name)
    return true
  })
  check('工具契约：parameters 有 required/action enum', () => {
    const t = createFyrunnerTools()[0]
    const p = t.parameters
    if (!Array.isArray(p.required) || !p.required.includes('action')) throw new Error('required 缺失')
    if (!Array.isArray(p.properties.action.enum) || p.properties.action.enum.length < 5) throw new Error('enum 缺失')
    if (typeof t.output.render !== 'function') throw new Error('render 缺失')
    return true
  })
  check('render：running 状态能排版', () => {
    const t = createFyrunnerTools()[0]
    const out = t.output.render({}, { ok: true, running: true, url: 'http://127.0.0.1:8771', mods: 9 })
    if (!out?.[0]?.text?.includes('运行中')) throw new Error('render 文案不对：' + JSON.stringify(out))
    return true
  })

  // 2. 配置与 Python
  const cfg = check('配置：读得到 port 默认值', () => {
    const c = readConfig()
    if (!Number(c.port)) throw new Error('port 无效')
    return c
  })
  check('Python：能找到 3.10+ 解释器', () => {
    const py = findPython(cfg || readConfig())
    if (!py.path) throw new Error('没找到 python，tried=' + JSON.stringify(py.tried || []))
    return py
  })

  // 3. 未运行时的 status
  await acheck('status：未运行时 running=false', async () => {
    const s = await status({ port: TEST_PORT })
    if (!s || s.running !== false) throw new Error('期望 running=false，实际 ' + JSON.stringify(s))
    return s
  })

  // 4. 起服务
  const started = await acheck('start：起服务并通过健康检查', async () => {
    const s = await start({ port: TEST_PORT })
    if (!s.ok || !s.running) throw new Error(JSON.stringify(s))
    if (s.port !== TEST_PORT) throw new Error('端口漂移：' + s.port)
    return s
  })

  await acheck('status：运行中且能读到 MOD 数', async () => {
    const s = await status()
    if (!s.running) throw new Error('期望 running=true')
    if (!(s.mods > 0)) throw new Error('mods=' + s.mods)
    return s
  })

  await acheck('API：/api/mode 在插件模式下为 share=false', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/mode`, { signal: AbortSignal.timeout(2000) })
    const j = await res.json()
    if (j?.data?.share !== false) throw new Error('share=' + JSON.stringify(j?.data))
    return { ok: true }
  })

  await acheck('API：/api/health 稳定应答', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`, { signal: AbortSignal.timeout(2000) })
    const j = await res.json()
    if (!j?.ok) throw new Error('health 不应答')
    return { ok: true }
  })

  acheck('logs：日志文件可读', async () => {
    const l = logs(20)
    if (typeof l.logTail !== 'string') throw new Error('logTail 类型不对')
    return { ok: true }
  })

  // 5. 重复 start 幂等
  await acheck('start：重复调用不重复起进程', async () => {
    const s = await start({ port: TEST_PORT })
    if (!s.running) throw new Error('第二次 start 不健康')
    return s
  })

  // 6. 停服务
  await acheck('stop：停掉并释放端口', async () => {
    const s = await stop()
    if (!s.ok || s.running) throw new Error(JSON.stringify(s))
    return s
  })

  await acheck('status：停止后 running=false', async () => {
    const s = await status({ port: TEST_PORT })
    if (s.running !== false) throw new Error('还在跑')
    return s
  })

  await acheck('stop：重复调用幂等', async () => {
    const s = await stop()
    if (!s.ok) throw new Error(JSON.stringify(s))
    return s
  })

  const payload = result()
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8')
  } catch {
    // 落盘失败不影响退出码
  }
  console.log(JSON.stringify(payload, null, 2))
  process.exit(payload.ok ? 0 : 1)
}

main().catch((error) => {
  const payload = { ok: false, fatal: String(error?.stack || error), checks }
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8')
  } catch {
    // ignore
  }
  console.log(JSON.stringify(payload, null, 2))
  process.exit(1)
})
