import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-svc-'))
process.env.DSH_HOME = temp

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)

const declared = []
globalThis[Symbol.for('dsh-feiyu-self.service')] = { declare: (manifest) => declared.push(manifest) }

const ctx = {
  logger: { info() {}, warn() {} },
  get: () => undefined,
  effect: (fn) => fn(),
  provide: () => {},
}
const api = mod.apply(ctx)

test('apply 返回服务，默认库在 DSH_HOME 下', () => {
  assert.ok(api)
  assert.equal(typeof api.search, 'function')
  const stats = api.stats()
  assert.ok(stats.dbFile.startsWith(temp), stats.dbFile)
  assert.equal(stats.items, 0)
})

test('查询必须带 groupId，不带就返回空', () => {
  assert.deepEqual(api.search('任何东西'), [])
  assert.deepEqual(api.search('任何东西', { channel: 'qq-group' }), [])
})

test('图片描述按群写入后能按群检索', async () => {
  api.ingestImage({ url: 'https://example.com/a.png', caption: 'ALPHA_ONLY 的截图说明', groupId: 'A' })
  const hits = api.search('ALPHA_ONLY', { channel: 'qq-group', groupId: 'A' })
  assert.equal(hits.length, 1)
  assert.ok(String(hits[0].summary || hits[0].content || '').includes('ALPHA_ONLY'))
})

test('另一个群查不到 A 群的内容', () => {
  assert.deepEqual(api.search('ALPHA_ONLY', { channel: 'qq-group', groupId: 'B' }), [])
})

test('统计条目数，并声明能力给 self', () => {
  assert.equal(api.stats().items, 1)
  const manifest = declared.find((item) => item.id === 'knowledge')
  assert.ok(manifest, '应该向 self 声明能力')
  assert.equal(manifest.package, 'dsh-group-knowledge')
  assert.ok(Array.isArray(manifest.limits))
  assert.equal(typeof manifest.state, 'function')
})

test('清理', () => {
  try {
    api.close()
  } catch {
    // 已经关了
  }
  fs.rmSync(temp, { recursive: true, force: true })
})
