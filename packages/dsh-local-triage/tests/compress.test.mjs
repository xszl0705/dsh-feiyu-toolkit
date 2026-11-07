import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarness } from './_harness.mjs'
import {
  capText,
  projectFields,
  paginate,
  trimError,
  extractHunks,
  dedupeBlocks,
  spillToFile,
  compressToolResult,
} from '../lib/compress.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(HERE, '..', 'reports', '_spill')

const h = createHarness('compress.test')

h.check('capText 截断并留标记', () => {
  const r = capText('x'.repeat(100), 40)
  assert.equal(r.truncated, true)
  assert.equal(r.dropped, 60)
  assert.match(r.text, /已截断 60 字/)
})

h.check('capText 未超限时原样返回', () => {
  const r = capText('hello', 100)
  assert.equal(r.truncated, false)
  assert.equal(r.text, 'hello')
})

h.check('projectFields 只留白名单', () => {
  const out = projectFields({ id: 1, name: 'a', secret: 'x' }, ['id', 'name'])
  assert.deepEqual(out, { id: 1, name: 'a' })
})

h.check('projectFields 支持数组', () => {
  const out = projectFields([{ id: 1, extra: 2 }, { id: 3, extra: 4 }], ['id'])
  assert.deepEqual(out, [{ id: 1 }, { id: 3 }])
})

h.check('paginate 给出翻页信息', () => {
  const items = Array.from({ length: 50 }, (_, i) => i)
  const r = paginate(items, { pageSize: 10 })
  assert.equal(r.page.length, 10)
  assert.equal(r.total, 50)
  assert.equal(r.nextOffset, 10)
  assert.match(r.hint, /共 50 条/)
})

h.check('paginate 末页 nextOffset 为 null', () => {
  const r = paginate([1, 2, 3], { pageSize: 10 })
  assert.equal(r.nextOffset, null)
})

h.check('trimError 去掉无关堆栈行', () => {
  const raw = [
    'TypeError: Cannot read property x',
    '    at foo (/a.js:10:5)',
    '    at bar (/b.js:20:3)',
    'noise 1', 'noise 2', 'noise 3', 'noise 4', 'noise 5',
  ].join('\n')
  const r = trimError(raw, { maxLines: 4 })
  assert.equal(r.trimmed, true)
  assert.match(r.text, /TypeError/)
  assert.match(r.text, /已省略/)
})

h.check('extractHunks 只保留改动附近', () => {
  const lines = []
  for (let i = 0; i < 40; i += 1) lines.push(`line ${i}`)
  lines[20] = '+新增的一行'
  const r = extractHunks(lines.join('\n'), { context: 2 })
  assert.equal(r.changed, true)
  assert.match(r.text, /新增的一行/)
  assert.ok(!r.text.includes('line 0\n'), '远处的行不应出现')
})

h.check('extractHunks 无改动时原样返回', () => {
  const r = extractHunks('a\nb\nc')
  assert.equal(r.changed, false)
})

h.check('dedupeBlocks 去重', () => {
  const r = dedupeBlocks(['a', 'b', 'a', 'c', 'b'])
  assert.deepEqual(r.blocks, ['a', 'b', 'c'])
  assert.equal(r.dropped, 2)
})

h.check('spillToFile 落盘并回路径', () => {
  const r = spillToFile('x'.repeat(200), { dir: TMP, id: 'unit-test', ext: 'txt', minBytes: 10 })
  assert.equal(r.spilled, true)
  assert.ok(fs.existsSync(r.path))
  assert.match(r.text, /结果已落盘/)
  fs.unlinkSync(r.path)
})

h.check('spillToFile 体积不足时原样返回', () => {
  const r = spillToFile('small', { dir: TMP, minBytes: 100 })
  assert.equal(r.spilled, false)
  assert.equal(r.text, 'small')
})

h.check('compressToolResult 大结果走落盘', () => {
  const r = compressToolResult({ rows: Array(500).fill('x'.repeat(40)) }, { spillDir: TMP, id: 'big', spillBytes: 1000 })
  assert.equal(r.level, 'spill')
  assert.ok(r.path)
  if (r.path && fs.existsSync(r.path)) fs.unlinkSync(r.path)
})

h.check('compressToolResult 小结果不折腾', () => {
  const r = compressToolResult({ ok: true }, { spillDir: TMP, spillBytes: 1000 })
  assert.equal(r.level, 'none')
})

h.finish()
