/**
 * 自有 OS 子进程的统一视图与安全停止（方案 v3 · 2.4）。
 *
 * 只认三类可管理进程，**绝不接管宿主（DSH desktop）与未知进程**：
 * - pet      python / pythonw，命令行含 run_pet.py
 * - mindLoop node / electron，命令行含 mind-loop.mjs
 * - verifyx  DSH 进程，命令行带 `--profile verifyx`
 *
 * 第四类 SnowLuma（QQ 桥）生命周期归用户 / SnowLuma 自己维护，这里只提供
 * `portOpen` 探测，不列进程、不停进程——桥挂了要用户自己决定怎么处理。
 *
 * 纪律：
 * 1. 列进程只有一条 PowerShell 路径（Get-CimInstance 侧先过滤，输出很小）。
 * 2. 停进程前必须用自有清单校验 pid 属于目标类别；不在清单里的一律拒绝（防误杀宿主）。
 * 3. 停止后按 pid 复核存活；报成功但进程还在算失败。
 */

import { execFile } from 'node:child_process'
import net from 'node:net'

export const KINDS = ['pet', 'mindLoop', 'verifyx']

const LIST_SCRIPT =
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'run_pet\\.py|mind-loop\\.mjs|--profile[ =]verifyx' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"

function runPowerShell(command, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve({ ok: false, out: '' })
            return
          }
          resolve({ ok: true, out: String(stdout || '').trim() })
        },
      )
    } catch {
      // spawn 本身失败（受限环境 EPERM）：当作「查不到」，不让调用方崩
      resolve({ ok: false, out: '' })
    }
  })
}

/**
 * 单条进程行的分类（纯函数，便于单测）。不认识的返回 null。
 * @param {{ pid?: number|string, name?: string, cmd?: string }} row
 * @returns {'pet'|'mindLoop'|'verifyx'|null}
 */
export function classifyProcess(row = {}) {
  const name = String(row.name || '').toLowerCase()
  const cmd = String(row.cmd || '')
  if ((name === 'python.exe' || name === 'pythonw.exe') && /run_pet\.py/i.test(cmd)) return 'pet'
  if (/mind-loop\.mjs/i.test(cmd)) return 'mindLoop'
  // 只认 `--profile verifyx`，不认路径里恰好出现 verifyx（desktop 实例必须排除）
  if (/(^|\s)--profile[=\s]+verifyx(?:\s|$|"|')/i.test(cmd)) return 'verifyx'
  return null
}

/** 一次列出全部自有进程，按类别分组。查不到时返回空分组而不是抛错。 */
export async function listOwnProcesses({ run = runPowerShell } = {}) {
  const groups = { pet: [], mindLoop: [], verifyx: [] }
  const res = await run(LIST_SCRIPT)
  if (!res.ok || !res.out) return groups
  let rows
  try {
    const parsed = JSON.parse(res.out)
    rows = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return groups
  }
  for (const row of rows) {
    const kind = classifyProcess({ name: row.Name, cmd: row.CommandLine })
    if (!kind) continue
    groups[kind].push({
      pid: Number(row.ProcessId),
      name: String(row.Name || ''),
      cmd: String(row.CommandLine || ''),
    })
  }
  return groups
}

/** 进程是否活着。EPERM = 还在但没权限动它；只有 ESRCH 才是真的不在了。 */
export function isAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

/** 只测「端口有没有人听」，不发任何协议数据（SnowLuma 探测也走这里）。 */
export function portOpen(port, { host = '127.0.0.1', timeoutMs = 900 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let socket = null
    const done = (value) => {
      if (settled) return
      settled = true
      try {
        socket?.destroy()
      } catch {
        // socket 可能还没建出来
      }
      resolve(value)
    }
    try {
      socket = net.connect({ host, port })
    } catch {
      done(false)
      return
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function defaultKill(pids) {
  const args = pids.map((pid) => `/PID ${pid}`).join(' ')
  return runPowerShell(`taskkill /F ${args} | Out-Null`, 10000)
}

const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 安全停止自有进程：pid 必须出现在对应类别的自有清单里，否则拒绝。
 * 返回 { ok, stopped, rejected, alive?, error? }。
 */
export async function stopOwnProcess(kind, pids, { list = listOwnProcesses, kill = defaultKill, wait = defaultWait, alive = isAlive } = {}) {
  if (!KINDS.includes(kind)) return { ok: false, stopped: [], rejected: [], error: `不支持的进程类别：${kind}` }
  const wanted = [...new Set((Array.isArray(pids) ? pids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))]
  if (wanted.length === 0) return { ok: true, stopped: [], rejected: [] }

  const snapshot = await list()
  const allowed = new Set((snapshot[kind] || []).map((p) => Number(p.pid)))
  const rejected = wanted.filter((pid) => !allowed.has(pid))
  const targets = wanted.filter((pid) => allowed.has(pid))
  if (targets.length === 0) {
    return { ok: false, stopped: [], rejected, error: `pid 不在自有 ${kind} 清单里，拒绝停止` }
  }

  const result = await kill(targets)
  await wait(500)
  const stillAlive = targets.filter((pid) => alive(pid))
  const stopped = targets.filter((pid) => !stillAlive.includes(pid))
  if (stillAlive.length > 0) {
    return {
      ok: false,
      stopped,
      rejected,
      alive: stillAlive,
      error: `taskkill 后仍有进程存活：${stillAlive.join(', ')}${result?.ok ? '' : '（taskkill 执行失败）'}`,
    }
  }
  return { ok: true, stopped, rejected }
}
