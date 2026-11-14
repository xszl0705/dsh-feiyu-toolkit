/**
 * tests/cases/numeric.test.mjs — 数字复算四级 + 量纲检测
 *
 * 断言重点：
 *   1. 容差按单位刻度算：亿元下 0.01 亿（=100 万元）不该被当成 EQUAL
 *   2. 对称式阈值：CALIBER ≤ 0.5%、UNSURE ≤ 1%、其余 ERROR
 *   3. 比率/增速没有刻度，absTol = 0.5 × 显示精度
 *   4. 单位问题单独出：UNIT_ERROR / UNIT_MISMATCH / LOW_BASE
 *   5. 中间量（absTol / rel）能给出来，basis 才能复算
 */
import { absTolFor, cmpNumeric, cmpNumericDetailed, compareNumeric, detectUnit, isRatioUnit, unitScale } from '../../lib/numeric.js';

export const name = 'numeric';

export async function run(t) {
  // 1. 刻度与容差
  {
    t.eq(unitScale('亿元'), 1e8, '亿元刻度 1e8');
    t.eq(unitScale('万元'), 1e4, '万元刻度 1e4');
    t.eq(unitScale(null), 1, '无单位刻度按 1');
    t.eq(unitScale('%'), 1, '比率无刻度');
    t.eq(absTolFor('亿元', 2), 0.5 * 1e-2 * 1e8, '亿元两位小数容差 = 50 万');
    t.eq(absTolFor('%', 2), 0.005, '% 两位小数容差 0.005');
    t.eq(absTolFor('个百分点', 1), 0.05, 'pp 一位小数容差 0.05');
    t.eq(absTolFor('元', 0), 0.5, '元零位小数容差 0.5');
  }

  // 2. EQUAL / CALIBER / UNSURE / ERROR 四档
  {
    t.eq(cmpNumeric(1741.44, 1741.44, 'amount', '亿元', 2), 'EQUAL', '完全相同 → EQUAL');
    // 亿元两位：容差 5e5，0.01 亿 = 1e6 > 容差，但相对差 5.7e-6 ≤ 0.5% → CALIBER
    t.eq(cmpNumeric(1741.44, 1741.45, 'amount', '亿元', 2), 'CALIBER', '差 0.01 亿 → CALIBER（不是 EQUAL）');
    t.eq(cmpNumeric(10000, 10050, 'amount', null, 0), 'CALIBER', '相对差 0.498% → CALIBER');
    t.eq(cmpNumeric(100, 100.7, 'amount', null, 0), 'UNSURE', '相对差 0.695% → UNSURE');
    t.eq(cmpNumeric(100, 100.9, 'amount', null, 0), 'UNSURE', '相对差 0.89% → UNSURE');
    t.eq(cmpNumeric(100, 102, 'amount', null, 0), 'ERROR', '相对差 2% → ERROR');
    t.eq(cmpNumeric(100, 120, 'amount', null, 0), 'ERROR', '相对差 16.7% → ERROR');
    t.eq(cmpNumeric(0, 0, 'amount', '元', 0), 'EQUAL', '0 与 0 → EQUAL');
    t.eq(cmpNumeric(0, 0.4, 'amount', '元', 0), 'EQUAL', '差 0.4 ≤ 0.5 → EQUAL');
    t.eq(cmpNumeric(0, 0.6, 'amount', '元', 0), 'ERROR', '0 基准下单边差 0.6 → ERROR（相对差 100%）');
  }

  // 3. 比率/增速：只看显示精度
  {
    t.eq(isRatioUnit('%'), true, '% 是比率');
    t.eq(isRatioUnit('亿元'), false, '亿元不是比率');
    t.eq(cmpNumeric(15.66, 15.66, 'growth', '%', 2), 'EQUAL', '增速相同 → EQUAL');
    t.eq(cmpNumeric(15.66, 15.67, 'growth', '%', 2), 'CALIBER', '差 0.01 个百分点 → CALIBER');
    t.eq(cmpNumeric(15.66, 16.0, 'growth', '%', 2), 'ERROR', '差 0.34 个百分点 → ERROR');
    t.eq(cmpNumeric(3.2, 3.2, 'ratio', '个百分点', 1), 'EQUAL', 'pp 相同 → EQUAL');
    t.eq(cmpNumeric(50.0, 50.1, 'ratio', '个百分点', 1), 'CALIBER', 'pp 差 0.1 / 50 → CALIBER');
    t.eq(cmpNumeric(3.2, 3.3, 'ratio', '个百分点', 1), 'ERROR', 'pp 差 0.1 / 3.2（3%）→ ERROR');
  }

  // 4. 中间量可复算
  {
    const d = cmpNumericDetailed(1741.44, 1741.45, 'amount', '亿元', 2);
    t.eq(d.result, 'CALIBER', 'detailed 给出 result');
    t.eq(d.absTol, 5e5, 'detailed 给出 absTol');
    t.ok(Math.abs(d.rel - 0.01 / 1741.45) < 1e-12, 'detailed 给出 rel');
    t.eq(d.storedDecimals, 2, 'detailed 回显精度');
    let threw = false;
    try {
      cmpNumeric('abc', 1);
    } catch {
      threw = true;
    }
    t.eq(threw, true, '非数字抛 BAD_NUMBER');
  }

  // 5. 量纲检测
  {
    t.eq(detectUnit(174100, 1741, '万元', '万元'), 'UNIT_ERROR', '差 100 倍且同标签 → UNIT_ERROR');
    t.eq(detectUnit(1741e4, 1741, '元', '元'), 'UNIT_ERROR', '差 1e4 → UNIT_ERROR');
    t.eq(detectUnit(1741, 1741, '亿元', '万元'), 'UNIT_MISMATCH', '标签不同 → UNIT_MISMATCH');
    t.eq(detectUnit(1, 0.5, '%', '%', 'growth'), 'LOW_BASE', '增速基数过小 → LOW_BASE');
    t.eq(detectUnit(1741, 1741, '亿元', '亿元'), null, '同值同标签无问题');
    t.eq(detectUnit(1741, 1740, '亿元', '亿元', 'growth'), null, '基数够大不报 LOW_BASE');
  }

  // 6. 直接比 atom.numeric
  {
    const a = { value: 1741.44, unit: '亿元', decimals: 2 };
    const b = { value: 1741.45, unit: '亿元', decimals: 2 };
    const r = compareNumeric(a, b);
    t.eq(r.result, 'CALIBER', 'atom 级比对 → CALIBER');
    t.eq(r.unitIssue, null, 'atom 级无单位问题');
    t.eq(r.kind, 'amount', '金额类');
    t.eq(r.decimals, 2, '取较小精度');
    const g1 = { value: 15.66, unit: '%', decimals: 2 };
    const g2 = { value: 16.0, unit: '%', decimals: 2 };
    const rg = compareNumeric(g1, g2);
    t.eq(rg.kind, 'growth', '比率单位自动按增速比对');
    t.eq(rg.result, 'ERROR', '增速差 0.34 → ERROR');
    const mismatch = compareNumeric({ value: 1741, unit: '亿元', decimals: 0 }, { value: 17414400, unit: '万元', decimals: 0 });
    t.eq(mismatch.unitIssue, 'UNIT_MISMATCH', '单位不同直接标出');
    let threw = false;
    try {
      compareNumeric(null, { value: 1 });
    } catch {
      threw = true;
    }
    t.eq(threw, true, '缺 numeric 抛 NOT_NUMERIC');
  }
}
