/**
 * dsh-memory-unified — SQLite 存储后端（设计说明书 v2 · P1）
 *
 * 为什么换：JSON 整文件重写既不原子也不可索引。Node 24 内置 node:sqlite（SQLite 3.53），
 * 于是可以「零依赖」拿到 WAL、事务、FTS5 与 BM25。
 *
 * 索引策略（实测见 ../../docs/MEMORY-DESIGN-v2.md §6）：
 *   不存原文进 FTS，而是存「bigram token 串」——中文没有空格，
 *   FTS5 的 unicode61 / trigram 都没法稳定命中两字词。
 *
 * 兼容：读不到 node:sqlite 时由 index.js 回退到 JSON 存储，插件不能因此加载失败。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { assertMemorySafe, jaccard, simhash64, tokenize } from './engine.js'

const require = createRequire(import.meta.url)
let sqlite = null
try {
  sqlite = require('node:sqlite')
} catch {
  sqlite = null
}

// 不同 Node 版本导出的类名不同（24.21 是 DatabaseSync，新版本改成 Database）
const DatabaseCtor = sqlite ? sqlite.Database || sqlite.DatabaseSync : null

export function sqliteReady() {
  return typeof DatabaseCtor === 'function'
}

const SCHEMA_VERSION = 1
const FOLDER_KEYWORD_CAP = 20

function tokensQuery(text) {
  const tokens = tokenize(text)
  if (tokens.length === 0) return ''
  return tokens.map((token) => `"${token.replace(/"/g, '')}"`).join(' OR ')
}

function parseKeywords(raw) {
  try {
    const value = JSON.parse(raw || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function recencyScore(createdAt, now = Date.now()) {
  const ageDays = Math.max(0, (now - Number(createdAt || now)) / 86400000)
  return Math.exp(-ageDays / 30)
}

export class SqliteStore {
  constructor(dir, { log } = {}) {
    if (!sqliteReady()) throw new Error('node:sqlite unavailable')
    this.dir = dir
    this.log = typeof log === 'function' ? log : () => {}
    this.db = null
  }

  // ------------------------------------------------------------ 打开/建表
  open() {
    if (this.db) return this
    fs.mkdirSync(this.dir, { recursive: true })
    const file = path.join(this.dir, 'memory.db')
    this.db = new DatabaseCtor(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 2000;
      PRAGMA foreign_keys = ON;
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS folders (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        keywords TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT NOT NULL UNIQUE,
        folder_id INTEGER NOT NULL REFERENCES folders(id),
        text TEXT NOT NULL,
        keywords TEXT NOT NULL DEFAULT '[]',
        category TEXT NOT NULL DEFAULT 'general',
        importance REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active',
        superseded_by TEXT,
        valid_to INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL DEFAULT 0,
        access_count INTEGER NOT NULL DEFAULT 0,
        simhash TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_mem_folder ON memories(folder_id, status);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(tokens);
    `)
    this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
    return this
  }

  close() {
    try {
      this.db?.close()
    } catch {
      // ignore
    }
    this.db = null
  }

  // ------------------------------------------------------------ 写入
  upsertFolder(name, keywords = []) {
    const now = Date.now()
    const cleaned = String(name || '未命名').trim() || '未命名'
    let row = this.db.prepare('SELECT id, keywords FROM folders WHERE name = ?').get(cleaned)
    if (!row) {
      const info = this.db
        .prepare('INSERT INTO folders(name, keywords, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(cleaned, JSON.stringify([]), now, now)
      row = { id: Number(info.lastInsertRowid), keywords: '[]' }
    }
    const merged = parseKeywords(row.keywords)
    for (const keyword of keywords || []) {
      if (keyword && !merged.includes(keyword)) merged.push(keyword)
    }
    const capped = merged.slice(-FOLDER_KEYWORD_CAP)
    this.db
      .prepare('UPDATE folders SET keywords = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(capped), now, row.id)
    return { id: row.id, name: cleaned, keywords: capped }
  }

  /**
   * 写入一条（去重 + 失效语义与 JSON 后端一致）。
   * @returns {{item: object, folder: object, action: 'inserted'|'duplicate'|'updated', supersededId?: string}}
   */
  addItem({
    folderName,
    text,
    keywords = [],
    importance = 0.5,
    category = 'general',
    maxItems = 200,
    dedupe = true,
    duplicateRatio = 0.9,
    updateRatio = 0.5,
  }) {
    assertMemorySafe(text)
    const cleaned = String(text || '').trim()
    const now = Date.now()
    const folder = this.upsertFolder(folderName, keywords)
    let action = 'inserted'
    let supersededId = ''

    this.db.exec('BEGIN IMMEDIATE')
    try {
      let target = null
      if (dedupe) {
        const query = tokensQuery(cleaned)
        if (query) {
          const rows = this.db
            .prepare(
              `SELECT m.id, m.text, m.keywords, m.importance, m.category, m.created_at
                 FROM memory_fts JOIN memories m ON m.rowid = memory_fts.rowid
                WHERE memory_fts MATCH ? AND m.folder_id = ? AND m.status = 'active'
                ORDER BY bm25(memory_fts) LIMIT 5`,
            )
            .all(query, folder.id)
          const cleanedTokens = tokenize(cleaned)
          for (const row of rows) {
            if (row.text === cleaned) {
              target = { row, duplicate: true }
              break
            }
            const ratio = jaccard(tokenize(row.text), cleanedTokens)
            if (ratio >= duplicateRatio) {
              target = { row, duplicate: true }
              break
            }
            if (ratio >= updateRatio) {
              target = { row, duplicate: false }
              break
            }
          }
        }
      }

      if (target && target.duplicate) {
        const merged = parseKeywords(target.row.keywords)
        for (const keyword of keywords) if (keyword && !merged.includes(keyword)) merged.push(keyword)
        this.db
          .prepare('UPDATE memories SET keywords = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(merged.slice(-40)), now, target.row.id)
        action = 'duplicate'
        this.db.exec('COMMIT')
        return {
          item: { id: target.row.id, text: target.row.text, keywords: merged },
          folder: { ...folder, items: [], activeCount: this.#activeCount(folder.id) },
          action,
        }
      }

      const id = `m${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const info = this.db
        .prepare(
          `INSERT INTO memories(folder_id, id, text, keywords, category, importance, status,
             created_at, updated_at, simhash)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          folder.id,
          id,
          cleaned,
          JSON.stringify(keywords.slice()),
          category,
          Number.isFinite(importance) ? Math.min(1, Math.max(0, importance)) : 0.5,
          now,
          now,
          String(simhash64(cleaned)),
        )
      const rowid = Number(info.lastInsertRowid)
      const ftsTokens = tokenize(cleaned).join(' ')
      this.db.prepare('INSERT INTO memory_fts(rowid, tokens) VALUES (?, ?)').run(rowid, ftsTokens)

      if (target) {
        this.db
          .prepare("UPDATE memories SET status = 'superseded', superseded_by = ?, valid_to = ?, updated_at = ? WHERE id = ?")
          .run(id, now, now, target.row.id)
        supersededId = target.row.id
        action = 'updated'
      }

      // 超限：先清失效条目，再按最旧裁剪
      const count = this.db.prepare('SELECT COUNT(*) c FROM memories WHERE folder_id = ?').get(folder.id).c
      if (count > maxItems) {
        const excess = count - maxItems
        const doomed = this.db
          .prepare(
            `SELECT id FROM memories WHERE folder_id = ? AND status <> 'active'
              ORDER BY created_at ASC LIMIT ?`,
          )
          .all(folder.id, excess)
        for (const row of doomed) this.#hardDelete(row.id)
      }

      this.db.exec('COMMIT')
      return {
        item: { id, text: cleaned, keywords: keywords.slice(), importance, category, createdAt: now },
        folder: { ...folder, items: [], activeCount: this.#activeCount(folder.id) },
        action,
        supersededId,
      }
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw error
    }
  }

  #hardDelete(id) {
    const row = this.db.prepare('SELECT rowid AS rid FROM memories WHERE id = ?').get(id)
    if (!row) return
    this.db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(row.rid)
    this.db.prepare('DELETE FROM memories WHERE rowid = ?').run(row.rid)
  }

  #activeCount(folderId) {
    return this.db
      .prepare("SELECT COUNT(*) c FROM memories WHERE folder_id = ? AND status = 'active'")
      .get(folderId).c
  }

  // ------------------------------------------------------------ 检索
  /**
   * 候选来自 FTS5（BM25 排序），最终分数用「词面命中率」算——BM25 的绝对量级
   * 随语料规模剧烈变化（小库里常见词 IDF 归零、分数为 0），不能当阈值用。
   */
  search(query, { limit = 8, minRatio = 0.2, folder = '' } = {}) {
    const match = tokensQuery(query)
    const queryTokens = tokenize(query)
    if (!match || queryTokens.length === 0) return []
    const scope = String(folder || '').trim()
    const sql = `SELECT m.id, m.text, m.category, m.importance, m.created_at, m.access_count,
                fd.name AS folder, bm25(memory_fts) AS rank
           FROM memory_fts
           JOIN memories m ON m.rowid = memory_fts.rowid
           JOIN folders fd ON fd.id = m.folder_id
          WHERE memory_fts MATCH ? AND m.status = 'active'${scope ? ' AND fd.name = ?' : ''}
          ORDER BY rank LIMIT 50`
    const rows = scope
      ? this.db.prepare(sql).all(match, scope)
      : this.db.prepare(sql).all(match)
    const now = Date.now()
    const hits = []
    for (const row of rows) {
      const target = new Set(tokenize(row.text))
      let hit = 0
      for (const token of queryTokens) {
        if (target.has(token)) hit += token.length >= 2 ? 1 : 0.4
      }
      if (hit <= 0) continue // 拒答：没有任何词面命中
      const ratio = hit / queryTokens.length
      if (ratio < minRatio) continue
      const bm25 = -Number(row.rank || 0) // FTS5 返回负数，取反后越大越相关
      const score = 0.6 * ratio + 0.25 * (row.importance || 0.5) + 0.15 * recencyScore(row.created_at, now)
      hits.push({
        folder: row.folder,
        id: row.id,
        text: row.text,
        category: row.category,
        importance: row.importance,
        createdAt: row.created_at,
        score: Number(score.toFixed(4)),
        hitRatio: Number(ratio.toFixed(3)),
        bm25: Number(bm25.toFixed(3)),
      })
    }
    hits.sort((a, b) => b.score - a.score || b.bm25 - a.bm25)
    return hits.slice(0, limit)
  }

  touch(ids = []) {
    if (!ids.length) return
    const now = Date.now()
    try {
      const stmt = this.db.prepare('UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?')
      this.db.exec('BEGIN IMMEDIATE')
      for (const id of ids) stmt.run(now, id)
      this.db.exec('COMMIT')
    } catch {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore
      }
    }
  }

  // ------------------------------------------------------------ 删除
  forget({ id, folderName, query } = {}) {
    const now = Date.now()
    const params = []
    let where = "status = 'active'"
    if (id) {
      where += ' AND id = ?'
      params.push(id)
    } else if (query) {
      const tokens = tokenize(query).filter((token) => token.length >= 2)
      if (tokens.length === 0) return { count: 0, ids: [] }
      where += ` AND (${tokens.map(() => 'text LIKE ?').join(' OR ')})`
      for (const token of tokens) params.push(`%${token}%`)
    } else {
      return { count: 0, ids: [] }
    }
    if (folderName) {
      where += ' AND folder_id = (SELECT id FROM folders WHERE name = ?)'
      params.push(String(folderName).trim())
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const rows = this.db.prepare(`SELECT id FROM memories WHERE ${where}`).all(...params)
      const stmt = this.db.prepare("UPDATE memories SET status = 'deleted', valid_to = ?, updated_at = ? WHERE id = ?")
      for (const row of rows) stmt.run(now, now, row.id)
      this.db.exec('COMMIT')
      return { count: rows.length, ids: rows.map((row) => row.id) }
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw error
    }
  }

  // ------------------------------------------------------------ 视图
  allFolders() {
    const folders = this.db.prepare('SELECT id, name, keywords, created_at, updated_at FROM folders ORDER BY id').all()
    return folders.map((folder) => {
      const items = this.db
        .prepare(
          `SELECT id, text, keywords, category, importance, status, created_at
             FROM memories WHERE folder_id = ? ORDER BY created_at ASC`,
        )
        .all(folder.id)
        .map((item) => ({
          id: item.id,
          text: item.text,
          keywords: parseKeywords(item.keywords),
          category: item.category,
          importance: item.importance,
          status: item.status,
          createdAt: item.created_at,
        }))
      return {
        id: folder.id,
        name: folder.name,
        keywords: parseKeywords(folder.keywords),
        createdAt: folder.created_at,
        updatedAt: folder.updated_at,
        items,
      }
    })
  }

  stats() {
    const active = this.db.prepare("SELECT COUNT(*) c FROM memories WHERE status = 'active'").get().c
    const total = this.db.prepare('SELECT COUNT(*) c FROM memories').get().c
    const folders = this.db.prepare('SELECT COUNT(*) c FROM folders').get().c
    return { storeDir: this.dir, folders, items: active, archived: total - active, backend: 'sqlite' }
  }

  /** 体检：状态分布、重复组、FTS 漂移、体积、时间范围。 */
  doctor() {
    const stats = this.stats()
    const byStatus = {}
    for (const row of this.db.prepare('SELECT status, COUNT(*) c FROM memories GROUP BY status').all()) {
      byStatus[row.status] = row.c
    }
    const memCount = this.db.prepare('SELECT COUNT(*) c FROM memories').get().c
    const ftsCount = this.db.prepare('SELECT COUNT(*) c FROM memory_fts').get().c
    const pageCount = Number(this.db.prepare('PRAGMA page_count').get().page_count || 0)
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get().page_size || 0)
    const range = this.db
      .prepare("SELECT MIN(created_at) a, MAX(created_at) b FROM memories WHERE status = 'active'")
      .get()
    const duplicates = this.consolidateDuplicates({ dryRun: true }).duplicates
    return {
      backend: 'sqlite',
      storeDir: this.dir,
      folders: stats.folders,
      items: stats.items,
      archived: stats.archived,
      byStatus,
      duplicateGroups: duplicates,
      ftsDrift: memCount - ftsCount,
      dbBytes: pageCount * pageSize,
      oldestAt: range.a || 0,
      newestAt: range.b || 0,
    }
  }

  /** 导出为可 diff 的 JSON（含已失效/已删除条目，便于审计）。 */
  exportToFile(directory) {
    const target = path.resolve(directory || path.join(this.dir, 'exports'))
    fs.mkdirSync(target, { recursive: true })
    const file = path.join(target, `memory-${Date.now()}.json`)
    const folders = this.allFolders()
    const payload = {
      schema: 'dsh-memory-unified/v2',
      exportedAt: Date.now(),
      folders: folders.map((folder) => ({
        name: folder.name,
        keywords: folder.keywords,
        items: folder.items,
      })),
    }
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
    const items = payload.folders.reduce((sum, folder) => sum + folder.items.length, 0)
    return { file, folders: payload.folders.length, items }
  }

  /** 导入 JSON（本插件导出格式或 v1 格式均可）。按 id 去重，只导入活跃条目。 */
  importFromFile(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const folders = Array.isArray(data?.folders) ? data.folders : []
    let imported = 0
    let skipped = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const folder of folders) {
        const target = this.upsertFolder(folder.name || '导入', folder.keywords || [])
        const items = Array.isArray(folder.items) ? folder.items : []
        for (const item of items) {
          try { assertMemorySafe(item.text) } catch { skipped += 1; continue }
          if (item.status && item.status !== 'active') {
            skipped += 1
            continue
          }
          const now = Number(item.createdAt) || Date.now()
          const id = String(item.id || `m${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`)
          if (this.db.prepare('SELECT 1 FROM memories WHERE id = ?').get(id)) {
            skipped += 1
            continue
          }
          const info = this.db
            .prepare(
              `INSERT INTO memories(folder_id, id, text, keywords, category, importance, status,
                 created_at, updated_at, simhash)
               VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
            )
            .run(
              target.id,
              id,
              String(item.text || ''),
              JSON.stringify(item.keywords || []),
              item.category || 'general',
              Number.isFinite(item.importance) ? item.importance : 0.5,
              now,
              now,
              String(simhash64(item.text || '')),
            )
          this.db
            .prepare('INSERT INTO memory_fts(rowid, tokens) VALUES (?, ?)')
            .run(Number(info.lastInsertRowid), tokenize(item.text || '').join(' '))
          imported += 1
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw error
    }
    return { imported, skipped }
  }

  /**
   * 合并重复记忆：同主题内文本完全相同或 Jaccard ≥ ratio（默认 0.9）。
   * 保留最早一条，其余标 superseded。迁移进来的老库常有这种重复（v0.2 没有去重）。
   */
  consolidateDuplicates({ dryRun = false, ratio = 0.9 } = {}) {
    const rows = this.db
      .prepare("SELECT id, folder_id, text, created_at FROM memories WHERE status = 'active' ORDER BY folder_id, created_at ASC")
      .all()
    const byFolder = new Map()
    for (const row of rows) {
      if (!byFolder.has(row.folder_id)) byFolder.set(row.folder_id, [])
      byFolder.get(row.folder_id).push(row)
    }
    const merges = []
    for (const list of byFolder.values()) {
      const kept = []
      for (const row of list) {
        const duplicate = kept.find((candidate) =>
          String(candidate.text).trim() === String(row.text).trim() ||
          jaccard(tokenize(candidate.text), tokenize(row.text)) >= ratio,
        )
        if (duplicate) {
          merges.push({ keep: duplicate.id, drop: row.id })
        } else {
          kept.push(row)
        }
      }
    }
    if (!dryRun && merges.length > 0) {
      const now = Date.now()
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const stmt = this.db.prepare(
          "UPDATE memories SET status = 'superseded', superseded_by = ?, valid_to = ?, updated_at = ? WHERE id = ?",
        )
        for (const merge of merges) stmt.run(merge.keep, now, now, merge.drop)
        this.db.exec('COMMIT')
      } catch (error) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          // ignore
        }
        throw error
      }
    }
    return { duplicates: merges.length, merges }
  }

  /** 兼容旧名：只合并判据同名方法。 */
  consolidateExactDuplicates(options = {}) {
    return this.consolidateDuplicates({ ...options, ratio: 1 })
  }

  // ------------------------------------------------------------ 迁移
  /** 若库为空且目录里有 v1 JSON，自动导入（JSON 原样保留，可回滚）。 */
  migrateFromJsonIfEmpty() {
    const count = this.db.prepare('SELECT COUNT(*) c FROM memories').get().c
    if (count > 0) return { migrated: 0, skipped: true }
    return this.migrateFromJson({ force: false })
  }

  /**
   * 从 v1 JSON 导入记忆。
   *   force=false：只在库为空时导入（首次迁移）
   *   force=true ：增量补齐 JSON 里有、但库里没有的条目（切换期间防丢）
   */
  migrateFromJson({ force = false } = {}) {
    const indexFile = path.join(this.dir, 'index.json')
    if (!fs.existsSync(indexFile)) return { migrated: 0, skipped: true }
    let index
    try {
      index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    } catch {
      return { migrated: 0, skipped: true }
    }
    let migrated = 0
    for (const entry of index.folders || []) {
      const folderFile = path.join(this.dir, 'folders', `${entry.id}.json`)
      if (!fs.existsSync(folderFile)) continue
      let folder
      try {
        folder = JSON.parse(fs.readFileSync(folderFile, 'utf8'))
      } catch {
        continue
      }
      const target = this.upsertFolder(folder.name || entry.name || '未命名', folder.keywords || [])
      for (const item of folder.items || []) {
        try { assertMemorySafe(item.text) } catch { continue }
        if (item.status && item.status !== 'active') continue
        const now = Number(item.createdAt) || Date.now()
        const id = String(item.id || `m${now.toString(36)}`)
        if (force && this.db.prepare('SELECT 1 FROM memories WHERE id = ?').get(id)) continue
        try {
          const info = this.db
            .prepare(
              `INSERT INTO memories(folder_id, id, text, keywords, category, importance, status,
                 created_at, updated_at, simhash)
               VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
            )
            .run(
              target.id,
              id,
              String(item.text || ''),
              JSON.stringify(item.keywords || []),
              item.category || 'general',
              Number.isFinite(item.importance) ? item.importance : 0.5,
              now,
              now,
              String(simhash64(item.text || '')),
            )
          this.db
            .prepare('INSERT INTO memory_fts(rowid, tokens) VALUES (?, ?)')
            .run(Number(info.lastInsertRowid), tokenize(item.text || '').join(' '))
          migrated += 1
        } catch {
          // 单条失败不影响整体迁移
        }
      }
    }
    this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('migrated_from_json', String(migrated))
    return { migrated, skipped: false }
  }
}

export function createSqliteStore(dir) {
  if (!sqliteReady()) throw new Error('node:sqlite unavailable')
  const store = new SqliteStore(dir)
  store.open()
  return store
}
