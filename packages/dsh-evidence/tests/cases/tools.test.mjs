/**
 * tests/cases/tools.test.mjs — ev_fetch / ev_extract（全离线，假 fetch + 内存库）
 *
 * 断言重点：
 *   1. 工具定义形状（name / parameters.required）
 *   2. ev_fetch 成功链路：返回 artifactId / sha256 / httpStatus，trace 落盘
 *   3. 同字节二次抓取 dedup=true，不新增 DB 行
 *   4. 登录墙 → BLOCKED，不落 artifact
 *   5. 非 http(s) URL → BAD_URL；全部通道失败 → ALL_FAILED
 *   6. ev_extract：正文、span 可切片、表格、截断标记、未知 id
 */
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../../lib/db.js';
import { createEvidenceTools } from '../../lib/tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, '..', '..', '..', '..', '_tmp', 'evidence-tools-test');

const ARTICLE = `<!doctype html><html><head><script>var x="脚本噪声";</script></head><body>
<nav><a href="/">首页</a></nav>
<article>
<h1>贵州茅台2024年年报</h1>
<p>公司2024年实现营业收入1741.44亿元，同比增长15.66%，归母净利润862.28亿元。</p>
<p>茅台酒收入1458.28亿元，系列酒收入246.84亿元，直销渠道占比继续提升。</p>
<table><caption>营收拆分</caption><tr><th>项目</th><th>金额</th></tr><tr><td>茅台酒</td><td>1458.28</td></tr></table>
</article></body></html>`;

const BLOCKED = '<html><body><div>请先登录后查看完整内容</div></body></html>';

function makeRes(status, contentType, body) {
  const buf = new TextEncoder().encode(body);
  return {
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

function toolOf(defs, name) {
  return defs.find((d) => d.name === name);
}

function makeTools(fetchImpl) {
  const db = openDatabase(':memory:');
  const defs = createEvidenceTools({
    dataDir: DATA_DIR,
    channelOrder: ['host_fetch', 'node_direct'],
    budget: { deadlineMs: 5000 },
    hostFetch: null,
    fetchImpl,
    dbProvider: () => db,
  });
  return { defs, db };
}

export const name = 'tools';

export async function run(t) {
  rmSync(DATA_DIR, { recursive: true, force: true });

  // 1. 定义形状
  {
    const { defs } = makeTools(async () => makeRes(200, 'text/html; charset=utf-8', ARTICLE));
    t.eq(defs.map((d) => d.name), ['ev_fetch', 'ev_extract', 'ev_claim', 'ev_search', 'ev_verify'], '工具清单含抓取与抽取');
    t.eq(toolOf(defs, 'ev_fetch').parameters.required, ['url'], 'ev_fetch 必填 url');
    t.eq(toolOf(defs, 'ev_extract').parameters.required, ['artifactId'], 'ev_extract 必填 artifactId');
    t.eq(typeof toolOf(defs, 'ev_fetch').execute, 'function', 'execute 是可调用函数');
  }

  // 2. ev_fetch 成功
  const { defs, db } = makeTools(async () => makeRes(200, 'text/html; charset=utf-8', ARTICLE));
  const evFetch = toolOf(defs, 'ev_fetch');
  const evExtract = toolOf(defs, 'ev_extract');
  {
    const r = await evFetch.execute({ url: 'https://example.com/report' });
    t.eq(r.status, 'OK', 'ev_fetch 成功');
    t.eq(r.httpStatus, 200, 'httpStatus=200');
    t.eq(r.channel, 'node_direct', '走 node_direct（未注入 hostFetch）');
    t.ok(/^art_[0-9a-f]{16}$/.test(r.artifactId || ''), 'artifactId 形状正确');
    t.eq((r.sha256 || '').length, 64, 'sha256 是 64 位十六进制');
    t.eq(r.dedup, false, '首抓 dedup=false');
    t.eq(r.replacementChars, 0, '零替换字符');
    t.ok(r.bytes > 0, 'bytes > 0');
    t.ok(Array.isArray(r.qualityFlags) && r.qualityFlags.includes('SHORT_TEXT') === false, '正文够长不标 SHORT_TEXT');
    t.ok(/^tr_/.test(r.traceId || ''), 'traceId 形状正确');
    t.eq(existsSync(r.tracePath), true, 'trace 文件已落盘');
    t.ok(r.attempts.some((a) => a.skipped && a.reason === 'NO_HOST_FETCH'), 'host_fetch 缺席被记录');
  }

  // 3. 二次抓同内容 → dedup
  {
    const r = await evFetch.execute({ url: 'https://example.com/report' });
    t.eq(r.status, 'OK', '二次抓取仍 OK');
    t.eq(r.dedup, true, 'dedup=true');
    t.eq(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n, 1, 'DB 不新增行');
  }

  // 4. 登录墙 → BLOCKED，不落 artifact
  {
    const blockedTools = makeTools(async () => makeRes(200, 'text/html; charset=utf-8', BLOCKED));
    const r = await toolOf(blockedTools.defs, 'ev_fetch').execute({ url: 'https://example.com/login-wall' });
    t.eq(r.status, 'BLOCKED', '登录墙标 BLOCKED');
    t.eq(r.artifactId, undefined, 'BLOCKED 不返回 artifactId');
    t.eq(blockedTools.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n, 0, 'BLOCKED 不落库');
  }

  // 5. 参数与通道失败
  {
    const failing = makeTools(async () => makeRes(500, 'text/plain', 'boom'));
    const fetch5 = toolOf(failing.defs, 'ev_fetch');
    t.eq((await fetch5.execute({ url: 'ftp://example.com/x' })).status, 'BAD_URL', '非 http(s) 拒绝');
    t.eq((await fetch5.execute({})).status, 'BAD_URL', '缺 url 拒绝');
    const failed = await fetch5.execute({ url: 'https://fail.example.com/x' });
    t.eq(failed.status, 'ALL_FAILED', '全通道失败标 ALL_FAILED');
    t.eq(failed.sha256, null, '失败不返回 sha256');
    t.ok(Array.isArray(failed.attempts) && failed.attempts.length >= 2, '两个通道都留痕');
  }

  // 6. ev_extract：正文 / span / 表格
  {
    const fetch1 = await evFetch.execute({ url: 'https://example.com/report2' });
    const r = await evExtract.execute({ artifactId: fetch1.artifactId });
    t.eq(r.status, 'OK', 'ev_extract 成功');
    t.ok(r.text.includes('贵州茅台2024年年报'), '正文含标题');
    t.ok(r.text.includes('营业收入1741.44亿元'), '正文含段落');
    t.eq(r.text.includes('脚本噪声'), false, '抽取时同样剔除脚本');
    t.ok(r.spans.length >= 3, 'span 数量正确');
    t.eq(r.spans.every((s) => r.text.slice(s.start, s.end).length > 0), true, '每个 span 都能切片');
    t.eq(r.tables.length, 1, '抽到 1 张表');
    t.eq(r.tables[0].caption, '营收拆分', '表格 caption 正确');
    t.eq(r.encoding, 'utf-8', '编码回落 utf-8');
    t.eq(existsSync(r.parsedPath), true, 'parsed 文件已落盘');
  }

  // 7. 截断与未知 id
  {
    const fetch1 = await evFetch.execute({ url: 'https://example.com/report2' });
    const short = await evExtract.execute({ artifactId: fetch1.artifactId, maxChars: 12 });
    t.eq(short.text.length, 12, '按 maxChars 截断');
    t.eq(short.qualityFlags.includes('TEXT_TRUNCATED'), true, '标 TEXT_TRUNCATED');
    t.eq(short.spans.every((s) => s.end <= short.text.length), true, '越界 span 被过滤');
    const missing = await evExtract.execute({ artifactId: 'art_0000000000000000' });
    t.eq(missing.status, 'NOT_FOUND', '未知 id 返回 NOT_FOUND');
    t.eq((await evExtract.execute({})).status, 'BAD_ARGUMENT', '缺参返回 BAD_ARGUMENT');
  }

  db.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
}
