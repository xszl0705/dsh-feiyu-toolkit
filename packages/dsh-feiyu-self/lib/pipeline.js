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
import { atomicWriteJson } from 'dsh-plugin-kit/atomic-write'

export const CHANGE_TTL_DAYS = 7
export const ALLOWED_FLAG_FIELDS = ['enabled', 'variants']
/** 1.5.2 单一候选制：同一时间只允许 1 个可应用候选在途。 */
export const MAX_ACTIVE_CHANGES = 1
/** 1.5.2 单次改动规模上限：代码补丁看行数，配置类候选看 JSON 字符数。 */
export const MAX_DIFF_LINES = 50
export const MAX_DIFF_CHARS = 2000
/**
 * 1.5.1 只把「像错误」的 load.log 行当诊断。
 * 「就绪 / 已注册 / 端点已注册」这类正常信息重复一百次也不是问题——
 * 不降噪的话，load.log 会把所有正常启动日志刷成诊断噪音。
 */
export const ERROR_HINT =
  /(失败|错误|异常|超时|未注册|拒绝|不可用|未就绪|ENOENT|EACCES|EPERM|ERR_|timeout|refused|denied|fail|\b40[0-9]\b|\b50[0-9]\b)/i

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
export function propose({ diagnoses = [], flags = [], procedures = [], active = [], now = new Date() } = {}) {
  const changes = []
  // 1.5.2：已有在途可应用候选时，本轮不再产出新的可应用候选，只留提醒
  const activeCount = (active || []).filter(
    (row) => row && row.actionable && ['proposed', 'approved', 'applied'].includes(String(row.status)),
  ).length
  const atCapacity = activeCount >= MAX_ACTIVE_CHANGES
  const flagMap = new Map(flags.map((flag) => [flag.name, flag]))
  const blocked = new Set(
    (procedures || [])
      .filter((item) => item?.kind === 'reverted-change')
      .map((item) => String(item.trigger || '').replace(/^尝试过：/, '')),
  )
  const push = (change) => {
    if (blocked.has(change.title)) return false
    // 在途已满：可应用候选降级为提醒，保留证据但不放行
    const item =
      atCapacity && change.actionable
        ? { ...change, actionable: false, downgradedFrom: 'actionable', blockedBy: `在途候选已达上限 ${MAX_ACTIVE_CHANGES} 个，先处理手上这个` }
        : change
    changes.push(item)
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
  // 1.5.2 改动规模：代码补丁看行数，配置类候选看 JSON 字符数（flag 改动序列化后永远单行）
  const patchLines = String(change.patch || '').split('\n').length
  if (change.patch && patchLines > MAX_DIFF_LINES) {
    return { ok: false, problems: [`补丁 ${patchLines} 行，超过上限 ${MAX_DIFF_LINES} 行（1.5.2）`] }
  }
  const diffChars = JSON.stringify(change.diff).length
  if (diffChars > MAX_DIFF_CHARS) {
    return { ok: false, problems: [`改动规模 ${diffChars} 字符，超过上限 ${MAX_DIFF_CHARS} 字符（1.5.2）`] }
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

/**
 * 1.5.1 诊断源聚合：load.log 错误码、回归失败项、未进 verify 的插件。
 * 纯规则、不调模型；入参由调用方提供，方便单独测试。
 */
export function diagnoseFromSources({ loadLogs = {}, verifyFailures = [], uncoveredPlugins = [] } = {}) {
  const found = []
  const push = (id, severity, text, evidence) => found.push({ id, severity, text, evidence })

  // 同一句在 load.log 出现 >=2 次才算模式；单次抖动只当噪音
  for (const [plugin, text] of Object.entries(loadLogs || {})) {
    const counts = new Map()
    for (const line of String(text || '').split(/\r?\n/)) {
      const body = line.replace(/^\S+\s+/, '').trim()
      if (!body) continue
      counts.set(body, (counts.get(body) || 0) + 1)
    }
    for (const [body, count] of counts) {
      if (count < 2) continue
      // 降噪：① 不像错误的不报；② 测试临时目录（.tmp-*）里的是测试残留，不进生产诊断
      if (!ERROR_HINT.test(body)) continue
      if (/\.tmp-/.test(body)) continue
      push(`loadlog:${plugin}`, 'warn', `${plugin} 的 load.log 里同一句出现 ${count} 次：${body.slice(0, 80)}`, [
        { source: 'load.log', plugin, count },
      ])
    }
  }
  for (const item of verifyFailures || []) {
    push(`verify-fail:${item?.name || 'unknown'}`, 'warn', `回归失败：${item?.name || 'unknown'}`, [{ source: 'verify', ...item }])
  }
  for (const plugin of uncoveredPlugins || []) {
    push(`uncovered:${plugin}`, 'info', `${plugin} 没进 verify 清单`, [{ source: 'verify-manifest', plugin }])
  }
  return found
}

/** 1.5.3 三重验证：三份证据各自出数，缺一项不许 apply。 */
export function tripleVerify({ target = null, migration = null, full = null } = {}) {
  const item = (name, row, label) => {
    if (!row) return { name, ok: false, detail: `缺${label}结果` }
    return { name, ok: Boolean(row.ok), detail: String(row.detail || row.output || row.summary || '') }
  }
  const items = [
    item('target', target, '目标修复用例'),
    item('migration', migration, '同类迁移子集'),
    item('full', full, '全量 verify'),
  ]
  const blockers = items.filter((row) => !row.ok).map((row) => `${row.name}: ${row.detail}`)
  const fullTally =
    full && Number.isFinite(full.pass) && Number.isFinite(full.total) ? { pass: full.pass, total: full.total } : null
  return { ok: blockers.length === 0, items, blockers, full: fullTally }
}

/** 1.5.4 变体档案：variants/<id>/ 下留 patch / diff / metrics，最多保留 keep 个。 */
export function archiveVariant({ dir, id, patch = '', diff = null, metrics = null, keep = 10 } = {}) {
  if (!dir || !id) throw new Error('archiveVariant 需要 dir 与 id')
  const root = path.join(dir, 'variants')
  const target = path.join(root, String(id))
  fs.mkdirSync(target, { recursive: true })
  if (patch) fs.writeFileSync(path.join(target, 'patch.diff'), String(patch), 'utf8')
  atomicWriteJson(path.join(target, 'diff.json'), diff ?? {})
  atomicWriteJson(path.join(target, 'metrics.json'), metrics ?? {})
  const all = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((row) => row.isDirectory())
    .map((row) => row.name)
    .sort()
  for (const name of all.slice(0, Math.max(0, all.length - keep))) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true })
  }
  return { dir: target, kept: Math.min(all.length, keep) }
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
    atomicWriteJson(changeFile, rows)
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
    // 1.5.3：带验证记录的候选必须三项全绿；老候选没带记录按原规则放行
    if (change.verification && change.verification.ok !== true) {
      return { ok: false, reason: '三重验证未通过：' + (change.verification.blockers || []).join('; ') }
    }

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
      const tag = backupTag()
      const backup = path.join(backupDir, `flags-${tag}.json`)
      atomicWriteJson(backup, current)
      atomicWriteJson(flagsFile, next)
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
    archiveVariant: (payload = {}) => archiveVariant({ dir, ...payload }),
    propose: ({ diagnoses, flags, procedures = [] }) => {
      const incoming = propose({ diagnoses, flags, procedures, active: readChanges(), now: now() })
      const rows = merge(incoming)
      return rows.filter((row) => incoming.some((item) => item.id === row.id))
    },
    report: ({ day, diagnoses }) => buildDailyReport({ day, diagnoses, changes: readChanges() }),
  }
}
