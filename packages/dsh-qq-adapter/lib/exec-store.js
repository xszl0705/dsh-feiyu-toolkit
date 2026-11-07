/**
 * 执行层存储（阶段 1.3）：SQLite 里的 inbox / work / effects / attempts 四张表。
 *
 * 目标不是「更快的队列」，而是把**副作用**写进可恢复的状态机：
 *   pending → running → done / failed / unknown
 * - 幂等动作（如图片按 sha256 入库）崩溃后可以安全重放；
 * - 非幂等动作（如发消息）崩溃后只能进 unknown，等人工对账，不能自动重发。
 *
 * 四表分工：
 *   inbox   = 外部进来的事件（群消息/私聊/心跳），按 (source, external_id) 去重
 *   work    = 从 inbox 开出的工单（对应方案里的 WorkOrder），带 mandate
 *   effects = 工单产生的副作用（可重放/不可重放）
 *   attempts= 每次尝试的流水，用于对账与排障
 *
 * 存储位置：~/.dsh/dafeiyu/exec/qq.db（可用 DSH_EXEC_DB 覆盖）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let sqlite = null
try {
  sqlite = require('node:sqlite')
} catch {
  sqlite = null
}

// Node 24 早期是 DatabaseSync，新版本导出 Database
const DatabaseCtor = sqlite ? sqlite.Database || sqlite.DatabaseSync : null

export function sqliteReady() {
  return typeof DatabaseCtor === 'function'
}

export function defaultExecDbFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return process.env.DSH_EXEC_DB || path.join(home, 'dafeiyu', 'exec', 'qq.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  thread TEXT,
  actor TEXT,
  text TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_dedupe ON inbox(source, external_id);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(status, created_at);

CREATE TABLE IF NOT EXISTS work (
  id TEXT PRIMARY KEY,
  inbox_id TEXT,
  mandate TEXT NOT NULL DEFAULT '{}',
  thread TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  report TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_status ON work(status, created_at);

CREATE TABLE IF NOT EXISTS effects (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  idem_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,
  lease_until INTEGER,
  last_error TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_effects_status ON effects(status, next_at);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  effect_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_effect ON attempts(effect_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  path TEXT NOT NULL,
  format TEXT,
  hash TEXT,
  validated_at TEXT,
  validation_result TEXT,
  delivery_state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
`

/**
 * 给已有库补列（CREATE TABLE IF NOT EXISTS 不会加列）。
 * 2026-11-04 阶段 4.4：work 表补 checkpoint / evidence_refs，旧库也能直接用。
 */
function ensureColumns(db) {
  const cols = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name))
  const work = cols('work')
  if (!work.has('checkpoint')) db.exec('ALTER TABLE work ADD COLUMN checkpoint TEXT')
  if (!work.has('evidence_refs')) db.exec("ALTER TABLE work ADD COLUMN evidence_refs TEXT NOT NULL DEFAULT '[]'")
}

export function openExecStore({ file = defaultExecDbFile(), now = Date.now } = {}) {
  if (!DatabaseCtor) throw new Error('node:sqlite 不可用')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseCtor(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  ensureColumns(db)

  const iso = (ms) => new Date(ms).toISOString()

  function getByIdem(idemKey) {
    return db.prepare('SELECT * FROM effects WHERE idem_key = ?').get(String(idemKey))
  }

  // ---------- inbox：外部事件按 (source, external_id) 去重入场 ----------

  function inboxIdOf(source, externalId) {
    return 'inb_' + crypto.createHash('sha256').update(`${source}:${externalId}`).digest('hex').slice(0, 24)
  }

  function acceptIntoInbox({ source, externalId, thread = '', actor = '', text = '' }) {
    if (!source || externalId === undefined || externalId === null || externalId === '') {
      return { created: false, inbox: null }
    }
    const at = iso(now())
    const id = inboxIdOf(String(source), String(externalId))
    const info = db
      .prepare(
        'INSERT INTO inbox(id, source, external_id, thread, actor, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, external_id) DO NOTHING',
      )
      .run(id, String(source), String(externalId), String(thread), String(actor), String(text).slice(0, 4000), 'new', at, at)
    return {
      created: Number(info.changes) > 0,
      inbox: db.prepare('SELECT * FROM inbox WHERE id = ?').get(id),
    }
  }

  /** 认领一条 new：CAS 从 new → claimed，多个消费者不会抢到同一条。 */
  function claimInbox({ limit = 10 } = {}) {
    const at = iso(now())
    const n = Math.min(50, Math.max(1, Number(limit) || 10))
    db.exec('BEGIN IMMEDIATE')
    try {
      const rows = db.prepare("SELECT * FROM inbox WHERE status = 'new' ORDER BY created_at LIMIT ?").all(n)
      const claimed = []
      for (const row of rows) {
        const info = db
          .prepare("UPDATE inbox SET status = 'claimed', updated_at = ? WHERE id = ? AND status = 'new'")
          .run(at, row.id)
        if (Number(info.changes) > 0) claimed.push(db.prepare('SELECT * FROM inbox WHERE id = ?').get(row.id))
      }
      db.exec('COMMIT')
      return claimed
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function settleInbox(id, status = 'done') {
    if (!['done', 'dropped'].includes(String(status))) return { ok: false, reason: 'bad-status' }
    const info = db
      .prepare("UPDATE inbox SET status = ?, updated_at = ? WHERE id = ? AND status = 'claimed'")
      .run(String(status), iso(now()), String(id))
    return { ok: Number(info.changes) > 0 }
  }

  // ---------- work：从 inbox 开工单 ----------

  function openWork({ inboxId = null, mandate = {}, thread = '' }) {
    const at = iso(now())
    const id = 'wrk_' + crypto.randomUUID()
    db.prepare('INSERT INTO work(id, inbox_id, mandate, thread, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      inboxId === null ? null : String(inboxId),
      JSON.stringify(mandate && typeof mandate === 'object' ? mandate : {}),
      String(thread || ''),
      'open',
      at,
      at,
    )
    return db.prepare('SELECT * FROM work WHERE id = ?').get(id)
  }

  /** 认领一条 open 工单：CAS 从 open → running。 */
  function claimWork() {
    const at = iso(now())
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare("SELECT * FROM work WHERE status = 'open' ORDER BY created_at LIMIT 1").get()
      if (!row) {
        db.exec('COMMIT')
        return null
      }
      const info = db
        .prepare("UPDATE work SET status = 'running', updated_at = ? WHERE id = ? AND status = 'open'")
        .run(at, row.id)
      db.exec('COMMIT')
      if (Number(info.changes) === 0) return null
      return db.prepare('SELECT * FROM work WHERE id = ?').get(row.id)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function reportWork(id, { status, report = null } = {}) {
    if (!['done', 'blocked', 'failed', 'dropped'].includes(String(status))) return { ok: false, reason: 'bad-status' }
    const info = db
      .prepare('UPDATE work SET status = ?, report = ?, updated_at = ? WHERE id = ?')
      .run(String(status), report === null ? null : JSON.stringify(report), iso(now()), String(id))
    return { ok: Number(info.changes) > 0 }
  }

  function listWork({ status = 'open', limit = 20 } = {}) {
    const n = Math.min(100, Math.max(1, Number(limit) || 20))
    return db.prepare('SELECT * FROM work WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(String(status), n)
  }

  // ---------- effects：工单产生的副作用 ----------

  function enqueue({ kind, idemKey, payload = {} }) {
    const at = now()
    const id = 'eff_' + crypto.randomUUID()
    const info = db
      .prepare(
        'INSERT INTO effects(id, kind, idem_key, payload, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT(idem_key) DO NOTHING',
      )
      .run(id, String(kind), String(idemKey), JSON.stringify(payload), 'pending', iso(at), iso(at))
    return { created: Number(info.changes) > 0, effect: getByIdem(idemKey) }
  }

  /** 认领一条 pending：单条 UPDATE ... WHERE status='pending' 做 CAS。 */
  function claim({ leaseMs = 30_000 } = {}) {
    const at = now()
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db
        .prepare("SELECT * FROM effects WHERE status = 'pending' AND (next_at IS NULL OR next_at <= ?) ORDER BY created_at LIMIT 1")
        .get(at)
      if (!row) {
        db.exec('COMMIT')
        return null
      }
      db.prepare(
        "UPDATE effects SET status = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      ).run(at + leaseMs, iso(at), row.id)
      db.prepare('INSERT INTO attempts(effect_id, started_at) VALUES (?, ?)').run(row.id, iso(at))
      db.exec('COMMIT')
      return db.prepare('SELECT * FROM effects WHERE id = ?').get(row.id)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function finish(id, { status, result = null, error = null } = {}) {
    const at = iso(now())
    db.prepare('UPDATE effects SET status = ?, result = ?, last_error = ?, lease_until = NULL, updated_at = ? WHERE id = ?').run(
      String(status),
      result === null ? null : JSON.stringify(result),
      error === null ? null : String(error).slice(0, 500),
      at,
      String(id),
    )
    db.prepare('UPDATE attempts SET finished_at = ?, outcome = ?, error = ? WHERE effect_id = ? AND finished_at IS NULL').run(
      at,
      String(status),
      error === null ? null : String(error).slice(0, 500),
      String(id),
    )
  }

  function retry(id, error, { delayMs = 0 } = {}) {
    const at = now()
    db.prepare("UPDATE effects SET status = 'pending', next_at = ?, lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?").run(
      at + Math.max(0, delayMs),
      String(error || '').slice(0, 500),
      iso(at),
      String(id),
    )
    db.prepare('UPDATE attempts SET finished_at = ?, outcome = ?, error = ? WHERE effect_id = ? AND finished_at IS NULL').run(
      iso(at),
      'retry',
      String(error || '').slice(0, 500),
      String(id),
    )
  }

  /**
   * 启动恢复：租约过期的 running 不能装没看见。
   * 幂等 kind（image.*）退回 pending 重放；非幂等进 unknown，等对账。
   */
  function recover() {
    const at = now()
    const stale = db.prepare("SELECT * FROM effects WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?").all(at)
    for (const row of stale) {
      if (String(row.kind).startsWith('image.')) {
        db.prepare("UPDATE effects SET status = 'pending', lease_until = NULL, updated_at = ? WHERE id = ?").run(iso(at), row.id)
      } else {
        db.prepare(
          "UPDATE effects SET status = 'unknown', lease_until = NULL, last_error = '租约过期：无法确认副作用是否已发生', updated_at = ? WHERE id = ?",
        ).run(iso(at), row.id)
      }
    }
    return stale.length
  }

  /** 列出指定状态的记录（默认 unknown），最近更新在前。 */
  function listByStatus(status = 'unknown', limit = 20) {
    const n = Math.min(100, Math.max(1, Number(limit) || 20))
    return db.prepare('SELECT * FROM effects WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(String(status), n)
  }

  /**
   * 人工对账：unknown 只能被裁定一次，done=确认已发出，failed=确认没发出。
   * 只接受 unknown 记录，避免手工改写自动流转中的状态。
   */
  function resolve(id, { status, note = '' } = {}) {
    const row = db.prepare('SELECT * FROM effects WHERE id = ?').get(String(id))
    if (!row) return { ok: false, reason: 'not-found' }
    if (row.status !== 'unknown') return { ok: false, reason: 'not-unknown', status: row.status }
    if (status !== 'done' && status !== 'failed') return { ok: false, reason: 'bad-status' }
    const at = iso(now())
    const isDone = status === 'done'
    db.prepare('UPDATE effects SET status = ?, result = ?, last_error = ?, updated_at = ? WHERE id = ?').run(
      status,
      isDone ? JSON.stringify({ reconciled: true, note: String(note || '').slice(0, 200) }) : null,
      isDone ? null : String(note || '').slice(0, 500) || row.last_error,
      at,
      String(id),
    )
    db.prepare('UPDATE attempts SET finished_at = ?, outcome = ?, error = ? WHERE effect_id = ? AND finished_at IS NULL').run(
      at,
      isDone ? 'done' : 'failed',
      isDone ? '人工对账：确认已发出' : '人工对账：确认未发出',
      String(id),
    )
    return { ok: true, id: String(id), status }
  }

  function stats() {
    // 固定字段：某状态归零后也要返回 0，调用方不必区分 undefined
    const out = { total: 0, pending: 0, running: 0, done: 0, failed: 0, unknown: 0 }
    const rows = db.prepare('SELECT status, COUNT(*) AS count FROM effects GROUP BY status').all()
    for (const row of rows) {
      out[row.status] = Number(row.count)
      out.total += Number(row.count)
    }
    return out
  }

  /** inbox/work 的计数，给 qq(action=status) 用。 */
  function counts() {
    const one = (sql) => Number(db.prepare(sql).get()?.count || 0)
    return {
      inboxNew: one("SELECT COUNT(*) AS count FROM inbox WHERE status = 'new'"),
      inboxClaimed: one("SELECT COUNT(*) AS count FROM inbox WHERE status = 'claimed'"),
      workOpen: one("SELECT COUNT(*) AS count FROM work WHERE status = 'open'"),
      workRunning: one("SELECT COUNT(*) AS count FROM work WHERE status = 'running'"),
    }
  }

  // ---------- artifacts：任务产物（阶段 4.4） ----------

  /** 记一件产物；delivery_state 默认 pending，校验通过后再改 sent/file 等。 */
  function recordArtifact({ taskId = '', path: artifactPath = '', format = '', hash = '', validationResult = '', deliveryState = 'pending' } = {}) {
    if (!artifactPath) return { ok: false, reason: 'missing-path' }
    const at = iso(now())
    const id = 'art_' + crypto.randomUUID()
    db.prepare(
      'INSERT INTO artifacts(id, task_id, path, format, hash, validated_at, validation_result, delivery_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      String(taskId),
      String(artifactPath),
      String(format),
      String(hash),
      validationResult ? at : null,
      String(validationResult || ''),
      String(deliveryState),
      at,
    )
    return { ok: true, artifact: db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) }
  }

  function listArtifacts(taskId = '') {
    return taskId
      ? db.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at').all(String(taskId))
      : db.prepare('SELECT * FROM artifacts ORDER BY created_at DESC LIMIT 50').all()
  }

  /** 已收敛的记录不能无限长：done/failed 超过保留期就删，attempts 跟着清。 */
  function prune({ days = 30 } = {}) {
    const cutoff = iso(now() - Math.max(1, Number(days) || 30) * 86_400_000)
    db.prepare(
      "DELETE FROM attempts WHERE effect_id IN (SELECT id FROM effects WHERE status IN ('done', 'failed') AND updated_at < ?)",
    ).run(cutoff)
    const info = db.prepare("DELETE FROM effects WHERE status IN ('done', 'failed') AND updated_at < ?").run(cutoff)
    db.prepare("DELETE FROM inbox WHERE status IN ('done', 'dropped') AND updated_at < ?").run(cutoff)
    db.prepare("DELETE FROM work WHERE status IN ('done', 'failed', 'dropped') AND updated_at < ?").run(cutoff)
    return Number(info.changes)
  }

  function close() {
    try {
      db.close()
    } catch {
      // already closed
    }
  }

  return {
    file,
    db,
    enqueue,
    getByIdem,
    claim,
    finish,
    retry,
    recover,
    listByStatus,
    resolve,
    stats,
    counts,
    // inbox / work
    acceptIntoInbox,
    claimInbox,
    settleInbox,
    openWork,
    claimWork,
    reportWork,
    listWork,
    recordArtifact,
    listArtifacts,
    prune,
    close,
  }
}
