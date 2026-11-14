/**
 * lib/invariants.js — 不变量校验（跑在「落盘前」与「读回后」）
 *
 * 规格：docs/v0.4-master-plan.md 的 I1–I18，P0 只落这 8 条：
 *   I2  正向必有证据        SUPPORTED / SUPPORTED_WEAK 必须有 L1–L3 证据
 *   I3  反驳有据            REFUTED 必须有反向信号
 *   I4  冲突为真            CONFLICTING 必须有数字口径冲突
 *   I8  conf 可复算          |stored − recompute(basis)| ≤ 1e-9，且 stored 是 4 位定点
 *   I10 producer 只能是 js_rule / py_rule
 *   I13 evidence.fetched_at ≤ as_of
 *   I17 排序键不含浮点      (cluster_id, artifact_sha256, offset)
 *   I18 序列化幂等          JSON(JCS 近似) 两次结果一致
 *
 * 校验失败 → 抛 `INVARIANT_VIOLATION`（带 violations 明细），不静默放行。
 */
import { isHighLevel, isRefute, recomputeConfidence, RULES_VERSION } from './verdict.js';

export const CHECKED_INVARIANTS = ['I2', 'I3', 'I4', 'I8', 'I10', 'I13', 'I17', 'I18'];

function violation(id, message, detail) {
  return { id, message, detail: detail ?? null };
}

/** 证据排序键：不含浮点分数（I17），可直接用于稳定排序与去重 */
export function evidenceSortKey(item) {
  return [
    String(item?.cluster_id ?? ''),
    String(item?.artifact_sha256 ?? item?.sha256 ?? ''),
    Number(item?.offset ?? item?.span_start ?? 0),
  ];
}

export function compareEvidence(a, b) {
  const ka = evidenceSortKey(a);
  const kb = evidenceSortKey(b);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

/** 近似 JCS：键排序 + 无多余空白 + **跳过 undefined 键**（和 JSON.stringify 的口径一致）；够用来做「两次序列化是否一致」 */
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function checkVerdictV1(result = {}, input = {}) {
  const violations = [];
  const verdict = String(result.verdict ?? '');
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const highLevel = evidence.filter((item) => isHighLevel(item?.level));

  // I10
  if (!['js_rule', 'py_rule'].includes(String(result.producer))) {
    violations.push(violation('I10', 'producer 必须是 js_rule 或 py_rule', result.producer));
  }

  // I2
  if (['SUPPORTED', 'SUPPORTED_WEAK'].includes(verdict) && highLevel.length === 0) {
    violations.push(violation('I2', '正向判决必须有 L1–L3 证据', verdict));
  }

  // I3
  if (verdict === 'REFUTED' && !evidence.some((item) => isRefute(item))) {
    violations.push(violation('I3', 'REFUTED 必须有反向信号证据'));
  }

  // I4
  if (
    verdict === 'CONFLICTING' &&
    !evidence.some(
      (item) =>
        item?.numericConflict === true ||
        String(item?.numericVerdict ?? '').toUpperCase() === 'ERROR' ||
        String(item?.numericResult ?? '').toUpperCase() === 'ERROR',
    )
  ) {
    violations.push(violation('I4', 'CONFLICTING 必须有数字口径冲突证据'));
  }

  // I8
  if (result.basis) {
    const recomputed = recomputeConfidence(result.basis);
    if (Math.abs(Number(result.confidence) - recomputed) > 1e-9) {
      violations.push(violation('I8', 'conf 与 basis 复算不一致', { stored: result.confidence, recomputed }));
    }
    if (Math.round(Number(result.confidence) * 1e4) / 1e4 !== Number(result.confidence)) {
      violations.push(violation('I8', 'conf 必须是 4 位定点', result.confidence));
    }
  } else {
    violations.push(violation('I8', '缺 basis，conf 无法复算'));
  }

  // 规则版本要写明（否则 current 唯一性无从判定）
  if (String(result.rulesVersion ?? '') !== RULES_VERSION) {
    violations.push(violation('RULES_VERSION', 'rulesVersion 必须等于 ' + RULES_VERSION, result.rulesVersion));
  }

  return violations;
}

/** I13：证据的 fetched_at 不得晚于主张的 as_of */
export function checkFreshnessBound(evidence = [], asOf) {
  const violations = [];
  const bound = asOf ? Date.parse(String(asOf)) : NaN;
  if (!Number.isFinite(bound)) return violations;
  for (const item of evidence) {
    const stamp = item?.fetched_at ?? item?.fetchedAt ?? item?.data_as_of ?? item?.dataAsOf;
    const ms = stamp ? Date.parse(String(stamp)) : NaN;
    if (Number.isFinite(ms) && ms > bound) {
      violations.push(violation('I13', '证据晚于 as_of', { fetched_at: stamp, as_of: asOf }));
    }
  }
  return violations;
}

/** I17：排序键必须互不相同（同一 artifact 同一 offset 出现两次说明去重没做） */
export function checkSortKeyUnique(evidence = []) {
  const seen = new Map();
  const violations = [];
  for (const item of evidence) {
    const key = evidenceSortKey(item).join('|');
    const prev = seen.get(key);
    if (prev) {
      violations.push(violation('I17', '排序键重复', { key, first: prev, second: item?.id ?? null }));
      continue;
    }
    seen.set(key, item?.id ?? null);
  }
  return violations;
}

/** I18：同一对象序列化两次必须一致，且不受键顺序影响 */
export function checkSerializationIdempotent(value) {
  const first = canonicalJson(value);
  const second = canonicalJson(JSON.parse(JSON.stringify(value)));
  return first === second ? [] : [violation('I18', '序列化不幂等', null)];
}

/** 汇总校验；`strict` 下抛错 */
export function validate(params = {}, options = {}) {
  const { result, evidence = [], asOf = null } = params;
  const violations = [
    ...checkVerdictV1(result, { evidence }),
    ...checkFreshnessBound(evidence, asOf),
    ...checkSortKeyUnique(evidence),
    ...checkSerializationIdempotent(result ?? {}),
  ];
  if (violations.length && options.strict !== false) {
    const error = new Error('INVARIANT_VIOLATION: ' + violations.map((v) => v.id + ' ' + v.message).join('; '));
    error.code = 'INVARIANT_VIOLATION';
    error.violations = violations;
    throw error;
  }
  return violations;
}

/** I16 的读侧检查：每 (claim_id, rules_version) 只能有一条 current（superseded_by IS NULL） */
export function checkCurrentVerdictUnique(db, claimId, rulesVersion = RULES_VERSION) {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM verdicts WHERE claim_id = ? AND rules_version = ? AND superseded_by IS NULL',
    )
    .get(String(claimId), String(rulesVersion));
  const n = Number(row?.n ?? 0);
  return n <= 1 ? [] : [violation('I16', '同 claim 同 rules_version 有多条 current', { claimId, rulesVersion, n })];
}
