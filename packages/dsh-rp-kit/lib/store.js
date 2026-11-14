/**
 * 项目库存取。所有落盘都在 config.root 下，不放用户目录。
 *
 *   <root>/projects.json                 项目索引
 *   <root>/<project>/sources/*.md        切好的源文
 *   <root>/<project>/issues.json         问题台账
 *   <root>/<project>/reports/*.md        体检报告
 *   <root>/<project>/versions/*.md       改稿快照
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.resolve(HERE, '..')

const KINDS = ['rules', 'setting', 'outline', 'numbers', 'misc']
export const ALL_KINDS = KINDS

export function loadConfig() {
  const fallback = {
    root: path.join('E:\\', '工作区', 'rp-kit'),
    maxPacketChars: 24000,
    maxSourceSlicesPerPacket: 6,
    simTrialLimit: 50000,
  }
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'config.json'), 'utf8'))
  } catch {
    raw = {}
  }
  // 测试或换机时用 DSH_RP_KIT_ROOT 指到别处，优先级最高
  const envRoot = process.env.DSH_RP_KIT_ROOT
  return { ...fallback, ...raw, ...(envRoot ? { root: envRoot } : {}) }
}

export function rootDir(config = loadConfig()) {
  const dir = path.isAbsolute(config.root) ? config.root : path.resolve(PLUGIN_ROOT, config.root)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 项目名只允许中文、字母、数字、下划线、短横线，防止路径穿越。 */
export function cleanName(value) {
  const name = String(value || '').trim()
  if (!name) throw new Error('项目名不能为空')
  if (!/^[\u4e00-\u9fa5A-Za-z0-9_-]{1,40}$/.test(name)) {
    throw new Error('项目名只能用中文/字母/数字/_/-，1~40 字')
  }
  return name
}

function indexFile(config) {
  return path.join(rootDir(config), 'projects.json')
}

export function loadIndex(config = loadConfig()) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(config), 'utf8'))
    return raw && typeof raw === 'object' && raw.projects ? raw : { projects: {} }
  } catch {
    return { projects: {} }
  }
}

export function saveIndex(index, config = loadConfig()) {
  fs.writeFileSync(indexFile(config), JSON.stringify(index, null, 2), 'utf8')
}

export function projectDir(name, config = loadConfig()) {
  return path.join(rootDir(config), cleanName(name))
}

export function getProject(name, config = loadConfig()) {
  const index = loadIndex(config)
  const project = index.projects[cleanName(name)]
  if (!project) {
    const known = Object.keys(index.projects)
    throw new Error('项目不存在：' + name + (known.length ? '（已有：' + known.join('、') + '）' : '（还没有任何项目）'))
  }
  return project
}

export function createProject(name, title, config = loadConfig()) {
  const key = cleanName(name)
  const index = loadIndex(config)
  if (index.projects[key]) return { created: false, project: index.projects[key] }
  const dir = projectDir(key, config)
  for (const sub of ['sources', 'reports', 'versions']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const project = { name: key, title: String(title || key), createdAt: new Date().toISOString(), kinds: {} }
  index.projects[key] = project
  saveIndex(index, config)
  return { created: true, project }
}

export function listProjects(config = loadConfig()) {
  const index = loadIndex(config)
  return Object.values(index.projects).map((p) => ({
    name: p.name,
    title: p.title,
    createdAt: p.createdAt,
    kinds: p.kinds || {},
    issues: readIssues(p.name, config).length,
    open: readIssues(p.name, config).filter((i) => i.status === 'open').length,
  }))
}

/** 按 markdown 标题切章；没有标题就整段一章。 */
export function splitByHeading(content) {
  const text = String(content || '').replace(/\r\n/g, '\n').trim()
  if (!text) return []
  const lines = text.split('\n')
  const chapters = []
  let current = { title: '', lines: [] }
  for (const line of lines) {
    const match = /^(#{1,4})\s+(.+)$/.exec(line)
    if (match) {
      if (current.lines.length || current.title) chapters.push(current)
      current = { title: match[2].trim(), lines: [] }
    } else {
      current.lines.push(line)
    }
  }
  if (current.lines.length || current.title) chapters.push(current)
  return chapters
    .map((c, i) => ({ title: c.title || '片段 ' + (i + 1), text: c.lines.join('\n').trim() }))
    .filter((c) => c.text)
}

export function addSource(name, kind, title, content, config = loadConfig()) {
  const key = cleanName(name)
  const project = getProject(key, config)
  const safeKind = KINDS.includes(kind) ? kind : 'misc'
  const chapters = splitByHeading(content)
  if (!chapters.length) throw new Error('内容为空，没有可登记的正文')
  const dir = path.join(projectDir(key, config), 'sources')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const written = []
  chapters.forEach((chapter, i) => {
    const file = path.join(dir, stamp + '-' + safeKind + '-' + String(i + 1).padStart(2, '0') + '.md')
    const body = '# ' + chapter.title + '\n\n' + chapter.text
    fs.writeFileSync(file, body, 'utf8')
    written.push({ file: path.basename(file), title: chapter.title, chars: chapter.text.length, kind: safeKind })
  })
  const index = loadIndex(config)
  const entry = index.projects[key]
  entry.kinds[safeKind] = (entry.kinds[safeKind] || 0) + written.length
  entry.updatedAt = new Date().toISOString()
  entry.lastTitle = String(title || '').slice(0, 80)
  saveIndex(index, config)
  return { project: key, kind: safeKind, added: written.length, chapters: written }
}

export function listSources(name, kind, config = loadConfig()) {
  const key = cleanName(name)
  getProject(key, config)
  const dir = path.join(projectDir(key, config), 'sources')
  let entries = []
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  const matched = kind ? entries.filter((f) => f.includes('-' + kind + '-')) : entries
  return matched.sort().map((f) => {
    const full = path.join(dir, f)
    const text = fs.readFileSync(full, 'utf8')
    const firstLine = text.split('\n')[0] || ''
    return { file: f, title: firstLine.replace(/^#\s*/, ''), chars: text.length }
  })
}

export function readSources(name, kind, config = loadConfig()) {
  const key = cleanName(name)
  const dir = path.join(projectDir(key, config), 'sources')
  const files = listSources(key, kind, config)
  return files.map((f) => ({ ...f, text: fs.readFileSync(path.join(dir, f.file), 'utf8') }))
}

export function issuesFile(name, config = loadConfig()) {
  return path.join(projectDir(name, config), 'issues.json')
}

export function readIssues(name, config = loadConfig()) {
  try {
    const raw = JSON.parse(fs.readFileSync(issuesFile(name, config), 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

export function saveIssues(name, issues, config = loadConfig()) {
  fs.writeFileSync(issuesFile(name, config), JSON.stringify(issues, null, 2), 'utf8')
}

export function upsertIssue(name, issue, config = loadConfig()) {
  const issues = readIssues(name, config)
  const now = new Date().toISOString()
  const id = issue.id || 'I' + String(issues.length + 1).padStart(3, '0')
  const existing = issues.find((i) => i.id === id)
  const record = {
    id,
    severity: issue.severity || 'major',
    category: issue.category || 'rules',
    location: issue.location || '',
    quote: String(issue.quote || '').slice(0, 400),
    problem: issue.problem || '',
    suggestion: issue.suggestion || '',
    status: issue.status || 'open',
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  }
  if (existing) Object.assign(existing, record)
  else issues.push(record)
  saveIssues(name, issues, config)
  return record
}
