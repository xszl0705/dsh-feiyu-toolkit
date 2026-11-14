/**
 * tests/cases/claim.test.mjs — 声明分解（原子 + span + 数字口径）
 *
 * 断言重点：
 *   1. 一句活三个数字 → 三个 numeric atom，span 各自指向数字本身
 *   2. 年份 / 日期成分不算数字断言；纯日期句当 date atom
 *   3. 观点 / 预测 / 规范 / 传闻 → outOfScope，且不产生 atom
 *   4. 缺 unit 或 basis → 进 unverified，不静默丢
 *   5. 每个 span 都能在原文上 slice 出 atom.text
 *   6. 落库幂等；claimId 只由「归一文本 + as_of」决定
 */
import path from 'node:path'
import { openDatabase, segmentCJK } from '../../lib/db.js';
import { claimIdFor, extractAtoms, loadClaim, saveClaim, splitSentences } from '../../lib/claim.js';
import { createEvidenceTools } from '../../lib/tools.js';

const TEXT = '公司2024年实现营业收入1741.44亿元，同比增长15.66%，归母净利润862.28亿元。';
const AS_OF = '2026-11-12T00:00:00Z';

export const name = 'claim';

export async function run(t) {
  // 1. 三数字 → 三个 numeric atom
  {
    const r = extractAtoms(TEXT, { asOf: AS_OF });
    t.eq(r.atoms.length, 3, '一句三数字拆成 3 个 atom');
    t.eq(r.atoms.map((a) => a.type), ['numeric', 'numeric', 'numeric'], '类型都是 numeric');
    t.eq(r.atoms.map((a) => a.numeric.unit), ['亿元', '%', '亿元'], '单位识别正确');
    t.eq(r.atoms[0].numeric.value, 1741.44, '数值去掉千分位');
    t.eq(r.atoms[0].numeric.scale, 1e8, '亿元刻度 1e8');
    t.eq(r.atoms[0].numeric.period, '2024', '期间取到 2024');
    t.eq(r.atoms[0].numeric.basis, '营业收入', '口径取到营业收入');
    t.eq(r.atoms[1].numeric.period, '同比', '增速的期间是同比');
    t.eq(r.atoms[2].numeric.basis, '归母净利润', '口径取到归母净利润');
    t.eq(r.atoms.map((a) => a.text), ['1741.44亿元', '15.66%', '862.28亿元'], 'atom.text 是数字+单位');
  }

  // 2. span 必须落在原文上，且能 slice 出 atom.text
  {
    const r = extractAtoms(TEXT, { asOf: AS_OF });
    const slices = r.atoms.map((a) => TEXT.slice(a.span[0], a.span[1]));
    t.eq(slices, r.atoms.map((a) => a.text), 'span 切片等于 atom.text');
    t.eq(r.atoms.every((a) => a.span[1] > a.span[0]), true, 'span 非空');
    const ordered = r.atoms.every((a, i) => i === 0 || a.span[0] > r.atoms[i - 1].span[0]);
    t.eq(ordered, true, 'atom 按出现顺序排列');
  }

  // 3. 缺 unit / 缺 basis 进 unverified
  {
    const r = extractAtoms(TEXT, { asOf: AS_OF });
    const noBasis = r.unverified.filter((u) => u.reason === 'NO_BASIS').map((u) => u.atomId);
    t.eq(noBasis.includes(r.atoms[1].id), true, '增速 atom 缺口径 → NO_BASIS');
    const bare = extractAtoms('报告期内公司营业收入为1741。', { asOf: AS_OF });
    t.eq(bare.atoms[0].numeric.unit, null, '无单位时 unit 为 null');
    t.eq(bare.unverified.some((u) => u.reason === 'NO_UNIT'), true, '无单位 → NO_UNIT');
    t.eq(bare.atoms.length >= 1, true, '缺单位不丢弃 atom');
  }

  // 4. 观点 / 预测 / 规范 / 传闻 → outOfScope，不产生 atom
  const outOfScopeCases = [
    ['我认为这家公司值得长期持有。', 'OPINION'],
    ['预计2025年营业收入增长20%。', 'FORECAST'],
    ['公司应当加强内部管理。', 'NORM'],
    ['雪球上有网友说明年翻倍。', 'UGC_SOURCE'],
  ];
  for (const [text, reason] of outOfScopeCases) {
    const r = extractAtoms(text, { asOf: AS_OF });
    t.eq(r.outOfScope.length, 1, `「${text}」标 outOfScope`);
    t.eq(r.outOfScope[0].reason, reason, `「${text}」原因=${reason}`);
    t.eq(r.atoms.length, 0, `「${text}」不产生 atom`);
  }

  // 5. 引述 / 日期 / 关系 / 普通事实
  {
    const quote = extractAtoms('公司公告称「将择机回购股份」。', { asOf: AS_OF });
    t.eq(quote.atoms[0]?.type, 'quote', '引述句 → quote');
    const date = extractAtoms('公司于2026-11-12发布公告。', { asOf: AS_OF });
    t.eq(date.atoms.length, 1, '日期句只留一个 atom');
    t.eq(date.atoms[0].type, 'date', '日期句 → date');
    const rel = extractAtoms('公司收购贵州某酒厂，成为其控股股东。', { asOf: AS_OF });
    t.eq(rel.atoms[0]?.type, 'entity_relation', '关系句 → entity_relation');
    const fact = extractAtoms('公司在上海设有研究中心。', { asOf: AS_OF });
    t.eq(fact.atoms[0]?.type, 'fact', '普通陈述 → fact');
  }

  // 6. 切句保留偏移
  {
    const src = '第一句足够长的内容。第二句也不短的内容！';
    const s = splitSentences(src);
    t.eq(s.length, 2, '切出两句');
    t.eq(src.slice(s[1].start, s[1].end), '第二句也不短的内容', '第二句偏移准确');
    t.eq(extractAtoms('   。 ', { asOf: AS_OF }).atoms.length, 0, '无内容不出 atom');
  }

  // 7. claimId 由「归一文本 + as_of」决定
  {
    t.eq(claimIdFor(TEXT, AS_OF), claimIdFor(`  ${TEXT}  `, AS_OF), '空白不影响 claimId');
    t.eq(claimIdFor(TEXT, AS_OF) === claimIdFor(TEXT, '2026-11-13T00:00:00Z'), false, 'as_of 不同则 claimId 不同');
    t.ok(/^cl_[0-9a-f]{16}$/.test(claimIdFor(TEXT, AS_OF)), 'claimId 形状正确');
  }

  // 8. 落库幂等 + 读回
  {
    const db = openDatabase(':memory:');
    const parsed = extractAtoms(TEXT, { asOf: AS_OF });
    const first = saveClaim({ db, text: TEXT, asOf: AS_OF, atoms: parsed.atoms });
    t.eq(first.inserted, true, '首次落库');
    t.eq(first.atomCount, 3, '插入 3 个 atom');
    const again = saveClaim({ db, text: TEXT, asOf: AS_OF, atoms: parsed.atoms });
    t.eq(again.inserted, false, '二次调用不重复建 claim');
    t.eq(again.atomCount, 0, '二次调用不重复插 atom');
    t.eq(db.prepare('SELECT COUNT(*) AS n FROM claims').get().n, 1, 'claims 只有一条');
    t.eq(db.prepare('SELECT COUNT(*) AS n FROM claim_atoms').get().n, 3, 'claim_atoms 三条');

    const loaded = loadClaim(db, first.claimId);
    t.eq(loaded.atoms.length, 3, '读回三个 atom');
    t.eq(loaded.atoms[0].id, parsed.atoms[0].id, '读回 id 一致');
    t.eq(loaded.atoms[0].numeric.value, 1741.44, 'numeric 以 JSON 读回');
    t.eq(loaded.textSeg, segmentCJK(TEXT), 'textSeg 走同一份 segmentCJK');
    t.eq(loadClaim(db, 'cl_0000000000000000'), null, '未知 claim 返回 null');
    db.close();
  }

  // 9. 工具层 ev_claim
  {
    const db = openDatabase(':memory:');
    const defs = createEvidenceTools({ dataDir: path.join(process.cwd(), '_tmp', 'evidence-claim-test'), dbProvider: () => db });
    const evClaim = defs.find((d) => d.name === 'ev_claim');
    t.eq(defs.map((d) => d.name), ['ev_fetch', 'ev_extract', 'ev_claim', 'ev_search', 'ev_verify'], '工具清单含 ev_claim');
    t.eq(evClaim.parameters.required, ['text'], 'ev_claim 必填 text');
    const r = await evClaim.execute({ text: TEXT, as_of: AS_OF });
    t.eq(r.status, 'OK', 'ev_claim 成功');
    t.ok(/^cl_[0-9a-f]{16}$/.test(r.claimId || ''), '返回 claimId');
    t.eq(r.atomCount, 3, '返回 3 个 atom');
    t.eq(r.inserted, true, '首次 inserted=true');
    const again = await evClaim.execute({ text: TEXT, as_of: AS_OF });
    t.eq(again.inserted, false, '重复提交 inserted=false');
    t.eq((await evClaim.execute({})).status, 'BAD_ARGUMENT', '缺 text 报 BAD_ARGUMENT');
    t.eq((await evClaim.execute({ text: '我认为值得长期持有。' })).outOfScopeCount, 1, '观点只进 outOfScope');
    db.close();
  }
}
