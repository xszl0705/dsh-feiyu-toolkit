/**
 * 统一时间线：把四份时间流合成一条。
 *
 *   daily/<YYYY-MM>/<YYYY-MM-DD>.md    日常日记（## HH:MM · 标题）
 *   work/<YYYY-MM>/<YYYY-MM-DD>.md     工作日志（同一格式）
 *   chats/<YYYY-MM-DD>.jsonl           聊天留痕（每行一条）
 *   dafeiyu/decisions/<YYYY-MM-DD>.jsonl 决策日志（每行一条）
 *
 * 为什么需要它：想知道「今天到底发生了什么」得翻四个地方，
 * 而且四份东西的时间格式还不一样（一个是 Markdown 标题，三个是 JSONL）。
 *
 * 约束：只做合并与排序，不改写源文件；决策日志本来就不含用户正文，照原样透出。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const pad = (n) => String(n).padStart(2, '0')

export function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 解析日记类 Markdown：每个 `## HH:MM · 标题` 是一段。 */
function parseDiaryMarkdown(file, date, kind, source) {
  const entries = []
  let current = null
  for (const line of readText(file).split('\n')) {
    const head = line.match(/^##\s+(\d{1,2}:\d{2})\s+·\s+(.+)$/)
    if (head) {
      current = { time: head[1], title: head[2].trim(), body: [] }
      entries.push(current)
      continue
    }
    if (!current) continue
    if (/^#{1,6}\s/.test(line)) {
      current = null
      continue
    }
    const text = line.trim()
    if (text) current.body.push(text)
  }
  return entries
    .map((entry) => {
      const [hour, minute] = String(entry.time).split(':')
      const body = entry.body.join(' ').slice(0, 160)
      return {
        at: `${date}T${pad(hour)}:${pad(minute)}:00`,
        kind,
        source,
        text: entry.title + (body ? '：' + body : ''),
      }
    })
    .filter((entry) => entry.text)
}

function parseJsonl(file, kind, source, mapper) {
  const out = []
  for (const line of readText(file).split('\n')) {
    const raw = line.trim()
    if (!raw) continue
    let row
    try {
      row = JSON.parse(raw)
    } catch {
      continue
    }
    const mapped = mapper(row)
    if (mapped) out.push({ kind, source, ...mapped })
  }
  return out
}

/**
 * 收集某一天的完整时间线。
 *
 * root 默认 `~/.dsh/pet-diary`；decisionsDir 默认 `~/.dsh/dafeiyu/decisions`。
 */
export function collectTimeline({
  date,
  root,
  decisionsDir,
  limit = 60,
  kinds = ['daily', 'work', 'chat', 'decision'],
} = {}) {
  const day = isValidDate(date) ? String(date) : dayOf(new Date())
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const base = root || path.join(home, 'pet-diary')
  const decisions = decisionsDir || path.join(home, 'dafeiyu', 'decisions')
  const [year, month] = day.split('-')
  const rows = []

  if (kinds.includes('daily')) {
    rows.push(...parseDiaryMarkdown(path.join(base, 'daily', `${year}-${month}`, `${day}.md`), day, 'daily', '日常日记'))
  }
  if (kinds.includes('work')) {
    rows.push(...parseDiaryMarkdown(path.join(base, 'work', `${year}-${month}`, `${day}.md`), day, 'work', '工作日志'))
  }
  if (kinds.includes('chat')) {
    rows.push(
      ...parseJsonl(path.join(base, 'chats', `${day}.jsonl`), 'chat', '聊天留痕', (row) => {
        const text = String(row?.text || '').trim()
        if (!text) return null
        return {
          at: String(row.at || `${day}T00:00:00`),
          text: text.slice(0, 120),
          meta: { channel: row.channel || '', moment: row.moment || '' },
        }
      }),
    )
  }
  if (kinds.includes('decision')) {
    rows.push(
      ...parseJsonl(path.join(decisions, `${day}.jsonl`), 'decision', '决策', (row) => {
        const kind = String(row?.kind || '')
        const choice = String(row?.choice || '')
        if (!kind && !choice) return null
        const reason = String(row?.reason || '').trim()
        return {
          at: String(row?.at || `${day}T00:00:00`),
          text: [kind, choice].filter(Boolean).join(' → ') + (reason ? `（${reason}）` : ''),
          meta: { channel: row?.channel || '', scope: row?.scope || '' },
        }
      }),
    )
  }

  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)))
  const capped = rows.slice(-Math.max(1, Number(limit) || 60))
  const byKind = {}
  for (const row of capped) byKind[row.kind] = (byKind[row.kind] || 0) + 1
  return { date: day, count: capped.length, total: rows.length, byKind, entries: capped }
}

function dayOf(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
