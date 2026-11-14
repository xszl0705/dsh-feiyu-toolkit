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

import { createTools, detectBurst, judge } from '../lib/tools.js'
import { readSession, resolveSessionFile, shapeOfSession, summarizeFile } from '../lib/usage.js'

const THRESHOLDS = {
  stepsWarn: 200,
  stepsHard: 250,
  tokensWarn: 200000000,
  perStepWarn: 400000,
  cacheRateWarn: 0.7,
  contextWarn: 250000,
  contextHard: 400000,
  burstInput: 100000,
  burstCacheRate: 0.8,
  burstCount: 2,
}

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
    context: 100000,
    lastInput: 10000,
    lastCacheRate: 0.9,
    recent: [{ input: 10000, cache: 90000 }],
    cacheRate: 0.9,
    ...over,
  }
}

test('judge：健康会话不报警', () => {
  const v = judge(makeStat(), THRESHOLDS)
  assert.equal(v.level, 'ok')
  assert.deepEqual(v.alerts, [])
})

test('judge：步数过软线 → prepare（先准备账本，不是催交接）', () => {
  const v = judge(makeStat({ steps: 210 }), THRESHOLDS)
  assert.equal(v.level, 'prepare')
  assert.match(v.alerts.join(), /步数 210 ≥ 200/)
})

test('judge：步数过硬线 → hard（优先于软线）', () => {
  const v = judge(makeStat({ steps: 300 }), THRESHOLDS)
  assert.equal(v.level, 'hard')
  assert.match(v.alerts.join(), /300 ≥ 250/)
})

test('judge：上下文过 250k → prepare（步数不到 200 也报）', () => {
  const v = judge(makeStat({ steps: 120, context: 260000 }), THRESHOLDS)
  assert.equal(v.level, 'prepare')
  assert.match(v.alerts.join(), /上下文 260,000 ≥ 250,000/)
})

test('judge：上下文过 400k → hard（即使才 221 步）', () => {
  const v = judge(makeStat({ steps: 221, context: 485874 }), THRESHOLDS)
  assert.equal(v.level, 'hard')
  assert.match(v.alerts.join(), /485,874 ≥ 400,000/)
})

test('judge：步数硬线优先于上下文硬线（只报一条主因）', () => {
  const v = judge(makeStat({ steps: 300, context: 500000 }), THRESHOLDS)
  assert.equal(v.level, 'hard')
  assert.match(v.alerts.join(), /步数 300/)
  assert.doesNotMatch(v.alerts.join(), /上下文/)
})

test('judge：连续 2 步非缓存输入 ≥100k 且缓存 <80% → prepare', () => {
  const recent = [
    { input: 120000, cache: 200000 },
    { input: 130000, cache: 180000 },
  ]
  const v = judge(makeStat({ steps: 60, context: 130000, recent }), THRESHOLDS)
  assert.equal(v.level, 'prepare')
  assert.match(v.alerts.join(), /连续 2 步非缓存输入/)
})

test('judge：只有一步突发不算（要求连续 burstCount 步）', () => {
  const recent = [
    { input: 10000, cache: 90000 },
    { input: 130000, cache: 180000 },
  ]
  const v = judge(makeStat({ steps: 60, context: 130000, recent }), THRESHOLDS)
  assert.equal(v.level, 'ok')
})

test('judge：缓存恢复后不算突发', () => {
  const recent = [
    { input: 130000, cache: 180000 },
    { input: 130000, cache: 900000 },
  ]
  assert.equal(detectBurst(recent, THRESHOLDS), false)
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
  const few = judge(makeStat({ cacheRate: 0.5, steps: 20 }), THRESHOLDS)
  assert.equal(few.level, 'ok')
})

test('readSession：多帧 zstd 能拼回来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
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
    JSON.stringify({ type: 'assistant/message', data: {} }),
  ].join('\n') + '\n'
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(lines, 'utf8')))
  const s = summarizeFile(file)
  assert.equal(s.steps, 2)
  assert.equal(s.input, 300)
  assert.equal(s.cache, 1700)
  assert.equal(s.output, 30)
  assert.equal(s.total, 2030)
  assert.equal(s.perStep, 1000)
  assert.equal(s.maxStep, 1000)
  assert.equal(s.context, 1000)
  assert.equal(s.lastInput, 200)
  assert.equal(s.recent.length, 2)
  assert.ok(Math.abs(s.cacheRate - 1700 / 2000) < 1e-9)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('summarizeFile：recent 只留最近 8 步', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-'))
  const ws = path.join(dir, 'ws', 'sess')
  fs.mkdirSync(ws, { recursive: true })
  const file = path.join(ws, 'session.v4.jsonl.zstd')
  const lines = Array.from({ length: 12 }, (_, i) =>
    JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: i + 1, cacheReadTokens: 0, outputTokens: 1 } } }),
  ).join('\n')
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(lines, 'utf8')))
  const s = summarizeFile(file)
  assert.equal(s.steps, 12)
  assert.equal(s.recent.length, 8)
  assert.equal(s.recent.at(-1).input, 12)
  assert.equal(s.lastInput, 12)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('summarizeFile：没有 assistant 帧返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-'))
  const file = path.join(dir, 'x.jsonl')
  fs.writeFileSync(file, '{"type":"user/message"}\n', 'utf8')
  assert.equal(summarizeFile(file), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('resolveSessionFile：按 id 找到会话文件', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-home-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const sess = path.join(home, 'sessions', 'ws1', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    fs.mkdirSync(sess, { recursive: true })
    const file = path.join(sess, 'session.v4.jsonl.zstd')
    fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from('{"type":"x"}\n', 'utf8')))
    assert.equal(resolveSessionFile('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), file)
    assert.equal(resolveSessionFile('session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), file)
    assert.equal(resolveSessionFile('ffffffff-0000-0000-0000-000000000000'), null)
    assert.equal(resolveSessionFile(''), null)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('createTools status：按会话 id 定位，不看 mtime', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-home-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const mk = (dirName, steps, lastInput, lastCache) => {
      const sess = path.join(home, 'sessions', 'ws1', dirName)
      fs.mkdirSync(sess, { recursive: true })
      const lines = []
      for (let i = 0; i < steps; i++) {
        const last = i === steps - 1
        lines.push(
          JSON.stringify({
            type: 'assistant/message',
            data: { usage: { inputTokens: last ? lastInput : 1000, cacheReadTokens: last ? lastCache : 9000, outputTokens: 10 } },
          }),
        )
      }
      fs.writeFileSync(path.join(sess, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8')))
      fs.utimesSync(path.join(sess, 'session.v4.jsonl.zstd'), new Date(Date.now() - 60000), new Date(Date.now() - 60000))
      return sess
    }
    const mainId = '11111111-2222-3333-4444-555555555555'
    mk('session-' + mainId, 3, 120000, 300000)
    mk('99999999-8888-7777-6666-555555555555', 1, 500, 500)

    const tools = createTools({}, { getSessionId: () => mainId })
    const out = await tools[0].execute({ action: 'status' })
    assert.equal(out.via, 'session-id')
    assert.equal(out.session, 'session-' + mainId)
    assert.equal(out.steps, 3)
    assert.equal(out.context, 420000)
    assert.equal(out.level, 'hard')

    const fallback = createTools({}, {})
    const guess = await fallback[0].execute({ action: 'status' })
    assert.equal(guess.via, 'mtime')
    assert.equal(guess.steps, 1)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('shapeOfSession：轮首缓存冻结时能反查到具体块', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-shape-'))
  const ws = path.join(dir, 'ws', 'sess')
  fs.mkdirSync(ws, { recursive: true })
  const file = path.join(ws, 'session.v4.jsonl.zstd')
  const lines = []
  // 10 轮：每轮先一条 runtime-context（1000 字符），再一条 assistant。
  // 缓存从第 3 轮起卡在 5000，上下文继续涨 → 末 8 轮缓存全等，应判定冻结。
  for (let turn = 1; turn <= 10; turn++) {
    lines.push(
      JSON.stringify({
        type: 'user/message',
        seq: lines.length + 1,
        data: { turn, content: 'x'.repeat(1000), source: { kind: 'runtime-context' } },
      }),
    )
    const cache = turn < 3 ? 1000 * turn : 5000
    lines.push(
      JSON.stringify({
        type: 'assistant/message',
        seq: lines.length + 1,
        data: { turn, step: 1, message: 'y'.repeat(200), usage: { inputTokens: turn * 900, cacheReadTokens: cache, outputTokens: 10 } },
      }),
    )
  }
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8')))
  const s = shapeOfSession(file)
  assert.equal(s.turns.length, 10)
  assert.equal(s.frozen, true)
  assert.ok(s.breakAt, '应定位到断点块')
  assert.equal(s.breakAt.kind, 'user/runtime-context')
  assert.ok(s.blocks.length > 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('shapeOfSession：未冻结时 breakAt 为 null（工具输出不能挂 null 对象）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-shape2-'))
  const ws = path.join(dir, 'ws', 'sess')
  fs.mkdirSync(ws, { recursive: true })
  const file = path.join(ws, 'session.v4.jsonl.zstd')
  const lines = []
  // 10 轮，缓存跟随上下文增长 → 不应判定冻结
  for (let turn = 1; turn <= 10; turn++) {
    lines.push(
      JSON.stringify({ type: 'user/message', seq: lines.length + 1, data: { turn, content: 'x'.repeat(500), source: { kind: 'runtime-context' } } }),
    )
    const ctx = turn * 5000
    lines.push(
      JSON.stringify({
        type: 'assistant/message',
        seq: lines.length + 1,
        data: { turn, step: 1, message: 'y'.repeat(100), usage: { inputTokens: 500, cacheReadTokens: ctx - 500, outputTokens: 10 } },
      }),
    )
  }
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8')))
  const s = shapeOfSession(file)
  assert.equal(s.frozen, false)
  assert.equal(s.breakAt, null)
  fs.rmSync(dir, { recursive: true, force: true })
})
