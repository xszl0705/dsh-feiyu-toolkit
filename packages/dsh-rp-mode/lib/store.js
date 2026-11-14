/**
 * 扮演记忆存储。
 *
 * 设计取舍：
 * - 落 Markdown 分文件，人能直接看、能直接改、能备份，不用数据库。
 * - id 由 kind+name 哈希得来 —— save 同名即覆盖，重复调用不会攒出一堆副本。
 * - 没有 index.json：目录扫描时只读 frontmatter（前若干行），条目量在千级以内够快。
 * - 与工作记忆（~/.dsh/memory、.dsh-memory）完全分开，互不写入。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/** kind → 子目录。顺序即 digest 的展示顺序。 */
export const KINDS = {
  character: 'characters',
  world: 'worlds',
  scene: 'scenes',
  bond: 'bonds',
  note: 'notes',
}

export const KIND_LABEL = {
  character: '角色',
  world: '世界',
  scene: '剧情',
  bond: '关系',
  note: '杂记',
}

export function defaultRoot(home = os.homedir()) {
  return path.join(home, '.dsh', 'rp-memory')
}

/** 去掉换行和 frontmatter 里会捣乱的字符。 */
function oneLine(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[:#]/g, '·')
    .trim()
    .slice(0, 120)
}

export function makeId(kind, name) {
  const hash = crypto.createHash('sha1').update(`${kind}:${oneLine(name)}`).digest('hex')
  return `rp_${hash.slice(0, 12)}`
}

function kindDir(root, kind) {
  const dir = KINDS[kind]
  if (!dir) throw new Error(`未知 kind「${kind}」，可选：${Object.keys(KINDS).join('/')}`)
  return path.join(root, dir)
}

function splitTags(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[,，\s]+/)
  return [...new Set(list.map((x) => oneLine(x)).filter(Boolean))].slice(0, 12)
}

function renderFile({ id, kind, name, tags, updated, body }) {
  const lines = [
    '---',
    `id: ${id}`,
    `kind: ${kind}`,
    `name: ${oneLine(name)}`,
    `tags: ${tags.join(',')}`,
    `updated: ${updated}`,
    '---',
    '',
    String(body ?? '').replace(/\r\n/g, '\n').trim(),
    '',
  ]
  return lines.join('\n')
}

function parseFile(text, file) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized)
  if (!match) {
    return { id: path.basename(file, '.md'), kind: 'note', name: path.basename(file, '.md'), tags: [], updated: '', body: normalized.trim(), file }
  }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return {
    id: meta.id || path.basename(file, '.md'),
    kind: KINDS[meta.kind] ? meta.kind : 'note',
    name: meta.name || path.basename(file, '.md'),
    tags: meta.tags ? meta.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    updated: meta.updated || '',
    body: match[2].trim(),
    file,
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function listFiles(root, kind) {
  const dir = kindDir(root, kind)
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'))
  } catch {
    return []
  }
  return names.map((n) => path.join(dir, n))
}

/** 保存或追加一条。追加时把新内容接在旧正文后面，保留时间顺序。 */
export function saveEntry(root, { kind, name, body, tags = [], mode = 'save' }) {
  if (!KINDS[kind]) throw new Error(`未知 kind「${kind}」，可选：${Object.keys(KINDS).join('/')}`)
  const title = oneLine(name)
  if (!title) throw new Error('name 不能为空')
  const text = String(body ?? '').trim()
  if (!text) throw new Error('body 不能为空')

  const dir = kindDir(root, kind)
  ensureDir(dir)
  const id = makeId(kind, title)
  const file = path.join(dir, `${id}.md`)
  const updated = new Date().toISOString()

  let finalBody = text
  let mergedTags = splitTags(tags)
  if (mode === 'append' && fs.existsSync(file)) {
    const prev = parseFile(fs.readFileSync(file, 'utf8'), file)
    finalBody = `${prev.body}\n\n${text}`.trim()
    mergedTags = [...new Set([...prev.tags, ...mergedTags])].slice(0, 12)
  }

  fs.writeFileSync(file, renderFile({ id, kind, name: title, tags: mergedTags, updated, body: finalBody }), 'utf8')
  return { id, kind, name: title, chars: finalBody.length, updated, mode }
}

export function readEntry(root, { id, name, kind }) {
  if (id) {
    for (const k of Object.keys(KINDS)) {
      const file = path.join(kindDir(root, k), `${id}.md`)
      if (fs.existsSync(file)) return parseFile(fs.readFileSync(file, 'utf8'), file)
    }
    return null
  }
  if (!name) throw new Error('read 需要 id 或 name')
  const kinds = kind && KINDS[kind] ? [kind] : Object.keys(KINDS)
  for (const k of kinds) {
    const file = path.join(kindDir(root, k), `${makeId(k, name)}.md`)
    if (fs.existsSync(file)) return parseFile(fs.readFileSync(file, 'utf8'), file)
  }
  return null
}

/** 列条目：只读 frontmatter，按更新时间倒序。 */
export function listEntries(root, { kind, limit = 50 } = {}) {
  const kinds = kind && KINDS[kind] ? [kind] : Object.keys(KINDS)
  const out = []
  for (const k of kinds) {
    for (const file of listFiles(root, k)) {
      try {
        const entry = parseFile(fs.readFileSync(file, 'utf8'), file)
        out.push({ id: entry.id, kind: entry.kind, name: entry.name, tags: entry.tags, updated: entry.updated, chars: entry.body.length })
      } catch {
        // 单个坏文件不影响整体
      }
    }
  }
  out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
  return out.slice(0, Math.max(1, Number(limit) || 50))
}

/** 关键词检索：名字/标签命中排前面，正文命中给一行片段。 */
export function recallEntries(root, { query, kind, limit = 8 } = {}) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (!needle) throw new Error('recall 需要 query')
  const kinds = kind && KINDS[kind] ? [kind] : Object.keys(KINDS)
  const hits = []
  for (const k of kinds) {
    for (const file of listFiles(root, k)) {
      let entry
      try {
        entry = parseFile(fs.readFileSync(file, 'utf8'), file)
      } catch {
        continue
      }
      const haystack = `${entry.name} ${entry.tags.join(' ')} ${entry.body}`.toLowerCase()
      if (!haystack.includes(needle)) continue
      const inTitle = entry.name.toLowerCase().includes(needle) || entry.tags.some((t) => t.toLowerCase().includes(needle))
      hits.push({
        id: entry.id,
        kind: entry.kind,
        name: entry.name,
        tags: entry.tags,
        updated: entry.updated,
        score: inTitle ? 2 : 1,
        snippet: snippetAround(entry.body, needle),
      })
    }
  }
  hits.sort((a, b) => b.score - a.score || String(b.updated).localeCompare(String(a.updated)))
  return hits.slice(0, Math.max(1, Number(limit) || 8))
}

function snippetAround(body, needle) {
  const flat = String(body).replace(/\s+/g, ' ')
  const at = flat.toLowerCase().indexOf(needle)
  if (at < 0) return flat.slice(0, 80)
  const start = Math.max(0, at - 40)
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + 100)}${start + 100 < flat.length ? '…' : ''}`
}

/** 删除即归档到 .trash，不真删。 */
export function forgetEntry(root, { id, name, kind }) {
  const entry = readEntry(root, { id, name, kind })
  if (!entry) return null
  const trash = path.join(root, '.trash')
  ensureDir(trash)
  const target = path.join(trash, `${entry.id}-${Date.now()}.md`)
  fs.renameSync(entry.file, target)
  return { id: entry.id, name: entry.name, kind: entry.kind, trashed: target }
}

/** 总览：各类条目数 + 每类最近若干条。给开场和每轮注入用。 */
export function digest(root, { perKind = 8 } = {}) {
  const byKind = {}
  const recent = []
  for (const k of Object.keys(KINDS)) {
    const entries = listEntries(root, { kind: k, limit: 9999 })
    byKind[k] = entries.length
    for (const entry of entries.slice(0, Math.max(1, Number(perKind) || 8))) recent.push(entry)
  }
  recent.sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
  return { root, byKind, total: Object.values(byKind).reduce((a, b) => a + b, 0), recent }
}
