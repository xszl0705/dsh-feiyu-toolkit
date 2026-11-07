/**
 * qq(action=send) 发送层：文字/图片/语音/文件的组合发送、失败不抛错、临时 wav 收尾。
 * 2026-11-04 从 index.js 抽出 lib/send-action.js 时补的回归。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSendAction, resolveExisting } from '../lib/send-action.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'send-action-'))
const config = { httpUrl: 'http://127.0.0.1:3000', accessToken: 'token', maxReplyChars: 120 }
const noop = () => {}

function makeFile(name, content = 'x') {
  const file = path.join(temp, name)
  fs.writeFileSync(file, content)
  return file
}

test('一个参数都不给 → 明确报错', async () => {
  const r = await runSendAction({ args: {}, config })
  assert.equal(r.ok, false)
  assert.match(r.detail, /至少给一个/)
})

test('纯文字 + 执行层可用 → 走 exec，不拼消息段', async () => {
  let segCalls = 0
  const r = await runSendAction({
    args: { kind: 'private', targetId: '10001', text: '你好' },
    config,
    runtime: { exec: { send: async () => ({ ok: true, retcode: 0 }) } },
    deps: { sendSegments: async () => { segCalls += 1; return { ok: true, retcode: 0 } } },
  })
  assert.equal(r.ok, true)
  assert.match(r.detail, /已发送 retcode=0/)
  assert.equal(segCalls, 0, '执行层成功时不该再发消息段')
})

test('执行层结果未知 → 不重发，提示待对账', async () => {
  const r = await runSendAction({
    args: { kind: 'group', targetId: '42', text: 'hi' },
    config,
    runtime: { exec: { send: async () => ({ ok: false, unknown: true }) } },
  })
  assert.equal(r.ok, false)
  assert.match(r.detail, /结果未知/)
})

test('没有执行层时纯文字也走消息段', async () => {
  let captured
  const r = await runSendAction({
    args: { kind: 'group', targetId: '42', text: 'hi' },
    config,
    runtime: {},
    deps: { sendSegments: async (payload) => { captured = payload; return { ok: true, retcode: 0 } } },
  })
  assert.equal(r.ok, true)
  assert.equal(captured.targetId, '42')
  assert.equal(captured.kind, 'group')
  assert.deepEqual(captured.segments, [{ type: 'text', data: { text: 'hi' } }])
})

test('say → TTS 后按 record 段发送，临时 wav 收尾删掉', async () => {
  let captured
  let sentFile = ''
  const r = await runSendAction({
    args: { kind: 'private', targetId: '10001', say: '晚安' },
    config,
    runtime: {},
    note: noop,
    deps: {
      tts: async (_text, outPath) => {
        fs.writeFileSync(outPath, 'wav-bytes')
        return { size: 2048, via: 'ssvo', engine: 'gsv' }
      },
      sendSegments: async (payload) => {
        captured = payload
        sentFile = payload.segments[0].data.file
        return { ok: true, retcode: 0 }
      },
    },
  })
  assert.equal(r.ok, true)
  assert.match(r.detail, /TTS 2KB ssvo\/gsv/)
  assert.equal(captured.segments[0].type, 'record')
  assert.match(sentFile, /^file:\/\//)
  assert.equal(fs.existsSync(sentFile.replace(/^file:\/\//, '')), false, '临时 wav 应已删除')
})

test('voice 与 say 同时给 → 用 voice，不调 TTS', async () => {
  const voice = makeFile('voice.wav', 'voice-bytes')
  let ttsCalls = 0
  const r = await runSendAction({
    args: { kind: 'private', targetId: '10001', voice, say: '这句不该合成' },
    config,
    runtime: {},
    note: noop,
    deps: {
      tts: async () => { ttsCalls += 1; return { size: 1, via: 'sapi' } },
      sendSegments: async () => ({ ok: true, retcode: 0 }),
    },
  })
  assert.equal(ttsCalls, 0)
  assert.match(r.detail, /已用 voice/)
})

test('图片路径不存在 → 失败但不抛错', async () => {
  let called = false
  const r = await runSendAction({
    args: { kind: 'private', targetId: '10001', image: path.join(temp, 'nope.png') },
    config,
    runtime: {},
    deps: { sendSegments: async () => { called = true; return { ok: true, retcode: 0 } } },
  })
  assert.equal(r.ok, false)
  assert.match(r.detail, /图片不存在/)
  assert.equal(called, false)
})

test('文件上传失败 → ok:false 且 detail 写清', async () => {
  const file = makeFile('report.txt', 'content')
  const r = await runSendAction({
    args: { kind: 'group', targetId: '42', file },
    config,
    runtime: {},
    deps: { uploadFile: async () => ({ ok: false, retcode: 1200 }) },
  })
  assert.equal(r.ok, false)
  assert.match(r.detail, /文件 fail retcode=1200/)
})

test('只有文件也允许：上传成功即 ok', async () => {
  const file = makeFile('ok.txt', 'content')
  const r = await runSendAction({
    args: { kind: 'group', targetId: '42', file },
    config,
    runtime: {},
    deps: { uploadFile: async () => ({ ok: true, retcode: 0 }) },
  })
  assert.equal(r.ok, true)
  assert.match(r.detail, /文件 ok/)
})

test('resolveExisting 卡大小上限', () => {
  const big = makeFile('big.bin', Buffer.alloc(2 * 1024 * 1024))
  assert.throws(() => resolveExisting(big, '文件', 1), /超过 1MB 上限/)
  assert.equal(resolveExisting(big, '文件'), big)
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
