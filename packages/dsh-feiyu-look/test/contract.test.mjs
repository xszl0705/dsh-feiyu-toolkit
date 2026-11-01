// 契约测试：不依赖宿主，验证 client bundle 的加载形态 + host 聚合端点的形状
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// ---- 1. client bundle：必须能被 __ModuleLoader__ 接住，并导出 apply/inject ----
const src = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (m) => { captured = m } } },
  console,
  fetch: () => Promise.reject(new Error('no network in test')),
  setInterval: () => 0,
  clearInterval: () => {},
}
vm.createContext(sandbox)
vm.runInContext(src, sandbox)

assert.ok(captured, 'client.js 没有调用 __ModuleLoader__.load')
assert.equal(captured.id, 'dsh-feiyu-look', 'module id 必须是包名')

const FakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
}
const mod = captured.factory((name) => {
  if (name === 'react') return FakeReact
  throw new Error('unexpected require: ' + name)
})

assert.equal(typeof mod.apply, 'function', 'client 必须导出 apply')
assert.equal(Array.from(mod.inject).join(','), 'slots', 'client 必须声明 inject: ["slots"]')

// 真实存在过的 slot（从已装 client 插件里扫出来的白名单）——
// 写错名字不会报错，只会静默不渲染，所以这里必须卡住
const KNOWN_SLOTS = new Set([
  'plugins.bundle.config',
  'plugins.tab',
  'settings.plugin.item',
  'settings.plugins.tab',
  'settings.section',
  'shell.overlay',
  'sidebar.panellist',
  'tool.call.toolview',
])

const registrations = []
const fakeCtx = {
  slots: {
    inject: (name, fn) => {
      assert.ok(KNOWN_SLOTS.has(name), `slot 名不在已知白名单里：${name}`)
      fn()
    },
    register: (meta, component) => {
      registrations.push({ meta, component })
      return () => {}
    },
  },
}
mod.apply(fakeCtx)
assert.equal(registrations.length, 1, '应该注册一个 slot')
assert.equal(registrations[0].meta.name, 'shell.overlay')
assert.equal(registrations[0].meta.id, 'feiyu-look')
assert.equal(typeof registrations[0].component, 'function', 'slot 的组件必须是函数')

// ---- 2. host 半侧：聚合函数形状 + 路由注册 ----
const host = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
assert.equal(host.name, 'dsh-feiyu-look')

const state = host.collectState()
assert.equal(typeof state, 'object')
assert.equal(typeof state.at, 'string')
for (const key of ['mood', 'memory', 'knowledge', 'skills', 'pet']) {
  assert.ok(key in state, '缺少字段 ' + key)
}
if (state.memory !== null) assert.equal(typeof state.memory.items, 'number')
if (state.knowledge !== null) assert.equal(typeof state.knowledge.items, 'number')
if (state.mood !== null) assert.equal(typeof state.mood.value, 'number')

// 没有 webServer 时不能抛
host.apply({})
host.apply({})

// 有 webServer 时注册一条 exact 路由，handler 返回 JSON
let route = null
host.apply({ get: () => ({ register: (r) => { route = r; return () => {} } }) })
assert.ok(route, '应该注册路由')
assert.equal(route.path, '/dsh-feiyu-look/state')
assert.equal(route.kind, 'exact')

let body = ''
const res = {
  writeHead: () => {},
  end: (chunk) => { body = String(chunk) },
}
route.handler({ url: '/dsh-feiyu-look/state' }, res)
const parsed = JSON.parse(body)
assert.equal(typeof parsed, 'object')
assert.ok('mood' in parsed && 'memory' in parsed)

console.log('OK client bundle + host state contract')
console.log(JSON.stringify(parsed, null, 2))
