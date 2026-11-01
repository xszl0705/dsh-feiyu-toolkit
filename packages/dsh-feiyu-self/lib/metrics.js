/**
 * Metrics & Baseline：把「变好了」变成可计算的数字。
 *
 * 数据源只有两个：
 *  - brain 的日统计 jsonl（route/model/ms/tokens/blocked/error/intent）
 *  - self 的决策日志 jsonl（reply sent / ignored / blocked / autostart）
 *
 * 原则：
 *  1. 算不出来就返回 null，并写进 missing —— 不拿默认值凑数
 *  2. 指标必须成组看，单指标改进不构成采纳理由（Goodhart）
 *  3. 基线样本不足时返回 null，不允许拿两天的数据当标准
 */

export const REPEAT_WINDOW_MS = 10 * 60 * 1000

/** 指标白名单：只有这些字段会进 baseline。 */
export const BASELINE_METRICS = [
  'rates.replyRate',
  'rates.spamRate',
  'rates.blockRate',
  'rates.autostartSuccess',
  'cost.tokensPerReply',
  'latency.p50',
  'latency.p95',
]

export function emptyDay(day = '') {
  return {
    day,
    volume: { requests: 0, replies: 0, ignored: 0, blocked: 0, failed: 0, decisions: 0 },
    rates: { replyRate: null, spamRate: null, blockRate: null, autostartSuccess: null },
    cost: { totalTokens: 0, promptTokens: 0, outTokens: 0, tokensPerReply: null },
    latency: { p50: null, p95: null, max: null },
    // 三段拆分：慢在哪一段，性能验证要看这个
    stages: { ctx: { p50: null, p95: null }, model: { p50: null, p95: null }, send: { p50: null, p95: null } },
    models: {},
    intents: {},
    missing: [],
  }
}

function num(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function percentile(sorted, q) {
  if (!sorted.length) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))
  return sorted[index]
}

/** 同会话 10 分钟内连发，作为「刷屏」的代理指标：连发条数 / 回复总数。 */
export function spamRate(decisions = [], windowMs = REPEAT_WINDOW_MS) {
  const byConversation = new Map()
  let total = 0
  for (const row of decisions) {
    if (row?.kind !== 'reply' || row?.choice !== 'sent') continue
    total += 1
    const key = String(row.conversation || '')
    if (!key) continue
    const at = new Date(row.at).getTime()
    if (!Number.isFinite(at)) continue
    const list = byConversation.get(key) || []
    list.push(at)
    byConversation.set(key, list)
  }
  if (!total) return null
  let close = 0
  for (const list of byConversation.values()) {
    list.sort((a, b) => a - b)
    for (let i = 1; i < list.length; i += 1) {
      if (list[i] - list[i - 1] < windowMs) close += 1
    }
  }
  return close / total
}

export function collectDay({ day = '', stats = [], decisions = [] } = {}) {
  const out = emptyDay(day)
  const latencies = []
  const stageSamples = { ctx: [], model: [], send: [] }
  let autostartLaunched = 0
  let autostartFailed = 0
  let guardBlocked = 0

  for (const row of stats) {
    out.volume.requests += 1
    if (row?.blocked) out.volume.blocked += 1
    if (row?.error) out.volume.failed += 1
    const ms = num(row?.ms, -1)
    if (ms >= 0) latencies.push(ms)
    for (const [key, field] of [['ctx', 'contextMs'], ['model', 'modelMs'], ['send', 'sendMs']]) {
      const value = num(row?.[field], -1)
      if (value >= 0) stageSamples[key].push(value)
    }
    out.cost.totalTokens += num(row?.totalTokens)
    out.cost.promptTokens += num(row?.promptTokens)
    out.cost.outTokens += num(row?.outTokens)
    const model = String(row?.model || 'unknown')
    out.models[model] = (out.models[model] || 0) + 1
    const intent = String(row?.intent || '')
    if (intent) out.intents[intent] = (out.intents[intent] || 0) + 1
  }

  for (const row of decisions) {
    out.volume.decisions += 1
    if (row?.kind === 'reply' && row?.choice === 'sent') out.volume.replies += 1
    if (row?.choice === 'ignored') out.volume.ignored += 1
    if (row?.kind === 'guard' && row?.choice === 'blocked') {
      out.volume.blocked += 1
      guardBlocked += 1
    }
    if (row?.choice === 'failed') out.volume.failed += 1
    if (row?.kind === 'autostart') {
      if (row.choice === 'launched') autostartLaunched += 1
      if (row.choice === 'failed') autostartFailed += 1
    }
  }

  const attempted = out.volume.replies + out.volume.ignored + guardBlocked
  if (attempted > 0) out.rates.replyRate = out.volume.replies / attempted
  out.rates.blockRate = out.volume.requests > 0 ? out.volume.blocked / Math.max(1, out.volume.requests + out.volume.blocked) : null
  out.rates.spamRate = spamRate(decisions)
  const autostartTotal = autostartLaunched + autostartFailed
  if (autostartTotal > 0) out.rates.autostartSuccess = autostartLaunched / autostartTotal

  latencies.sort((a, b) => a - b)
  out.latency.p50 = percentile(latencies, 0.5)
  out.latency.p95 = percentile(latencies, 0.95)
  out.latency.max = latencies.length ? latencies[latencies.length - 1] : null

  for (const [key, samples] of Object.entries(stageSamples)) {
    samples.sort((a, b) => a - b)
    out.stages[key].p50 = percentile(samples, 0.5)
    out.stages[key].p95 = percentile(samples, 0.95)
  }

  if (out.volume.replies > 0) out.cost.tokensPerReply = out.cost.totalTokens / out.volume.replies

  if (out.rates.spamRate === null) out.missing.push('rates.spamRate')
  if (out.rates.autostartSuccess === null) out.missing.push('rates.autostartSuccess')
  if (out.cost.tokensPerReply === null) out.missing.push('cost.tokensPerReply')
  if (out.stages.model.p50 === null) out.missing.push('stages.model')
  // 这两个指标目前没有数据源，明确列为缺失，不假装能算
  out.missing.push('rates.followUpRate', 'rates.refusalRate')
  return out
}

function readPath(object, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), object)
}

/** 滚动窗口基线：mean / std / 样本数。样本不足 minSamples 时返回 null。 */
export function buildBaseline({ daily = [], windowDays = 7, minSamples = 3 } = {}) {
  const window = daily.filter((day) => day && typeof day === 'object').slice(-Math.max(1, windowDays))
  const out = { windowDays, samples: window.length, metrics: {}, generatedAt: new Date().toISOString() }
  for (const path of BASELINE_METRICS) {
    const values = window
      .map((day) => readPath(day, path))
      .filter((value) => typeof value === 'number' && Number.isFinite(value))
    if (values.length < minSamples) {
      out.metrics[path] = null
      continue
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
    out.metrics[path] = { mean, std: Math.sqrt(variance), n: values.length, min: Math.min(...values), max: Math.max(...values) }
  }
  return out
}

/**
 * 和基线比。std=0 时用「是否相同」判断，避免除零。
 * 方向：up / down / flat / unknown
 */
export function compare({ today, baseline, epsilon = 1e-9 } = {}) {
  const out = {}
  for (const path of BASELINE_METRICS) {
    const value = readPath(today, path)
    const base = baseline?.metrics?.[path]
    if (typeof value !== 'number' || !base) {
      out[path] = { value, mean: base?.mean ?? null, z: null, direction: 'unknown' }
      continue
    }
    const diff = value - base.mean
    const direction = Math.abs(diff) <= epsilon ? 'flat' : diff > 0 ? 'up' : 'down'
    const z = base.std > epsilon ? diff / base.std : diff === 0 ? 0 : diff > 0 ? Infinity : -Infinity
    out[path] = { value, mean: base.mean, z, direction }
  }
  return out
}

/**
 * 采纳规则：至少 2 个指标改善，且没有指标显著恶化。
 * 「显著」= |z| >= threshold 且方向不利。指标方向由调用方给出。
 */
export function adoptVerdict({ comparison = {}, betterDirection = {}, threshold = 2 } = {}) {
  let improved = 0
  const regressions = []
  for (const [path, row] of Object.entries(comparison)) {
    if (row.direction === 'unknown' || row.direction === 'flat') continue
    const want = betterDirection[path]
    if (!want) continue
    if (row.direction === want) improved += 1
    else if (Number.isFinite(row.z) && Math.abs(row.z) >= threshold) regressions.push(path)
  }
  return { ok: improved >= 2 && regressions.length === 0, improved, regressions }
}
