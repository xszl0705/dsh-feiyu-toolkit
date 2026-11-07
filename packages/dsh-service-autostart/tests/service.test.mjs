import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'autostart-svc-'))
process.env.DSH_HOME = temp
process.env.DSH_AUTOSTART_SKIP_STARTUP = '1'

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

test('apply 返回服务，NapCat 拉起入口已移除', () => {
  assert.ok(api)
  assert.equal(typeof api.ensureServices, 'function')
  assert.equal(typeof api.ensureMindLoop, 'function')
  assert.equal(typeof api.probeBridge, 'function')
  assert.equal(typeof api.ensureNapCat, 'undefined')
  const manifest = declared.find((item) => item.id === 'autostart')
  assert.ok(manifest)
  assert.equal(manifest.package, 'dsh-service-autostart')
  assert.match(String(manifest.intent), /微心跳/)
})

test('桥端口在听 → up，且不拉起任何东西', async () => {
  const result = await api.probeBridge({ config: {}, probe: async () => true })
  assert.equal(result.action, 'up')
})

test('桥端口没人听 → down，也不拉起（桥由 SnowLuma 自己维护）', async () => {
  const result = await api.probeBridge({ config: {}, probe: async () => false })
  assert.equal(result.action, 'down')
})

test('ensureServices 只拉起微心跳，不碰桥', async () => {
  const scriptDir = path.join(temp, 'mind-loop')
  fs.mkdirSync(scriptDir, { recursive: true })
  const script = path.join(scriptDir, 'mind-loop.mjs')
  fs.writeFileSync(script, '')
  const pidFile = path.join(temp, 'mind-loop.pid')
  const seen = []
  const result = await api.ensureServices({
    config: { autostart: { mindLoop: { script, node: process.execPath, pidFile, cooldownMs: 600000 } } },
    state: {},
    probe: async () => false,
    launch: (file, args) => seen.push({ file, args }),
    note: () => {},
  })
  assert.equal(result.bridge.action, 'down')
  assert.equal(result.mindLoop.action, 'launched')
  assert.equal(seen.length, 1)
  assert.match(seen[0].args[0], /mind-loop\.mjs$/)
})

test('bsk 端口在听 → running，不重复拉起', async () => {
  const result = await api.ensureBskDaemon({ config: {}, probe: async () => true })
  assert.equal(result.action, 'running')
  assert.equal(result.port, 52800)
})

test('bsk 没在跑且文件存在 → 以 foreground 拉起，env 带 BSK_HOME', async () => {
  const bin = path.join(temp, 'bsk.exe')
  fs.writeFileSync(bin, '')
  const home = path.join(temp, 'bsk-home')
  const seen = []
  const result = await api.ensureBskDaemon({
    config: { autostart: { bsk: { bin, home, cooldownMs: 600000 } } },
    state: {},
    probe: async () => false,
    launch: (file, args, options) => seen.push({ file, args, options }),
    note: () => {},
  })
  assert.equal(result.action, 'launched')
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].args, ['daemon', 'start', '--foreground'])
  assert.equal(seen[0].options.env.BSK_HOME, home)
})

test('bsk 可执行文件不存在 → missing-binary，不拉起', async () => {
  const result = await api.ensureBskDaemon({
    config: { autostart: { bsk: { bin: path.join(temp, 'nope.exe'), home: temp } } },
    state: {},
    probe: async () => false,
    launch: () => assert.fail('不该拉起'),
    note: () => {},
  })
  assert.equal(result.action, 'missing-binary')
})

test('stats 记录调用次数和最近结果', () => {
  const stats = api.stats()
  assert.ok(stats.calls >= 3)
  assert.ok(stats.last && stats.last.result)
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
