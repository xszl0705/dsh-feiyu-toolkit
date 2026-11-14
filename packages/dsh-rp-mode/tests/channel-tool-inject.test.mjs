/**
 * view 注入单测（2026-11-10 · 0.5.13）。
 *
 * 背景：`dsh-tools/lib/index.js:477 view(scope)` 里 agent **自己那层**的注册
 * 无条件可见，其它层要靠 scope 链继承；rp-mode 注册在 preset realm 的层，
 * 这条链不通 —— 实测扮演会话请求体只剩 `web_fetch / web_search`。
 * 0.5.13 改成：在 view 出口把本包工具补进白名单视图。
 *
 * 关键不变量：补进去的 registration 必须是**同一个对象实例**，
 * 否则 `dsh-tools:568` 的 `===` 准入校验会把工具剔掉（schema 有、调用 UNKNOWN_TOOL）。
 *
 * 跑法：node tests/channel-tool-inject.test.mjs
 */
import { buildExtraTools, filterView } from '../lib/channel.js'

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

const rpCard = { name: 'rp_card', description: 'cards', execute() {} }
const rpMemory = { name: 'rp_memory', description: 'memory', execute() {} }
const webSearch = { name: 'web_search', description: 'web', execute() {} }

function baseView() {
  return {
    visible: new Map([['web_search', webSearch]]),
    registrations: new Map([['web_search', { definition: webSearch }]]),
    knownNames: new Set(['web_search', 'pwsh', 'read']),
    restrictableNames: new Set(['web_search', 'pwsh', 'read']),
  }
}

// 1. buildExtraTools 的形状
{
  const extra = buildExtraTools([rpCard, rpMemory, null, { description: '无名' }])
  ok('跳过无效定义', extra.visible.size === 2, String(extra.visible.size))
  ok('两个工具都在', extra.visible.has('rp_card') && extra.visible.has('rp_memory'))
  ok('每个都有 registration', extra.registrations.get('rp_card')?.definition === rpCard)
}

// 2. 白名单允许 + 原视图没有 ⇒ 补进来
{
  const extra = buildExtraTools([rpCard])
  const keep = new Set(['web_search', 'rp_card'])
  const view = filterView(baseView(), keep, extra)
  ok('补进 rp_card', view.visible.has('rp_card'))
  ok('原有 web_search 还在', view.visible.has('web_search'))
  ok('knownNames 跟上', view.knownNames.has('rp_card'))
  ok('registration 指向同一 definition', view.registrations.get('rp_card')?.definition === rpCard)
}

// 3. 白名单没配 ⇒ 不补
{
  const extra = buildExtraTools([rpCard])
  const view = filterView(baseView(), new Set(['web_search']), extra)
  ok('白名单外不补', !view.visible.has('rp_card'))
}

// 4. 原本可见的同名工具不被 extra 覆盖
{
  const real = { name: 'rp_card', description: 'real', execute() {} }
  const view0 = {
    visible: new Map([['rp_card', real]]),
    registrations: new Map([['rp_card', { definition: real, real: true }]]),
    knownNames: new Set(['rp_card']),
    restrictableNames: new Set(['rp_card']),
  }
  const view = filterView(view0, new Set(['rp_card']), buildExtraTools([rpCard]))
  ok('保留真实注册', view.visible.get('rp_card') === real)
  ok('保留真实 registration', view.registrations.get('rp_card')?.real === true)
}

// 5. 原视图过滤后为空，但 extra 有 ⇒ 仍然交付注入后的视图（不是 fail-open 原视图）
{
  const empty = {
    visible: new Map(),
    registrations: new Map(),
    knownNames: new Set(['pwsh']),
    restrictableNames: new Set(['pwsh']),
  }
  const view = filterView(empty, new Set(['rp_card']), buildExtraTools([rpCard]))
  ok('空视图也注入', view.visible.has('rp_card'), String(view.visible.size))
}

// 6. 同一 extra 对象多次过滤，registration 引用稳定（准入校验依赖它）
{
  const extra = buildExtraTools([rpCard])
  const a = filterView(baseView(), new Set(['rp_card']), extra)
  const b = filterView(baseView(), new Set(['rp_card']), extra)
  ok('registration 引用跨次稳定', a.registrations.get('rp_card') === b.registrations.get('rp_card'))
  ok('visible 值也同一对象', a.visible.get('rp_card') === b.visible.get('rp_card'))
}

// 7. 没有 keep 时原样返回（fail-open 语义不变）
{
  const view = baseView()
  ok('无 keep 原样返回', filterView(view, null, buildExtraTools([rpCard])) === view)
}

console.log('\n' + pass + ' 通过 / ' + fails.length + ' 失败')
if (fails.length) {
  console.log(fails.map((f) => '  - ' + f).join('\n'))
  process.exit(1)
}
console.log('RESULT: PASS ' + pass + '/' + pass)
