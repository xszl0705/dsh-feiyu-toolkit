/**
 * 本地存储：node:sqlite（本机已验证，无原生依赖）+ FTS5。
 * 与 dsh-group-knowledge 是同一个技术选型，但**库文件分开**：
 * 群知识是「别人说过什么」，学习卡是「我要记住什么」，混在一起检索会互相干扰。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { schedule } from './srs.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
export const DEFAULT_DB = path.join(DSH_HOME, 'dafeiyu', 'finance-learn', 'learn.db')

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS card_links (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'related',
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE TABLE IF NOT EXISTS reviews (
  card_id TEXT PRIMARY KEY,
  ef REAL NOT NULL DEFAULT 2.5,
  reps INTEGER NOT NULL DEFAULT 0,
  interval_days INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL,
  last_review_at TEXT NOT NULL DEFAULT '',
  stability REAL,
  difficulty REAL
);
CREATE TABLE IF NOT EXISTS review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  reviewed_at TEXT NOT NULL,
  interval_days INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
  title, body, tags, content='cards', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS cards_ai AFTER INSERT ON cards BEGIN
  INSERT INTO cards_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS cards_ad AFTER DELETE ON cards BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS cards_au AFTER UPDATE ON cards BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO cards_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
`

function nowIso() {
  return new Date().toISOString()
}

function makeId(title, body) {
  return 'c_' + crypto.createHash('sha1').update(String(title) + '\u0000' + String(body)).digest('hex').slice(0, 12)
}

function rowToCard(row) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tags: row.tags,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class FinanceStore {
  constructor(file = DEFAULT_DB) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(SCHEMA)
  }

  // ---------- 卡片 ----------

  addCard({ title, body = '', tags = '', source = '' } = {}) {
    const t = String(title || '').trim()
    if (!t) throw new Error('标题不能为空')
    const id = makeId(t, body)
    const ts = nowIso()
    this.db
      .prepare('INSERT INTO cards (id, title, body, tags, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, tags=excluded.tags, updated_at=excluded.updated_at')
      .run(id, t, String(body || ''), String(tags || ''), String(source || ''), ts, ts)
    return this.getCard(id)
  }

  getCard(id) {
    return rowToCard(this.db.prepare('SELECT * FROM cards WHERE id = ?').get(String(id || '')))
  }

  updateCard(id, patch = {}) {
    const cur = this.getCard(id)
    if (!cur) return null
    const next = {
      title: patch.title != null ? String(patch.title) : cur.title,
      body: patch.body != null ? String(patch.body) : cur.body,
      tags: patch.tags != null ? String(patch.tags) : cur.tags,
      source: patch.source != null ? String(patch.source) : cur.source,
    }
    this.db
      .prepare('UPDATE cards SET title=?, body=?, tags=?, source=?, updated_at=? WHERE id=?')
      .run(next.title, next.body, next.tags, next.source, nowIso(), cur.id)
    return this.getCard(cur.id)
  }

  removeCard(id) {
    const info = this.db.prepare('DELETE FROM cards WHERE id = ?').run(String(id || ''))
    this.db.prepare('DELETE FROM reviews WHERE card_id = ?').run(String(id || ''))
    this.db.prepare('DELETE FROM card_links WHERE from_id = ? OR to_id = ?').run(String(id || ''), String(id || ''))
    return Number(info?.changes || 0) > 0
  }

  listCards({ limit = 20, offset = 0, tag = '' } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 200)
    const off = Math.max(Number(offset) || 0, 0)
    const rows = tag
      ? this.db.prepare("SELECT * FROM cards WHERE tags LIKE ? ORDER BY updated_at DESC LIMIT ? OFFSET ?").all(`%${tag}%`, lim, off)
      : this.db.prepare('SELECT * FROM cards ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(lim, off)
    return rows.map(rowToCard)
  }

  searchCards(query, limit = 10) {
    const q = String(query || '').trim()
    if (!q) return []
    const lim = Math.min(Math.max(Number(limit) || 10, 1), 50)
    try {
      const rows = this.db
        .prepare("SELECT c.* FROM cards_fts f JOIN cards c ON c.rowid = f.rowid WHERE cards_fts MATCH ? ORDER BY bm25(cards_fts) LIMIT ?")
        .all(quoteFts(q), lim)
      if (rows.length) return rows.map(rowToCard)
    } catch {
      // FTS 查询语法错就退 LIKE，不让检索整体失败
    }
    return this.db
      .prepare("SELECT * FROM cards WHERE title LIKE ? OR body LIKE ? OR tags LIKE ? ORDER BY updated_at DESC LIMIT ?")
      .all(`%${q}%`, `%${q}%`, `%${q}%`, lim)
      .map(rowToCard)
  }

  link(fromId, toId, kind = 'related') {
    this.db
      .prepare('INSERT OR IGNORE INTO card_links (from_id, to_id, kind) VALUES (?,?,?)')
      .run(String(fromId), String(toId), String(kind || 'related'))
  }

  links(id) {
    return this.db.prepare('SELECT * FROM card_links WHERE from_id = ? OR to_id = ?').all(String(id), String(id))
  }

  // ---------- 复习 ----------

  reviewState(cardId) {
    const row = this.db.prepare('SELECT * FROM reviews WHERE card_id = ?').get(String(cardId))
    if (!row) return null
    return {
      cardId: row.card_id,
      ef: row.ef,
      reps: row.reps,
      interval: row.interval_days,
      lapses: row.lapses,
      dueAt: row.due_at,
      lastReviewAt: row.last_review_at,
    }
  }

  /** 到期队列；从没复习过的卡 dueAt = 建档时间，所以新卡也会排进来。 */
  dueCards(limit = 30, now = new Date()) {
    const lim = Math.min(Math.max(Number(limit) || 30, 1), 200)
    const iso = now.toISOString()
    const rows = this.db
      .prepare(
        `SELECT c.*, r.due_at, r.reps FROM cards c
         LEFT JOIN reviews r ON r.card_id = c.id
         WHERE r.card_id IS NULL OR r.due_at <= ?
         ORDER BY COALESCE(r.due_at, c.created_at) ASC
         LIMIT ?`,
      )
      .all(iso, lim)
    return rows.map((row) => ({ ...rowToCard(row), dueAt: row.due_at || row.created_at, reps: Number(row.reps) || 0 }))
  }

  /** 打分并落库，返回新状态。 */
  gradeCard(cardId, rating, now = new Date()) {
    const card = this.getCard(cardId)
    if (!card) throw new Error('卡片不存在：' + cardId)
    const prev = this.reviewState(cardId) || {}
    const next = schedule(prev, rating, now)
    this.db
      .prepare(
        `INSERT INTO reviews (card_id, ef, reps, interval_days, lapses, due_at, last_review_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(card_id) DO UPDATE SET ef=excluded.ef, reps=excluded.reps, interval_days=excluded.interval_days,
           lapses=excluded.lapses, due_at=excluded.due_at, last_review_at=excluded.last_review_at`,
      )
      .run(cardId, next.ef, next.reps, next.interval, next.lapses, next.dueAt, next.lastReviewAt)
    this.db
      .prepare('INSERT INTO review_log (card_id, rating, reviewed_at, interval_days) VALUES (?,?,?,?)')
      .run(cardId, Number(rating), next.lastReviewAt, next.interval)
    return { cardId, ...next }
  }

  reviewStats(now = new Date()) {
    const iso = now.toISOString()
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM cards').get()?.n) || 0
    const due = Number(
      this.db
        .prepare('SELECT COUNT(*) AS n FROM cards c LEFT JOIN reviews r ON r.card_id = c.id WHERE r.card_id IS NULL OR r.due_at <= ?')
        .get(iso)?.n,
    ) || 0
    const learned = Number(this.db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE reps > 0').get()?.n) || 0
    return { total, due, learned }
  }

  // ---------- 缓存 ----------

  cacheGet(key, maxAgeMs = 60_000) {
    const row = this.db.prepare('SELECT * FROM cache WHERE key = ?').get(String(key))
    if (!row) return null
    const age = Date.now() - Date.parse(row.fetched_at)
    if (!Number.isFinite(age) || age > maxAgeMs) return null
    try {
      return JSON.parse(row.payload)
    } catch {
      return null
    }
  }

  /** 不过期缓存，用于「网络挂了拿上次的顶着」场景。 */
  cacheGetStale(key) {
    const row = this.db.prepare('SELECT * FROM cache WHERE key = ?').get(String(key))
    if (!row) return null
    try {
      return { value: JSON.parse(row.payload), fetchedAt: row.fetched_at }
    } catch {
      return null
    }
  }

  cachePut(key, value) {
    this.db
      .prepare('INSERT INTO cache (key, payload, fetched_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at')
      .run(String(key), JSON.stringify(value), nowIso())
  }

  close() {
    try {
      this.db.close()
    } catch {
      // 已经关了
    }
  }
}

/** FTS5 短语查询转义：内部引号翻倍，整体加引号避免把用户输入当语法。 */
function quoteFts(query) {
  return '"' + String(query).replace(/"/g, '""') + '"'
}
