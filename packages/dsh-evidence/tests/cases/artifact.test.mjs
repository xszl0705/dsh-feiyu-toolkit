/**
 * tests/cases/artifact.test.mjs — artifact 两阶段落盘
 *
 * 断言重点：
 *   1. 原文先落盘再插 DB；sha256 / 字节数 / month 目录都对
 *   2. 同 sha256 不重复落盘，返回既有 id 且 dedup=true
 *   3. text_seg 走同一份 segmentCJK（写读两端一致）
 *   4. writeParsed 落 parsed/*.json 并回填 parsed_path
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, segmentCJK } from '../../lib/db.js';
import {
  artifactIdFor,
  findArtifactBySha,
  loadArtifact,
  monthOf,
  rawPathFor,
  saveArtifact,
  sha256Hex,
  writeParsed,
} from '../../lib/artifact.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, '..', '..', '..', '..', '_tmp', 'evidence-artifact-test');

const URL0 = 'https://example.com/a';
const FETCHED = '2026-11-12T01:02:03Z';
const BODY = '贵州茅台2024年营业收入1741.44亿元，同比增长15.66%。';
const BYTES = new TextEncoder().encode(BODY);

export const name = 'artifact';

export async function run(t) {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const db = openDatabase(':memory:');

  // 1. 首次落盘
  const first = saveArtifact({
    db,
    dataDir: DATA_DIR,
    url: URL0,
    fetchedAt: FETCHED,
    channel: 'node_direct',
    httpStatus: 200,
    contentType: 'text/html; charset=utf-8',
    bytes: BYTES,
    text: BODY,
    quality: { isArticle: true },
    dataAsOf: FETCHED,
    status: 'OK',
  });
  t.eq(first.dedup, false, '首落 dedup=false');
  t.eq(first.id, artifactIdFor(sha256Hex(BYTES)), 'id 由 sha256 前 16 位生成');
  t.eq(existsSync(first.rawPath), true, 'raw 文件已写');
  t.eq(Buffer.compare(readFileSync(first.rawPath), Buffer.from(BYTES)), 0, 'raw 文件内容与原始字节一致');
  t.ok(first.rawPath.includes(join('artifacts', '2026-11')), '按月目录 2026-11');

  // 2. 同字节再落一次 → 去重
  const second = saveArtifact({
    db,
    dataDir: DATA_DIR,
    url: URL0,
    fetchedAt: '2026-11-12T01:09:09Z',
    channel: 'node_direct',
    httpStatus: 200,
    contentType: 'text/html; charset=utf-8',
    bytes: BYTES,
    text: BODY,
  });
  t.eq(second.dedup, true, '重复字节 dedup=true');
  t.eq(second.id, first.id, '返回既有 artifactId');
  t.eq(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n, 1, 'DB 里只有一条');

  // 3. DB 行字段
  const row = loadArtifact(db, first.id);
  t.eq(row.sha256, sha256Hex(BYTES), 'sha256 一致');
  t.eq(Number(row.bytes), BYTES.length, 'bytes 记原始字节长度');
  t.eq(row.text_seg, segmentCJK(BODY), 'text_seg 走同一份 segmentCJK');
  t.eq(row.status, 'OK', 'status 落库');
  t.eq(row.data_as_of, FETCHED, 'data_as_of 落库');
  t.eq(row.parsed_path, null, '首次落盘 parsed_path 为空');
  t.ok(String(row.quality).includes('isArticle'), 'quality 以 JSON 落库');
  t.eq(db.prepare('SELECT COUNT(*) AS n FROM artifacts_fts WHERE artifacts_fts MATCH ?').get('茅 台').n, 1, 'FTS 可检索到');

  // 4. 查不到的 id
  t.eq(loadArtifact(db, 'art_deadbeefdeadbeef'), null, '未知 id 返回 null');
  t.eq(findArtifactBySha(db, sha256Hex(new TextEncoder().encode('别的字节'))), null, '未知 sha 返回 null');

  // 5. writeParsed 回填
  const parsed = { text: BODY, textSeg: segmentCJK(BODY), tables: [], json: undefined, spans: [{ start: 0, end: BODY.length }], qualityFlags: [] };
  const parsedPath = writeParsed({ db, dataDir: DATA_DIR, row, parsed });
  t.eq(existsSync(parsedPath), true, 'parsed 文件已写');
  t.eq(loadArtifact(db, first.id).parsed_path, parsedPath, 'parsed_path 已回填');
  const saved = JSON.parse(readFileSync(parsedPath, 'utf8'));
  t.eq(saved.artifactId, first.id, 'parsed 文件带 artifactId');
  t.eq(saved.parsed.spans.length, 1, 'parsed 文件保留 span');
  t.ok(parsedPath.includes(join('parsed', '2026-11')), 'parsed 也按月归档');

  // 6. 路径与月份工具函数
  t.eq(monthOf(FETCHED), '2026-11', 'monthOf 取 ISO 前 7 位');
  t.eq(rawPathFor(DATA_DIR, FETCHED, 'art_x'), join(DATA_DIR, 'artifacts', '2026-11', 'art_x.raw'), 'rawPathFor 拼接正确');

  db.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
}
