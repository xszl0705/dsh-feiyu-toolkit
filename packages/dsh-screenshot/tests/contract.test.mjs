// 契约测试：不依赖宿主，验证 client bundle 的加载形态 + host 截图端点的形状
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
const styleNodes = []
const fakeDocument = {
  getElementById: (id) => styleNodes.find((node) => node.id === id) || null,
  createElement: (tag) => ({ tag, id: '', textContent: '' }),
  head: { appendChild: (node) => styleNodes.push(node) },
}
const sandbox = {
  window: { __ModuleLoader__: { load: (m) => { captured = m } } },
  document: fakeDocument,
  console,
  fetch: () => Promise.reject(new Error('no network in test')),
  setTimeout: () => 0,
  clearTimeout: () => {},
  File: class File {},
  DataTransfer: class DataTransfer {},
  AbortController,
}
vm.createContext(sandbox)
vm.runInContext(src, sandbox)

assert.ok(captured, 'client.js 没有调用 __ModuleLoader__.load')
assert.equal(captured.id, 'dsh-screenshot', 'module id 必须是包名')

const FakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
}
const mod = captured.factory((name) => {
  if (name === 'react') return FakeReact
  throw new Error('unexpected require: ' + name)
})

assert.equal(typeof mod.apply, 'function', 'client 必须导出 apply')
assert.equal(Array.from(mod.inject).join(','), 'slots', 'client 必须声明 inject: ["slots"]')

// 真实存在的 slot（从宿主 ui-conversation 契约里核过的名单）——
// 写错名字不会报错，只会静默不渲染，所以这里必须卡住
const KNOWN_SLOTS = new Set([
  'conversation.input.left',
  'conversation.input.right',
  'conversation.input.dock',
  'conversation.input.attachments',
  'shell.overlay',
  'settings.section',
  'sidebar.panellist',
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
assert.equal(registrations[0].meta.name, 'conversation.input.left')
assert.equal(registrations[0].meta.id, 'screenshot')
assert.equal(typeof registrations[0].component, 'function', 'slot 的组件必须是函数')
assert.equal(styleNodes.length, 1, '样式应当只注入一次')

// ---- 1.5 框选坐标换算：视口选区 → 图片像素矩形 ----
const crop = mod.__computeCrop
assert.equal(typeof crop, 'function', '应该导出 __computeCrop 供测试')

// 图片显示 1000x500（原图 2000x1000，缩了一半），选区落在图片内部
// 注意：对象来自 vm 沙箱，跨 realm 的 deepStrictEqual 会因原型不同失败，统一用 JSON 比
const sameRect = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message)
const imageRect = { left: 100, top: 50, width: 1000, height: 500 }
sameRect(
  crop(imageRect, { left: 600, top: 150, width: 200, height: 100 }, 2000, 1000),
  { px: 1000, py: 200, pw: 400, ph: 200 },
  '内部选区应按缩放比换算',
)

// 选区左/上越过图片边界：clamp 到图片内，不产生负偏移
sameRect(
  crop(imageRect, { left: 0, top: 0, width: 200, height: 100 }, 2000, 1000),
  { px: 0, py: 0, pw: 200, ph: 100 },
  '越界选区应被 clamp',
)

// 选区完全在图外 / 太小：返回 null（视为取消，不插入）
assert.equal(crop(imageRect, { left: 0, top: 0, width: 20, height: 20 }, 2000, 1000), null, '图外选区应为 null')
assert.equal(crop(imageRect, { left: 200, top: 100, width: 3, height: 3 }, 2000, 1000), null, '过小选区应为 null')
assert.equal(crop({ left: 0, top: 0, width: 0, height: 0 }, { left: 10, top: 10, width: 50, height: 50 }, 100, 100), null, '图片未布局时为 null')

// ---- 2. host 半侧：端点形状 + 无服务时不抛 ----
const host = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
assert.equal(host.name, 'dsh-screenshot')

// 没有任何服务时必须安静返回，且不能在进程里留下 250ms 重试定时器
const disposers = []
const bare = {
  get: () => undefined,
  effect: (fn) => {
    const cleanup = fn()
    if (typeof cleanup === 'function') disposers.push(cleanup)
  },
}
host.apply(bare)
host.apply(bare)

// 有 webServer 但没有 tools 时：注册一条 exact 路由（tools 走自己的重试）
let route = null
const withWeb = {
  get: (name) => (name === 'webServer' ? { register: (r) => { route = r; return () => {} } } : undefined),
  effect: (fn) => {
    const cleanup = fn()
    if (typeof cleanup === 'function') disposers.push(cleanup)
  },
}
host.apply(withWeb)
assert.ok(route, '应该注册截图路由')
assert.equal(route.kind, 'exact')
assert.equal(route.path, '/dsh-screenshot/capture')
assert.equal(typeof route.handler, 'function')

// 清掉重试定时器，避免测试进程被吊住
for (const dispose of disposers) dispose()

console.log('OK screenshot client slot + host capture route contract')
