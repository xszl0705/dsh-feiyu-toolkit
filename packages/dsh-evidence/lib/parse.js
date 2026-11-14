/**
 * lib/parse.js — 抽取（article / table / json）
 *
 * 规格：docs/tech-spec-evidence.md §4.2、docs/handoff/impl-dsh-evidence.md §3
 * 约束：
 *   1. 无依赖，正则 + 行状态机，**不做 DOM 解析**（没有 jsdom）
 *   2. `text` 是 text_raw 的来源，`textSeg` 必须走写读同一份 `segmentCJK`
 *   3. 每个 span 都必须在返回的 `text` 上可 `slice` 出非空片段（quote 定位靠它）
 */
import { segmentCJK } from './db.js';

/** 行级最小长度：短于此的行视作导航/按钮/角标噪声 */
export const MIN_LINE_CHARS = 8;
/** 正文短于此长度标 SHORT_TEXT（不是失败，只是提示质量可疑） */
export const SHORT_TEXT_CHARS = 60;

const ENTITIES = {
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  times: '×',
  divide: '÷',
  yen: '¥',
  deg: '°',
  plusmn: '±',
};

function codePointToString(cp, raw) {
  if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff) return raw;
  try {
    return String.fromCodePoint(cp);
  } catch {
    return raw;
  }
}

export function decodeEntities(input) {
  return String(input ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (raw, body) => {
    const key = body.toLowerCase();
    if (key.startsWith('#x')) return codePointToString(parseInt(key.slice(2), 16), raw);
    if (key.startsWith('#')) return codePointToString(parseInt(key.slice(1), 10), raw);
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : raw;
  });
}

/** 去标签、解实体、压空白 —— 只用于「这一段说了什么」，不用于定位 */
export function stripTags(input) {
  return decodeEntities(String(input ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 去噪声块：注释、脚本、样式、模板、内嵌图、head、导航、页脚、侧栏 */
export function removeNoise(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}

/** 把 HTML 拍平成行：块级闭合标签与 <br> 当换行，行内标签当空格 */
export function toLines(html) {
  const flattened = String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|section|article|tr|td|th|dd|dt|figcaption)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(flattened)
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u00a0\u3000]+/g, ' ').trim());
}

/** 选正文容器：article → main → body → 整段 */
export function pickContainer(html) {
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  if (article && stripTags(article[1]).length >= 80) return { html: article[1], tag: 'article' };
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  if (main && stripTags(main[1]).length >= 80) return { html: main[1], tag: 'main' };
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  if (body) return { html: body[1], tag: 'body' };
  return { html, tag: 'fragment' };
}

/** 行数组 → 正文 + span（span 是最终 text 上的偏移，可直接 slice） */
export function joinLines(lines) {
  const kept = lines.filter((line) => line.length >= MIN_LINE_CHARS);
  const text = kept.join('\n');
  const spans = [];
  let cursor = 0;
  for (const line of kept) {
    spans.push({ start: cursor, end: cursor + line.length });
    cursor += line.length + 1; // 换行符占 1
  }
  return { text, spans };
}

export function extractTables(html) {
  const tables = [];
  const flags = new Set();
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = tableRe.exec(html))) {
    const block = m[0];
    const inner = m[1];
    if (/rowspan|colspan/i.test(block)) flags.add('TABLE_MERGED_CELLS');
    if (/<table\b/i.test(inner)) flags.add('TABLE_NESTED');
    const rows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(inner))) {
      const cells = [];
      const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) cells.push(stripTags(cm[1]));
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) continue;
    if (new Set(rows.map((r) => r.length)).size > 1) flags.add('TABLE_LOSSY');
    const caption = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(inner);
    const label = caption ? stripTags(caption[1]) : '';
    tables.push(label ? { rows, caption: label } : { rows });
  }
  return { tables, flags: [...flags] };
}

export function parseJsonText(input) {
  try {
    return { json: JSON.parse(String(input)), ok: true };
  } catch {
    return { json: undefined, ok: false };
  }
}

/**
 * @param {string} input HTML / JSON 文本
 * @param {{target?: 'article'|'table'|'json'}} [options]
 * @returns {{text:string, textSeg:string, tables:Array, json:unknown, spans:Array<{start:number,end:number}>, qualityFlags:string[]}}
 */
export function extract(input, options = {}) {
  const target = options.target || 'article';
  const raw = String(input ?? '');
  const trimmed = raw.trim();
  if (!trimmed) {
    return { text: '', textSeg: '', tables: [], json: undefined, spans: [], qualityFlags: ['EMPTY'] };
  }

  const body = removeNoise(raw);
  const { tables, flags: tableFlags } = extractTables(body);
  const flags = [...tableFlags];

  const looksJson = /^[[{]/.test(trimmed);
  if (target === 'json' || looksJson) {
    const parsed = parseJsonText(trimmed);
    if (parsed.ok) {
      const text = typeof parsed.json === 'string' ? parsed.json : JSON.stringify(parsed.json);
      return {
        text,
        textSeg: segmentCJK(text),
        tables,
        json: parsed.json,
        spans: text ? [{ start: 0, end: text.length }] : [],
        qualityFlags: flags,
      };
    }
    if (target === 'json') flags.push('JSON_PARSE_FAILED');
  }

  const container = pickContainer(body);
  const joined = joinLines(toLines(container.html));
  let { text, spans } = joined;

  if (!text) {
    // 没有够长的行：退回「所有非空行」，并如实标 SHORT_TEXT 之外的空态
    const fallback = toLines(container.html).filter(Boolean);
    text = fallback.join('\n');
    spans = [];
    let cursor = 0;
    for (const line of fallback) {
      spans.push({ start: cursor, end: cursor + line.length });
      cursor += line.length + 1;
    }
  }

  if (!text) flags.push('EMPTY');
  else if (text.length < SHORT_TEXT_CHARS) flags.push('SHORT_TEXT');
  if (target === 'table' && tables.length === 0) flags.push('NO_TABLE');
  if (container.tag === 'fragment') flags.push('NO_BODY_TAG');

  return {
    text,
    textSeg: segmentCJK(text),
    tables,
    json: undefined,
    spans,
    qualityFlags: [...new Set(flags)],
  };
}
