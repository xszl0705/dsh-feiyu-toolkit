/**
 * lib/artifact.js — artifact 两阶段落盘
 *
 * 规格：docs/tech-spec-evidence.md §3、§4.1；docs/handoff/impl-dsh-evidence.md §7 第二步
 * 顺序硬约束：**先写 raw 文件，再插 DB**。DB 是索引，文件才是真相：
 *   - 文件写失败 → 不插 DB（避免出现指向不存在文件的行）
 *   - DB 插失败 → 留孤儿文件但抛错，由调用方标记 ERROR，不做静默丢弃
 * 去重：`artifacts.sha256` 有唯一索引，同字节内容只落一次，返回既有 id 并标 `dedup: true`
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { segmentCJK } from './db.js';

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function artifactIdFor(sha256) {
  return 'art_' + String(sha256).slice(0, 16);
}

export function monthOf(iso) {
  return String(iso).slice(0, 7);
}

export function rawPathFor(dataDir, fetchedAt, id) {
  return join(dataDir, 'artifacts', monthOf(fetchedAt), id + '.raw');
}

export function parsedPathFor(dataDir, fetchedAt, id) {
  return join(dataDir, 'parsed', monthOf(fetchedAt), id + '.json');
}

export function findArtifactBySha(db, sha256) {
  const row = db.prepare('SELECT id, url, raw_path FROM artifacts WHERE sha256 = ?').get(sha256);
  return row ?? null;
}

export function loadArtifact(db, id) {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(String(id));
  return row ?? null;
}

const INSERT = `
INSERT INTO artifacts (
  id, url, fetched_at, channel, http_status, content_type, bytes, sha256, raw_path,
  parsed_path, text_raw, text_seg, simhash, quality, data_as_of, status
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`;

/**
 * @returns {{id:string, sha256:string, rawPath:string, dedup:boolean}}
 */
export function saveArtifact(input) {
  const {
    db,
    dataDir,
    url,
    fetchedAt,
    channel = 'unknown',
    httpStatus = null,
    contentType = '',
    bytes,
    text = '',
    quality = null,
    dataAsOf = null,
    status = 'OK',
  } = input;

  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  const sha256 = sha256Hex(buf);

  const existing = findArtifactBySha(db, sha256);
  if (existing) {
    return { id: existing.id, sha256, rawPath: existing.raw_path, dedup: true };
  }

  const id = artifactIdFor(sha256);
  const rawPath = rawPathFor(dataDir, fetchedAt, id);
  mkdirSync(dirname(rawPath), { recursive: true });
  writeFileSync(rawPath, buf); // 一阶段

  try {
    db.prepare(INSERT).run(
      id,
      url,
      fetchedAt,
      channel,
      httpStatus,
      contentType,
      buf.length,
      sha256,
      rawPath,
      null,
      text,
      text ? segmentCJK(text) : null,
      null,
      quality ? JSON.stringify(quality) : null,
      dataAsOf,
      status,
    );
  } catch (e) {
    // sha256 唯一冲突（并发下两路同时落到这里）：以先落库的那条为准
    const raced = /UNIQUE|constraint/i.test(String(e?.message || e)) ? findArtifactBySha(db, sha256) : null;
    if (raced) return { id: raced.id, sha256, rawPath: raced.raw_path, dedup: true };
    throw e;
  }

  return { id, sha256, rawPath, dedup: false };
}

/** 二阶段产物：解析结果落 parsed/*.json 并回填 parsed_path */
export function writeParsed({ db, dataDir, row, parsed }) {
  if (!row) throw new Error('WRITE_PARSED_NO_ROW');
  const path = parsedPathFor(dataDir, row.fetched_at, row.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      { artifactId: row.id, url: row.url, parsedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), parsed },
      null,
      1,
    ),
    'utf8',
  );
  db.prepare('UPDATE artifacts SET parsed_path = ? WHERE id = ?').run(path, row.id);
  return path;
}
