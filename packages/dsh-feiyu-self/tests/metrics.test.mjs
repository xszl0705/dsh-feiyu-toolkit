import test from 'node:test'
import assert from 'node:assert/strict'
import { adoptVerdict, buildBaseline, collectDay, compare, spamRate } from '../lib/metrics.js'

const stats = [
  { ms: 100, totalTokens: 300, promptTokens: 200, outTokens: 100, model: 'deepseek-flash', intent: 'chat', route: 'big' },
  { ms: 300, totalTokens: 500, promptTokens: 300, outTokens: 200, model: 'qwen3:4b', intent: 'memory', route: 'local' },
  { ms: 500, blocked: true, model: 'deepseek-flash', intent: 'chat' },
]

const decisions = [
  { at: '2026-10-31T05:00:00Z', kind: 'reply', choice: 'sent', conversation: 'group:1' },
  { at: '2026-10-31T05:05:00Z', kind: 'reply', choice: 'sent', conversation: 'group:1' },
  { at: '2026-10-31T06:00:00Z', kind: 'reply', choice: 'sent', conversation: 'owner' },
  { at: '2026-10-31T05:10:00Z', kind: 'policy', choice: 'ignored' },
  { at: '2026-10-31T05:11:00Z', kind: 'guard', choice: 'blocked' },
  { at: '2026-10-31T05:12:00Z', kind: 'autostart', choice: 'launched' },
  { at: '2026-10-31T05:13:00Z', kind: 'autostart', choice: 'failed' },
]

test('没有数据时全部为 null，并列出缺失指标', () => {
  const day = collectDay({ day: '2026-11-01' })
  assert.equal(day.volume.requests, 0)
  assert.equal(day.rates.replyRate, null)
  assert.equal(day.latency.p50, null)
  assert.ok(day.missing.includes('rates.followUpRate'))
  assert.ok(day.missing.includes('rates.refusalRate'))
})

test('有数据时算出体积、成本、延迟', () => {
  const day = collectDay({ day: '2026-10-31', stats, decisions })
  assert.equal(day.volume.requests, 3)
  assert.equal(day.volume.replies, 3)
  assert.equal(day.volume.ignored, 1)
  assert.equal(day.volume.blocked, 2) // stats 1 + guard 1
  assert.equal(day.cost.totalTokens, 800)
  assert.equal(day.cost.tokensPerReply, 800 / 3)
  assert.equal(day.latency.p50, 300)
  assert.equal(day.latency.max, 500)
  assert.equal(day.rates.replyRate, 3 / 5) // 3 sent / (3 sent + 1 ignored + 1 guard blocked)
  assert.equal(day.rates.autostartSuccess, 0.5)
})

test('三段计时分别统计，慢在哪一段看得见', () => {
  const timed = [
    { ms: 400, contextMs: 20, modelMs: 300, sendMs: 80, model: 'deepseek-flash' },
    { ms: 200, contextMs: 10, modelMs: 150, sendMs: 40, model: 'deepseek-flash' },
    { ms: 600, contextMs: 60, modelMs: 500, sendMs: 40, model: 'deepseek-flash' },
  ]
  const day = collectDay({ day: '2026-10-31', stats: timed })
  assert.equal(day.stages.ctx.p50, 20)
  assert.equal(day.stages.model.p50, 300)
  assert.equal(day.stages.send.p50, 40)
  assert.equal(day.stages.model.p95, 500)
})

test('没有三段数据时 stages 为 null，并记进 missing', () => {
  const day = collectDay({ stats: [{ ms: 100, model: 'deepseek-flash' }] })
  assert.equal(day.stages.ctx.p50, null)
  assert.equal(day.stages.model.p50, null)
  assert.ok(day.missing.includes('stages.model'))
})

test('刷屏代理：同会话 10 分钟内连发 / 回复总数', () => {
  assert.equal(spamRate(decisions), 1 / 3) // group:1 连发 1 条，总回复 3 条
  assert.equal(spamRate([]), null)
  const onlyOne = [{ at: '2026-10-31T05:00:00Z', kind: 'reply', choice: 'sent', conversation: 'a' }]
  assert.equal(spamRate(onlyOne), 0)
})

test('基线样本不足时返回 null，不拿两天当标准', () => {
  const days = [collectDay({ day: 'd1', stats }), collectDay({ day: 'd2', stats })]
  const baseline = buildBaseline({ daily: days, windowDays: 7, minSamples: 3 })
  assert.equal(baseline.metrics['latency.p50'], null)
  assert.equal(baseline.samples, 2)
})

test('基线样本足够时算出 mean / std', () => {
  const days = [100, 200, 300].map((ms, index) => collectDay({ day: `d${index}`, stats: [{ ms }] }))
  const baseline = buildBaseline({ daily: days, minSamples: 3 })
  assert.equal(baseline.metrics['latency.p50'].mean, 200)
  assert.ok(baseline.metrics['latency.p50'].std > 0)
  assert.equal(baseline.metrics['latency.p50'].n, 3)
})

test('compare 给出方向和 z 值', () => {
  const baseline = buildBaseline({ daily: [100, 200, 300].map((ms) => collectDay({ stats: [{ ms }] })), minSamples: 3 })
  const today = collectDay({ stats: [{ ms: 400 }] })
  const result = compare({ today, baseline })
  assert.equal(result['latency.p50'].direction, 'up')
  assert.ok(result['latency.p50'].z > 0)
  assert.equal(result['rates.replyRate'].direction, 'unknown')
})

test('采纳规则：至少 2 个指标改善且无显著恶化', () => {
  const better = { 'latency.p50': 'down', 'latency.p95': 'down', 'rates.replyRate': 'up' }
  const good = adoptVerdict({
    comparison: {
      'latency.p50': { direction: 'down', z: -3 },
      'latency.p95': { direction: 'down', z: -2.5 },
    },
    betterDirection: better,
  })
  assert.equal(good.ok, true)
  assert.equal(good.improved, 2)

  const oneOnly = adoptVerdict({
    comparison: { 'latency.p50': { direction: 'down', z: -3 } },
    betterDirection: better,
  })
  assert.equal(oneOnly.ok, false)

  const withRegression = adoptVerdict({
    comparison: {
      'latency.p50': { direction: 'down', z: -3 },
      'latency.p95': { direction: 'down', z: -2.5 },
      'rates.replyRate': { direction: 'down', z: -4 },
    },
    betterDirection: better,
  })
  assert.equal(withRegression.ok, false)
  assert.deepEqual(withRegression.regressions, ['rates.replyRate'])
})
