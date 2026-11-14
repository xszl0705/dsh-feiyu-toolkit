/**
 * tests/cases/db.test.mjs — DDL 与约束的可行性验证
 *
 * 目的：规格自洽 ≠ SQL 能跑。这里只验证四件事：
 *   1. 建库建表成功，user_version 正确
 *   2. FTS5 external content 触发器工作，中文 2 字词可检索
 *   3. sha256 唯一约束生效
 *   4. verdicts 的 partial unique index 行为符合预期
 */
import { openDatabase, segmentCJK, SCHEMA_VERSION, nowISO } from '../../lib/db.js';

export const name = 'db';

export async function run(t) {
  const db = openDatabase(':memory:');

  // 1. 建表与版本
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  t.eq(tables.includes('artifacts') && tables.includes('verdicts'), true, '核心表已建');
  const uv = Number(db.prepare('PRAGMA user_version').get().user_version);
  t.eq(uv, SCHEMA_VERSION, 'user_version 正确');

  // 2. FTS5 + 中文两字词
  const raw = '贵州茅台2024年营业收入同比增长';
  db.prepare(
    `INSERT INTO artifacts (id,url,fetched_at,channel,bytes,sha256,raw_path,text_raw,text_seg,status)
     VALUES (?,?,?,?,?,?,?,?,?,'OK')`
  ).run('art_1', 'https://example.com/a', nowISO(), 'node_direct', 100, 'sha-a', 'a.raw', raw, segmentCJK(raw));

  const hit2 = db
    .prepare('SELECT count(*) AS n FROM artifacts_fts WHERE artifacts_fts MATCH ?')
    .get(`"${segmentCJK('茅台')}"`).n;
  t.eq(hit2, 1, '中文两字词可检索（需要写读两端同一切分）');

  const hit4 = db
    .prepare('SELECT count(*) AS n FROM artifacts_fts WHERE artifacts_fts MATCH ?')
    .get(`"${segmentCJK('营业收入')}"`).n;
  t.eq(hit4, 1, '中文四字词可检索');

  const miss = db
    .prepare('SELECT count(*) AS n FROM artifacts_fts WHERE artifacts_fts MATCH ?')
    .get(`"${segmentCJK('五粮液')}"`).n;
  t.eq(miss, 0, '无关词不命中');

  // text_raw 供 quote 子串匹配，切分后 LIKE 必然失效
  const likeOnSeg = db.prepare("SELECT count(*) AS n FROM artifacts WHERE text_seg LIKE '%茅台%'").get().n;
  const likeOnRaw = db.prepare("SELECT count(*) AS n FROM artifacts WHERE text_raw LIKE '%茅台%'").get().n;
  t.eq(likeOnSeg, 0, '切分列上 LIKE 失效（故必须双列）');
  t.eq(likeOnRaw, 1, '原文列上 LIKE 可用（供 quote 校验）');

  // 3. sha256 唯一
  let dupErr = null;
  try {
    db.prepare(
      `INSERT INTO artifacts (id,url,fetched_at,channel,bytes,sha256,raw_path,status)
       VALUES (?,?,?,?,?,?,?,'OK')`
    ).run('art_2', 'https://example.com/b', nowISO(), 'node_direct', 10, 'sha-a', 'b.raw');
  } catch (e) {
    dupErr = String(e.code || e.message).slice(0, 40);
  }
  t.eq(dupErr !== null, true, '重复 sha256 被拒绝');

  // 4. verdicts partial unique index
  db.prepare('INSERT INTO claims (id,text,norm_hash,as_of,created_at) VALUES (?,?,?,?,?)')
    .run('c1', '贵州茅台2024年营收100亿', 'h1', nowISO(), nowISO());

  const insVerdict = db.prepare(
    `INSERT INTO verdicts (id,claim_id,verdict,rules_version,idem_key,checked_at,superseded_by)
     VALUES (?,?,?,?,?,?,?)`
  );
  insVerdict.run('v1', 'c1', 'SUPPORTED', 'r1', 'k1', nowISO(), null);

  let dupCur = null;
  try {
    insVerdict.run('v2', 'c1', 'REFUTED', 'r1', 'k2', nowISO(), null);
  } catch (e) {
    dupCur = String(e.code || e.message).slice(0, 40);
  }
  t.eq(dupCur !== null, true, '同 (claim, rules_version) 的第二条 current 被拒绝');

  // 不同规则版本允许并存
  insVerdict.run('v3', 'c1', 'REFUTED', 'r2', 'k3', nowISO(), null);
  const curCount = db
    .prepare('SELECT count(*) AS n FROM verdicts WHERE claim_id=? AND superseded_by IS NULL')
    .get('c1').n;
  t.eq(curCount, 2, '跨规则版本允许并存 current');

  // 标记 superseded 后可再插同版本
  db.prepare('UPDATE verdicts SET superseded_by=? WHERE id=?').run('v3', 'v1');
  insVerdict.run('v4', 'c1', 'SUPPORTED', 'r1', 'k4', nowISO(), null);
  t.eq(1, 1, 'superseded 后同版本可再插');

  db.close();
}
