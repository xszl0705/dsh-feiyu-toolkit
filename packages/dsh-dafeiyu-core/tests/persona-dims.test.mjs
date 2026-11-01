import test from 'node:test'
import assert from 'node:assert/strict'
import { readPersonaDims } from '../index.js'

const block = (json) => `# 我是谁\n\n正文……\n\n<!-- persona-dims\n${json}\n-->\n`

test('从 persona.md 里读出人格数值块', () => {
  const dims = readPersonaDims(block('{"extraversion":0.8,"agreeableness":0.7,"conscientiousness":0.5,"neuroticism":0.45,"openness":0.65}'))
  assert.equal(dims.extraversion, 0.8)
  assert.equal(dims.openness, 0.65)
})

test('越界的值被夹到 0–1，非法值被丢弃', () => {
  const dims = readPersonaDims(block('{"extraversion":9,"agreeableness":-3,"openness":"x"}'))
  assert.equal(dims.extraversion, 1)
  assert.equal(dims.agreeableness, 0)
  assert.equal('openness' in dims, false)
})

test('没有这块就返回 null，不编默认值', () => {
  assert.equal(readPersonaDims('# 只是普通人格文本\n没有维度块'), null)
})

test('坏 JSON 返回 null，不影响人格加载', () => {
  assert.equal(readPersonaDims(block('{不是 JSON}')), null)
})

test('空块返回 null', () => {
  assert.equal(readPersonaDims(block('{}')), null)
})
