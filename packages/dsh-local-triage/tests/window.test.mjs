import assert from 'node:assert/strict'
import { createHarness } from './_harness.mjs'
import { keepRecent, dropToBudget, approxTokens } from '../lib/window.mjs'

const h = createHarness('window.test')

h.check('keepRecent 保留最近 n 条', () => {
  const r = keepRecent([1, 2, 3, 4, 5], 2)
  assert.deepEqual(r.kept, [4, 5])
  assert.equal(r.dropped, 3)
})

h.check('keepRecent 不足 n 条时全留', () => {
  const r = keepRecent([1, 2], 5)
  assert.deepEqual(r.kept, [1, 2])
  assert.equal(r.dropped, 0)
})

h.check('keepRecent n=0 时清空', () => {
  const r = keepRecent([1, 2, 3], 0)
  assert.deepEqual(r.kept, [])
  assert.equal(r.dropped, 3)
})

h.check('keepRecent 处理非数组输入', () => {
  const r = keepRecent(null, 3)
  assert.deepEqual(r.kept, [])
  assert.equal(r.dropped, 0)
})

h.check('dropToBudget 按给定顺序让位', () => {
  const blocks = { a: 'x'.repeat(100), b: 'y'.repeat(100), c: 'z'.repeat(50) }
  const r = dropToBudget(blocks, { budget: 160, order: ['a', 'b', 'c'] })
  assert.equal(r.blocks.a, '')
  assert.ok(r.size <= 160)
  assert.ok(r.dropped.includes('a'))
})

h.check('dropToBudget 不超预算时不动任何块', () => {
  const blocks = { a: 'abc' }
  const r = dropToBudget(blocks, { budget: 100, order: ['a'] })
  assert.equal(r.blocks.a, 'abc')
  assert.deepEqual(r.dropped, [])
})

h.check('dropToBudget 顺序丢完仍超时，按体积从大到小继续丢', () => {
  const blocks = { keep: 'k'.repeat(10), big: 'b'.repeat(200), mid: 'm'.repeat(100) }
  const r = dropToBudget(blocks, { budget: 120, order: [] })
  assert.ok(r.size <= 120)
  assert.equal(r.blocks.big, '')
  assert.ok(r.dropped.length >= 1)
})

h.check('dropToBudget budget=0 视为不限', () => {
  const blocks = { a: 'x'.repeat(1000) }
  const r = dropToBudget(blocks, { budget: 0, order: ['a'] })
  assert.equal(r.blocks.a.length, 1000)
})

h.check('approxTokens 中文按字计', () => {
  assert.equal(approxTokens('你好世界'), 4)
})

h.check('approxTokens 英文按 4 字符计', () => {
  assert.equal(approxTokens('abcd'), 1)
})

h.finish()
