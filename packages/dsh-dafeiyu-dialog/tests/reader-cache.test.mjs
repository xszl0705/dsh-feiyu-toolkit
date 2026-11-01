import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDayReader } from '../lib/reader.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dialog-reader-'))
const dir = path.join(temp, 'dialogues')
fs.mkdirSync(dir, { recursive: true })

function writeDay(day, rows) {
  fs.writeFileSync(path.join(dir, `${day}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
}

test('同一天同一会话重复读只解析一次', () => {
  writeDay('2026-10-31', [
    { at: '2026-10-31T01:00:00Z', conversation: 'owner', role: 'user', text: '一' },
    { at: '2026-10-31T01:01:00Z', conversation: 'owner', role: 'assistant', text: '二' },
    { at: '2026-10-31T01:02:00Z', conversation: 'group:1', role: 'user', text: '三' },
  ])
  const reader = createDayReader({ dir })
  const first = reader.rowsFor({ day: '2026-10-31', conversation: 'owner' })
  assert.equal(first.length, 2)
  const second = reader.rowsFor({ day: '2026-10-31', conversation: 'owner' })
  assert.equal(second.length, 2)
  const stats = reader.stats()
  assert.equal(stats.misses, 1, '只应该解析一次')
  assert.equal(stats.hits, 1, '第二次应该命中缓存')
  assert.equal(stats.rowsParsed, 3)
})

test('不同会话从同一份解析结果里分组取', () => {
  const reader = createDayReader({ dir })
  const group = reader.rowsFor({ day: '2026-10-31', conversation: 'group:1' })
  assert.equal(group.length, 1)
  assert.equal(group[0].text, '三')
  assert.equal(reader.stats().misses, 1, '不应因为换会话而重读文件')
})

test('文件追加后 size 变化，缓存自动失效', () => {
  const reader = createDayReader({ dir })
  reader.rowsFor({ day: '2026-10-31', conversation: 'owner' })
  fs.appendFileSync(path.join(dir, '2026-10-31.jsonl'), JSON.stringify({ at: '2026-10-31T02:00:00Z', conversation: 'owner', role: 'user', text: '四' }) + '\n', 'utf8')
  const rows = reader.rowsFor({ day: '2026-10-31', conversation: 'owner' })
  assert.equal(rows.length, 3)
  assert.equal(reader.stats().misses, 2, '追加后应该重新解析')
})

test('坏行被跳过，不影响其它行', () => {
  fs.writeFileSync(path.join(dir, '2026-10-30.jsonl'), '{broken\n' + JSON.stringify({ at: '2026-10-30T01:00:00Z', conversation: 'owner', text: '好的' }) + '\n', 'utf8')
  const reader = createDayReader({ dir })
  const rows = reader.rowsFor({ day: '2026-10-30', conversation: 'owner' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].text, '好的')
})

test('文件不存在返回空数组，不抛错', () => {
  const reader = createDayReader({ dir })
  assert.deepEqual(reader.rowsFor({ day: '2026-01-01', conversation: 'owner' }), [])
  assert.deepEqual(reader.rowsFor({ day: '', conversation: 'owner' }), [])
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
