/**
 * lib/verdict.js — 判决 v1（规则版，**唯一的 verdict 写入口**）
 *
 * 规格：docs/tech-spec-evidence.md §5.5；置信度公式见 docs/framework-v0.3.md §「判决」：
 *   `conf = 0.5·P + 0.15·indep + 0.2·level + 0.15·freshness`，定点 4 位，另受 `cap` 压制。
 *
 * 三条铁律：
 *   1. `producer` 只能是 `js_rule`（P0）——LLM 不得写判决字段
 *   2. `degraded` 且 `gaps` 为空 → 直接抛 `INVARIANT_VIOLATION`：故障不许伪装成结论
 *   3. `basis` 必须能把 `confidence` 复算出来（I8，误差 ≤ 1e-9）
 */
import { createHash } from 'node:crypto';

export const RULES_VERSION = 'verdict_v1';
export const CONF_FORMULA_ID = 'conf_v1';

/** 来源等级权重（A 最高） */
export const LEVEL_WEIGHT = { A: 1.0, B: 0.7, C: 0.5, D: 0.3, E: 0.15 };
/** L1–L3（A/B/C）才算「够等级」的证据 */
export const HIGH_LEVELS = ['A', 'B', 'C'];

export const VERDICT = {
  SUPPORTED: 'SUPPORTED',
  SUPPORTED_WEAK: 'SUPPORTED_WEAK',
  REFUTED: 'REFUTED',
  CONFLICTING: 'CONFLICTING',
  UNVERIFIED_SATURATED: 'UNVERIFIED_SATURATED',
  UNVERIFIED_INSUFFICIENT_SEARCH: 'UNVERIFIED_INSUFFICIENT_SEARCH',
  ABSTAINED_LOW_DISCRIMINATION: 'ABSTAINED_LOW_DISCRIMINATION',
};

const SUPPORT_STANCES = new Set(['support', 'agree', 'entail', 'assert', 'back']);
const REFUTE_STANCES = new Set(['refute', 'contradict', 'deny', 'against']);

export function levelWeight(level) {
  return Number(LEVEL_WEIGHT[String(level ?? '').toUpperCase()]) || 0;
}

export function isHighLevel(level) {
  return HIGH_LEVELS.includes(String(level ?? '').toUpperCase());
}

export function stanceOf(item) {
  return String(item?.stance ?? '').toLowerCase();
}

export function isSupport(item) {
  return SUPPORT_STANCES.has(stanceOf(item));
}

export function isRefute(item) {
  return REFUTE_STANCES.has(stanceOf(item));
}

/** 同一 artifact 的多次出现归一个簇；无 cluster_id 时按 artifact/自身退化为独立簇 */
export function groupByCluster(evidence = []) {
  const groups = new Map();
  evidence.forEach((item, index) => {
    const key = item?.cluster_id ?? item?.artifact_id ?? item?.artifactId ?? `ev${index}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return groups;
}

export function maxLevelWeight(evidence = []) {
  return evidence.reduce((max, item) => Math.max(max, levelWeight(item?.level)), 0);
}

/** 一致性三档 P：ratio ≥ 0.8 → 0.8；≤ 0.3 → 0.2；其余 0.5（写进 basis 可复算） */
export function consistencyP(agreeing, total) {
  const ratio = total === 0 ? 0 : agreeing / total;
  const P = ratio >= 0.8 ? 0.8 : ratio <= 0.3 ? 0.2 : 0.5;
  return { ratio, P };
}

/** 新鲜度：30 天内 1.0 / 180 天内 0.8 / 1 年内 0.6 / 更早 0.4；无证据按 0.4 */
export function freshnessOf(evidence = [], options = {}) {
  const nowMs = toMs(options.now ?? new Date());
  const stamps = evidence
    .map((item) => toMs(item?.fetched_at ?? item?.fetchedAt ?? item?.data_as_of ?? item?.dataAsOf))
    .filter((x) => Number.isFinite(x));
  if (!stamps.length) return 0.4;
  const newest = Math.max(...stamps);
  const ageDays = (nowMs - newest) / 86400000;
  if (ageDays <= 30) return 1.0;
  if (ageDays <= 180) return 0.8;
  if (ageDays <= 365) return 0.6;
  return 0.4;
}

/** 上限压制：独立源 < 2 → 0.6；无 L1–L3 证据 → 0.5（取更严的） */
export function capOf(clusterCount = 0, highLevelCount = 0) {
  let cap = 1.0;
  if (clusterCount < 2) cap = Math.min(cap, 0.6);
  if (highLevelCount === 0) cap = Math.min(cap, 0.5);
  return cap;
}

export function round4(x) {
  return Math.round((Number(x) + Number.EPSILON) * 1e4) / 1e4;
}

/** 由 basis 复算置信度：唯一的算法入口，I8 靠它 */
export function recomputeConfidence(basis = {}) {
  const P = Number(basis.P) || 0;
  const indep = Number(basis.indep) || 0;
  const level = Number(basis.level) || 0;
  const freshness = Number(basis.freshness) || 0;
  const cap = Number.isFinite(Number(basis.cap)) ? Number(basis.cap) : 1;
  const raw = 0.5 * P + 0.15 * indep + 0.2 * level + 0.15 * freshness;
  return round4(Math.min(cap, Math.max(0, raw)));
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : NaN;
}

/** 证据里是否出现数字口径冲突（`numericVerdict` / `numericResult` 为 ERROR 或显式 numericConflict） */
export function hasNumericConflict(evidence = []) {
  return evidence.some(
    (item) =>
      item?.numericConflict === true ||
      String(item?.numericVerdict ?? '').toUpperCase() === 'ERROR' ||
      String(item?.numericResult ?? '').toUpperCase() === 'ERROR',
  );
}

function abstain(coverage = {}, hasEvidence) {
  const saturation = String(coverage?.saturation ?? '').toUpperCase();
  if (saturation === 'SATURATED') return VERDICT.UNVERIFIED_SATURATED;
  if (coverage?.insufficientSearch === true) return VERDICT.UNVERIFIED_INSUFFICIENT_SEARCH;
  if (hasEvidence) return VERDICT.ABSTAINED_LOW_DISCRIMINATION;
  return VERDICT.UNVERIFIED_INSUFFICIENT_SEARCH;
}

/**
 * @param {{
 *   evidence?: Array<object>,
 *   coverage?: {saturation?: string, sourcesTried?: number, sourcesHit?: number, insufficientSearch?: boolean},
 *   degraded?: boolean,
 *   gaps?: string[],
 *   recheckOk?: boolean,
 *   now?: Date|string,
 * }} input
 * @returns {{verdict:string, confidence:number, basis:object, producer:'js_rule', rulesVersion:string,
 *   degraded:boolean, gaps:string[], coverage:object, clusters:number}}
 */
export function judgeV1(input = {}) {
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const coverage = input.coverage ?? { saturation: 'unknown' };
  const degraded = Boolean(input.degraded);
  const gaps = Array.isArray(input.gaps) ? input.gaps : [];
  const recheckOk = input.recheckOk !== false;

  // 铁律 2：故障不许伪装成结论
  if (degraded && gaps.length === 0) {
    const error = new Error('INVARIANT_VIOLATION: degraded 但 gaps 为空（故障不许伪装成结论）');
    error.code = 'INVARIANT_VIOLATION';
    throw error;
  }

  const groups = groupByCluster(evidence);
  const clusterCount = groups.size;
  let agreeingClusters = 0;
  for (const items of groups.values()) {
    if (items.some((item) => isSupport(item))) agreeingClusters += 1;
  }
  const { ratio, P } = consistencyP(agreeingClusters, clusterCount);
  const highLevel = evidence.filter((item) => isHighLevel(item?.level));
  const reverseSignal = evidence.some((item) => isRefute(item));
  const numericConflict = hasNumericConflict(evidence);

  if (numericConflict) {
    return finish(VERDICT.CONFLICTING, { P, ratio, clusterCount, highLevel, evidence, coverage, degraded, gaps });
  }
  if (reverseSignal && highLevel.length > 0) {
    return finish(VERDICT.REFUTED, { P, ratio, clusterCount, highLevel, evidence, coverage, degraded, gaps });
  }
  if (clusterCount >= 2 && recheckOk && highLevel.length > 0) {
    return finish(VERDICT.SUPPORTED, { P, ratio, clusterCount, highLevel, evidence, coverage, degraded, gaps });
  }
  if (clusterCount === 1 && highLevel.length > 0) {
    return finish(VERDICT.SUPPORTED_WEAK, { P, ratio, clusterCount, highLevel, evidence, coverage, degraded, gaps });
  }
  const v = abstain(coverage, evidence.length > 0);
  return finish(v, { P, ratio, clusterCount, highLevel, evidence, coverage, degraded, gaps });
}

function finish(verdict, ctx) {  const { P, ratio, clusterCount, highLevel, evidence, coverage, degraded, gaps } = ctx;
  const indep = Math.min(clusterCount, 3) / 3;
  const level = maxLevelWeight(evidence);
  const freshness = freshnessOf(evidence, { now: ctx.now });
  const basis = {
    formula_id: CONF_FORMULA_ID,
    P,
    P_source: 'consistency_v1',
    consistency: round4(ratio),
    indep: round4(indep),
    level: round4(level),
    freshness: round4(freshness),
    cap: capOf(clusterCount, highLevel.length),
  };
  return {
    verdict,
    confidence: recomputeConfidence(basis),
    basis,
    producer: 'js_rule',
    rulesVersion: RULES_VERSION,
    degraded: Boolean(degraded),
    gaps: gaps || [],
    coverage: coverage || {},
    clusters: clusterCount,
  };
}

/** 稳定序列化（只用于算 idem_key 与比对，不引入 invariants 以免循环依赖） */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}

function sha256Short(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 幂等键：同 claim + 同规则版本 + 同证据摘要 → 同一个键（I11：键相同则 deepEqual）
 */
export function idemKeyFor({ claimId, rulesVersion = RULES_VERSION, evidence = [], asOf = null }) {
  return 'idem_' + sha256Short(stable({ claimId, rulesVersion, asOf, evidence })).slice(0, 24);
}

const INSERT_VERDICT = `
INSERT INTO verdicts (
  id, claim_id, verdict, confidence, conf_basis, calibration_id, degraded,
  gaps, coverage, conflict_state, rules_version, idem_key, checked_at, valid_until, superseded_by
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
`;

/**
 * 落库（**唯一的 verdict 写入口**）：
 *   1. 同 `idem_key` 命中 → 只比内容（I11），一致就直接返回既有行，不插新行
 *   2. 否则先把该 `(claim_id, rules_version)` 的旧 current 标 `superseded_by`，再插新 current
 *   3. `degraded`/`gaps`/`coverage` 原样落库，便于 `abstain` 可回溯
 *
 * @returns {{id:string, inserted:boolean, superseded:string[]}}
 */
export function saveVerdict({ db, claimId, result, evidence = [], idemKey = null, checkedAt = null, validUntil = null }) {
  if (!db) throw new Error('SAVE_VERDICT_NO_DB');
  if (!claimId) throw new Error('SAVE_VERDICT_NO_CLAIM');
  if (!result || !result.verdict) throw new Error('SAVE_VERDICT_NO_RESULT');

  const key = idemKey || idemKeyFor({ claimId, rulesVersion: result.rulesVersion, evidence });
  const existing = db.prepare('SELECT * FROM verdicts WHERE idem_key = ?').get(key);
  const payload = stable({
    verdict: result.verdict,
    confidence: result.confidence,
    basis: result.basis ?? null,
  });
  if (existing) {
    const same = stable({
      verdict: existing.verdict,
      confidence: Number(existing.confidence),
      basis: existing.conf_basis ? JSON.parse(existing.conf_basis) : null,
    });
    if (same !== payload) {
      const error = new Error('INVARIANT_VIOLATION: I11 同 idem_key 判定不一致');
      error.code = 'INVARIANT_VIOLATION';
      throw error;
    }
    return { id: existing.id, inserted: false, superseded: [] };
  }

  const id = 'vd_' + sha256Short(key).slice(0, 16);
  const checked = checkedAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  db.prepare(
    'UPDATE verdicts SET superseded_by = ? WHERE claim_id = ? AND rules_version = ? AND superseded_by IS NULL',
  ).run(id, claimId, result.rulesVersion ?? RULES_VERSION);
  db.prepare(INSERT_VERDICT).run(
    id,
    claimId,
    result.verdict,
    result.confidence,
    result.basis ? JSON.stringify(result.basis) : null,
    result.calibrationId ?? null,
    result.degraded ? 1 : 0,
    JSON.stringify(result.gaps ?? []),
    JSON.stringify(result.coverage ?? {}),
    result.verdict === VERDICT.CONFLICTING ? 'CONFLICT' : null,
    result.rulesVersion ?? RULES_VERSION,
    key,
    checked,
    validUntil,
  );
  return { id, inserted: true, superseded: [] };
}

/** 读该 claim 当前生效的判决 */
export function loadCurrentVerdict(db, claimId, rulesVersion = RULES_VERSION) {
  const row = db
    .prepare('SELECT * FROM verdicts WHERE claim_id = ? AND rules_version = ? AND superseded_by IS NULL')
    .get(String(claimId), String(rulesVersion));
  if (!row) return null;
  return {
    id: row.id,
    claimId: row.claim_id,
    verdict: row.verdict,
    confidence: Number(row.confidence),
    basis: row.conf_basis ? JSON.parse(row.conf_basis) : null,
    degraded: Number(row.degraded) === 1,
    gaps: row.gaps ? JSON.parse(row.gaps) : [],
    coverage: row.coverage ? JSON.parse(row.coverage) : {},
    rulesVersion: row.rules_version,
    idemKey: row.idem_key,
    checkedAt: row.checked_at,
  };
}
