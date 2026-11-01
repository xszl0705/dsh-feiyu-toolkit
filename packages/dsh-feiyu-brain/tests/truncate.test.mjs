import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldEscalate, truncateAtSentence } from '../index.js'

test('短文本原样返回', () => {
  assert.equal(truncateAtSentence('今天天气不错', 120), '今天天气不错')
  assert.equal(truncateAtSentence('', 120), '')
})

test('长文本切在句末标点，而不是硬切', () => {
  const text = '第一句话讲背景。第二句话讲结论。第三句是补充说明，还有很多细节没说完。'
  const out = truncateAtSentence(text, 20)
  assert.ok(out.length <= 20)
  assert.ok(/[。！？；]$/.test(out), `实际结尾：${out}`)
})

test('没有句末标点时退到逗号，不把句子切成相反意思', () => {
  const text = '不是因为他不想去，而是因为那天临时有事走不开，所以最后没成行。'
  const out = truncateAtSentence(text, 18)
  assert.ok(out.length <= 18)
  assert.ok(out.includes('不是因为他不想去'), `实际：${out}`)
  assert.ok(/[，,]$/.test(out), `实际结尾：${out}`)
})

test('完全没有标点时按长度截断', () => {
  const text = '一'.repeat(50)
  assert.equal(truncateAtSentence(text, 12).length, 12)
})

test('reasoning-leak 默认会被识别', () => {
  assert.equal(shouldEscalate('首先，用户问的是这个问题，然后我需要回答', '问题'), 'reasoning-leak')
})

test('escalateOnReasoningLeak 关掉后不再因为推理泄漏升级', () => {
  assert.equal(shouldEscalate('首先，用户问的是这个问题', '问题', { escalateOnReasoningLeak: false }), '')
})

test('其他升级理由不受配置影响', () => {
  assert.equal(shouldEscalate('', '问'), 'empty')
  assert.equal(shouldEscalate('记不清了', '你记得吗？'), 'no-answer')
})
