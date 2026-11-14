/**
 * tests/cases/verify.test.mjs — ev_verify 编排层（全离线）
 *
 * 断言重点：
 *   1. 两个独立簇都支持 → SUPPORTED，且不变量零违规
 *   2. 页面数字与声明冲突 → numericVerdict=ERROR → CONFLICTING（不和稀泥）
 *   3. 只有 UGC 簇 → 只进 leads，不产生证据，判决弃权
 *   4. 检索后端缺失 → degraded=true + gaps 带 SEARCH_UNAVAILABLE，判决弃权（不许猜）
 *   5. 抓取失败 → gaps 记 FETCH_FAILED，但不冒充「没找到反向证据」
 *   6. 工具层 ev_verify 能落 claims/verdicts，且重复核验幂等
 */
import path from 'node:path'
import { extractAtoms, saveClaim } from '../../lib/claim.js';
import { judgeV1, saveVerdict } from '../../lib/verdict.js';
import { compareNumeric } from '../../lib/numeric.js';
import { runSearch } from '../../lib/search.js';
import { validate } from '../../lib/invariants.js';
import { openDatabase } from '../../lib/db.js';
import { DEPTH_PRESETS, buildQueries, verifyClaim } from '../../lib/verify.js';
import { createEvidenceTools } from '../../lib/tools.js';

const AS_OF = '2026-11-12T00:00:00Z';
const FETCHED = '2026-11-10T00:00:00Z';
const CLAIM = '贵州茅台2024年实现营业收入1741.44亿元，同比增长15.66%。';
// 两篇不同措辞的稿子（同源归并按内容判，所以摘要必须是两段不同文字）
const SUPPORT_TEXT_A =
  '贵州茅台2024年实现营业收入1741.44亿元，同比增长15.66%，归母净利润862.28亿元。' +
  '公司在年报中披露，直销渠道占比继续提升，系列酒收入246.84亿元。报告期内经营活动现金流保持为正。';
const SUPPORT_TEXT_B =
  '茅台披露2024年度业绩：全年营业总收入口径下营业收入1741.44亿元，同比增速15.66%。' +
  '分产品看，茅台酒收入1458.28亿元，系列酒246.84亿元。经销商数量较上年末有所增加，渠道结构继续调整。';
const CONFLICT_TEXT =
  '贵州茅台2024年实现营业收入1200.00亿元，同比增长9.10%，归母净利润600.00亿元。' +
  '该口径与公司年报披露的数据存在明显差异，需以正式公告为准，本文所列数字来自未经审计的估算表。';

const HITS = [
  { url: 'http://www.csrc.gov.cn/a.html', title: '贵州茅台2024年年报', snippet: SUPPORT_TEXT_A },
  { url: 'https://finance.eastmoney.com/b.html', title: '茅台2024年营收与增速出炉', snippet: SUPPORT_TEXT_B },
];

function pageTextOf(url) {
  if (url.includes('eastmoney')) return SUPPORT_TEXT_B;
  if (url.includes('csrc')) return SUPPORT_TEXT_A;
  return SUPPORT_TEXT_A;
}

function makeDeps(overrides = {}) {
  return {
    extractAtoms,
    runSearch,
    searchImpl: async () => HITS,
    fetchPage: async (url) => ({
      ok: true,
      text: pageTextOf(url),
      sha256: 'sha' + url.slice(-4),
      fetchedAt: FETCHED,
      url,
    }),
    compareNumeric,
    judgeV1,
    nowISO: () => AS_OF,
    ...overrides,
  };
}

function makeRes(status, contentType, body) {
  const buf = new TextEncoder().encode(body);
  return {
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

export const name = 'verify';

export async function run(t) {
  // 1. 两簇都支持 → SUPPORTED
  {
    const r = await verifyClaim({ claim: CLAIM, asOf: AS_OF }, makeDeps());
    t.eq(r.status, 'OK', '核验返回 OK');
    t.eq(r.clusters, 2, '识别出 2 个独立簇');
    t.eq(r.evidenceCount, 2, '两簇各出一条证据');
    t.eq(r.evidence.every((e) => e.stance === 'support'), true, '两条都是支持');
    t.eq(r.verdict, 'SUPPORTED', '两簇高等级支持 → SUPPORTED');
    t.eq(r.degraded, false, '无检索故障');
    t.eq(r.gaps, [], '无缺口');
    t.eq(r.coverage.saturation, 'unknown', '覆盖度口径不变');
    t.eq(validate({ result: r, evidence: r.evidence, asOf: AS_OF }, { strict: false }), [], '不变量零违规');
    t.ok(r.confidence > 0.6, '两簇 conf 高于 cap=0.6 的单簇档');
  }

  // 2. 数字冲突 → CONFLICTING
  {
    const deps = makeDeps({
      fetchPage: async (url) => ({
        ok: true,
        text: url.includes('eastmoney') ? CONFLICT_TEXT : SUPPORT_TEXT_A,
        sha256: 'sha' + url.slice(-4),
        fetchedAt: FETCHED,
      }),
    });
    const r = await verifyClaim({ claim: CLAIM, asOf: AS_OF }, deps);
    t.eq(r.verdict, 'CONFLICTING', '一页支持一页冲突 → CONFLICTING');
    t.eq(r.evidence.some((e) => e.numericVerdict === 'ERROR'), true, '冲突被标成 numericVerdict=ERROR');
    t.eq(r.evidence.find((e) => e.numericVerdict === 'ERROR')?.stance, 'refute', '冲突簇的 stance=refute');
  }

  // 3. 只有 UGC 簇 → 只作线索
  {
    const deps = makeDeps({
      searchImpl: async () => [{ url: 'https://xueqiu.com/1/2', title: '茅台传闻', snippet: SUPPORT_TEXT_A }],
    });
    const r = await verifyClaim({ claim: CLAIM, asOf: AS_OF }, deps);
    t.eq(r.evidenceCount, 0, 'UGC 不进证据层');
    t.eq(r.leads.length, 1, 'UGC 进 leads');
    t.eq(r.gaps.includes('NO_NON_LEAD_CLUSTERS'), true, '记 NO_NON_LEAD_CLUSTERS');
    t.eq(r.verdict, 'UNVERIFIED_INSUFFICIENT_SEARCH', '没有可用证据 → 检索不足弃权');
    t.eq(validate({ result: r, evidence: r.evidence, asOf: AS_OF }, { strict: false }), [], '弃权也不违规');
  }

  // 4. 检索后端缺失 → degraded + 弃权
  {
    const r = await verifyClaim({ claim: CLAIM, asOf: AS_OF }, makeDeps({ searchImpl: null }));
    t.eq(r.degraded, true, '后端缺失标 degraded');
    t.eq(r.gaps.includes('SEARCH_UNAVAILABLE'), true, 'gaps 带 SEARCH_UNAVAILABLE');
    t.eq(r.verdict, 'UNVERIFIED_INSUFFICIENT_SEARCH', '不许猜 → 弃权');
    t.eq(validate({ result: r, evidence: r.evidence, asOf: AS_OF }, { strict: false }), [], 'degraded 有 gaps 不触发 INVARIANT_VIOLATION');
  }

  // 5. 抓取失败 → gaps 记录，不当成反向证据
  {
    const deps = makeDeps({ fetchPage: async () => ({ ok: false, code: 'ALL_FAILED' }) });
    const r = await verifyClaim({ claim: CLAIM, asOf: AS_OF }, deps);
    t.eq(r.evidenceCount, 0, '抓不到就没有证据');
    t.eq(r.gaps.filter((g) => g.startsWith('FETCH_FAILED')).length, 2, '两簇各记一条抓取失败');
    t.eq(r.verdict, 'UNVERIFIED_INSUFFICIENT_SEARCH', '抓取失败不冒充「没有反向证据」');
  }

  // 6. 参数与依赖
  {
    t.eq((await verifyClaim({}, makeDeps())).status, 'BAD_ARGUMENT', '空 claim 拒绝');
    t.eq((await verifyClaim({ claim: CLAIM }, { extractAtoms })).code, 'MISSING_DEPENDENCY', '缺依赖直接报错');
  }

  // 7. sources 指定来源：不检索，直接取证（研学模式主路径）
  {
    let searchCalls = 0;
    const deps = makeDeps({
      searchImpl: async () => {
        searchCalls += 1;
        throw new Error('should not be called');
      },
    });
    const r = await verifyClaim(
      {
        claim: CLAIM,
        asOf: AS_OF,
        sources: ['http://www.csrc.gov.cn/a.html', 'https://finance.eastmoney.com/b.html'],
      },
      deps,
    );
    t.eq(r.status, 'OK', 'sources 路径可用');
    t.eq(searchCalls, 0, '给了 sources 就不再检索');
    t.eq(r.queries, [], '检索式为空');
    t.eq(r.sourcesUsed, 2, '记录用了两条指定来源');
    t.eq(r.clusters, 2, '两条来源各自成簇（无标题也不并成一簇）');
    t.eq(r.verdict, 'SUPPORTED', '两来源都支持 → SUPPORTED');
    t.eq(r.degraded, false, 'sources 路径不算检索故障');
    t.eq(r.coverage.sourcesTried, 0, '没有发起检索');
  }

  // 8. sources + 没有检索后端 → 依然能给出判决
  {
    const r = await verifyClaim(
      { claim: CLAIM, asOf: AS_OF, sources: ['http://www.csrc.gov.cn/a.html', 'https://finance.eastmoney.com/b.html'] },
      makeDeps({ searchImpl: null }),
    );
    t.eq(r.degraded, false, '无后端但给了 sources → 不 degraded');
    t.eq(r.verdict, 'SUPPORTED', '仍能判 SUPPORTED');
  }

  // 9. 检索式生成：数字 atom 带口径与期间；deep 加官方站定向
  {
    const atoms = extractAtoms(CLAIM, { asOf: AS_OF }).atoms;
    const quick = buildQueries(CLAIM, atoms, DEPTH_PRESETS.quick);
    t.ok(quick.length >= 2, 'quick 至少两条检索式');
    t.ok(quick.some((q) => q.includes('1741.44亿元')), '数字 atom 进检索式');
    const deep = buildQueries(CLAIM, atoms, DEPTH_PRESETS.deep);
    t.ok(deep.some((q) => q.includes('site:gov.cn')), 'deep 加官方站定向');
    t.ok(deep.length > quick.length, 'deep 检索式更多');
  }

  // 8. 工具层：真实链路（假 fetch）落 claims / verdicts，重复核验幂等
  {
    const db = openDatabase(':memory:');
    const pages = {
      'http://www.csrc.gov.cn/a.html': SUPPORT_TEXT_A,
      'https://finance.eastmoney.com/b.html': SUPPORT_TEXT_B,
    };
    const defs = createEvidenceTools({
      dataDir: path.join(process.cwd(), '_tmp', 'evidence-verify-test'),
      searchImpl: async () => HITS,
      fetchImpl: async (url) => makeRes(200, 'text/html; charset=utf-8', pages[url] ?? SUPPORT_TEXT_A),
      dbProvider: () => db,
    });
    t.eq(defs.map((d) => d.name), ['ev_fetch', 'ev_extract', 'ev_claim', 'ev_search', 'ev_verify'], '五个工具齐');
    const evVerify = defs.find((d) => d.name === 'ev_verify');
    t.eq(evVerify.parameters.required, ['claim'], 'ev_verify 必填 claim');

    const first = await evVerify.execute({ claim: CLAIM, as_of: AS_OF });
    t.eq(first.status, 'OK', '工具核验成功');
    t.eq(first.verdict, 'SUPPORTED', '工具层判决 SUPPORTED');
    t.ok(/^cl_[0-9a-f]{16}$/.test(first.claimId || ''), '返回 claimId');
    t.eq(first.inserted, true, '首次落库');
    t.eq(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n, 2, '两篇原文落成 artifact');
    t.eq(db.prepare('SELECT COUNT(*) AS n FROM verdicts').get().n, 1, '一条判决');

    const again = await evVerify.execute({ claim: CLAIM, as_of: AS_OF });
    t.eq(again.inserted, false, '重复核验幂等');
    t.eq(db.prepare('SELECT COUNT(*) AS n FROM verdicts').get().n, 1, '不重复落判决');
    t.eq((await evVerify.execute({})).status, 'BAD_ARGUMENT', '空 claim 拒绝');
    db.close();
  }
}
