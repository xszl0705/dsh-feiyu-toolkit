/**
 * dsh-memory-unified — 存储层
 *
 * 目录结构（默认 ~/.dsh/dsh-memory-unified，可用 config.json 的 storeDir / 环境变量覆盖）：
 *   index.json            { folders: [{id, name, keywords, createdAt, updatedAt, count}], nextId }
 *   folders/<id>.json     { id, name, keywords, createdAt, updatedAt, items: [...] }
 *
 * 为什么用「文件夹 + 条目」而不是扁平表：
 *   旧方案（rofm/engram/graph-memory）都是把记忆压成一条条向量/关键词，
 *   但人找记忆时是「那次聊桌宠的」这种按主题找，所以这里保留主题分层。
 *
 * 0.3 的改动（设计说明书 P0）：
 *   - 条目带状态机：active / superseded / deleted
 *   - 写入去重：SimHash + Jaccard，完全重复合并、近似重复走「知识更新」
 *   - forget：软删除（保留历史，不再参与检索）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertMemorySafe, jaccard, searchFolders, simhash64, tokenize } from './engine.js'

export function defaultStoreDir() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-memory-unified')
}

export function ensureDir(dir) {
  fs.mkdirSync(path.join(dir, 'folders'), { recursive: true })
  return dir
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

function isActive(item) {
  return !item.status || item.status === 'active'
}

function mergeKeywords(item, keywords) {
  if (!Array.isArray(item.keywords)) item.keywords = []
  for (const keyword of keywords || []) {
    if (keyword && !item.keywords.includes(keyword)) item.keywords.push(keyword)
  }
  if (item.keywords.length > 40) item.keywords = item.keywords.slice(-40)
}

export class MemoryStore {
  constructor(dir = defaultStoreDir()) {
    // 不在构造时就建目录：读多写少，而且构造失败会让整个插件加载失败。
    this.dir = dir
  }

  /** 只在真正要写的时候建目录；建不了就把错误抛给调用方（工具层会兜）。 */
  ensure() {
    return ensureDir(this.dir)
  }

  get indexFile() {
    return path.join(this.dir, 'index.json')
  }

  folderFile(id) {
    return path.join(this.dir, 'folders', `${id}.json`)
  }

  readIndex() {
    const index = readJson(this.indexFile, null)
    if (!index || !Array.isArray(index.folders)) return { folders: [], nextId: 1 }
    if (typeof index.nextId !== 'number') index.nextId = index.folders.length + 1
    return index
  }

  writeIndex(index) {
    this.ensure()
    writeJson(this.indexFile, index)
  }

  readFolder(id) {
    return readJson(this.folderFile(id), null)
  }

  writeFolder(folder) {
    this.ensure()
    writeJson(this.folderFile(folder.id), folder)
  }

  /** 新建或复用同名文件夹，返回文件夹对象。 */
  upsertFolder(name, keywords = []) {
    const index = this.readIndex()
    const cleaned = String(name || '未命名').trim() || '未命名'
    let entry = index.folders.find((f) => f.name === cleaned)
    const now = Date.now()
    if (!entry) {
      entry = { id: `f${index.nextId}`, name: cleaned, keywords: [], createdAt: now, updatedAt: now, count: 0 }
      index.nextId += 1
      index.folders.push(entry)
    }
    for (const keyword of keywords) {
      if (keyword && !entry.keywords.includes(keyword)) entry.keywords.push(keyword)
    }
    // 文件夹关键词封顶，避免越用越长稀释打分
    if (entry.keywords.length > 20) entry.keywords = entry.keywords.slice(-20)
    entry.updatedAt = now
    this.writeIndex(index)
    const folder = this.readFolder(entry.id) || {
      id: entry.id,
      name: entry.name,
      keywords: entry.keywords,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      items: [],
    }
    folder.keywords = entry.keywords
    return folder
  }

  /**
   * 写入一条记忆。
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
    simThreshold = 3,
    duplicateRatio = 0.9,
    updateRatio = 0.5,
  }) {
    assertMemorySafe(text)
    const folder = this.upsertFolder(folderName, keywords)
    const cleaned = String(text || '').trim()
    const now = Date.now()
    const hash = simhash64(cleaned)

    let superseded = null

    if (dedupe) {
      for (const old of folder.items || []) {
        if (!isActive(old)) continue
        const oldText = String(old.text || '').trim()
        if (oldText === cleaned) {
          mergeKeywords(old, keywords)
          old.updatedAt = now
          folder.updatedAt = now
          this.writeFolder(folder)
          return { item: old, folder, action: 'duplicate' }
        }
        // 纯词面 Jaccard 判重：SimHash 只作辅助元数据，阈值窗口太窄不适合单独决策
        const ratio = jaccard(tokenize(oldText), tokenize(cleaned))
        if (ratio >= duplicateRatio) {
          mergeKeywords(old, keywords)
          old.updatedAt = now
          folder.updatedAt = now
          this.writeFolder(folder)
          return { item: old, folder, action: 'duplicate' }
        }
        if (ratio >= updateRatio) {
          superseded = old
          break
        }
      }
    }

    const item = {
      id: `m${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text: cleaned,
      keywords: keywords.slice(),
      importance: Number.isFinite(importance) ? Math.min(1, Math.max(0, importance)) : 0.5,
      category,
      status: 'active',
      supersededBy: null,
      validTo: null,
      createdAt: now,
      updatedAt: now,
      lastAccessed: 0,
      accessCount: 0,
      simhash: String(hash),
    }
    folder.items.push(item)

    if (superseded) {
      superseded.status = 'superseded'
      superseded.validTo = now
      superseded.supersededBy = item.id
      superseded.updatedAt = now
    }

    // 超限时先清理已失效的旧条目，再动活跃条目
    if (folder.items.length > maxItems) {
      const inactive = folder.items.filter((entry) => !isActive(entry))
      const excess = folder.items.length - maxItems
      if (inactive.length > 0) {
        const drop = new Set(inactive.slice(0, excess).map((entry) => entry.id))
        folder.items = folder.items.filter((entry) => !drop.has(entry.id))
      }
      if (folder.items.length > maxItems) {
        folder.items = folder.items.slice(-maxItems)
      }
    }

    folder.updatedAt = now
    this.writeFolder(folder)

    const index = this.readIndex()
    const entry = index.folders.find((f) => f.id === folder.id)
    if (entry) {
      entry.count = folder.items.filter(isActive).length
      entry.updatedAt = now
      this.writeIndex(index)
    }
    return { item, folder, action: superseded ? 'updated' : 'inserted', supersededId: superseded?.id }
  }

  /**
   * 软删除：按 id，或「文件夹 + 查询词」批量。
   * @returns {{count: number, ids: string[]}}
   */
  forget({ id, folderName, query } = {}) {
    const index = this.readIndex()
    const targets = folderName
      ? index.folders.filter((entry) => entry.name === String(folderName).trim())
      : index.folders
    const queryTokens = query ? tokenize(query) : []
    const now = Date.now()
    const ids = []

    for (const entry of targets) {
      const folder = this.readFolder(entry.id)
      if (!folder) continue
      let changed = false
      for (const item of folder.items || []) {
        if (!isActive(item)) continue
        let matched = false
        if (id) {
          matched = item.id === id
        } else if (query) {
          const itemTokens = tokenize([item.text, ...(item.keywords || [])].join(' '))
          const hasToken = itemTokens.some((token) => token.length >= 2 && queryTokens.includes(token))
          matched = hasToken || String(item.text).includes(String(query).trim())
        } else {
          matched = true
        }
        if (!matched) continue
        item.status = 'deleted'
        item.validTo = now
        item.updatedAt = now
        ids.push(item.id)
        changed = true
      }
      if (changed) {
        this.writeFolder(folder)
        entry.count = (folder.items || []).filter(isActive).length
        entry.updatedAt = now
      }
    }
    if (ids.length) this.writeIndex(index)
    return { count: ids.length, ids }
  }

  /** 与 SQLite 后端保持同一接口：返回按分数排序的命中；可选按主题过滤。 */
  search(query, options = {}) {
    const folders = this.allFolders()
    const scope = String(options.folder || '').trim()
    const scoped = scope ? folders.filter((folder) => folder.name === scope) : folders
    return searchFolders(scoped, query, options)
  }

  /** 全部文件夹（含条目），用于检索。 */
  allFolders() {
    return this.readIndex()
      .folders.map((entry) => this.readFolder(entry.id))
      .filter(Boolean)
  }

  stats() {
    const folders = this.allFolders()
    const all = folders.reduce((sum, f) => sum + (f.items?.length || 0), 0)
    const active = folders.reduce((sum, f) => sum + (f.items || []).filter(isActive).length, 0)
    return {
      storeDir: this.dir,
      folders: folders.length,
      items: active,
      archived: all - active,
      backend: 'json',
    }
  }

  /** 体检（JSON 后端版本，字段与 SQLite 后端对齐）。 */
  doctor() {
    const folders = this.allFolders()
    const stats = this.stats()
    let duplicates = 0
    for (const folder of folders) {
      const active = (folder.items || []).filter(isActive)
      const kept = []
      for (const item of active) {
        const dup = kept.some(
          (candidate) =>
            String(candidate.text).trim() === String(item.text).trim() ||
            jaccard(tokenize(candidate.text), tokenize(item.text)) >= 0.9,
        )
        if (dup) duplicates += 1
        else kept.push(item)
      }
    }
    let dbBytes = 0
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue
        const full = path.join(this.dir, name)
        if (fs.statSync(full).isFile()) dbBytes += fs.statSync(full).size
      }
    } catch {
      dbBytes = 0
    }
    const active = folders.flatMap((folder) => (folder.items || []).filter(isActive))
    return {
      backend: 'json',
      storeDir: this.dir,
      folders: stats.folders,
      items: stats.items,
      archived: stats.archived,
      byStatus: { active: stats.items, inactive: stats.archived },
      duplicateGroups: duplicates,
      ftsDrift: 0,
      dbBytes,
      oldestAt: active.reduce((min, item) => Math.min(min, item.createdAt || Infinity), Infinity) || 0,
      newestAt: active.reduce((max, item) => Math.max(max, item.createdAt || 0), 0),
    }
  }

  /** 导出为可 diff 的 JSON（含失效/删除条目）。 */
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

  /** 导入 JSON（导出格式或 v1 格式）。按 id 去重，只导入活跃条目。 */
  importFromFile(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const incoming = Array.isArray(data?.folders) ? data.folders : []
    const existing = new Set(this.allFolders().flatMap((folder) => (folder.items || []).map((item) => item.id)))
    let imported = 0
    let skipped = 0
    for (const folder of incoming) {
      for (const item of Array.isArray(folder.items) ? folder.items : []) {
        try { assertMemorySafe(item.text) } catch { skipped += 1; continue }
        if (item.status && item.status !== 'active') {
          skipped += 1
          continue
        }
        const id = String(item.id || '')
        if (id && existing.has(id)) {
          skipped += 1
          continue
        }
        this.addItem({
          folderName: folder.name || '导入',
          text: String(item.text || ''),
          keywords: item.keywords || [],
          importance: item.importance,
          category: item.category || 'general',
          dedupe: false,
        })
        if (id) existing.add(id)
        imported += 1
      }
    }
    return { imported, skipped }
  }
}
