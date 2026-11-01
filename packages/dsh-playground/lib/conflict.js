/**
 * 冲突扫描：找出「两个插件注册了同一个名字」的地方。
 *
 * 为什么要有它：2026-10-31 的事故就是 vision-router 和 qq-adapter 都注册
 * `vision_describe`，一个注册失败把整个 bundles 重置成 2 个。
 *
 * 判据：工具名 / 服务名重复 = 硬冲突；数据目录同名 = 软冲突（会互相覆盖）。
 *
 * 限制：第三方包是打包压缩的，扫出来会有噪音，所以只认「长得像工具名」的
 * （小写字母开头、含下划线或纯小写、长度 4-48）。
 */

import fs from 'node:fs'
import path from 'node:path'

const TOOL_NAME_RE = /name:\s*['"]([a-z][a-z0-9_]{3,47})['"]/g
const SERVICE_RE = /provide\??\.\(\s*['"]([a-zA-Z][a-zA-Z0-9]{1,30})['"]/g

/** 递归收集某个包目录下的 .js/.mjs 文件（跳过 node_modules）。 */
function collectJs(dir, out = [], depth = 0) {
  if (depth > 6) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.pnpm' || entry.name === 'dist' && depth > 2) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectJs(full, out, depth + 1)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

function namesFromFile(file, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const tools = new Set()
  const services = new Set()
  let text = ''
  try {
    const stat = fs.statSync(file)
    if (stat.size > maxBytes) return { tools, services }
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { tools, services }
  }
  for (const m of text.matchAll(TOOL_NAME_RE)) tools.add(m[1])
  for (const m of text.matchAll(SERVICE_RE)) services.add(m[1])
  return { tools, services }
}

/**
 * 扫一个 profile 实际加载的插件，找重名。
 * 只扫 package.json 的 dependencies（bundles 里可能有不带依赖的宿主内置包，跳过）。
 */
export function scanConflicts({ profilesRoot, profile, maxPerPackage = 400 } = {}) {
  const profileDir = path.join(profilesRoot, profile)
  const pkgFile = path.join(profileDir, 'package.json')
  if (!fs.existsSync(pkgFile)) return { ok: false, error: 'profile 不存在：' + profileDir }

  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    return { ok: false, error: 'package.json 解析失败：' + String((error && error.message) || error) }
  }
  const allDeps = Object.keys(pkg.dependencies || {})
  const bundles = pkg.dsh?.profile?.bundles || []
  // 只扫「在 bundles 里 + 又能扫到源码」的包：
  // dependencies 里可能躺着没启用的插件（比如 vision-router），扫它会报假冲突；
  // bundles 里的宿主内置包（@deepseek-ai/*）不在 dependencies 里，本来也扫不到。
  const scannable = new Set(allDeps.filter((dep) => bundles.includes(dep)))
  const deps = allDeps.filter((dep) => scannable.has(dep))
  const notLoaded = allDeps.filter((dep) => !bundles.includes(dep))
  const scanned = []
  const toolOwner = new Map()
  const serviceOwner = new Map()
  const errors = []

  for (const dep of deps) {
    const pkgDir = path.join(profileDir, 'node_modules', dep)
    if (!fs.existsSync(pkgDir)) {
      errors.push(`${dep}: node_modules 里没有`)
      continue
    }
    const files = collectJs(pkgDir).slice(0, maxPerPackage)
    const tools = new Set()
    const services = new Set()
    for (const file of files) {
      const found = namesFromFile(file)
      for (const t of found.tools) tools.add(t)
      for (const s of found.services) services.add(s)
    }
    scanned.push({ package: dep, files: files.length, tools: tools.size, services: services.size })
    for (const t of tools) {
      const list = toolOwner.get(t) || []
      list.push(dep)
      toolOwner.set(t, list)
    }
    for (const s of services) {
      const list = serviceOwner.get(s) || []
      list.push(dep)
      serviceOwner.set(s, list)
    }
  }

  const toolConflicts = [...toolOwner.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([name, owners]) => ({ name, owners: [...new Set(owners)] }))
  const serviceConflicts = [...serviceOwner.entries()]
    .filter(([, owners]) => [...new Set(owners)].length > 1)
    .map(([name, owners]) => ({ name, owners: [...new Set(owners)] }))

  return {
    ok: true,
    profile,
    packages: deps.length,
    scanned: scanned.length,
    toolCount: toolOwner.size,
    serviceCount: serviceOwner.size,
    toolConflicts,
    serviceConflicts,
    errors,
    // dependencies 里装了但不在 bundles 的包：不会加载，但留着占空间
    installedButDisabled: notLoaded,
    // 只把「我们自己写的」列出来，第三方噪音多
    ours: scanned.filter((s) => String(s.package).startsWith('dsh-')).map((s) => s.package),
  }
}
