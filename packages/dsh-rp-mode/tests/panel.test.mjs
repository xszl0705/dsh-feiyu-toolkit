/**
 * dsh-rp-mode 卡库面板：契约测试 + 端点测试。
 * 跑法：node tests/panel.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

// 卡库是机器相关资源（自建库 + 下载库）。发布仓里没有卡时跳过依赖真实卡库的用例，避免误报失败。
const __libRoots = [process.env.DSH_RP_CARD_ROOT, process.env.DSH_RP_DOWNLOAD_ROOT].filter(Boolean)
const __hasLib = __libRoots.some((dir) => {
  try { return fs.readdirSync(dir).length > 0 } catch { return false }
})
if (!__hasLib) {
  console.log('SKIP: 没有可用的角色卡库（设 DSH_RP_CARD_ROOT / DSH_RP_DOWNLOAD_ROOT 后重跑）')
  process.exit(0)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT = path.join(ROOT, 'lib', 'client.js')

let pass = 0
const fails = []
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log('  ok  ' + name)
  } else {
    fails.push(name + (extra ? ' :: ' + extra : ''))
    console.log('  FAIL ' + name + (extra ? ' :: ' + extra : ''))
  }
}

/* ---------------- 1. client 契约 ---------------- */
console.log('[1] client 契约')
const SLOT_WHITELIST = new Set([
  'shell.overlay',
  'conversation.input.left',
  'conversation.input.dock',
  'conversation.chat.assistant-actions',
  'settings.section',
  'settings.plugins.tab',
  'sidebar.footer.action',
  'sidebar.panellist',
])

const registered = []
let loadedId = null
let factoryResult = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(def) {
        loadedId = def.id
        factoryResult = def.factory((name) => {
          if (name === 'react') {
            return {
              createElement: (...args) => ({ __el: args[0], args }),
              useState: (v) => [v, () => {}],
              useEffect: () => {},
              useCallback: (fn) => fn,
              useRef: (v) => ({ current: v }),
              Fragment: 'Fragment',
            }
          }
          throw new Error('unexpected require: ' + name)
        })
      },
    },
  },
  document: {
    querySelector: () => null,
    createElement: () => ({ style: {}, select() {}, value: '' }),
    body: { appendChild() {}, removeChild() {} },
    execCommand: () => true,
  },
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
  setTimeout,
  clearTimeout,
  console,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

const src = fs.readFileSync(CLIENT, 'utf8')
vm.runInContext(src, sandbox, { filename: 'client.js' })

ok('module id 是 dsh-rp-mode', loadedId === 'dsh-rp-mode', String(loadedId))
ok('factory 返回 apply/inject', Boolean(factoryResult && factoryResult.apply && factoryResult.inject), JSON.stringify(Object.keys(factoryResult || {})))
ok('inject 含 slots', Array.isArray(factoryResult?.inject) && factoryResult.inject.includes('slots'), JSON.stringify(factoryResult?.inject))

const ctxStub = {
  slots: {
    inject(name, fn) {
      registered.push({ inject: name })
      return fn()
    },
    register(opts, Comp) {
      registered.push({ opts, hasComp: typeof Comp === 'function' })
      return { dispose() {} }
    },
  },
}
try {
  factoryResult.apply(ctxStub)
  const reg = registered.find((r) => r.opts)
  ok('注册到了 slot', Boolean(reg), JSON.stringify(registered.map((r) => r.inject || r.opts?.name)))
  ok('slot 名在白名单里', Boolean(reg && SLOT_WHITELIST.has(reg.opts.name)), reg?.opts?.name)
  ok('注册带组件', Boolean(reg && reg.hasComp))
  ok('inject 用同名 slot', registered.some((r) => r.inject === reg?.opts?.name), JSON.stringify(registered.find((r) => r.inject)))
} catch (error) {
  ok('apply 不抛错', false, String(error && error.message))
}

/* ---------------- 2. 后端 queryRows ---------------- */
console.log('[2] 后端 queryRows')
const { __handlers } = await import('file:///' + path.join(ROOT, 'lib', 'webui.js').replace(/\\/g, '/'))
const { loadTagIndex } = await import('file:///' + path.join(ROOT, 'lib', 'card.js').replace(/\\/g, '/'))
const INDEX = process.env.DSH_RP_TAG_INDEX || path.join(process.cwd(), '_tmp', 'rp-cardindex', 'cards.jsonl')
const idx = loadTagIndex(INDEX)
ok('索引可用', Boolean(idx && idx.rows.length > 9000), idx ? String(idx.rows.length) : 'null')

if (idx) {
  const r1 = __handlers.queryRows(idx.rows, { q: '病娇 妹妹', limit: 5 })
  ok('关键词有命中', r1.total > 100 && r1.items.length === 5, `total=${r1.total} items=${r1.items.length}`)
  ok('首条带标签与摘要', Boolean(r1.items[0].name && r1.items[0].l1 && r1.items[0].preview), JSON.stringify({ n: r1.items[0].name, l1: r1.items[0].l1 }))
  ok('首条封面是 png url', String(r1.items[0].cover || '').startsWith('/dsh-rp-mode/cover'), r1.items[0].cover)

  const r2 = __handlers.queryRows(idx.rows, { l1: 'system', limit: 10 })
  ok('l1=system 全对', r2.items.length === 10 && r2.items.every((x) => x.l1 === 'system'), `total=${r2.total}`)

  const r3 = __handlers.queryRows(idx.rows, { tag: '巨乳,御姐', l2: 'school', limit: 5 })
  ok('tag+l2 过滤生效', r3.items.every((x) => (x.l2 || []).includes('school') && (x.traits || []).includes('巨乳')), `total=${r3.total}`)

  const r4 = __handlers.queryRows(idx.rows, { rating: 'hard', limit: 5 })
  ok('分级过滤生效', r4.items.every((x) => x.rating === 'hard'), `total=${r4.total}`)

  const r5 = __handlers.queryRows(idx.rows, { q: '不可能存在的词zzzqqq', limit: 5 })
  ok('无命中返回空', r5.total === 0 && r5.items.length === 0)
}

/* ---------------- 3. cover 安全 ---------------- */
console.log('[3] cover 安全')
function fakeRes() {
  const out = { status: 0, headers: null, body: null }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(body) {
      out.body = body
    },
  }
}
const coverH = __handlers.coverHandler()
const bad1 = fakeRes()
coverH({ url: '/dsh-rp-mode/cover?rel=..%2F..%2Fwindows%2Fwin.ini' }, bad1)
ok('目录穿越被拒', bad1.out.status === 403, String(bad1.out.status))

const bad2 = fakeRes()
coverH({ url: '/dsh-rp-mode/cover?rel=' + encodeURIComponent('_cardindex/cards.jsonl') }, bad2)
ok('非图片扩展被拒', bad2.out.status === 403, String(bad2.out.status))

const bad3 = fakeRes()
coverH({ url: '/dsh-rp-mode/cover?rel=' + encodeURIComponent('不存在/x.png') }, bad3)
ok('缺文件 404', bad3.out.status === 404, String(bad3.out.status))

/* ---------------- 4. meta ---------------- */
console.log('[4] meta')
const metaRes = fakeRes()
__handlers.metaHandler()({ url: '/dsh-rp-mode/meta' }, metaRes)
let meta = {}
try {
  meta = JSON.parse(metaRes.out.body)
} catch {
  meta = {}
}
ok('meta ok', meta.ok === true)
ok('meta 有 17 类题材', (meta.levels?.l2 || []).length === 17, String((meta.levels?.l2 || []).length))
ok('meta 有卡数', Number(meta.counts?.cards) > 9000, String(meta.counts?.cards))

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(' - ' + f)
  process.exit(1)
}
