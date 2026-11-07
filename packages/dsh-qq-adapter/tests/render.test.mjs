import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldSendAsFile, splitForChannel } from '../lib/render.js'

test('短文本单条', () => {
  const r = splitForChannel('你好', { limit: 100 })
  assert.deepEqual(r.parts, ['你好'])
  assert.equal(r.truncated, false)
})

test('空文本返回空数组', () => {
  assert.deepEqual(splitForChannel('').parts, [])
})

test('长文本按行拆且拼回不丢行', () => {
  const text = Array.from({ length: 10 }, (_, i) => `第${i}行内容`).join('\n')
  const r = splitForChannel(text, { limit: 30, maxParts: 10 })
  assert.ok(r.parts.length > 1)
  assert.equal(r.parts.join('\n'), text)
})

test('代码块不因拆分被删', () => {
  const text = '说明：\n```js\nconsole.log(1)\n```\n结束。'
  const r = splitForChannel(text, { limit: 1000 })
  assert.ok(r.parts[0].includes('console.log(1)'))
})

test('超长单行触发 hardCut 信号', () => {
  const r = splitForChannel('x'.repeat(200), { limit: 50, maxParts: 2 })
  assert.equal(r.hardCut, true)
})

test('shouldSendAsFile 判断多段需要转文件', () => {
  assert.equal(shouldSendAsFile({ parts: ['a'] }), false)
  assert.equal(shouldSendAsFile({ parts: ['a', 'b'] }), true)
  assert.equal(shouldSendAsFile({ parts: ['a'], hardCut: true }), true)
})
