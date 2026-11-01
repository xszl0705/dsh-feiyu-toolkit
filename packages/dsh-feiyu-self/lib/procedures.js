/**
 * Procedural Memory（程序性记忆）：记「这类情况该怎么处理」。
 *
 * 为什么单独一层：
 *  - semantic（memory）= 事实，episodic（dialog / decisions）= 发生了什么
 *  - procedural = 从「发生了什么」里提炼出的「下次该怎么做」
 *  - 没有这一层，M5 流水线每次都要重新踩同一个坑
 *
 * 第一版只用确定性规则，不调用模型：
 *  - 反复出现的失败模式 → 一条「经验」
 *  - 被回滚的改动 → 一条「别再这么做」
 *  - 保留下来且没回滚的改动 → 一条「这么做有效」
 *
 * 原则：**只提炼、只提示，不自动执行**。采纳与否仍然走 M5 的审批。
 */

import fs from 'node:fs'
import path from 'node:path'

const FAILURE_RE = /fail|reject|blocked|timeout|unavailable|expired/i

function hash(text) {
  let value = 0
  for (let i = 0; i < text.length; i += 1) value = (value * 31 + text.charCodeAt(i)) % 1_000_000_007
  return value.toString(36)
}

export function procedureId(trigger, action) {
  return `proc_${hash(`${trigger}|${action}`)}`
}

/**
 * 从决策日志提炼「反复失败」的经验。
 * 同一个 kind+choice 出现至少 minRepeats 次才成一条，避免一次偶发就下结论。
 */
export function extractFromDecisions({ decisions = [], minRepeats = 3 } = {}) {
  const counters = new Map()
  for (const row of decisions) {
    const kind = String(row?.kind || '')
    const choice = String(row?.choice || '')
    if (!kind || !choice || !FAILURE_RE.test(choice)) continue
    const key = `${kind}|${choice}`
    const entry = counters.get(key) || { kind, choice, count: 0, lastAt: '' }
    entry.count += 1
    if (String(row.at || '') > entry.lastAt) entry.lastAt = String(row.at || '')
    counters.set(key, entry)
  }
  const out = []
  for (const entry of counters.values()) {
    if (entry.count < minRepeats) continue
    const trigger = `${entry.kind} 反复出现 ${entry.choice}`
    const action = '先定位原因再重试，不要盲目重复同一动作'
    out.push({
      id: procedureId(trigger, action),
      kind: 'failure-pattern',
      trigger,
      conditions: [`kind:${entry.kind}`, `choice:${entry.choice}`],
      action,
      evidence: { count: entry.count, lastAt: entry.lastAt },
      outcome: { attempts: entry.count, failed: entry.count },
      confidence: Math.min(0.8, 0.3 + entry.count * 0.1),
      source: 'decisions',
      updatedAt: new Date().toISOString(),
    })
  }
  return out
}

/** 从变更记录提炼「改过之后怎么样」。 */
export function extractFromChanges({ changes = [] } = {}) {
  const out = []
  for (const change of changes) {
    if (!change?.id || !change?.title) continue
    if (change.status === 'rolled-back') {
      const trigger = `尝试过：${change.title}`
      const action = '这个方向已经失败过一次，先找原因再重试'
      out.push({
        id: procedureId(trigger, action),
        kind: 'reverted-change',
        trigger,
        conditions: change.diff ? Object.keys(change.diff).map((key) => `field:${String(key).split('.').pop()}`) : [],
        action,
        evidence: { changeId: change.id, rolledBackAt: change.rolledBackAt || '' },
        outcome: { attempts: 1, failed: 1 },
        confidence: 0.55,
        source: 'pipeline',
        updatedAt: new Date().toISOString(),
      })
      continue
    }
    if (change.status === 'applied') {
      const trigger = `做过：${change.title}`
      const action = '这个改动目前没被回滚，可以继续观察'
      out.push({
        id: procedureId(trigger, action),
        kind: 'kept-change',
        trigger,
        conditions: change.diff ? Object.keys(change.diff).map((key) => `field:${String(key).split('.').pop()}`) : [],
        action,
        evidence: { changeId: change.id, appliedAt: change.appliedAt || '' },
        outcome: { attempts: 1, failed: 0 },
        confidence: 0.5,
        source: 'pipeline',
        updatedAt: new Date().toISOString(),
      })
    }
  }
  return out
}

/** 同一 id 的合并：次数累加、置信度取高、保留最新证据。 */
export function mergeProcedures(existing = [], incoming = []) {
  const byId = new Map(existing.map((item) => [item.id, item]))
  for (const item of incoming) {
    const prev = byId.get(item.id)
    if (!prev) {
      byId.set(item.id, item)
      continue
    }
    byId.set(item.id, {
      ...prev,
      ...item,
      evidence: { ...prev.evidence, ...item.evidence },
      outcome: {
        attempts: Number(prev.outcome?.attempts || 0) + Number(item.outcome?.attempts || 0),
        failed: Number(prev.outcome?.failed || 0) + Number(item.outcome?.failed || 0),
      },
      confidence: Math.max(Number(prev.confidence) || 0, Number(item.confidence) || 0),
      updatedAt: item.updatedAt || prev.updatedAt,
    })
  }
  return [...byId.values()].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
}

/**
 * 用当前上下文匹配经验。
 * conditions 形如 `kind:route`、`field:variants`，命中 context 同名字段得 2 分，文本包含得 1 分。
 */
export function matchProcedures({ procedures = [], context = {}, limit = 5 } = {}) {
  const haystack = Object.values(context)
    .map((value) => String(value || ''))
    .join(' ')
    .toLowerCase()
  const scored = []
  for (const item of procedures) {
    let score = 0
    for (const condition of item.conditions || []) {
      const [key, value] = String(condition).split(':')
      if (!value) continue
      const actual = context[key]
      if (actual !== undefined && String(actual) === value) score += 2
      else if (haystack.includes(String(value).toLowerCase())) score += 1
    }
    if (score > 0) scored.push({ ...item, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Number(limit) || 5))
}

export function createProcedureStore({ dir, now = () => new Date() } = {}) {
  if (!dir) throw new Error('procedure dir is required')
  const file = path.join(dir, 'procedures.json')

  function list() {
    try {
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  function save(rows = []) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8')
    return rows
  }

  function extract({ decisions = [], changes = [], minRepeats = 3 } = {}) {
    const incoming = [...extractFromDecisions({ decisions, minRepeats }), ...extractFromChanges({ changes })]
    const merged = mergeProcedures(list(), incoming)
    return { procedures: save(merged), added: incoming.length }
  }

  return {
    dir,
    file,
    list,
    save,
    extract,
    merge: (incoming) => save(mergeProcedures(list(), incoming)),
    match: (context, limit) => matchProcedures({ procedures: list(), context, limit }),
    stats: () => {
      const rows = list()
      return {
        total: rows.length,
        byKind: rows.reduce((acc, row) => {
          acc[row.kind] = (acc[row.kind] || 0) + 1
          return acc
        }, {}),
        updatedAt: rows.reduce((latest, row) => (String(row.updatedAt || '') > latest ? String(row.updatedAt) : latest), ''),
      }
    },
  }
}
