/**
 * 简报层：规则抽取版（必成）。LLM 成文是可选叠加，P1 接。
 *
 * 原则：简报里的每一句都必须能回到 items.jsonl 里的某条（带 id 与原文路径），
 * 抽不到就写「本期无」，不编。
 */
import { ZONE_LABELS, ZONE_ORDER } from './sources.js';

const STATUS_LABEL = { full: '全文', summary: '摘要', withheld: '被拦', failed: '失败' };

const CN_NUM = /(\d+(?:\.\d+)?)\s*(%|％|个百分点|万亿|亿元|亿|bp|基点|万美元|亿美元)/g;
const KEY_TERMS = ['CPI', 'PPI', 'PMI', 'GDP', 'M2', 'LPR', 'MLF', '社融', '赤字', '关税', '降息', '加息', '通胀', '就业', '非农', '国债', '收益率'];

export function extractNumbers(text) {
  const out = [];
  const source = String(text || '');
  let m;
  CN_NUM.lastIndex = 0;
  while ((m = CN_NUM.exec(source)) !== null && out.length < 6) {
    out.push(`${m[1]}${m[2] === '％' ? '%' : m[2]}`);
  }
  return out;
}

export function hitTerms(text) {
  const source = String(text || '').toUpperCase();
  return KEY_TERMS.filter((term) => source.includes(term.toUpperCase())).slice(0, 4);
}

function firstSentence(text, max = 120) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const cut = clean.match(/^.{0,200}?[。！？.!?；;]/);
  const sentence = cut ? cut[0] : clean;
  return sentence.length > max ? sentence.slice(0, max) + '…' : sentence;
}

function bodyTag(item) {
  const status = STATUS_LABEL[item.bodyStatus] || item.bodyStatus || '未知';
  if (item.bodyChars) return `${status} ${item.bodyChars} 字`;
  return status;
}

function norm(text) {
  return String(text || '')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    .toLowerCase();
}

/** 摘要与标题重复时不重复显示（Fed/ECB 的 RSS description 就是标题）。 */
function summaryLine(item) {
  const title = norm(item.title).slice(0, 20);
  const summary = norm(item.summary || item.bodyText || '');
  if (!summary) return '';
  if (title && summary.startsWith(title)) return '';
  return firstSentence(item.summary || item.bodyText || '');
}

/**
 * 每区选条目：同源最多 2 条，round-robin，避免一个源把整区占满（ECB 讲话曾吃掉整个学术区）。
 * 优先 full 的条目。
 */
function pickForZone(items, max = 4) {
  const filtered = dedupe(items);
  const bySource = new Map();
  for (const item of filtered) {
    const list = bySource.get(item.source) || [];
    if (list.length < 2) {
      list.push(item);
      bySource.set(item.source, list);
    }
  }
  const pools = [...bySource.values()].map((list) =>
    [...list].sort((a, b) => (b.bodyStatus === 'full' ? 1 : 0) - (a.bodyStatus === 'full' ? 1 : 0)),
  );
  const out = [];
  for (let round = 0; round < 2; round += 1) {
    for (const pool of pools) {
      if (out.length >= max) return out;
      if (pool[round]) out.push(pool[round]);
    }
  }
  return out;
}

function oneLine(item) {
  const bits = [`**${item.title || '（无标题）'}**`, `〔${item.sourceLabel || item.source} · ${bodyTag(item)}`];
  if (item.channel) bits.push(` · ${item.channel}`);
  const head = bits.join('') + '〕';
  const summary = summaryLine(item);
  const numbers = extractNumbers(`${item.title} ${item.summary || ''}`);
  const terms = hitTerms(`${item.title} ${item.summary || ''}`);
  const tail = [];
  if (numbers.length) tail.push(`关键数字：${numbers.slice(0, 3).join(' / ')}`);
  if (terms.length) tail.push(`关键词：${terms.join(' ')}`);
  return [head, summary ? `  ${summary}` : '', tail.length ? `  ${tail.join('｜')}` : '', `  原文：text/${item.id}.md · id ${item.id}`]
    .filter(Boolean)
    .join('\n');
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = String(item.title || '')
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
      .slice(0, 24)
      .toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * @param {{ date:string, items:Array, manifest:object, summaryMode?:string }} input
 * @returns {string} markdown
 */
export function buildBrief(input) {
  const { date, items, manifest } = input;
  const totals = manifest?.totals || {};
  const gaps = manifest?.gaps || [];
  const lines = [];

  lines.push(`# 经济简报 · ${date}`);
  lines.push('');
  lines.push(
    `> 采集 ${totals.items ?? items.length} 条 ｜ 全文 ${totals.full ?? 0} ｜ 摘要 ${totals.summary ?? 0} ｜ 被拦 ${totals.withheld ?? 0} ｜ 失败 ${totals.failed ?? 0} ｜ 缺口 ${gaps.length} ｜ summaryMode: ${input.summaryMode || 'extractive'}`,
  );
  lines.push('');

  for (const zone of ZONE_ORDER) {
    const zoneItems = pickForZone(items.filter((item) => item.zone === zone), 4);
    lines.push(`## ${ZONE_LABELS[zone] || zone}`);
    lines.push('');
    if (!zoneItems.length) {
      lines.push('- 本期无可入库条目（原因见「本期缺口」）。');
      lines.push('');
      continue;
    }
    for (const item of zoneItems) {
      lines.push(oneLine(item));
      lines.push('');
    }
  }

  lines.push('## 本期缺口与替代');
  lines.push('');
  if (!gaps.length) {
    lines.push('- 无。所有启用源均返回数据。');
  } else {
    for (const gap of gaps) lines.push(`- ${gap}`);
  }
  lines.push('');
  lines.push('---');
  lines.push(`生成时间 ${new Date().toISOString()} ｜ 源 ${manifest?.sourceCount ?? 0} 个 ｜ 耗时 ${Math.round((manifest?.durationMs || 0) / 1000)}s`);
  lines.push('数据仅用于个人研学，原文版权归各来源所有。');
  return lines.join('\n');
}

/** 溯源表：简报里提到的每条 → id / url / 原文文件。 */
export function buildSourcesTable(date, items) {
  const lines = ['# 溯源表 · ' + date, '', '| id | 源 | 区 | 标题 | 状态 | 字数 | 原文 | 链接 |', '|---|---|---|---|---|---|---|---|'];
  for (const item of items) {
    const title = String(item.title || '').replace(/\|/g, '/').slice(0, 60);
    lines.push(
      `| ${item.id} | ${item.source} | ${item.zone} | ${title} | ${item.bodyStatus} | ${item.bodyChars || 0} | text/${item.id}.md | ${item.url || ''} |`,
    );
  }
  return lines.join('\n');
}
