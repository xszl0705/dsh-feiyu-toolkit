/**
 * lib/db.js — 数据库连接、DDL 与迁移
 *
 * 规格来源：docs/tech-spec-evidence.md §3
 * 关键点：
 *   1. 中文必须双列：text_raw（供 quote 子串匹配）+ text_seg（供 FTS）
 *   2. 写端与查询端必须用同一个 segmentCJK，否则 2 字词查不到
 *   3. verdicts 的 current 唯一性按 (claim_id, rules_version)，允许跨版本并存
 *   4. 时间一律 ISO8601 UTC 字符串
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;

/** 中文逐字切分：贵州茅台 → 贵 州 茅 台（写端与查询端必须同一函数） */
export function segmentCJK(text) {
  return String(text ?? '')
    .replace(/[\u4e00-\u9fa5]/g, (c) => ` ${c} `)
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS artifacts (
  id           TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  channel      TEXT NOT NULL,
  http_status  INTEGER,
  content_type TEXT,
  bytes        INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  raw_path     TEXT NOT NULL,
  parsed_path  TEXT,
  text_raw     TEXT,
  text_seg     TEXT,
  simhash      TEXT,
  quality      TEXT,
  data_as_of   TEXT,
  status       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_artifacts_sha ON artifacts(sha256);
CREATE INDEX IF NOT EXISTS ix_artifacts_url_time ON artifacts(url, fetched_at);

CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
  text_seg, content='artifacts', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS artifacts_ai AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(rowid, text_seg) VALUES (new.rowid, new.text_seg);
END;
CREATE TRIGGER IF NOT EXISTS artifacts_ad AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, text_seg) VALUES('delete', old.rowid, old.text_seg);
END;
CREATE TRIGGER IF NOT EXISTS artifacts_au AFTER UPDATE ON artifacts
WHEN old.text_seg IS NOT new.text_seg BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, text_seg) VALUES('delete', old.rowid, old.text_seg);
  INSERT INTO artifacts_fts(rowid, text_seg) VALUES (new.rowid, new.text_seg);
END;

CREATE TABLE IF NOT EXISTS claims (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  norm_hash  TEXT NOT NULL,
  as_of      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_atoms (
  id         TEXT PRIMARY KEY,
  claim_id   TEXT NOT NULL REFERENCES claims(id),
  text       TEXT NOT NULL,
  span_start INTEGER NOT NULL,
  span_end   INTEGER NOT NULL,
  type       TEXT NOT NULL,
  numeric    TEXT
);
CREATE INDEX IF NOT EXISTS ix_atoms_claim ON claim_atoms(claim_id);

CREATE TABLE IF NOT EXISTS evidence_links (
  id          TEXT PRIMARY KEY,
  claim_id    TEXT NOT NULL REFERENCES claims(id),
  atom_id     TEXT,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  quote       TEXT NOT NULL,
  span_start  INTEGER,
  span_end    INTEGER,
  level       TEXT NOT NULL,
  stance      TEXT NOT NULL,
  entail_prob REAL,
  cluster_id  TEXT,
  checker     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ev_claim ON evidence_links(claim_id);

CREATE TABLE IF NOT EXISTS verdicts (
  id             TEXT PRIMARY KEY,
  claim_id       TEXT NOT NULL REFERENCES claims(id),
  verdict        TEXT NOT NULL,
  confidence     REAL,
  conf_basis     TEXT,
  calibration_id TEXT,
  degraded       INTEGER NOT NULL DEFAULT 0,
  gaps           TEXT,
  coverage       TEXT,
  conflict_state TEXT,
  rules_version  TEXT NOT NULL,
  idem_key       TEXT NOT NULL,
  checked_at     TEXT NOT NULL,
  valid_until    TEXT,
  superseded_by  TEXT
);
-- 每 (claim_id, rules_version) 一条 current；跨版本允许并存
CREATE UNIQUE INDEX IF NOT EXISTS ux_verdict_current
  ON verdicts(claim_id, rules_version) WHERE superseded_by IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_verdict_idem ON verdicts(idem_key);

CREATE TABLE IF NOT EXISTS events (
  factcheck_id TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL,
  at           TEXT NOT NULL,
  PRIMARY KEY (factcheck_id, seq)
);

CREATE TABLE IF NOT EXISTS domain_health (
  domain          TEXT PRIMARY KEY,
  last_ok_at      TEXT,
  last_fail_at    TEXT,
  fail_streak     INTEGER NOT NULL DEFAULT 0,
  cooldown_until  TEXT,
  success_rate_7d REAL
);

CREATE TABLE IF NOT EXISTS quota (
  bucket       TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count        INTEGER NOT NULL
);
`;

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get();
  const current = Number(row?.user_version ?? 0);
  if (current === 0) {
    db.exec(DDL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return { from: 0, to: SCHEMA_VERSION };
  }
  if (current > SCHEMA_VERSION) {
    throw new Error(`DB_SCHEMA_TOO_NEW: db=${current} code=${SCHEMA_VERSION}`);
  }
  return { from: current, to: current };
}

export function nowISO() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function assertISO8601UTC(value, field = 'time') {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new Error(`BAD_TIME_FORMAT: ${field}=${value}`);
  }
  return value;
}
