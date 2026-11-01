/**
 * 桌宠对话留痕的读取层（数据由 pet-hub 的 /line 写入）。
 *
 * 目录：~/.dsh/pet-diary/chats/YYYY-MM-DD.jsonl
 * 每行：{ at, channel, moment, text, model }
 *
 * 这里只读不写；坏行跳过，不让一条脏数据毁掉整天。
 */

import fs from 'node:fs'
import path from 'node:path'

const DAY_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/

function pad(n) {
  return String(n).padStart(2, '0')
}

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function clockOf(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--'
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export class ChatLog {
  constructor(root) {
    this.dir = path.join(root, 'chats')
  }

  #dayFiles() {
    let names
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      return []
    }
    return names
      .filter((name) => DAY_RE.test(name))
      .sort((a, b) => (a < b ? 1 : -1)) // 新→旧
      .map((name) => ({ date: name.slice(0, 10), file: path.join(this.dir, name) }))
  }

  #entries(file, date) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const out = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const row = JSON.parse(trimmed)
        if (!row || typeof row.text !== 'string') continue
        out.push({
          date,
          at: String(row.at || ''),
          clock: clockOf(row.at),
          channel: String(row.channel || 'unknown'),
          moment: String(row.moment || ''),
          text: row.text,
          model: String(row.model || ''),
        })
      } catch {
        // 坏行跳过
      }
    }
    return out
  }

  /** 最近几天各有多少条（给「她都聊了些什么」的总览）。 */
  days(limit = 7) {
    return this.#dayFiles()
      .slice(0, Math.max(1, limit))
      .map(({ date, file }) => ({ date, count: this.#entries(file, date).length }))
  }

  /** 某一天的对话（默认今天），按时间升序；limit 取最后 N 条。 */
  read(date = dayKey(), { limit = 200, channel = '' } = {}) {
    const file = path.join(this.dir, `${date}.jsonl`)
    let rows = this.#entries(file, date)
    if (channel) rows = rows.filter((row) => row.channel === channel)
    const size = Math.max(1, Number(limit) || 200)
    return rows.slice(-size)
  }

  /** 跨天关键词搜索（默认最近 30 天），命中按新→旧返回。 */
  search(query, { days = 30, limit = 20, channel = '' } = {}) {
    const needle = String(query || '').trim()
    if (!needle) return []
    const files = this.#dayFiles().slice(0, Math.max(1, days))
    const hits = []
    for (const { date, file } of files) {
      for (const row of this.#entries(file, date)) {
        if (channel && row.channel !== channel) continue
        if (row.text.includes(needle)) hits.push(row)
      }
    }
    hits.sort((a, b) => (a.at < b.at ? 1 : -1))
    return hits.slice(0, Math.max(1, Number(limit) || 20))
  }

  /** 全量统计（不返回正文）。 */
  stats() {
    const files = this.#dayFiles()
    let total = 0
    for (const { date, file } of files) total += this.#entries(file, date).length
    return { days: files.length, entries: total, firstDay: files.length ? files[files.length - 1].date : '', lastDay: files.length ? files[0].date : '' }
  }
}

export { dayKey }
