/**
 * 扮演通道单测（判定点 + 三条出口 + 配置防漂移）。
 * 跑法：node tests/channel.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bindSessionSource,
  channelTools,
  filterView,
  installChannel,
  installChannelGuard,
  loadChannels,
  patchToolView,
  resetChannelCache,
  resolveChannel,
  resolvePresetOf,
} from '../lib/channel.js'

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
    console.log('  FAIL ' + name + (extra ? ' :: ' + extra : ''))
  }
}

const CHANNELS = {
  presets: {
    roleplay: {
      tools: ['rp_card', 'rp_memory', 'web_search'],
      prompt: { note: '只有这些工具。' },
    },
    standard: { tools: ['rp_card'] },
  },
}

/** 造一个像 ToolsService 的实例：view 在原型上，返回 {visible, registrations, knownNames, restrictableNames}。 */
class FakeTools {
  constructor(names) {
    this.names = names.slice()
    this.guards = []
  }
  view(scope) {
    const visible = new Map()
    const registrations = new Map()
    for (const name of this.names) {
      visible.set(name, { name, description: name })
      registrations.set(name, { definition: { name } })
    }
    return { visible, registrations, knownNames: new Set(this.names), restrictableNames: new Set(this.names) }
  }
  register() {
    return { dispose() {} }
  }
  restrict() {
    throw new Error('restrict 不应再被调用')
  }
  guard(fn) {
    this.guards.push(fn)
    return () => {}
  }
}

const ALL = ['rp_card', 'rp_memory', 'web_search', 'pwsh', 'read', 'write', 'memory', 'run_code']

/* ---------- 1. preset 解析 ---------- */
{
  ok('session.agentPreset 优先', resolvePresetOf({ session: { agentPreset: 'roleplay' } }) === 'roleplay')
  ok('projectionValues 兜底', resolvePresetOf({ session: { projectionValues: { agentPreset: 'roleplay' } } }) === 'roleplay')
  ok('顶层 agentPreset 兜底', resolvePresetOf({ agentPreset: 'roleplay' }) === 'roleplay')
  ok('无 preset 返回空串', resolvePresetOf({}) === '')
  ok('非对象返回空串', resolvePresetOf(null) === '')
  const spy = { get: () => [][0], session: undefined }
  ok('getter 抛错不炸', (() => {
    try {
      return resolvePresetOf(spy) === ''
    } catch {
      return false
    }
  })())
}

/* ---------- 1b. registry 权威优先（2026-11-08 实测纠错） ---------- */
{
  // 会话 header 记的是创建时快照 standard，真正选中的 preset 在 projection（registry 里）
  const fakeCtx = {
    get: (name) => (name === 'agentPresets' ? { presetForSession: () => 'roleplay' } : undefined),
  }
  const bound = bindSessionSource(fakeCtx)
  ok('registry 绑定成功', bound.registry === true)
  ok('registry 值压过 header 快照', resolvePresetOf({ session: { header: { agentPreset: 'standard' } } }) === 'roleplay')
  ok('registry 无会话时 fail-open', resolvePresetOf({}) === '')

  const nullCtx = { get: () => null }
  bindSessionSource(nullCtx)
  ok('无 registry 时回落到字段', resolvePresetOf({ session: { header: { agentPreset: 'standard' } } }) === 'standard')
}

/* ---------- 2. 判定点 ---------- */
{
  const hit = resolveChannel({ session: { agentPreset: 'roleplay' } }, CHANNELS)
  ok('命中 roleplay', hit && hit.preset === 'roleplay')
  ok('未收录 preset 返回 null', resolveChannel({ session: { agentPreset: 'work' } }, CHANNELS) === null)
  ok('无 preset 返回 null', resolveChannel({}, CHANNELS) === null)
  ok('无配置返回 null', resolveChannel({ session: { agentPreset: 'roleplay' } }, null) === null)
  ok('undefined agent 返回 null', resolveChannel(undefined, CHANNELS) === null)

  const keep = channelTools(hit)
  ok('白名单集合含 rp_card', keep.has('rp_card'))
  ok('白名单集合不含 pwsh', !keep.has('pwsh'))
  ok('run_code 强制保留', keep.has('run_code'))
}

/* ---------- 3. view 过滤 ---------- */
{
  const tools = new FakeTools(ALL)
  const raw = tools.view(undefined)
  const filtered = filterView(raw, channelTools({ preset: 'roleplay', cfg: CHANNELS.presets.roleplay }))
  ok('只留白名单 + run_code', [...filtered.visible.keys()].sort().join(',') === 'rp_card,rp_memory,run_code,web_search', [...filtered.visible.keys()].join(','))
  ok('registrations 同步过滤', filtered.registrations.size === filtered.visible.size)
  ok('knownNames 跟随可见集', [...filtered.knownNames].every((n) => filtered.visible.has(n)))
  ok('原 view 未被改写', raw.visible.size === ALL.length)

  const empty = filterView(raw, new Set(['nope']))
  ok('过滤后为空 → fail-open 原样返回', empty === raw)
}

/* ---------- 4. view 补丁（含幂等与 gating） ---------- */
{
  const tools = new FakeTools(ALL)
  const logs = []
  ok('patchToolView 装上', patchToolView(tools, { channels: CHANNELS, log: (l) => logs.push(l) }) === true)
  ok('重复装载返回 false（幂等）', patchToolView(tools, { channels: CHANNELS }) === false)

  const rpHit = tools.view({ session: { agentPreset: 'roleplay' } })
  ok('命中通道：工具面被砍到 4 个', rpHit.visible.size === 4, String(rpHit.visible.size))
  ok('命中通道：pwsh 不可见', !rpHit.visible.has('pwsh'))
  ok('命中通道：rp_card 仍在', rpHit.visible.has('rp_card'))

  const work = tools.view({ session: { agentPreset: 'work' } })
  ok('未命中通道：工具面原样（fail-open）', work.visible.size === ALL.length, String(work.visible.size))

  const global = tools.view(undefined)
  ok('全局视图（scope=undefined）不被过滤', global.visible.size === ALL.length)

  ok('装载日志落了一行', logs.some((l) => l.includes('通道生效')))
}

/* ---------- 5. 执行兜底 guard ---------- */
{
  const tools = new FakeTools(ALL)
  const logs = []
  ok('guard 装上', installChannelGuard(tools, { channels: CHANNELS, log: (l) => logs.push(l) }) === true)
  const guard = tools.guards[0]
  const rpAgent = { session: { agentPreset: 'roleplay' } }
  ok('白名单内放行', guard({ agent: rpAgent, name: 'web_search' }) === undefined)
  const reason = guard({ agent: rpAgent, name: 'pwsh' })
  ok('白名单外拒绝', typeof reason === 'string' && reason.includes('pwsh'), String(reason))
  ok('未命中通道一律放行', guard({ agent: { session: { agentPreset: 'work' } }, name: 'pwsh' }) === undefined)
  ok('无 agent 一律放行', guard({ name: 'pwsh' }) === undefined)
  ok('exec.call.name 兼容', typeof guard({ agent: rpAgent, call: { name: 'bash' } }) === 'string')
  ok('拒绝日志落盘', logs.some((l) => l.includes('[guard] 拒绝')))
}

/* ---------- 6. installChannel 总装（同一 ToolsService 类只会被补一次，原型复用） ---------- */
{
  const tools = new FakeTools(ALL)
  const cfg = { root: path.join(ROOT, 'tests', '.channel-log') }
  const result = installChannel({}, tools, cfg)
  ok('guard 装上', result.guard === true)
  ok('view 过滤生效（原型或实例二者之一）', tools.view({ session: { agentPreset: 'roleplay' } }).visible.size === 4)
  const logFile = path.join(cfg.root, 'channel.log')
  const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
  ok('channel.log 里有 install 行', text.includes('[install] 完成'))
  try {
    fs.rmSync(cfg.root, { recursive: true, force: true })
  } catch {}
}

/* ---------- 7. 配置防漂移 ---------- */
{
  resetChannelCache()
  const channels = loadChannels()
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
  ok('channel.json 可读', !!channels && !!channels.presets)
  const rp = channels && channels.presets ? channels.presets.roleplay : null
  ok('channel.json 有 roleplay 通道', !!rp && Array.isArray(rp.tools))
  const a = [...(rp?.tools || [])].sort().join(',')
  const b = [...(config.allowedTools || [])].sort().join(',')
  ok('channel.json 与 config.allowedTools 一致（防漂移）', a === b, `channel=${a} | config=${b}`)
  ok('每个通道都有 prompt.note', Object.values(channels.presets).every((c) => !c.prompt || typeof c.prompt.note === 'string'))

  // 与 auto-memory 侧的白名单对齐（注入出口与工具出口必须描述同一个世界）
  const rpAllow = path.resolve(ROOT, '..', 'dsh-auto-memory', 'rp-allowlist.json')
  if (fs.existsSync(rpAllow)) {
    const allow = JSON.parse(fs.readFileSync(rpAllow, 'utf8'))
    let same = 0
    let diff = []
    for (const [preset, cfg] of Object.entries(channels.presets)) {
      const other = allow.presets && allow.presets[preset]
      if (!other) continue
      const left = [...(cfg.tools || [])].sort().join(',')
      const right = [...(other.tools || [])].sort().join(',')
      if (left === right) same += 1
      else diff.push(preset)
    }
    ok('同名 preset 的工具清单与 rp-allowlist.json 一致', diff.length === 0, diff.join(',') + ` (一致 ${same} 个)`)
  } else {
    console.log('  skip rp-allowlist.json 不在（跨包一致性跳过）')
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(' - ' + f)
  process.exitCode = 1
}
