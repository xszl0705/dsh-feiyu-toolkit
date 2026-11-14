import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

// 测试用 slim 配置：先关，再开，避免动到真实 slim.json
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'step-saver-'))
const slimFile = path.join(temp, 'slim.json')
process.env.DSH_SLIM_FILE = slimFile

const writeSlim = (obj) => fs.writeFileSync(slimFile, JSON.stringify(obj), 'utf8')

writeSlim({ enabled: false, keep: ['pwsh'], groups: { media: ['draw'] } })

const slim = await import(pathToFileURL(path.join(ROOT, 'lib/slim.js')).href)
const toolsMod = await import(pathToFileURL(path.join(ROOT, 'lib/tools.js')).href)

slim.resetSlimCache()

test('enabled=false 时 resolveSlim 返回 null（完全放行）', () => {
  writeSlim({ enabled: false, keep: ['pwsh'], groups: {} })
  slim.resetSlimCache()
  assert.equal(slim.resolveSlim({ session: { id: 's1' } }), null)
})

test('enabled=true 且一般模式 preset 为空 ⇒ 命中，keep 含 RESERVED', () => {
  writeSlim({ enabled: true, keep: ['pwsh', 'read'], groups: { media: ['draw'] } })
  slim.resetSlimCache()
  const hit = slim.resolveSlim({ session: { id: 's1' } })
  assert.ok(hit)
  assert.equal(hit.preset, '(default)')
  assert.ok(hit.keep.has('pwsh'))
  assert.ok(hit.keep.has('read'))
  assert.ok(hit.keep.has('run_code'), 'RESERVED 必须始终保留')
})

test('roleplay preset 不归 slim 管（交给它自己的通道）', () => {
  writeSlim({ enabled: true, keep: ['pwsh'], groups: {} })
  slim.resetSlimCache()
  const hit = slim.resolveSlim({ session: { id: 's2', projectionValues: { agentPreset: 'roleplay' } } })
  assert.equal(hit, null)
})

test('unrestricted preset 必须命中（desktop 的真实 preset，白名单制时代空转的根因）', () => {
  writeSlim({ enabled: true, keep: ['pwsh', 'read'], groups: {} })
  slim.resetSlimCache()
  const hit = slim.resolveSlim({ session: { id: 's2b', projectionValues: { agentPreset: 'unrestricted' } } })
  assert.ok(hit, 'unrestricted 属于一般模式，必须瘦身')
  assert.equal(hit.preset, 'unrestricted')
  assert.ok(hit.keep.has('pwsh'))
})

test('excludePresets 可配置：默认放行 redteam，显式空数组时全部瘦身', () => {
  writeSlim({ enabled: true, keep: ['pwsh'], groups: {} })
  slim.resetSlimCache()
  assert.equal(slim.resolveSlim({ session: { id: 's2c', projectionValues: { agentPreset: 'redteam' } } }), null)
  writeSlim({ enabled: true, keep: ['pwsh'], groups: {}, excludePresets: [] })
  slim.resetSlimCache()
  assert.ok(slim.resolveSlim({ session: { id: 's2d', projectionValues: { agentPreset: 'redteam' } } }))
  assert.ok(slim.resolveSlim({ session: { id: 's2e', projectionValues: { agentPreset: 'roleplay' } } }))
  writeSlim({ enabled: true, keep: ['pwsh'], groups: {}, excludePresets: ['custom-mine'] })
  slim.resetSlimCache()
  assert.equal(slim.resolveSlim({ session: { id: 's2f', projectionValues: { agentPreset: 'custom-mine' } } }), null)
  assert.ok(slim.resolveSlim({ session: { id: 's2g', projectionValues: { agentPreset: 'roleplay' } } }), '自定义 excludePresets 覆盖默认值')
})

test('explainSlimMiss 说清未命中原因', () => {
  writeSlim({ enabled: true, keep: ['pwsh'], groups: {} })
  slim.resetSlimCache()
  assert.match(slim.explainSlimMiss({ session: { id: 's2h', projectionValues: { agentPreset: 'roleplay' } } }), /excludePresets/)
  assert.match(slim.explainSlimMiss(undefined), /全局视图/)
  writeSlim({ enabled: false, keep: ['pwsh'], groups: {} })
  slim.resetSlimCache()
  assert.match(slim.explainSlimMiss({ session: { id: 's2i' } }), /enabled=false/)
})

test('scope 不存在时放行（全局视图 fail-open）', () => {
  writeSlim({ enabled: true, keep: ['pwsh'], groups: {} })
  slim.resetSlimCache()
  assert.equal(slim.resolveSlim(undefined), null)
  assert.equal(slim.resolveSlim(null), null)
})

test('白名单为空时放行，不把会话变成零工具', () => {
  writeSlim({ enabled: true, keep: [], groups: {} })
  slim.resetSlimCache()
  assert.equal(slim.resolveSlim({ session: { id: 's3' } }), null)
})

test('配置文件缺失时 loadSlim 返回 null，resolveSlim 放行', () => {
  process.env.DSH_SLIM_FILE = path.join(temp, 'nope.json')
  slim.resetSlimCache()
  assert.equal(slim.loadSlim(path.join(temp, 'nope.json')), null)
  assert.equal(slim.resolveSlim({ session: { id: 's4' } }), null)
  process.env.DSH_SLIM_FILE = slimFile
  slim.resetSlimCache()
})

test('filterView 只留白名单内的工具，且过滤后为空时返回原 view', () => {
  const view = {
    visible: new Map([
      ['pwsh', { name: 'pwsh' }],
      ['draw', { name: 'draw' }],
      ['workflow', { name: 'workflow' }],
    ]),
    registrations: new Map([['pwsh', { plugin: 'x' }]]),
    restrictableNames: new Set(['pwsh']),
  }
  const filtered = slim.filterView(view, new Set(['pwsh', 'draw']))
  assert.deepEqual([...filtered.visible.keys()], ['pwsh', 'draw'])
  assert.ok(filtered.registrations.get('pwsh'))
  assert.equal(filtered.restrictableNames, view.restrictableNames)
  const empty = slim.filterView(view, new Set(['nope']))
  assert.equal(empty, view, '过滤空了要 fail-open')
})

test('会话挂载：effectiveKeep 合并 keep 与 extra，clearSession 清空', () => {
  const hit = { keep: new Set(['pwsh']), groups: {} }
  slim.addToSession('sess-a', ['draw', 'comfy'])
  const merged = slim.effectiveKeep(hit, 'sess-a')
  assert.ok(merged.has('pwsh'))
  assert.ok(merged.has('draw'))
  assert.ok(merged.has('comfy'))
  assert.ok(!slim.effectiveKeep(hit, 'sess-b').has('draw'), '别的会话不该被影响')
  slim.clearSession('sess-a')
  assert.ok(!slim.effectiveKeep(hit, 'sess-a').has('draw'))
})

test('toolbox 挂载与执行兜底同源：宿主的 exec 没有 session 字段也要挂上（2026-11-10 报错回归）', () => {
  writeSlim({ enabled: true, keep: ['pwsh', 'toolbox'], groups: { rp: ['rp_card', 'rp_memory'], media: ['draw'] } })
  slim.resetSlimCache()
  // 宿主 ToolExecution = { name, arguments, agent, parent, toolSet, schema }，会话 id 只在 agent.session.id
  const agent = { preset: 'standard', id: 'agent-1', session: { id: 'sess-real' } }
  const exec = { name: 'toolbox', arguments: { show: 'rp' }, agent }
  const mounted = toolsMod.toolboxTool({ show: 'rp' }, exec)
  assert.equal(mounted.ok, true)
  assert.ok(mounted.mounted.includes('rp_card'))

  const hit = { keep: new Set(['pwsh', 'toolbox']), groups: {} }
  const keep = slim.effectiveKeepOf(hit, { name: 'rp_card', arguments: {}, agent })
  assert.ok(keep.has('rp_card'), '挂载后同一会话的 rp_card 必须放行')
  assert.ok(keep.has('pwsh'), '原有 keep 不能丢')

  // 别的会话不受影响（不能退化成全局放行）
  const other = { name: 'rp_card', arguments: {}, agent: { preset: 'standard', id: 'agent-2', session: { id: 'sess-other' } } }
  assert.ok(!slim.effectiveKeepOf(hit, other).has('rp_card'))
})

test('exec 上完全没有会话键时才退回 _global 兜底', () => {
  const hit = { keep: new Set(['pwsh']), groups: {} }
  toolsMod.toolboxTool({ show: 'media' }, { name: 'toolbox', arguments: {} })
  assert.ok(slim.effectiveKeepOf(hit, { name: 'draw', arguments: {} }).has('draw'))
  slim.clearSession('_global')
  assert.ok(!slim.effectiveKeepOf(hit, { name: 'draw', arguments: {} }).has('draw'))
})

test('file_outline 给出函数骨架而不是整文件', () => {
  const result = toolsMod.fileOutlineTool({ path: path.join(ROOT, 'lib/slim.js') })
  assert.equal(result.ok, true)
  const names = result.items.map((item) => item.name)
  assert.ok(names.includes('resolveSlim'), '应解析出 resolveSlim')
  assert.ok(names.includes('filterView'), '应解析出 filterView')
  assert.ok(names.includes('installSlim'), '应解析出 installSlim')
  assert.ok(result.text.length < 4000, '骨架文本应远小于整文件')
  // 回归：for / if / while 这类块关键字不能被当成方法名（v0.1.0 首版踩过）
  for (const bad of ['for', 'if', 'while', 'switch', 'catch', 'return']) {
    assert.ok(!names.includes(bad), `不应把 ${bad} 当成方法/函数名`)
  }
})

test('file_outline 对纯数据文件降级为前 20 行 + 总行数', () => {
  const jsonFile = path.join(temp, 'data.json')
  fs.writeFileSync(jsonFile, JSON.stringify({ a: 1 }, null, 2), 'utf8')
  const result = toolsMod.fileOutlineTool({ path: jsonFile })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'raw')
  assert.match(result.text, /共 \d+ 行/)
})

test('file_outline 对不存在的文件返回错误而不是抛错', () => {
  const result = toolsMod.fileOutlineTool({ path: path.join(temp, 'no-such-file.js') })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /不存在/)
})

test('ls_tree 列出目录且跳过 node_modules', () => {
  const result = toolsMod.lsTreeTool({ path: ROOT, depth: 1 })
  assert.equal(result.ok, true)
  assert.match(result.text, /lib/)
  assert.match(result.text, /index\.js/)
  assert.doesNotMatch(result.text, /node_modules/)
})

test('smart_grep 命中附 owner（所属函数/标题）', () => {
  const result = toolsMod.smartGrepTool({ pattern: 'export function installSlim', path: path.join(ROOT, 'lib/slim.js') })
  assert.equal(result.ok, true)
  assert.ok(result.hits >= 1)
  assert.match(result.text, /slim\.js:\d+/)
  assert.match(result.text, /owner|\[installSlim/) // owner 列存在即视为带上下文
})

test('smart_grep 非法正则退化为纯文本搜索，不抛错', () => {
  const result = toolsMod.smartGrepTool({ pattern: 'installSlim(', path: path.join(ROOT, 'lib') })
  assert.equal(result.ok, true)
})

test('toolbox：slim 未启用时说明不需要挂载', () => {
  writeSlim({ enabled: false, keep: ['pwsh'], groups: { media: ['draw'] } })
  slim.resetSlimCache()
  const result = toolsMod.toolboxTool({})
  assert.equal(result.enabled, false)
  assert.match(result.text, /未启用/)
})

test('toolbox：列分组、挂载组、未知组报错', () => {
  writeSlim({ enabled: true, keep: ['pwsh'], groups: { media: ['draw', 'comfy'], fin: ['fin_quote'] } })
  slim.resetSlimCache()
  const listed = toolsMod.toolboxTool({})
  assert.deepEqual(listed.groups, ['media', 'fin'])
  const mounted = toolsMod.toolboxTool({ show: 'media' }, { session: { id: 'sess-t' } })
  assert.equal(mounted.ok, true)
  assert.deepEqual(mounted.mounted, ['draw', 'comfy'])
  const unknown = toolsMod.toolboxTool({ show: 'nope' }, { session: { id: 'sess-t' } })
  assert.equal(unknown.ok, false)
})

test('五个工具都有完整定义（name / parameters / output / execute）', () => {
  const defs = toolsMod.createStepSaverTools()
  assert.equal(defs.length, 5)
  for (const def of defs) {
    assert.ok(def.name, '缺 name')
    assert.equal(typeof def.description, 'string')
    assert.equal(typeof def.execute, 'function')
    assert.ok(def.parameters && def.parameters.type === 'object')
    assert.ok(def.output && def.output.schema && typeof def.output.render === 'function')
    assert.equal(typeof def.timeoutMs, 'number')
  }
  assert.deepEqual(defs.map((d) => d.name), ['run_node', 'ls_tree', 'file_outline', 'smart_grep', 'toolbox'])
})

test('installSlimAgentHook：没有 systemPrompt.context 时安全返回 false，不抛错', () => {
  const fakeCtx = { get: () => undefined, effect: (fn) => fn() }
  assert.equal(slim.installSlimAgentHook(fakeCtx, {}), false)
})

test('installSlimAgentHook：钩子拿到 agent 后对其 agent.ctx.tools 打补丁，且每个 agent 只打一次', () => {
  writeSlim({ enabled: true, keep: ['pwsh'], groups: {} })
  slim.resetSlimCache()
  let hookOptions = null
  let effectCalls = 0
  const fakeCtx = {
    get: (name) => (name === 'systemPrompt' ? { context: (opts) => ((hookOptions = opts), () => {}) } : undefined),
    effect: (fn) => {
      effectCalls += 1
      fn()
    },
  }
  assert.equal(slim.installSlimAgentHook(fakeCtx, {}), true)
  assert.ok(hookOptions, '应注册 systemPrompt.context 钩子')
  assert.equal(effectCalls, 1)
  assert.equal(hookOptions.text({ agent: null }), '', '无 agent 时返回空串')

  const view = {
    visible: new Map([
      ['pwsh', { name: 'pwsh' }],
      ['comfy', { name: 'comfy' }],
    ]),
    registrations: new Map(),
    restrictableNames: new Set(),
  }
  const tools = { view: () => view }
  const agent = { ctx: { tools }, session: { id: 'agent-1' } }
  assert.equal(hookOptions.text({ agent }), '')
  const filtered = tools.view(agent)
  assert.deepEqual([...filtered.visible.keys()], ['pwsh'], 'agent 级视图应被收窄')
  // 再次触发同一个 agent：不应重复打补丁（WeakSet 生效）
  assert.equal(hookOptions.text({ agent }), '')
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
