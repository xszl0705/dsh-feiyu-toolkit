/**
 * 执行层四表：inbox 去重入场、work CAS 认领、口子计数、终态回收。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openExecStore, sqliteReady } from '../lib/exec-store.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-inbox-'))
const file = path.join(dir, 'test.db')
let store = null

test('node:sqlite 可用', () => {
  assert.equal(sqliteReady(), true, '执行层需要 node:sqlite；不可用时应走回退路径')
  store = openExecStore({ file })
})

test('inbox：同 source+external_id 只入一条', () => {
  const a = store.acceptIntoInbox({ source: 'qq', externalId: 'm1', thread: 'group:1', actor: 'u1', text: '在吗' })
  assert.equal(a.created, true)
  const b = store.acceptIntoInbox({ source: 'qq', externalId: 'm1', thread: 'group:1', actor: 'u1', text: '在吗' })
  assert.equal(b.created, false, '重复投递不应再插一条')
  assert.equal(b.inbox.id, a.inbox.id)
  const c = store.acceptIntoInbox({ source: 'dialog', externalId: 'm1', thread: 'dsh:1', text: '你好' })
  assert.equal(c.created, true, '不同 source 的同 id 是不同事件')
  assert.equal(store.acceptIntoInbox({ source: 'qq', externalId: '', text: 'x' }).created, false, '空外部 id 不入场')
})

test('inbox：认领是 CAS，不会重复给两个人', () => {
  store.acceptIntoInbox({ source: 'qq', externalId: 'm2', thread: 'private:2', text: 'hi' })
  const first = store.claimInbox({ limit: 10 })
  const second = store.claimInbox({ limit: 10 })
  assert.ok(first.length >= 1)
  assert.equal(second.length, 0, '已被认领的不应再出现')
  const ids = new Set(first.map((row) => row.id))
  assert.equal(ids.size, first.length)
})

test('inbox：settle 只接受 claimed 的记录', () => {
  const claimed = store.claimInbox({ limit: 1 })
  if (claimed.length) {
    assert.equal(store.settleInbox(claimed[0].id, 'done').ok, true)
    assert.equal(store.settleInbox(claimed[0].id, 'done').ok, false, '重复 settle 应拒绝')
  }
  assert.equal(store.settleInbox('nope', 'done').ok, false)
  assert.equal(store.settleInbox('nope', 'weird').reason, 'bad-status')
})

test('work：开工单 → CAS 认领 → 报结果', () => {
  const inbox = store.acceptIntoInbox({ source: 'qq', externalId: 'm3', thread: 'group:3', text: '画个图' }).inbox
  const work = store.openWork({ inboxId: inbox.id, mandate: { scope: 'owner' }, thread: 'group:3' })
  assert.equal(work.status, 'open')
  assert.equal(JSON.parse(work.mandate).scope, 'owner')

  const claimed = store.claimWork()
  assert.equal(claimed.id, work.id)
  assert.equal(claimed.status, 'running')
  assert.equal(store.claimWork(), null, '没有第二个 open 工单')

  assert.equal(store.reportWork(work.id, { status: 'done', report: { summary: 'ok' } }).ok, true)
  assert.equal(store.reportWork(work.id, { status: 'weird' }).reason, 'bad-status')
  assert.equal(store.listWork({ status: 'done' }).length, 1)
})

test('counts 与 prune', () => {
  const c = store.counts()
  assert.equal(typeof c.inboxNew, 'number')
  assert.equal(typeof c.workOpen, 'number')
  assert.ok(c.inboxClaimed + c.inboxNew >= 1)
  const removed = store.prune({ days: 0 })
  assert.equal(typeof removed, 'number')
})

test('关闭', () => {
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
