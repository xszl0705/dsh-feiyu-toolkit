/**
 * 决策日志：给「因果连续性」打底。
 *
 * 设计约束（见 docs/self-evolving-harness-tech-v1.md）：
 *  - 只记决策与结果，**不记用户正文**
 *  - 字段白名单，防止上游随手塞 text/content 进来
 *  - 一天一个 jsonl，追加写，损坏行跳过
 */

import fs from 'node:fs'
import path from 'node:path'

const FIELDS = new Set([
  'kind',
  'requestId',
  'messageId',
  'choice',
  'alternatives',
  'reason',
  'outcome',
  'cost',
  'version',
  'privacy',
  'channel',
  'conversation',
  'intent',
  'scope',
])

const MAX_STRING = 300

export function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function shrink(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value
  if (typeof value !== 'object') return value
  if (depth >= 3) return undefined
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => shrink(item, depth + 1)).filter((item) => item !== undefined)
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (/^(text|content|body|raw|prompt|reply)$/i.test(key)) continue
    const next = shrink(item, depth + 1)
    if (next !== undefined) out[key] = next
  }
  return out
}

/** 白名单过滤 + 长度收缩 + 隐私声明，保证落盘内容可审计。 */
export function sanitizeDecision(entry = {}, now = new Date()) {
  const at = entry.at ? new Date(entry.at) : now
  const out = { at: (Number.isNaN(at.getTime()) ? now : at).toISOString() }
  for (const key of FIELDS) {
    const value = shrink(entry[key])
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  out.privacy = { containsUserText: false, ...(entry.privacy || {}) }
  return out
}

export function validateDecision(entry = {}) {
  const problems = []
  if (!entry.kind) problems.push('kind is required')
  if (!entry.choice) problems.push('choice is required')
  if (entry.kind && !/^[a-z][a-z0-9-]*$/.test(entry.kind)) problems.push('kind must be kebab-case')
  return { ok: problems.length === 0, problems }
}

export function createDecisionLog({ root, now = () => new Date(), retentionDays = 30 } = {}) {
  if (!root) throw new Error('decision log root is required')
  const dir = path.join(root, 'decisions')
  let closed = false

  function fileFor(date) {
    return path.join(dir, `${dayKey(date)}.jsonl`)
  }

  /** 记录一条决策；不合法的记录返回 { ok:false }，不抛错打断调用方。 */
  function record(entry) {
    if (closed) return { ok: false, reason: 'closed' }
    const check = validateDecision(entry)
    if (!check.ok) return { ok: false, reason: check.problems.join('; ') }
    const row = sanitizeDecision(entry, now())
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(fileFor(now()), JSON.stringify(row) + '\n', 'utf8')
      return { ok: true, row }
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) }
    }
  }

  function readDay(day) {
    const rows = []
    try {
      for (const line of fs.readFileSync(path.join(dir, `${day}.jsonl`), 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          rows.push(JSON.parse(line))
        } catch {
          // 坏行跳过，不影响其它记录
        }
      }
    } catch {
      // 当天没有文件
    }
    return rows
  }

  /** 查询：默认最近 7 天，按新→旧。 */
  function query({ kind = '', from = '', to = '', days = 7, limit = 100, now: at = now() } = {}) {
    const end = at instanceof Date ? at : new Date(at)
    const span = Math.max(1, Math.min(90, Number(days) || 7))
    const rows = []
    for (let i = 0; i < span; i += 1) {
      const day = new Date(end.getTime() - i * 86_400_000)
      const key = dayKey(day)
      if (from && key < from) break
      if (to && key > to) continue
      rows.push(...readDay(key))
    }
    const filtered = kind ? rows.filter((row) => row.kind === kind) : rows
    return filtered.slice(-Math.max(1, Math.min(1000, Number(limit) || 100))).reverse()
  }

  /** 按 kind 聚合计数，给 self_limits / 指标用。 */
  function tally({ kind = '', days = 7, now: at = now() } = {}) {
    const rows = query({ kind, days, limit: 1000, now: at })
    const byChoice = {}
    for (const row of rows) byChoice[row.choice] = (byChoice[row.choice] || 0) + 1
    return { total: rows.length, byChoice }
  }

  function close() {
    closed = true
  }

  return { dir, record, query, tally, readDay, close, retentionDays }
}
