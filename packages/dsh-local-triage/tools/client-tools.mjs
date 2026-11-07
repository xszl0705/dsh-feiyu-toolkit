// 客户端工具用量明细：解压会话原始事件流（分帧 zstd），按工具/类别汇总上下文占用
// 用法：node client-tools.mjs [sessionId前缀]   输出：reports/tool-usage.md
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const SESSIONS = path.join(os.homedir(), '.dsh', 'sessions')
const WORKSPACE_DIR = '--E-~5DE5~4F5C~533A--'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'reports', 'tool-usage.md')
const prefix = process.argv[2] || ''

const root = path.join(SESSIONS, WORKSPACE_DIR)
const dirs = fs.readdirSync(root).filter((d) => d.startsWith('session-'))
const target = prefix ? dirs.find((d) => d.includes(prefix)) : dirs
  .map((d) => ({ d, t: fs.statSync(path.join(root, d)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0]?.d
if (!target) {
  console.error('session not found')
  process.exit(2)
}

const file = path.join(root, target, 'session.v4.jsonl.zstd')
const buf = fs.readFileSync(file)

// zstd 帧以 0x28B52FFD 开头，文件是逐条追加写的，必须逐帧解压
const starts = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
}
const records = []
let failed = 0
for (let k = 0; k < starts.length; k++) {
  const from = starts[k]
  const to = k + 1 < starts.length ? starts[k + 1] : buf.length
  try {
    const text = zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8')
    for (const line of text.split(/\r?\n/)) if (line.trim()) records.push(JSON.parse(line))
  } catch {
    failed += 1
  }
}

const CATEGORY = (name) => {
  if (/^(read|glob|grep)$/.test(name)) return '读取'
  if (/^(edit|write)$/.test(name)) return '写入'
  if (/^pwsh$/.test(name)) return '执行'
  if (/^memory_/.test(name)) return '记忆'
  if (/^(web_search|web_fetch)$/.test(name)) return '网络'
  if (/^(job_|list_agents|send_message|interrupt_agent)/.test(name)) return '任务'
  if (/^(diary_|calendar_|chatlog_)/.test(name)) return '日志/日历'
  if (/^(pet_|feiyu_|self_|naga_|qq_|screenshot_|playground_)/.test(name)) return '自有插件'
  return '其他'
}

const nameByCall = new Map()
for (const rec of records) {
  if (rec.type !== 'tool/call') continue
  const d = rec.data ?? {}
  const id = d.callId ?? d.toolCallId ?? d.message?.toolCallId
  const name = d.name ?? d.toolName ?? d.message?.name
  if (id && name) nameByCall.set(id, name)
}

const byTool = new Map()
let results = 0
let unmatched = 0
for (const rec of records) {
  if (rec.type !== 'tool/result') continue
  results += 1
  const d = rec.data ?? {}
  const id = d.toolCallId ?? d.message?.toolCallId ?? d.callId
  const name = nameByCall.get(id) ?? 'unknown'
  if (name === 'unknown') unmatched += 1
  const content = d.message?.content
  let chars = 0
  if (Array.isArray(content)) {
    for (const part of content) {
      chars += typeof part?.text === 'string' ? part.text.length : JSON.stringify(part).length
    }
  } else {
    chars = JSON.stringify(content ?? d).length
  }
  if (!byTool.has(name)) byTool.set(name, { count: 0, chars: 0 })
  const e = byTool.get(name)
  e.count += 1
  e.chars += chars
}

const totalChars = [...byTool.values()].reduce((s, e) => s + e.chars, 0)
const rows = [...byTool.entries()].map(([name, e]) => ({ name, ...e, category: CATEGORY(name) })).sort((a, b) => b.chars - a.chars)

const lines = []
lines.push('# 工具上下文占用（按工具 / 按类别）')
lines.push('')
lines.push(`会话：${target.replace('session-', '')}`)
lines.push(`事件流：${starts.length} 帧解压，${records.length} 条记录（失败 ${failed} 帧）`)
lines.push('')
lines.push(`工具调用 ${results} 次，结果正文合计 ${totalChars.toLocaleString()} 字符 ≈ **${Math.round(totalChars / 4).toLocaleString()} token**（4 字符/token 估算）`)
if (unmatched) lines.push(`⚠ ${unmatched} 次结果未匹配到调用`)
lines.push('')
lines.push('| 工具 | 类别 | 次数 | 字符 | ≈token | 占比 |')
lines.push('|---|---|---:|---:|---:|---:|')
for (const r of rows) {
  lines.push(`| ${r.name} | ${r.category} | ${r.count} | ${r.chars.toLocaleString()} | ${Math.round(r.chars / 4).toLocaleString()} | ${((r.chars / totalChars) * 100).toFixed(1)}% |`)
}

const byCat = new Map()
for (const r of rows) {
  if (!byCat.has(r.category)) byCat.set(r.category, { count: 0, chars: 0 })
  const e = byCat.get(r.category)
  e.count += r.count
  e.chars += r.chars
}
lines.push('')
lines.push('## 按类别')
lines.push('')
lines.push('| 类别 | 次数 | 字符 | ≈token | 占比 |')
lines.push('|---|---:|---:|---:|---:|')
for (const [cat, e] of [...byCat.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
  lines.push(`| ${cat} | ${e.count} | ${e.chars.toLocaleString()} | ${Math.round(e.chars / 4).toLocaleString()} | ${((e.chars / totalChars) * 100).toFixed(1)}% |`)
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log('written ' + OUT + ' tools=' + rows.length)
