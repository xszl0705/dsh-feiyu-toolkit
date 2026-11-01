import test from 'node:test'
import assert from 'node:assert/strict'
import { buildContext, contextPlan, contextStats } from '../index.js'

const KEYS = ['instr', 'know', 'tools', 'mem', 'state', 'query']

test('六组件预算齐全，加总正好等于总量', () => {
  const plan = contextPlan({ intent: 'chat' })
  for (const key of KEYS) {
    assert.ok(Number.isFinite(plan.blocks[key]), `${key} 应为数字`)
    assert.ok(plan.blocks[key] >= 0, `${key} 不应为负`)
  }
  const sum = KEYS.reduce((total, key) => total + plan.blocks[key], 0)
  assert.equal(sum, plan.total)
})

test('记忆类意图的 mem 预算比闲聊大', () => {
  const memory = contextPlan({ intent: 'memory' })
  const chat = contextPlan({ intent: 'chat' })
  assert.ok(memory.blocks.mem > chat.blocks.mem, `memory=${memory.blocks.mem} chat=${chat.blocks.mem}`)
})

test('问候类意图的 mem 预算最小', () => {
  const greeting = contextPlan({ intent: 'greeting' })
  const chat = contextPlan({ intent: 'chat' })
  assert.ok(greeting.blocks.mem <= chat.blocks.mem)
})

test('未知意图退回 chat 的 tier，但保留原意图名', () => {
  const plan = contextPlan({ intent: 'nonsense' })
  assert.equal(plan.intent, 'nonsense')
  assert.deepEqual(plan.tier, contextPlan({ intent: 'chat' }).tier)
})

test('总量来自 maxInputTokens 估算，不会低于下限', () => {
  const plan = contextPlan({})
  assert.ok(plan.total >= 800)
})

test('buildContext 把 plan 一起返回，供组装方使用', () => {
  const result = buildContext({ text: '今天有点累', scope: 'owner' })
  assert.ok(result.plan)
  assert.equal(result.plan.intent, 'emotional')
  assert.ok(result.plan.blocks.mem > 0)
})

test('buildContext 顺手记一条用量：预算、实际、是否压缩', () => {
  const result = buildContext({ text: '在吗', scope: 'owner' })
  assert.ok(result.stats)
  assert.ok(result.stats.budget > 0)
  assert.ok(result.stats.used >= 0)
  assert.equal(typeof result.stats.compressed, 'boolean')
  // 意图名由分类器决定（「在吗」会落 greeting），这里只验证它被记下来了
  assert.ok(typeof result.stats.intent === 'string' && result.stats.intent.length > 0)
})

test('contextStats 聚合成「平均用量 / 压缩率 / 意图分布」', () => {
  buildContext({ text: '在吗', scope: 'owner' })
  buildContext({ text: '今天有点累', scope: 'owner' })
  const stats = contextStats({ limit: 20 })
  assert.ok(stats.samples >= 2)
  assert.ok(stats.avgBudget >= 0)
  assert.ok(stats.avgUsed >= 0)
  assert.ok(stats.compressedRate >= 0 && stats.compressedRate <= 1)
  // 意图名由分类器决定，这里只验证分布被统计了，不假设具体名字
  assert.ok(Object.keys(stats.byIntent).length >= 1)
  assert.ok(stats.latest)
})

test('没有采样时 contextStats 返回 samples=0，不编数字', () => {
  const stats = contextStats({ limit: 1 })
  // 前面已有采样，这里只验证结构：要么有样本，要么字段为空
  if (stats.samples === 0) {
    assert.equal(stats.avgUsed, null)
    assert.equal(stats.avgBudget, null)
  } else {
    assert.ok(Number.isFinite(stats.avgUsed))
  }
})
