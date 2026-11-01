import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'autostart-svc-'))
process.env.DSH_HOME = temp

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)

const declared = []
globalThis[Symbol.for('dsh-feiyu-self.service')] = { declare: (manifest) => declared.push(manifest) }

const ctx = {
  logger: { info() {}, warn() {} },
  get: () => undefined,
  effect: (fn) => fn(),
  provide: () => {},
}
const api = mod.apply(ctx)

const launcherRoot = path.join(temp, 'napcat')
fs.mkdirSync(launcherRoot, { recursive: true })
fs.writeFileSync(path.join(launcherRoot, 'start-hidden.vbs'), '')
const mindLoopScript = path.join(temp, 'mind-loop.mjs')
fs.writeFileSync(mindLoopScript, '')

const napcatConfig = (overrides = {}) => ({
  autostart: {
    napcat: { enabled: true, root: launcherRoot, launcher: 'start-hidden.vbs', ...overrides },
    mindLoop: { enabled: true, script: mindLoopScript, node: process.execPath },
  },
})

test('apply 返回服务，能力已声明', () => {
  assert.ok(api)
  assert.equal(typeof api.ensureServices, 'function')
  const manifest = declared.find((item) => item.id === 'autostart')
  assert.ok(manifest)
  assert.equal(manifest.package, 'dsh-service-autostart')
  assert.equal(typeof manifest.state, 'function')
})

test('端口在听就不拉', async () => {
  const calls = []
  const result = await api.ensureNapCat({ config: napcatConfig(), state: {}, probe: async () => true, launch: (...args) => calls.push(args), note: () => {} })
  assert.equal(result.action, 'up')
  assert.equal(calls.length, 0)
})

test('端口没人听就拉一次，冷却期内不重复', async () => {
  const calls = []
  const state = {}
  const run = () => api.ensureNapCat({ config: napcatConfig(), state, probe: async () => false, launch: (...args) => calls.push(args), note: () => {} })
  const first = await run()
  assert.equal(first.action, 'launched')
  assert.equal(calls.length, 1)
  const second = await run()
  assert.equal(second.action, 'cooldown')
  assert.equal(calls.length, 1)
})

test('调用方关掉 enabled 就不拉', async () => {
  const result = await api.ensureNapCat({
    config: { autostart: { enabled: false } },
    state: {},
    probe: async () => false,
    launch: () => assert.fail('should not launch'),
    note: () => {},
  })
  assert.equal(result.action, 'disabled')
})

test('ensureServices 同时处理 QQ 和微心跳', async () => {
  const seen = []
  const result = await api.ensureServices({
    config: napcatConfig(),
    state: {},
    probe: async () => false,
    launch: (file, args) => seen.push({ file, args }),
    note: () => {},
  })
  assert.equal(result.napcat.action, 'launched')
  assert.ok(['launched', 'cooldown', 'running'].includes(result.mindLoop.action), result.mindLoop.action)
  assert.ok(seen.length >= 1)
})

test('stats 记录调用次数和最近结果', () => {
  const stats = api.stats()
  assert.ok(stats.calls >= 4)
  assert.ok(stats.last && stats.last.result)
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
