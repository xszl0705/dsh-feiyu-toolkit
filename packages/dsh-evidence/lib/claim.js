/**
 * lib/claim.js — 声明分解成原子（atoms）
 *
 * 规格：docs/tech-spec-evidence.md §4.3、docs/framework-v0.2.md §4.1、docs/handoff/impl-dsh-evidence.md §3
 * 硬约束：
 *   1. 每个 atom **必须带 span**（原文偏移），拿不到 span 就丢弃——这是防编造的第一道闸
 *   2. `type ∈ fact | numeric | date | entity_relation | quote`；观点 / 预测 / 规范 / 传闻进 `outOfScope`
 *   3. `numeric` 缺 `unit` 或 `basis` **不许静默丢**，进 `unverified`
 *   4. 只做规则，不调模型：同一段文本两次分解必须完全一致（可复算）
 */
import { createHash } from 'node:crypto';
import { segmentCJK, nowISO } from './db.js';
import { UNIT_SCALE } from './numeric.js';

/** 单位刻度（唯一来源是 `lib/numeric.js`，这里保留旧导出名以免调用方改 import） */
export { UNIT_SCALE };

/** 长的在前，避免「亿元」被「元」先吃掉 */
const UNITS = ['个百分点', '亿元', '万元', '千元', '元', '%', 'pp', '倍', '家', '人', '吨', '股', '手', '亿', '万'];

const UGC_MARKERS = /雪球|股吧|微博|知乎|公众号|网友|传闻|小道消息|据说/;
const FORECAST_MARKERS = /预计|预期|有望|或将|将会|未来|明年|后年|潜在|估计|可能达到|大概率/;
const OPINION_MARKERS = /我认为|笔者|觉得|看好|看空|值得|不难看出|显然|明显偏|个人判断/;
const NORM_MARKERS = /应该|必须|应当|建议|严禁|不得|需要加强|理应/;

const QUOTE_MARKERS = /[「」“”"《》]/;
const ATTRIBUTION = /称|表示|指出|报道|声明|公告/;
const RELATION_MARKERS = /收购|并购|增持|减持|控股|子公司|担任|董事长|总经理|股东|参股|设立|入股|剥离/;
const DATE_MARKERS = /(\d{4}\s*年(度)?|20\d{2}[-/]\d{1,2}([-/]\d{1,2})?|第[一二三四1-4]季度|Q[1-4]|上半年|下半年|全年)/;
const BASIS_MARKERS = /归母净利润|营业收入|营收|净利润|毛利率|净利率|市占率|销量|产量|分红|现金流/;

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

export function sha256Hex(input) {
  return createHash('sha256').update(String(input)).digest('hex');
}

/** 归一口径只用于算哈希：合并空白、全角数字转半角。**不改原文，span 必须落在原串上** */
export function normalizeForHash(text) {
  return String(text ?? '')
    .replace(/[\uff10-\uff19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    .trim();
}

export function normHash(text) {
  return sha256Hex(normalizeForHash(text));
}

export function claimIdFor(text, asOf) {
  return 'cl_' + sha256Hex(normHash(text) + '|' + String(asOf ?? '')).slice(0, 16);
}

/** 按句号/分号/换行切句，保留每一句在原文里的偏移 */
export function splitSentences(text) {
  const src = String(text ?? '');
  const out = [];
  const re = /[^。！？!?；;\n]+/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const seg = raw.trim();
    if (!seg) continue;
    out.push({ text: seg, start: m.index + lead, end: m.index + lead + seg.length });
  }
  return out;
}

function outOfScopeReason(sentence) {
  if (UGC_MARKERS.test(sentence)) return 'UGC_SOURCE';
  if (FORECAST_MARKERS.test(sentence)) return 'FORECAST';
  if (OPINION_MARKERS.test(sentence)) return 'OPINION';
  if (NORM_MARKERS.test(sentence)) return 'NORM';
  return null;
}

function periodOf(windows) {
  const m = /(\d{4})\s*年(?:度)?/.exec(windows);
  if (m) return m[1];
  const ym = /(20\d{2})[-/](\d{1,2})/.exec(windows);
  if (ym) return `${ym[1]}-${String(ym[2]).padStart(2, '0')}`;
  const q = /第?([一二三四1-4])季度|Q([1-4])/.exec(windows);
  if (q) return 'Q' + ({ 一: '1', 二: '2', 三: '3', 四: '4' }[q[1]] ?? q[1] ?? q[2]);
  if (/同比/.test(windows)) return '同比';
  if (/环比/.test(windows)) return '环比';
  if (/上半年/.test(windows)) return 'H1';
  if (/下半年/.test(windows)) return 'H2';
  if (/全年/.test(windows)) return 'FY';
  return null;
}

function basisOf(window) {
  const m = BASIS_MARKERS.exec(String(window ?? ''));
  return m ? m[0] : null;
}

function looksLikeIdentifier(raw, unit) {
  if (unit) return false;
  if (raw.length >= 5) return true; // 600519 / 00700 之类代码
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) && n >= 1900 && n <= 2100 && !raw.includes('.'); // 裸年份
}

/**
 * 从一个句子抽 numeric atoms（一句三数字 → 三个 atom，各自 span 指向数字本身）
 * @returns {{atoms: Array, unverified: Array}}
 */
export function numericAtomsOf(sentence, sentenceStart) {
  const atoms = [];
  const unverified = [];
  const src = sentence.text;
  NUMBER_RE.lastIndex = 0;
  let m;
  while ((m = NUMBER_RE.exec(src))) {
    const raw = m[0];
    const after = src.slice(m.index + raw.length);
    // 日期成分（2024年 / 2026-11 / 3日）不算数字断言
    if (/^\s*(年|月|日|年度)/.test(after)) continue;
    let unit = null;
    for (const candidate of UNITS) {
      if (after.startsWith(candidate)) {
        unit = candidate;
        break;
      }
    }
    if (looksLikeIdentifier(raw.replace(/[,\s]/g, ''), unit)) continue;
    const windowStart = Math.max(0, m.index - 12);
    const windows = src.slice(windowStart, m.index + raw.length + 12);
    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    const decimals = raw.includes('.') ? raw.split('.')[1].length : 0;
    const spanStart = sentenceStart + m.index;
    const spanEnd = spanStart + raw.length + (unit ? unit.length : 0);
    const isRatio = unit === '%' || unit === '个百分点' || unit === 'pp';
    const numeric = {
      value,
      unit,
      scale: unit && UNIT_SCALE[unit] ? UNIT_SCALE[unit] : 1,
      period: periodOf(windows),
      // 比率/增速的口径不能靠邻近词猜（旁边常是「净利润」这类被描述对象）：P0 一律留空 → 进 unverified
      basis: isRatio ? null : basisOf(windows),
      decimals,
      raw: raw + (unit ?? ''),
    };
    const atom = {
      id: 'at_' + sha256Hex(src + '|' + m.index).slice(0, 12),
      text: src.slice(m.index, spanEnd - sentenceStart),
      span: [spanStart, spanEnd],
      type: 'numeric',
      numeric,
    };
    atoms.push(atom);
    if (!numeric.unit) unverified.push({ atomId: atom.id, reason: 'NO_UNIT' });
    if (!numeric.basis) unverified.push({ atomId: atom.id, reason: 'NO_BASIS' });
  }
  return { atoms, unverified };
}

/**
 * @param {string} text
 * @param {{asOf?: string}} [options]
 * @returns {{
 *   atoms: Array<{id,text,span:[number,number],type,numeric?}>,
 *   outOfScope: Array<{text,span:[number,number],reason}>,
 *   unverified: Array<{atomId:string, reason:string}>
 * }}
 */
export function extractAtoms(text, options = {}) {
  const src = String(text ?? '');
  const sentences = splitSentences(src);
  const atoms = [];
  const outOfScope = [];
  const unverified = [];

  for (const sentence of sentences) {
    const reason = outOfScopeReason(sentence.text);
    if (reason) {
      outOfScope.push({ text: sentence.text, span: [sentence.start, sentence.end], reason });
      continue;
    }

    const numeric = numericAtomsOf(sentence, sentence.start);
    // 全是无单位数字、且这句本身就是日期句（2026-11-12 这类）→ 当 date atom，不当数字断言
    const allUnitless = numeric.atoms.length > 0 && numeric.atoms.every((a) => !a.numeric.unit);
    if (numeric.atoms.length && !(allUnitless && DATE_MARKERS.test(sentence.text))) {
      atoms.push(...numeric.atoms);
      unverified.push(...numeric.unverified);
      continue;
    }

    let type = 'fact';
    if (QUOTE_MARKERS.test(sentence.text) && ATTRIBUTION.test(sentence.text)) type = 'quote';
    else if (DATE_MARKERS.test(sentence.text)) type = 'date';
    else if (RELATION_MARKERS.test(sentence.text)) type = 'entity_relation';

    atoms.push({
      id: 'at_' + sha256Hex(sentence.text + '|' + sentence.start).slice(0, 12),
      text: sentence.text,
      span: [sentence.start, sentence.end],
      type,
    });
  }

  // 兜底：span 落不到原文上的 atom 一律丢弃（不是报错）
  const keptAtoms = atoms.filter((a) => {
    const [s, e] = a.span;
    return Number.isInteger(s) && Number.isInteger(e) && e > s && e <= src.length && src.slice(s, e).trim().length > 0;
  });
  const keptIds = new Set(keptAtoms.map((a) => a.id));
  atoms.length = 0;
  atoms.push(...keptAtoms);

  return {
    atoms,
    outOfScope,
    unverified: unverified.filter((u) => keptIds.has(u.atomId)),
  };
}

/**
 * 落库：claims + claim_atoms。同一 (claim, atom) 幂等——重复调用只补缺，不重复插。
 * @returns {{claimId:string, inserted:boolean, atomCount:number}}
 */
export function saveClaim({ db, text, asOf, atoms }) {
  const claimId = claimIdFor(text, asOf);
  const existing = db.prepare('SELECT id FROM claims WHERE id = ?').get(claimId);
  if (!existing) {
    db.prepare('INSERT INTO claims (id, text, norm_hash, as_of, created_at) VALUES (?,?,?,?,?)').run(
      claimId,
      String(text ?? ''),
      normHash(text),
      String(asOf ?? ''),
      nowISO(),
    );
  }
  const insertAtom = db.prepare(
    'INSERT OR IGNORE INTO claim_atoms (id, claim_id, text, span_start, span_end, type, numeric) VALUES (?,?,?,?,?,?,?)',
  );
  let count = 0;
  for (const atom of atoms) {
    const r = insertAtom.run(
      atom.id,
      claimId,
      atom.text,
      atom.span[0],
      atom.span[1],
      atom.type,
      atom.numeric ? JSON.stringify(atom.numeric) : null,
    );
    count += Number(r?.changes ?? 0);
  }
  return { claimId, inserted: !existing, atomCount: count };
}

/** 读回某条 claim 的 atoms（按 span 排序） */
export function loadClaim(db, claimId) {
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(String(claimId));
  if (!claim) return null;
  const atoms = db
    .prepare('SELECT * FROM claim_atoms WHERE claim_id = ? ORDER BY span_start')
    .all(claimId)
    .map((row) => ({
      id: row.id,
      text: row.text,
      span: [Number(row.span_start), Number(row.span_end)],
      type: row.type,
      numeric: row.numeric ? JSON.parse(row.numeric) : undefined,
    }));
  return { claim, atoms, textSeg: claim.text ? segmentCJK(claim.text) : '' };
}
