/**
 * 试验区核心逻辑：启停隔离实例、检查组合配置、往试验区装插件。
 *
 * 为什么放进插件而不是命令行工具：
 *   DSH 工具启动的子进程继承 agent 沙箱，拉起 powershell / 另一个 DSH 实例会被拦（EPERM）。
 *   插件跑在宿主进程里，没有这层限制——和 dsh-service-autostart 拉 NapCat 是同一个道理。
 *
 * 铁律（2026-10-31 踩出来的）：
 *   1. profile 只能靠 `--profile <name>` 选，环境变量 DSH_PROFILE 不参与启动
 *   2. --profile 后面不能再跟 app 名（web），profile 自己决定 app
 *   3. 脚本源文件必须 ASCII 或带 BOM，否则 PowerShell 5.1 按 ANSI 读会破坏引号
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const DEFAULTS = {
  exe: '',
  cli: '',
  port: 3080,
  bootTimeoutMs: 45000,
}

export function defaultProfilesRoot() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles')
}

/**
 * 名字白名单：字母/数字/点/横线/下划线，必须以字母数字开头，最长 64。
 *
 * 挡的是一类真实事故：packageName 或 profile 传 `..` / `../../..` 时，
 * path.join 会把它解析到 profiles 目录之外，而后面紧跟 fs.rmSync(recursive)，
 * 等于一次工具调用就能删掉整个 profile 甚至整个用户目录（2026-11-01 审计发现）。
 */
const SAFE_NAME = /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** 校验名字。返回 { ok, value } 或 { ok:false, error }，不抛异常，方便调用方转成工具错误。 */
export function safeName(value, label) {
  const s = String(value ?? '')
  if (!SAFE_NAME.test(s) || s.includes('..')) {
    return {
      ok: false,
      error: `${label} 不合法（只允许字母/数字/点/横线/下划线，不能含 ..）：${JSON.stringify(s)}`,
    }
  }
  return { ok: true, value: s }
}

/**
 * 确认 target 解析后仍落在 base 目录里面。
 * 名字正则挡不住所有写法（短名、大小写、分隔符变体），所以路径层面再兜一层。
 */
export function insideDir(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 端口上有东西在听就算活着。 */
export function portOpen(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const done = (result) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function waitForPort(port, deadline) {
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  return false
}

/**
 * 启动一个隔离实例。
 * state 由调用方传一个对象进来记录 pid（插件级状态），不使用全局变量。
 */
export async function startInstance({ profile, port, state = {}, config = {}, note = () => {} } = {}) {
  if (!profile) throw new Error('缺 profile 名')
  {
    const checked = safeName(profile, 'profile')
    if (!checked.ok) throw new Error(checked.error)
    profile = checked.value
  }
  const exe = config.exe || DEFAULTS.exe
  const cli = config.cli || DEFAULTS.cli
  const listenPort = Number(port) || config.port || DEFAULTS.port
  const timeout = Number(config.bootTimeoutMs) || DEFAULTS.bootTimeoutMs

  if (!fs.existsSync(exe)) return { ok: false, error: '找不到 DSH 可执行文件：' + exe }
  if (!fs.existsSync(cli)) return { ok: false, error: '找不到 DSH CLI：' + cli }

  const profilesRoot = config.profilesRoot || defaultProfilesRoot()
  const profileDir = path.join(profilesRoot, profile)
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    return { ok: false, error: 'profile 不存在：' + profileDir }
  }

  // 已经在跑就直接复用
  if (await portOpen(listenPort)) {
    state.pid = state.pid || null
    // 端口被占时拿不到我们自己记的 pid，但工具出参 schema 要求 pid 是 number，
    // 返回 null 会被宿主判成 invalid output。用 0 表示「未知 pid，实例不是本次启动的」。
    return {
      ok: true,
      reused: true,
      pid: Number(state.pid) || 0,
      url: `http://127.0.0.1:${listenPort}/`,
      note: '端口已在监听，可能已有实例在跑；要重启需先手动停掉它',
    }
  }

  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  // 启动日志落盘：stdio 'ignore' 时子进程崩溃没有任何线索（2026-11-01 verifyx 排查）。
  // stdout/stderr 都写 profileDir/boot.log，append 且超 512KB 截断，防止无限增长。
  const bootLog = path.join(profileDir, 'boot.log')
  let logFd
  try {
    if (fs.existsSync(bootLog) && fs.statSync(bootLog).size > 512 * 1024) fs.truncateSync(bootLog)
    logFd = fs.openSync(bootLog, 'a')
    fs.writeSync(logFd, `\n===== boot ${new Date().toISOString()} profile=${profile} =====\n`)
  } catch (error) {
    return { ok: false, error: '打不开启动日志 ' + bootLog + '：' + String((error && error.message) || error) }
  }
  let child
  try {
    child = spawn(exe, ['--expose-internals', cli, '--profile', profile], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env,
    })
  } catch (error) {
    try { fs.closeSync(logFd) } catch { /* already closed */ }
    return { ok: false, error: 'spawn 失败：' + String((error && error.message) || error) }
  }
  try { fs.closeSync(logFd) } catch { /* already closed */ }
  child.unref()
  state.pid = child.pid
  state.profile = profile
  state.port = listenPort
  note(`试验区启动：profile=${profile} pid=${child.pid} 等端口 ${listenPort}`)

  const startedAt = Date.now()
  const ready = await waitForPort(listenPort, startedAt + timeout)
  if (!ready) {
    return {
      ok: false,
      pid: child.pid,
      error: `等 ${timeout}ms 端口 ${listenPort} 还没起来`,
      hint: '看 verifyx 的插件日志，或者手动跑一次 dsh --profile ' + profile,
    }
  }
  note(`试验区就绪：http://127.0.0.1:${listenPort}/`)
  return { ok: true, pid: child.pid, port: listenPort, url: `http://127.0.0.1:${listenPort}/`, bootMs: Date.now() - startedAt }
}

/** 停实例：只杀记过的 pid，绝不按名字全杀（会把 desktop 一起带走）。 */
export function stopInstance({ state = {}, note = () => {} } = {}) {
  const pid = Number(state.pid)
  if (!pid) return { ok: false, error: '没有记录到实例 pid' }
  try {
    process.kill(pid)
    note(`试验区停止：pid=${pid}`)
    state.pid = null
    return { ok: true, pid }
  } catch (error) {
    state.pid = null
    return { ok: false, pid, error: String((error && error.message) || error) }
  }
}

/**
 * 检查 profile 的组合配置：跑 --dump-config，把插件 id 抽出来。
 * 纯只读（DSH 会重写 cordis.yml，但那是它自己的产物）。
 */
export function checkProfile({ profile, config = {}, timeoutMs = 60000 } = {}) {
  const exe = config.exe || DEFAULTS.exe
  const cli = config.cli || DEFAULTS.cli
  const profilesRoot = config.profilesRoot || defaultProfilesRoot()
  const result = runSync(exe, ['--expose-internals', cli, '--profile', profile, '--dump-config'], {
    timeoutMs,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  if (!result.ok) {
    const detail = String(result.stderr || result.error || '').trim().slice(0, 500)
    return { ok: false, error: detail || 'dump-config 失败', raw: String(result.stdout || '').slice(0, 200) }
  }
  const ids = []
  for (const line of String(result.stdout || '').split('\n')) {
    const m = line.match(/^-\s+id:\s*(.+)$/)
    if (m) ids.push(m[1].trim())
  }
  return { ok: true, profile, profileDir: path.join(profilesRoot, profile), entries: ids.length, ids, preview: ids.slice(0, 40) }
}

/** 同步跑子进程（插件里可以，工具里受沙箱限制）。 */
function runSync(file, args, { timeoutMs = 60000, env = process.env } = {}) {
  try {
    const out = spawnSync(file, args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
      env,
      maxBuffer: 32 * 1024 * 1024,
    })
    if (out.error) return { ok: false, error: String(out.error.message || out.error) }
    if (out.status !== 0) return { ok: false, error: `exit ${out.status}`, stdout: out.stdout, stderr: out.stderr }
    return { ok: true, stdout: out.stdout, stderr: out.stderr }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/**
 * 找一个已建好 junction 的包的入口文件，返回相对路径；找不到返回 null。
 * 顺序：package.json 的 main → exports["."]（字符串或 .default）→ index.js。
 * 别写死 index.js：auto-memory / vision-router 这类包的入口在 lib/ 下面。
 */
export function resolveLinkedEntry(packageDir) {
  const exists = (rel) => {
    if (!rel || typeof rel !== 'string') return false
    try {
      return fs.existsSync(path.join(packageDir, rel.replace(/^\.\//, '')))
    } catch {
      return false
    }
  }
  let manifest = null
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    manifest = null
  }
  const candidates = []
  if (manifest) {
    if (typeof manifest.main === 'string') candidates.push(manifest.main)
    const dot = manifest.exports && typeof manifest.exports === 'object' ? manifest.exports['.'] : undefined
    if (typeof dot === 'string') candidates.push(dot)
    else if (dot && typeof dot === 'object') {
      for (const key of ['import', 'default', 'require']) {
        if (typeof dot[key] === 'string') candidates.push(dot[key])
      }
    }
  }
  candidates.push('index.js')
  for (const rel of candidates) if (exists(rel)) return rel
  return null
}

/**
 * 把插件装进试验区 profile：备份 → 改 package.json → 建 junction → 自检。
 * 只动指定 profile，绝不碰 desktop（除非调用方显式传 desktop）。
 */
export function installPlugin({ profile, packageName, sourceDir, config = {}, note = () => {} } = {}) {
  if (!profile || !packageName) return { ok: false, error: '缺 profile 或 packageName' }

  // 安全闸：名字必须先过白名单，否则后面拼出来的 linkPath 可能跑到 profiles 之外，
  // 而下方有 fs.rmSync(linkPath, { recursive: true })——越界等于删库。
  const profileCheck = safeName(profile, 'profile')
  if (!profileCheck.ok) return { ok: false, error: profileCheck.error }
  const pkgCheck = safeName(packageName, 'packageName')
  if (!pkgCheck.ok) return { ok: false, error: pkgCheck.error }
  profile = profileCheck.value
  packageName = pkgCheck.value

  const profilesRoot = config.profilesRoot || defaultProfilesRoot()
  const profileDir = path.join(profilesRoot, profile)
  const pkgFile = path.join(profileDir, 'package.json')
  if (!fs.existsSync(pkgFile)) return { ok: false, error: 'profile 不存在：' + profileDir }

  // 1) 备份
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backupRoot = config.backupRoot || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'backups')
  const backupDir = path.join(backupRoot, `${stamp}-before-${packageName}-in-${profile}`)
  try {
    fs.mkdirSync(backupDir, { recursive: true })
    fs.copyFileSync(pkgFile, path.join(backupDir, 'package.json'))
  } catch (error) {
    return { ok: false, error: '备份失败：' + String((error && error.message) || error) }
  }

  // 2) 改 JSON
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    return { ok: false, error: 'package.json 解析失败：' + String((error && error.message) || error) }
  }
  pkg.dependencies = pkg.dependencies || {}
  pkg.dependencies[packageName] = sourceDir ? `link:${String(sourceDir).replace(/\\/g, '/')}` : pkg.dependencies[packageName] || '*'
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []
  if (!pkg.dsh.profile.bundles.includes(packageName)) pkg.dsh.profile.bundles.push(packageName)
  try {
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  } catch (error) {
    return { ok: false, error: '写 package.json 失败：' + String((error && error.message) || error) }
  }

  // 3) junction（只给 link: 源目录建）
  let linked = false
  if (sourceDir) {
    const linkPath = path.join(profileDir, 'node_modules', packageName)
    // 双保险：即使名字校验被绕过，目标也必须落在 node_modules 里。
    // 下面有 fs.rmSync(linkPath, { recursive: true })，越界等于删库。
    if (!insideDir(path.join(profileDir, 'node_modules'), linkPath)) {
      return { ok: false, error: '安装路径越界：' + linkPath }
    }
    try {
      if (fs.existsSync(linkPath)) {
        const stat = fs.lstatSync(linkPath)
        if (stat.isSymbolicLink() || stat.isDirectory()) fs.rmSync(linkPath, { recursive: true, force: true })
      }
      fs.mkdirSync(path.dirname(linkPath), { recursive: true })
      fs.symlinkSync(sourceDir, linkPath, 'junction')
      linked = true
    } catch (error) {
      return { ok: false, error: '建 junction 失败：' + String((error && error.message) || error), backup: backupDir }
    }
  }

  // 4) 自检
  // 入口不能写死 index.js：不少包 main 是 lib/index.js（auto-memory、vision-router 都是），
  // 按 main → exports["."] → index.js 的顺序找。2026-10-31 装 auto-memory 时被这条误判过。
  const linkedEntry = sourceDir ? resolveLinkedEntry(path.join(profileDir, 'node_modules', packageName)) : null
  const checks = {
    jsonValid: true,
    inDeps: Boolean(pkg.dependencies[packageName]),
    inBundles: pkg.dsh.profile.bundles.includes(packageName),
    bundlesCount: pkg.dsh.profile.bundles.length,
    junctionReadable: sourceDir ? linkedEntry !== null : null,
    entry: linkedEntry || undefined,
  }
  const failed = []
  if (!checks.inDeps) failed.push('dependencies 里没有')
  if (!checks.inBundles) failed.push('bundles 里没有')
  if (sourceDir && checks.junctionReadable === false) failed.push('junction 读不到入口文件')
  note(`装 ${packageName} 到 ${profile}：${failed.length ? '自检失败 ' + failed.join('/') : '自检通过'}（bundles=${checks.bundlesCount}）`)
  return { ok: failed.length === 0, profile, packageName, backup: backupDir, linked, checks, failed }
}

/** 当前实例状态：端口在不在、记的 pid 还活着吗。 */export async function instanceStatus({ state = {}, config = {} } = {}) {
  const port = Number(state.port) || config.port || DEFAULTS.port
  const listening = await portOpen(port)
  let alive = null
  if (state.pid) {
    try {
      process.kill(Number(state.pid), 0)
      alive = true
    } catch {
      alive = false
    }
  }
  return {
    profile: state.profile || '',
    // pid 只在有值时才出现：schema 里声明成 number，null 会被输出校验拒掉
    ...(state.pid ? { pid: Number(state.pid) } : {}),
    port,
    listening,
    pidAlive: alive,
    url: listening ? `http://127.0.0.1:${port}/` : '',
    profilesRoot: config.profilesRoot || defaultProfilesRoot(),
  }
}
