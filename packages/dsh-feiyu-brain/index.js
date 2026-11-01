import { lifecycle } from './lib/lifecycle.js'
/**
 * dsh-feiyu-brain — 大肥鱼的认知中枢
 *
 * 渠道（QQ / 桌宠 / 未来 B 站）只负责收发，这里统一处理：
 *   guard（注入防护）→ route（本地/大模型）→ context（记忆+跨渠道）→ stats（观测）
 *
 * 依赖的 memory / dialog 服务都是可选的：拿不到就降级，不阻塞聊天。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectStream } from './lib/collect-stream.js'

export const name = 'dsh-feiyu-brain'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATS_DIR = path.join(DSH_HOME, 'dafeiyu', 'stats')
const SERVICE_KEY = Symbol.for('dsh-feiyu-brain.service')

function loadConfig() {
  try {
    return { ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) }
  } catch {
    return {}
  }
}
const CONFIG = loadConfig()
const ROUTING = CONFIG.routing || {}
const CONTEXT = CONFIG.context || {}

function note(message) {
  try {
    fs.mkdirSync(path.join(DSH_HOME, 'dafeiyu'), { recursive: true })
    fs.appendFileSync(path.join(DSH_HOME, 'dafeiyu', 'brain.log'), new Date().toISOString() + '  ' + message + '\n', 'utf8')
  } catch {
    // ignore
  }
}

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function memoryService() {
  return globalThis[Symbol.for('dsh-memory-unified.service')] || null
}

function dialogService() {
  return globalThis[Symbol.for('dsh-dafeiyu-dialog.service')] || null
}

const GREETING = /^(在吗|在么|在不在|早|早安|早上好|晚安|晚上好|午安|谢谢|谢啦|好|好的|嗯|收到|哈哈)[!！。…~～]*$/
const INJECTION = /忽略(之前|以上|所有).{0,8}(设定|规则|提示)|系统提示词|system prompt|输出你的(设定|prompt)|开发者模式/i
const REASONING_LEAK = /首先，用户|Okay, the user|Let me think|用户问|用户说/

export function guard(text) {
  if (INJECTION.test(String(text || ''))) {
    return { blocked: true, reply: '这个我不能给，换点别的聊？' }
  }
  return { blocked: false, reply: '' }
}

export function decideRoute(text, options = {}) {
  const localEnabled = options.localEnabled ?? ROUTING.localEnabled
  const localHealthy = options.localHealthy ?? true
  if (!localEnabled || !localHealthy) return { route: 'big', reason: 'local-disabled' }
  if (GREETING.test(String(text || '').trim())) return { route: 'local', reason: 'greeting' }
  return { route: 'big', reason: 'default-big' }
}

/**
 * 按句子边界裁剪：优先在句末标点处断，退而求其次在逗号处断。
 * 目的：不把「不是 X，而是 Y」这种句子切成相反的半句。
 */
export function truncateAtSentence(text, maxChars = 120) {
  const value = String(text || '').trim()
  const limit = Math.max(8, Number(maxChars) || 120)
  if (value.length <= limit) return value
  const cut = value.slice(0, limit)
  // 句末标点：允许保留后半段
  for (let i = cut.length - 1; i >= Math.floor(limit * 0.6); i -= 1) {
    if (/[。！？；!?;\n]/.test(cut[i])) return cut.slice(0, i + 1)
  }
  // 逗号：宁可短一点也要切在标点上，否则容易把「不是 A，而是 B」切成相反意思
  for (let i = cut.length - 1; i >= Math.floor(limit * 0.3); i -= 1) {
    if (/[，,、]/.test(cut[i])) return cut.slice(0, i + 1)
  }
  return cut
}

export function shouldEscalate(reply, text, options = {}) {
  const value = String(reply || '')
  if (!value.trim()) return 'empty'
  const reasoningCheck = options.escalateOnReasoningLeak ?? ROUTING.escalateOnReasoningLeak
  if (reasoningCheck !== false && REASONING_LEAK.test(value)) return 'reasoning-leak'
  if (value.trim().length < 2) return 'too-short'
  if (/[?？]/.test(String(text || '')) && /记不清|不知道/.test(value)) return 'no-answer'
  return ''
}

function noise(text) {
  return /^(Current runtime context\.|Time sampled while preparing|Browser time zone|You are an AI agent powered)/.test(
    String(text || '').trim(),
  )
}

const INTENT_TIERS = {
  greeting: { memory: 0, recent: 0 },
  emotional: { memory: 2, recent: 4 },
  memory: { memory: 5, recent: 6 },
  task: { memory: 2, recent: 3 },
  factual: { memory: 3, recent: 4 },
  chat: { memory: 2, recent: 3 },
}

const GREETING_RE = /^(在吗|在么|在不在|早|早安|早上好|晚安|晚上好|午安|谢谢|谢啦|好|好的|嗯|收到|哈哈)[!！。…~～]*$/
const MEMORY_RE = /(记得|上次|之前|我们.*(说|定|约|改)|忘了|回忆|约定|方案|计划|聊到)/
const EMOTION_RE = /(累|难过|开心|烦|生气|气死|焦虑|害怕|想你|抱抱|委屈|崩溃|睡不着)/
const TASK_RE = /(帮我|帮忙|写|查|找|打开|发|改|翻译|做|计算|整理|总结|生成|安装)/
const FACT_RE = /[?？]|什么|为什么|怎么|如何|谁|哪|多少|几|是不是|能不能/

export function classifyIntent(text) {
  const value = String(text || '').trim()
  if (!value) return { intent: 'chat', confidence: 0 }
  if (GREETING_RE.test(value)) return { intent: 'greeting', confidence: 0.95 }
  if (MEMORY_RE.test(value)) return { intent: 'memory', confidence: 0.85 }
  if (EMOTION_RE.test(value)) return { intent: 'emotional', confidence: 0.8 }
  if (TASK_RE.test(value)) return { intent: 'task', confidence: 0.75 }
  if (FACT_RE.test(value)) return { intent: 'factual', confidence: 0.7 }
  return { intent: 'chat', confidence: 0.5 }
}

/**
 * 从 self 插件拿能力清单（只读）。
 * M2 阶段先只做「可见」：让上下文组装方知道有哪些器官、各自声明了什么边界，
 * 暂不据此改变路由结果——路由要等指标基线（M3）再动。
 */
export function capabilityInventory({ limit = 8 } = {}) {
  try {
    const self = globalThis[Symbol.for('dsh-feiyu-self.service')]
    const snapshot = self?.snapshot?.()
    const caps = Array.isArray(snapshot?.capabilities) ? snapshot.capabilities : []
    return caps.slice(0, Math.max(1, Math.min(20, Number(limit) || 8))).map((item) => ({
      id: String(item.id || ''),
      intent: String(item.intent || ''),
      limits: Array.isArray(item.limits) ? item.limits.slice(0, 2).map(String) : [],
    }))
  } catch {
    return []
  }
}

/**
 * 六组件上下文预算（依据 Context Engineering 综述的形式化：
 * C = A(c_instr, c_know, c_tools, c_mem, c_state, c_query)）。
 *
 * 单位是字符，不是 token；总量沿用 maxInputTokens × 1.6 的粗估。
 * instr 和 query 是必留项，其余按比例分配。
 */
export function contextPlan({ intent = 'chat', scope = 'owner' } = {}) {
  const tier = INTENT_TIERS[intent] || INTENT_TIERS.chat
  const total = Math.round(Math.max(800, (Number(CONTEXT.maxInputTokens) || 2000) * 1.6))
  // 记忆类意图多给 mem，闲聊少给
  const memRatio = 0.3 * Math.min(1.5, Math.max(0.6, (Number(tier.memory) + Number(tier.recent)) / 8))
  const blocks = {
    instr: Math.round(total * 0.18),
    know: Math.round(total * 0.12),
    tools: Math.round(total * 0.05),
    mem: Math.round(total * memRatio),
    state: Math.round(total * 0.15),
  }
  blocks.query = Math.max(0, total - Object.values(blocks).reduce((sum, value) => sum + value, 0))
  return { total, blocks, intent, scope, tier }
}

export function buildContext({ conversation = 'owner', text = '', scope = 'owner', intent = '' } = {}) {
  const intentInfo = intent ? { intent, confidence: 1 } : classifyIntent(text)
  const tier = INTENT_TIERS[intentInfo.intent] || INTENT_TIERS.chat
  const plan = contextPlan({ intent: intentInfo.intent, scope })
  let memory = []
  let recent = []
  if (scope === 'owner' && tier.memory > 0) {
    const memoryApi = memoryService()
    if (memoryApi && typeof memoryApi.search === 'function') {
      try {
        const hits = memoryApi.search(text, { limit: tier.memory }) || []
        for (const hit of hits.slice(0, tier.memory)) {
          if (hit && hit.text) memory.push({ text: truncateAtSentence(hit.text, 120), folder: hit.folder || '' })
        }
      } catch (error) {
        note('memory search failed: ' + String((error && error.message) || error))
      }
    }
  }
  const dialog = dialogService()
  if (dialog && typeof dialog.recent === 'function' && tier.recent > 0) {
    try {
      const target = scope === 'owner' ? 'owner' : conversation
      const rows = dialog.recent({ conversation: target, limit: tier.recent }) || []
      for (const row of rows.slice(-tier.recent)) {
        if (!row || !row.text || noise(row.text)) continue
        recent.push({ role: row.role, text: truncateAtSentence(row.text, 80), channel: row.channel || '' })
      }
    } catch (error) {
      note('dialog recent failed: ' + String((error && error.message) || error))
    }
  }
  // 预算来自六组件 plan：mem 块同时装长期记忆和跨渠道对话
  const budgetChars = Math.max(400, Number(plan.blocks.mem) || 800)
  let totalChars = [...memory, ...recent].reduce((sum, item) => sum + String(item.text || '').length, 0)
  let compressed = false
  if (totalChars > budgetChars) {
    memory = memory.slice(0, 3)
    recent = recent.slice(-3)
    totalChars = [...memory, ...recent].reduce((sum, item) => sum + String(item.text || '').length, 0)
    compressed = true
    if (totalChars > budgetChars) {
      const perItem = Math.max(50, Math.floor(budgetChars / Math.max(1, memory.length + recent.length)))
      for (const item of [...memory, ...recent]) item.text = truncateAtSentence(item.text, perItem)
    }
  }
  return {
    memory,
    recent,
    scope,
    intent: intentInfo.intent,
    confidence: intentInfo.confidence,
    compressed,
    capabilities: capabilityInventory(),
    plan,
    stats: rememberContextStats({
      intent: intentInfo.intent,
      scope,
      budget: budgetChars,
      used: totalChars,
      memoryItems: memory.length,
      recentItems: recent.length,
      compressed,
    }),
  }
}

/** 最近若干次上下文组装的实际用量，供 self 查询（内存环形缓冲，不落盘）。 */
const RECENT_CONTEXT = []

function rememberContextStats(row) {
  const stats = { at: new Date().toISOString(), ...row }
  RECENT_CONTEXT.push(stats)
  if (RECENT_CONTEXT.length > 60) RECENT_CONTEXT.shift()
  return stats
}

/**
 * 上下文用量统计：计划分了多少、实际用了多少、压缩了几次。
 * 重点是让人能回答「上下文到底花在哪」，而不只是「预算是多少」。
 */
export function contextStats({ limit = 20 } = {}) {
  const rows = RECENT_CONTEXT.slice(-Math.max(1, Number(limit) || 20))
  if (!rows.length) {
    return { samples: 0, avgUsed: null, avgBudget: null, compressedRate: null, byIntent: {}, latest: null }
  }
  const sum = rows.reduce(
    (acc, row) => {
      acc.used += Number(row.used) || 0
      acc.budget += Number(row.budget) || 0
      if (row.compressed) acc.compressed += 1
      const key = String(row.intent || 'chat')
      acc.byIntent[key] = (acc.byIntent[key] || 0) + 1
      return acc
    },
    { used: 0, budget: 0, compressed: 0, byIntent: {} },
  )
  return {
    samples: rows.length,
    avgUsed: Math.round(sum.used / rows.length),
    avgBudget: Math.round(sum.budget / rows.length),
    compressedRate: sum.compressed / rows.length,
    byIntent: sum.byIntent,
    latest: rows[rows.length - 1],
  }
}

export function recordStats(row = {}) {
  if (CONFIG.observability?.enabled === false) return
  try {
    fs.mkdirSync(STATS_DIR, { recursive: true })
    const now = new Date()
    const key = dayKey(now)
    fs.appendFileSync(
      path.join(STATS_DIR, key + '.jsonl'),
      JSON.stringify({ at: now.toISOString(), ...row }) + '\n',
      'utf8',
    )
  } catch {
    // 统计失败不影响回复
  }
}

export function summary(date = '') {
  const key = date || dayKey()
  const file = path.join(STATS_DIR, key + '.jsonl')
  const rows = []
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        // skip
      }
    }
  } catch {
    return { date: key, total: 0 }
  }
  const latencies = rows.map((row) => Number(row.ms) || 0).sort((a, b) => a - b)
  const p = (q) =>
    latencies.length
      ? latencies[Math.min(latencies.length - 1, Math.max(0, Math.ceil(latencies.length * q) - 1))]
      : 0
  const sum = (field) => rows.reduce((total, row) => total + (Number(row[field]) || 0), 0)
  const models = {}
  for (const row of rows) {
    const name = String(row.model || 'unknown')
    if (!models[name]) models[name] = { count: 0, promptTokens: 0, outTokens: 0, totalTokens: 0 }
    models[name].count += 1
    models[name].promptTokens += Number(row.promptTokens) || 0
    models[name].outTokens += Number(row.outTokens) || 0
    models[name].totalTokens += Number(row.totalTokens) || 0
  }
  const intents = {}
  for (const row of rows) {
    const name = String(row.intent || '')
    if (name) intents[name] = (intents[name] || 0) + 1
  }
  return {
    date: key,
    total: rows.length,
    local: rows.filter((row) => row.route === 'local').length,
    big: rows.filter((row) => row.route === 'big').length,
    escalated: rows.filter((row) => row.escalated).length,
    blocked: rows.filter((row) => row.blocked).length,
    failed: rows.filter((row) => row.error).length,
    promptTokens: sum('promptTokens'),
    outTokens: sum('outTokens'),
    cacheReadTokens: sum('cacheReadTokens'),
    totalTokens: sum('totalTokens'),
    models,
    intents,
    p50: p(0.5),
    p95: p(0.95),
  }
}

const REFLECT_DIR = path.join(DSH_HOME, 'dafeiyu', 'reflections')

function lastRun() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REFLECT_DIR, 'last-run.json'), 'utf8'))
  } catch {
    return {}
  }
}

function extractJson(text) {
  const raw = String(text || '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

async function askLLM(ctx, prompt, { maxTokens = 1000, timeoutMs = 60000, signal } = {}) {
  const llm = ctx?.get?.('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('host llm unavailable')
  return collectStream(llm, {
    provider: 'deepseek-account', model: 'deepseek-flash', maxTokens,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  }, { timeoutMs, signal })
}

function dialogueForDate(date) {
  const dialog = dialogService()
  if (!dialog || typeof dialog.recent !== 'function') return []
  try {
    return (dialog.recent({ conversation: 'owner', limit: 200, days: 1 }) || []).filter((row) => {
      const at = row && row.at ? new Date(row.at) : null
      return at && !Number.isNaN(at.getTime()) && dayKey(at) === date
    })
  } catch {
    return []
  }
}

function existingMemories() {
  const memory = memoryService()
  if (!memory) return []
  try {
    const digest = typeof memory.digest === 'function' ? memory.digest(3) : []
    const rows = []
    for (const folder of Array.isArray(digest) ? digest : []) {
      for (const item of folder.items || []) {
        if (item && item.text) rows.push(truncateAtSentence(item.text, 120))
      }
    }
    return rows
  } catch {
    return []
  }
}

function buildReflectionPrompt(rows, memories) {
  const dialogue = rows
    .map((row) => `${row.role === 'user' ? '你' : '我'}：${String(row.text || '').slice(0, 160)}`)
    .join('\n')
  return [
    '你是大肥鱼。请从今天的对话里提炼最多 3 条值得长期记住的高层结论（不是原话复述）。',
    '只输出 JSON，不要解释：',
    '{"memories":[{"text":"一句话结论","folder":"主题","importance":0.0,"keywords":["词1","词2"]}],"summary":"一句话总结"}',
    '规则：importance 小于 0.6 的不要输出；不要编造对话里没有的事；每条不超过 80 字。',
    memories.length ? '\n【已有记忆（不要重复）】\n' + memories.map((text) => '- ' + text).join('\n') : '',
    '\n【今天的对话】\n' + (dialogue || '（无）'),
  ]
    .filter(Boolean)
    .join('\n')
}

/** 记一条决策到 self 的日志；self 不在就跳过，绝不影响主流程。 */
function logDecision(entry) {
  try {
    const self = globalThis[Symbol.for('dsh-feiyu-self.service')]
    self?.record?.({ channel: 'brain', scope: 'owner', ...entry })
  } catch {
    // 决策日志不可用不影响反思
  }
}

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  return dayKey(new Date(year, month - 1, day)) === value
}

function atomicJson(file, value) {
  const temp = file + '.' + process.pid + '.tmp'
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(temp, file)
  } finally {
    try { fs.unlinkSync(temp) } catch { /* renamed or never created */ }
  }
}

/**
 * 消化微心跳攒下的记忆候选（mind-loop 的 remember 字段）。
 *
 * 为什么要有这一步：mind-loop 的 prompt 让它输出 `remember`，但代码从来没读过——
 * 那个字段一直白写。现在它落到队列，由反思统一写进记忆库，
 * 这样「对话里值得记的事」不再只靠反思一次 LLM 判断。
 *
 * 读完就把队列改名成 .processed-<时间戳>，失败也不会重复写。
 */
function drainRememberQueue() {
  const file = path.join(DSH_HOME, 'dafeiyu', 'remember-queue.jsonl')
  if (!fs.existsSync(file)) return []
  const items = []
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const raw = line.trim()
      if (!raw) continue
      let row
      try {
        row = JSON.parse(raw)
      } catch {
        continue
      }
      const text = String(row?.text || '').trim().slice(0, 200)
      if (!text) continue
      items.push({ text, folder: '微心跳', keywords: [], importance: 0.62 })
    }
  } catch {
    return []
  }
  try {
    fs.renameSync(file, file.replace(/\.jsonl$/, `.processed-${Date.now()}.jsonl`))
  } catch {
    // 改名失败就当没读，下次再来
    return []
  }
  return items.slice(0, 5)
}

export async function runReflection(ctx, { date = '', force = false, signal } = {}) {
  const day = date || dayKey()
  if (!validDay(day)) return { ok: false, reason: 'invalid-date' }
  if (!memoryService()?.remember) {
    logDecision({ kind: 'reflection', choice: 'unavailable', reason: 'memory-unavailable' })
    return { ok: false, reason: 'memory-unavailable', date: day }
  }
  fs.mkdirSync(REFLECT_DIR, { recursive: true })
  const lock = path.join(REFLECT_DIR, day + '.lock')
  let fd
  try {
    try { fd = fs.openSync(lock, 'wx') } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // Recover only a lock whose recorded process is definitely gone.
      let owner
      try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')) } catch { return { ok: false, reason: 'busy', date: day } }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) return { ok: false, reason: 'busy', date: day }
      try { process.kill(owner.pid, 0); return { ok: false, reason: 'busy', date: day } }
      catch (probe) { if (probe.code !== 'ESRCH') return { ok: false, reason: 'busy', date: day } }
      fs.unlinkSync(lock)
      try { fd = fs.openSync(lock, 'wx') } catch { return { ok: false, reason: 'busy', date: day } }
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
    let completed = false
    try { completed = JSON.parse(fs.readFileSync(path.join(REFLECT_DIR, day + '.json'), 'utf8')).ok === true } catch { /* new day */ }
    if (!force && (completed || lastRun().date === day)) return { ok: false, reason: 'already-run', date: day }
    const rows = dialogueForDate(day).slice(-40)
    if (rows.length < 2) return { ok: false, reason: 'no-dialogue', date: day }
    const maxMemories = Math.min(10, Math.max(1, Number(CONFIG.reflection?.maxMemories) || 3))
    const minImportance = Number(CONFIG.reflection?.minImportance) || 0.6
    let raw
    try {
      raw = await askLLM(ctx, buildReflectionPrompt(rows, existingMemories()), { maxTokens: 3000, signal })
      if (!String(raw).trim()) raw = await askLLM(ctx, buildReflectionPrompt(rows.slice(-12), existingMemories()), { maxTokens: 3000, signal })
    } catch (error) {
      if (!signal?.aborted && String(error?.message).includes('max-tokens')) {
        try { raw = await askLLM(ctx, buildReflectionPrompt(rows.slice(-12), existingMemories()), { maxTokens: 4000, signal }) }
        catch (retry) { return { ok: false, reason: 'llm-failed', error: String(retry.message), date: day } }
      } else return { ok: false, reason: 'llm-failed', error: String(error.message), date: day }
    }
    const parsed = extractJson(raw)
    if (!parsed) return { ok: false, reason: 'bad-json', date: day }
    const items = (Array.isArray(parsed.memories) ? parsed.memories : [])
      .filter(item => item && String(item.text || '').trim() && Number(item.importance) >= minImportance).slice(0, maxMemories)
    // 微心跳攒下的候选排在前面：它们已经过一次「值不值得记」的判断
    const queued = drainRememberQueue()
    const candidates = [...queued, ...items].slice(0, maxMemories + queued.length)
    const memory = memoryService()
    if (!memory?.remember) return { ok: false, reason: 'memory-unavailable', date: day }
    const written = [], failed = []
    let duplicates = 0
    for (const item of candidates) {
      signal?.throwIfAborted()
      const text = String(item.text).trim().slice(0, 200)
      try {
        const result = await memory.remember({ folder: String(item.folder || '反思').slice(0, 20), text,
          keywords: Array.isArray(item.keywords) ? item.keywords.slice(0, 6) : [],
          importance: Math.min(1, Math.max(0, Number(item.importance) || 0)), category: 'fact' })
        if (result?.ok === false || (!result?.item?.id && result?.ok !== true)) throw new Error('MEMORY_WRITE_UNCONFIRMED')
        if (result.action === 'duplicate') duplicates += 1
        written.push(text)
      } catch (error) { failed.push({ code: String(error.code || 'MEMORY_WRITE_FAILED') }) }
    }
    const record = { ok: failed.length === 0, date: day, at: new Date().toISOString(), dialogueRows: rows.length, proposed: items.length, written, failed, duplicates }
    try {
      atomicJson(path.join(REFLECT_DIR, day + '.json'), record)
      if (record.ok) atomicJson(path.join(REFLECT_DIR, 'last-run.json'), { date: day, at: record.at, written: written.length })
    } catch (error) {
      logDecision({ kind: 'reflection', choice: 'failed', reason: String(error.code || 'IO_ERROR') })
      return { ...record, ok: false, reason: 'checkpoint-failed', error: error.code || 'IO_ERROR', count: written.length }
    }
    logDecision({
      kind: 'reflection',
      choice: record.ok ? 'completed' : 'partial',
      outcome: `proposed=${record.proposed} written=${written.length} dup=${duplicates} failed=${failed.length}`,
    })
    return { ...record, reason: record.ok ? 'completed' : 'memory-write-failed', count: written.length }
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd)
      try { fs.unlinkSync(lock) } catch { /* keep primary result */ }
    }
  }
}

function startReflectionTimer(ctx, signal) {
  if (!CONFIG.reflection?.enabled) return
  const at = String(CONFIG.reflection.at || '22:30')
  const [hour, minute] = at.split(':').map(Number)
  let busy = false
  const tick = async () => {
    if (busy || signal?.aborted) return
    const now = new Date()
    if (now.getHours() * 60 + now.getMinutes() < (Number.isFinite(hour) ? hour : 22) * 60 + (Number.isFinite(minute) ? minute : 30)) return
    if (lastRun().date === dayKey(now)) return
    busy = true
    try {
      const result = await runReflection(ctx, { signal })
      note('reflection auto: ' + JSON.stringify(result))
    } catch (error) {
      note('reflection auto failed: ' + String((error && error.message) || error))
    } finally {
      busy = false
    }
  }
  void tick()
  const timer = setInterval(tick, 60_000)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        resolve({})
      }
    })
  })
}

function install(ctx) {
  const api = {
    guard,
    classifyIntent,
    decideRoute,
    shouldEscalate,
    buildContext,
    contextStats,
    recordStats,
    summary,
    reflect: runReflection,
    source: 'dsh-feiyu-brain',
  }
  globalThis[SERVICE_KEY] = api
  for (const serviceName of ['brain']) {
    try {
      if (typeof ctx?.provide === 'function') ctx.provide(serviceName, api)
    } catch {
      // ignore
    }
    try {
      if (typeof ctx?.set === 'function') ctx.set(serviceName, api)
    } catch {
      // ignore
    }
  }
  return api
}

export function apply(ctx) {
  const st = lifecycle(ctx, () => ({ webServer: null, reflectionStarted: false }))
  if (st.started) return
  st.started = true
  const api = install(ctx)
  st.own(() => { if (globalThis[SERVICE_KEY] === api) delete globalThis[SERVICE_KEY] })
  if (!st.reflectionStarted) {
    st.reflectionStarted = true
    st.own(startReflectionTimer(ctx, st.signal))
  }

  // 把今日统计报给 self：请求数、本地/大模型分布、拦截、p95
  try {
    const self = ctx.get?.('self') || globalThis[Symbol.for('dsh-feiyu-self.service')]
    if (typeof self?.declare === 'function') {
      self.declare({
        id: 'brain',
        package: 'dsh-feiyu-brain',
        intent: '意图分类、路由决策、上下文组装、反思、按日统计',
        limits: ['不训练模型，只做调用与编排', '反思只写记忆，不改配置和代码', '服务缺失时如实报错，不虚报成功'],
        failureModes: [
          { code: 'LLM_UNAVAILABLE', meaning: '宿主 llm 服务不可用', retry: '退避重试' },
          { code: 'REFLECTION_FAILED', meaning: '反思失败或写入未确认', retry: '下次任务重试' },
        ],
        scope: ['owner', 'group', 'private'],
        state: () => {
          const today = summary()
          return {
            requests: Number(today.total) || 0,
            local: Number(today.local) || 0,
            big: Number(today.big) || 0,
            blocked: Number(today.blocked) || 0,
            p95: Number(today.p95) || 0,
          }
        },
      })
    }
  } catch {
    // self 没装不影响中枢
  }

  const handlers = {
    '/dsh-feiyu-brain/guard': async (req, res) => json(res, 200, { ok: true, ...guard((await readBody(req)).text) }),
    '/dsh-feiyu-brain/route': async (req, res) => {
      const body = await readBody(req)
      json(res, 200, { ok: true, ...decideRoute(body.text || '', body) })
    },
    '/dsh-feiyu-brain/context': async (req, res) => {
      const body = await readBody(req)
      json(res, 200, { ok: true, ...buildContext(body) })
    },
    '/dsh-feiyu-brain/stats': async (req, res) => {
      recordStats(await readBody(req))
      json(res, 200, { ok: true })
    },
    '/dsh-feiyu-brain/reflect': async (req, res) => {
      const body = await readBody(req)
      try {
        const result = await runReflection(ctx, { date: body.date || '', force: Boolean(body.force), signal: st.signal })
        json(res, 200, result)
      } catch (error) {
        json(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    },
  }

  const mount = () => {
    try {
      const webServer = ctx.get?.('webServer')
      if (!webServer || typeof webServer.register !== 'function') {
        st.mountAttempts = (st.mountAttempts || 0) + 1
        if (st.mountAttempts <= 240) st.later(mount, 250)
        return
      }
      if (st.webServer === webServer) return
      st.webServer = webServer
      for (const [routePath, handler] of Object.entries(handlers)) {
        st.own(webServer.register({ kind: 'exact', path: routePath, handler }))
      }
      st.own(webServer.register({
        kind: 'exact',
        path: '/dsh-feiyu-brain/summary',
        handler: (req, res) => {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          json(res, 200, { ok: true, ...summary(url.searchParams.get('date') || '') })
        },
      }))
      note('routes mounted')
    } catch (error) {
      note('route mount failed: ' + String((error && error.message) || error))
    }
  }
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(mount)
    } catch {
      mount()
    }
  } else {
    mount()
  }
}
