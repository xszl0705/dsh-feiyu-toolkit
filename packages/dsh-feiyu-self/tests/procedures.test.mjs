import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createProcedureStore,
  extractFromChanges,
  extractFromDecisions,
  matchProcedures,
  mergeProcedures,
} from '../lib/procedures.js'

const dec = (kind, choice, at = '2026-10-31T01:00:00Z') => ({ at, kind, choice })

test('失败模式出现不足 3 次不进经验', () => {
  const rows = [dec('memory', 'rejected'), dec('memory', 'rejected')]
  assert.deepEqual(extractFromDecisions({ decisions: rows, minRepeats: 3 }), [])
})

test('同一失败模式出现 3 次以上生成一条经验', () => {
  const rows = [dec('memory', 'rejected'), dec('memory', 'rejected'), dec('memory', 'rejected')]
  const procedures = extractFromDecisions({ decisions: rows, minRepeats: 3 })
  assert.equal(procedures.length, 1)
  assert.equal(procedures[0].kind, 'failure-pattern')
  assert.ok(procedures[0].trigger.includes('memory'))
  assert.deepEqual(procedures[0].conditions, ['kind:memory', 'choice:rejected'])
  assert.equal(procedures[0].outcome.failed, 3)
  assert.ok(procedures[0].confidence > 0.3)
})

test('成功类决策不会被当成失败经验', () => {
  const rows = [dec('reply', 'sent'), dec('reply', 'sent'), dec('reply', 'sent')]
  assert.deepEqual(extractFromDecisions({ decisions: rows }), [])
})

test('被回滚的改动变成「别再这么做」', () => {
  const changes = [{ id: 'chg_1', title: '把群参与率降到 90%', status: 'rolled-back', diff: { 'qq.groupRate.variants': {} } }]
  const procedures = extractFromChanges({ changes })
  assert.equal(procedures.length, 1)
  assert.equal(procedures[0].kind, 'reverted-change')
  assert.ok(procedures[0].action.includes('失败过一次'))
  assert.deepEqual(procedures[0].conditions, ['field:variants'])
})

test('保留的改动变成「可以继续观察」', () => {
  const changes = [{ id: 'chg_2', title: '开 5% 灰度', status: 'applied', diff: { 'f.enabled': true } }]
  const procedures = extractFromChanges({ changes })
  assert.equal(procedures[0].kind, 'kept-change')
  assert.equal(procedures[0].outcome.failed, 0)
})

test('同一条经验再出现时合并次数，置信度取高', () => {
  const a = extractFromDecisions({ decisions: [dec('memory', 'rejected'), dec('memory', 'rejected'), dec('memory', 'rejected')] })
  const b = extractFromDecisions({ decisions: [dec('memory', 'rejected'), dec('memory', 'rejected'), dec('memory', 'rejected')] })
  const merged = mergeProcedures(a, b)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].outcome.attempts, 6)
  assert.ok(merged[0].confidence >= a[0].confidence)
})

test('按上下文匹配经验，命中的排前面', () => {
  const procedures = [
    { id: 'a', conditions: ['kind:route'], trigger: '路由失败', action: 'x' },
    { id: 'b', conditions: ['kind:memory'], trigger: '记忆被拒', action: 'y' },
  ]
  const hit = matchProcedures({ procedures, context: { kind: 'memory' } })
  assert.equal(hit.length, 1)
  assert.equal(hit[0].id, 'b')
  assert.equal(hit[0].score, 2)
})

test('存储层：写入、读取、统计', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'procedures-'))
  const store = createProcedureStore({ dir: temp })
  const result = store.extract({
    decisions: [dec('memory', 'rejected'), dec('memory', 'rejected'), dec('memory', 'rejected')],
    changes: [{ id: 'chg_1', title: '测试改动', status: 'rolled-back', diff: {} }],
  })
  assert.equal(result.added, 2)
  const rows = store.list()
  assert.equal(rows.length, 2)
  const stats = store.stats()
  assert.equal(stats.total, 2)
  assert.ok(stats.byKind['failure-pattern'] >= 1)
  // 再提炼一次不重复增加
  store.extract({ decisions: [dec('memory', 'rejected')] })
  assert.equal(store.list().length, 2)
  fs.rmSync(temp, { recursive: true, force: true })
})
