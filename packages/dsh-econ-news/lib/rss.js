/**
 * RSS 2.0 / Atom 解析（零依赖，正则版）。
 *
 * 为什么不用 xml 库：这些 feed 结构稳定，且我们不能给宿主装依赖。
 * 已知边界：不处理 CDATA 嵌套、不处理 XHTML 命名空间里的内层标签（只去标签取文本）。
 */

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(input) {
  return String(input == null ? '' : input)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-z]+);/gi, (whole, name) => (ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : whole));
}

export function stripMarkup(html) {
  return decodeEntities(String(html == null ? '' : html))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 取一个标签的原始内容（含 CDATA）。 */
function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

/** RSS <link> 与 Atom <link href> 都要认。 */
function linkOf(block) {
  const plain = tag(block, 'link');
  if (plain) {
    const direct = decodeEntities(plain).trim();
    if (direct && !/^<link/i.test(direct)) return direct;
  }
  const m = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
  if (m) return decodeEntities(m[1]).trim();
  const gu = block.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i);
  return gu ? decodeEntities(gu[1]).trim() : '';
}

function dateOf(block) {
  const raw = decodeEntities(tag(block, 'pubDate') || tag(block, 'updated') || tag(block, 'published') || tag(block, 'dc:date')).trim();
  if (!raw) return '';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return raw;
  return new Date(ts).toISOString();
}

function idOf(block, link) {
  const raw = decodeEntities(tag(block, 'guid') || tag(block, 'id')).trim();
  return raw || link;
}

/**
 * @returns {{ ok: boolean, title: string, items: Array<{title:string, link:string, summary:string, publishedAt:string, guid:string, author:string}>, error?: string }}
 */
export function parseFeed(xml) {
  const text = String(xml || '');
  if (!text.trim()) return { ok: false, title: '', items: [], error: 'EMPTY_BODY' };
  const isAtom = /<feed[\s>]/i.test(text);
  const feedTitle = decodeEntities(tag(text.slice(0, 4000), 'title')).trim();
  const blocks = isAtom
    ? [...text.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0])
    : [...text.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);

  const items = blocks.map((block) => {
    const link = linkOf(block);
    const summaryRaw = tag(block, 'description') || tag(block, 'summary') || tag(block, 'content:encoded') || tag(block, 'content');
    return {
      title: stripMarkup(tag(block, 'title')).replace(/\s+/g, ' ').trim(),
      link,
      summary: stripMarkup(summaryRaw).slice(0, 1200),
      publishedAt: dateOf(block),
      guid: idOf(block, link),
      author: stripMarkup(tag(block, 'dc:creator') || tag(block, 'author') || tag(block, 'name')).trim().slice(0, 80),
    };
  });

  return { ok: true, title: feedTitle, items: items.filter((it) => it.title || it.link) };
}

/** Atom 的 arXiv API 返回里，摘要常带 "Abstract: " 前缀与换行，这里清一下。 */
export function cleanSummary(summary) {
  return String(summary || '')
    .replace(/^Abstract:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
