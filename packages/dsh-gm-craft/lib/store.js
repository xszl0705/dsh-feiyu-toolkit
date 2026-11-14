/**
 * 项目库：一个项目 = 一个目录，四份 JSON。
 *
 *   <root>/<项目>/
 *     world.json     世界卡 + 元素表
 *     scenes.json    场景卡
 *     threads.json   剧情线
 *     beats.json     选择记录
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.resolve(HERE, '..')

const DEFAULT = {
  root: path.join('E:\\', '工作区', 'gm-craft'),
  maxWorldChars: 30000,
  minCluesPerScene: 3,
  postTargetChars: 200,
}

export function loadConfig() {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'config.json'), 'utf8'))
  } catch {
    raw = {}
  }
  const envRoot = process.env.DSH_GM_CRAFT_ROOT
  return { ...DEFAULT, ...raw, ...(envRoot ? { root: envRoot } : {}) }
}

export function rootDir(config = loadConfig()) {
  const dir = path.isAbsolute(config.root) ? config.root : path.resolve(PLUGIN_ROOT, config.root)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function cleanName(value) {
  const name = String(value || '').trim()
  if (!name) throw new Error('项目名不能为空')
  if (!/^[\u4e00-\u9fa5A-Za-z0-9_-]{1,40}$/.test(name)) {
    throw new Error('项目名只能用中文/字母/数字/_/-，1~40 字')
  }
  return name
}

export function projectDir(name, config = loadConfig()) {
  return path.join(rootDir(config), cleanName(name))
}

const FILES = { world: 'world.json', scenes: 'scenes.json', threads: 'threads.json', beats: 'beats.json' }

export function readState(name, kind, config = loadConfig()) {
  const file = path.join(projectDir(name, config), FILES[kind])
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function writeState(name, kind, value, config = loadConfig()) {
  const dir = projectDir(name, config)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, FILES[kind]), JSON.stringify(value, null, 2), 'utf8')
  return value
}

export function createProject(name, title, config = loadConfig()) {
  const dir = projectDir(name, config)
  fs.mkdirSync(dir, { recursive: true })
  const existing = readState(name, 'world', config)
  if (existing) return { created: false, world: existing }
  const world = {
    name: cleanName(name),
    title: String(title || name),
    rule: '',
    limits: [],
    geography: [],
    history: [],
    culture: [],
    daily: [],
    tags: [],
    elements: [],
    createdAt: new Date().toISOString(),
  }
  writeState(name, 'world', world, config)
  writeState(name, 'scenes', [], config)
  writeState(name, 'threads', [], config)
  writeState(name, 'beats', [], config)
  return { created: true, world }
}

export function requireProject(name, config = loadConfig()) {
  const world = readState(name, 'world', config)
  if (!world) {
    const known = listProjects(config).map((p) => p.name)
    throw new Error('项目不存在：' + name + (known.length ? '（已有：' + known.join('、') + '）' : ''))
  }
  return world
}

export function listProjects(config = loadConfig()) {
  const root = rootDir(config)
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const world = readState(entry.name, 'world', config)
    if (!world) continue
    out.push({
      name: world.name,
      title: world.title,
      rule: world.rule || '',
      elements: (world.elements || []).length,
      scenes: (readState(entry.name, 'scenes', config) || []).length,
    })
  }
  return out
}

let seq = 0
export function nextId(prefix) {
  seq += 1
  return prefix + '_' + Date.now().toString(36) + seq.toString(36)
}
