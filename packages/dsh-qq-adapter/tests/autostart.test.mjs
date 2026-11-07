import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { ensureMindLoop, ensureServices, pidAlive, portOpen, probeBridge, readPid } from '../lib/autostart.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'autostart-'))
const scriptDir = path.join(temp, 'mind-loop')
fs.mkdirSync(scriptDir, { recursive: true })
fs.writeFileSync(path.join(scriptDir, 'mind-loop.mjs'), '')
const pidFile = path.join(temp, 'mind-loop.pid')

function config(overrides = {}) {
  return {
    autostart: {
      mindLoop: { script: path.join(scriptDir, 'mind-loop.mjs'), node: process.execPath, pidFile, cooldownMs: 600000, ...overrides.mindLoop },
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

test('桥端口在听 → up / 没人听 → down，都不拉起', async () => {
  assert.equal((await probeBridge({ config: config(), probe: async () => true })).action, 'up')
  assert.equal((await probeBridge({ config: config(), probe: async () => false })).action, 'down')
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

test('微心跳没在跑 → 用隐藏方式拉一份，冷却期内不重复', async () => {
  fs.rmSync(pidFile, { force: true })
  const calls = []
  const state = {}
  const result = await ensureMindLoop({ config: config(), state, launch: (...args) => calls.push(args) })
  assert.equal(result.action, 'launched')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], process.execPath)
  assert.match(calls[0][1][0], /mind-loop\.mjs$/)
  assert.equal(calls[0][2].cwd, scriptDir)
  const again = await ensureMindLoop({ config: config(), state, launch: (...args) => calls.push(args) })
  assert.equal(again.action, 'cooldown')
  assert.equal(calls.length, 1)
})

test('ensureServices 只拉微心跳，不碰桥', async () => {
  fs.rmSync(pidFile, { force: true })
  const seen = []
  const result = await ensureServices({
    config: config(),
    state: {},
    probe: async () => false,
    launch: (file, args) => seen.push({ file, args }),
  })
  assert.equal(result.bridge.action, 'down')
  assert.equal(result.mindLoop.action, 'launched')
  assert.equal(seen.length, 1)
  assert.match(seen[0].args[0], /mind-loop\.mjs$/)
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
