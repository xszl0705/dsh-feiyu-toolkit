import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectTimeline, isValidDate } from '../lib/timeline.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-'))
const day = '2026-10-31'
const [year, month] = day.split('-')

function seed() {
  fs.mkdirSync(path.join(temp, 'daily', `${year}-${month}`), { recursive: true })
  fs.mkdirSync(path.join(temp, 'work', `${year}-${month}`), { recursive: true })
  fs.mkdirSync(path.join(temp, 'chats'), { recursive: true })
  fs.mkdirSync(path.join(temp, 'decisions'), { recursive: true })

  fs.writeFileSync(
    path.join(temp, 'daily', `${year}-${month}`, `${day}.md`),
    `# 桌宠日常日记\n\n## 15:30 · 今天整理了插件\n\n一大堆细节\n\n## 09:10 · 早上好\n\n起来了\n`,
    'utf8',
  )
  fs.writeFileSync(
    path.join(temp, 'work', `${year}-${month}`, `${day}.md`),
    `# 工作日志\n\n## 18:20 · 修复桌宠单实例\n\n给探测加了两道判断\n`,
    'utf8',
  )
  fs.writeFileSync(
    path.join(temp, 'chats', `${day}.jsonl`),
    [
      JSON.stringify({ at: `${day}T08:00:00.000Z`, channel: 'qq', moment: 'private', text: '早上好呀' }),
      '{坏行',
      JSON.stringify({ at: `${day}T16:42:00.000Z`, channel: 'qq', moment: 'group', text: '装那几个插件' }),
    ].join('\n') + '\n',
    'utf8',
  )
  fs.writeFileSync(
    path.join(temp, 'decisions', `${day}.jsonl`),
    [
      JSON.stringify({ at: `${day}T10:14:00.000Z`, kind: 'memory', choice: 'inserted', reason: 'folder:规则' }),
      JSON.stringify({ at: `${day}T12:00:00.000Z`, kind: 'reply', choice: 'sent' }),
    ].join('\n') + '\n',
    'utf8',
  )
}

test('日期格式校验', () => {
  assert.equal(isValidDate('2026-10-31'), true)
  assert.equal(isValidDate('2026-1-1'), false)
  assert.equal(isValidDate(''), false)
})

test('四份时间流合并成一条，按时间升序', () => {
  seed()
  const result = collectTimeline({ date: day, root: temp, decisionsDir: path.join(temp, 'decisions') })
  assert.equal(result.date, day)
  assert.equal(result.count, 7) // 2 日记 + 1 工作 + 2 聊天 + 2 决策（坏行被跳过）
  const times = result.entries.map((entry) => entry.at)
  assert.deepEqual(times, [...times].sort())
  const kinds = new Set(result.entries.map((entry) => entry.kind))
  assert.ok(kinds.has('daily'))
  assert.ok(kinds.has('work'))
  assert.ok(kinds.has('chat'))
  assert.ok(kinds.has('decision'))
})

test('kinds 过滤只留指定的几类', () => {
  const result = collectTimeline({ date: day, root: temp, decisionsDir: path.join(temp, 'decisions'), kinds: ['decision'] })
  assert.ok(result.entries.length >= 1)
  assert.ok(result.entries.every((entry) => entry.kind === 'decision'))
})

test('坏行被跳过，不影响其它条目', () => {
  const result = collectTimeline({ date: day, root: temp, decisionsDir: path.join(temp, 'decisions'), kinds: ['chat'] })
  assert.equal(result.entries.length, 2)
})

test('limit 只截最近的几条', () => {
  const all = collectTimeline({ date: day, root: temp, decisionsDir: path.join(temp, 'decisions') })
  const limited = collectTimeline({ date: day, root: temp, decisionsDir: path.join(temp, 'decisions'), limit: 2 })
  assert.equal(limited.entries.length, 2)
  assert.deepEqual(limited.entries.map((e) => e.at), all.entries.slice(-2).map((e) => e.at))
})

test('没有数据的日子返回空，不报错', () => {
  const result = collectTimeline({ date: '2020-01-01', root: temp, decisionsDir: path.join(temp, 'decisions') })
  assert.equal(result.count, 0)
  assert.deepEqual(result.entries, [])
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
