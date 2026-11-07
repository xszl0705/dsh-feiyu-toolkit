/**
 * 图片 / 表情包 / GIF 库（渠道无关）。
 *
 * 两档：
 * - recent：收到就落盘，用来「记住看过什么图」，按数量和总字节滚动淘汰；
 * - saved：明确收藏（AI 判断值得 / 主人说存这个），永久保留，不参与淘汰。
 *
 * GIF 与动图原样保存，不转码，不抽帧；动图靠文件头识别（GIF/APNG/动态 WebP）。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_DIR_NAME = 'image-library'
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_RECENT_FILES = 300
const DEFAULT_MAX_RECENT_BYTES = 150 * 1024 * 1024

export function defaultImageLibraryDir() {
  const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(base, 'dafeiyu', DEFAULT_DIR_NAME)
}

export function hashOf(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

function px(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function pngSize(b) {
  if (b.length < 24) return { width: 0, height: 0 }
  return { width: px(b.readUInt32BE(16)), height: px(b.readUInt32BE(20)) }
}

function gifSize(b) {
  if (b.length < 10) return { width: 0, height: 0 }
  return { width: px(b.readUInt16LE(6)), height: px(b.readUInt16LE(8)) }
}

function jpegSize(b) {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue }
    const marker = b[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    if (marker === 0xd9 || marker === 0xda) break
    const len = b.readUInt16BE(i + 2)
    if (len < 2) break
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) return { width: px(b.readUInt16BE(i + 7)), height: px(b.readUInt16BE(i + 5)) }
    i += 2 + len
  }
  return { width: 0, height: 0 }
}

function webpSize(b) {
  if (b.length < 30) return { width: 0, height: 0 }
  const kind = b.toString('ascii', 12, 16)
  if (kind === 'VP8X') {
    return { width: px(1 + b.readUIntLE(24, 3)), height: px(1 + b.readUIntLE(27, 3)) }
  }
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21)
    return { width: px(1 + (bits & 0x3fff)), height: px(1 + ((bits >> 14) & 0x3fff)) }
  }
  if (kind === 'VP8 ') {
    return { width: px(b.readUInt16LE(26) & 0x3fff), height: px(b.readUInt16LE(28) & 0x3fff) }
  }
  return { width: 0, height: 0 }
}

function pngAnimated(b) {
  // APNG：actl 出现在 IDAT 之前
  for (let i = 8; i + 12 < b.length && i < 4096;) {
    const len = b.readUInt32BE(i)
    const type = b.toString('ascii', i + 4, i + 8)
    if (type === 'acTL') return true
    if (type === 'IDAT') return false
    i += 12 + len
  }
  return false
}

/** 从文件头判断类型、动图标记与尺寸；不是图片返回 null。 */
export function sniffImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null
  const b = bytes
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') {
    const size = pngSize(b)
    return { mediaType: 'image/png', ext: 'png', animated: pngAnimated(b), ...size }
  }
  if (b.toString('ascii', 0, 4) === 'GIF8') {
    const size = gifSize(b)
    // 静态 GIF 也存在，但 QQ 场景里基本是表情包动图；帧数检查代价高，按动图记
    return { mediaType: 'image/gif', ext: 'gif', animated: true, ...size }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    const size = jpegSize(b)
    return { mediaType: 'image/jpeg', ext: 'jpg', animated: false, ...size }
  }
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const animated = b.includes(Buffer.from('ANIM', 'ascii'))
    const size = webpSize(b)
    return { mediaType: 'image/webp', ext: 'webp', animated, ...size }
  }
  if (b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12)
    if (brand === 'avif' || brand === 'avis') {
      return { mediaType: 'image/avif', ext: 'avif', animated: brand === 'avis', width: 0, height: 0 }
    }
    return null
  }
  return null
}

function readIndexFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const items = Array.isArray(raw?.items) ? raw.items.filter((x) => x && typeof x.id === 'string') : []
    return { version: 1, items }
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, items: [] }
    try {
      fs.renameSync(file, file + '.broken-' + Date.now())
    } catch {
      // 坏索引不动它也行，下次再试
    }
    return { version: 1, items: [] }
  }
}

function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  const out = []
  for (const tag of tags) {
    const text = truncate(tag, 12)
    if (text && !out.includes(text)) out.push(text)
    if (out.length >= 6) break
  }
  return out
}

/**
 * @param {object} options
 * @param {string} [options.dir] 库目录（默认 ~/.dsh/dafeiyu/image-library）
 * @param {number} [options.maxFileBytes] 单图上限，超过不入库
 * @param {number} [options.maxRecentFiles] recent 档保留文件数
 * @param {number} [options.maxRecentBytes] recent 档保留总字节
 * @param {() => number} [options.now]
 */
export function createImageLibrary({
  dir = defaultImageLibraryDir(),
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxRecentFiles = DEFAULT_MAX_RECENT_FILES,
  maxRecentBytes = DEFAULT_MAX_RECENT_BYTES,
  now = Date.now,
} = {}) {
  const root = path.resolve(dir)
  const filesDir = path.join(root, 'files')
  const indexFile = path.join(root, 'index.json')
  let db = null

  function ensureDir() {
    fs.mkdirSync(filesDir, { recursive: true })
  }

  function data() {
    if (!db) db = readIndexFile(indexFile)
    return db
  }

  function persist() {
    ensureDir()
    const body = JSON.stringify(data(), null, 2)
    const tmp = indexFile + '.tmp-' + process.pid
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, indexFile)
  }

  function find(key) {
    const k = String(key || '')
    if (!k) return null
    return data().items.find((item) => item.id === k || item.sha === k) || null
  }

  function fileOf(item) {
    return path.join(filesDir, `${item.id}.${item.ext}`)
  }

  /** 收进最近档；同图（sha 相同）只累加次数，不重复落盘。 */
  function remember(input = {}) {
    const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes || [])
    const sniffed = sniffImage(bytes)
    if (!sniffed) return { ok: false, reason: 'not-image' }
    if (bytes.length > maxFileBytes) return { ok: false, reason: 'too-large', bytes: bytes.length }
    const sha = hashOf(bytes)
    const items = data().items
    const existing = find(sha)
    const at = new Date(now()).toISOString()
    if (existing) {
      existing.lastSeen = at
      existing.seen = (Number(existing.seen) || 1) + 1
      if (input.caption) existing.caption = truncate(input.caption, 300)
      if (input.saved) {
        existing.saved = true
        existing.savedAt ||= at
      }
      existing.tags = normalizeTags([...(existing.tags || []), ...(input.tags || [])])
      persist()
      return { ok: true, created: false, record: { ...existing }, path: fileOf(existing) }
    }
    const id = sha.slice(0, 12)
    const record = {
      id,
      sha,
      ext: sniffed.ext,
      mediaType: sniffed.mediaType,
      animated: Boolean(sniffed.animated),
      width: sniffed.width || 0,
      height: sniffed.height || 0,
      bytes: bytes.length,
      caption: truncate(input.caption, 300),
      tags: normalizeTags(input.tags),
      saved: Boolean(input.saved),
      savedAt: input.saved ? at : '',
      seen: 1,
      firstSeen: at,
      lastSeen: at,
      source: {
        channel: String(input.source?.channel || 'unknown').slice(0, 16),
        kind: String(input.source?.kind || '').slice(0, 16),
        userId: String(input.source?.userId || '').slice(0, 32),
        groupId: String(input.source?.groupId || '').slice(0, 32),
        messageId: String(input.source?.messageId || '').slice(0, 64),
        name: truncate(input.source?.name, 32),
      },
    }
    ensureDir()
    fs.writeFileSync(fileOf(record), bytes)
    items.push(record)
    persist()
    prune()
    return { ok: true, created: true, record: { ...record }, path: fileOf(record) }
  }

  function update(id, patch = {}) {
    const item = find(id)
    if (!item) throw new Error('图片不存在：' + id)
    if (patch.caption !== undefined) item.caption = truncate(patch.caption, 300)
    if (patch.tags) item.tags = normalizeTags([...(item.tags || []), ...patch.tags])
    if (patch.saved === true) {
      item.saved = true
      item.savedAt ||= new Date(now()).toISOString()
    }
    if (patch.saved === false) {
      item.saved = false
      item.savedAt = ''
    }
    persist()
    return { ...item, path: fileOf(item) }
  }

  function forget(id) {
    const item = find(id)
    if (!item) return false
    db.items = data().items.filter((x) => x.id !== item.id)
    try {
      fs.unlinkSync(fileOf(item))
    } catch {
      // 文件已不在也算删除成功
    }
    persist()
    return true
  }

  function prune() {
    const items = data().items
    const recent = items.filter((x) => !x.saved).sort((a, b) => String(a.lastSeen).localeCompare(String(b.lastSeen)))
    let count = recent.length
    let bytes = recent.reduce((sum, x) => sum + (Number(x.bytes) || 0), 0)
    const removed = []
    while (recent.length && (count > maxRecentFiles || bytes > maxRecentBytes)) {
      const victim = recent.shift()
      count -= 1
      bytes -= Number(victim.bytes) || 0
      removed.push(victim.id)
      try {
        fs.unlinkSync(fileOf(victim))
      } catch {
        // 文件已不在，忽略
      }
      db.items = db.items.filter((x) => x.id !== victim.id)
    }
    if (removed.length) persist()
    return removed
  }

  function list({ saved, query = '', channel = '', limit = 20 } = {}) {
    const q = String(query || '').trim().toLowerCase()
    const rows = data().items
      .filter((x) => (saved === undefined ? true : Boolean(x.saved) === Boolean(saved)))
      .filter((x) => (channel ? x.source?.channel === channel : true))
      .filter((x) => (q
        ? [x.caption, (x.tags || []).join(' '), x.source?.name].join(' ').toLowerCase().includes(q)
        : true))
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 20)))
      .map((x) => ({ ...x, path: fileOf(x) }))
    return rows
  }

  function stats() {
    const items = data().items
    const savedItems = items.filter((x) => x.saved)
    return {
      root,
      total: items.length,
      saved: savedItems.length,
      recent: items.length - savedItems.length,
      bytes: items.reduce((sum, x) => sum + (Number(x.bytes) || 0), 0),
      savedBytes: savedItems.reduce((sum, x) => sum + (Number(x.bytes) || 0), 0),
      animated: items.filter((x) => x.animated).length,
    }
  }

  function latest() {
    const items = data().items.slice().sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
    return items[0] ? { ...items[0], path: fileOf(items[0]) } : null
  }

  return {
    root,
    filesDir,
    indexFile,
    maxFileBytes,
    remember,
    update,
    forget,
    prune,
    list,
    stats,
    latest,
    get: (id) => {
      const item = find(id)
      return item ? { ...item, path: fileOf(item) } : null
    },
    reload: () => {
      db = null
      return stats()
    },
  }
}
