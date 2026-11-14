/**
 * dsh-rp-mode 卡库面板：宽屏 / 精简 两套布局的回归测试。
 *
 * 为什么要有它：布局是内联样式拼出来的，改一个数字没有任何编译期保护；
 * 而「手机上显示不全」正是这些数字（列宽 172px、详情栏 320px、筛选区高度上限）凑出来的。
 * 这里用一个极小的 DOM stub 真跑 panel.js，点按钮切布局，再断言生成的 style 字符串。
 *
 * 跑法：node tests/layout.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PANEL = path.join(ROOT, 'lib', 'panel.js')

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

/* ---------------- 极小 DOM stub ---------------- */

function makeEl(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    attrs: {},
    children: [],
    textContent: '',
    onclick: null,
    parentNode: null,
    style: {},
    setAttribute(name, value) {
      this.attrs[name] = String(value)
      if (name === 'style') this.style = parseStyle(value)
    },
    getAttribute(name) {
      return this.attrs[name]
    },
    appendChild(child) {
      child.parentNode = this
      this.children.push(child)
      return child
    },
    removeChild(child) {
      const i = this.children.indexOf(child)
      if (i >= 0) this.children.splice(i, 1)
      child.parentNode = null
      return child
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null
    },
    get innerHTML() {
      return ''
    },
    set innerHTML(v) {
      if (v === '') this.children.length = 0
    },
  }
  return node
}

function parseStyle(text) {
  const out = {}
  String(text || '')
    .split(';')
    .forEach((kv) => {
      const i = kv.indexOf(':')
      if (i <= 0) return
      const k = kv.slice(0, i).trim()
      const v = kv.slice(i + 1).trim()
      out[k] = v
      // 同时给 camelCase 别名，断言写 flexDirection / gridTemplateColumns 也能取到
      out[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v
    })
  return out
}

const storage = new Map()
const body = makeEl('body')
// panel.js 的模式判定挂在 setInterval 上，stub 要把回调收下来才能手动触发
const intervals1 = []

const sandbox = {
  window: {
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
  },
  document: {
    body,
    createElement: makeEl,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
  },
  fetch: () =>
    Promise.resolve({
      json: () =>
        Promise.resolve({
          total: 1,
          items: [{ id: 'a', name: '测试卡', l1: 'character', rating: 'sfw', words: 1200, cover: '', rel: 'x/a.json' }],
        }),
    }),
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: (fn) => {
    if (typeof fn === 'function') intervals1.push(fn)
    return 0
  },
  clearInterval: () => {},
  console,
}
sandbox.globalThis = sandbox
sandbox.window.document = sandbox.document
vm.createContext(sandbox)

const src = fs.readFileSync(PANEL, 'utf8')
vm.runInContext(src, sandbox, { filename: 'panel.js' })

/* ---------------- 1. 挂载 ---------------- */
console.log('[1] 挂载')
ok('设置注入标记', sandbox.window.__RP_CARDS_PANEL__ === true)
const launcher = body.children.find((n) => n.onclick)
ok('右下角按钮已挂上', Boolean(launcher), String(body.children.length))
ok(
  '宽屏按钮在右下 24px',
  launcher.style.bottom === '24px' && launcher.style.top === 'auto',
  launcher.style.bottom + '/' + launcher.style.top,
)

launcher.onclick()
const mask = body.children.find((n) => n.children && n.children.length && n !== launcher)
ok('点按钮后建出 mask', Boolean(mask && mask.children.length === 1))
if (!mask) process.exit(1)
const panel = mask.children[0]
const styleOf = (node) => node.style || {}

/* 面板内部结构：head / chips / body / foot */
const [head, chips, bodyRow, foot] = panel.children
ok('结构四段', Boolean(head && chips && bodyRow && foot), String(panel.children.length))
const [title, input] = head.children
ok('头部第一个是标题「选卡」', Boolean(title) && title.textContent === '选卡', title && title.textContent)
ok('不再有布局切换按钮', !head.children.some((n) => String(n.textContent || '').indexOf('宽屏') >= 0), String(head.children.length))
const [grid, side] = bodyRow.children

/* ---------------- 2. 桌面宽屏（唯一版式） ---------------- */
console.log('[2] 桌面宽屏')
ok('panel 宽 1180 上限', styleOf(panel).width === 'min(1180px,94vw)', styleOf(panel).width)
ok('panel 高 760 上限', styleOf(panel).height === 'min(760px,90vh)', styleOf(panel).height)
ok('panel 圆角 14px', styleOf(panel).borderRadius === '14px', styleOf(panel).borderRadius)
ok('mask 居中留边', styleOf(mask).alignItems === 'center' && styleOf(mask).padding === '3vh 3vw', styleOf(mask).alignItems + '/' + styleOf(mask).padding)
ok('网格列宽 172', String(styleOf(grid).gridTemplateColumns).includes('minmax(172px'), styleOf(grid).gridTemplateColumns)
ok('详情在右侧 320px', styleOf(side).width === '320px', styleOf(side).width)
ok('主体横排', styleOf(bodyRow).flexDirection === 'row', styleOf(bodyRow).flexDirection)
ok('筛选区限 34vh 可滚', styleOf(chips).maxHeight === '34vh' && styleOf(chips).overflowY === 'auto', styleOf(chips).maxHeight + '/' + styleOf(chips).overflowY)
ok('筛选区不被压缩', styleOf(chips).flexShrink === '0', styleOf(chips).flexShrink)
ok('输入框弹性宽', styleOf(input).flex === '1 1 260px', styleOf(input).flex)
ok('底部不限高', styleOf(foot).maxHeight === 'none', styleOf(foot).maxHeight)
ok('不再读写 localStorage', storage.size === 0, String(storage.size))

/* ---------------- 3. 筛选项折行（桌面） ---------------- */
// open() 里 chips 由 fetchMeta().then(renderChips) 渲染，是异步的。
// 用 macrotask 边界把 vm 里的 microtask 队列清干净（stub 的 setTimeout 是空实现，不能靠它）。
await new Promise((resolve) => setImmediate(resolve))
console.log('[3] 筛选项折行')
const strips = chips.children.filter((n) => n.children.length)
ok('有筛选行', strips.length > 0, String(strips.length))
ok('每行折行不横滑', strips.every((n) => styleOf(n).flexWrap === 'wrap'), JSON.stringify(strips.slice(0, 2).map((n) => styleOf(n).flexWrap)))

/* ---------------- 5. 重开面板仍是同一套 ---------------- */
console.log('[5] 重开面板仍是同一套')
const body2 = makeEl('body')
const sandbox2 = { ...sandbox, document: { ...sandbox.document, body: body2 } }
sandbox2.globalThis = sandbox2
vm.createContext(sandbox2)
vm.runInContext(src.replace('window.__RP_CARDS_PANEL__', 'window.__RP_PANEL_2__'), sandbox2, { filename: 'panel2.js' })
const launcher2 = body2.children.find((n) => n.onclick)
launcher2.onclick()
const panel2 = body2.children.find((n) => n.children.length).children[0]
const [head2, , bodyRow2] = panel2.children
const [, side2] = bodyRow2.children
ok('重开后主体仍横排', bodyRow2.style.flexDirection === 'row', bodyRow2.style.flexDirection)
ok('重开后详情仍在右侧', side2.style.width === '320px', side2.style.width)
ok('重开后依然没有切换按钮', head2.children.length === head.children.length, String(head2.children.length))

/* ---------------- 6. 窄视口 390px：宽屏退化成竖排抽屉 ---------------- */
// 320px 侧栏 + 172px 列在 360px 屏上会把网格压成一条缝，所以窄屏只退化渲染。
console.log('[6] 窄视口 390px')
const body3 = makeEl('body')
const intervals3 = []
const sandbox3 = {
  ...sandbox,
  window: { ...sandbox.window, innerWidth: 390 },
  document: { ...sandbox.document, body: body3 },
  setInterval: (fn) => {
    if (typeof fn === 'function') intervals3.push(fn)
    return 0
  },
}
sandbox3.globalThis = sandbox3
vm.createContext(sandbox3)
vm.runInContext(src.replace('window.__RP_CARDS_PANEL__', 'window.__RP_PANEL_3__'), sandbox3, { filename: 'panel3.js' })
const launcher3 = body3.children.find((n) => n.onclick)
launcher3.onclick()
const panel3 = body3.children.find((n) => n.children.length).children[0]
const [, chips3, bodyRow3] = panel3.children
const [grid3, side3] = bodyRow3.children
ok('窄屏 panel 铺满', panel3.style.width === '100%' && panel3.style.height === '100%', panel3.style.width + '/' + panel3.style.height)
ok('窄屏去圆角', panel3.style.borderRadius === '0', panel3.style.borderRadius)
ok('窄屏主体竖排', bodyRow3.style.flexDirection === 'column', bodyRow3.style.flexDirection)
ok('窄屏网格 104 列', String(grid3.style.gridTemplateColumns).includes('minmax(104px'), grid3.style.gridTemplateColumns)
ok('窄屏筛选 22vh 可滚', chips3.style.maxHeight === '22vh' && chips3.style.overflowY === 'auto', chips3.style.maxHeight + '/' + chips3.style.overflowY)
ok('窄屏没选卡时详情 0 高', side3.style.height === '0px', side3.style.height)
ok('窄屏详情撑满宽', side3.style.width === '100%', side3.style.width)
ok(
  '窄屏按钮挪到右上，不再压发送键',
  launcher3.style.top === '84px' && launcher3.style.bottom === 'auto',
  launcher3.style.top + '/' + launcher3.style.bottom,
)
ok('窄屏按钮不再贴右 24px', launcher3.style.right === '8px', launcher3.style.right)

/* ---------------- 7. 模式判定：未知不灰化 ---------------- */
// 旧实现把 innerText 前 4000 字里找不到「扮演模式」当成「不是扮演模式」，
// 新会话（blank）与手机端都会落在这条分支上被误判。这里锁住三态行为。
console.log('[7] 模式判定三态')
const sync = () => intervals3.forEach((fn) => fn())

body3.textContent = ''
sync()
ok('读不到模式时不灰化', launcher3.style.opacity === '1', String(launcher3.style.opacity))
ok('读不到模式时 title 说明未识别', String(launcher3.title || '').indexOf('未识别') >= 0, String(launcher3.title))

body3.textContent = '会话标题 · 扮演模式'
sync()
ok('出现扮演模式时正常亮', launcher3.style.opacity === '1', String(launcher3.style.opacity))
ok('扮演模式 title 写明当前模式', String(launcher3.title || '').indexOf('扮演模式') >= 0, String(launcher3.title))

body3.textContent = '新会话 · 标准模式'
sync()
ok('确认是其它模式时灰化', launcher3.style.opacity === '0.6', String(launcher3.style.opacity))

body3.textContent = '标准模式'
sandbox3.window.__RP_CARDS_PRESET__ = 'roleplay'
sync()
ok('客户端推来的 preset 优先于页面文本', launcher3.style.opacity === '1', String(launcher3.style.opacity))
delete sandbox3.window.__RP_CARDS_PRESET__

/* ---------------- 汇总 ---------------- */
console.log('')
if (fails.length) {
  console.log(`FAIL ${fails.length} / PASS ${pass}`)
  fails.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}
console.log(`全部通过：${pass} 项`)
