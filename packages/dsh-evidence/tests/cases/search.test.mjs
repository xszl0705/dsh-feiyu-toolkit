/**
 * tests/cases/search.test.mjs — 检索薄封装 + 同源归并
 *
 * 断言重点：
 *   1. 来源分级：官方/交易所 A、主流财经 B、一般 C、博客 D、UGC E（且 leadOnly）
 *   2. 同源归并：转载同稿（跨域名）落一个簇；不同稿分簇；簇等级取最高
 *   3. coverage：saturation 恒 unknown，sourcesHit / clusters / leads 数字对得上
 *   4. 后端缺失 → SEARCH_UNAVAILABLE（不退化成「搜到 0 条」）
 */
import path from 'node:path'
import { buildCoverage, clusterCandidates, domainOf, jaccard, levelOf, normalizeTitle, runSearch, shingles } from '../../lib/search.js';
import { createEvidenceTools } from '../../lib/tools.js';

const BODY = '贵州茅台2024年实现营业收入1741.44亿元，同比增长15.66%，归母净利润862.28亿元';

const HITS = [
  { url: 'http://www.csrc.gov.cn/news/123.html', title: '贵州茅台2024年年报披露', snippet: BODY },
  { url: 'https://finance.eastmoney.com/a/2024.html', title: '贵州茅台2024年年报披露', snippet: BODY },
  { url: 'https://xueqiu.com/1234/5678', title: '贵州茅台2024年年报披露', snippet: BODY },
  { url: 'https://example.com/other', title: '白酒行业2025年展望', snippet: '渠道库存去化，价格体系重塑，行业集中度继续提升' },
];

export const name = 'search';

export async function run(t) {
  // 1. 域名与分级
  {
    t.eq(domainOf('https://finance.eastmoney.com/a/2024.html'), 'finance.eastmoney.com', '取 hostname');
    t.eq(levelOf('http://www.csrc.gov.cn/news/1.html').level, 'A', '证监会 → A');
    t.eq(levelOf('https://www.sse.com.cn/1.html').level, 'A', '上交所 → A');
    t.eq(levelOf('https://finance.sina.com.cn/1.html').level, 'B', '新浪财经 → B');
    t.eq(levelOf('https://www.example.com/a').level, 'C', '未知域名 → C');
    t.eq(levelOf('https://medium.com/@a/1').level, 'D', 'medium → D');
    const ugc = levelOf('https://xueqiu.com/1/2');
    t.eq(ugc.level, 'E', '雪球 → E');
    t.eq(ugc.leadOnly, true, 'UGC 标 leadOnly（只作线索）');
    t.eq(levelOf('https://guba.eastmoney.com/news,1.html').leadOnly, true, '东财股吧也算 UGC');
  }

  // 2. 标题归一键与相似度
  {
    t.eq(normalizeTitle('【重磅】贵州茅台：2024年年报'), '重磅 贵州茅台 2024年年报', '去掉全角括号与冒号');
    t.eq(jaccard(shingles('同一个内容'), shingles('同一个内容')), 1, '同一文本相似度 1');
    t.eq(jaccard(shingles('aaaaa'), shingles('bbbbb')), 0, '无关文本相似度 0');
    t.ok(jaccard(shingles(BODY), shingles(BODY.slice(0, 30))) > 0.5, '同稿截断仍高相似');
  }

  // 3. 同源归并
  {
    const clusters = clusterCandidates(HITS);
    t.eq(clusters.length, 2, '三转载 + 一篇别的稿 → 2 簇');
    const same = clusters.find((cluster) => cluster.members.length === 3);
    t.ok(same, '转载同稿落进同一簇');
    t.eq(same.level, 'A', '簇等级取成员最高（证监会 A）');
    t.eq(same.leadOnly, false, '簇里只要有非 UGC 就不算线索');
    t.ok(same.members.some((m) => m.leadOnly === true), 'UGC 成员本身仍标 leadOnly');
    t.eq(clusters.every((c) => /^cl_[0-9a-f]{12}$/.test(c.clusterId)), true, 'clusterId 形状正确');
    const again = clusterCandidates(HITS);
    t.eq(again.map((c) => c.clusterId), clusters.map((c) => c.clusterId), '同一批候选归并结果稳定');
    // 只给 URL（没有标题/摘要）时按 URL 各自成簇，别把互不相关的来源并成一个
    const bare = clusterCandidates([{ url: 'https://a.example.com/1' }, { url: 'https://b.example.com/2' }]);
    t.eq(bare.length, 2, '无标题候选各自成簇');
    t.eq(bare.map((c) => c.level), ['C', 'C'], '未知域名按 C 级');
  }

  // 4. coverage
  {
    const clusters = clusterCandidates(HITS);
    const coverage = buildCoverage({ clusters, sourcesTried: 1 });
    t.eq(coverage.saturation, 'unknown', 'P0 saturation 恒 unknown');
    t.eq(coverage.sourcesHit, 4, '命中 4 条');
    t.eq(coverage.clusters, 2, '2 簇');
    t.eq(coverage.leads, 1, '1 条线索级（UGC）');
    t.eq(coverage.types, ['A', 'B', 'C', 'E'], '类型集合正确');
    t.eq(coverage.sourcesTried, 1, '检索式执行 1 次');
  }

  // 5. runSearch：成功 / 无后端 / 空 query
  {
    const ok = await runSearch({ query: '贵州茅台 2024 营业收入', searchImpl: async () => HITS });
    t.eq(ok.ok, true, '有后端 → ok');
    t.eq(ok.clusters.length, 2, '返回归并后的簇');
    t.eq(ok.coverage.saturation, 'unknown', '覆盖度口径不变');

    const none = await runSearch({ query: 'x' });
    t.eq(none.ok, false, '无后端 → 失败');
    t.eq(none.code, 'SEARCH_UNAVAILABLE', '如实报 SEARCH_UNAVAILABLE');

    const bad = await runSearch({ query: '   ', searchImpl: async () => HITS });
    t.eq(bad.code, 'BAD_QUERY', '空检索式 → BAD_QUERY');

    const boom = await runSearch({
      query: 'x',
      searchImpl: async () => {
        throw new Error('boom');
      },
    });
    t.eq(boom.ok, false, '后端抛错 → 失败');
    t.eq(boom.code, 'SEARCH_FAILED', '错误码 SEARCH_FAILED');
  }

  // 6. 工具层 ev_search
  {
    const defs = createEvidenceTools({
      dataDir: path.join(process.cwd(), '_tmp', 'evidence-search-test'),
      searchImpl: async () => HITS,
    });
    t.eq(defs.map((d) => d.name), ['ev_fetch', 'ev_extract', 'ev_claim', 'ev_search', 'ev_verify'], '注册五个工具');
    const evSearch = defs.find((d) => d.name === 'ev_search');
    t.eq(evSearch.parameters.required, ['query'], 'ev_search 必填 query');
    const r = await evSearch.execute({ query: '贵州茅台 2024 营业收入' });
    t.eq(r.status, 'OK', '工具返回 OK');
    t.eq(r.clusterCount, 2, '两簇');
    t.eq(r.candidateCount, 4, '四条候选');
    t.eq(r.coverage.saturation, 'unknown', 'coverage 口径透传');
    const noBackend = createEvidenceTools({ dataDir: path.join(process.cwd(), '_tmp', 'evidence-search-test') });
    const r2 = await noBackend.find((d) => d.name === 'ev_search').execute({ query: 'x' });
    t.eq(r2.status, 'SEARCH_UNAVAILABLE', '无后端时工具如实报不可用');
    t.eq((await evSearch.execute({})).status, 'BAD_QUERY', '缺 query → BAD_QUERY');
  }
}
