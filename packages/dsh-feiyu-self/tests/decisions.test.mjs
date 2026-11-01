import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDecisionLog, sanitizeDecision, validateDecision } from '../lib/decisions.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-decisions-'))

test('合法决策写入并按 kind 查回', () => {
  const log = createDecisionLog({ root: temp })
  const result = log.record({ kind: 'route', choice: 'local', reason: '短句且本地模型可用', cost: { tokens: 0 } })
  assert.equal(result.ok, true)
  const rows = log.query({ kind: 'route' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].choice, 'local')
  assert.equal(rows[0].privacy.containsUserText, false)
  log.close()
})

test('缺 kind / choice 的记录被拒，不抛错', () => {
  const log = createDecisionLog({ root: temp })
  assert.equal(log.record({ choice: 'x' }).ok, false)
  assert.equal(log.record({ kind: 'reply' }).ok, false)
  log.close()
})

test('用户正文不会进日志', () => {
  const row = sanitizeDecision({ kind: 'reply', choice: 'sent', text: '这是一条不该落盘的私聊', reply: '也不该', reason: '正常回复' })
  assert.equal(row.text, undefined)
  assert.equal(row.reply, undefined)
  assert.equal(row.reason, '正常回复')
  const payload = JSON.stringify(row)
  assert.equal(payload.includes('不该落盘'), false)
})

test('超长字符串被截断，嵌套对象保留有限深度', () => {
  const row = sanitizeDecision({ kind: 'memory', choice: 'inserted', reason: 'a'.repeat(1000), cost: { tokens: 12, nested: { deep: { deeper: 'x' } } } })
  assert.equal(row.reason.length, 300)
  assert.equal(row.cost.tokens, 12)
})

test('非法 kind 命名被拒', () => {
  assert.equal(validateDecision({ kind: 'Route', choice: 'x' }).ok, false)
  assert.equal(validateDecision({ kind: 'route', choice: 'x' }).ok, true)
})

test('tally 按 choice 聚合', () => {
  const log = createDecisionLog({ root: temp })
  log.record({ kind: 'autostart', choice: 'launched' })
  log.record({ kind: 'autostart', choice: 'launched' })
  log.record({ kind: 'autostart', choice: 'cooldown' })
  const tally = log.tally({ kind: 'autostart' })
  assert.equal(tally.total, 3)
  assert.equal(tally.byChoice.launched, 2)
  assert.equal(tally.byChoice.cooldown, 1)
  log.close()
})

test('坏行跳过，好行照常读出', () => {
  const log = createDecisionLog({ root: temp })
  const file = path.join(temp, 'decisions', new Date().toISOString().slice(0, 10) + '.jsonl')
  fs.appendFileSync(file, '{broken json\n', 'utf8')
  log.record({ kind: 'deploy', choice: 'skipped' })
  const rows = log.query({ kind: 'deploy' })
  assert.equal(rows.length, 1)
  log.close()
})

test('关闭后不再写入', () => {
  const log = createDecisionLog({ root: temp })
  log.close()
  assert.equal(log.record({ kind: 'deploy', choice: 'x' }).ok, false)
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
