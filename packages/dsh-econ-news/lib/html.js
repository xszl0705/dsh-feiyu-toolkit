/**
 * HTML → 文本 / 链接（零依赖）。
 *
 * 两种正文抽法：
 *   1. 站点选择器（正则片段，来自源表 `articlePatterns`）—— 命中且 ≥ minChars 就用它
 *   2. 最长块兜底 —— 去掉脚本/导航/页脚后，把 <p>/<div> 段落拼成候选块，取字数最多的那块
 * 抽不到 ≥ minChars 时返回空，调用方记 bodyStatus=failed，保留 HTML 原文不编造。
 */
import { decodeEntities, stripMarkup } from './rss.js';

const NOISE = ['script', 'style', 'noscript', 'iframe', 'svg', 'form', 'nav', 'header', 'footer', 'aside'];

export function textOf(html) {
  let out = String(html == null ? '' : html);
  for (const tag of NOISE) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'gi'), ' ');
  }
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  return stripMarkup(out).replace(/\n{3,}/g, '\n\n').trim();
}

/** 在 HTML 里按正则片段找正文容器，返回容器内文本。 */
export function byPatterns(html, patterns = []) {
  const source = String(html || '');
  for (const pattern of patterns) {
    let re;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      continue;
    }
    const m = source.match(re);
    if (!m) continue;
    const inner = m[1] !== undefined ? m[1] : m[0];
    const text = textOf(inner);
    if (text.length >= 120) return { text, how: 'selector' };
  }
  return null;
}

/** 最长文本块兜底：按块级标签切，累积相邻段落。 */
export function longestBlock(html) {
  const source = String(html || '');
  const chunks = [];
  const re = /<(p|div|section|article|li|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    const text = textOf(m[2]);
    if (text.length >= 60) chunks.push(text);
  }
  if (!chunks.length) return { text: '', how: 'empty' };

  let best = '';
  let run = '';
  for (const chunk of chunks) {
    run = run ? `${run}\n${chunk}` : chunk;
    if (run.length > best.length) best = run;
    if (run.length > 4000) {
      if (best.length >= 4000) break;
      run = chunk;
    }
  }
  return { text: best, how: 'longest-block' };
}

/**
 * @returns {{ text: string, how: 'selector'|'longest-block'|'empty', chars: number }}
 */
export function extractArticle(html, options = {}) {
  const minChars = Number(options.minChars) > 0 ? Number(options.minChars) : 200;
  const head = String(html || '').slice(0, 400);
  if (/Access Denied|Just a moment|Attention Required|Page not found|404 Not Found/i.test(head) && String(html).length < 3000) {
    return { text: '', how: 'empty', chars: 0, reason: 'BLOCKED_OR_404' };
  }
  const hit = byPatterns(html, options.patterns || []);
  if (hit && hit.text.length >= minChars) return { text: hit.text, how: hit.how, chars: hit.text.length };
  const block = longestBlock(html);
  if (block.text.length >= minChars) return { text: block.text, how: block.how, chars: block.text.length };
  return { text: block.text || '', how: 'empty', chars: (block.text || '').length, reason: 'EXTRACT_EMPTY' };
}

export function absoluteUrl(base, href) {
  const raw = String(href || '').trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return '';
  try {
    return new URL(raw, base).toString();
  } catch {
    return '';
  }
}

/**
 * 列表页取链接。include / exclude 是正则字符串。
 * @returns {Array<{url:string, text:string}>}
 */
export function listLinks(html, options = {}) {
  const source = String(html || '');
  const base = options.baseUrl || '';
  const include = options.include ? new RegExp(options.include, 'i') : null;
  const exclude = options.exclude ? new RegExp(options.exclude, 'i') : null;
  const minText = Number(options.minText) > 0 ? Number(options.minText) : 8;
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 30;
  const seen = new Set();
  const out = [];

  const re = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    const url = absoluteUrl(base, decodeEntities(m[1]));
    if (!url || seen.has(url)) continue;
    if (include && !include.test(url)) continue;
    if (exclude && exclude.test(url)) continue;
    const text = stripMarkup(m[2]).replace(/\s+/g, ' ').trim();
    if (text.length < minText) continue;
    seen.add(url);
    out.push({ url, text });
    if (out.length >= limit) break;
  }
  return out;
}

/** 列表页里常混进「更多」「首页」这类，抽完再按日期模式过滤一遍。 */
export function looksLikeArticle(url, datePattern = '/20\\d{6}|/t20\\d{6}|\\/20\\d\\d\\/\\d\\d\\/') {
  try {
    return new RegExp(datePattern).test(url);
  } catch {
    return true;
  }
}
