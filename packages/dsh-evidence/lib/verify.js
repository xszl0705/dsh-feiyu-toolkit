/**
 * lib/verify.js — `ev_verify` 的编排层：把「检索 → 抓取 → 抽取 → 比对 → 判决 → 落库」串起来
 *
 * 规格：docs/tech-spec-evidence.md §4.4
 *
 * 设计取舍：这一层**不自己发请求、不自己开库**，全部依赖注入。
 *   - 这样离线测试可以造「哪些页面支持/哪些数字冲突」，不必连网
 *   - `ev_verify` 工具只负责把真实依赖（channel / artifact / db）装进来
 *
 * 硬约束：
 *   1. 检索后端缺失 → `degraded: true` + `gaps: ['SEARCH_UNAVAILABLE']`，判决只能弃权（不许猜）
 *   2. UGC 簇（`leadOnly`）**不进 evidence**，只进 `leads` —— 否则雪球帖子会把判决抬起来
 *   3. 抓取失败的簇进 `gaps`，不当成「没找到反向证据」
 */
import { annotate, clusterCandidates, buildCoverage } from './search.js';

export const DEPTH_PRESETS = {
  quick: { limit: 5, maxClusters: 3, perClusterFetches: 1 },
  deep: { limit: 8, maxClusters: 6, perClusterFetches: 2 },
};

const LEVEL_RANK = { A: 5, B: 4, C: 3, D: 2, E: 1 };

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

/** 每个 atom 生成 2–3 条检索式：原文片段 / 数字+口径 / 官方站定向 */
export function buildQueries(claim, atoms = [], preset = DEPTH_PRESETS.quick) {
  const out = [];
  const head = String(claim ?? '').trim().slice(0, 40);
  if (head) out.push(head);
  for (const atom of atoms.slice(0, 3)) {
    if (atom.type === 'numeric') {
      const basis = atom.numeric?.basis ? atom.numeric.basis : '';
      const period = atom.numeric?.period ? atom.numeric.period : '';
      out.push([basis, atom.text, period].filter(Boolean).join(' ').trim());
    } else {
      out.push(String(atom.text).slice(0, 40));
    }
  }
  if (preset === DEPTH_PRESETS.deep && head) out.push(head + ' site:gov.cn');
  return [...new Set(out.filter((q) => q.length > 0))];
}

/**
 * @param {{claim:string, asOf?:string, depth?:'quick'|'deep', sources?:string[]}} input
 * @param {{
 *   extractAtoms:Function, saveClaim?:Function, runSearch:Function, searchImpl?:Function,
 *   fetchPage:Function, compareNumeric:Function, judgeV1:Function, saveVerdict?:Function,
 *   db?:object, nowISO?:Function,
 * }} deps
 */
export async function verifyClaim(input = {}, deps = {}) {
  const claim = String(input.claim ?? '').trim();
  if (!claim) return { status: 'BAD_ARGUMENT', message: 'claim 必填' };
  if (typeof deps.fetchPage !== 'function' || typeof deps.judgeV1 !== 'function') {
    return { status: 'ERROR', code: 'MISSING_DEPENDENCY', message: 'fetchPage / judgeV1 必须注入' };
  }

  const depth = DEPTH_PRESETS[input.depth] ? input.depth : 'quick';
  const preset = DEPTH_PRESETS[depth];
  const asOf = String(input.asOf ?? '') || (typeof deps.nowISO === 'function' ? deps.nowISO() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));

  const parsedClaim = deps.extractAtoms(claim, { asOf });
  const atoms = parsedClaim.atoms || [];
  const gaps = [];
  const leads = [];
  const evidence = [];
  const fetched = [];

  // 1. 候选来源：调用方指定则**不检索**（宿主 web_search 已经把候选挑过了），否则自己检索
  const providedSources = (Array.isArray(input.sources) ? input.sources : [])
    .map((item) => String(item ?? '').trim())
    .filter((item) => /^https?:\/\//i.test(item));
  const queries = providedSources.length ? [] : buildQueries(claim, atoms, preset);
  const seen = new Map();
  let searchUnavailable = false;

  if (providedSources.length) {
    for (const url of providedSources) seen.set(url, annotate({ url }));
  } else {
    for (const query of queries) {
      const result = await deps.runSearch({ query, limit: preset.limit, searchImpl: deps.searchImpl });
      if (!result.ok) {
        if (result.code === 'SEARCH_UNAVAILABLE') searchUnavailable = true;
        else gaps.push('SEARCH_FAILED:' + (result.code || 'UNKNOWN'));
        continue;
      }
      for (const candidate of result.candidates) if (!seen.has(candidate.url)) seen.set(candidate.url, candidate);
    }
  }

  const candidates = [...seen.values()];
  if (searchUnavailable && candidates.length === 0) gaps.push('SEARCH_UNAVAILABLE');
  if (candidates.length === 0 && !searchUnavailable) gaps.push('NO_SEARCH_RESULTS');

  const clusters = clusterCandidates(candidates);

  // 2. 逐簇抓取（UGC 只作线索）
  for (const cluster of clusters) {
    if (cluster.leadOnly) {
      leads.push({ clusterId: cluster.clusterId, level: cluster.level, urls: cluster.members.map((m) => m.url) });
      continue;
    }
    const members = [...cluster.members].sort((a, b) => (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0));
    for (const member of members.slice(0, preset.perClusterFetches)) {
      const page = await deps.fetchPage(member.url);
      if (!page || !page.ok) {
        gaps.push('FETCH_FAILED:' + member.url);
        continue;
      }
      if (collapse(page.text).length < 80) gaps.push('TEXT_TOO_SHORT:' + member.url);
      fetched.push({ cluster, member, page });
      break; // 每簇只认一条最优成员，避免同一篇稿被重复计成独立证据
    }
  }

  if (clusters.length > 0 && fetched.length === 0 && !gaps.includes('SEARCH_UNAVAILABLE')) {
    gaps.push('NO_NON_LEAD_CLUSTERS');
  }

  // 3. 每簇一条 evidence：support / refute（数字冲突）/ unknown
  for (const item of fetched) {
    const pageText = collapse(item.page.text);
    const pageNumbers = (deps.extractAtoms(item.page.text, { asOf }).atoms || []).filter((a) => a.type === 'numeric');
    let conflict = false;
    let supported = 0;
    let offset = 0;

    for (const atom of atoms) {
      if (atom.type === 'numeric') {
        // 先看原文里有没有同一个数字串：命中即支持，不再拿别的数字去比（否则同页多个金额会互相误判冲突）
        if (pageText.includes(collapse(atom.text))) {
          supported += 1;
          const at = String(item.page.text).indexOf(atom.text);
          if (!offset && at > 0) offset = at;
          continue;
        }
        // 没原样命中，才在同一口径（basis）或同一期间下找可比的数字
        const sameUnit = pageNumbers.filter((p) => (p.numeric?.unit ?? null) === (atom.numeric?.unit ?? null));
        const comparable = sameUnit.filter((p) =>
          atom.numeric?.basis
            ? p.numeric?.basis === atom.numeric.basis
            : (p.numeric?.period ?? null) === (atom.numeric?.period ?? null),
        );
        let matched = false;
        for (const candidate of comparable) {
          const cmp = deps.compareNumeric(atom.numeric, candidate.numeric);
          if (cmp.result === 'ERROR') conflict = true;
          if (cmp.result === 'EQUAL' || cmp.result === 'CALIBER') matched = true;
        }
        if (matched) supported += 1;
      } else if (pageText.includes(collapse(atom.text))) {
        supported += 1;
        const at = String(item.page.text).indexOf(atom.text);
        if (!offset && at > 0) offset = at;
      }
    }

    evidence.push({
      id: 'ev_' + item.cluster.clusterId + '_' + (item.page.sha256 || '').slice(0, 8),
      cluster_id: item.cluster.clusterId,
      level: item.member.level,
      stance: conflict ? 'refute' : supported > 0 ? 'support' : 'unknown',
      ...(conflict ? { numericVerdict: 'ERROR', numericConflict: true } : {}),
      artifact_sha256: item.page.sha256 || '',
      offset,
      fetched_at: item.page.fetchedAt,
      url: item.member.url,
      supportedAtoms: supported,
    });
  }

  // 4. 判决（degraded 必须带 gaps，这条由 judgeV1 自己把守）
  const coverage = { ...buildCoverage({ clusters, sourcesTried: queries.length }), depth };
  const degraded = gaps.includes('SEARCH_UNAVAILABLE') || gaps.some((g) => g.startsWith('SEARCH_FAILED'));
  const verdict = deps.judgeV1({ evidence, coverage, degraded, gaps, now: asOf });

  // 5. 落库（可选：测试里可以不传 db）
  let claimId = null;
  let verdictId = null;
  let inserted = null;
  if (deps.db && typeof deps.saveClaim === 'function') {
    const saved = deps.saveClaim({ db: deps.db, text: claim, asOf, atoms });
    claimId = saved.claimId;
    if (typeof deps.saveVerdict === 'function') {
      const v = deps.saveVerdict({ db: deps.db, claimId, result: verdict, evidence });
      verdictId = v.id;
      inserted = v.inserted;
    }
  }

  return {
    status: 'OK',
    claimId,
    verdictId,
    inserted,
    asOf,
    depth,
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    basis: verdict.basis,
    rulesVersion: verdict.rulesVersion,
    producer: verdict.producer,
    atomCount: atoms.length,
    evidenceCount: evidence.length,
    sourcesUsed: providedSources.length,
    evidence,
    leads,
    gaps,
    degraded,
    coverage,
    clusters: clusters.length,
    queries,
  };
}
