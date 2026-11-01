/**
 * 例行日记自测：node tests/routine.mjs
 * 不连宿主，全部用临时目录 + 假 LLM。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoutineRunner, buildPrompt, cleanEntry, dayKey, timeReached, excerptsOf } from '../lib/routine.js'

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diary-routine-'))
}

class Book {
  constructor() {
    this.text = ''
    this.writes = []
  }
  read() {
    return this.text
  }
  write(text, options) {
    this.writes.push({ text, ...options })
    this.text = (this.text ? this.text + '\n' : '') + text
    return { entriesToday: this.writes.length }
  }
}

function makeChats(rows) {
  return { read: () => rows }
}

function okLlm(text = '今天把日记流程独立出来了，不用再有人提醒我。') {
  return {
    stream: async function* () {
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

function at(hour, minute) {
  return new Date(2026, 9, 29, hour, minute, 0)
}

// ---- 纯函数 ----
assert.equal(cleanEntry('日常日记： “今天很好。”'), '今天很好。')
assert.ok(cleanEntry('x'.repeat(600), 100).length <= 101)
assert.equal(timeReached(at(21, 59), '22:00'), false)
assert.equal(timeReached(at(22, 0), '22:00'), true)
assert.equal(timeReached(at(23, 30), '22:00'), true)
assert.ok(excerptsOf([{ clock: '10:00', channel: 'pet', text: '你好' }]).includes('10:00'))
assert.equal(dayKey(at(22, 0)), '2026-10-29')
{
  const prompt = buildPrompt({ kind: 'daily', date: '2026-10-29', excerpts: '10:00 pet: 你好' })
  assert.ok(prompt.includes('第一人称') && prompt.includes('「我」'), '提示词要明确第一人称')
  assert.ok(prompt.includes('本人'), '提示词要说明是本人写的，不是旁观助手')
  assert.ok(!prompt.includes('请根据'), '不要回到旁观总结的口吻')
}
console.log('✓ 纯函数')

// ---- 到点才写 ----
{
  const root = makeRoot()
  const daily = new Book()
  const work = new Book()
  const rows = [{ clock: '09:12', channel: 'pet', text: '今天调通了例行流程' }]
  const runner = new RoutineRunner({
    root,
    routines: [{ id: 'daily', enabled: true, time: '22:00', kind: 'daily' }],
    daily,
    work,
    chats: makeChats(rows),
    getLlm: () => okLlm(),
    config: { retryMinutes: 20 },
    log: () => {},
  })
  assert.deepEqual(await runner.tick(at(21, 0)), [])
  const actions = await runner.tick(at(22, 1))
  assert.equal(actions[0].action, 'write')
  assert.equal(daily.writes.length, 1)
  assert.equal(daily.writes[0].tags[0], '例行')
  // 同一天不再写
  assert.deepEqual(await runner.tick(at(22, 30)), [])
  assert.equal(daily.writes.length, 1)
  console.log('✓ 到点写一次，同日不重复')
}

// ---- 已有日记 / 没对话：跳过 ----
{
  const root = makeRoot()
  const daily = new Book()
  daily.text = '# 2026-10-29\n\n已经写过了'
  const runner = new RoutineRunner({
    root,
    routines: [{ id: 'daily', enabled: true, time: '22:00', kind: 'daily' }],
    daily,
    work: new Book(),
    chats: makeChats([{ clock: '09:00', channel: 'pet', text: 'x' }]),
    getLlm: () => okLlm(),
    config: {},
    log: () => {},
  })
  const actions = await runner.tick(at(22, 5))
  assert.equal(actions[0].action, 'skip')
  assert.equal(actions[0].reason, 'already-has-entry')

  const root2 = makeRoot()
  const runner2 = new RoutineRunner({
    root: root2,
    routines: [{ id: 'daily', enabled: true, time: '22:00', kind: 'daily' }],
    daily: new Book(),
    work: new Book(),
    chats: makeChats([]),
    getLlm: () => okLlm(),
    config: {},
    log: () => {},
  })
  const skip = await runner2.tick(at(22, 5))
  assert.equal(skip[0].reason, 'no-chat')
  console.log('✓ 已有内容 / 没对话时跳过')
}

// ---- 失败重试 + 状态跨进程保留 ----
{
  const root = makeRoot()
  const daily = new Book()
  const rows = [{ clock: '09:00', channel: 'pet', text: 'x' }]
  const failing = {
    stream: () => {
      throw new Error('boom')
    },
  }
  const runner = new RoutineRunner({
    root,
    routines: [{ id: 'daily', enabled: true, time: '22:00', kind: 'daily' }],
    daily,
    work: new Book(),
    chats: makeChats(rows),
    getLlm: () => failing,
    config: { retryMinutes: 20, maxAttempts: 3 },
    log: () => {},
  })
  const first = await runner.tick(at(22, 1))
  assert.equal(first[0].action, 'fail')
  assert.equal(daily.writes.length, 0)

  // 20 分钟内不重试
  assert.deepEqual(await runner.tick(at(22, 10)), [])
  // 过了重试间隔再试一次
  const second = await runner.tick(at(22, 25))
  assert.equal(second[0].action, 'fail')

  // 换一个进度：同一天新进程也不会重写（状态落盘）
  const runner2 = new RoutineRunner({
    root,
    routines: [{ id: 'daily', enabled: true, time: '22:00', kind: 'daily' }],
    daily,
    work: new Book(),
    chats: makeChats(rows),
    getLlm: () => okLlm(),
    config: { retryMinutes: 20, maxAttempts: 3 },
    log: () => {},
  })
  const third = await runner2.tick(at(22, 46))
  assert.equal(third[0].action, 'write', '重试预算内应允许成功')
  console.log('✓ 失败重试与状态持久化')
}

// ---- 工作 routine 独立 ----
{
  const root = makeRoot()
  const daily = new Book()
  const work = new Book()
  const runner = new RoutineRunner({
    root,
    routines: [
      { id: 'daily', enabled: true, time: '22:00', kind: 'daily' },
      { id: 'work', enabled: true, time: '18:30', kind: 'work' },
    ],
    daily,
    work,
    chats: makeChats([{ clock: '09:00', channel: 'pet', text: '修了队列' }]),
    getLlm: () => okLlm('修好了朗读队列积压，顺手加了日志。'),
    config: {},
    log: () => {},
  })
  await runner.tick(at(19, 0))
  assert.equal(work.writes.length, 1, '工作 routine 到点写')
  assert.equal(daily.writes.length, 0, '日常 routine 还没到点')
  console.log('✓ 多个 routine 互不影响')
}

console.log('\n全部通过')
