/**
 * tools 服务来源选择单测。
 *
 * 背景：roleplay preset 的 isolate realm 里 `ctx.get('tools')` 可能解析到宿主根服务，
 * 工具注册进宿主层后 preset 会话的 view 看不见（实测扮演会话请求头只剩 web 两个工具）。
 * 因此 `pickTools` 必须优先属性访问 `ctx.tools`，再退回 `ctx.get('tools')`。
 *
 * 跑法：node tests/tools-source.test.mjs
 */
import { pickKeeper, pickTools } from '../index.js'

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

const REALM_TOOLS = { register() {}, tag: 'realm' }
const ROOT_TOOLS = { register() {}, tag: 'root' }

// 1. 两个都在：必须选 ctx.tools（realm 绑定）
{
  const ctx = { tools: REALM_TOOLS, get: (n) => (n === 'tools' ? ROOT_TOOLS : undefined) }
  const picked = pickTools(ctx)
  ok('优先 ctx.tools（realm）', picked.tools === REALM_TOOLS, String(picked.tools?.tag))
  ok('来源标记为 ctx.tools', picked.source === 'ctx.tools', picked.source)
}

// 2. 只有根服务：退回 ctx.get
{
  const ctx = { get: (n) => (n === 'tools' ? ROOT_TOOLS : undefined) }
  const picked = pickTools(ctx)
  ok('回退 ctx.get', picked.tools === ROOT_TOOLS, String(picked.tools?.tag))
  ok('来源标记为 ctx.get', picked.source === 'ctx.get', picked.source)
}

// 3. ctx.tools 抛错（服务未就绪）：不炸，退回 ctx.get
{
  const ctx = {
    get tools() {
      throw new Error('service not ready')
    },
    get: (n) => (n === 'tools' ? ROOT_TOOLS : undefined),
  }
  let threw = false
  let picked
  try {
    picked = pickTools(ctx)
  } catch {
    threw = true
  }
  ok('ctx.tools 抛错时不抛出', threw === false)
  ok('抛错后回退 ctx.get', picked?.tools === ROOT_TOOLS)
}

// 4. 两者都没有
{
  const picked = pickTools({})
  ok('无服务时 tools 为空', picked.tools === undefined)
  ok('无服务时来源为 none', picked.source === 'none', picked.source)
}

// 5. 非函数形状（未就绪对象）：不能当成可用服务
{
  const ctx = { tools: {}, get: () => ({}) }
  const picked = pickTools(ctx)
  ok('缺 register 的对象不算可用', picked.tools === undefined)
}

// 6. 差异化：多路注册里只留真正打进 global 的那一路（0.6.7）
{
  ok(
    '第一路没打进 global → 留第二路',
    pickKeeper([
      { source: 'ctx.tools', before: false, after: false },
      { source: 'ctx.root.tools', before: false, after: true },
    ]) === 'ctx.root.tools',
  )
  ok(
    '第一路命中就留第一路（后面的不再争）',
    pickKeeper([
      { source: 'ctx.tools', before: false, after: true },
      { source: 'ctx.root.tools', before: true, after: true },
    ]) === 'ctx.tools',
  )
  ok(
    '一路都没命中 → 空串（调用方保留全部，不许删）',
    pickKeeper([
      { source: 'ctx.tools', before: false, after: false },
      { source: 'ctx.root.tools', before: false, after: false },
    ]) === '',
  )
  ok('注册前已有 rp_card 不算命中（避免误判）', pickKeeper([{ source: 'ctx.tools', before: true, after: true }]) === '')
  ok('空/脏输入不抛错', pickKeeper([]) === '' && pickKeeper(null) === '' && pickKeeper([null, {}]) === '')
}

console.log('\n' + pass + ' 通过 / ' + fails.length + ' 失败')
if (fails.length) {
  console.log(fails.map((f) => '  - ' + f).join('\n'))
  process.exit(1)
}
console.log('RESULT: PASS ' + pass + '/' + pass)
