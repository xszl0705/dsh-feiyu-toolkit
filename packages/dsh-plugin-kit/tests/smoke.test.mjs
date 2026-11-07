/**
 * dsh-plugin-kit 冒烟：四件公共实现各自的最小行为保证。
 * kit 坏了全仓插件都会跟着坏，所以它自己必须有回归。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWrite, atomicWriteJson, lifecycle, note, toolsOrRetry } from '../index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('lifecycle：同一个 ctx 拿到同一个实例', () => {
  const ctx = { effect: () => {} }
  const a = lifecycle(ctx, () => ({ n: 1 }))
  const b = lifecycle(ctx, () => ({ n: 2 }))
  assert.equal(a, b, '同一 ctx 必须复用实例')
  assert.equal(a.n, 1)
  a.dispose()
  const c = lifecycle(ctx, () => ({ n: 3 }))
  assert.equal(c.n, 3, 'dispose 后应能重新创建')
  c.dispose()
})

test('lifecycle：dispose 后 later 不再执行，own 的回调会被调用', async () => {
  const ctx = { effect: () => {} }
  const st = lifecycle(ctx)
  let laterRan = false
  let cleaned = false
  st.later(() => { laterRan = true }, 20)
  st.own(() => { cleaned = true })
  st.dispose()
  await sleep(40)
  assert.equal(laterRan, false, 'dispose 应清掉定时器')
  assert.equal(cleaned, true, 'own 登记的回调必须执行')
})

test('atomicWrite：写完可读，失败不毁旧文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-atomic-'))
  try {
    const file = path.join(dir, 'nested', 'state.json')
    atomicWriteJson(file, { a: 1 })
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 })
    assert.throws(() => atomicWrite(file, undefined))
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 }, '失败后旧内容仍在')
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp-')), [], '不留临时文件')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('note：一行一条，mkdir 选项能建目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-note-'))
  try {
    const sub = path.join(dir, 'logs')
    note(sub, '第一行', { mkdir: true })
    note(sub, '第二行', { mkdir: true })
    const lines = fs.readFileSync(path.join(sub, 'load.log'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(lines[0].includes('第一行'), true)
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('toolsOrRetry：tools 已就绪直接返回', () => {
  const tools = { register() {} }
  const st = { later() {} }
  const got = toolsOrRetry({ get: () => tools }, st, () => {})
  assert.equal(got, tools)
})

test('toolsOrRetry：没就绪时排一次重试，超时后走 warn', () => {
  const st = { later(fn) { this.retry = fn }, _toolsWaiting: false }
  const warn = []
  const got = toolsOrRetry({ get: () => undefined }, st, () => {}, { warn: (s) => warn.push(s) })
  assert.equal(got, null)
  assert.equal(typeof st.retry, 'function', '应排一次重试')
  assert.equal(st._toolsWaiting, true)

  // 假装已经等了 121 秒：默认 timeout 120 秒，应走 warn 而不是再排
  st._toolsWaiting = false
  st._toolsSince = Date.now() - 121000
  const got2 = toolsOrRetry({ get: () => undefined }, st, () => {}, { warn: (s) => warn.push(s) })
  assert.equal(got2, null)
  assert.equal(warn.length, 1)
  assert.equal(warn[0] >= 120, true, 'warn 拿到的是秒数')
})
