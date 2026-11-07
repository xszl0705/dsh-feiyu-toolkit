/**
 * 2.2 订阅直通 · 影子记录器：只写 JSONL、不改行为；关掉时零副作用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createShadowRecorder, estimateTokens, recordGroupMessage, shadowEntryOf, shadowFile } from '../lib/subscribe-shadow.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-'))

test('estimateTokens 按 1.6 字符/token 向上取整', () => {
  assert.equal(estimateTokens(0), 0)
  assert.equal(estimateTokens(8), 5)
  assert.equal(estimateTokens(1.6), 1)
  assert.equal(estimateTokens(32), 20)
})

test('关闭时一条都不写', () => {
  const r = createShadowRecorder({ dir: path.join(temp, 'off'), enabled: false })
  assert.equal(r.record({ chars: 10 }), null)
  assert.equal(fs.existsSync(r.dir), false)
})

test('开启时按天写 JSONL，字段齐全', () => {
  const dir = path.join(temp, 'on')
  const r = createShadowRecorder({ dir, enabled: true })
  const row = r.record({ groupId: '42', chars: 20, queued: true })
  assert.equal(row.chars, 20)
  assert.equal(row.estTokens, 13)
  assert.equal(row.wouldCard, true)
  const file = shadowFile(dir)
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const parsed = JSON.parse(lines[0])
  assert.equal(parsed.groupId, '42')
  assert.equal(parsed.queued, true)
  assert.ok(parsed.at)
})

test('写盘失败也不抛（目录不可写时静默）', () => {
  const r = createShadowRecorder({ dir: path.join(temp, 'on', 'nested', '\u0000bad'), enabled: true })
  assert.equal(r.record({ chars: 3 }), null)
})

test('shadowEntryOf 从 event 抽字段', () => {
  const row = shadowEntryOf({ groupId: 7, userId: 9, senderName: 'a', text: '你好呀' }, { queued: false })
  assert.equal(row.groupId, '7')
  assert.equal(row.threadKey, 'group:7')
  assert.equal(row.chars, 3)
  assert.equal(row.queued, false)
})

test('recordGroupMessage 默认关（config 未开），开启后复用 st 上的记录器', () => {
  const st = {}
  assert.equal(recordGroupMessage({ config: {} }, st, { groupId: '1', text: 'x' }), null)
  assert.equal(st.shadowRecorder, undefined)

  const dir = path.join(temp, 'cfg')
  const runtime = { config: { subscribeShadow: { enabled: true, dir } } }
  const first = recordGroupMessage(runtime, st, { groupId: '1', text: '十二个字的一句话内容' }, { queued: true })
  assert.ok(first)
  assert.equal(st.shadowRecorder.dir, dir)
  const second = recordGroupMessage(runtime, st, { groupId: '2', text: 'y' })
  assert.equal(second.groupId, '2')
  const lines = fs.readFileSync(shadowFile(dir), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
