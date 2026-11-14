/**
 * 角色卡库读取（多根 + PNG/JSON 双格式 + 持久索引）。
 *
 * 三个事实决定了这个模块的形状：
 *
 * 1. 卡库有两个来源：自建库（rp-kit，明文 JSON，chara_card_v3）和下载库
 *    （jueseka2，~9878 个 PNG + 581 个 JSON，24GB）。PNG 是 SillyTavern 图片卡，
 *    设定藏在 tEXt/iTXt 的 `chara`（V2）或 `ccv3`（V3）块里，值是 base64 JSON。
 * 2. 不可能每次扫描都读 24GB。所以按文件 mtime+size 做持久索引：
 *    命中就只 stat，不读内容；索引落 ~/.dsh/rp-memory/card-index.json。
 * 3. PNG 的文本块大概率紧跟 IHDR，所以阶梯读：64KB → 512KB → 尾部 256KB。
 *    多数卡第一档就命中，IO 从 GB 级降到百 MB 级。
 *
 * 另外解决「随时调换」：当前角色/背景记在 ~/.dsh/rp-memory/current.json，
 * 由 prompt 段每轮注入，不需要重启会话。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { htmlToText } from './html-text.js'

/** 自建库（明文 JSON）。 */
export const DEFAULT_CARD_ROOT = process.env.DSH_RP_CARD_ROOT || path.join(process.env.DSH_WORKSPACE || process.cwd(), 'rp-kit', '角色卡库', 'cards-json')
/** 下载库（PNG 图片卡为主）。 */
export const DOWNLOAD_CARD_ROOT = process.env.DSH_RP_DOWNLOAD_ROOT || path.join(os.homedir(), 'Downloads', 'jueseka2')

const INDEX_VERSION = 2
/** file -> { size, mtimeMs, meta }，meta 为 null 表示「确认不是卡」。 */
const memory = new Map()
/** 目录 -> { at, count }：避免同一轮里重复递归同一棵大树。 */
const dirCache = new Map()

function text(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim()
}

function clip(value, limit) {
  const s = text(value)
  return s.length <= limit ? s : s.slice(0, limit) + '…'
}

export function stateHome() {
  return path.join(os.homedir(), '.dsh', 'rp-memory')
}

export function defaultIndexFile() {
  return path.join(stateHome(), 'card-index.json')
}

export function defaultCurrentFile() {
  return path.join(stateHome(), 'current.json')
}

/** 配置里的 cardRoots 归一化成 [{path,label,recursive,exts}]；空配置退回两个默认根。 */
export function normalizeRoots(config = {}) {
  const raw = config.cardRoots
  if (Array.isArray(raw) && raw.length) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return { path: item, label: path.basename(item), recursive: true, exts: ['.json', '.png'] }
        const p = text(item?.path)
        if (!p) return null
        return {
          path: p,
          label: text(item.label) || path.basename(p),
          recursive: item.recursive !== false,
          exts: Array.isArray(item.exts) && item.exts.length ? item.exts.map((e) => text(e).toLowerCase()) : ['.json', '.png'],
        }
      })
      .filter(Boolean)
  }
  const single = text(config.cardRoot)
  if (single) return [{ path: single, label: path.basename(single), recursive: false, exts: ['.json', '.png'] }]
  return [
    { path: DEFAULT_CARD_ROOT, label: '自建', recursive: false, exts: ['.json', '.png'] },
    { path: DOWNLOAD_CARD_ROOT, label: '下载库', recursive: true, exts: ['.json', '.png'] },
  ]
}

/* ---------------- PNG 图片卡 ---------------- */

function tryDecodeCardPayload(raw) {
  const candidates = [raw]
  // iTXt 的正文前面可能带语言标签；兜底把整段里的 base64 段抽出来
  const compact = raw.replace(/\s+/g, '')
  if (compact !== raw) candidates.push(compact)
  for (const candidate of candidates) {
    try {
      const json = Buffer.from(candidate, 'base64').toString('utf8')
      const parsed = JSON.parse(json)
      if (parsed && (parsed.name || parsed.data?.name || parsed.spec)) return parsed
    } catch {
      // 试下一个
    }
  }
  return null
}

function readChunkWindow(fd, offset, length) {
  const buf = Buffer.allocUnsafe(length)
  const read = fs.readSync(fd, buf, 0, length, offset)
  return buf.subarray(0, read)
}

/** 从一个 PNG 窗口里找 chara / ccv3，返回解析后的对象。 */
function scanPngWindow(view, wantV3) {
  if (view.length < 8 || view.readUInt32BE(0) !== 0x89504e47) return null
  let off = 8
  let v2 = null
  let v3 = null
  while (off + 12 <= view.length) {
    const len = view.readUInt32BE(off)
    const type = view.toString('ascii', off + 4, off + 8)
    const dataStart = off + 8
    if (len > view.length || dataStart + len + 4 > view.length) break
    if (type === 'tEXt' || type === 'iTXt') {
      const body = view.subarray(dataStart, dataStart + len)
      const nul = body.indexOf(0)
      if (nul > 0) {
        const key = body.toString('latin1', 0, nul)
        if (key === 'chara' && !v2) v2 = tryDecodeCardPayload(body.toString('latin1', nul + 1))
        if (key === 'ccv3' && !v3) v3 = tryDecodeCardPayload(body.toString('latin1', nul + 1))
      }
    }
    if (type === 'IEND') break
    off = dataStart + len + 4
  }
  return wantV3 ? v3 || v2 : v2 || v3
}

/**
 * 在任意窗口里找 chara / ccv3 文本块。
 *
 * 不依赖 PNG 签名、也不要求 chunk 从窗口开头对齐——阶梯读的尾部窗口一定是
 * 从文件中间切的。做法是直接在窗口里搜 'tEXt' / 'iTXt' 四个字节，往前 4 字节
 * 取长度，往后取 body，再按 NUL 分段（iTXt 前面还有压缩标记与语言标签）。
 */
function decodeFromParts(parts) {
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const candidate = parts[i].trim()
    if (candidate.length < 20) continue
    const hit = tryDecodeCardPayload(candidate)
    if (hit) return hit
  }
  return null
}

function scanTextChunksRaw(view) {
  let v2 = null
  let v3 = null
  for (const mark of ['tEXt', 'iTXt']) {
    const sig = Buffer.from(mark, 'latin1')
    let at = view.indexOf(sig)
    while (at >= 0) {
      if (at >= 4) {
        const len = view.readUInt32BE(at - 4)
        const start = at + 4
        const end = start + Math.min(len, view.length - start)
        if (end > start) {
          const parts = view.subarray(start, end).toString('latin1').split('\u0000')
          if (parts[0] === 'chara' && !v2) v2 = decodeFromParts(parts)
          if (parts[0] === 'ccv3' && !v3) v3 = decodeFromParts(parts)
        }
      }
      at = view.indexOf(sig, at + 1)
    }
  }
  return v3 || v2
}

/** 读一张 PNG 卡：头部 128KB → 尾部 1MB → 整文件（≤16MB）。 */
export function parsePngCard(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    let hit = scanTextChunksRaw(readChunkWindow(fd, 0, Math.min(128 * 1024, size)))
    if (hit) return hit
    const tailLen = Math.min(1024 * 1024, size)
    hit = scanTextChunksRaw(readChunkWindow(fd, size - tailLen, tailLen))
    if (hit) return hit
    if (size <= 16 * 1024 * 1024) {
      hit = scanTextChunksRaw(readChunkWindow(fd, 0, size))
      if (hit) return hit
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // 关不掉不影响结果
      }
    }
  }
}

/* ---------------- 归一化 ---------------- */

/** V3 的顶层与 data 是冗余的，data 优先；PNG 卡常见只有顶层。 */
export function normalizeCard(raw) {
  const d = raw && typeof raw.data === 'object' && raw.data ? raw.data : {}
  const pick = (key) => text(d[key] ?? raw?.[key])
  /**
   * ★2026-11-08：卡正文里的 HTML 在这里一次性折成 Markdown 纯文本。
   *
   * 酒馆前端渲染 HTML，DSH 不渲染（前端只用 micromark 解析 CommonMark），
   * 模型照着卡里的 `<details><div style="…">` 状态栏模板输出，用户看到一屏源码。
   * 折在**加载口**而不是渲染口：buildStageKit / renderCardMemory / currentSummary /
   * 世界书全部从这里取字段，一处清洗，下游全干净。
   */
  const rich = (key) => htmlToText(text(d[key] ?? raw?.[key]))
  const tags = [raw?.tags, d?.tags].find((t) => Array.isArray(t)) || []
  const bookRaw = d.character_book || raw?.character_book
  const book = bookRaw && Array.isArray(bookRaw.entries) ? bookRaw.entries : []
  return {
    name: pick('name'),
    description: rich('description'),
    personality: rich('personality'),
    scenario: rich('scenario'),
    firstMes: rich('first_mes'),
    mesExample: rich('mes_example'),
    systemPrompt: rich('system_prompt'),
    postHistory: rich('post_history_instructions'),
    creatorNotes: rich('creator_notes') || rich('creatorcomment'),
    tags: tags.map((t) => text(t)).filter(Boolean),
    book,
    bookName: text(bookRaw?.name),
    spec: text(raw?.spec || d.spec || ''),
    alternateGreetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.map((x) => htmlToText(text(x))).filter(Boolean) : [],
    /** 卡自带的正则脚本（酒馆用它们渲染状态栏 / 清理历史）。 */
    regexScripts: (() => {
      const ext = (d && d.extensions) || (raw && raw.extensions) || {}
      return Array.isArray(ext.regex_scripts) ? ext.regex_scripts : []
    })(),
  }
}

function readJsonCard(file) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  // 纯世界书 / 正则预设：顶层是 entries 数组，不是角色卡
  if (!raw || typeof raw !== 'object') return null
  const hasName = !!(raw.name || raw.data?.name)
  const looksLore = Array.isArray(raw.entries) && !hasName
  if (looksLore) return null
  if (!hasName && !raw.spec && !raw.data) return null
  return raw
}

export function loadCard(file) {
  const lower = file.toLowerCase()
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  const cached = memory.get(file)
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.meta
  let raw = null
  if (lower.endsWith('.json')) raw = readJsonCard(file)
  else if (lower.endsWith('.png')) raw = parsePngCard(file)
  const card = raw ? normalizeCard(raw) : null
  memory.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, meta: card })
  return card
}

/* ---------------- 扫描与索引 ---------------- */

function walkDir(dir, root, out, depth, group) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nextGroup = depth === 0 ? entry.name : group
      walkDir(full, root, out, depth + 1, nextGroup)
      continue
    }
    const ext = path.extname(entry.name).toLowerCase()
    if (ext !== '.json' && ext !== '.png') continue
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    out.push({
      file: full,
      title: entry.name.replace(/\.[^.]+$/, ''),
      group,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      ext,
    })
  }
}

function readIndexFile(indexFile) {
  try {
    const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    if (data && data.version === INDEX_VERSION && data.entries && typeof data.entries === 'object') return data.entries
  } catch {
    // 没有索引就从空开始
  }
  return {}
}

function writeIndexFile(indexFile, entries) {
  try {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true })
    fs.writeFileSync(indexFile, JSON.stringify({ version: INDEX_VERSION, at: new Date().toISOString(), entries }), 'utf8')
  } catch {
    // 索引写不进去不影响本次结果
  }
}

/**
 * 扫卡库。命中索引的文件只 stat 不读内容；未命中或变了的才解析。
 * @returns {{index: Array, stats: {total:number,cards:number,parsed:number,fromCache:number}}}
 */
export function scanCards(config = {}, { indexFile, force = false } = {}) {
  const roots = Array.isArray(config) ? config : normalizeRoots(config)
  const file = indexFile || defaultIndexFile()
  const persisted = force ? {} : readIndexFile(file)
  const nextPersisted = {}
  const index = []
  let parsed = 0
  let fromCache = 0

  for (const root of roots) {
    if (!fs.existsSync(root.path)) continue
    if (dirCache.has(root.path) && !force) {
      const hit = dirCache.get(root.path)
      if (Date.now() - hit.at < 30000) {
        for (const entry of hit.list) {
          index.push({ ...entry, root: root.label })
          if (entry.cards) fromCache += 1
        }
        continue
      }
    }

    const files = []
    walkDir(root.path, root.path, files, 0, root.label)
    const list = []
    for (const entry of files) {
      if (entry.ext === '.png') entry.group = entry.group + '/' + path.basename(path.dirname(entry.file))
      if (entry.ext === '.png' && entry.group.length > 60) entry.group = entry.group.slice(0, 60)
      const key = entry.file
      const prev = persisted[key]
      let meta = null
      if (prev && prev.size === entry.bytes && prev.mtime === entry.mtimeMs && prev.kind !== 'lore') {
        meta = { name: prev.name, tags: prev.tags, bookCount: prev.bookCount }
        entry.cards = true
        fromCache += 1
      } else {
        const card = loadCard(entry.file)
        parsed += 1
        if (card && card.name) {
          meta = { name: card.name, tags: card.tags, bookCount: card.book.length }
          entry.cards = true
        }
      }
      nextPersisted[key] = {
        size: entry.bytes,
        mtime: entry.mtimeMs,
        kind: meta ? entry.ext : 'lore',
        name: meta?.name || '',
        tags: meta?.tags || [],
        bookCount: meta?.bookCount || 0,
      }
      if (!meta) continue
      index.push({ ...entry, root: root.label, cardName: meta.name, tags: meta.tags, bookCount: meta.bookCount })
      list.push({ ...entry, root: root.label, cardName: meta.name, tags: meta.tags, bookCount: meta.bookCount })
    }
    dirCache.set(root.path, { at: Date.now(), list })
  }

  if (parsed > 0 || !Object.keys(persisted).length) writeIndexFile(file, nextPersisted)

  index.sort((a, b) => String(a.cardName || a.title).localeCompare(String(b.cardName || b.title), 'zh'))
  return {
    index,
    stats: { total: index.length, roots: roots.map((r) => r.label), parsed, fromCache, indexFile: file },
  }
}

/* ---------------- 查询 ---------------- */

export function findCards(index, keyword, limit = 10) {
  const needle = text(keyword).toLowerCase()
  if (!needle) return []
  const hit = (entry) =>
    entry.title.toLowerCase().includes(needle) || String(entry.cardName || '').toLowerCase().includes(needle)
  return index.filter(hit).slice(0, limit)
}

export function searchCards(index, keyword, limit = 8) {
  const needle = text(keyword).toLowerCase()
  if (!needle) return []
  const hits = []
  for (const entry of index) {
    const inTitle = entry.title.toLowerCase().includes(needle) || String(entry.cardName || '').toLowerCase().includes(needle)
    const inTags = (entry.tags || []).some((t) => String(t).toLowerCase().includes(needle))
    if (!inTitle && !inTags) continue
    hits.push({ entry, score: inTitle ? 3 : 2 })
  }
  hits.sort((a, b) => b.score - a.score)
  if (hits.length >= limit) return hits.slice(0, limit)
  // 标题/标签没够，再用设定正文补（只对候选集，避免全量解析）
  for (const entry of index) {
    if (hits.some((h) => h.entry.file === entry.file)) continue
    const card = loadCard(entry.file)
    if (!card) continue
    const body = `${card.description} ${card.personality} ${card.scenario}`.toLowerCase()
    if (body.includes(needle)) hits.push({ entry, score: 1 })
    if (hits.length >= limit) break
  }
  return hits.slice(0, limit)
}

/**
 * 卡里的 `<img>某图.png</img>` 与 `![图](路径)` 引用，在本地卡库里查不到对应文件
 * （实测 80 张重世界书样本里只有 1 处引用、且文件不存在）。留着只会让模型照着
 * 输出空标记，所以在回给模型之前剥掉。
 */
export function stripImageTags(value) {
  // 图片标记先剥，再统一折 HTML（卡加载时已经折过一遍，这里兜住世界书、旧记忆等旁路）。
  return htmlToText(
    String(value ?? '')
      .replace(/<img\b[^>]*>[\s\S]*?<\/img>/gi, '')
      .replace(/<img\b[^>]*\/?>/gi, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ''),
  )
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 把卡里的酒馆占位符换成能直接读的词。
 *
 * 开场白 / 设定里普遍写 `{{user}}`、`{{char}}`、`<user>`、`<char>`。以前只做「中和」
 * （拆成 `{ {user} }`，防提示词变量校验报错），读起来别扭；这里直接换成「你」和角色名。
 */
export function fillPlaceholders(value, card = {}) {
  const charName = String(card?.name || '').trim() || '角色'
  return String(value ?? '')
    .replace(/\{\{\s*char\s*\}\}/gi, charName)
    .replace(/<\s*char\s*>/gi, charName)
    .replace(/\{\{\s*user\s*\}\}/gi, '你')
    .replace(/<\s*user\s*>/gi, '你')
}

/**
 * 卡的「自带开场」清单：first_mes 打头，其后是 alternate_greetings。
 * 实测 96% 的卡有 first_mes、约一半还有平均 3 个备选，随机抽一个会白白丢掉其余。
 * @returns {{tag: string, text: string}[]}
 */
export function openingsOf(card) {
  const list = []
  const first = fillPlaceholders(card?.firstMes, card).trim()
  if (first) list.push({ tag: 'first_mes', text: first })
  const alts = Array.isArray(card?.alternateGreetings) ? card.alternateGreetings : []
  alts.forEach((greeting, index) => {
    const text = fillPlaceholders(greeting, card).trim()
    if (text) list.push({ tag: `备选${index + 1}`, text })
  })
  return list
}

/**
 * 世界书目录：只给「有哪些条目、靠什么词触发、开头写了什么」，不给正文。
 * 用于 pick / cast 之后，让模型一次看清全貌，再决定用 book 取哪几条。
 * 起因（2026-11-08 实测）：pick 只回一句「该卡带世界书 N 条」，模型看不到条目，
 * 只好逐条 book 试探，同一场景换措辞问了两次（命中同一批），第一轮因此跑成 6 步。
 */
export function bookIndex(card, limit = 20) {
  const entries = Array.isArray(card?.book) ? card.book : []
  const items = entries
    .filter((e) => e && e.enabled !== false)
    .map((e) => {
      const keys = Array.isArray(e?.keys) ? e.keys.map((k) => text(k)).filter(Boolean) : []
      const content = stripImageTags(text(e?.content)).replace(/\s+/g, ' ')
      return {
        name: text(e?.name || e?.comment || ''),
        keys,
        head: content.slice(0, 40),
        chars: content.length,
        constant: e?.constant === true,
      }
    })
  const cap = Math.max(1, Number(limit) || 20)
  return { total: items.length, shown: Math.min(cap, items.length), items: items.slice(0, cap) }
}

/** 把 bookIndex 的结果渲染成几行文本（每行 ≤ 90 字），供工具返回直接拼 */
export function renderBookIndex(index, limit = 20) {
  if (!index || !index.total) return []
  const items = index.items.slice(0, Math.max(1, Number(limit) || 20))
  const lines = items.map((it, i) => {
    const label = it.name || it.keys[0] || `第${i + 1}条`
    const keys = it.keys.length ? it.keys.slice(0, 4).join(' / ') : '无关键词'
    return `  ${i + 1}. ${label}｜${keys}｜${it.head}…（${it.chars}字${it.constant ? '，常驻' : ''}）`
  })
  if (index.total > items.length) lines.push(`  …另有 ${index.total - items.length} 条未列出`)
  return lines
}

export function pickBookEntries(card, keyword, limit = 6) {
  const entries = Array.isArray(card.book) ? card.book : []
  if (!entries.length) return []
  const needle = text(keyword).toLowerCase()
  const shaped = entries.map((entry) => {
    const keys = Array.isArray(entry?.keys) ? entry.keys.map((k) => text(k)) : []
    return { keys, content: stripImageTags(text(entry?.content)), enabled: entry?.enabled !== false, order: Number(entry?.insertion_order) || 0 }
  })
  const pool = needle
    ? shaped.filter((e) => e.enabled && (e.keys.some((k) => k.toLowerCase().includes(needle)) || e.content.toLowerCase().includes(needle)))
    : shaped.filter((e) => e.enabled).sort((a, b) => b.order - a.order)
  return pool.slice(0, Math.max(1, Number(limit) || 6))
}

/**
 * 演出包：把卡里「作者写了、但默认会被丢掉」的东西整理成分节文本。
 * 数据依据（250 张抽样）：post_history_instructions 5.6%、mes_example 24.8%、
 * 世界书 constant 条目占 43%、keys 像人名的条目占 59%。
 */
export function buildStageKit(card) {
  const out = []
  if (!card) return out

  const fmt = [text(card.systemPrompt), text(card.postHistory)].filter(Boolean).join('\n\n')
  if (fmt) out.push(['本卡专用格式要求（作者写的，必须遵守）', clip(stripImageTags(fmt), 1200)])
  if (card.mesExample) out.push(['语气范例（说话照这个调，别用旁白腔）', clip(stripImageTags(card.mesExample), 800)])
  if (card.personality) out.push(['性格', clip(stripImageTags(card.personality), 1500)])
  if (card.scenario) out.push(['情境', clip(stripImageTags(card.scenario), 800)])

  const entries = Array.isArray(card.book) ? card.book : []
  const consts = entries
    .filter((e) => e && e.enabled !== false && e.constant === true && text(e.content))
    .sort((a, b) => (Number(a.insertion_order) || 0) - (Number(b.insertion_order) || 0))
  if (consts.length) {
    const joined = consts.map((e) => '· ' + stripImageTags(text(e.content))).join('\n')
    out.push([`世界设定（常驻 ${consts.length} 条，不用再问我）`, clip(joined, 3000)])
  }

  const rx = Array.isArray(card.regexScripts) ? card.regexScripts.filter((r) => r && typeof r === 'object') : []
  if (rx.length) {
    const cleanOnly = rx.filter((r) => r.promptOnly === true || r.markdownOnly === false).length
    const rxNames = rx
      .map((r) => text(r.scriptName || r.name || ''))
      .filter(Boolean)
      .slice(0, 6)
    out.push([
      `本卡自带 ${rx.length} 条正则脚本（渲染 / 清理历史）`,
      `${cleanOnly ? `其中 ${cleanOnly} 条是发送前清理用的。` : ''}回复里不要重复上一轮的状态栏、变量块与数值，只写变化的部分。` +
        (rxNames.length ? `涉及：${rxNames.join('、')}` : ''),
    ])
  }

  const names = []
  for (const e of entries) {
    const keys = Array.isArray(e?.keys) ? e.keys.map((k) => text(k)) : []
    for (const k of keys) {
      if (/^[\u4e00-\u9fa5A-Za-z·]{2,8}$/.test(k) && !names.includes(k)) {
        names.push(k)
        break
      }
    }
  }
  if (names.length > 1) out.push(['本卡包含的角色（世界书里能查到的）', names.slice(0, 14).join('、')])
  return out
}

export function renderCardView(card, { full = false } = {}) {
  const lines = [`【${card.name}】${card.tags.length ? ' ' + card.tags.slice(0, 8).map((t) => '#' + t).join(' ') : ''}`]
  if (card.personality) lines.push('性格：' + clip(stripImageTags(card.personality), full ? 800 : 200))
  if (card.scenario) lines.push('情境：' + clip(stripImageTags(card.scenario), full ? 800 : 200))
  if (card.description) lines.push('设定：' + clip(stripImageTags(card.description), full ? 2000 : 400))
  if (card.firstMes) {
    lines.push('', '开场（first_mes）：')
    lines.push(clip(stripImageTags(card.firstMes), full ? 4000 : 1500))
  }
  if (full) {
    if (card.mesExample) {
      lines.push('', '语气范例（mes_example）：')
      lines.push(clip(stripImageTags(card.mesExample), 2500))
    }
    if (card.systemPrompt) {
      lines.push('', '卡内指令（system_prompt）：')
      lines.push(clip(card.systemPrompt, 1200))
    }
    if (card.alternateGreetings.length) {
      lines.push('', `另有 ${card.alternateGreetings.length} 条备选开场（alternate_greetings）。`)
    }
  }
  if (card.book.length) lines.push('', `世界书 ${card.book.length} 条${card.bookName ? '（' + card.bookName + '）' : ''} —— 用 rp_card(action=book) 按关键词取。`)
  return lines
}

export function renderCardMemory(card) {
  const parts = []
  if (card.description) parts.push('设定：' + stripImageTags(card.description))
  if (card.personality) parts.push('性格：' + stripImageTags(card.personality))
  if (card.scenario) parts.push('情境：' + stripImageTags(card.scenario))
  if (card.mesExample) parts.push('语气范例：\n' + clip(stripImageTags(card.mesExample), 1200))
  // ★2026-11-10：卡里可能只有 first_mes、没有 description/personality/scenario
  //   （实测有一批卡就这样）。以前这里返回空串，`pick` 落到
  //   `saveEntry(... body: '' )` → 抛「body 不能为空」→ 整次 pick 失败，
  //   模型只能反复重试（用户侧看到的就是「pick 一直报错」）。用开场兜底，再不行给一句占位。
  if (!parts.length && card.firstMes) parts.push('开场：\n' + clip(stripImageTags(card.firstMes), 1200))
  if (!parts.length) parts.push(`《${stripImageTags(card.name || '未命名')}》——这张卡没有设定、性格、情境与开场文本，正文以首次登场时现演的为准。`)
  return parts.join('\n\n')
}

/* ---------------- 当前角色 / 背景（随时调换） ---------------- */

export function readCurrent(currentFile) {
  try {
    return JSON.parse(fs.readFileSync(currentFile || defaultCurrentFile(), 'utf8'))
  } catch {
    return null
  }
}

export function writeCurrent(payload, currentFile) {
  const file = currentFile || defaultCurrentFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ ...payload, at: new Date().toISOString() }, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 按卡组拼一句话摘要（**会话维度**）：提示词段用它代替全局 current.json。
 * cards 为空返回 '' —— 调用方据此走「开局先挑卡」。
 */
export function cardsSummary(cards, scenario) {
  const names = (Array.isArray(cards) ? cards : [])
    .map((c) => String((c && (c.name || c.title)) || '').trim())
    .filter(Boolean)
  if (!names.length) return ''
  const bits = [names.length > 1 ? `本局角色（群聊 ${names.length} 位）：${names.join('、')}` : `当前角色：${names[0]}`]
  if (scenario) bits.push(`背景：${clip(scenario, 120)}`)
  return bits.join('；')
}

/**
 * 取「本会话」该带的背景文本。
 *
 * 优先级：
 *   1. 会话锁上的 scenario（2026-11-10 起 background 写这里，按会话隔离）；
 *   2. 老会话没有会话级背景时，才回退全局 `current.json`，但**必须与本会话卡组同源**：
 *      `file` 要命中本会话卡组，且 `character` 若存在也必须命中 —— 否则说明这份
 *      scenario 是别的会话留下的（历史上出现过「本会话選了 A 卡，背景却在讲 B 卡」）。
 *
 * @param {object} lock 会话锁（含 cards / scenario）
 * @param {Array} cards 本会话卡组
 * @param {object} current 全局 current.json 内容（可为 null）
 * @returns {string} 可以直接进提示词的背景文本，'' 表示不带
 */
export function scenarioForSession(lock, cards, current) {
  const own = lock && typeof lock.scenario === 'string' ? lock.scenario.trim() : ''
  if (own) return own
  if (!current || !current.scenario) return ''
  const list = Array.isArray(cards) ? cards : []
  const files = new Set(list.map((c) => String((c && c.file) || '')))
  const names = new Set(list.map((c) => String((c && c.name) || '')))
  if (current.file && !files.has(String(current.file))) return ''
  if (current.character && !names.has(String(current.character))) return ''
  return String(current.scenario)
}

/** 每轮注入的一句话：当前在演谁、什么背景（全局口径，仅供面板/工具回显）。 */
export function currentSummary(currentFile) {  const cur = readCurrent(currentFile)
  if (!cur) return ''
  const cards = Array.isArray(cur.cards) && cur.cards.length
    ? cur.cards
    : cur.character
      ? [{ name: cur.character }]
      : []
  const base = cardsSummary(cards, cur.scenario)
  if (!base) return ''
  return cur.source ? `${base}；（卡源 ${cur.source}）` : base
}


/* ---------------- 标签索引（_cardindex/cards.jsonl，扮演模式的快速通道） ---------------- */

/** 索引文件 -> { mtimeMs, rows, byId, root, dir }，按 mtime 失效。 */
const tagIndexCache = new Map()

export function loadTagIndex(file) {
  const p = text(file)
  if (!p) return null
  try {
    const st = fs.statSync(p)
    const hit = tagIndexCache.get(p)
    if (hit && hit.mtimeMs === st.mtimeMs) return hit
    const rows = []
    for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        // 坏行跳过，不影响整库
      }
    }
    const dir = path.dirname(p)
    const entry = { mtimeMs: st.mtimeMs, rows, byId: new Map(rows.map((r) => [r.id, r])), dir, root: path.dirname(dir) }
    tagIndexCache.set(p, entry)
    return entry
  } catch {
    return null
  }
}

/** 把标签行换成 scanCards 同构的 entry 列表，让 list / read / book 复用同一条路。 */
export function tagRowsToIndex(idx) {
  if (!idx) return []
  return idx.rows.map((row) => {
    const parts = String(row.rel || '').split(/[\\/]/)
    return {
      file: path.resolve(idx.root, row.rel),
      title: row.name || path.basename(row.rel || ''),
      cardName: row.name || '',
      group: parts.length > 1 ? parts[0] : '根',
      bytes: row.size || 0,
      tags: row.ctags || [],
      bookCount: row.book || 0,
      tagRow: row,
    }
  })
}

/** 关键词（空格分隔，OR）+ 标签过滤，毫秒级。返回 [{ row, score }]。 */
export function searchTagIndex(idx, { query = '', tags = [], l1 = '', l2 = [], limit = 8 } = {}) {
  if (!idx) return []
  const terms = String(query || '').split(/[\s,，]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
  const wantTags = String(tags || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  const wantL2 = String(l2 || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  const out = []
  for (const row of idx.rows) {
    if (l1 && row.l1 !== l1) continue
    if (wantL2.length && !wantL2.every((x) => (row.l2 || []).includes(x))) continue
    if (wantTags.length) {
      const have = new Set([
        ...(row.traits || []), ...(row.relation || []), ...(row.kink || []), ...(row.ctags || []),
        ...(row.body || []), ...(row.persona || []), ...(row.role || []), ...(row.scene || []),
      ])
      if (!wantTags.every((t) => have.has(t))) continue
    }
    let score = 0
    if (terms.length) {
      const name = String(row.name || '').toLowerCase()
      const tagBlob = [
        ...(row.traits || []), ...(row.relation || []), ...(row.kink || []), ...(row.l2 || []), ...(row.ctags || []),
        ...(row.body || []), ...(row.persona || []), ...(row.role || []), ...(row.scene || []),
      ].join(' ').toLowerCase()
      const prev = String(row.preview || '').toLowerCase()
      let hit = 0
      for (const t of terms) {
        let s = 0
        if (name.includes(t)) s += 6
        if (tagBlob.includes(t)) s += 3
        if (prev.includes(t)) s += 1
        if (s) hit += 1
        score += s
      }
      if (!hit) continue
    }
    out.push({ row, score })
  }
  out.sort((a, b) => b.score - a.score || (b.row.words || 0) - (a.row.words || 0))
  return out.slice(0, Math.max(1, Number(limit) || 8))
}
