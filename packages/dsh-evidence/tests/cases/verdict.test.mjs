/**
 * tests/cases/verdict.test.mjs — 判决 v1（规则版）+ 不变量
 *
 * 断言重点：
 *   1. 判决链顺序：numeric_conflict → reverse → clusters≥2 → clusters==1 → abstain
 *   2. degraded 且 gaps 为空必须抛 INVARIANT_VIOLATION（故障不许伪装成结论）
 *   3. confidence 只能由 basis 复算出来（I8）
 *   4. abstain 三态按 coverage 分流
 *   5. 不变量校验：I2/I3/I4/I10/I13/I17/I18 都能被故意破坏触发
 */
import { judgeV1, LEVEL_WEIGHT, RULES_VERSION, consistencyP, capOf, freshnessOf, loadCurrentVerdict, recomputeConfidence, saveVerdict } from '../../lib/verdict.js';
import { canonicalJson, checkCurrentVerdictUnique, checkSortKeyUnique, compareEvidence, validate } from '../../lib/invariants.js';
import { openDatabase } from '../../lib/db.js';
import { extractAtoms, saveClaim } from '../../lib/claim.js';

const NOW = '2026-11-12T00:00:00Z';
const dayAgo = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString();

const EV = (cluster, level, stance = 'support', extra = {}) => ({
  id: cluster + '-' + level,
  cluster_id: cluster,
  level,
  stance,
  artifact_sha256: 'sha-' + cluster,
  offset: 0,
  fetched_at: dayAgo(5),
  ...extra,
});

export const name = 'verdict';

export async function run(t) {
  // 1. 基础常量与档位
  {
    t.eq(LEVEL_WEIGHT.A, 1.0, 'A 级权重 1.0');
    t.eq(LEVEL_WEIGHT.E, 0.15, 'E 级权重 0.15');
    t.eq(RULES_VERSION, 'verdict_v1', '规则版本号');
    t.eq(consistencyP(2, 2).P, 0.8, '全一致 → P=0.8');
    t.eq(consistencyP(1, 3).P, 0.5, '1/3 → P=0.5');
    t.eq(consistencyP(1, 4).P, 0.2, '1/4 → P=0.2');
    t.eq(capOf(1, 1), 0.6, '单簇 cap=0.6');
    t.eq(capOf(3, 0), 0.5, '无 L1–L3 cap=0.5');
    t.eq(capOf(3, 2), 1.0, '多簇 + 高等级不压制');
  }

  // 2. 新鲜度
  {
    t.eq(freshnessOf([], {}), 0.4, '无证据 freshness=0.4');
    t.eq(freshnessOf([EV('c1', 'A', 'support', { fetched_at: dayAgo(10) })], { now: NOW }), 1.0, '10 天 → 1.0');
    t.eq(freshnessOf([EV('c1', 'A', 'support', { fetched_at: dayAgo(100) })], { now: NOW }), 0.8, '100 天 → 0.8');
    t.eq(freshnessOf([EV('c1', 'A', 'support', { fetched_at: dayAgo(200) })], { now: NOW }), 0.6, '200 天 → 0.6');
    t.eq(freshnessOf([EV('c1', 'A', 'support', { fetched_at: dayAgo(400) })], { now: NOW }), 0.4, '400 天 → 0.4');
  }

  // 3. SUPPORTED：两个独立簇 + 高等级证据
  {
    const evidence = [EV('c1', 'A'), EV('c2', 'B')];
    const r = judgeV1({ evidence, coverage: { saturation: 'unknown' }, now: NOW });
    t.eq(r.verdict, 'SUPPORTED', '两簇高等级 → SUPPORTED');
    t.eq(r.producer, 'js_rule', 'producer 只能是 js_rule');
    t.eq(r.basis.P, 0.8, 'P 写进 basis');
    t.eq(r.basis.P_source, 'consistency_v1', 'P 来源可复算');
    t.eq(r.basis.indep, 0.6667, 'indep = min(2,3)/3');
    t.eq(r.basis.cap, 1.0, 'cap 不压制');
    t.eq(r.confidence, recomputeConfidence(r.basis), 'conf 可由 basis 复算');
    t.eq(r.clusters, 2, '簇数 2');
  }

  // 4. SUPPORTED_WEAK：单簇 + 高等级
  {
    const r = judgeV1({ evidence: [EV('c1', 'C')], now: NOW });
    t.eq(r.verdict, 'SUPPORTED_WEAK', '单簇 → SUPPORTED_WEAK');
    t.eq(r.basis.cap, 0.6, '单簇 cap=0.6');
    t.ok(r.confidence <= 0.6, 'conf 被 cap 压制');
  }

  // 5. REFUTED / CONFLICTING
  {
    const refuted = judgeV1({ evidence: [EV('c1', 'A', 'refute')], now: NOW });
    t.eq(refuted.verdict, 'REFUTED', '反向信号 + 高等级 → REFUTED');
    const conflicting = judgeV1({ evidence: [EV('c1', 'A', 'support', { numericConflict: true })], now: NOW });
    t.eq(conflicting.verdict, 'CONFLICTING', '数字口径冲突 → CONFLICTING');
    const both = judgeV1({ evidence: [EV('c1', 'A', 'refute', { numericResult: 'ERROR' })], now: NOW });
    t.eq(both.verdict, 'CONFLICTING', '冲突优先于反驳');
  }

  // 6. abstain 三态
  {
    t.eq(judgeV1({ evidence: [], coverage: { saturation: 'SATURATED' } }).verdict, 'UNVERIFIED_SATURATED', '饱和 → UNVERIFIED_SATURATED');
    t.eq(judgeV1({ evidence: [], coverage: { saturation: 'unknown' } }).verdict, 'UNVERIFIED_INSUFFICIENT_SEARCH', '无证据 → 检索不足');
    t.eq(judgeV1({ evidence: [], coverage: { insufficientSearch: true } }).verdict, 'UNVERIFIED_INSUFFICIENT_SEARCH', '显式检索不足');
    t.eq(judgeV1({ evidence: [EV('c1', 'E')] }).verdict, 'ABSTAINED_LOW_DISCRIMINATION', '有证据但不辨正反 → 低区分度弃权');
  }

  // 7. degraded 必须带 gaps
  {
    let threw = null;
    try {
      judgeV1({ evidence: [], degraded: true, gaps: [] });
    } catch (e) {
      threw = e;
    }
    t.eq(threw?.code, 'INVARIANT_VIOLATION', 'degraded 且 gaps 空 → 抛 INVARIANT_VIOLATION');
    const ok = judgeV1({ evidence: [], degraded: true, gaps: ['BUDGET_EXCEEDED'] });
    t.eq(ok.degraded, true, '带 gaps 的 degraded 允许返回');
    t.eq(ok.gaps, ['BUDGET_EXCEEDED'], 'gaps 原样带回');
  }

  // 8. 不变量校验：正常结果不报
  {
    const evidence = [EV('c1', 'A'), EV('c2', 'B')];
    const r = judgeV1({ evidence, now: NOW });
    const violations = validate({ result: r, evidence, asOf: NOW });
    t.eq(violations, [], '正常判决零违规');
  }

  // 9. 故意破坏：I2 / I3 / I4 / I8 / I10
  {
    const evidence = [EV('c1', 'E')];
    const base = judgeV1({ evidence: [EV('c1', 'A')], now: NOW });
    const i2 = validate({ result: { ...base, verdict: 'SUPPORTED' }, evidence }, { strict: false });
    t.eq(i2.some((v) => v.id === 'I2'), true, 'I2：正向无高等级证据被抓');
    const i3 = validate({ result: { ...base, verdict: 'REFUTED' }, evidence }, { strict: false });
    t.eq(i3.some((v) => v.id === 'I3'), true, 'I3：反驳无反向信号被抓');
    const i4 = validate({ result: { ...base, verdict: 'CONFLICTING' }, evidence }, { strict: false });
    t.eq(i4.some((v) => v.id === 'I4'), true, 'I4：冲突无冲突证据被抓');
    const i8 = validate({ result: { ...base, confidence: 0.123 }, evidence }, { strict: false });
    t.eq(i8.some((v) => v.id === 'I8'), true, 'I8：conf 与 basis 不一致被抓');
    const i10 = validate({ result: { ...base, producer: 'llm' }, evidence }, { strict: false });
    t.eq(i10.some((v) => v.id === 'I10'), true, 'I10：producer 非规则被抓');
    let threw = false;
    try {
      validate({ result: { ...base, producer: 'llm' }, evidence });
    } catch (e) {
      threw = e?.code === 'INVARIANT_VIOLATION';
    }
    t.eq(threw, true, 'strict 下违规直接抛');
  }

  // 10. I13 / I17 / I18
  {
    const late = [EV('c1', 'A', 'support', { fetched_at: '2027-01-01T00:00:00Z' })];
    const r = judgeV1({ evidence: late, now: NOW });
    const i13 = validate({ result: r, evidence: late, asOf: '2026-11-12T00:00:00Z' }, { strict: false });
    t.eq(i13.some((v) => v.id === 'I13'), true, 'I13：证据晚于 as_of 被抓');
    const dup = [EV('c1', 'A'), EV('c1', 'A')];
    t.eq(checkSortKeyUnique(dup).length >= 1, true, 'I17：排序键重复被抓');
    t.eq(checkSortKeyUnique([EV('c1', 'A'), EV('c2', 'A')]).length, 0, 'I17：正常不报');
    t.eq(canonicalJson({ b: 2, a: 1 }) === canonicalJson({ a: 1, b: 2 }), true, 'I18：键序不影响序列化');
    const sorted = [EV('c2', 'A'), EV('c1', 'A')].sort(compareEvidence);
    t.eq(sorted.map((e) => e.cluster_id), ['c1', 'c2'], '按 cluster_id 稳定排序');
  }

  // 11. I16 读侧：current 唯一性
  {
    const db = openDatabase(':memory:');
    t.eq(checkCurrentVerdictUnique(db, 'cl_x'), [], '无 verdict 行时不报');
    db.close();
  }

  // 12. 判决落库：幂等 / 跨版本并存 / current 唯一 / 手写第二条 current 被抓
  {
    const db = openDatabase(':memory:');
    const claimText = '公司2024年营业收入1741.44亿元。';
    const asOf = '2026-11-12T00:00:00Z';
    const saved = saveClaim({ db, text: claimText, asOf, atoms: extractAtoms(claimText, { asOf }).atoms });
    const evidence = [EV('c1', 'A'), EV('c2', 'B')];
    const result = judgeV1({ evidence, now: NOW });

    const first = saveVerdict({ db, claimId: saved.claimId, result, evidence, checkedAt: NOW });
    t.eq(first.inserted, true, '首判落库');
    t.ok(/^vd_[0-9a-f]{16}$/.test(first.id), 'verdict id 形状正确');
    const again = saveVerdict({ db, claimId: saved.claimId, result, evidence, checkedAt: NOW });
    t.eq(again.inserted, false, '同证据同规则 → 幂等不插新行');
    t.eq(again.id, first.id, '幂等返回同一 id');
    t.eq(db.prepare('SELECT COUNT(*) AS n FROM verdicts').get().n, 1, 'verdicts 只有一行');

    const current = loadCurrentVerdict(db, saved.claimId);
    t.eq(current.verdict, 'SUPPORTED', '读到当前判决');
    t.eq(current.confidence, result.confidence, '读回 conf 一致');
    t.eq(current.basis.P, result.basis.P, '读回 basis 一致');
    t.eq(current.degraded, false, 'degraded 落库为 0');

    // 新证据 → 新判决，旧 current 被 supersede
    const evidence2 = [EV('c1', 'A'), EV('c2', 'B'), EV('c3', 'C')];
    const result2 = judgeV1({ evidence: evidence2, now: NOW });
    const second = saveVerdict({ db, claimId: saved.claimId, result: result2, evidence: evidence2, checkedAt: NOW });
    t.eq(second.inserted, true, '新证据落新判决');
    t.eq(db.prepare('SELECT COUNT(*) AS n FROM verdicts').get().n, 2, '两行 verdict（跨证据）');
    t.eq(db.prepare('SELECT COUNT(*) AS n FROM verdicts WHERE superseded_by IS NULL').get().n, 1, '只有一条 current');
    t.eq(db.prepare('SELECT superseded_by FROM verdicts WHERE id = ?').get(first.id).superseded_by, second.id, '旧判决指向新判决');
    t.eq(checkCurrentVerdictUnique(db, saved.claimId), [], 'I16 读侧无违规');

    // 同 idem_key 但内容不同 → I11 报错
    let idemThrew = false;
    try {
      saveVerdict({ db, claimId: saved.claimId, result: { ...result, confidence: 0.1 }, evidence, checkedAt: NOW });
    } catch (e) {
      idemThrew = e?.code === 'INVARIANT_VIOLATION';
    }
    t.eq(idemThrew, true, 'I11：同 idem_key 内容不同 → INVARIANT_VIOLATION');

    // 手动插第二条 current → 被 DB 唯一索引直接拒绝（I16 在存储层就成立）
    let dbThrew = false;
    try {
      db.prepare(
        "INSERT INTO verdicts (id, claim_id, verdict, confidence, conf_basis, degraded, gaps, coverage, rules_version, idem_key, checked_at) VALUES ('vd_manual','" +
          saved.claimId +
          "','SUPPORTED',0.5,NULL,0,'[]','{}','verdict_v1','idem_manual','" +
          NOW +
          "')",
      ).run();
    } catch (e) {
      dbThrew = /UNIQUE|constraint/i.test(String(e?.message || e));
    }
    t.eq(dbThrew, true, 'I16：第二条 current 被唯一索引拒绝');
    t.eq(checkCurrentVerdictUnique(db, saved.claimId), [], 'I16 读侧仍然零违规');
    db.close();
  }
}
