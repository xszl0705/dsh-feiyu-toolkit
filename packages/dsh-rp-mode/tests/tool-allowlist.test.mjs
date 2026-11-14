/**
 * dsh-rp-mode 工具白名单单测（preset 减不掉 base 工具，靠 tools.restrict 收窄）。
 * 跑法：node tests/tool-allowlist.test.mjs
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyToolAllowlist, installAgentToolGuard } from '../index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let pass = 0
const fails = []
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log('  ok  ' + name)
  } else {
    fails.push(name + (extra ? ' :: ' + extra : ''))
    fails.length && console.log('  FAIL ' + name + (extra ? ' :: ' + extra : ''))
  }
}

const mkCtx = () => {
  const logs = []
  const effects = []
  return {
    logs,
    effects,
    effect: (fn) => effects.push(fn),
    get: () => undefined,
    // safeLog 走 ctx.log / console，这里拦住
    log: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
    info: (...args) => logs.push(args.join(' ')),
  }
}

const mkTools = (impl) => {
  const calls = []
  return {
    calls,
    register: () => ({ dispose: () => {} }),
    restrict: (filter) => {
      calls.push(filter)
      return impl(filter, calls.length)
    },
  }
}

/* 1. 没有白名单 → 不碰 restrict */
{
  const ctx = mkCtx()
  const tools = mkTools(() => () => {})
  applyToolAllowlist(ctx, tools, {})
  ok('无 allowedTools 时不调 restrict', tools.calls.length === 0)
  ok('无 allowedTools 时不挂 effect', ctx.effects.length === 0)
}

/* 2. 白名单全部是全局工具 → restrict 一次，disposer 挂到 effect */
{
  const ctx = mkCtx()
  let disposed = 0
  const tools = mkTools(() => () => {
    disposed += 1
  })
  applyToolAllowlist(ctx, tools, { allowedTools: ['web_search', 'web_fetch'] })
  ok('restrict 调用一次', tools.calls.length === 1)
  ok('filter 是 allow 形式', JSON.stringify(tools.calls[0]) === '{"allow":["web_search","web_fetch"]}', JSON.stringify(tools.calls[0]))
  ok('挂了一个 effect', ctx.effects.length === 1)
  ctx.effects.forEach((fn) => {
    const d = fn()
    if (typeof d === 'function') d()
  })
  ok('effect dispose 触发 restrict 的 disposer', disposed === 1)
}

/* 3. restrict 点名 scope 内工具（rp_card）→ 剔除后重试 */
{
  const ctx = mkCtx()
  const tools = mkTools((filter, n) => {
    if (n === 1) throw new Error('tools.restrict() names unknown global tool "rp_card"')
    return () => {}
  })
  applyToolAllowlist(ctx, tools, { allowedTools: ['rp_card', 'rp_memory', 'web_search'] })
  ok('第一次抛错后重试一次', tools.calls.length === 2)
  ok('重试时剔除了 rp_card', JSON.stringify(tools.calls[1]) === '{"allow":["rp_memory","web_search"]}', JSON.stringify(tools.calls[1]))
  ok('最终成功挂 effect', ctx.effects.length === 1)
}

/* 4. allow 全被判未知 → 退回 deny */
{
  const ctx = mkCtx()
  const tools = mkTools((filter, n) => {
    if (filter.allow) throw new Error('tools.restrict() names unknown global tool "rp_card"')
    return () => {}
  })
  applyToolAllowlist(ctx, tools, { allowedTools: ['rp_card'], denyTools: ['pwsh', 'read'] })
  ok('allow 失败后走了 deny', tools.calls.length === 2 && !!tools.calls[1].deny)
  ok('deny 名单原样传入', JSON.stringify(tools.calls[1].deny) === '["pwsh","read"]', JSON.stringify(tools.calls[1].deny))
  ok('deny 成功后挂 effect', ctx.effects.length === 1)
}

/* 4b. deny 里也有未知名 → 剔除后重试 */
{
  const ctx = mkCtx()
  const tools = mkTools((filter, n) => {
    if (filter.allow) throw new Error('tools.restrict() names unknown global tool "rp_card"')
    if (n === 2) throw new Error('tools.restrict() names unknown global tool "no_such_tool"')
    return () => {}
  })
  applyToolAllowlist(ctx, tools, { allowedTools: ['rp_card'], denyTools: ['no_such_tool', 'pwsh'] })
  ok('deny 未知名被剔除后成功', tools.calls.length === 3 && JSON.stringify(tools.calls[2].deny) === '["pwsh"]', JSON.stringify(tools.calls[2]))
}

/* 4c. 两条路都失败 → 只 warn */
{
  const ctx = mkCtx()
  const tools = mkTools(() => {
    throw new Error('tools.restrict() requires a scoped context (agent.ctx)')
  })
  let threw = false
  try {
    applyToolAllowlist(ctx, tools, { allowedTools: ['web_search'], denyTools: ['pwsh'] })
  } catch {
    threw = true
  }
  ok('两条路都失败时不抛错', threw === false)
  ok('两条路都失败时不挂 effect', ctx.effects.length === 0)
}

/* 5. restrict 不存在 → warn，不抛 */
{
  const ctx = mkCtx()
  const tools = { register: () => ({}) }
  let threw = false
  try {
    applyToolAllowlist(ctx, tools, { allowedTools: ['web_search'] })
  } catch {
    threw = true
  }
  ok('restrict 缺失时不抛错', threw === false)
  ok('restrict 缺失时不挂 effect', ctx.effects.length === 0)
}

/* 6. 非 scoped ctx 抛错 → 不抛给上游 */
{
  const ctx = mkCtx()
  const tools = mkTools(() => {
    throw new Error('tools.restrict() requires a scoped context (agent.ctx)')
  })
  let threw = false
  try {
    applyToolAllowlist(ctx, tools, { allowedTools: ['web_search'] })
  } catch {
    threw = true
  }
  ok('非 scoped ctx 时报错被吞', threw === false)
  ok('非 scoped ctx 时不挂 effect', ctx.effects.length === 0)
}

/* 7. 空白/非字符串条目被过滤 */
{
  const ctx = mkCtx()
  const tools = mkTools(() => () => {})
  applyToolAllowlist(ctx, tools, { allowedTools: ['  ', '', null, 'web_search'] })
  ok('脏条目被过滤', JSON.stringify(tools.calls[0]) === '{"allow":["web_search"]}', JSON.stringify(tools.calls[0]))
}

/* 8. agent 级守卫：restrict 必须落在 agent.ctx 上 */
{
  const logs = []
  let registered = null
  const effects = []
  const guardPrompt = {
    context: (def) => {
      registered = def
      return () => {}
    },
  }
  const guardCtx = {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    effect: (fn) => effects.push(fn),
    // 现在服务访问走 ctx.get()（软访问，不需要 inject），mock 也要给 get
    get: (n) => (n === 'systemPrompt' ? guardPrompt : null),
    systemPrompt: guardPrompt,
  }
  installAgentToolGuard(guardCtx, { allowedTools: ['web_search'] })
  ok('守卫挂了一个 effect', effects.length === 1)
  // effect 是延迟执行的：跑一次才会真的调 systemPrompt.context
  effects[0]()
  ok('守卫注册了 systemPrompt.context', !!registered)
  ok('守卫的 section 名正确', !!registered && registered.name === 'dsh:rp-mode-tool-guard')

  let restrictCalls = 0
  const agent = {
    ctx: {
      tools: {
        restrict: (f) => {
          restrictCalls += 1
          ok('落点是 agent.ctx.tools', !!f.allow)
          return () => {}
        },
      },
    },
  }
  // 回调返回空串 = 不注入内容
  ok('首帧返回空串', registered.text({ agent }) === '')
  ok('首次见 agent 调了一次 restrict', restrictCalls === 1)
  ok('同一 agent 第二次不重复调', registered.text({ agent }) === '' && restrictCalls === 1)
  ok('没有 agent 时不调', registered.text({}) === '' && restrictCalls === 1)
}

/* 9. agent.ctx 缺失 → 不炸，也不调 restrict */
{
  let registered = null
  const effects = []
  const guardPrompt9 = { context: (def) => ((registered = def), () => {}) }
  const guardCtx = {
    logger: { info() {}, warn() {} },
    effect: (fn) => effects.push(fn),
    get: (n) => (n === 'systemPrompt' ? guardPrompt9 : null),
  }
  installAgentToolGuard(guardCtx, { allowedTools: ['web_search'] })
  effects.forEach((fn) => fn())
  let threw = false
  try {
    registered.text({ agent: { ctx: {} } })
    registered.text({ agent: { ctx: { tools: null } } })
  } catch {
    threw = true
  }
  ok('agent.ctx 无 tools 时不抛错', threw === false && !!registered)
}

/* 10. 没有 systemPrompt.context → 静默不装 */
{
  let threw = false
  try {
    installAgentToolGuard({ effect: () => {} }, { allowedTools: ['web_search'] })
  } catch {
    threw = true
  }
  ok('无 systemPrompt.context 时不抛错', threw === false)
}

/* 11. 白名单单源校验：rp-mode/config.json 与 auto-memory/rp-allowlist.json 必须一致 */
{
  const rpConfig = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''))
  const amFile = path.resolve(ROOT, '..', 'dsh-auto-memory', 'rp-allowlist.json')
  let amList = null
  try {
    amList = JSON.parse(fs.readFileSync(amFile, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    amList = null
  }
  const norm = (arr) => (Array.isArray(arr) ? arr.slice().sort().join(',') : '')
  if (!amList) {
    ok('auto-memory 的白名单文件存在（可选）', true, '未安装则跳过比对')
  } else {
    const a = norm(rpConfig.allowedTools)
    const b = norm(amList.presets && amList.presets.roleplay && amList.presets.roleplay.tools)
    ok('两份白名单一致（防漂移）', a === b, 'rp-mode=' + a.slice(0, 60) + ' / am=' + b.slice(0, 60))
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) process.exit(1)
