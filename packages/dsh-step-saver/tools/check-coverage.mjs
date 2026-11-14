/**
 * slim 白名单覆盖率对账。
 *
 * 铁律：任何工具必须落在 keep 或某个 group 里，否则瘦身开启后它会永久不可见。
 * 每次改完 slim.json、或新装插件带来新工具，都跑一次这个脚本。
 *
 * 用法（本机无 node，走 run-node 封装）：
 *   run_node(script='<workspace>\dsh-plugins\dsh-step-saver\tools\check-coverage.mjs')
 * 退出码 0 = 全覆盖；2 = 有工具没被任何地方列出。
 *
 * 基线来源：`_tmp/tool-usage-report.txt`（tools/tool-usage-report.mjs 产出，含全部注册工具
 * 与调用次数）。也可以直接编辑下方的 NEW_TOOLS 补上刚新增、报告还没来得及收录的工具。
 */
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const REPORT = arg('report', path.join(process.cwd(), '_tmp', 'tool-usage-report.txt'))
const SLIM = arg('slim', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'slim.json'))
/** 报告里还没收录的本插件工具（新增工具时补这里）。 */
const NEW_TOOLS = ['run_node', 'ls_tree', 'file_outline', 'smart_grep', 'toolbox']

if (!fs.existsSync(SLIM)) {
  console.error('找不到 slim.json：' + SLIM)
  process.exit(1)
}

const registered = new Set()
if (fs.existsSync(REPORT)) {
  const text = fs.readFileSync(REPORT, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    // 行形如：   3495 字符 874 tok 4103 调用 pwsh
    const m = /^\s*\d+\s+\S+\s+\d+\s+tok\s+\d+\s+\S+\s+([A-Za-z0-9_$/.-]+)\s*$/.exec(line)
    if (m) registered.add(m[1])
  }
} else {
  console.error('（警告）没有工具使用报告，只做 keep/groups 的自洽检查：' + REPORT)
}
for (const name of NEW_TOOLS) registered.add(name)

const slim = JSON.parse(fs.readFileSync(SLIM, 'utf8'))
const keep = new Set(Array.isArray(slim.keep) ? slim.keep : [])
const groups = slim.groups && typeof slim.groups === 'object' ? slim.groups : {}
const inGroups = new Set()
for (const names of Object.values(groups)) {
  for (const name of Array.isArray(names) ? names : []) inGroups.add(name)
}

const covered = new Set([...keep, ...inGroups])
const missing = [...registered].filter((n) => !covered.has(n)).sort()
const keepNotRegistered = [...keep].filter((n) => !registered.has(n) && !NEW_TOOLS.includes(n)).sort()

console.log(`enabled=${slim.enabled === true} · 基线工具 ${registered.size} · keep ${keep.size} · 组内 ${inGroups.size} · 覆盖 ${covered.size}`)
console.log(`[未覆盖 · ${missing.length}] ${missing.length ? missing.join(', ') : '（无，全覆盖）'}`)
console.log(`[keep 里但基线没有 · ${keepNotRegistered.length}] ${keepNotRegistered.length ? keepNotRegistered.join(', ') : '（无）'}`)
for (const [group, names] of Object.entries(groups)) {
  console.log(`  ${group}（${(names || []).length}）：${(names || []).join(', ')}`)
}
process.exitCode = missing.length ? 2 : 0
