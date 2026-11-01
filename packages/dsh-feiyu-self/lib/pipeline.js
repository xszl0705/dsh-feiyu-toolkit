/**
 * Evolution Pipeline v0：发现问题 → 提候选 → 测试门禁 → 按天审批 → 灰度 → 回滚。
 *
 * 边界（写死在代码里）：
 *  - 候选只能改 flags.json 里的 enabled / variants
 *  - 不碰人设、manifest、config、代码、权限
 *  - 应用前备份，应用后写决策日志
 *  - 候选 7 天没批就作废，不无限堆积
 */

import fs from 'node:fs'
import path from 'node:path'

export const CHANGE_TTL_DAYS = 7
export const ALLOWED_FLAG_FIELDS = ['enabled', 'variants']

function pad(value) {
  return String(value).padStart(2, '0')
}

export function changeId(date = new Date(), seq = 0) {
  return `chg_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(seq)}`
}

/** 规则诊断：只用指标说话，不调用模型。 */
export function diagnose({ today = {}, comparison = {}, issues = [] } = {}) {
  const found = []
  const add = (id, severity, text, evidence) => found.push({ id, severity, text, evidence })

  const requests = Number(today?.volume?.requests) || 0
  const replies = Number(today?.volume?.replies) || 0
  const failed = Number(today?.volume?.failed) || 0
  const blocked = Number(today?.volume?.blocked) || 0

  if (requests > 0 && replies === 0) {
    add('no-reply', 'warn', '有请求但没有发出任何回复，先看是不是连接或限频问题', [{ metric: 'requests', value: requests }, { metric: 'replies', value: replies }])
  }
  if (failed > 3) {
    add('failures', 'warn', `今日失败 ${failed} 次，先定位错误类别再谈优化`, [{ metric: 'failed', value: failed }])
  }
  if (typeof today?.rates?.spamRate === 'number' && today.rates.spamRate > 0.3) {
    add('spam-high', 'warn', `同会话连发比例 ${(today.rates.spamRate * 100).toFixed(0)}%，偏高`, [{ metric: 'spamRate', value: today.rates.spamRate }])
  }
  if (blocked > 10) {
    add('blocked-high', 'info', `今日拦截 ${blocked} 次，确认拦截规则是否符合预期`, [{ metric: 'blocked', value: blocked }])
  }
  for (const [metric, row] of Object.entries(comparison || {})) {
    if (row?.direction !== 'up' || !Number.isFinite(row.z) || row.z < 2) continue
    if (metric === 'latency.p95' || metric === 'cost.tokensPerReply') {
      add(`regress:${metric}`, 'warn', `${metric} 比基线高 ${row.z.toFixed(1)} 个标准差`, [{ metric, value: row.value, baseline: row.mean }])
    }
  }
  if (issues.length) found.push(...issues)
  return found
}

/**
 * 由诊断生成候选。
 * v0 只生成「开关/权重」类候选：没有可行动的 flag 时直接返回空数组，不硬凑。
 *
 * procedures（程序性记忆）里标记为「已回滚」的方向会被跳过——
 * 这是 M6 对 M5 的唯一影响：别重复提一个已经失败过的方案。
 */
export function propose({ diagnoses = [], flags = [], procedures = [], now = new Date() } = {}) {
  const changes = []
  const flagMap = new Map(flags.map((flag) => [flag.name, flag]))
  const blocked = new Set(
    (procedures || [])
      .filter((item) => item?.kind === 'reverted-change')
      .map((item) => String(item.trigger || '').replace(/^尝试过：/, '')),
  )
  const push = (change) => {
    if (blocked.has(change.title)) return false
    changes.push(change)
    seq += 1
    return true
  }
  let seq = 1

  for (const issue of diagnoses) {
    if (issue.severity !== 'warn') continue
    if (issue.id === 'failures' || issue.id === 'no-reply') {
      // 这类问题不是「调个参数」能解决的，只出提醒，不生成可应用候选
      push({
        id: changeId(now, seq),
        at: now.toISOString(),
        kind: 'diagnosis',
        title: `排查：${issue.text}`,
        evidence: issue.evidence,
        diff: null,
        risk: 'none',
        actionable: false,
        status: 'proposed',
        expiresAt: new Date(now.getTime() + CHANGE_TTL_DAYS * 86_400_000).toISOString(),
      })
      continue
    }
    if (issue.id === 'spam-high') {
      const target = flagMap.get('qq.groupRate')
      push({
        id: changeId(now, seq),
        at: now.toISOString(),
        kind: 'flag',
        title: target ? '把群参与率降到 90%（灰度）' : '建议新增 qq.groupRate flag 控制群参与频率',
        evidence: issue.evidence,
        diff: target ? { 'qq.groupRate.variants': { control: 90, reduced: 10 } } : null,
        risk: 'low',
        actionable: Boolean(target),
        status: 'proposed',
        expiresAt: new Date(now.getTime() + CHANGE_TTL_DAYS * 86_400_000).toISOString(),
      })
      continue
    }
    if (issue.id.startsWith('regress:')) {
      push({
        id: changeId(now, seq),
        at: now.toISOString(),
        kind: 'diagnosis',
        title: `观察：${issue.text}`,
        evidence: issue.evidence,
        diff: null,
        risk: 'none',
        actionable: false,
        status: 'proposed',
        expiresAt: new Date(now.getTime() + CHANGE_TTL_DAYS * 86_400_000).toISOString(),
      })
    }
  }
  return changes
}

/** 候选合法性：只允许改 flag 的 enabled / variants，且权重必须合计 100。 */
export function validateChange(change) {
  if (!change || typeof change !== 'object') return { ok: false, problems: ['不是一个对象'] }
  if (!change.id) return { ok: false, problems: ['缺 id'] }
  if (change.kind !== 'flag') return { ok: true, problems: [], actionable: false }
  if (!change.diff || typeof change.diff !== 'object') return { ok: false, problems: ['flag 候选缺 diff'] }
  for (const key of Object.keys(change.diff)) {
    const field = String(key).split('.').pop()
    if (!ALLOWED_FLAG_FIELDS.includes(field)) {
      return { ok: false, problems: [`字段 ${key} 不在允许范围（只允许 enabled / variants）`] }
    }
    if (field === 'variants') {
      const weights = Object.values(change.diff[key] || {})
      const total = weights.reduce((sum, weight) => sum + (Number(weight) || 0), 0)
      if (Math.abs(total - 100) > 1e-6) return { ok: false, problems: [`${key} 权重合计应为 100，当前 ${total}`] }
    }
  }
  return { ok: true, problems: [], actionable: true }
}

export function buildDailyReport({ day, diagnoses = [], changes = [] } = {}) {
  const lines = [`# ${day} 自进化日报`, '']
  lines.push(`## 诊断（${diagnoses.length}）`)
  if (!diagnoses.length) lines.push('今天没有发现值得处理的问题。')
  for (const item of diagnoses) lines.push(`- [${item.severity}] ${item.text}`)
  lines.push('', `## 候选（${changes.length}）`)
  if (!changes.length) lines.push('没有可自动应用的候选。')
  for (const change of changes) {
    const action = change.actionable ? '可应用' : '仅提醒'
    lines.push(`- ${change.id} · ${action} · ${change.title}（${change.status}）`)
    if (change.diff) lines.push('  ```json\n  ' + JSON.stringify(change.diff) + '\n  ```')
  }
  lines.push('', '---', '审批：`self action=evolve op=approve id=<id>`，拒绝用 `op=reject`。7 天没批自动作废。')
  return lines.join('\n')
}

export function expireOld(changes = [], now = new Date()) {
  return changes.map((change) => {
    if (change.status !== 'proposed') return change
    const expires = new Date(change.expiresAt || 0)
    if (Number.isFinite(expires.getTime()) && expires.getTime() < now.getTime()) {
      return { ...change, status: 'expired', expiredAt: now.toISOString() }
    }
    return change
  })
}

/**
 * 文件存储 + 应用/回滚。
 * 应用只写 flags.json；备份放在 evolve/backups/ 下，回滚就是拷回来。
 */
export function createPipeline({ dir, flagsFile, now = () => new Date() } = {}) {
  if (!dir) throw new Error('pipeline dir is required')
  const changeFile = path.join(dir, 'changes.json')
  const backupDir = path.join(dir, 'backups')

  function readChanges() {
    try {
      const rows = JSON.parse(fs.readFileSync(changeFile, 'utf8'))
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  function writeChanges(rows) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(changeFile, JSON.stringify(rows, null, 2), 'utf8')
  }

  function merge(incoming = []) {
    const rows = expireOld(readChanges(), now())
    const byId = new Map(rows.map((row) => [row.id, row]))
    for (const change of incoming) {
      if (!byId.has(change.id)) byId.set(change.id, change)
    }
    const next = [...byId.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)))
    writeChanges(next)
    return next
  }

  function update(id, patch) {
    const rows = readChanges()
    const index = rows.findIndex((row) => row.id === id)
    if (index < 0) return { ok: false, reason: 'not-found' }
    rows[index] = { ...rows[index], ...patch }
    writeChanges(rows)
    return { ok: true, change: rows[index] }
  }

  function backupTag() {
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    return `${stamp}`
  }

  function apply(id) {
    const rows = readChanges()
    const change = rows.find((row) => row.id === id)
    if (!change) return { ok: false, reason: 'not-found' }
    if (change.status !== 'approved') return { ok: false, reason: `status=${change.status}，需要先审批` }
    const check = validateChange(change)
    if (!check.ok) return { ok: false, reason: check.problems.join('; ') }
    if (!check.actionable) return { ok: false, reason: '这个候选只是提醒，不能自动应用' }

    let current = {}
    try {
      current = JSON.parse(fs.readFileSync(flagsFile, 'utf8'))
    } catch {
      current = {}
    }
    const next = structuredClone(current)
    for (const [key, value] of Object.entries(change.diff || {})) {
      // flag 名本身可能带点（qq.groupRate），字段取最后一段
      const index = key.lastIndexOf('.')
      if (index <= 0) continue
      const flagName = key.slice(0, index)
      const field = key.slice(index + 1)
      next[flagName] = { ...(next[flagName] || {}), [field]: value }
    }

    try {
      fs.mkdirSync(backupDir, { recursive: true })
      const tag = backupTag()
      const backup = path.join(backupDir, `flags-${tag}.json`)
      fs.writeFileSync(backup, JSON.stringify(current, null, 2), 'utf8')
      fs.mkdirSync(path.dirname(flagsFile), { recursive: true })
      fs.writeFileSync(flagsFile, JSON.stringify(next, null, 2), 'utf8')
      const result = update(id, { status: 'applied', appliedAt: now().toISOString(), backup })
      return { ok: true, change: result.change, backup }
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) }
    }
  }

  function rollback(id) {
    const rows = readChanges()
    const change = rows.find((row) => row.id === id)
    if (!change) return { ok: false, reason: 'not-found' }
    if (change.status !== 'applied') return { ok: false, reason: `status=${change.status}，只有已应用的能回滚` }
    if (!change.backup || !fs.existsSync(change.backup)) return { ok: false, reason: '备份文件不在了' }
    try {
      fs.copyFileSync(change.backup, flagsFile)
      const result = update(id, { status: 'rolled-back', rolledBackAt: now().toISOString() })
      return { ok: true, change: result.change }
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) }
    }
  }

  return {
    dir,
    flagsFile,
    list: () => expireOld(readChanges(), now()),
    merge,
    update,
    apply,
    rollback,
    propose: ({ diagnoses, flags, procedures = [] }) => {
      const incoming = propose({ diagnoses, flags, procedures, now: now() })
      const rows = merge(incoming)
      return rows.filter((row) => incoming.some((item) => item.id === row.id))
    },
    report: ({ day, diagnoses }) => buildDailyReport({ day, diagnoses, changes: readChanges() }),
  }
}
