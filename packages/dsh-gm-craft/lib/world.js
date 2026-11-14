/** 世界卡：一条硬规则 + 四块（地理/历史/文化/日常）+ 元素表 + 激活。 */
import { nextId, readState, writeState } from './store.js'

export const TYPES = ['npc', 'place', 'faction', 'item', 'event', 'concept']

/** 建世界时用的空壳：字段都在，内容是空的——空的地方就是还没想清楚的地方。 */
export function blankWorld(name) {
  return {
    name,
    title: name,
    rule: '',
    limits: [],
    geography: [],
    history: [],
    culture: [],
    daily: [],
    tags: [],
    elements: [],
  }
}

function norm(text) {
  return String(text || '')
}

/** 一条硬规则：只在 init/set 时写，之后不允许"顺手改"。 */
export function setRule(name, rule, limits, config) {
  const world = readState(name, 'world', config) || blankWorld(name)
  const prev = world.rule
  world.rule = String(rule || '').trim()
  if (Array.isArray(limits)) world.limits = limits.map((x) => String(x).trim()).filter(Boolean)
  world.ruleChangedAt = new Date().toISOString()
  world.ruleChangedFrom = prev || null
  writeState(name, 'world', world, config)
  return { rule: world.rule, limits: world.limits, changedFrom: prev || null }
}

/**
 * 加一个世界元素。type 决定它进哪一类。
 * activation.keys 用于「提及自动召回」——这是从 SillyTavern World Info 借的机制。
 */
export function addElement(name, input, config) {
  const world = readState(name, 'world', config)
  if (!world) throw new Error('项目不存在：' + name)
  const type = TYPES.includes(input.type) ? input.type : 'concept'
  const el = {
    id: nextId('ent'),
    type,
    name: String(input.name || '').trim(),
    aliases: Array.isArray(input.aliases) ? input.aliases : [],
    tags: Array.isArray(input.tags) ? input.tags : [],
    fields: input.fields && typeof input.fields === 'object' ? input.fields : {},
    body: String(input.body || ''),
    relations: Array.isArray(input.relations) ? input.relations : [],
    progressions: Array.isArray(input.progressions) ? input.progressions : [],
    activation: {
      keys: Array.isArray(input.keys) && input.keys.length ? input.keys : [input.name].filter(Boolean),
      strategy: input.strategy === 'always' ? 'always' : 'keyword',
      group: input.group || null,
      weight: Number(input.weight) || 1,
    },
    visibility: input.visibility === 'player' ? 'player' : 'gm',
  }
  if (!el.name) throw new Error('元素需要有 name')
  world.elements = world.elements || []
  world.elements.push(el)

  // 同时按类型落到四块里，保证"地理/历史/文化"这些视图也有东西
  const bucket = type === 'place' || type === 'faction' ? 'geography' : type === 'event' ? 'history' : type === 'concept' ? 'culture' : null
  if (bucket) world[bucket] = [...(world[bucket] || []), { id: el.id, name: el.name, note: el.body.slice(0, 120) }]

  writeState(name, 'world', world, config)
  return el
}

/** 提及召回：给一段文本，返回该进上下文的元素（关键词命中 + always）。 */
export function activate(name, text, config) {
  const world = readState(name, 'world', config)
  if (!world) throw new Error('项目不存在：' + name)
  const hay = norm(text)
  const hits = []
  for (const el of world.elements || []) {
    if (el.activation?.strategy === 'always') {
      hits.push({ ...el, hitBy: 'always' })
      continue
    }
    const keys = el.activation?.keys || []
    const matched = keys.filter((k) => k && hay.includes(k))
    if (matched.length) hits.push({ ...el, hitBy: matched })
  }
  // relations 级联：从命中的元素出发，把它指向的元素也带出来（只带一层）
  const seen = new Set(hits.map((h) => h.id))
  const cascade = []
  for (const h of hits) {
    for (const rel of h.relations || []) {
      if (!rel?.to || seen.has(rel.to)) continue
      const target = (world.elements || []).find((e) => e.id === rel.to)
      if (target) {
        cascade.push({ ...target, hitBy: 'relation', from: h.name })
        seen.add(target.id)
      }
    }
  }
  return { hits, cascade }
}

/** 确定性体检——不用模型。 */
export function checkWorld(name, config) {
  const world = readState(name, 'world', config)
  if (!world) throw new Error('项目不存在：' + name)
  const issues = []
  if (!world.rule) issues.push({ level: 'blocker', msg: '缺核心规则（rule）——世界立不住' })
  if (!(world.daily || []).length) issues.push({ level: 'major', msg: '缺「普通人的一天」（daily）——世界摸不到' })
  if (!(world.geography || []).length) issues.push({ level: 'major', msg: '缺地理（geography）' })
  if ((world.elements || []).length === 0) issues.push({ level: 'major', msg: '一个元素都没有' })
  const noKeys = (world.elements || []).filter((e) => !(e.activation?.keys || []).length)
  if (noKeys.length) issues.push({ level: 'minor', msg: noKeys.length + ' 个元素没有激活关键词，永远不会被召回' })
  return { ok: issues.filter((i) => i.level === 'blocker').length === 0, issues, counts: { elements: (world.elements || []).length } }
}
