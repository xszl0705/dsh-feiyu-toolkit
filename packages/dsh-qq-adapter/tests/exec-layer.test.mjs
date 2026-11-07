/**
 * 执行层试点回归（阶段 1.3）：
 * - effects 按 idem_key 去重；claim 是 CAS；
 * - 租约过期的幂等动作退回 pending，非幂等进 unknown；
 * - 图片入库：同 bytes 只执行一次，staging 清理干净；
 * - 模拟崩溃：认领后进程没了，新实例能恢复并重放。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openExecStore, sqliteReady } from '../lib/exec-store.js'
import { createExecLayer } from '../lib/exec-layer.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-layer-'))
const skip = !sqliteReady() ? 'node:sqlite 不可用' : false

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

function fakeLibrary() {
  const calls = []
  return {
    calls,
    remember({ bytes }) {
      const digest = sha(bytes)
      calls.push(digest)
      return { ok: true, record: { id: digest.slice(0, 12), mediaType: 'image/png', animated: false } }
    },
  }
}

test('enqueue 按 idem_key 去重', { skip }, () => {
  const file = path.join(temp, 'dedupe.db')
  const store = openExecStore({ file })
  try {
    const first = store.enqueue({ kind: 'image.ingest', idemKey: 'image:x', payload: {} })
    const second = store.enqueue({ kind: 'image.ingest', idemKey: 'image:x', payload: {} })
    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(first.effect.id, second.effect.id)
    assert.equal(store.stats().total, 1)
  } finally {
    store.close()
  }
})

test('claim 是 CAS：同一条不会被认领两次', { skip }, () => {
  const file = path.join(temp, 'claim.db')
  const store = openExecStore({ file })
  try {
    store.enqueue({ kind: 'image.ingest', idemKey: 'image:y', payload: {} })
    const first = store.claim({ leaseMs: 30_000 })
    const second = store.claim({ leaseMs: 30_000 })
    assert.ok(first)
    assert.equal(second, null, '同一时刻只能有一个 worker 拿到同一条')
    store.finish(first.id, { status: 'done', result: { id: 'abc' } })
    assert.equal(store.stats().done, 1)
  } finally {
    store.close()
  }
})

test('租约过期的幂等 effect 退回 pending，非幂等进 unknown', { skip }, () => {
  const file = path.join(temp, 'recover.db')
  const store = openExecStore({ file })
  try {
    store.enqueue({ kind: 'image.ingest', idemKey: 'image:z', payload: {} })
    const idem = store.claim({ leaseMs: -1000 })
    assert.equal(idem.kind, 'image.ingest')
    store.enqueue({ kind: 'qq.send', idemKey: 'send:1', payload: {} })
    store.claim({ leaseMs: -1000 }) // 拿到 qq.send（FIFO 是 image 先，但 image 已 running）
    assert.equal(store.recover(), 2)
    assert.equal(store.getByIdem('image:z').status, 'pending')
    assert.equal(store.getByIdem('send:1').status, 'unknown')
  } finally {
    store.close()
  }
})

test('图片入库幂等：同 bytes 只执行一次，staging 清理', { skip }, async () => {
  const dir = path.join(temp, 'layer')
  const lib = fakeLibrary()
  const layer = createExecLayer({ dir, imageLibrary: lib, tickMs: 60_000 })
  try {
    const bytes = Buffer.from('fake-image-bytes')
    const first = await layer.ingestImage({ bytes, source: { channel: 'test' } })
    const second = await layer.ingestImage({ bytes, source: { channel: 'test' } })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(first.id, second.id)
    assert.equal(lib.calls.length, 1, '同一 sha 只应执行一次')
    assert.equal(layer.stats().done, 1)
    assert.deepEqual(fs.readdirSync(path.join(dir, 'staging')), [], 'staging 应清空')
  } finally {
    layer.close()
  }
})

test('崩溃恢复：认领后没 finish，新实例能重放', { skip }, async () => {
  const dir = path.join(temp, 'crash')
  const dbFile = path.join(dir, 'qq.db')
  const staged = path.join(dir, 'staging', 'pending.bin')
  fs.mkdirSync(path.dirname(staged), { recursive: true })
  fs.writeFileSync(staged, Buffer.from('crash-image'))

  const before = openExecStore({ file: dbFile })
  before.enqueue({ kind: 'image.ingest', idemKey: 'image:crash', payload: { stagingFile: staged, source: {} } })
  before.claim({ leaseMs: -1 })
  before.close()

  const lib = fakeLibrary()
  const layer = createExecLayer({ dir, imageLibrary: lib, tickMs: 60_000 })
  try {
    await layer.drain()
    assert.equal(layer.stats().done, 1)
    assert.equal(lib.calls.length, 1)
    assert.equal(fs.existsSync(staged), false, 'staging 文件应在成功后删掉')
  } finally {
    layer.close()
  }
})

test('done 记录超过保留期被清理', { skip }, () => {
  const file = path.join(temp, 'prune.db')
  const store = openExecStore({ file })
  try {
    const { effect } = store.enqueue({ kind: 'image.ingest', idemKey: 'image:old', payload: {} })
    store.finish(effect.id, { status: 'done', result: { id: 'old' } })
    store.db.prepare("UPDATE effects SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(effect.id)
    assert.equal(store.prune({ days: 1 }), 1)
    assert.equal(store.stats().total, 0)
  } finally {
    store.close()
  }
})

test('纯文字发送：成功 done、明确失败 failed、网络不确定 unknown（不重试）', { skip }, async () => {
  const dir = path.join(temp, 'send')
  const lib = fakeLibrary()
  let mode = 'ok'
  const layer = createExecLayer({
    dir,
    imageLibrary: lib,
    tickMs: 60_000,
    sendText: async () => {
      if (mode === 'fail') return { ok: false, retcode: 1200 }
      if (mode === 'throw') throw new Error('socket hang up')
      return { ok: true, retcode: 0 }
    },
  })
  try {
    const ok = await layer.send({ kind: 'private', targetId: '1', text: 'hi' })
    assert.equal(ok.ok, true)
    assert.equal(ok.retcode, 0)

    mode = 'fail'
    const failed = await layer.send({ kind: 'private', targetId: '1', text: 'hi' })
    assert.equal(failed.ok, false)
    assert.equal(failed.status, 'failed')

    mode = 'throw'
    const unknown = await layer.send({ kind: 'private', targetId: '1', text: 'hi' })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.unknown, true)

    const stats = layer.stats()
    assert.equal(stats.done, 1)
    assert.equal(stats.failed, 1)
    assert.equal(stats.unknown, 1)
  } finally {
    layer.close()
  }
})

test('崩溃恢复：qq.send 租约过期进 unknown，不自动重发', { skip }, async () => {
  const dir = path.join(temp, 'send-crash')
  const dbFile = path.join(dir, 'qq.db')
  const before = openExecStore({ file: dbFile })
  before.enqueue({ kind: 'qq.send', idemKey: 'send:crash', payload: { kind: 'private', targetId: '1', text: 'hi' } })
  before.claim({ leaseMs: -1 })
  before.close()

  let sends = 0
  const layer = createExecLayer({
    dir,
    imageLibrary: fakeLibrary(),
    tickMs: 60_000,
    sendText: async () => {
      sends += 1
      return { ok: true, retcode: 0 }
    },
  })
  try {
    await layer.drain()
    assert.equal(sends, 0, 'unknown 的发送不能被自动重放')
    assert.equal(layer.stats().unknown, 1)
  } finally {
    layer.close()
  }
})

test('对账：unknown 可列出，裁定 sent → done', { skip }, async () => {
  const dir = path.join(temp, 'reconcile')
  const layer = createExecLayer({
    dir,
    imageLibrary: fakeLibrary(),
    tickMs: 60_000,
    sendText: async () => {
      throw new Error('socket hang up')
    },
  })
  try {
    const res = await layer.send({ kind: 'private', targetId: '10001', text: '对账测试' })
    assert.equal(res.unknown, true)

    const rows = layer.listUnknown()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].channel, 'private')
    assert.equal(rows[0].targetId, '10001')
    assert.match(rows[0].text, /对账测试/)

    const first = layer.reconcile(rows[0].id, 'sent')
    assert.equal(first.ok, true)
    assert.equal(layer.stats().unknown, 0)
    assert.equal(layer.stats().done, 1)

    // 同一条不能被二次裁定：自动流转的状态不接受手工改写
    const again = layer.reconcile(rows[0].id, 'sent')
    assert.equal(again.ok, false)
    assert.equal(again.reason, 'not-unknown')
  } finally {
    layer.close()
  }
})

test('对账：not-sent → failed，非法 decision 与未知 id 被拒绝', { skip }, async () => {
  const dir = path.join(temp, 'reconcile-fail')
  const layer = createExecLayer({
    dir,
    imageLibrary: fakeLibrary(),
    tickMs: 60_000,
    sendText: async () => {
      throw new Error('timeout')
    },
  })
  try {
    await layer.send({ kind: 'group', targetId: '20002', text: 'x' })
    const rows = layer.listUnknown()
    assert.equal(rows.length, 1)

    const bad = layer.reconcile(rows[0].id, 'maybe')
    assert.equal(bad.ok, false)
    assert.match(bad.reason, /sent 或 not-sent/)

    assert.equal(layer.reconcile('eff_nope', 'sent').reason, 'not-found')

    const done = layer.reconcile(rows[0].id, 'not-sent')
    assert.equal(done.ok, true)
    assert.equal(layer.stats().unknown, 0)
    assert.equal(layer.stats().failed, 1)
  } finally {
    layer.close()
  }
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
