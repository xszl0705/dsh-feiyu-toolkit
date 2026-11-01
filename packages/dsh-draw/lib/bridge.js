/**
 * bridge —— 调用 Python 渲染脚本的桥。
 *
 * 本机沙箱对 child_process 的 piped stdio（默认 stdio:'pipe'）返回 EPERM，
 * 所以**不能用 stdout 传结果**。改用文件做 IPC：
 *   参数写进 spec.json → python 读 → 结果写 result.json → JS 读回来
 * 子进程 stdio 全部 ignore，不碰管道。
 *
 * 依赖：本机 pip 在沙箱里写盘被拒（Errno 13），matplotlib 以 wheel 解压后的
 * 目录形式固化在插件 pylibs/ 里，运行时通过 PYTHONPATH 注入。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.dirname(HERE)
export const PYLIB_DIR = path.join(PLUGIN_ROOT, 'pylibs')
export const PY_DIR = path.join(HERE, 'py')
const TMP_DIR = path.join(PLUGIN_ROOT, '.tmp')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

/** 按优先级找 Python：显式配置 > 环境变量 > DSH 自带运行时。 */
export function findPython(explicit) {
  if (explicit && fs.existsSync(explicit)) return { path: explicit, from: 'config' }
  const fromEnv = process.env.DSH_PYTHON
  if (fromEnv && fs.existsSync(fromEnv)) return { path: fromEnv, from: 'env' }

  const runtimes = path.join(DSH_HOME, 'dsh-runtimes')
  try {
    for (const dir of fs.readdirSync(runtimes)) {
      const candidate = path.join(runtimes, dir, 'dependencies', 'python', 'python.exe')
      if (fs.existsSync(candidate)) return { path: candidate, from: 'dsh-runtime' }
    }
  } catch {
    // 没有 dsh-runtimes 目录
  }
  return { path: '', from: 'none' }
}

export function pythonEnv() {
  const env = { ...process.env }
  env.PYTHONPATH = fs.existsSync(PYLIB_DIR)
    ? PYLIB_DIR + (env.PYTHONPATH ? path.delimiter + env.PYTHONPATH : '')
    : env.PYTHONPATH || ''
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONUTF8 = '1'
  env.MPLBACKEND = 'Agg'
  return env
}

/**
 * 跑一个脚本，返回脚本写出的结果 JSON。
 * @param {string} script  lib/py 下的文件名，如 'chart.py'
 * @param {object} spec    传给脚本的参数
 * @param {{pythonPath?:string, timeoutMs?:number}} opts
 */
export async function runPython(script, spec, opts = {}) {
  const { pythonPath, timeoutMs = 30000 } = opts
  const py = findPython(pythonPath)
  if (!py.path) {
    return {
      ok: false,
      reason: 'PYTHON_NOT_FOUND',
      error: '没找到 Python 解释器：请在 config.json 里配 pythonPath，或设置环境变量 DSH_PYTHON',
    }
  }
  const scriptFile = path.join(PY_DIR, script)
  if (!fs.existsSync(scriptFile)) {
    return { ok: false, reason: 'SCRIPT_MISSING', error: `脚本不存在: ${scriptFile}` }
  }

  fs.mkdirSync(TMP_DIR, { recursive: true })
  const tag = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  const specFile = path.join(TMP_DIR, `${tag}.spec.json`)
  const resultFile = path.join(TMP_DIR, `${tag}.result.json`)

  try {
    fs.writeFileSync(specFile, JSON.stringify(spec), 'utf8')
  } catch (error) {
    return { ok: false, reason: 'IO_FAILED', error: String(error?.message || error) }
  }

  const cleanup = () => {
    for (const f of [specFile, resultFile]) {
      try {
        fs.unlinkSync(f)
      } catch {
        // 清理失败不影响结果
      }
    }
  }

  const code = await new Promise((resolve) => {
    let child
    try {
      child = spawn(py.path, ['-X', 'utf8', scriptFile, '--spec', specFile, '--result', resultFile], {
        env: pythonEnv(),
        cwd: PLUGIN_ROOT,
        windowsHide: true,
        stdio: 'ignore', // 关键：不能 pipe，沙箱下会 EPERM
      })
    } catch (error) {
      resolve({ spawnError: String(error?.message || error) })
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        // ignore
      }
      resolve({ timeout: true })
    }, timeoutMs)

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ spawnError: String(error?.message || error) })
    })
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode })
    })
  })

  if (code.spawnError) {
    cleanup()
    return { ok: false, reason: 'SPAWN_FAILED', error: code.spawnError }
  }
  if (code.timeout) {
    cleanup()
    return { ok: false, reason: 'TIMEOUT', error: `${timeoutMs}ms 内没画完` }
  }

  let raw = ''
  try {
    raw = fs.readFileSync(resultFile, 'utf8')
  } catch {
    cleanup()
    return {
      ok: false,
      reason: 'NO_RESULT',
      error: `脚本没有写结果文件（exit ${code.exitCode}）。可能是 Python 环境或依赖问题。`,
    }
  }
  cleanup()
  try {
    return JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'BAD_RESULT', error: `结果不是 JSON: ${raw.slice(0, 200)}` }
  }
}
