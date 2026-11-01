/** 群聊策略 / gate 单测：node tests/group-policy.test.mjs */
import assert from 'node:assert/strict'
import {
  DEFAULT_POLICY,
  normalizePolicy,
  createPolicyState,
  computeProbability,
  decideCandidate,
  markReply,
  markSilence,
  isWater,
  isQuestion,
  densityFactor,
} from '../lib/group-policy.js'
import { buildGatePrompt, parseGateResult } from '../lib/gate.js'
import { createPlan, recheckPlan, planExpired } from '../lib/planned.js'

const cfg = normalizePolicy({
  baseProbability: 0.5,
  afterReplyProbability: 0.5,
  minMessageChars: 2,
  interestKeywords: ['原神'],
})

assert.equal(cfg.densityMax, 3)
assert.equal(cfg.energy.initial, DEFAULT_POLICY.energy.initial)

// 短消息 / 水消息
assert.equal(decideCandidate({ text: '嗯', state: createPolicyState(), cfg }).candidate, false)
assert.equal(isWater('哈哈哈'), true)
assert.equal(isQuestion('为什么'), true)

// 概率命中/未命中（注入随机数）
const base = createPolicyState()
const hit = decideCandidate({ text: '这是什么', state: base, cfg, random: 0.1 })
const miss = decideCandidate({ text: '这是什么', state: base, cfg, random: 0.99 })
assert.equal(hit.candidate, true)
assert.equal(miss.candidate, false)

// 回复后概率提升（但仍在 180s 最小间隔内时，最小间隔优先）
const replied = { ...markReply(base, '好的', Date.now(), cfg), lastProactiveAt: Date.now() - 200000 }
const boosted = computeProbability({ text: '继续聊', state: replied, cfg, now: Date.now() })
assert.ok(boosted.probability >= cfg.afterReplyProbability)

// 密度硬限
const dense = { ...base, replyTimes: [Date.now(), Date.now(), Date.now()] }
assert.equal(densityFactor(dense, Date.now(), cfg), 0)
assert.equal(computeProbability({ text: '继续', state: dense, cfg, now: Date.now() }).probability, 0)

// 静默状态机
let silent = createPolicyState()
for (let i = 0; i < 3; i += 1) silent = markSilence(silent, Date.now(), cfg)
assert.ok(silent.silentUntil > Date.now())
assert.equal(decideCandidate({ text: '这是什么', state: silent, cfg, random: 0 }).reason, 'silent')

// 能量消耗
const afterReply = markReply(createPolicyState(), '一段比较长的回复内容', Date.now(), cfg)
assert.ok(afterReply.energy < 0.7)
assert.equal(afterReply.silenceStreak, 0)

// gate prompt / parse
const prompt = buildGatePrompt({
  identity: '我是大肥鱼',
  recent: [{ id: 'm1', speaker: '艾什', text: '这个构筑能过吗' }],
  candidate: { id: 'm2', speaker: '淼采萝', text: '召唤距离呢' },
  knowledge: [],
})
assert.ok(prompt.includes('m1') && prompt.includes('silence|ask|reply'))

const ok = parseGateResult(JSON.stringify({ action: 'reply', relevance: 0.8, confidence: 0.7, evidence: ['m1'], reply_intent: '接话' }))
assert.equal(ok.ok, true)
assert.equal(ok.action, 'reply')

const noEvidence = parseGateResult(JSON.stringify({ action: 'reply', relevance: 0.8, confidence: 0.7, evidence: [] }))
assert.equal(noEvidence.action, 'silence')
assert.equal(noEvidence.reason, 'no-evidence')

const internal = parseGateResult(JSON.stringify({ action: 'reply', relevance: 0.8, confidence: 0.7, evidence: ['m1'], reason: '刚醒，状态模糊' }))
assert.equal(internal.action, 'silence')
assert.equal(internal.reason, 'internal-state')

const bad = parseGateResult('not json')
assert.equal(bad.ok, false)
assert.equal(bad.action, 'silence')

// 计划与发送前复检
const plan = createPlan({ groupId: 'g', sourceMessageId: 'm1', action: 'reply', text: '接一句', contextVersion: 1, now: 1000, ttlSec: 180 })
assert.equal(planExpired(plan, 1000), false)
assert.equal(planExpired(plan, 200000), true)
assert.equal(recheckPlan({ plan, now: 2000, contextVersion: 1 }).cancel, false)
assert.equal(recheckPlan({ plan, now: 2000, contextVersion: 2 }).cancel, true)
assert.equal(recheckPlan({ plan, now: 2000, contextVersion: 2, newGate: { action: 'silence' } }).cancel, true)
assert.equal(recheckPlan({ plan, now: 2000, contextVersion: 2, newGate: { action: 'reply', relevance: 0.8 } }).cancel, false)

console.log('✓ group-policy / gate 全部通过')
