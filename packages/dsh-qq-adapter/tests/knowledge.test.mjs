import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-knowledge-test-'))
process.env.DSH_HOME = tmp
const { KnowledgeStore, extractUrls } = await import(`../lib/knowledge.js?test=${Date.now()}`)

test('knowledge add, dedupe and FTS search', () => {
  const store = new KnowledgeStore()
  const first = store.add({ kind: 'note', title: '巨兽蔓生构筑', summary: '巨兽加蔓生，平时带种子跑', tags: '游戏 构筑' })
  const same = store.add({ kind: 'note', title: '巨兽蔓生构筑', summary: '巨兽加蔓生，平时带种子跑', tags: '游戏 构筑' })
  assert.equal(first.inserted, true)
  assert.equal(same.inserted, false)
  const hits = store.search('蔓生 构筑')
  assert.ok(hits.length >= 1)
  assert.match(hits[0].text, /巨兽/)
  assert.equal(store.stats().items, 1)
  store.close()
})

test('extractUrls dedupes and trims punctuation', () => {
  const urls = extractUrls('看这个 https://example.com/a，还有 https://example.com/b。https://example.com/a')
  assert.deepEqual(urls, ['https://example.com/a', 'https://example.com/b'])
})

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})
