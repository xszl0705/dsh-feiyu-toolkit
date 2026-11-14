/**
 * lib/search.js — 检索薄封装 + 同源归并
 *
 * 规格：docs/tech-spec-evidence.md §4.7（`ev_search` 薄封装）、§5.3（同源归并）
 *
 * 三条硬约束：
 *   1. **不承诺检索全面性**：`coverage.saturation` 在 P0 恒为 `unknown`（SATURATED 是 P1 能力）
 *   2. **不做 UGC 的证据**：雪球/股吧/微博/知乎/公众号等只作线索，标 `leadOnly: true`、等级 E
 *   3. 归并只看「内容像不像同一篇稿」，不看域名：转载同稿必须落进一个簇，否则判决会虚高独立性
 *
 * 检索后端由外部注入（`searchImpl(query, {limit}) => [{url, title, snippet}]`），
 * 插件自己不发搜索请求——这样测试完全离线，换后端也不用改归并逻辑。
 */
import { createHash } from 'node:crypto';

/** 来源等级：A 官方/交易所，B 主流财经，C 一般商业媒体，D 博客/自媒体，E UGC（只作线索） */
export const LEVEL_BY_KIND = { A: 'A', B: 'B', C: 'C', D: 'D', E: 'E' };

const A_DOMAINS = [
  'gov.cn',
  'csrc.gov.cn',
  'stats.gov.cn',
  'pbc.gov.cn',
  'sse.com.cn',
  'szse.cn',
  'bse.cn',
  'chinaclear.cn',
  'hkexnews.hk',
  'sec.gov',
];

const B_DOMAINS = [
  'eastmoney.com',
  'sina.com.cn',
  'sina.cn',
  'cninfo.com.cn',
  'xinhuanet.com',
  'news.cn',
  'people.com.cn',
  'cctv.com',
  'yicai.com',
  'caixin.com',
  '21jingji.com',
  'stcn.com',
  'cnstock.com',
  'cs.com.cn',
  'jrj.com.cn',
  'hexun.com',
  'reuters.com',
  'bloomberg.com',
];

const D_DOMAINS = ['medium.com', 'substack.com', 'jianshu.com', 'csdn.net', 'sohu.com', 'baijiahao.baidu.com'];

const E_DOMAINS = [
  'xueqiu.com',
  'guba.eastmoney.com',
  'guba.sina.com.cn',
  'weibo.com',
  'zhihu.com',
  'tieba.baidu.com',
  'douban.com',
  'mp.weixin.qq.com',
  'toutiao.com',
];

export function domainOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function matchDomain(host, list) {
  return list.some((item) => host === item || host.endsWith('.' + item));
}

/**
 * @returns {{level:'A'|'B'|'C'|'D'|'E', leadOnly:boolean, domain:string}}
 */
export function levelOf(url) {
  const host = domainOf(url);
  if (matchDomain(host, E_DOMAINS)) return { level: 'E', leadOnly: true, domain: host };
  if (matchDomain(host, A_DOMAINS)) return { level: 'A', leadOnly: false, domain: host };
  if (matchDomain(host, B_DOMAINS)) return { level: 'B', leadOnly: false, domain: host };
  if (matchDomain(host, D_DOMAINS)) return { level: 'D', leadOnly: false, domain: host };
  return { level: 'C', leadOnly: false, domain: host };
}

const LEVEL_RANK = { A: 5, B: 4, C: 3, D: 2, E: 1 };

export function normalizeTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[【】\[\]（）()「」《》<>|｜_—–\-·:：,，.。!！?？"'"'`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 字符级 shingle（中文按字切，去空白），用于「同一篇稿」的相似度 */
export function shingles(text, size = 3) {
  const clean = String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, '');
  const out = new Set();
  if (!clean) return out;
  if (clean.length <= size) {
    out.add(clean);
    return out;
  }
  for (let i = 0; i + size <= clean.length; i += 1) out.add(clean.slice(i, i + size));
  return out;
}

export function jaccard(a, b) {
  const setA = a instanceof Set ? a : shingles(a);
  const setB = b instanceof Set ? b : shingles(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const item of setA) if (setB.has(item)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

function clusterIdFor(key) {
  return 'cl_' + createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
}

/** 候选 → 带等级与簇的结构（不做网络请求） */
export function annotate(candidate) {
  const info = levelOf(candidate?.url);
  return {
    url: String(candidate?.url ?? ''),
    title: String(candidate?.title ?? ''),
    snippet: String(candidate?.snippet ?? ''),
    ...info,
  };
}

/**
 * 同源归并：标题归一键相同，或者「标题 + 摘要」的 shingle 相似度过阈值 → 同一簇。
 * 簇的等级取成员里最高的等级（转载到小站不降低可信度，转载到 UGC 也不提升）。
 */
export function clusterCandidates(candidates = [], options = {}) {
  const threshold = Number(options.threshold) > 0 ? Number(options.threshold) : 0.6;
  const clusters = [];

  for (const raw of candidates) {
    const candidate = annotate(raw);
    if (!candidate.url) continue;
    // 没有标题也没有摘要（例如调用方直接给了 URL 列表）时，按 URL 各自成簇：
    // 既不能按空标题并成一簇，也不能因为「https://」这种相同前缀被判成同源。
    const contentless = !normalizeTitle(candidate.title) && !candidate.snippet;
    const titleKey = contentless
      ? candidate.url
      : normalizeTitle(candidate.title) || candidate.snippet.slice(0, 20);
    const sig = shingles(titleKey + candidate.snippet);

    let target = contentless
      ? null
      : clusters.find((cluster) => cluster.titleKey === titleKey || jaccard(cluster.sig, sig) >= threshold);

    if (!target) {
      target = {
        clusterId: clusterIdFor(titleKey),
        titleKey,
        sig,
        members: [],
        level: 'E',
        leadOnly: true,
      };
      clusters.push(target);
    }
    target.members.push(candidate);
    if (LEVEL_RANK[candidate.level] > LEVEL_RANK[target.level]) target.level = candidate.level;
    target.leadOnly = target.leadOnly && candidate.leadOnly;
  }

  return clusters.map((cluster) => ({
    clusterId: cluster.clusterId,
    level: cluster.level,
    leadOnly: cluster.leadOnly,
    members: cluster.members,
  }));
}

/**
 * coverage 口径（P0）：saturation 恒 `unknown`，只报实际统计到的数
 * @returns {{saturation:'unknown', sourcesTried:number, sourcesHit:number, types:string[], clusters:number, leads:number}}
 */
export function buildCoverage({ clusters = [], sourcesTried = 0 } = {}) {
  const all = clusters.flatMap((cluster) => cluster.members || []);
  const types = [...new Set(all.map((item) => item.level))].sort();
  return {
    saturation: 'unknown',
    sourcesTried: Number(sourcesTried) || 0,
    sourcesHit: all.length,
    types,
    clusters: clusters.length,
    leads: all.filter((item) => item.leadOnly).length,
  };
}

/**
 * 跑一次检索并归并。后端缺失时如实返回 `SEARCH_UNAVAILABLE`，不退化成「搜到了 0 条」。
 * @param {{query:string, limit?:number, searchImpl?:Function, now?:Function}} input
 */
export async function runSearch(input = {}) {
  const query = String(input.query ?? '').trim();
  if (!query) return { ok: false, code: 'BAD_QUERY' };
  const searchImpl = input.searchImpl ?? null;
  if (typeof searchImpl !== 'function') return { ok: false, code: 'SEARCH_UNAVAILABLE' };

  const limit = Number(input.limit) > 0 ? Number(input.limit) : 8;
  let raw = [];
  try {
    raw = (await searchImpl(query, { limit })) || [];
  } catch (e) {
    return { ok: false, code: String(e?.code || 'SEARCH_FAILED'), message: String(e?.message || e) };
  }
  const candidates = raw
    .filter((item) => item && item.url)
    .slice(0, limit)
    .map((item) => annotate(item));
  const clusters = clusterCandidates(candidates, { threshold: input.threshold });
  return {
    ok: true,
    query,
    candidates,
    clusters,
    coverage: buildCoverage({ clusters, sourcesTried: 1 }),
  };
}
