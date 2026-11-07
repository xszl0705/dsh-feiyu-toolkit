/**
 * 桌宠进程管理（把「桌宠」与「悬浮窗/挂件」两形态统一到一个开关下）
 *
 * 两形态其实是同一个程序的两套立绘（skin=大肥鱼 / skin=小鲸鱼挂件），
 * 单实例运行，所以"整合"= 一个生命周期 + 一个形态切换，而不是两个进程。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isAlive, listOwnProcesses, stopOwnProcess } from './process.js'

/**
 * 插件不再写死旧的写死路径。
 * 排序：DSH_PET_DIR 环境变量 → 插件根 config.json 的 petDir → <plugins 根>/_pets/deepseek-dafeiyu-pet
 *
 * 2026-11-04 修复：kit 通过 dsh-plugins/node_modules 的 junction 被 import 时，
 * fileURLToPath 拿到的是 junction 路径（…\dsh-plugins\node_modules\dsh-plugin-kit\lib），
 * PLUGINS_ROOT 会错成 node_modules，petDir 永远不存在。用 realpath 沿 junction 回到真实目录。
 */
function realDir(fileUrl) {
  try {
    return path.dirname(fs.realpathSync(fileURLToPath(fileUrl)))
  } catch {
    return path.dirname(fileURLToPath(fileUrl))
  }
}

const HERE = realDir(import.meta.url)
export const PLUGINS_ROOT = path.resolve(HERE, '..', '..')

const PET_PACKAGE = 'deepseek-dafeiyu-pet'

/**
 * 依次找「真的有 run_pet.py」的桌宠目录。
 * - 源码版：kit 在 <dsh-plugins>/dsh-plugin-kit/lib → PLUGINS_ROOT = <dsh-plugins>
 * - junction 版：kit 经 <dsh-plugins>/node_modules 解析 → PLUGINS_ROOT = node_modules，要往上一级找
 * 2026-11-04：realpath 对 junction 不可靠（实测仍返回 node_modules 路径），所以用目录探测兜底。
 */
export function resolveDefaultPetDir() {
  if (process.env.DSH_PET_DIR) return process.env.DSH_PET_DIR
  const candidates = [
    path.join(PLUGINS_ROOT, '_pets', PET_PACKAGE),
    path.join(PLUGINS_ROOT, '..', '_pets', PET_PACKAGE),
    path.join(HERE, '..', '..', '..', '_pets', PET_PACKAGE),
  ]
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'run_pet.py'))) return dir
    } catch {
      // 换下一个候选
    }
  }
  return candidates[0]
}

export const DEFAULT_PET_DIR = resolveDefaultPetDir()
export const FORM_PET = '大肥鱼'
export const FORM_WIDGET = '小鲸鱼挂件'

export function defaultPythonw() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Python', 'Python312', 'pythonw.exe')
}

export function readPetConfig(petDir) {
  // 优先用桌宠自己报的路径：打包版（frozen）把配置写在 %APPDATA%\大肥鱼桌宠，
  // 和 petDir 不是同一个地方；spawn 的是源码版时这俩恰好一样。状态文件里带 paths.config。
  const candidates = []
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const state = JSON.parse(fs.readFileSync(path.join(home, 'pet', 'state.json'), 'utf8'))
    if (state && state.paths && state.paths.config) candidates.push(state.paths.config)
  } catch {
    // 还没有 state.json：按老规矩读 petDir
  }
  candidates.push(path.join(petDir, 'config.json'))
  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      // 换下一个候选
    }
  }
  return {}
}

export function writePetConfig(petDir, patch) {
  const current = readPetConfig(petDir)
  const next = { ...current, ...patch }
  fs.writeFileSync(path.join(petDir, 'config.json'), JSON.stringify(next, null, 2), 'utf8')
  return next
}

/** 找出正在跑的桌宠进程（按自有进程清单里的 pet 类，不误伤别的 python）。 */
export async function listPetProcesses() {
  const { pet } = await listOwnProcesses()
  return pet.map((p) => p.pid)
}

/** 停桌宠：复用 kit/process 的安全停止，pid 必须在自有 pet 清单里。 */
export async function stopPet(pids) {
  return stopOwnProcess('pet', pids)
}

/**
 * 清掉「进程已经不在」时留下的 pet.pid 与 state.json running 标记。
 * 2026-11-04 掉线修复：桌宠单实例靠 pet.pid 判断，进程被 kill 后 pid 文件会留下，
 * 下次启动可能被误判成「已有实例」；state.json 的 running 也会过期。
 */
export function clearStalePetState(petDir) {
  try {
    const pidFile = path.join(petDir, 'pet.pid')
    if (fs.existsSync(pidFile)) {
      const pid = Number(String(fs.readFileSync(pidFile, 'utf8')).trim())
      if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) fs.rmSync(pidFile, { force: true })
    }
  } catch {
    // 清不掉不影响启动
  }
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const file = path.join(home, 'pet', 'state.json')
    if (!fs.existsSync(file)) return
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (state && state.running && !isAlive(Number(state.pid))) {
      state.running = false
      state.pid = null
      state.droppedAt = new Date().toISOString()
      fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
    }
  } catch {
    // 状态文件写不了不影响启动
  }
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
  // 2026-11-04：启动前清残留（pet.pid / state.json 的过期 running），否则会被误判成已有实例。
  clearStalePetState(petDir)
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
  let lastLog = ''
  try {
    const lines = fs.readFileSync(path.join(petDir, 'pet-instance.log'), 'utf8').trim().split('\n')
    lastLog = lines[lines.length - 1] || ''
  } catch {
    // 没有日志就只报超时
  }
  return { ok: false, error: '进程已拉起但 8 秒内没检测到 run_pet.py' + (lastLog ? `（最近日志：${lastLog}）` : '') }
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
  if (pids.length > 0) {
    const stopped = await stopPet(pids)
    if (!stopped.ok) return { ok: false, error: stopped.error }
  }
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
