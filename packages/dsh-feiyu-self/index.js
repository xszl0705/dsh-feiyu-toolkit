/**
 * dsh-feiyu-self — Self Model 与决策日志。
 *
 * 目标：让「我会什么、不会什么、最近改了什么、为什么」变成可查询的结构化数据。
 * 原则：只从真实声明/探测生成；拿不到就写 unknown，不猜。
 *
 * 自进化方案 v1 的 M0 + M1：docs/self-evolving-harness-tech-v1.md
 */

import fs from 'node:fs'
import { note as kitNote } from 'dsh-plugin-kit/note'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lifecycle } from 'dsh-plugin-kit/lifecycle'
import { createDecisionLog, dayKey } from './lib/decisions.js'
import { buildSnapshot, deriveLimits, diffSnapshot, snapshotHash, UNKNOWN } from './lib/self-model.js'
import { adoptVerdict, buildBaseline, collectDay, compare } from './lib/metrics.js'
import { createFlagStore, DEFAULT_FLAGS } from './lib/variants.js'
import { createPipeline, diagnose, diagnoseFromSources } from './lib/pipeline.js'
import { createProcedureStore } from './lib/procedures.js'
import { atomicWrite } from 'dsh-plugin-kit/atomic-write'

export const name = 'dsh-feiyu-self'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVICE_KEY = Symbol.for('dsh-feiyu-self.service')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SELF_DIR = path.join(DSH_HOME, 'dafeiyu', 'self')
const SNAPSHOT_FILE = path.join(SELF_DIR, 'snapshot.json')
const CAPABILITIES_FILE = path.join(SELF_DIR, 'capabilities.json')
const CHANGELOG_FILE = path.join(SELF_DIR, 'changelog.jsonl')
const STATS_DIR = path.join(DSH_HOME, 'dafeiyu', 'stats')
const DECISIONS_DIR = path.join(DSH_HOME, 'dafeiyu', 'decisions')
const FLAGS_FILE = path.join(DSH_HOME, 'dafeiyu', 'flags.json')
const MAX_DECISIONS_HISTORY = 1000

// 指标变好是往哪个方向：用于采纳规则，不参与计算本身。
const BETTER_DIRECTION = {
  'rates.replyRate': 'up',
  'rates.spamRate': 'down',
  'rates.blockRate': 'down',
  'rates.autostartSuccess': 'up',
  'cost.tokensPerReply': 'down',
  'latency.p50': 'down',
  'latency.p95': 'down',
}

const DEFAULTS = {
  enabled: true,
  snapshotIntervalMinutes: 10,
  knownPlugins: [],
  identityVersion: '',
  channel: 'dsh',
  identityName: '大肥鱼',
}

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function note(message) {
  kitNote(HERE, message)
}

function safeWrite(file, content) {
  try {
    atomicWrite(file, content)
    return true
  } catch {
    return false
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function readJsonl(file) {
  const rows = []
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        // 坏行跳过
      }
    }
  } catch {
    // 文件不存在
  }
  return rows
}

/** 按日期连续生成 dayKey，从旧到新，最后一个是今天。 */
function dayKeys(count, end = new Date()) {
  const total = Math.max(1, Math.min(30, Number(count) || 7))
  const out = []
  for (let i = total - 1; i >= 0; i -= 1) out.push(dayKey(new Date(end.getTime() - i * 86_400_000)))
  return out
}

function state(ctx) {
  return lifecycle(ctx, () => ({
    started: false,
    toolsInstalled: false,
    declared: new Map(),
    stateReaders: new Map(),
    snapshot: null,
    lastDecisionAt: '',
    lastError: '',
    staleSince: '',
    refreshedAt: '',
    decisions: null,
    log: null,
    pipeline: null,
    procedureStore: null,
  }))
}

function probeServices(ctx) {
  const out = {}
  for (const name of ['tools', 'webServer', 'memory', 'dialog', 'brain', 'llm', 'deepseekAccount']) {
    try {
      const value = ctx?.get?.(name)
      out[name] = value ? 'up' : 'down'
    } catch {
      out[name] = UNKNOWN
    }
  }
  return out
}

function persistCapabilities(st) {
  const rows = [...st.declared.values()].map((item) => ({
    id: item.id,
    package: item.package,
    intent: item.intent,
    limits: item.limits,
    failureModes: item.failureModes,
    scope: item.scope,
    declaredAt: item.declaredAt,
    source: item.source,
  }))
  return safeWrite(CAPABILITIES_FILE, JSON.stringify(rows, null, 2))
}

function loadDeclaredCapabilities(st) {
  // 文件不存在 = 第一次装，不算失败；解析失败才算 stale。
  if (!fs.existsSync(CAPABILITIES_FILE)) return
  const rows = readJson(CAPABILITIES_FILE, null)
  if (!Array.isArray(rows)) {
    st.staleSince = new Date().toISOString()
    return
  }
  for (const row of rows) {
    if (!row?.id) continue
    st.declared.set(String(row.id), {
      id: String(row.id),
      package: String(row.package || row.id),
      intent: String(row.intent || ''),
      limits: Array.isArray(row.limits) ? row.limits : [],
      failureModes: Array.isArray(row.failureModes) ? row.failureModes : [],
      scope: Array.isArray(row.scope) ? row.scope : [],
      declaredAt: String(row.declaredAt || ''),
      source: row.source === 'registry' ? 'registry' : 'declared',
    })
  }
}

function loadOwnCapability() {
  return readJson(path.join(HERE, 'capability.json'), null)
}

/**
 * 扫描各插件目录里的 capability.json。
 * 这是「声明」而非「探测」：文件存在即声明，运行时 declare 会覆盖同 id 的项。
 */
export function scanCapabilityFiles(roots = []) {
  const found = []
  for (const root of roots) {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const data = readJson(path.join(root, entry.name, 'capability.json'), null)
      if (data?.id) found.push({ ...data, source: 'declared' })
    }
  }
  return found
}

export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const st = state(ctx)
    st.lastError = String((error && error.message) || error)
    note('apply 抛错：' + st.lastError)
    return undefined
  }
}

function applyInner(ctx) {
  const st = state(ctx)
  if (st.started) return
  const config = loadConfig()
  if (config.enabled === false) {
    note('配置关闭，跳过')
    return
  }
  st.started = true

  loadDeclaredCapabilities(st)
  st.log = createDecisionLog({ root: path.join(DSH_HOME, 'dafeiyu'), retentionDays: 30 })

  const api = createApi(st, ctx, config)
  // 先扫各插件的 capability.json，再声明自己（同 id 后者覆盖前者）。
  for (const item of scanCapabilityFiles(config.pluginRoots)) api.declare(item)
  const own = loadOwnCapability()
  if (own?.id) {
    api.declare({
      ...own,
      source: 'declared',
      state: () => ({
        snapshotAt: st.snapshot?.at || '',
        decisionsToday: st.log?.tally({ days: 1 }).total || 0,
        capabilities: st.declared.size,
        procedures: st.procedureStore?.stats?.().total || 0,
      }),
    })
  }
  try {
    if (typeof ctx.provide === 'function') ctx.provide('self', api)
  } catch {
    // 宿主可能不认这个服务名
  }
  globalThis[SERVICE_KEY] = api
  st.own(() => {
    if (globalThis[SERVICE_KEY] === api) delete globalThis[SERVICE_KEY]
  })

  const tools = ctx.get?.('tools')
  if (!tools || typeof tools.register !== 'function') {
    if (!st.toolsSince) st.toolsSince = Date.now()
    if (!st.toolsWaiting && Date.now() - st.toolsSince < 60000) {
      st.toolsWaiting = true
      st.later(() => {
        st.toolsWaiting = false
        st.started = false
        try {
          applyInner(ctx)
        } catch (error) {
          note('重试注册工具失败：' + String((error && error.message) || error))
        }
      }, 250)
    } else if (!st.toolsWaiting) {
      note('60s 内没等到 tools 服务，self 工具未注册')
    }
    return
  }

  if (!st.toolsInstalled) {
    st.toolsInstalled = true
    ctx.effect(() => {
      const handles = createTools(api).map((tool) => tools.register(tool))
      return () => {
        for (const handle of handles) {
          try {
            handle?.dispose?.()
          } catch {
            // 释放失败不抛
          }
        }
      }
    })
  }

  api.refresh('apply')
  const interval = Math.max(1, Number(config.snapshotIntervalMinutes) || 10) * 60_000
  const tick = () => {
    if (st.disposed) return
    api.refresh('timer')
    const next = st.later(tick, interval)
    next?.unref?.()
  }
  const timer = st.later(tick, interval)
  timer?.unref?.()
  note(`dsh-feiyu-self 就绪（已知插件 ${config.knownPlugins.length} 个，已声明 ${st.declared.size} 个）`)
}

function createApi(st, ctx, config) {
  const flags = createFlagStore({ file: FLAGS_FILE, fallback: DEFAULT_FLAGS })

  /** 读插件的运行时状态；抛错就记下来，不阻塞快照。 */
  function readState(id) {
    const reader = st.stateReaders.get(id)
    if (typeof reader !== 'function') return null
    try {
      const value = reader()
      if (value && typeof value === 'object') return value
      return { value: String(value) }
    } catch (error) {
      return { error: String((error && error.message) || error).slice(0, 120) }
    }
  }

  function declare(manifest = {}) {
    if (st.disposed) return { ok: false, reason: 'disposed' }
    const id = String(manifest.id || '').trim()
    if (!id) return { ok: false, reason: 'id is required' }
    const item = {
      id,
      package: String(manifest.package || id).trim(),
      intent: String(manifest.intent || '').trim(),
      limits: Array.isArray(manifest.limits) ? manifest.limits.map(String).filter(Boolean).slice(0, 20) : [],
      failureModes: Array.isArray(manifest.failureModes) ? manifest.failureModes.slice(0, 20) : [],
      scope: Array.isArray(manifest.scope) ? manifest.scope.map(String).slice(0, 10) : [],
      declaredAt: new Date().toISOString(),
      source: manifest.source === 'registry' ? 'registry' : 'declared',
    }
    // state 是函数，只能活在内存里，不能写进 capabilities.json
    if (typeof manifest.state === 'function') st.stateReaders.set(id, manifest.state)
    st.declared.set(id, item)
    persistCapabilities(st)
    return { ok: true, declared: item }
  }

  function record(entry = {}) {
    if (st.disposed) return { ok: false, reason: 'disposed' }
    const result = st.log.record(entry)
    if (result.ok) st.lastDecisionAt = result.row.at
    return result
  }

  function refresh(reason = 'manual') {
    if (st.disposed) return st.snapshot
    try {
      const now = new Date()
      const capabilities = [...st.declared.values()].map((item) => ({ ...item, state: readState(item.id) }))
      const services = probeServices(ctx)
      const decisions = st.log.tally({ days: 7, now })
      const limits = deriveLimits({ capabilities, decisions, services })
      const next = buildSnapshot({
        identity: { name: config.identityName, version: config.identityVersion || UNKNOWN, source: 'config' },
        capabilities,
        limits,
        state: { channel: config.channel, services, lastError: st.lastError },
        structure: { known: config.knownPlugins, declared: capabilities.map((item) => item.package || item.id) },
        causality: { decisions: decisions.total, lastDecisionAt: st.lastDecisionAt },
        stale: st.staleSince ? { since: st.staleSince, reasons: ['capabilities.json 读取失败，使用内存声明'] } : {},
        now,
      })
      const prev = st.snapshot
      st.snapshot = next
      st.refreshedAt = next.at
      safeWrite(SNAPSHOT_FILE, JSON.stringify(next, null, 2))
      const diff = diffSnapshot(prev, next)
      if (!prev || diff.changed) {
        try {
          fs.mkdirSync(SELF_DIR, { recursive: true })
          fs.appendFileSync(CHANGELOG_FILE, JSON.stringify({ at: next.at, reason, hash: snapshotHash(next), diff }) + '\n', 'utf8')
        } catch {
          // changelog 写不了不影响快照
        }
      }
      return next
    } catch (error) {
      st.lastError = String((error && error.message) || error)
      note('生成快照失败：' + st.lastError)
      return st.snapshot
    }
  }

  function history({ days = 7, kind = '', limit = 20 } = {}) {
    return st.log.query({ days, kind, limit })
  }

  function status() {
    const snapshot = st.snapshot || refresh('status')
    const missing = snapshot?.structure?.missing || []
    let cache = null
    try {
      cache = ctx.get?.('dialog')?.stats?.() || null
    } catch {
      cache = null
    }
    return {
      at: snapshot?.at || '',
      identity: snapshot?.identity || { name: UNKNOWN, version: UNKNOWN, source: UNKNOWN },
      declared: snapshot?.capabilities?.length || 0,
      known: snapshot?.structure?.known?.length || 0,
      missing,
      services: snapshot?.state?.services || {},
      lastError: st.lastError,
      cache,
    }
  }

  function check() {
    const snapshot = st.snapshot
    const ageMs = snapshot ? Date.now() - new Date(snapshot.at).getTime() : null
    const problems = []
    if (!snapshot) problems.push('还没有生成过快照')
    if (snapshot && ageMs > Math.max(2, Number(config.snapshotIntervalMinutes) || 10) * 60_000 * 3) problems.push('快照过期')
    if (st.staleSince) problems.push('capabilities.json 读取失败')
    for (const id of snapshot?.structure?.missing || []) problems.push(`插件 ${id} 还没声明能力`)
    for (const cap of snapshot?.capabilities || []) {
      if (cap.degraded) problems.push(`${cap.id} 缺少 limits 声明`)
    }
    return {
      ok: problems.length === 0,
      snapshotAt: snapshot?.at || '',
      ageMinutes: ageMs === null ? null : Math.round(ageMs / 60000),
      declared: snapshot?.capabilities?.length || 0,
      known: snapshot?.structure?.known?.length || 0,
      missing: snapshot?.structure?.missing || [],
      problems,
    }
  }

  function metrics({ days = 7 } = {}) {
    const keys = dayKeys(days)
    const daily = keys.map((day) =>
      collectDay({
        day,
        stats: readJsonl(path.join(STATS_DIR, `${day}.jsonl`)),
        decisions: readJsonl(path.join(DECISIONS_DIR, `${day}.jsonl`)),
      }),
    )
    const today = daily[daily.length - 1]
    // 基线用「今天之前」的天，避免拿今天和自己比。
    const baseline = buildBaseline({ daily: daily.slice(0, -1), windowDays: 7, minSamples: 3 })
    const comparison = compare({ today, baseline })
    const verdict = adoptVerdict({ comparison, betterDirection: BETTER_DIRECTION })
    return {
      today,
      baseline,
      comparison,
      verdict,
      missing: today?.missing || [],
      days: keys,
    }
  }

  /**
   * 1.5.1 收集诊断源：各插件 load.log 的最后 200 行 + 未进 verify 清单的插件。
   * 只读、失败静默——诊断源收集不能拖垮 evolve。
   */
  function collectDiagnosisSources() {
    const pluginsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    const loadLogs = {}
    let uncoveredPlugins = []
    try {
      const pkgs = fs
        .readdirSync(pluginsDir, { withFileTypes: true })
        .filter((row) => row.isDirectory() && /^dsh-/.test(row.name))
        .map((row) => row.name)
      for (const name of pkgs) {
        const file = path.join(pluginsDir, name, 'load.log')
        if (!fs.existsSync(file)) continue
        const text = fs.readFileSync(file, 'utf8')
        loadLogs[name] = text.split('\n').slice(-200).join('\n')
      }
      const verifyFile = path.join(pluginsDir, 'tests', 'verify.mjs')
      if (fs.existsSync(verifyFile)) {
        const manifest = fs.readFileSync(verifyFile, 'utf8')
        uncoveredPlugins = pkgs.filter((name) => !manifest.includes(name))
      }
    } catch {
      // 收集失败就只报原有诊断
    }
    return { loadLogs, uncoveredPlugins }
  }

  function evolve({ action = 'list', id = '' } = {}) {
    st.pipeline ||= createPipeline({ dir: path.join(DSH_HOME, 'dafeiyu', 'evolve'), flagsFile: FLAGS_FILE })
    const pipeline = st.pipeline
    const now = new Date()
    const currentDiagnoses = () => {
      const result = metrics({ days: 7 })
      const base = diagnose({ today: result.today, comparison: result.comparison })
      // 1.5.1：再接三路诊断源——各插件 load.log 的错误模式、未进 verify 清单的插件
      try {
        return [...base, ...diagnoseFromSources(collectDiagnosisSources())]
      } catch {
        return base
      }
    }
    try {
      if (action === 'propose') {
        const diagnoses = currentDiagnoses()
        const procedures = st.procedureStore?.list?.() || []
        const changes = pipeline.propose({ diagnoses, flags: flags.list(), procedures })
        return { action, ok: true, count: changes.length, changes, diagnoses, procedures: procedures.length }
      }
      if (action === 'report') {
        const diagnoses = currentDiagnoses()
        return { action, ok: true, report: pipeline.report({ day: dayKey(now), diagnoses }) }
      }
      if (action === 'list') {
        return { action, ok: true, changes: pipeline.list() }
      }
      if (action === 'approve' || action === 'reject') {
        const result = pipeline.update(id, {
          status: action === 'approve' ? 'approved' : 'rejected',
          [action === 'approve' ? 'approvedAt' : 'rejectedAt']: now.toISOString(),
        })
        if (result.ok) record({ kind: 'deploy', choice: action === 'approve' ? 'approved' : 'rejected', reason: id })
        return { action, ok: result.ok, change: result.change, reason: result.reason }
      }
      if (action === 'apply') {
        const result = pipeline.apply(id)
        if (result.ok) record({ kind: 'deploy', choice: 'applied', reason: id })
        return { action, ok: result.ok, change: result.change, reason: result.reason, backup: result.backup }
      }
      if (action === 'rollback') {
        const result = pipeline.rollback(id)
        if (result.ok) record({ kind: 'deploy', choice: 'rolled-back', reason: id })
        return { action, ok: result.ok, change: result.change, reason: result.reason }
      }
      return { action, ok: false, reason: 'unknown-action' }
    } catch (error) {
      return { action, ok: false, reason: String(error?.message || error) }
    }
  }

  /**
   * 程序性记忆：从决策日志和变更记录里提炼「这类情况该怎么办」。
   * 只提炼、只提示，不自动执行。
   */
  function procedures({ action = 'list', context = {}, minRepeats = 3 } = {}) {
    st.procedureStore ||= createProcedureStore({ dir: path.join(DSH_HOME, 'dafeiyu', 'procedures') })
    const store = st.procedureStore
    try {
      if (action === 'extract') {
        const decisions = st.log.query({ days: 30, limit: 1000 })
        const changes = st.pipeline?.list?.() || []
        const result = store.extract({ decisions, changes, minRepeats: Number(minRepeats) || 3 })
        record({ kind: 'reflection', choice: 'procedures-extracted', outcome: `added=${result.added}` })
        return { action, ok: true, added: result.added, total: result.procedures.length, procedures: result.procedures }
      }
      if (action === 'match') {
        return { action, ok: true, matched: store.match(context) }
      }
      return { action, ok: true, ...store.stats(), procedures: store.list() }
    } catch (error) {
      return { action, ok: false, reason: String(error?.message || error) }
    }
  }

  /**
   * 上下文用量：计划分了多少、实际用了多少、压缩了几次。
   * 数据来自 brain 的上下文环形缓冲，这里只做转发与兜底。
   */
  function contextUsage() {
    try {
      const brain = ctx.get?.('brain') || globalThis[Symbol.for('dsh-feiyu-brain.service')]
      if (!brain || typeof brain.contextStats !== 'function') {
        return { ok: false, reason: 'brain 没有提供 contextStats' }
      }
      return { ok: true, ...brain.contextStats({ limit: 20 }) }
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) }
    }
  }

  return {
    id: 'self',
    declare,
    record,
    refresh,
    status,
    check,
    history,
    metrics,
    evolve,
    procedures,
    contextUsage,
    flag: (name, context) => flags.evaluate(name, context),
    flags: () => ({ flags: flags.list(), state: flags.state() }),
    snapshot: () => st.snapshot,
    limits: () => st.snapshot?.limits || [],
  }
}

function render(payload) {
  return [{ type: 'text', text: payload }]
}

function createActionDefs(api) {
  return [
    {
      name: 'self_status',
      description: '我现在的状态：身份、已声明能力数、缺失声明、各服务在线情况、最近错误。数据来自真实探测，不猜。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: {
            at: { type: 'string' },
            declared: { type: 'number' },
            known: { type: 'number' },
            missing: { type: 'array', items: { type: 'string' } },
            lastError: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const cacheLine = value.cache
            ? `对话缓存：命中 ${value.cache.hits} / 解析 ${value.cache.misses}（${value.cache.files} 个文件，读过 ${Math.round((value.cache.bytesRead || 0) / 1024)}KB）`
            : '对话缓存：不可用'
          return render(
            `身份：${value.identity?.name || UNKNOWN}（${value.identity?.version || UNKNOWN}）\n` +
              `能力声明：${value.declared}/${value.known}${value.missing?.length ? `，缺 ${value.missing.join('、')}` : ''}\n` +
              `服务：${Object.entries(value.services || {}).map(([k, v]) => `${k}=${v}`).join('，')}\n` +
              `${cacheLine}\n` +
              `${value.lastError ? '最近错误：' + value.lastError : '没有记录到错误'}`,
          )
        },
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => true,
      execute: async () => api.status(),
    },
    {
      name: 'self_capabilities',
      description: '我实际会做什么：按插件列出的能力声明，含边界标记。缺 limits 的会标成 degraded。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: { capabilities: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, intent: { type: 'string' }, degraded: { type: 'boolean' } } } } },
        },
        render: (_args, value) => {
          if (!value.capabilities.length) return render('还没有任何插件声明能力。')
          const stateText = (state) => {
            if (!state) return ''
            if (state.error) return ` ⚠ ${state.error}`
            const entries = Object.entries(state).slice(0, 3)
            if (!entries.length) return ''
            return ' · ' + entries.map(([key, item]) => `${key}=${item && typeof item === 'object' ? JSON.stringify(item).slice(0, 40) : item}`).join(' ')
          }
          return render(
            value.capabilities
              .map((item) => `- ${item.id}${item.degraded ? '（缺 limits）' : ''}${stateText(item.state)}：${item.intent || UNKNOWN}`)
              .join('\n'),
          )
        },
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => true,
      execute: async () => {
        const snapshot = api.snapshot()
        return { capabilities: snapshot?.capabilities || [] }
      },
    },
    {
      name: 'self_limits',
      description: '我不会做什么、什么时候不该信我：来自插件的 limits 声明和最近 7 天的真实失败/拒绝记录。',
      parameters: { type: 'object', properties: { days: { type: 'number', description: '回看天数，默认 7' } } },
      output: {
        schema: { type: 'object', properties: { limits: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string' } } } } } },
        render: (_args, value) => {
          if (!value.limits.length) return render('没有记录到边界。这不代表没有边界，只代表还没有证据。')
          return render(value.limits.map((item) => `- [${item.kind}] ${item.text}`).join('\n'))
        },
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => true,
      execute: async () => {
        const snapshot = api.snapshot() || api.refresh('limits')
        return { limits: snapshot?.limits || [] }
      },
    },
    {
      name: 'self_history',
      description: '我最近做过哪些决定：按天聚合的决策记录（只含决策与结果，不含对话正文）。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '回看天数，默认 7' },
          kind: { type: 'string', description: '只看某类：route/reply/memory/reflection/autostart/deploy' },
          limit: { type: 'number', description: '最多几条，默认 20' },
        },
      },
      output: {
        schema: { type: 'object', properties: { count: { type: 'number' }, rows: { type: 'array', items: { type: 'object', properties: { at: { type: 'string' }, kind: { type: 'string' }, choice: { type: 'string' }, reason: { type: 'string' } } } } } },
        render: (_args, value) => {
          if (!value.count) return render('最近没有决策记录。')
          return render(value.rows.map((row) => `${row.at.slice(5, 16)} ${row.kind}/${row.choice}${row.reason ? ' · ' + row.reason : ''}`).join('\n'))
        },
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const rows = api.history({ days: Number(args?.days) || 7, kind: String(args?.kind || ''), limit: Number(args?.limit) || 20 })
        return { count: rows.length, rows }
      },
    },
    {
      name: 'self_check',
      description: '自检：快照是否新鲜、哪些插件还没声明能力、哪些声明缺 limits。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } } } },
        render: (_args, value) => render(value.ok ? '自检通过。' : '自检发现问题：\n' + value.problems.map((item) => '- ' + item).join('\n')),
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => true,
      execute: async () => api.check(),
    },
    {
      name: 'self_metrics',
      description: '最近 N 天的指标：回复率、刷屏率、拦截率、成本、延迟、自愈成功率，以及与滚动基线的对比。算不出来的指标会明确列为缺失。',
      parameters: { type: 'object', properties: { days: { type: 'number', description: '统计天数，默认 7' } } },
      output: {
        schema: {
          type: 'object',
          properties: {
            day: { type: 'string' },
            requests: { type: 'number' },
            replies: { type: 'number' },
            baselineSamples: { type: 'number' },
            missing: { type: 'array', items: { type: 'string' } },
            verdictOk: { type: 'boolean' },
          },
        },
        render: (_args, value) => {
          const pct = (num) => (typeof num === 'number' ? `${(num * 100).toFixed(1)}%` : '—')
          const ms = (num) => (typeof num === 'number' ? `${Math.round(num)}ms` : '—')
          const tok = (num) => (typeof num === 'number' ? Math.round(num) : '—')
          const metricMap = value.baseline?.metrics || {}
          const valid = Object.values(metricMap).filter(Boolean).length
          const total = Object.keys(metricMap).length
          const lines = [
            `${value.day}：请求 ${value.today?.volume?.requests ?? 0} · 回复 ${value.today?.volume?.replies ?? 0} · 忽略 ${value.today?.volume?.ignored ?? 0} · 拦截 ${value.today?.volume?.blocked ?? 0}`,
            `回复率 ${pct(value.today?.rates?.replyRate)} · 刷屏 ${pct(value.today?.rates?.spamRate)} · 自愈 ${pct(value.today?.rates?.autostartSuccess)}`,
            `成本 ${tok(value.today?.cost?.tokensPerReply)} tok/回复 · p50 ${ms(value.today?.latency?.p50)} · p95 ${ms(value.today?.latency?.p95)}`,
            `分段 p95：上下文 ${ms(value.today?.stages?.ctx?.p95)} · 模型 ${ms(value.today?.stages?.model?.p95)} · 发送 ${ms(value.today?.stages?.send?.p95)}`,
            `基线窗口 ${value.baseline?.samples ?? 0} 天 · 有效指标 ${valid}/${total}${valid === 0 ? '（样本不足，暂不比较）' : ''}`,
          ]
          if (value.missing?.length) lines.push('缺指标：' + value.missing.join('、'))
          return render(lines.join('\n'))
        },
      },
      timeoutMs: 8000,
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const result = api.metrics({ days: Number(args?.days) || 7 })
        return {
          day: result.today?.day || '',
          requests: result.today?.volume?.requests || 0,
          replies: result.today?.volume?.replies || 0,
          baselineSamples: result.baseline?.samples || 0,
          missing: result.missing,
          verdictOk: result.verdict?.ok || false,
          today: result.today,
          baseline: result.baseline,
          comparison: result.comparison,
          verdict: result.verdict,
        }
      },
    },
    {
      name: 'self_flags',
      description: '灰度开关：不带参数列出当前所有 flag；带 name + context 时返回该 flag 在当前上下文下的变体（sticky 分桶，同一会话固定同一版本）。改 flags.json 立即生效，不用重启。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'flag 名，例如 route.modelHint' },
          context: {
            type: 'object',
            properties: {
              channel: { type: 'string', description: 'qq / dsh / pet' },
              intent: { type: 'string', description: 'chat / memory / task ...' },
              scope: { type: 'string', description: 'owner / group / private' },
              conversation: { type: 'string', description: '会话键，sticky 分桶用' },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            count: { type: 'number' },
            broken: { type: 'boolean' },
            name: { type: 'string' },
            variant: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.name) {
            return render(`${value.name} → ${value.variant}（bucket=${value.bucket ?? '—'}，${value.reason}）`)
          }
          if (!value.count) return render('还没有配置任何 flag。控制权在 flags.json。')
          const lines = value.flags.map((item) => {
            const weights = Object.entries(item.variants).map(([variant, weight]) => `${variant} ${weight}`).join(' / ')
            return `- ${item.name}${item.enabled ? '' : '（已关）'}：${weights} · sticky=${item.stickyKey}${item.valid ? '' : ' · ⚠ 配置非法'}`
          })
          if (value.broken) lines.push('⚠ flags.json 解析失败，正在用上一次的内容')
          return render(lines.join('\n'))
        },
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const name = String(args?.name || '')
        if (name) {
          const result = api.flag(name, args?.context || {})
          return { count: 0, broken: false, name, variant: result.variant, bucket: result.bucket, reason: result.reason }
        }
        const { flags, state } = api.flags()
        return { count: flags.length, broken: state.broken, flags }
      },
    },
    {
      name: 'self_evolve',
      description:
        '自进化流水线：propose 生成候选、list 查看、report 出日报、approve/reject 审批、apply 应用、rollback 回滚。只允许改 flags.json 的开关与权重；人设、配置、代码永远不自动改。应用前自动备份。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['propose', 'list', 'report', 'approve', 'reject', 'apply', 'rollback'] },
          id: { type: 'string', description: '候选 id，approve/reject/apply/rollback 时必填' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            ok: { type: 'boolean' },
            count: { type: 'number' },
            reason: { type: 'string' },
            report: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.action === 'report' && value.report) return render(value.report)
          if (value.action === 'propose') {
            if (!value.ok) return render('生成候选失败：' + (value.reason || 'unknown'))
            const diagText = (value.diagnoses || []).map((item) => item.text).join('；') || '无'
            if (!value.count) return render('今天没有生成候选。诊断：' + diagText)
            return render(`生成 ${value.count} 个候选：\n` + value.changes.map((item) => `- ${item.id} ${item.actionable ? '可应用' : '仅提醒'}：${item.title}`).join('\n'))
          }
          if (value.action === 'list') {
            if (!value.changes?.length) return render('没有候选。')
            return render(
              value.changes
                .map((c) => `- ${c.id} [${c.status}]${c.actionable ? ' 可应用' : ' 仅提醒'}：${c.title}`)
                .join('\n'),
            )
          }
          if (value.change) {
            return render(`${value.action} ${value.change.id} → ${value.change.status}${value.backup ? '（备份在 ' + value.backup + '）' : ''}`)
          }
          return render(`${value.action}：${value.ok ? '完成' : '失败'}${value.reason ? '（' + value.reason + '）' : ''}`)
        },
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => false,
      execute: async (args) => api.evolve({ action: String(args?.op || 'list'), id: String(args?.id || '') }),
    },
    {
      name: 'self_procedures',
      description:
        '程序性记忆（经验库）：list 看已提炼的经验，extract 从决策日志和变更记录里提炼，match 按上下文找相关经验。只提炼、只提示，不自动执行。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'extract', 'match'] },
          minRepeats: { type: 'number', description: '同一失败模式出现几次才成经验，默认 3' },
          context: {
            type: 'object',
            properties: {
              kind: { type: 'string', description: '例如 memory / route / autostart' },
              field: { type: 'string', description: '例如 variants / enabled' },
            },
          },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            ok: { type: 'boolean' },
            total: { type: 'number' },
            added: { type: 'number' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return render(`${value.action} 失败：${value.reason || 'unknown'}`)
          if (value.action === 'extract') return render(`提炼完成：新增 ${value.added} 条，现有 ${value.total} 条经验。`)
          if (value.action === 'match') {
            if (!value.matched?.length) return render('没有匹配到相关经验。')
            return render(value.matched.map((item) => `- ${item.trigger} → ${item.action}（命中 ${item.score}）`).join('\n'))
          }
          const kinds = Object.entries(value.byKind || {})
            .map(([kind, count]) => `${kind} ${count}`)
            .join(' / ')
          if (!value.total) return render('还没有经验。先跑一次 extract。')
          return render(
            `共 ${value.total} 条经验${kinds ? '（' + kinds + '）' : ''}\n` +
              (value.procedures || []).map((item) => `- [${item.kind}] ${item.trigger} → ${item.action}`).join('\n'),
          )
        },
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => false,
      execute: async (args) =>
        api.procedures({
          action: String(args?.op || 'list'),
          context: args?.context || {},
          minRepeats: Number(args?.minRepeats) || 3,
        }),
    },
    {
      name: 'self_context',
      description:
        '上下文用量：最近若干次组装里，预算是多少、实际用了多少、压缩了几次、意图分布。用来回答「上下文到底花在哪」。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: '看最近几次，默认 20' } },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            samples: { type: 'number' },
            avgUsed: { type: 'number' },
            avgBudget: { type: 'number' },
            compressedRate: { type: 'number' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return render(`查不到上下文用量：${value.reason || 'unknown'}`)
          if (!value.samples) return render('还没有采样。等几次对话之后再来看。')
          const pct = Math.round((Number(value.compressedRate) || 0) * 100)
          const intents = Object.entries(value.byIntent || {})
            .map(([k, v]) => `${k} ${v}`)
            .join(' / ')
          return render(
            `最近 ${value.samples} 次：平均预算 ${value.avgBudget} 字符，平均用掉 ${value.avgUsed} 字符，压缩率 ${pct}%\n` +
              `意图分布：${intents || '—'}`,
          )
        },
      },
      timeoutMs: 10000,
      isConcurrencySafe: () => true,
      execute: async () => api.contextUsage(),
    },
  ]
}

// 单入口：把上面 10 个分支收进 self(action)。分支本身的参数、默认值、api 调用都不变。
// 只有 self_evolve / self_procedures 原本自带 action 参数，与入口的 action 重名，
// 因此子动作改由 op 传入（取值集合不变）。
const ACTION_NAMES = ['status', 'capabilities', 'limits', 'history', 'check', 'metrics', 'flags', 'evolve', 'procedures', 'context']

function actionOf(def) {
  return String(def?.name || '').replace(/^self_/, '')
}

function createTools(api) {
  const defs = createActionDefs(api)
  const byAction = new Map(defs.map((def) => [actionOf(def), def]))
  const missing = ACTION_NAMES.filter((action) => !byAction.has(action))
  if (missing.length) throw new Error('self 工具缺少 action 分支：' + missing.join('、'))

  return [
    {
      name: 'self',
      description:
        'Self Model：我现在什么状态、会什么、不会什么、最近改了什么。action 选 status / capabilities / limits / history / check / metrics / flags / evolve / procedures / context。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ACTION_NAMES,
            description:
              'status=状态，capabilities=能力声明，limits=边界与失败，history=决策记录，check=自检，metrics=指标，flags=灰度开关，evolve=自进化流水线，procedures=经验库，context=上下文用量',
          },
          op: {
            type: 'string',
            enum: ['propose', 'list', 'report', 'approve', 'reject', 'apply', 'rollback', 'extract', 'match'],
            description: 'evolve / procedures 的子动作（其他 action 忽略）',
          },
          id: { type: 'string', description: 'evolve：候选 id，approve/reject/apply/rollback 时必填' },
          days: { type: 'number', description: '回看/统计天数，默认 7（limits / history / metrics）' },
          kind: { type: 'string', description: 'history：只看某类 route/reply/memory/reflection/autostart/deploy' },
          limit: { type: 'number', description: '最多几条，默认 20（history / context）' },
          name: { type: 'string', description: 'flags：flag 名，例如 route.modelHint' },
          context: {
            type: 'object',
            properties: {
              channel: { type: 'string', description: 'qq / dsh / pet' },
              intent: { type: 'string', description: 'chat / memory / task ...' },
              scope: { type: 'string', description: 'owner / group / private' },
              conversation: { type: 'string', description: '会话键，sticky 分桶用' },
              kind: { type: 'string', description: 'procedures：例如 memory / route / autostart' },
              field: { type: 'string', description: 'procedures：例如 variants / enabled' },
            },
          },
          minRepeats: { type: 'number', description: 'procedures：同一失败模式出现几次才成经验，默认 3' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { action: { type: 'string' }, ok: { type: 'boolean' } },
        },
        render: (_args, value) => {
          const def = byAction.get(String(value?.action || ''))
          if (!def?.output?.render) return render(JSON.stringify(value))
          // 分支 render 里看到的 action 是子动作（evolve / procedures），这里还原回去。
          return def.output.render(_args, value && value.op ? { ...value, action: value.op } : value)
        },
      },
      timeoutMs: 20000,
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const action = String(args?.action || '')
        const def = byAction.get(action)
        if (!def) return { ok: false, action, error: '未知 action：' + action }
        const out = await def.execute(args)
        if (action === 'evolve' || action === 'procedures') return { ...out, action, op: out?.action }
        return { action, ...out }
      },
    },
  ]
}
