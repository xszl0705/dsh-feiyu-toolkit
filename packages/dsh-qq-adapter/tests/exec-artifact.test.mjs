import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openExecStore } from '../lib/exec-store.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-art-'))
const file = path.join(dir, 'test.db')

test('artifacts 表：记录与查询', () => {
  const store = openExecStore({ file })
  const work = store.openWork({ mandate: { goal: '整理报告' } })
  const saved = store.recordArtifact({
    taskId: work.id,
    path: 'E:\\out\\report.md',
    format: 'md',
    hash: 'abc123',
    validationResult: 'ok',
    deliveryState: 'file',
  })
  assert.equal(saved.ok, true)
  const list = store.listArtifacts(work.id)
  assert.equal(list.length, 1)
  assert.equal(list[0].path, 'E:\\out\\report.md')
  assert.ok(list[0].validated_at, '有校验时间才算有证据')
  store.close()
})

test('旧库重开不报错（ensureColumns 幂等）', () => {
  const store = openExecStore({ file })
  assert.ok(store.listArtifacts().length >= 1)
  store.close()
})

test('缺 path 拒绝记录', () => {
  const store = openExecStore({ file })
  const r = store.recordArtifact({ taskId: 't1' })
  assert.equal(r.ok, false)
  store.close()
})
