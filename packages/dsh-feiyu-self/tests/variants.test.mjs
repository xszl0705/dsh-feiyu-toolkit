import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bucketOf, createFlagStore, evaluateFlag, validateFlag } from '../lib/variants.js'

const flag = (overrides = {}) => ({
  enabled: true,
  variants: { control: 90, experiment: 10 },
  stickyKey: 'conversation',
  audience: { channel: ['qq'] },
  ...overrides,
})

test('分桶稳定：同一个 key 永远同一个桶', () => {
  assert.equal(bucketOf('group:1', 'route.modelHint'), bucketOf('group:1', 'route.modelHint'))
  assert.ok(bucketOf('a', 'f') >= 0 && bucketOf('a', 'f') < 100)
  assert.notEqual(bucketOf('a', 'f'), bucketOf('b', 'f'))
})

test('90/10 的权重在 1000 个会话上大致按比例分', () => {
  let experiment = 0
  for (let i = 0; i < 1000; i += 1) {
    const result = evaluateFlag({ name: 'route.modelHint', flag: flag(), context: { channel: 'qq', conversation: `group:${i}` } })
    if (result.variant === 'experiment') experiment += 1
  }
  assert.ok(experiment > 50 && experiment < 160, `experiment=${experiment}`)
})

test('关闭、受众不匹配、缺 sticky key 都退回 control', () => {
  assert.equal(evaluateFlag({ name: 'f', flag: flag({ enabled: false }), context: { channel: 'qq', conversation: 'a' } }).reason, 'disabled')
  assert.equal(evaluateFlag({ name: 'f', flag: flag(), context: { channel: 'dsh', conversation: 'a' } }).reason, 'audience-miss')
  assert.equal(evaluateFlag({ name: 'f', flag: flag(), context: { channel: 'qq' } }).reason, 'missing-conversation')
})

test('权重合计不是 100 时判为非法，不硬跑', () => {
  const result = evaluateFlag({ name: 'f', flag: flag({ variants: { control: 50, experiment: 30 } }), context: { channel: 'qq', conversation: 'a' } })
  assert.equal(result.reason, 'invalid-config')
  assert.equal(result.variant, 'control')
  assert.equal(validateFlag('f', flag()).ok, true)
})

test('store 读文件，改文件后立即生效（不需要重启）', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flags-'))
  const file = path.join(temp, 'flags.json')
  fs.writeFileSync(file, JSON.stringify({ f: flag() }), 'utf8')
  const store = createFlagStore({ file })
  assert.equal(store.get('f').enabled, true)
  // 模拟「回滚」：把 flag 关掉，改文件时间戳
  fs.writeFileSync(file, JSON.stringify({ f: flag({ enabled: false }) }), 'utf8')
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(file, future, future)
  assert.equal(store.evaluate('f', { channel: 'qq', conversation: 'a' }).reason, 'disabled')
})

test('文件不存在时用 fallback，坏 JSON 时保留上一次的内容', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flags-'))
  const file = path.join(temp, 'flags.json')
  const store = createFlagStore({ file, fallback: { f: flag() } })
  assert.equal(store.get('f').enabled, true)
  fs.writeFileSync(file, '{broken', 'utf8')
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(file, future, future)
  assert.equal(store.get('f').enabled, true)
  assert.equal(store.state().broken, true)
  fs.rmSync(temp, { recursive: true, force: true })
})

test('list 返回可读的 flag 清单', () => {
  const store = createFlagStore({ fallback: { f: flag() } })
  const rows = store.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'f')
  assert.equal(rows[0].valid, true)
  assert.equal(rows[0].stickyKey, 'conversation')
})
