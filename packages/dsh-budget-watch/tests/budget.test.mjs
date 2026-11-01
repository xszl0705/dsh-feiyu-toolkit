/**
 * budget-watch 的纯逻辑测试：不碰真实会话日志，用构造数据验算。
 * 跑法：node --test tests/budget.test.mjs（沙箱里 test runner 会 spawn EPERM，用直跑脚本代替）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { judge } from '../lib/tools.js'
import { readSession, summarizeFile } from '../lib/usage.js'

const THRESHOLDS = { stepsWarn: 500, stepsHard: 800, tokensWarn: 200000000, perStepWarn: 400000, cacheRateWarn: 0.7 }

function makeStat(over = {}) {
  return {
    session: 'test-session',
    steps: 100,
    input: 1000000,
    cache: 9000000,
    output: 50000,
    total: 10050000,
    perStep: 100000,
    maxStep: 200000,
    cacheRate: 0.9,
    ...over,
  }
}

test('judge：健康会话不报警', () => {
  const v = judge(makeStat(), THRESHOLDS)
  assert.equal(v.level, 'ok')
  assert.deepEqual(v.alerts, [])
})

test('judge：步数过软线 → warn', () => {
  const v = judge(makeStat({ steps: 550 }), THRESHOLDS)
  assert.equal(v.level, 'warn')
  assert.match(v.alerts.join(), /步数 550 ≥ 500/)
})

test('judge：步数过硬线 → hard（优先于软线）', () => {
  const v = judge(makeStat({ steps: 900 }), THRESHOLDS)
  assert.equal(v.level, 'hard')
  assert.match(v.alerts.join(), /900 ≥ 800/)
})

test('judge：累计超 2 亿 → warn', () => {
  const v = judge(makeStat({ total: 210000000 }), THRESHOLDS)
  assert.equal(v.level, 'warn')
  assert.match(v.alerts.join(), /2\.10 亿/)
})

test('judge：每步超线 → warn', () => {
  const v = judge(makeStat({ perStep: 420000 }), THRESHOLDS)
  assert.equal(v.level, 'warn')
  assert.match(v.alerts.join(), /每步/)
})

test('judge：缓存命中低于 70% 且步数够多才报', () => {
  const low = judge(makeStat({ cacheRate: 0.5, steps: 100 }), THRESHOLDS)
  assert.equal(low.level, 'warn')
  assert.match(low.alerts.join(), /缓存命中/)
  // 步数少的时候不报（样本不足）
  const few = judge(makeStat({ cacheRate: 0.5, steps: 20 }), THRESHOLDS)
  assert.equal(few.level, 'ok')
})

test('readSession：多帧 zstd 能拼回来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  // 自己压两帧拼起来，模拟真实格式
  const f1 = zlib.zstdCompressSync(Buffer.from('{"type":"a"}\n', 'utf8'))
  const f2 = zlib.zstdCompressSync(Buffer.from('{"type":"b"}\n', 'utf8'))
  fs.writeFileSync(file, Buffer.concat([f1, f2]))
  const text = readSession(file)
  assert.match(text, /"type":"a"/)
  assert.match(text, /"type":"b"/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('summarizeFile：正确累加 usage，跳过无 usage 帧', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-'))
  const ws = path.join(dir, 'ws', 'sess')
  fs.mkdirSync(ws, { recursive: true })
  const file = path.join(ws, 'session.v4.jsonl.zstd')
  const lines = [
    JSON.stringify({ type: 'user/message', data: {} }),
    JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 } } }),
    JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: 200, cacheReadTokens: 800, outputTokens: 20 } } }),
    JSON.stringify({ type: 'assistant/message', data: {} }), // 缺 usage，跳过
  ].join('\n') + '\n'
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(lines, 'utf8')))
  const s = summarizeFile(file)
  assert.equal(s.steps, 2)
  assert.equal(s.input, 300)
  assert.equal(s.cache, 1700)
  assert.equal(s.output, 30)
  assert.equal(s.total, 2030)
  assert.equal(s.perStep, 1000)
  assert.equal(s.maxStep, 1000) // 第二帧 200+800
  assert.ok(Math.abs(s.cacheRate - 1700 / 2000) < 1e-9)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('summarizeFile：没有 assistant 帧返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-'))
  const file = path.join(dir, 'x.jsonl')
  fs.writeFileSync(file, '{"type":"user/message"}\n', 'utf8')
  assert.equal(summarizeFile(file), null)
  fs.rmSync(dir, { recursive: true, force: true })
})
