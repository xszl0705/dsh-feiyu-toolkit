/**
 * Trigger 影子模式回归：结构稳定、fast path 规则对齐、落盘可汇总。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildTrigger, fastPath, recordTrigger, summarizeDispositions, triggerId } from '../lib/trigger.js'

const priv = (text = '你好') => ({ kind: 'private', userId: '10001', groupId: '', messageId: 'm1', text, atSelf: false })
const grp = (over = {}) => ({ kind: 'group', userId: '20002', groupId: '30003', messageId: 'm2', text: '在吗', atSelf: false, ...over })

const cfg = (over = {}) => ({ allowPrivate: true, groups: ['30003'], groupTrigger: 'at', ...over })

test('Trigger 结构完整且 id 稳定', () => {
  const a = buildTrigger(priv('hi'))
  const b = buildTrigger(priv('hi'))
  assert.equal(a.id, b.id, '同一条事件两次构建应同 id')
  assert.equal(a.source, 'qq')
  assert.equal(a.thread, 'private:10001')
  assert.equal(a.human, true)
  assert.equal(typeof a.at, 'number')
  assert.equal(a.meta.messageId, 'm1')
  assert.equal(triggerId('qq', 'x').length, 16)
})

test('同源不同消息 id 不同；不同来源同消息 id 不同', () => {
  const a = buildTrigger({ ...priv(), messageId: 'a' })
  const b = buildTrigger({ ...priv(), messageId: 'b' })
  assert.notEqual(a.id, b.id)
  const c = buildTrigger(priv(), { source: 'dialog' })
  assert.notEqual(c.id, a.id)
  assert.equal(c.source, 'dialog')
})

test('fast path：私聊放行 / 私聊关闭拒绝', () => {
  assert.deepEqual(fastPath(buildTrigger(priv()), cfg()), { decision: 'accept', rule: 'private_allow' })
  assert.deepEqual(fastPath(buildTrigger(priv()), cfg({ allowPrivate: false })), { decision: 'ignore', rule: 'private_disabled' })
})

test('fast path：群白名单、@ 与唤醒词', () => {
  assert.deepEqual(fastPath(buildTrigger(grp()), cfg()), { decision: 'ignore', rule: 'not_addressed' })
  assert.equal(fastPath(buildTrigger(grp({ atSelf: true })), cfg()).decision, 'accept')
  assert.equal(fastPath(buildTrigger(grp()), cfg({ groups: [] })).rule, 'no_group_whitelist')
  assert.equal(fastPath(buildTrigger(grp({ groupId: '99999' })), cfg()).rule, 'group_not_whitelisted')
  assert.equal(fastPath(buildTrigger(grp()), cfg({ groupTrigger: 'auto' })).decision, 'accept')
  assert.equal(fastPath(buildTrigger(grp({ text: '大肥鱼在吗' })), cfg({ groupTrigger: 'wake', wakeWords: ['大肥鱼'] })).decision, 'accept')
  assert.equal(fastPath(buildTrigger(grp()), cfg({ groupTrigger: 'wake', wakeWords: ['大肥鱼'] })).decision, 'ignore')
})

test('影子落盘：一行一条，fast 与 actual 都在，可汇总', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-shadow-'))
  try {
    recordTrigger(priv(), cfg(), { dir })
    recordTrigger(grp(), cfg(), { dir })
    recordTrigger(grp({ atSelf: true }), cfg(), { dir })
    const sum = summarizeDispositions(dir)
    assert.equal(sum.total, 3)
    assert.equal(sum.fastAccept, 2, '私聊 + @ 应判 accept')
    assert.equal(sum.actualAccept, 2)
    assert.equal(sum.mismatch, 0, '影子与现网判断应一致')
    assert.equal(sum.byRule.private_allow, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('开关关闭时不落盘；异常输入不抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-off-'))
  try {
    assert.equal(recordTrigger(priv(), { ...cfg(), triggerShadow: false }, { dir }), null)
    assert.equal(recordTrigger(null, cfg(), { dir }), null)
    assert.equal(summarizeDispositions(dir).total, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
