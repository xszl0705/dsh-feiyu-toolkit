/**
 * 扮演通道（channel）—— 单一判定点 + 三条出口 + 单一日志。
 *
 * 为什么需要它：preset 只能「加插件」，减不掉 base bundle 里的工具。实测扮演会话
 * 仍是 69 个工具定义（bash / pwsh / fs / skill / todo / goal / subagent / memory …）。
 *
 * 三条老路都试过，都不通（结论绑在 dsh-tools 源码位置上，见 docs/rp-mode-channel.md）：
 *   A. `tools.restrict({allow})`：`known = view(scope).restrictableNames` 只含
 *      **全局层 + 祖先链**，且 scope 自身注册的工具不受 restriction 影响
 *      （dsh-tools/lib/index.js:464-467、:497-501）。base 工具随 agent 挂载，
 *      落在 agent 自己的层 ⇒ restrict 永远看不到它们，实测 deny 66 个名字只有
 *      qq / sticker 两个 host 平面工具被认出来（toolguard.log）。
 *   B. `systemPrompt.context()` 回调里取 agent：真实宿主里 rp-mode 的这次注册
 *      从未触发（toolguard.log 13:23 那段只有 [standing]，没有 [agent] 守卫安装行）。
 *   C. `system-prompt/assemble` 瀑布里改 assembly.tools：**改不动**，assemble 最后
 *      强制用本地 tools 覆盖瀑布结果（dsh-system-prompt/lib/index.js:401-405）。
 *
 * 真正唯一的汇聚点：`ToolsService.view(scope)`。描述、schema、`definitions()`、
 * `executable()`、`resolve()`（每步准入）、`get()` 全部走它
 * （dsh-tools/lib/index.js:477-534、:579-591）。所以本模块把 view 包一层：
 * 命中通道就按白名单过滤 visible / registrations，一处改动同时覆盖
 * 「模型看到的工具面」与「执行期可解析的工具」。
 *
 * 设计纪律：
 *   1. **单一判定点**：只有 `resolveChannel(agent)` 一个函数下结论。
 *   2. **三条出口**：工具（view 过滤 + guard 兜底）、提示词（prompt.note）、
 *      注入（auto-memory 侧 rp-channel 读同一份 presets 配置）。
 *   3. **单一日志**：`~/.dsh/rp-memory/channel.log`，每行带出口标签。
 *   4. **fail-open**：拿不到 preset、配置缺失、过滤后为空 ⇒ 一律放行原工具面。
 *      宁可不省，也不能让一个会话没有工具。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '..')
export const CHANNEL_FILE = path.join(PKG_ROOT, 'channel.json')

/** PTC 传输工具受宿主保护，任何情况下都不进过滤（缺了会触发「全部 deferred」400）。 */
const RESERVED = new Set(['run_code'])

const cache = { file: '', mtimeMs: -1, data: null }

export function channelLogPath(config = {}) {
  const root = (config && config.root) || path.join(process.env.USERPROFILE || process.env.HOME || PKG_ROOT, '.dsh', 'rp-memory')
  return path.join(root, 'channel.log')
}

/** 写一行通道日志。永不抛错——诊断不能反过来打断扮演。 */
export function channelLog(line, config = {}) {
  try {
    const file = channelLogPath(config)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch {
    // 写不进去不影响功能
  }
}

/**
 * 读通道配置（mtime 缓存，热路径零 IO）。
 * @param {string} [file] 覆盖路径，测试用
 * @returns {{presets?: Record<string, any>}|null}
 */
export function loadChannels(file = process.env.DSH_RP_CHANNEL || CHANNEL_FILE) {
  try {
    const stat = fs.statSync(file)
    if (cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.data) return cache.data
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    cache.file = file
    cache.mtimeMs = stat.mtimeMs
    cache.data = data && typeof data === 'object' ? data : null
    return cache.data
  } catch {
    return null
  }
}

/** 测试/热重载用：丢掉缓存。 */
export function resetChannelCache() {
  cache.file = ''
  cache.mtimeMs = -1
  cache.data = null
}

/* ============================ 判定点 ============================ */

let sessionSource = null
let presetRegistry = null
let ctxRef = null

/**
 * 绑定宿主判定源。
 *
 * ★ 2026-11-08 21:5x 实测纠错：`session.header.agentPreset` 是**会话创建时的快照**，
 *   用户在建会话时选「扮演模式」并不会改它 —— 会话文件 header 里写的是 `standard`，
 *   而 projection 存储（`storages/session_projcache/sessions/*.json`）里同一个会话是
 *   `roleplay`（由 `agent-preset/selected` 事件写进 projection）。
 *   读 header ⇒ 永远 standard ⇒ 通道永不命中。权威来源是 registry 的 `presetForSession(session)`。
 *
 * @param ctx rp-mode 的宿主平面 ctx（本包在 bundles 里，启动即 apply）
 * @returns {{registry: boolean, sessions: boolean}}
 */
export function bindSessionSource(ctx) {
  ctxRef = ctx || null
  let registry = false
  let sessions = false
  try {
    const reg = ctx && typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
    if (reg && typeof reg.presetForSession === 'function') {
      presetRegistry = reg
      registry = true
    } else presetRegistry = null
  } catch {
    presetRegistry = null
  }
  try {
    const sessionsService = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
    if (sessionsService && sessionsService.list && typeof sessionsService.list.getSnapshot === 'function') {
      sessionSource = () => sessionsService.list.getSnapshot()
      sessions = true
    } else sessionSource = null
  } catch {
    sessionSource = null
  }
  return { registry, sessions }
}

/** 懒重绑：apply 时 registry 可能还没就绪。 */
function ensureRegistry() {
  if (presetRegistry || !ctxRef) return presetRegistry
  try {
    const reg = typeof ctxRef.get === 'function' ? ctxRef.get('agentPresets') : null
    if (reg && typeof reg.presetForSession === 'function') presetRegistry = reg
  } catch {
    // 拿不到就继续用后面的兜底来源
  }
  return presetRegistry
}

function safeGet(obj, keys) {
  try {
    let cur = obj
    for (const key of keys) {
      if (cur === null || cur === undefined) return undefined
      cur = cur[key]
    }
    return cur
  } catch {
    return undefined
  }
}

/** 首选：registry 记录的会话 preset（唯一权威）。 */
function presetFromRegistry(agent) {
  const reg = ensureRegistry()
  if (!reg) return ''
  const session = safeGet(agent, ['session'])
  if (!session) return ''
  try {
    const value = reg.presetForSession(session)
    return typeof value === 'string' && value.trim() ? value.trim() : ''
  } catch {
    return ''
  }
}

function presetFromSessions(agent) {
  if (typeof sessionSource !== 'function') return ''
  try {
    const snapshot = sessionSource()
    if (!snapshot || !snapshot.byId) return ''
    const sid = String(safeGet(agent, ['session', 'id']) || safeGet(agent, ['session', 'sessionId']) || '')
    if (!sid || !snapshot.byId[sid]) return ''
    const row = snapshot.byId[sid]
    const direct = safeGet(row, ['projectionValues', 'agentPreset'])
    if (typeof direct === 'string' && direct.trim()) return direct.trim()
    const alt = safeGet(row, ['agentPreset']) || safeGet(row, ['preset'])
    return typeof alt === 'string' ? alt.trim() : ''
  } catch {
    return ''
  }
}

/**
 * 从 agent 解析 preset id。顺序即优先级：
 *   1. registry.presetForSession(session) —— 权威，跟随 `agent-preset/selected` 事件
 *   2. agent.session 上的 projection 值
 *   3. sessions 快照（只认本会话 id，**不 fallback 到 current**：串会话会误判）
 *   4. header.agentPreset —— 只是创建时快照，放最后
 * 全落空返回 ''（调用方 fail-open）。
 */
/**
 * preset 解析结果落盘（只记变化）。
 *
 * 2026-11-10 加：channel.log 里出现过 `preset=cordis` —— 兜底链吸到了非 preset 字段。
 * 现在去掉 `agent.preset` 兜底，并把「从哪个字段命中」写进日志，出错时一眼能看出。
 */
let lastPresetNote = ''
function notePreset(from, value) {
  const line = `[preset] ${from} → ${value || '(空)'}`
  if (line === lastPresetNote) return
  lastPresetNote = line
  try {
    channelLog(line)
  } catch {
    // 日志失败不影响判定
  }
}

export function resolvePresetOf(agent) {
  if (!agent || typeof agent !== 'object') return ''
  const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')
  const registry = presetFromRegistry(agent)
  if (registry) return registry
  const candidates = [
    ['session.projection', safeGet(agent, ['session', 'projectionValues', 'agentPreset'])],
    ['sessions 快照', presetFromSessions(agent)],
    ['agent.projection', safeGet(agent, ['projectionValues', 'agentPreset'])],
    ['session.header', safeGet(agent, ['session', 'header', 'agentPreset'])],
    ['session.agentPreset', safeGet(agent, ['session', 'agentPreset'])],
    ['agent.agentPreset', safeGet(agent, ['agentPreset'])],
  ]
  for (const [from, candidate] of candidates) {
    const hit = pick(candidate)
    if (hit) {
      notePreset(from, hit)
      return hit
    }
  }
  notePreset('(全落空)', '')
  return ''
}

/**
 * ★唯一判定点：agent → 通道配置。
 * @param {unknown} agent 组装/执行时带进来的 agent 对象（也可能是 undefined 的全局视图）
 * @param {object} [channels] 覆盖配置，测试用
 * @returns {{preset: string, cfg: {tools?: string[], prompt?: {note?: string}, inject?: any}}|null}
 */
export function resolveChannel(agent, channels = loadChannels()) {
  if (!channels || !channels.presets) return null
  const preset = resolvePresetOf(agent)
  if (!preset) return null
  const cfg = channels.presets[preset]
  if (!cfg || typeof cfg !== 'object') return null
  return { preset, cfg }
}

/** 通道白名单集合（含保留名），非命中返回 null。 */
export function channelTools(hit) {
  if (!hit || !hit.cfg) return null
  const list = Array.isArray(hit.cfg.tools) ? hit.cfg.tools : []
  const set = new Set(RESERVED)
  for (const name of list) if (typeof name === 'string' && name.trim()) set.add(name.trim())
  return set
}

/** 提示词出口：给系统提示词段用的一句话。 */
export function channelPromptNote(hit) {
  if (!hit || !hit.cfg) return ''
  const note = safeGet(hit.cfg, ['prompt', 'note'])
  return typeof note === 'string' && note.trim() ? note.trim() : ''
}

/* ============================ 出口 1：工具面 ============================ */

const PATCHED = Symbol.for('dsh-rp-mode.channel.patched')

/**
/**
 * 把「本包自己注册、但注册的层不在 agent 可见链上」的工具做成可注入的视图补丁。
 *
 * ★2026-11-10 前的坑：`dsh-tools/lib/index.js:477 view(scope)` 里
 *   `own = layers.peek(scope)` —— agent **自己那层**的注册无条件可见，
 *   其它层要靠 scope 链继承。rp-mode 注册在 preset realm 的层，这条链不通，
 *   实测 agent 每步的函数表只剩 `web_fetch / web_search`，`rp_card` 永远发不出去。
 *   所以在这里把它们补进 view 出口，`definitions()` / `schemas()` / `executable()`
 *   全都从 view 派生，一处补全全链生效。
 *
 * registration 必须是**同一个对象实例**（缓存一次）：
 *   `dsh-tools/lib/index.js:568` 用 `current.registrations.get(name) === view.registrations.get(name)`
 *   判断准入，每次新建对象会导致「schema 里有、调用 UNKNOWN_TOOL」。
 *
 * @param {Array} definitions 本包 createTools() 的返回
 * @returns {{visible: Map, registrations: Map}}
 */
export function buildExtraTools(definitions) {
  const visible = new Map()
  const registrations = new Map()
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    if (!definition || !definition.name) continue
    visible.set(definition.name, definition)
    registrations.set(definition.name, { definition, extra: true })
  }
  return { visible, registrations }
}

/**
 * 按白名单过滤一份 view。过滤后为空 ⇒ 返回原 view（fail-open，避免把会话变成零工具）。
 * `extra` 给出时，把白名单允许、原本不可见的工具补进来（见 buildExtraTools）。
 */
export function filterView(view, keep, extra) {
  if (!view || !keep) return view
  const visible = new Map()
  const registrations = new Map()
  for (const [name, definition] of view.visible) {
    if (!keep.has(name)) continue
    visible.set(name, definition)
    const registration = view.registrations && view.registrations.get(name)
    if (registration) registrations.set(name, registration)
  }
  if (extra) {
    for (const [name, definition] of extra.visible) {
      if (!keep.has(name) || visible.has(name)) continue
      visible.set(name, definition)
      const registration = extra.registrations.get(name)
      if (registration) registrations.set(name, registration)
    }
  }
  if (visible.size === 0 && !extra) return view
  return {
    visible,
    registrations,
    knownNames: new Set(visible.keys()),
    restrictableNames: view.restrictableNames,
  }
}

/**
 * 给 ToolsService 的 view 包一层过滤器。
 *
 * 同时补实例与原型：cordis 的 scoped ctx 可能给出 per-scope 的服务视图，
 * 只补实例会漏掉 agent 真正用的那个对象；只补原型在实例自带 own view 时又会被压住。
 * 两处都补，用 Symbol 防重复。
 *
 * 判定点自带 gating（只有 preset 命中才过滤），所以即使补到原型上、
 * 影响到全部 agent，普通会话也不受任何影响。
 *
 * @param {object} tools ToolsService 实例（或同形对象）
 * @param {{log?: (line: string) => void, channels?: object}} [options]
 * @returns {boolean} 是否装上了
 */
export function patchToolView(tools, options = {}) {
  if (!tools || typeof tools.view !== 'function') return false
  const log = typeof options.log === 'function' ? options.log : () => {}
  const channels = options.channels
  const extra = options.extraTools ? buildExtraTools(options.extraTools) : null
  const originalInstance = tools.view
  const proto = Object.getPrototypeOf(tools)
  const originalProto = proto && typeof proto.view === 'function' ? proto.view : null
  if (originalInstance[PATCHED] || (originalProto && originalProto[PATCHED])) return false

  const makeWrapper = (original) =>
    function patchedView(scope) {
      const view = original.call(this, scope)
      try {
        // 按 preset 去重落诊断：能一眼看出「哪些会话走过了 view、各自被判成什么」。
        // 只记首次出现，最多 20 种组合，避免长会话刷爆日志。
        const seen = (patchedView.__rpChannelSeen ||= new Set())
        const preset = resolvePresetOf(scope) || '(空)'
        const sid = String((scope && scope.session && (scope.session.id || scope.session.sessionId)) || '')
        const key = `${scope ? 'obj' : 'undef'}:${preset}`
        if (!seen.has(key) && seen.size < 20) {
          seen.add(key)
          log(`[tools] view 调用 scope=${scope ? 'obj' : 'undefined'} preset=${preset} sid=${sid.slice(0, 8) || '(无)'}`)
        }
        const hit = resolveChannel(scope, channels)
        const keep = channelTools(hit)
        if (!keep) return view
        const filtered = filterView(view, keep, extra)
        if (filtered !== view && !patchedView.__rpChannelLogged && hit) {
          patchedView.__rpChannelLogged = true
          const kept = [...filtered.visible.keys()].filter((n) => n !== 'run_code')
          const dropped = [...view.visible.keys()].filter((n) => !filtered.visible.has(n))
          log(`[tools] 通道生效 preset=${hit.preset} 可见 ${view.visible.size} → ${filtered.visible.size} 个工具`)
          log(`[tools] 保留 [${kept.join(',')}]`)
          log(`[tools] 砍掉 ${dropped.length} 个 [${dropped.slice(0, 16).join(',')}${dropped.length > 16 ? ',…' : ''}]`)
          // 白名单里写了、但当前会话根本看不见的工具 —— 指向「没注册 / 插件没挂载」，
          // 与过滤无关（过滤只做减法，不会凭空砍掉已配置的名字）。
          const missing = [...keep].filter((n) => n !== 'run_code' && !view.visible.has(n))
          if (missing.length) log(`[tools] 白名单里配了但本会话不可见 [${missing.join(',')}]`)
          // 补进来的（本包注册、但注册层不在这个 scope 的链上）
          if (extra) {
            const injected = [...filtered.visible.keys()].filter((n) => extra.visible.has(n) && !view.visible.has(n))
            if (injected.length) log(`[tools] 补进 ${injected.length} 个（注册层不在本 scope 链上）[${injected.join(',')}]`)
          }
        }
        return filtered
      } catch (error) {
        log(`[tools] 过滤抛错（放行原视图）: ${String((error && error.message) || error)}`)
        return view
      }
    }

  const wrapper = makeWrapper(originalInstance)
  wrapper[PATCHED] = true
  try {
    Object.defineProperty(tools, 'view', { value: wrapper, configurable: true, writable: true })
  } catch {
    // 冻结实例：退回只补原型
  }
  if (originalProto && !originalProto[PATCHED]) {
    const protoWrapper = makeWrapper(originalProto)
    protoWrapper[PATCHED] = true
    try {
      Object.defineProperty(proto, 'view', { value: protoWrapper, configurable: true, writable: true })
    } catch {
      // 原型不可改：实例补丁仍然有效
    }
  }
  log('[tools] view 过滤器已装载（实例 + 原型）')
  return true
}

/* ============================ 出口 2：执行兜底 ============================ */

/**
 * 执行期兜底：白名单外的工具直接判死。
 *
 * view 过滤已经覆盖 `executable()`，这一层是保险——防止宿主某条路径直接用
 * 注册表（不经 view）派发调用。guard 自己再判一次通道命中，所以即便注册到了
 * 全局层，也只会对命中通道的 agent 生效。
 */
export function installChannelGuard(tools, options = {}) {
  if (!tools || typeof tools.guard !== 'function') return false
  const log = typeof options.log === 'function' ? options.log : () => {}
  const channels = options.channels
  try {
    tools.guard((exec) => {
      try {
        const hit = resolveChannel(exec && exec.agent, channels)
        if (!hit) return undefined
        const keep = channelTools(hit)
        const name = String((exec && (exec.name || safeGet(exec, ['call', 'name']) || safeGet(exec, ['tool', 'name']))) || '')
        if (!name || keep.has(name)) return undefined
        log(`[guard] 拒绝 preset=${hit.preset} 工具=${name}`)
        return `[扮演通道] ${name} 不在本会话开放的工具面内，改用 ${
          [...keep].filter((n) => n.startsWith('rp_')).join(' / ') || 'rp_card'
        }`
      } catch {
        return undefined
      }
    })
    log('[guard] 执行兜底已装载')
    return true
  } catch (error) {
    log('[guard] 装载失败: ' + String((error && error.message) || error))
    return false
  }
}

/* ============================ 装配入口 ============================ */

/**
 * 三条出口一起装。工具出口失败不影响提示词出口，反之亦然。
 * @returns {{view: boolean, guard: boolean}}
 */
export function installChannel(ctx, tools, config = {}, extraTools = null) {
  const log = (line) => channelLog(line, config)
  let view = false
  let guard = false
  try {
    view = patchToolView(tools, { log, extraTools })
  } catch (error) {
    log('[tools] 装载抛错: ' + String((error && error.message) || error))
  }
  try {
    guard = installChannelGuard(tools, { log })
  } catch (error) {
    log('[guard] 装载抛错: ' + String((error && error.message) || error))
  }
  log(`[install] 完成 view=${view ? 'ok' : 'no'} guard=${guard ? 'ok' : 'no'} 通道=${describeChannels()}`)
  return { view, guard }
}

/** 诊断串：当前配置里有哪些 preset 通道、各开放几个工具。 */
export function describeChannels(channels = loadChannels()) {
  if (!channels || !channels.presets) return 'none'
  return Object.entries(channels.presets)
    .map(([preset, cfg]) => `${preset}(${(cfg && Array.isArray(cfg.tools) ? cfg.tools.length : 0)} 个工具)`)
    .join(' | ')
}
