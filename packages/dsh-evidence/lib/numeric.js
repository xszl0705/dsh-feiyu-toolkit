/**
 * lib/numeric.js — 数字复算与量纲检测
 *
 * 规格：docs/tech-spec-evidence.md §5.4（13 域四级 + 单位检测）
 * 三条硬约束：
 *   1. 容差按「该单位的最小可存储刻度」算：`absTol = 0.5 * 10^-decimals * scale`。
 *      按小数位算会把「亿元」下的 0.01 当成 100 万元（自审 A6 已否掉）。
 *   2. 对称式判定：`|a-b| <= max(absTol, ρ·max(|a|,|b|))`，ρ = 0.005（CALIBER）/ 0.010（UNSURE）。
 *      比率/增速没有单位刻度，absTol 退化为 0.5 × 显示精度（pp 1 位 → 0.05，% 2 位 → 0.005）。
 *   3. 单位问题不等于数字问题：`UNIT_ERROR` / `UNIT_MISMATCH` / `LOW_BASE` 单独出，不混进四级。
 */
import { createHash } from 'node:crypto';

/** 元/千元/万元/亿元 → 刻度；`亿`/`万` 是简写 */
export const UNIT_SCALE = { 元: 1, 千元: 1e3, 万元: 1e4, 亿元: 1e8, 亿: 1e8, 万: 1e4 };

/** 比率类单位：没有量纲刻度，容差只看显示精度 */
export const RATIO_UNITS = new Set(['%', '个百分点', 'pp', '倍']);

/** 单位误标时常见的三档倍数 */
export const UNIT_FACTORS = [1e2, 1e4, 1e8];

export const EQUAL = 'EQUAL';
export const CALIBER = 'CALIBER';
export const UNSURE = 'UNSURE';
export const ERROR = 'ERROR';

export function unitScale(label) {
  if (label === null || label === undefined || label === '') return 1;
  return UNIT_SCALE[label] ?? 1;
}

export function isRatioUnit(label) {
  return RATIO_UNITS.has(label);
}

/** 该单位、该显示精度下的绝对容差 */
export function absTolFor(unitLabel, storedDecimals = 0) {
  const decimals = Number.isFinite(Number(storedDecimals)) ? Number(storedDecimals) : 0;
  return 0.5 * Math.pow(10, -decimals) * unitScale(unitLabel);
}

/**
 * 四级比对。返回字符串，与 tech-spec 的 `cmpNumeric` 签名一致。
 * @param {number} a
 * @param {number} b
 * @param {'amount'|'growth'|'ratio'} [kind]
 * @param {string|null} [unitLabel]
 * @param {number} [storedDecimals] 两边显示精度的较小值
 */
export function cmpNumeric(a, b, kind = 'amount', unitLabel = null, storedDecimals = 0) {
  return cmpNumericDetailed(a, b, kind, unitLabel, storedDecimals).result;
}

/**
 * 带证据的比对：verdict 的 basis 需要能复算出 result，所以把中间量一起给出去。
 *
 * **量纲对齐**：`a`/`b` 各自带着 `unitLabel` 这个单位（如 1741.44 亿元），
 * 所以先换算到基准单位（元）再和 `absTol` 比——`absTol` 也是基准单位口径（5e5 元）。
 * 直接把「亿元口径的差值(0.01)」和「元口径的容差(5e5)」比会永远判 EQUAL，这是实测踩过的坑。
 *
 * @returns {{result:string, absTol:number, diff:number, rel:number, kind:string, unitLabel:string|null, storedDecimals:number}}
 */
export function cmpNumericDetailed(a, b, kind = 'amount', unitLabel = null, storedDecimals = 0) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('BAD_NUMBER: ' + JSON.stringify({ a, b }));
  }
  const decimals = Number.isFinite(Number(storedDecimals)) ? Number(storedDecimals) : 0;
  const scale = unitScale(unitLabel);
  const absTol = absTolFor(unitLabel, decimals);
  const xa = x * scale;
  const ya = y * scale;
  const diff = Math.abs(xa - ya);
  const mag = Math.max(Math.abs(xa), Math.abs(ya));
  const rel = mag === 0 ? 0 : diff / mag;
  const base = { absTol, diff, rel, kind, unitLabel: unitLabel ?? null, storedDecimals: decimals };

  if (diff <= absTol) return { result: EQUAL, ...base };
  if (diff <= Math.max(absTol, 0.005 * mag)) return { result: CALIBER, ...base };
  if (diff <= Math.max(absTol, 0.01 * mag)) return { result: UNSURE, ...base };
  return { result: ERROR, ...base };
}

/**
 * 量纲检测：只回答「单位是不是有问题」，不做四级判定。
 * 顺序按规格：UNIT_ERROR → UNIT_MISMATCH → LOW_BASE。
 * @returns {null|'UNIT_ERROR'|'UNIT_MISMATCH'|'LOW_BASE'}
 */
export function detectUnit(a, b, unitLabelA = null, unitLabelB = unitLabelA, kind = 'amount') {
  const x = Math.abs(Number(a));
  const y = Math.abs(Number(b));
  const sameLabel = (unitLabelA ?? null) === (unitLabelB ?? null);

  if (sameLabel && Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0) {
    const ratio = x > y ? x / y : y / x;
    for (const factor of UNIT_FACTORS) {
      if (Math.abs(ratio / factor - 1) < 1e-6) return 'UNIT_ERROR';
    }
  }

  if (!sameLabel) return 'UNIT_MISMATCH';

  if (kind === 'growth' && Number.isFinite(y)) {
    // 基数按「显示单位」算：|b| < 100 个单位才算小基数（亿元口径就不是 100 亿元，是 100 亿）
    if (Math.abs(y) < 100) return 'LOW_BASE';
  }

  return null;
}

/**
 * 直接比两个 numeric 对象（`{value, unit, decimals, ...}`，即 ev_claim 产出的 `atom.numeric`）
 * @returns {{result:string, unitIssue:string|null, absTol:number, rel:number, kind:string, unitLabel:string|null, decimals:number}}
 */
export function compareNumeric(numericA, numericB) {
  if (!numericA || !numericB) throw new Error('NOT_NUMERIC');
  const unitLabel = numericA.unit ?? numericB.unit ?? null;
  const kind = isRatioUnit(unitLabel) ? 'growth' : 'amount';
  const decimals = Math.min(Number(numericA.decimals ?? 0), Number(numericB.decimals ?? 0));
  const detailed = cmpNumericDetailed(numericA.value, numericB.value, kind, unitLabel, decimals);
  const unitIssue = detectUnit(numericA.value, numericB.value, numericA.unit ?? null, numericB.unit ?? null, kind);
  return {
    result: detailed.result,
    unitIssue,
    absTol: detailed.absTol,
    rel: detailed.rel,
    kind,
    unitLabel,
    decimals,
  };
}

/** 稳定哈希：给 numeric 复算结果做去重键（basis 里要能复现） */
export function numericKey(parts) {
  return 'n_' + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}
