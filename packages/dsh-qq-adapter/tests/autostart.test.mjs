import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { ensureMindLoop, ensureNapCat, ensureServices, pidAlive, portOpen, readPid } from '../lib/autostart.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'autostart-'))
const launcherRoot = path.join(temp, 'napcat')
fs.mkdirSync(launcherRoot, { recursive: true })
fs.writeFileSync(path.join(launcherRoot, 'start-hidden.vbs'), '')
const scriptDir = path.join(temp, 'mind-loop')
fs.mkdirSync(scriptDir, { recursive: true })
fs.writeFileSync(path.join(scriptDir, 'mind-loop.mjs'), '')
const pidFile = path.join(temp, 'mind-loop.pid')

function config(overrides = {}) {
  return {
    autostart: {
      napcat: { root: launcherRoot, launcher: 'start-hidden.vbs', port: 3001, webuiPort: 6099, cooldownMs: 30000, ...overrides.napcat },
      mindLoop: { enabled: true, script: path.join(scriptDir, 'mind-loop.mjs'), node: process.execPath, pidFile, cooldownMs: 600000, ...overrides.mindLoop },
    },
  }
}

test('portOpen 能区分有人听和没人听', async () => {
  const server = net.createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  assert.equal(await portOpen(port, { timeoutMs: 500 }), true)
  await new Promise((resolve) => server.close(resolve))
  assert.equal(await portOpen(port, { timeoutMs: 500 }), false)
})

test('QQ 端口没开 → 只拉起一次，冷却期内不重复', async () => {
  const calls = []
  const state = {}
  const launch = (...args) => {
    calls.push(args)
    return {}
  }
  const probe = async () => false
  const first = await ensureNapCat({ config: config(), state, note: () => {}, probe, launch })
  assert.equal(first.action, 'launched')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].length, 1)
  assert.match(calls[0][1][0], /start-hidden\.vbs$/)
  const second = await ensureNapCat({ config: config(), state, note: () => {}, probe, launch })
  assert.equal(second.action, 'cooldown')
  assert.equal(calls.length, 1)
})

test('3001 或 6099 有人听时不乱拉', async () => {
  const calls = []
  const launch = (...args) => calls.push(args)
  assert.equal((await ensureNapCat({ config: config(), state: {}, probe: async (p) => p === 3001, launch })).action, 'up')
  assert.equal((await ensureNapCat({ config: config(), state: {}, probe: async (p) => p === 6099, launch })).action, 'starting')
  assert.equal(calls.length, 0)
})

test('有 node.exe + index.js 时走 node 直启，输出进日志', async () => {
  const root = path.join(temp, 'napcat-node')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'node.exe'), '')
  fs.writeFileSync(path.join(root, 'index.js'), '')
  const calls = []
  const result = await ensureNapCat({
    config: config({ napcat: { root } }),
    state: {},
    probe: async () => false,
    launch: (...args) => calls.push(args),
  })
  assert.equal(result.action, 'launched')
  assert.equal(result.mode, 'node')
  assert.equal(calls[0][0], path.join(root, 'node.exe'))
  assert.equal(calls[0][1][0], path.join(root, 'index.js'))
  assert.ok(Number.isInteger(calls[0][2].stdio?.[1]), 'stdout 应重定向到日志句柄')
  const log = fs.readFileSync(path.join(root, 'napcat-autostart.log'), 'utf8')
  assert.match(log, /attempt=1 mode=node/)
})

test('launcher 不存在时不假装成功', async () => {
  const state = {}
  const result = await ensureNapCat({
    config: config({ napcat: { root: path.join(temp, 'missing') } }),
    state,
    probe: async () => false,
    launch: () => assert.fail('should not launch'),
  })
  assert.equal(result.action, 'missing-launcher')
  assert.equal(state.napcatFailures, 1)
})

test('自动拉起可整体关掉', async () => {
  const result = await ensureNapCat({
    config: { autostart: { enabled: false } },
    state: {},
    probe: async () => false,
    launch: () => assert.fail('should not launch'),
  })
  assert.equal(result.action, 'disabled')
})

test('微心跳按 pid 文件判断存活，不重复拉起', async () => {
  fs.writeFileSync(pidFile, String(process.pid))
  assert.equal(readPid(pidFile), process.pid)
  assert.equal(pidAlive(process.pid), true)
  const calls = []
  const result = await ensureMindLoop({ config: config(), state: {}, launch: (...args) => calls.push(args) })
  assert.equal(result.action, 'running')
  assert.equal(calls.length, 0)
})

test('微心跳没在跑 → 用隐藏方式拉一份', async () => {
  fs.rmSync(pidFile, { force: true })
  const calls = []
  const state = {}
  const result = await ensureMindLoop({
    config: config(),
    state,
    launch: (...args) => calls.push(args),
  })
  assert.equal(result.action, 'launched')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], process.execPath)
  assert.match(calls[0][1][0], /mind-loop\.mjs$/)
  assert.equal(calls[0][2].cwd, scriptDir)
  const again = await ensureMindLoop({ config: config(), state, launch: (...args) => calls.push(args) })
  assert.equal(again.action, 'cooldown')
  assert.equal(calls.length, 1)
})

test('ensureServices 同时处理两边', async () => {
  fs.rmSync(pidFile, { force: true })
  const seen = []
  const result = await ensureServices({
    config: config(),
    state: {},
    probe: async () => false,
    launch: (file, args) => seen.push({ file, args }),
  })
  assert.equal(result.napcat.action, 'launched')
  assert.equal(result.mindLoop.action, 'launched')
  assert.equal(seen.length, 2)
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
