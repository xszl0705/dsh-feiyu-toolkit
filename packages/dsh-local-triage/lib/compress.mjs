/**
 * 确定性压缩器 —— 本方案里收益最大、风险最低的部分，而且完全不需要本地模型。
 *
 * 铁律（来自 CliffCompaction 的教训）：
 *   只截断、只丢弃，绝不改写；永不对压缩结果再压缩。
 *
 * 每个函数都是纯函数，可单测、可回归。压缩比写在注释里，方便估算。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 硬截断：最简单也最安全的压缩。 */
export function capText(text, maxChars = 4000) {
  const s = String(text ?? '')
  if (s.length <= maxChars) return { text: s, truncated: false, dropped: 0 }
  const kept = s.slice(0, maxChars)
  return { text: `${kept}\n…[已截断 ${s.length - maxChars} 字]`, truncated: true, dropped: s.length - maxChars }
}

/**
 * 字段投影：只保留白名单字段。典型压缩比 5~50x。
 * @param {object|object[]} input
 * @param {string[]} allow
 */
export function projectFields(input, allow = []) {
  const allowSet = new Set(allow)
  const pick = (obj) => {
    if (!obj || typeof obj !== 'object') return obj
    const out = {}
    for (const key of Object.keys(obj)) {
      if (allowSet.size === 0 || allowSet.has(key)) out[key] = obj[key]
    }
    return out
  }
  if (Array.isArray(input)) return input.map(pick)
  return pick(input)
}

/**
 * 分页：回前 N 条 + 总数 + 翻页提示。典型压缩比 10~100x。
 * @param {any[]} items
 * @param {{offset?:number, pageSize?:number, itemLabel?:string}} opts
 */
export function paginate(items, { offset = 0, pageSize = 20, itemLabel = 'items' } = {}) {
  const list = Array.isArray(items) ? items : []
  const start = Math.max(0, Number(offset) || 0)
  const size = Math.max(1, Number(pageSize) || 20)
  const page = list.slice(start, start + size)
  const end = start + page.length
  const more = end < list.length
  return {
    page,
    total: list.length,
    offset: start,
    nextOffset: more ? end : null,
    hint: more ? `共 ${list.length} 条，当前第 ${start + 1}-${end} 条；需要更多请用 offset=${end} 再取` : `共 ${list.length} 条，已全部返回`,
  }
}

/**
 * 落盘回路径：大结果写文件，上下文里只留路径 + 预览。典型压缩比 50~500x。
 * 注意：目录由调用方决定，函数本身不删除任何东西。
 */
export function spillToFile(content, { dir, id, ext = 'txt', previewChars = 200, minBytes = 0 } = {}) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (!dir || bytes < minBytes) {
    return { spilled: false, bytes, text }
  }
  fs.mkdirSync(dir, { recursive: true })
  const safeId = String(id || Date.now()).replace(/[^\w.-]+/g, '_')
  const file = path.join(dir, `${safeId}.${ext}`)
  fs.writeFileSync(file, text, 'utf8')
  const preview = text.slice(0, previewChars)
  return {
    spilled: true,
    path: file,
    bytes,
    text: `[结果已落盘：${file}（${bytes} 字节）]\n[预览]\n${preview}${text.length > previewChars ? '\n…' : ''}\n[需要全文时按路径读取]`,
  }
}

/**
 * 报错裁剪：只回错误类型 + 关键行 + 位置。典型压缩比 20~100x。
 * 保留的信息恰好够定位，不保留整个 stack。
 */
export function trimError(text, { maxLines = 6 } = {}) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim())
  if (lines.length <= maxLines) return { text: lines.join('\n'), trimmed: false }
  const head = lines.filter((l) => /error|exception|failed|denied|cannot|undefined|null/i.test(l)).slice(0, 2)
  const at = lines.filter((l) => /:\d+:\d+|:\d+\b/.test(l)).slice(0, 2)
  const picked = [...new Set([...head, ...at])].slice(0, maxLines)
  const fallback = picked.length ? picked : lines.slice(0, maxLines)
  return {
    text: `${fallback.join('\n')}\n…[已省略 ${lines.length - fallback.length} 行]`,
    trimmed: true,
    omitted: lines.length - fallback.length,
  }
}

/**
 * diff hunk 提取：只发改动附近 ±context 行。典型压缩比 10~300x。
 * 纯文本定位，不做语言解析（够用且不会误伤）。
 */
export function extractHunks(text, { context = 3, maxHunks = 5 } = {}) {
  const lines = String(text ?? '').split(/\r?\n/)
  const marks = []
  for (let i = 0; i < lines.length; i += 1) {
    if (/^[+-](?![+-])/.test(lines[i])) marks.push(i)
  }
  if (!marks.length) return { text: lines.join('\n'), hunks: 0, changed: false }

  const ranges = []
  for (const i of marks) {
    const from = Math.max(0, i - context)
    const to = Math.min(lines.length - 1, i + context)
    const last = ranges[ranges.length - 1]
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to)
    else ranges.push({ from, to })
  }
  const sliced = ranges.slice(0, maxHunks)
  const out = []
  for (const r of sliced) {
    out.push(`@@ 行 ${r.from + 1}-${r.to + 1} @@`)
    out.push(...lines.slice(r.from, r.to + 1))
  }
  const omitted = ranges.length - sliced.length
  if (omitted > 0) out.push(`…[另有 ${omitted} 处改动未展示]`)
  return { text: out.join('\n'), hunks: ranges.length, changed: true }
}

/**
 * 去重：相同内容块只保留首次出现。典型压缩比视重复度。
 * @param {string[]} blocks
 */
export function dedupeBlocks(blocks, { keyOf = (s) => String(s).trim() } = {}) {
  const seen = new Set()
  const kept = []
  let dropped = 0
  for (const block of blocks) {
    const key = keyOf(block)
    if (seen.has(key)) { dropped += 1; continue }
    seen.add(key)
    kept.push(block)
  }
  return { blocks: kept, dropped }
}

/**
 * 一步到位：把工具返回值按体积分档处理。
 * 小结果原样回，中等结果投影+分页，大结果落盘回路径。
 */
export function compressToolResult(content, {
  allowFields,
  spillDir,
  id,
  spillBytes = 12000,
  capChars = 4000,
  previewChars = 200,
} = {}) {
  const raw = typeof content === 'string' ? content : JSON.stringify(content ?? null)
  const bytes = Buffer.byteLength(raw, 'utf8')

  if (bytes >= spillBytes && spillDir) {
    const spilled = spillToFile(content, { dir: spillDir, id, ext: 'txt', previewChars })
    return { level: 'spill', bytes, out: spilled.text, path: spilled.path }
  }

  if (Array.isArray(content) && content.length > 0 && allowFields) {
    const projected = projectFields(content, allowFields)
    const paged = paginate(projected, { pageSize: 20 })
    const body = JSON.stringify(paged)
    const capped = capText(body, capChars)
    return { level: 'project+page', bytes, out: capped.text }
  }

  const capped = capText(raw, capChars)
  return { level: capped.truncated ? 'cap' : 'none', bytes, out: capped.text }
}
