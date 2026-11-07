// 按「轮」标注客户端会话消耗：输入、输出、缓存命中，以及上下文各部分的构成
// 用法：node client-turns.mjs [sessionId前缀]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')
const OUT_MD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'reports', 'client-turns.md')
const prefix = process.argv[2] || ''

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
let file = null
if (prefix) {
  file = files.find((f) => f.startsWith('session-' + prefix)) ?? null
} else {
  const sorted = files.map((f) => ({ f, t: fs.statSync(path.join(DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t)
  file = sorted[0]?.f ?? null
}
if (!file) {
  console.error('no session file')
  process.exit(2)
}

const data = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'))
const rows = data?.record?.rows ?? {}
const tl = rows.contextTimeline?.val ?? {}
const requests = tl.requests ?? []
const usage = rows.tokenUsage?.val ?? null

const md = []
md.push('# 客户端每轮消耗标注')
md.push('')
md.push(`会话：${file.replace('session-', '').replace('.json', '')}`)
md.push(`请求数：${requests.length}　（每步一次请求）`)
md.push('')

// ---- 按轮聚合 ----
const byTurn = new Map()
for (const r of requests) {
  const turn = r.turn ?? 0
  if (!byTurn.has(turn)) byTurn.set(turn, { steps: 0, prompt: 0, cacheRead: 0, output: 0, total: 0, ms: 0 })
  const t = byTurn.get(turn)
  t.steps += 1
  t.prompt += Number(r.prompt) || 0
  t.cacheRead += Number(r.cacheRead) || 0
  t.output += Number(r.output) || 0
  t.total = Number(r.total) || t.total
  t.ms += Number(r.activeMs) || 0
}

md.push('## 每轮消耗')
md.push('')
md.push('口径：`输入` = 该轮所有步的 prompt 合计（含命中部分），`命中` = 缓存读，命中率 = 命中 ÷ 输入。')
md.push('')
md.push('| 轮 | 步数 | 输入 token | 其中命中 | 未命中 | 命中率 | 输出 token | 轮末上下文 |')
md.push('|---|---:|---:|---:|---:|---:|---:|---:|')
let sumIn = 0
let sumHit = 0
let sumOut = 0
for (const [turn, t] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
  if (t.prompt === 0 && t.output === 0) {
    md.push(`| ${turn} | ${t.steps} | 进行中 | — | — | — | — | ${t.total.toLocaleString()} |`)
    continue
  }
  const hit = t.prompt > 0 ? t.cacheRead / t.prompt : 0
  const missed = Math.max(0, t.prompt - t.cacheRead)
  sumIn += t.prompt
  sumHit += t.cacheRead
  sumOut += t.output
  md.push(`| ${turn} | ${t.steps} | ${t.prompt.toLocaleString()} | ${t.cacheRead.toLocaleString()} | ${missed.toLocaleString()} | ${(hit * 100).toFixed(1)}% | ${t.output.toLocaleString()} | ${t.total.toLocaleString()} |`)
}
md.push('')
if (sumIn) {
  md.push(`合计：输入 ${sumIn.toLocaleString()}（命中 ${sumHit.toLocaleString()}、未命中 ${(sumIn - sumHit).toLocaleString()}），输出 ${sumOut.toLocaleString()}，命中率 **${((sumHit / sumIn) * 100).toFixed(2)}%**`)
}
md.push('')

// ---- 上下文构成（最后一次请求为准）----
const last = requests[requests.length - 1]
if (last) {
  const parts = [
    ['system', last.system],
    ['tools', last.tools],
    ['inject', last.inject],
    ['skill', last.skill],
    ['assistant（历史回复）', last.assistant],
    ['tool（工具结果）', last.tool],
    ['user（用户消息）', last.user],
  ]
  const total = parts.reduce((s, [, v]) => s + (Number(v) || 0), 0)
  md.push('## 当前上下文构成（共 ' + total.toLocaleString() + ' token）')
  md.push('')
  md.push('| 部分 | token | 占比 |')
  md.push('|---|---:|---:|')
  for (const [name, v] of parts.sort((a, b) => (b[1] || 0) - (a[1] || 0))) {
    if (!v) continue
    md.push(`| ${name} | ${Number(v).toLocaleString()} | ${((v / total) * 100).toFixed(1)}% |`)
  }
  md.push('')
}

// ---- 注入明细排行（events kind=inject）----
const events = tl.events ?? []
const injects = events.filter((e) => e.kind === 'inject')
const byName = new Map()
for (const e of injects) {
  const key = e.name ?? e.form ?? 'unknown'
  byName.set(key, (byName.get(key) ?? 0) + (Number(e.tokens) || 0))
}
if (byName.size) {
  md.push('## 注入项排行（events.kind=inject）')
  md.push('')
  md.push('| 来源 | token |')
  md.push('|---|---:|')
  for (const [name, tokens] of [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    md.push(`| ${name} | ${tokens.toLocaleString()} |`)
  }
  md.push('')
}

// ---- 全局 totals 对照 ----
if (usage?.totals) {
  const t = usage.totals
  md.push('## 全局累计（projection totals）')
  md.push('')
  md.push(`未缓存输入 ${Number(t.uncachedInputTokens).toLocaleString()} · 缓存读 ${Number(t.cacheReadTokens).toLocaleString()} · 输出 ${Number(t.outputTokens).toLocaleString()}`)
}

fs.writeFileSync(OUT_MD, md.join('\n'), 'utf8')
console.log('written ' + OUT_MD)
