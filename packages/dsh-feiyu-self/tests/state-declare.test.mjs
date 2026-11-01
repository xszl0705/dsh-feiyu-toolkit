import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-state-'))
process.env.DSH_HOME = temp

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
const tools = new Map()
const ctx = {
  logger: { info() {}, warn() {} },
  get: (name) => (name === 'tools' ? { register: (tool) => { tools.set(tool.name, tool); return { dispose: () => tools.delete(tool.name) } } } : undefined),
  effect: (fn) => fn(),
  provide: () => {},
}
mod.apply(ctx)

const api = globalThis[Symbol.for('dsh-feiyu-self.service')]

test('declare 带 state 函数后，快照里能读到运行时状态', () => {
  api.declare({
    id: 'demo',
    package: 'dsh-demo',
    intent: '演示',
    limits: ['不做事'],
    failureModes: [{ code: 'NOPE' }],
    state: () => ({ items: 3, mode: 'idle' }),
  })
  const snapshot = api.refresh('test')
  const demo = snapshot.capabilities.find((item) => item.id === 'demo')
  assert.equal(demo.state.items, 3)
  assert.equal(demo.state.mode, 'idle')
})

test('state 函数抛错时记下错误，不让快照挂掉', () => {
  api.declare({
    id: 'broken',
    package: 'dsh-broken',
    intent: '会抛错',
    limits: ['x'],
    failureModes: [{ code: 'ERR' }],
    state: () => {
      throw new Error('boom')
    },
  })
  const snapshot = api.refresh('test')
  const broken = snapshot.capabilities.find((item) => item.id === 'broken')
  assert.equal(broken.state.error, 'boom')
})

test('没有 state 的能力，state 为 null 而不是编造', () => {
  api.declare({ id: 'plain', package: 'dsh-plain', intent: '无状态', limits: ['x'], failureModes: [] })
  const snapshot = api.refresh('test')
  assert.equal(snapshot.capabilities.find((item) => item.id === 'plain').state, null)
})

test('state 函数不会被写进 capabilities.json', () => {
  const file = path.join(temp, 'dafeiyu', 'self', 'capabilities.json')
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
  const demo = rows.find((row) => row.id === 'demo')
  assert.ok(demo)
  assert.equal('state' in demo, false)
})

test('self_capabilities 渲染会带上状态摘要', () => {
  api.refresh('test')
  const tool = tools.get('self')
  const value = { action: 'capabilities', capabilities: api.snapshot().capabilities }
  const text = tool.output.render({ action: 'capabilities' }, value)[0].text
  assert.ok(text.includes('items=3'), text)
  assert.ok(text.includes('⚠'), text)
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
