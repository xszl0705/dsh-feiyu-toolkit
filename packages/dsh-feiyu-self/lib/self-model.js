/**
 * Self Model：把「我是谁、会什么、不会什么、现在怎么样」变成可 diff 的结构化快照。
 *
 * 三条硬规则（来自技术方案 v1）：
 *  1. 纯函数：输入显式，输出可 diff，不读全局
 *  2. 拿不到就标 unknown，**不许推测填空**
 *  3. 能力清单来自真实声明/注册表，不手写
 */

import { createHash } from 'node:crypto'

export const UNKNOWN = 'unknown'

const iso = (value, fallback) => {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

export function emptySnapshot(now = new Date()) {
  const at = iso(now, new Date().toISOString())
  return {
    at,
    identity: { name: UNKNOWN, version: UNKNOWN, source: UNKNOWN },
    capabilities: [],
    limits: [],
    state: { channel: UNKNOWN, services: {}, lastError: '' },
    structure: { known: [], declared: [], missing: [] },
    causality: { decisions: 0, lastDecisionAt: '' },
    stale: { since: '', reasons: [] },
  }
}

function normalizeCapabilities(list = []) {
  return list
    .filter((item) => item && item.id)
    .map((item) => ({
      id: String(item.id),
      package: String(item.package || item.id),
      intent: String(item.intent || '').trim() || UNKNOWN,
      limits: Array.isArray(item.limits) ? item.limits.map(String).filter(Boolean) : [],
      failureModes: Array.isArray(item.failureModes) ? item.failureModes.map((mode) => ({
        code: String(mode?.code || UNKNOWN),
        meaning: String(mode?.meaning || ''),
        retry: String(mode?.retry || ''),
      })) : [],
      scope: Array.isArray(item.scope) ? item.scope.map(String) : [],
      declaredAt: iso(item.declaredAt, ''),
      source: item.source === 'declared' ? 'declared' : item.source === 'registry' ? 'registry' : UNKNOWN,
      degraded: item.limits?.length ? false : true,
      // 运行时状态由插件在 declare 时提供；没有就是 null，不猜。
      state: item.state && typeof item.state === 'object' ? item.state : null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

function normalizeLimits(list = []) {
  return list
    .filter((item) => item && item.text)
    .map((item) => ({
      id: String(item.id || item.text).slice(0, 80),
      text: String(item.text).slice(0, 200),
      kind: String(item.kind || 'declared'),
      source: String(item.source || ''),
      count: Number(item.count) || 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

function normalizeState(state = {}) {
  const services = {}
  for (const [name, value] of Object.entries(state.services || {})) services[name] = value ?? UNKNOWN
  return {
    channel: String(state.channel || UNKNOWN),
    services,
    lastError: String(state.lastError || ''),
  }
}

function normalizeStructure(structure = {}) {
  const known = (structure.known || []).map(String).sort()
  const declared = (structure.declared || []).map(String).sort()
  const declaredSet = new Set(declared)
  return {
    known,
    declared,
    missing: known.filter((id) => !declaredSet.has(id)),
  }
}

export function buildSnapshot({
  identity = {},
  capabilities = [],
  limits = [],
  state = {},
  structure = {},
  causality = {},
  stale = {},
  now = new Date(),
} = {}) {
  const at = iso(now, new Date().toISOString())
  return {
    at,
    identity: {
      name: String(identity.name || UNKNOWN),
      version: String(identity.version || UNKNOWN),
      source: String(identity.source || UNKNOWN),
    },
    capabilities: normalizeCapabilities(capabilities),
    limits: normalizeLimits(limits),
    state: normalizeState(state),
    structure: normalizeStructure(structure),
    causality: {
      decisions: Number(causality.decisions) || 0,
      lastDecisionAt: iso(causality.lastDecisionAt, ''),
    },
    stale: {
      since: iso(stale.since, ''),
      reasons: (stale.reasons || []).map(String),
    },
  }
}

export function snapshotHash(snapshot) {
  const body = JSON.stringify({ ...snapshot, at: '', stale: { ...snapshot.stale, since: '' } })
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}

/** 只比较「有意义的变化」，时间戳和 stale 时间不算变化。 */
export function diffSnapshot(prev, next) {
  const a = prev || emptySnapshot()
  const b = next || emptySnapshot()
  const capsA = new Map(a.capabilities.map((item) => [item.id, item]))
  const capsB = new Map(b.capabilities.map((item) => [item.id, item]))
  const added = [...capsB.keys()].filter((id) => !capsA.has(id))
  const removed = [...capsA.keys()].filter((id) => !capsB.has(id))
  const changed = []
  for (const [id, item] of capsB) {
    const before = capsA.get(id)
    if (before && JSON.stringify(before) !== JSON.stringify(item)) changed.push(id)
  }
  const serviceChanges = {}
  for (const key of new Set([...Object.keys(a.state.services), ...Object.keys(b.state.services)])) {
    const before = a.state.services[key]
    const after = b.state.services[key]
    if (JSON.stringify(before) !== JSON.stringify(after)) serviceChanges[key] = { before, after }
  }
  return {
    changed: added.length + removed.length + changed.length + Object.keys(serviceChanges).length > 0,
    added,
    removed,
    modified: changed,
    services: serviceChanges,
    missing: b.structure.missing,
  }
}

/**
 * 从声明与真实记录里算「边界」：不会做什么、什么时候不该信。
 * 只使用可观测事实，不使用模型自述。
 */
export function deriveLimits({ capabilities = [], decisions = {}, services = {} } = {}) {
  const limits = []
  for (const item of capabilities) {
    for (const text of item.limits || []) {
      limits.push({ id: `${item.id}:${text.slice(0, 40)}`, text, kind: 'declared', source: item.id })
    }
  }
  for (const [choice, count] of Object.entries(decisions.byChoice || {})) {
    if (!/reject|blocked|failed|timeout|unavailable/i.test(choice)) continue
    limits.push({ id: `runtime:${choice}`, text: `最近出现过 ${choice}（${count} 次）`, kind: 'observed', source: 'decisions', count })
  }
  for (const [name, value] of Object.entries(services)) {
    if (value === 'down' || value === 'unavailable') {
      limits.push({ id: `service:${name}`, text: `${name} 当前不可用，相关能力不能承诺`, kind: 'observed', source: 'state' })
    }
  }
  return limits
}
