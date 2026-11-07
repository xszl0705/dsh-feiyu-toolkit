/**
 * 一键验证：重启 + QQ 恢复后，跑这一条就知道改动到底有没有生效。
 *
 * 判据：
 *   1. 前缀修复 —— 最近有 token 的调用里，cacheReadTokens 是否出现过 ≥384
 *   2. 每任务观测 —— 是否出现 traceId 字段
 *   3. 数据新鲜度 —— 最近一条记录是否晚于 reply.js 的修改时间
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 "E:\dsh\DeepSeek Harness.exe" tools\verify-cost.mjs
 * 输出：reports/verify-cost.md，退出码 0=通过 / 1=待观察或失败
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')          // E:\工作区
const STATS = path.join(os.homedir(), '.dsh', 'dafeiyu', 'stats')
const OUT = path.join(HERE, '..', 'reports', 'verify-cost.md')

const WATCHED = [
  path.join(ROOT, 'dsh-plugins', 'dsh-qq-adapter', 'lib', 'reply.js'),
  path.join(ROOT, 'dsh-plugins', 'dsh-qq-adapter', 'lib', 'gate.js'),
]

const FIXED_AT = Math.max(
  ...WATCHED.map((f) => {
    try { return fs.statSync(f).mtimeMs } catch { return 0 }
  }),
)

function loadRows() {
  let files = []
  try { files = fs.readdirSync(STATS).filter((f) => f.endsWith('.jsonl')).sort() } catch { return [] }
  const rows = []
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(STATS, f), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
    }
  }
  return rows.sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

const rows = loadRows()
const withTokens = rows.filter((r) => Number(r.promptTokens) > 0)
const afterFix = rows.filter((r) => Date.parse(r.at) > FIXED_AT)
const afterFixTokens = afterFix.filter((r) => Number(r.promptTokens) > 0)

const maxCache = afterFixTokens.length
  ? Math.max(...afterFixTokens.map((r) => Number(r.cacheReadTokens) || 0))
  : 0
const withTrace = rows.filter((r) => r.traceId).length
const lastAt = rows.length ? rows[rows.length - 1].at : null

const cacheOk = maxCache >= 384
const traceOk = withTrace > 0
const fresh = afterFix.length > 0

const verdict = !fresh
  ? 'PENDING'
  : cacheOk && traceOk
    ? 'PASS'
    : 'FAIL'

const lines = []
lines.push('# 降消耗改动验证')
lines.push('')
lines.push(`生成时间：${new Date().toISOString()}`)
lines.push(`判定：**${verdict}**`)
lines.push('')
lines.push('| 检查项 | 结果 | 说明 |')
lines.push('|---|---|---|')
lines.push(`| 修复后是否有新数据 | ${fresh ? '有' : '无'} | 最近记录 ${lastAt || '无'}；修复时间 ${new Date(FIXED_AT).toISOString()} |`)
lines.push(`| 缓存命中最大值 | ${maxCache} token | 目标 ≥384（修复前恒为 128/256） |`)
lines.push(`| traceId 是否落盘 | ${withTrace} 条 | 目标 >0 |`)
lines.push(`| 有 token 的调用总数 | ${withTokens.length} / ${rows.length} | |`)
lines.push('')

if (verdict === 'PENDING') {
  lines.push('## 为什么是 PENDING')
  lines.push('')
  lines.push('修复之后没有产生新的调用记录（QQ 未恢复或未发消息）。**这不代表失败**，只是还没有可判定的样本。')
  lines.push('')
  lines.push('## 待办')
  lines.push('')
  lines.push('1. 确认 QQ 登录且 `pauseFile` 不存在')
  lines.push('2. 发 3~5 条私聊 + 至少 1 条群消息（群消息才走 gate 链路）')
  lines.push('3. 重跑本脚本')
} else if (verdict === 'FAIL') {
  lines.push('## 失败项')
  lines.push('')
  if (!cacheOk) lines.push(`- 缓存命中仍 ≤256（实测 ${maxCache}）：前缀结构可能被别的东西破坏，用 \`tools/audit-prefix.mjs\` 复查。`)
  if (!traceOk) lines.push('- 没有 traceId：`brainStat()` 的改动可能没被加载，检查是否重启过。')
  lines.push('')
  lines.push('回滚命令：把 `github/backups/20261031-232051-prefix-cache/reply.js` 和 `20261031-233332-gate-prefix/gate.js` 拷回原位。')
} else {
  lines.push('## 结论')
  lines.push('')
  lines.push(`前缀缓存已生效：修复后命中最大值 ${maxCache} token（修复前恒为 128/256）。`)
  lines.push(`每任务观测已生效：${withTrace} 条记录带 traceId。`)
  lines.push('')
  lines.push('接下来可以跑 `tools/analyze-usage.mjs` 看每任务成本基线。')
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
process.exit(verdict === 'PASS' ? 0 : 1)
