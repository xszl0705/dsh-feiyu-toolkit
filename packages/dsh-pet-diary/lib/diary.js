/**
 * dsh-pet-diary — 双层日记存储（零依赖）
 *
 * 日常日记（对外）：daily/<YYYY-MM>/<YYYY-MM-DD>.md，普通路径、方便导出分享。
 * 隐私日记（对内）：private/<h1>/<h2>/<YYYY-MM-DD>.md，h = sha256(salt|date)，
 *   索引不落盘、工具不返回路径——机制上不主动泄露，但这不是加密（同一台机器可扫盘）。
 *
 * 两份都只用 node:fs / node:path / node:os / node:crypto。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const pad = (n) => String(n).padStart(2, '0')

export function defaultRoot() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'pet-diary')
}

export function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function clock(date = new Date()) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function isValidKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function writeText(file, text) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, text, 'utf8')
}

function appendText(file, text) {
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, text, 'utf8')
}

function countEntries(text) {
  return (String(text).match(/^## /gm) || []).length
}

function walk(dir) {
  const out = []
  let names
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of names) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

export class DailyDiary {
  constructor(root, { maxEntryChars = 2000, subdir = 'daily', label = '日常', title = '桌宠日常日记', filePrefix = 'pet-diary' } = {}) {
    this.dir = path.join(root, subdir)
    this.maxEntryChars = maxEntryChars
    this.label = label
    this.title = title
    this.filePrefix = filePrefix
  }

  fileFor(date) {
    return path.join(this.dir, date.slice(0, 7), `${date}.md`)
  }

  /** 追加一条日常日记，返回 {date, entriesToday}。 */
  write(text, { date = todayKey(), tags = [] } = {}) {
    const body = String(text || '').trim()
    if (!body) throw new Error('日记内容不能为空')
    if (body.length > this.maxEntryChars) throw new Error(`单条超过 ${this.maxEntryChars} 字`)
    const file = this.fileFor(date)
    if (!readText(file)) writeText(file, `# ${date}\n`)
    const tagText = (Array.isArray(tags) ? tags : []).filter(Boolean).map((tag) => `#${tag}`).join(' ')
    const head = `\n## ${clock()} · ${this.label}${tagText ? ' · ' + tagText : ''}\n\n`
    appendText(file, head + body + '\n')
    return { date, entriesToday: countEntries(readText(file)) }
  }

  read(date = todayKey()) {
    return readText(this.fileFor(date)).trim()
  }

  /** 最近若干天：{date, entries}。 */
  list(limit = 7) {
    const files = walk(this.dir)
      .filter((file) => isValidKey(path.basename(file, '.md')))
      .map((file) => ({ date: path.basename(file, '.md'), file }))
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, Math.max(1, limit))
    return files.map(({ date, file }) => ({ date, entries: countEntries(readText(file)) }))
  }

  /** 导出成一整份可分享的 Markdown。 */
  exportTo(directory) {
    const target = path.resolve(directory || path.join(path.dirname(this.dir), 'exports'))
    ensureDir(target)
    const stamp = new Date()
    const file = path.join(
      target,
      `${this.filePrefix}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.md`,
    )
    const files = walk(this.dir)
      .filter((item) => isValidKey(path.basename(item, '.md')))
      .sort()
    let days = 0
    let entries = 0
    const chunks = [`# ${this.title}\n`]
    for (const item of files) {
      const text = readText(item)
      if (!text.trim()) continue
      days += 1
      entries += countEntries(text)
      chunks.push(text.trim(), '\n---\n')
    }
    writeText(file, chunks.join('\n'))
    return { file, days, entries }
  }
}

/** 工作日志：与日常同构，但独立目录，不对外分享、不混进日常。 */
export class WorkDiary extends DailyDiary {
  constructor(root, options = {}) {
    super(root, { subdir: 'work', label: '工作', title: '工作日志', filePrefix: 'pet-work', ...options })
  }
}

export class PrivateDiary {
  constructor(root, { maxEntryChars = 2000, salt = '' } = {}) {
    this.dir = path.join(root, 'private')
    this.maxEntryChars = maxEntryChars
    this.fixedSalt = String(salt || '')
  }

  salt() {
    if (this.fixedSalt) return this.fixedSalt
    const file = path.join(this.dir, '.salt')
    const existing = readText(file).trim()
    if (existing) return existing
    const value = crypto.randomBytes(16).toString('hex')
    writeText(file, value)
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // Windows 上 chmod 无效，忽略
    }
    return value
  }

  fileFor(date) {
    const digest = crypto.createHash('sha256').update(`${this.salt()}|${date}`).digest('hex')
    return path.join(this.dir, digest.slice(0, 4), digest.slice(4, 8), `${date}.md`)
  }

  write(text, { date = todayKey(), mood = '' } = {}) {
    const body = String(text || '').trim()
    if (!body) throw new Error('日记内容不能为空')
    if (body.length > this.maxEntryChars) throw new Error(`单条超过 ${this.maxEntryChars} 字`)
    const file = this.fileFor(date)
    if (!readText(file)) writeText(file, `# ${date}\n`)
    const moodText = String(mood || '').trim()
    const head = `\n## ${clock()} · 私密${moodText ? ' · ' + moodText : ''}\n\n`
    appendText(file, head + body + '\n')
    return { date, entriesToday: countEntries(readText(file)) }
  }

  read(date = todayKey()) {
    return readText(this.fileFor(date)).trim()
  }

  /** 只回统计，不回路径、不回正文。 */
  stats() {
    const keys = walk(this.dir)
      .filter((file) => isValidKey(path.basename(file, '.md')))
      .map((file) => path.basename(file, '.md'))
      .sort()
    const today = todayKey()
    const yesterdayKey = (() => {
      const d = new Date()
      d.setDate(d.getDate() - 1)
      return todayKey(d)
    })()
    let streak = 0
    let cursor = keys.includes(today) ? today : keys.includes(yesterdayKey) ? yesterdayKey : ''
    while (cursor && keys.includes(cursor)) {
      streak += 1
      const d = new Date(`${cursor}T00:00:00`)
      d.setDate(d.getDate() - 1)
      cursor = todayKey(d)
    }
    return {
      days: keys.length,
      entries: keys.reduce((sum, key) => sum + countEntries(readText(this.fileFor(key))), 0),
      streak,
      firstDay: keys[0] || '',
      lastDay: keys[keys.length - 1] || '',
    }
  }
}
