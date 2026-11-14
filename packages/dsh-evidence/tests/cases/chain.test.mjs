/**
 * tests/cases/chain.test.mjs — 端到端一条链：文本 → 原子 → 数字复算 → 判决 → 落库
 *
 * 这条用例存在的意义：单模块全绿不等于链能跑通。
 * 这里只用公开入口（extractAtoms / compareNumeric / judgeV1 / validate / saveVerdict），
 * 不碰内部函数——所以它红了就是真链路断了。
 */
import { openDatabase } from '../../lib/db.js';
import { extractAtoms, saveClaim } from '../../lib/claim.js';
import { compareNumeric } from '../../lib/numeric.js';
import { judgeV1, loadCurrentVerdict, saveVerdict } from '../../lib/verdict.js';
import { validate } from '../../lib/invariants.js';

const AS_OF = '2026-11-12T00:00:00Z';
const SRC_A = '贵州茅台2024年实现营业收入1741.44亿元，同比增长15.66%。';
const SRC_B = '贵州茅台2024年实现营业收入1200.00亿元，同比增长9.10%。';

function firstNumeric(atoms) {
  return atoms.find((a) => a.type === 'numeric');
}

export const name = 'chain';

export async function run(t) {
  const db = openDatabase(':memory:');
  const claimedA = extractAtoms(SRC_A, { asOf: AS_OF });
  const claimedB = extractAtoms(SRC_B, { asOf: AS_OF });

  // 1. 两个来源各自抽出金额 atom
  const amountA = firstNumeric(claimedA.atoms);
  const amountB = firstNumeric(claimedB.atoms);
  t.eq(amountA?.numeric?.unit, '亿元', '来源 A 抽出亿元金额');
  t.eq(amountB?.numeric?.unit, '亿元', '来源 B 抽出亿元金额');
  t.eq(SRC_A.slice(amountA.span[0], amountA.span[1]), amountA.text, 'A 的 span 能在原文切片');

  // 2. 复算：1741.44 亿 vs 1200 亿 → ERROR
  const cmp = compareNumeric(amountA.numeric, amountB.numeric);
  t.eq(cmp.result, 'ERROR', '两个金额相差过大 → ERROR');
  t.eq(cmp.unitIssue, null, '不是量纲问题，是数值问题');

  // 3. 数字冲突 → 判决必须是 CONFLICTING（不和稀泥）
  const evidence = [
    {
      id: 'ev-a',
      cluster_id: 'eastmoney',
      level: 'A',
      stance: 'support',
      artifact_sha256: 'sha-a',
      offset: amountA.span[0],
      fetched_at: '2026-11-10T00:00:00Z',
      numericVerdict: cmp.result,
    },
    {
      id: 'ev-b',
      cluster_id: 'sina',
      level: 'B',
      stance: 'support',
      artifact_sha256: 'sha-b',
      offset: amountB.span[0],
      fetched_at: '2026-11-10T00:00:00Z',
      numericVerdict: 'ERROR',
    },
  ];
  const result = judgeV1({ evidence, coverage: { saturation: 'unknown' }, now: AS_OF });
  t.eq(result.verdict, 'CONFLICTING', '数字冲突 → CONFLICTING');
  t.eq(result.producer, 'js_rule', '判决由规则产出');
  t.ok(result.confidence > 0 && result.confidence <= 1, 'conf 落在 (0,1]');
  t.eq(validate({ result, evidence, asOf: AS_OF }), [], '链路结果零违规');

  // 4. 落库：claim → verdict → 读回
  const claimText = '贵州茅台2024年营业收入1741.44亿元。';
  const atoms = extractAtoms(claimText, { asOf: AS_OF });
  const claim = saveClaim({ db, text: claimText, asOf: AS_OF, atoms: atoms.atoms });
  const saved = saveVerdict({ db, claimId: claim.claimId, result, evidence, checkedAt: AS_OF });
  t.eq(saved.inserted, true, '判决落库');
  const current = loadCurrentVerdict(db, claim.claimId);
  t.eq(current.verdict, 'CONFLICTING', '读回判决一致');
  t.eq(current.confidence, result.confidence, '读回 conf 一致');
  t.eq(current.basis.formula_id, 'conf_v1', '读回公式 id');

  db.close();
}
