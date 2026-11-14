/**
 * 卡 HTML → 纯文本 / Markdown。
 *
 * 为什么需要：角色卡（酒馆格式）的作者习惯把状态面板写成 HTML——`<details><summary>`
 * 加一堆 `<div style="background-color:#1A1A1A;…">`。酒馆前端会渲染，**DSH 不渲染 HTML**
 * （前端只用 micromark 解析 CommonMark，没有 rehype-raw），于是模型把模板原样吐出来，
 * 用户看到一屏源码。
 *
 * 做法两层，本模块负责"源头"那一层：卡加载时就把这些字段折成 Markdown 纯文本，
 * 模型读到的模板本身已经是干净的列表，自然不会照抄标签。
 *
 * 设计约束：
 *   1. **只认得常见的排版标签**——遇到 `<` 当比较符号用的普通文本（`a < b`）原样返回。
 *   2. **不丢内容**：`<details>` 里的正文保留，只去掉折叠外壳。
 *   3. **信息不降级**：`<li>` → `- `，`<strong>` → `**`，`<summary>` → 加粗标题行，
 *      让状态面板折完之后仍然是一条条可读的条目。
 *   4. 幂等：折过一次再折，结果不变。
 */

const KNOWN = /<\/?(details|summary|div|span|p|ul|ol|li|br|hr|strong|b|em|i|u|s|code|pre|table|thead|tbody|tr|td|th|h[1-6])\b/i

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&middot;': '·',
}

function decodeEntities(input) {
  return String(input)
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39|apos|mdash|ndash|hellip|middot);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = Number(code)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const n = parseInt(hex, 16)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''
    })
}

/**
 * 把一段可能带 HTML 的文本折成 Markdown 纯文本。
 * @param {unknown} value
 * @returns {string}
 */
export function htmlToText(value) {
  const raw = String(value ?? '')
  if (!raw) return ''
  // 没有可识别的排版标签 ⇒ 只是普通文本（可能含 `<` 比较符），原样返回
  if (!KNOWN.test(raw)) return raw

  let out = raw
    // 实体先解，避免 `&lt;div&gt;` 这类被当成标签处理
    .replace(/<img\b[^>]*\/?>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    // 折叠外壳：summary 变成加粗小标题，正文保留
    .replace(/<\/summary>/gi, '**\n')
    .replace(/<summary[^>]*>/gi, '**')
    // 列表项
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    // 强调
    .replace(/<(strong|b)\b[^>]*>/gi, '**')
    .replace(/<\/(strong|b)>/gi, '**')
    .replace(/<(em|i)\b[^>]*>/gi, '*')
    .replace(/<\/(em|i)>/gi, '*')
    .replace(/<code[^>]*>/gi, '`')
    .replace(/<\/code>/gi, '`')
    // 块级：换行
    .replace(/<\/(p|div|section|article|details|ul|ol|table|thead|tbody|tr|h[1-6])>/gi, '\n')
    .replace(/<(p|div|section|article|details|ul|ol|table|thead|tbody|tr|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<t[dh]\b[^>]*>/gi, '')
    // 剩余标签一律剥掉
    .replace(/<\/?[a-z][^>]*>/gi, '')
    // 被 clip() 截断的残缺开标签（`<p style="margi…` 这种，没有闭合 `>`）：
    // 只清「已知块级/行内标签名 + 到行尾无 `>`」，`a < b` 这类比较符不受影响。
    .replace(/<\/?(?:details|summary|div|span|p|ul|ol|li|strong|b|em|i|code|pre|table|tr|td|th|h[1-6]|br|hr)\b[^<>]*$/gim, '')

  out = decodeEntities(out)
    // `<summary>标题</summary><p>正文` 折完会粘成「**标题**正文」，这里补一个换行
    .replace(/\*\*([^*\n]{1,80})\*\*(?=[^\s*])/g, '**$1**\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\*\*\s*\*\*/g, '')
    .trim()
  return out
}

/** 是否还残留 HTML 标签（用于诊断与清理脚本）。 */
export function hasHtmlTags(value) {
  return KNOWN.test(String(value ?? ''))
}
