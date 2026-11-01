/**
 * 桌宠进程管理（把「桌宠」与「悬浮窗/挂件」两形态统一到一个开关下）
 *
 * 两形态其实是同一个程序的两套立绘（skin=大肥鱼 / skin=小鲸鱼挂件），
 * 单实例运行，所以"整合"= 一个生命周期 + 一个形态切换，而不是两个进程。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * 插件不再写死旧的绝对路径。
 * 排序：DSH_PET_DIR 环境变量 → 插件根 config.json 的 petDir → <plugins 根>/_pets/deepseek-dafeiyu-pet
 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGINS_ROOT = path.resolve(HERE, '..', '..')
export const DEFAULT_PET_DIR =
  process.env.DSH_PET_DIR || path.join(PLUGINS_ROOT, '_pets', 'deepseek-dafeiyu-pet')
export const FORM_PET = '大肥鱼'
export const FORM_WIDGET = '小鲸鱼挂件'

export function defaultPythonw() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Python', 'Python312', 'pythonw.exe')
}

export function readPetConfig(petDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(petDir, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

export function writePetConfig(petDir, patch) {
  const current = readPetConfig(petDir)
  const next = { ...current, ...patch }
  fs.writeFileSync(path.join(petDir, 'config.json'), JSON.stringify(next, null, 2), 'utf8')
  return next
}

function runPowerShell(command, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { timeout: timeoutMs, windowsHide: true },
        (error, stdout) => {
          if (error) {
            resolve({ ok: false, out: '' })
            return
          }
          resolve({ ok: true, out: String(stdout || '').trim() })
        },
      )
    } catch {
      // spawn 本身失败（例如受限环境里 EPERM）：当作「查不到」而不是让插件崩
      resolve({ ok: false, out: '' })
    }
  })
}

/** 找出正在跑的桌宠进程（按命令行里的 run_pet.py 认，不误伤别的 python）。 */
export async function listPetProcesses() {
  const res = await runPowerShell(
    "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe' or Name='python.exe'\" | Where-Object { $_.CommandLine -like '*run_pet.py*' } | Select-Object -ExpandProperty ProcessId",
  )
  if (!res.ok || !res.out) return []
  return res.out
    .split(/\s+/)
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x) && x > 0)
}

export async function stopPet(pids) {
  const list = (Array.isArray(pids) ? pids : []).filter((pid) => Number.isInteger(pid) && pid > 0)
  if (list.length === 0) return { ok: true, stopped: [] }
  await runPowerShell(`taskkill /PID ${list.join(' /PID ')} /F | Out-Null`, 10000)
  return { ok: true, stopped: list }
}

// 同一进程里并发调用只允许一次真正的“查—起”，否则会一次开出好几只
let startInFlight = null

/** 启动桌宠：同一时间只跑一次，避免并发调用分身。 */
export async function startPet(options) {
  if (startInFlight) return startInFlight
  startInFlight = startPetInner(options).finally(() => { startInFlight = null })
  return startInFlight
}

/** 启动桌宠，返回新进程 pid（已存在实例时返回 adopted）。 */
async function startPetInner({ petDir, pythonw, form }) {
  if (!petDir || !fs.existsSync(petDir)) {
    return { ok: false, error: `petDir 不存在：${petDir || '(空)'}（把桌宠仓库放到这里，或在 config.json 里改 petDir）` }
  }
  if (form) {
    try {
      writePetConfig(petDir, { skin: form === 'widget' ? FORM_WIDGET : FORM_PET })
    } catch {
      // 配置写不了不影响后续判断
    }
  }
  const existing = await listPetProcesses()
  if (existing.length > 0) {
    // 已经有多只在跑：留最早的那只，其余收掉
    const sorted = [...existing].sort((a, b) => a - b)
    if (sorted.length > 1) await stopPet(sorted.slice(1))
    return { ok: true, pid: sorted[0], adopted: true, deduped: sorted.slice(1) }
  }

  const exe = pythonw && fs.existsSync(pythonw) ? pythonw : defaultPythonw()
  if (!fs.existsSync(exe)) return { ok: false, error: `pythonw 不存在：${exe}` }
  if (!fs.existsSync(path.join(petDir, 'run_pet.py'))) return { ok: false, error: `run_pet.py 不存在：${petDir}` }

  const child = spawn(exe, ['run_pet.py'], {
    cwd: petDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

  // 等它真的起来（最多 8 秒）
  for (let i = 0; i < 16; i += 1) {
    await new Promise((r) => setTimeout(r, 500))
    const pids = await listPetProcesses()
    if (pids.length > 0) {
      // 起来后发现多只（并发/宿主残留）→ 留最早的一只
      const sorted = [...pids].sort((a, b) => a - b)
      const extras = sorted.slice(1)
      if (extras.length > 0) await stopPet(extras)
      return { ok: true, pid: sorted[0], adopted: false, deduped: extras }
    }
  }
  return { ok: false, error: '进程已拉起但 8 秒内没检测到 run_pet.py' }
}

/** 读桌宠当前形态（skin）与运行状态。 */
export async function petStatus({ petDir, pythonw }) {
  const cfg = readPetConfig(petDir)
  const pids = await listPetProcesses()
  return {
    running: pids.length > 0,
    pid: pids[0] ?? null,
    pids,
    form: String(cfg.skin || '') === FORM_WIDGET ? 'widget' : 'pet',
    skin: String(cfg.skin || ''),
    size: cfg.size ?? null,
    mode: cfg.mode ?? null,
    topmost: cfg.topmost ?? null,
    petDir,
    pythonw: pythonw || defaultPythonw(),
    configFound: Object.keys(cfg).length > 0,
    balanceAlways: cfg.balance_always ?? null,
    ballBubble: cfg.bubble_style ?? null,
  }
}

/** 切形态：改 skin 并重启（单实例，必须重启才换立绘）。 */
export async function switchForm({ petDir, pythonw, form }) {
  const pids = await listPetProcesses()
  if (pids.length > 0) await stopPet(pids)
  await new Promise((r) => setTimeout(r, 600))
  return startPet({ petDir, pythonw, form })
}

export function stateFilePath() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'pet-sync.json')
}

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(), 'utf8'))
  } catch {
    return {}
  }
}

export function writeState(patch) {
  const next = { ...readState(), ...patch, updatedAt: Date.now() }
  try {
    fs.mkdirSync(path.dirname(stateFilePath()), { recursive: true })
    fs.writeFileSync(stateFilePath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // 状态文件写不了不影响主流程
  }
  return next
}
