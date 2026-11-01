import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryTools } from '../lib/tools.js'
import { MemoryStore } from '../lib/store.js'

// 假的 self 服务：只收决策，不落盘。测的是「工具有没有把决策报出去」。
const records = []
globalThis[Symbol.for('dsh-feiyu-self.service')] = { record: (entry) => records.push(entry) }

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-decisions-'))
const store = new MemoryStore(temp)
const tools = Object.fromEntries(createMemoryTools({ store, config: {} }).map((tool) => [tool.name, tool]))

test('写入、重复、敏感拒绝都各记一条决策', async () => {
  records.length = 0
  const inserted = await tools.memory.execute({ action: 'remember', text: '喜欢喝豆浆不加糖', folder: '喜好' })
  assert.equal(inserted.ok, true)
  const duplicate = await tools.memory.execute({ action: 'remember', text: '喜欢喝豆浆不加糖', folder: '喜好' })
  assert.equal(duplicate.result.action, 'duplicate')
  const rejected = await tools.memory.execute({ action: 'remember', text: '我的 api key 是 sk-abcdef123456', folder: '机密' })
  assert.equal(rejected.ok, false)
  assert.deepEqual(
    records.map((row) => row.choice),
    ['inserted', 'duplicate', 'rejected'],
  )
  assert.equal(records[2].reason, 'sensitive')
  assert.equal(records[0].kind, 'memory')
  assert.equal(records[0].scope, 'owner')
})

test('决策里没有正文', async () => {
  const payload = JSON.stringify(records)
  assert.equal(payload.includes('豆浆'), false)
  assert.equal(payload.includes('api key'), false)
  assert.equal(payload.includes('sk-abc'), false)
})

test('self 服务不存在时不崩', async () => {
  delete globalThis[Symbol.for('dsh-feiyu-self.service')]
  const result = await tools.memory.execute({ action: 'remember', text: '没有 self 也能写', folder: '回归' })
  assert.equal(result.ok, true)
})

test('未知 action 返回 ok:false 而不是抛错', async () => {
  const result = await tools.memory.execute({ action: 'nope', text: 'x' })
  assert.equal(result.ok, false)
  assert.match(String(result.result.error), /unknown action/)
})

test('合并后只注册一个工具', () => {
  assert.deepEqual(createMemoryTools({ store, config: {} }).map((tool) => tool.name), ['memory'])
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
