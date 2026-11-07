/**
 * 正文保真测试（阶段 4.0，先红后绿）。
 *
 * 现状（2026-11-04 复现）：cleanLong / cleanReply 删除代码块、压平表格换行；
 * stripMeta 会把合法引文删成「嗯。」。这里断言「清洗后正文保真」——
 * 当前应全部失败，4.1 改完后转绿。
 *
 * 注意：4.1 完成前**不要**登记进 verify.mjs（回归会红是预期，不是回归坏了）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanLong, stripMeta } from '../lib/reply.js'
import { cleanReply } from '../lib/prompt.js'

const CODE = '前面一句。\n\n```python\nprint("hi")\n```\n\n结束。'
const TABLE = '数据如下：\n| 名称 | 数值 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |\n\n结论可用。'
const QUOTE = '原文里“手滑”是作者自述，不能删。'
const PATH = '结果在 D:\\out\\report.md，请查收。'
const URL = '链接 https://example.com/x?a=1&b=2 。'
const JSON_TEXT = '配置：\n```json\n{"a": 1, "b": [2, 3]}\n```'

test('cleanLong 保留代码块原文', () => {
  const out = cleanLong(CODE)
  assert.ok(out.includes('print("hi")'), `代码被删：${out}`)
})

test('cleanLong 保留表格换行结构', () => {
  const out = cleanLong(TABLE)
  assert.ok(out.includes('\n|'), `表格换行被压平：${out}`)
})

test('cleanReply 保留代码块原文', () => {
  const out = cleanReply(CODE)
  assert.ok(out.includes('print("hi")'), `代码被删：${out}`)
})

test('stripMeta 不删合法引文', () => {
  const out = stripMeta(QUOTE)
  assert.ok(out.includes('手滑'), `引文被删：${out}`)
})

test('cleanLong 保留 Windows 路径', () => {
  const out = cleanLong(PATH)
  assert.ok(out.includes('D:\\out\\report.md'), `路径被改：${out}`)
})

test('cleanLong 保留 URL', () => {
  const out = cleanLong(URL)
  assert.ok(out.includes('https://example.com/x?a=1&b=2'), `URL 被改：${out}`)
})

test('cleanReply 保留 JSON 原文', () => {
  const out = cleanReply(JSON_TEXT, 500)
  assert.ok(out.includes('{"a": 1, "b": [2, 3]}'), `JSON 被改：${out}`)
})
