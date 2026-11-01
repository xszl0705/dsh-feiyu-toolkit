import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSnapshot, deriveLimits, diffSnapshot, emptySnapshot, snapshotHash } from '../lib/self-model.js'

test('空快照的每个未知字段都是 unknown，不是编的', () => {
  const snap = emptySnapshot(new Date('2026-10-31T05:00:00Z'))
  assert.equal(snap.identity.name, 'unknown')
  assert.equal(snap.state.channel, 'unknown')
  assert.deepEqual(snap.capabilities, [])
  assert.equal(snap.structure.missing.length, 0)
})

test('能力按 id 排序，缺 limits 标记 degraded', () => {
  const snap = buildSnapshot({
    capabilities: [
      { id: 'qq', intent: '收发消息', limits: ['不能加好友'], failureModes: [{ code: 'NAPCAT_DOWN' }] },
      { id: 'brain', intent: '路由', limits: [], failureModes: [] },
    ],
  })
  assert.deepEqual(snap.capabilities.map((item) => item.id), ['brain', 'qq'])
  const brain = snap.capabilities.find((item) => item.id === 'brain')
  assert.equal(brain.degraded, true)
  assert.equal(snap.capabilities.find((item) => item.id === 'qq').degraded, false)
})

test('structure.missing 只列「已知但没声明」的插件', () => {
  const snap = buildSnapshot({ structure: { known: ['a', 'b', 'c'], declared: ['b'] } })
  assert.deepEqual(snap.structure.declared, ['b'])
  assert.deepEqual(snap.structure.missing, ['a', 'c'])
})

test('diff 能看出新增、移除、服务变化', () => {
  const before = buildSnapshot({ capabilities: [{ id: 'a', intent: 'x' }], state: { services: { memory: 'up' } } })
  const after = buildSnapshot({ capabilities: [{ id: 'b', intent: 'y' }], state: { services: { memory: 'down' } } })
  const diff = diffSnapshot(before, after)
  assert.deepEqual(diff.added, ['b'])
  assert.deepEqual(diff.removed, ['a'])
  assert.equal(diff.changed, true)
  assert.deepEqual(diff.services.memory, { before: 'up', after: 'down' })
})

test('内容不变时 diff 说没变，时间戳不影响 hash', () => {
  const a = buildSnapshot({ capabilities: [{ id: 'a', intent: 'x' }], now: new Date('2026-10-31T05:00:00Z') })
  const b = buildSnapshot({ capabilities: [{ id: 'a', intent: 'x' }], now: new Date('2026-10-31T06:00:00Z') })
  assert.equal(diffSnapshot(a, b).changed, false)
  assert.equal(snapshotHash(a), snapshotHash(b))
})

test('limits 来自声明与真实观测，不算模型自述', () => {
  const limits = deriveLimits({
    capabilities: [{ id: 'qq', limits: ['不能主动加好友'] }],
    decisions: { byChoice: { rejected: 2, sent: 10 } },
    services: { memory: 'down' },
  })
  const texts = limits.map((item) => item.text)
  assert.ok(texts.includes('不能主动加好友'))
  assert.ok(texts.some((text) => text.includes('rejected')))
  assert.ok(texts.some((text) => text.includes('memory')))
  assert.equal(limits.some((item) => item.text.includes('sent')), false)
})
