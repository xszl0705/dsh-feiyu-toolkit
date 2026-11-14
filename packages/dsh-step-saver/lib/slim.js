/**
 * slim 通道 —— 一般模式的工具面瘦身（照 dsh-rp-mode/lib/channel.js 的手法移植）。
 *
 * 背景（实测 7 天 / 11,878 次调用）：
 *   注册工具 72 个，定义合计 14,298 token，**每一步都随系统提示重发**；
 *   其中 22 个 7 天内零调用，白付 4,455 token/步。
 *   扮演模式用同样手法把 69 个收到 19 个，开局步数从 6 降到 3-4。
 *
 * 判定：**排除制**（2026-11-08 实测修正）。
 *   原先是白名单制（只认 preset 为空 / default / general / native），但 desktop profile
 *   的会话用的是自定义 preset `unrestricted`（dsh-purge 骨架），命中不了 → 整条通道空转：
 *   日志 `[slim/agent] 首次见到 agent preset=(未命中) keep=0`，42 个白名单外工具照样可调。
 *   所以反过来：**默认全部瘦身，只有明确归别的通道管的 preset 才放行**。
 *   · preset 命中 `excludePresets`（默认 roleplay / roleplay-web / roleplay-gm / redteam）⇒ 放行
 *   · 其余 preset（含空 / default / unrestricted / 任何新建自定义）⇒ 命中 slim
 *   · scope 不存在（全局视图）、配置缺失、白名单为空 ⇒ 放行（fail-open）
 *
 * 单一判定点：`resolveSlim(scope)`。所有出口（view 过滤 / toolbox 挂载 / 提示词）都问它。
 */
import { currentPreset, bindCurrentPresetContext } from './current-preset.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = path.resolve(HERE, '..')
export const SLIM_FILE = process.env.DSH_SLIM_FILE || path.join(PKG_ROOT, 'slim.json')

/** 受宿主保护、任何情况下都不进过滤的工具（缺了会触发「全部 deferred」400）。 */
const RESERVED = new Set(['run_code'])

/**
 * 归别的通道 / 专用 preset 自己管的 preset 名，slim 一律放行。
 * slim.json 里给了 `excludePresets` 数组就以它为准（空数组 = 谁也不排除）。
 */
export const DEFAULT_EXCLUDE_PRESETS = ['roleplay', 'roleplay-web', 'roleplay-gm', 'redteam']

/** 旧白名单制的 preset 集合：0.1.1 起不再参与判定，只为兼容外部引用保留。 */
export const GENERAL_PRESETS = new Set(['', 'default', 'general', 'native'])

const cache = { file: '', mtimeMs: -1, data: null }

export function slimLogPath(config = {}) {
  const root = (config && config.root) || path.join(process.env.USERPROFILE || process.env.HOME || PKG_ROOT, '.dsh', 'step-saver')
  return path.join(root, 'slim.log')
}

export function slimLog(line, config = {}) {
  try {
    const file = slimLogPath(config)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch {
    // 诊断不能反过来打断会话
  }
}

/** 读 slim.json（按 mtime 缓存，改完重启即生效）。 */
export function loadSlim(file = SLIM_FILE) {
  try {
    const stat = fs.statSync(file)
    if (cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.data) return cache.data
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    cache.file = file
    cache.mtimeMs = stat.mtimeMs
    cache.data = data
    return data
  } catch {
    return null
  }
}

export function resetSlimCache() {
  cache.file = ''
  cache.mtimeMs = -1
  cache.data = null
}

const safeGet = (obj, keys) => {
  let cur = obj
  for (const key of keys) {
    if (cur == null) return undefined
    cur = cur[key]
  }
  return cur
}

/** agent / scope → preset 名（空串表示没设 preset）。 */
export function resolvePresetOf(agent) { return currentPreset(agent) }

/** 放行的 preset 集合（小写比较）。slim.json 显式给了 excludePresets 就听它的。 */
export function resolveExcludePresets(slim = loadSlim()) {
  const raw = slim && Array.isArray(slim.excludePresets) ? slim.excludePresets : DEFAULT_EXCLUDE_PRESETS
  const set = new Set()
  for (const name of raw) {
    if (typeof name === 'string' && name.trim()) set.add(name.trim().toLowerCase())
  }
  return set
}

/** ★唯一判定点：scope → slim 是否命中 + 白名单。 */
export function resolveSlim(scope, slim = loadSlim()) {
  if (!slim || !scope || typeof scope !== 'object') return null
  const preset = resolvePresetOf(scope)
  const policy = slim.presetPolicies?.[preset.toLowerCase()]
  if (policy?.strict === true && Array.isArray(policy.keep)) {
    return { preset, strict: true, keep: new Set([...RESERVED, ...policy.keep]), groups: {} }
  }
  if (slim.enabled !== true) return null
  const key = preset.toLowerCase()
  if (key && resolveExcludePresets(slim).has(key)) return null
  const keep = Array.isArray(slim.keep) ? slim.keep.filter((n) => typeof n === 'string' && n.trim()) : []
  if (!keep.length) return null
  const set = new Set(RESERVED)
  for (const name of keep) set.add(name.trim())
  return { preset: preset || '(default)', keep: set, groups: slim.groups || {} }
}

/** 未命中原因（只用于日志，不参与判定）。 */
export function explainSlimMiss(scope, slim = loadSlim()) {
  if (!slim || slim.enabled !== true) return 'enabled=false'
  if (!scope || typeof scope !== 'object') return 'scope 不存在（全局视图）'
  const preset = resolvePresetOf(scope)
  if (preset && resolveExcludePresets(slim).has(preset.toLowerCase())) return `preset=${preset} 在 excludePresets 里`
  const keep = Array.isArray(slim.keep) ? slim.keep.filter((n) => typeof n === 'string' && n.trim()) : []
  if (!keep.length) return '白名单为空'
  return '未命中'
}

/* --------------------------- 会话级 toolbox 挂载 --------------------------- */

const sessionExtra = new Map()

export function sessionIdOf(scope) {
  try {
    const id = safeGet(scope, ['session', 'id']) || safeGet(scope, ['session', 'sessionId']) || safeGet(scope, ['id'])
    return id ? String(id) : ''
  } catch {
    return ''
  }
}

/**
 * 一个 exec / scope 对应的**全部**会话键（去重、只留非空字符串）。
 *
 * 2026-11-10 修：宿主 `ToolExecution` 只有 `{ name, arguments, agent, parent, toolSet, schema }`
 * （见 dsh-tools/lib/types/pipeline.js 的字段注释），**没有 session 字段**；
 * 会话 id 只在 `exec.agent.session.id` 上。旧代码 toolbox 侧用 `sessionIdOf(exec)`
 * （拿到 ''，落到 '_global'）、执行兜底用 `sessionIdOf(exec.agent)`（拿到真 session id），
 * 两边键不一致 → `toolbox(show="rp")` 回报「已挂载」，下一次调用照样被兜底拒绝。
 * 现在两侧都走 scopeKeys，且读写取并集，任一键重合即生效。
 */
export function scopeKeys(...sources) {
  const out = []
  const push = (v) => {
    if (typeof v !== 'string' || !v.trim()) return
    const name = v.trim()
    if (name && !out.includes(name)) out.push(name)
  }
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue
    try {
      for (const path of [
        ['agent', 'session', 'id'],
        ['agent', 'session', 'sessionId'],
        ['agent', 'sessionId'],
        ['session', 'id'],
        ['session', 'sessionId'],
        ['sessionId'],
        ['id'],
        ['agent', 'id'],
      ]) {
        const value = safeGet(src, path)
        if (typeof value === 'string') push(value)
      }
    } catch {
      // 单个键取不到不影响其他键
    }
  }
  return out
}

/** exec 视角的会话键（toolbox 与执行兜底共用，保证同源）。 */
export function execScopeKeys(exec) {
  if (!exec || typeof exec !== 'object') return []
  const context = safeGet(exec, ['context'])
  const keys = scopeKeys(exec, context)
  return keys.length ? keys : []
}

/** 把一组工具名挂进某个会话（不落盘；重开会话恢复默认）。 */
export function addToSession(sid, names) {
  const key = String(sid || '_global')
  const set = sessionExtra.get(key) || new Set()
  for (const name of names) if (name) set.add(String(name))
  sessionExtra.set(key, set)
  return [...set]
}

/**
 * 按 exec 把工具挂进它所属的会话：**每个会话键都写一份**。
 * 返回实际写入的键，供日志核对（键集合是排查挂载失效的唯一抓手）。
 */
export function addToScope(exec, names) {
  const keys = execScopeKeys(exec)
  const targets = keys.length ? keys : ['_global']
  for (const key of targets) addToSession(key, names)
  return targets
}

/** exec 可见的会话级挂载（所有键的并集；一个键都解析不到时才退回 '_global'）。 */
export function scopeExtraOf(exec) {
  const out = new Set()
  const keys = execScopeKeys(exec)
  if (!keys.length) {
    for (const name of sessionExtraOf('_global')) out.add(name)
    return out
  }
  for (const key of keys) {
    for (const name of sessionExtraOf(key)) out.add(name)
  }
  return out
}

/** exec 视角真正可见的集合（keep ∪ 会话挂载 ∪ 全局兜底挂载）。 */
export function effectiveKeepOf(hit, exec) {
  const set = new Set(hit.keep)
  if (hit.strict) return set
  for (const name of scopeExtraOf(exec)) set.add(name)
  return set
}

export function sessionExtraOf(sid) {
  return sessionExtra.get(String(sid || '_global')) || new Set()
}

export function clearSession(sid) {
  sessionExtra.delete(String(sid || '_global'))
}

/** 某个会话当前真正可见的集合（keep ∪ 会话挂载）。 */
export function effectiveKeep(hit, sid) {
  const set = new Set(hit.keep)
  if (hit.strict) return set
  for (const name of sessionExtraOf(sid)) set.add(name)
  return set
}

/* ------------------------------- view 过滤 ------------------------------- */

const PATCHED = Symbol.for('dsh-step-saver.slim.patched')

export function filterView(view, keep, strict = false) {
  if (!view || !keep) return view
  const visible = new Map()
  const registrations = new Map()
  for (const [name, definition] of view.visible) {
    if (!keep.has(name)) continue
    visible.set(name, definition)
    const registration = view.registrations && view.registrations.get(name)
    if (registration) registrations.set(name, registration)
  }
  if (visible.size === 0 && !strict) return view
  return {
    visible,
    registrations,
    knownNames: new Set(visible.keys()),
    restrictableNames: view.restrictableNames,
  }
}

/**
 * 给 ToolsService 的 view 包一层过滤器（实例 + 原型都补，Symbol 防重复）。
 * 判定点自带 gating，所以补到原型上也不会影响别的 preset 会话。
 */
export function patchSlimView(tools, options = {}) {
  if (!tools || typeof tools.view !== 'function') return false
  const log = typeof options.log === 'function' ? options.log : () => {}
  const originalInstance = tools.view
  const proto = Object.getPrototypeOf(tools)
  const originalProto = proto && typeof proto.view === 'function' ? proto.view : null
  if (originalInstance[PATCHED] || (originalProto && originalProto[PATCHED])) return false

  const makeWrapper = (original) =>
    function patchedView(scope) {
      const view = original.call(this, scope)
      try {
        const hit = resolveSlim(scope, options.slim || loadSlim())
        if (!hit) return view
        const keys = scopeKeys(scope)
        const keep = keys.length ? effectiveKeepOf(hit, scope) : effectiveKeep(hit, '')
        const filtered = filterView(view, keep, hit.strict === true)
        if (filtered !== view && !patchedView.__dshStepSaverLogged) {
          patchedView.__dshStepSaverLogged = true
          const kept = [...filtered.visible.keys()]
          const dropped = [...view.visible.keys()].filter((n) => !filtered.visible.has(n))
          log(`[slim] 生效 preset=${hit.preset} 可见 ${view.visible.size} → ${filtered.visible.size}`)
          log(`[slim] 保留 [${kept.join(',')}]`)
          log(`[slim] 收起 ${dropped.length} 个 [${dropped.slice(0, 20).join(',')}${dropped.length > 20 ? ',…' : ''}]`)
          const missing = [...hit.keep].filter((n) => n !== 'run_code' && !view.visible.has(n))
          if (missing.length) log(`[slim] 白名单配了但本会话不可见 [${missing.join(',')}]`)
        }
        return filtered
      } catch (error) {
        log(`[slim] 过滤抛错（放行原视图）: ${String((error && error.message) || error)}`)
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
  log('[slim] view 过滤器已装载（实例 + 原型）')
  return true
}

/**
 * 执行期兜底：白名单外 + 未挂载的工具直接判死（防宿主某条路径绕过 view）。
 * 与 view 过滤同源判定，所以不会误伤别的 preset。
 */
export function installSlimGuard(tools, options = {}) {
  if (!tools || typeof tools.guard !== 'function') return false
  const log = typeof options.log === 'function' ? options.log : () => {}
  try {
    tools.guard((exec) => {
      try {
        const agent = exec && (exec.agent || safeGet(exec, ['context', 'agent']))
        const hit = resolveSlim(agent || exec, options.slim || loadSlim())
        if (!hit) return undefined
        // 与 toolbox 同源：都按 exec 的会话键取挂载（旧写法用 sessionIdOf(agent)，
        // 与 toolbox 的 sessionIdOf(exec) 是两条链，挂载永远对不上）。
        const keep = effectiveKeepOf(hit, exec)
        const name = String((exec && (exec.name || safeGet(exec, ['call', 'name']) || safeGet(exec, ['tool', 'name']))) || '')
        if (!name || keep.has(name)) return undefined
        log(`[slim/guard] 拒绝 ${name}（未在当前工具面内）keys=${execScopeKeys(exec).join('|') || '(空)'}`)
        return `[slim] 工具 ${name} 已被收起。用 toolbox(show="组名") 挂回，或用 toolbox() 看分组。`
      } catch {
        return undefined
      }
    })
    log('[slim] 执行兜底已装载')
    return true
  } catch (error) {
    log('[slim] 兜底装载失败: ' + String((error && error.message) || error))
    return false
  }
}

/**
 * agent 级钩子 —— 真正的落点（v0.1.0 踩过的坑）。
 *
 * `ctx.get('tools')` 拿到的是**根服务**，patch 它不会影响宿主实际派发用的那份：
 * 实测 enabled=true、视图过滤器装载 ok，但白名单外的工具（comfy / schedule_list …）
 * 照样能调 —— 因为每个 agent 用的是自己的 `agent.ctx.tools`。
 *
 * 所以走 systemPrompt.context 钩子：每次组装提示词都会把 agent 带进来，
 * 首次见到某个 agent 时就地对它的 `agent.ctx.tools` 打同一份 view 补丁（WeakSet 记一次）。
 * 代价：首轮仍带全量工具，从第二轮起稳定为白名单（与 dsh-rp-mode 的已知行为一致）。
 */
export function installSlimAgentHook(ctx, config = {}) {
  const log = (line) => slimLog(line, config)
  let prompt = null
  try {
    prompt = ctx && typeof ctx.get === 'function' ? ctx.get('systemPrompt') : null
  } catch {
    prompt = null
  }
  if (!prompt || typeof prompt.context !== 'function' || typeof ctx.effect !== 'function') {
    log('[slim/agent] systemPrompt.context 不可用，agent 级钩子未安装（工具面不会收窄）')
    return false
  }
  const seen = new WeakSet()
  const patchFor = (agent) => {
    if (!agent || typeof agent !== 'object' || seen.has(agent)) return
    seen.add(agent)
    const actx = agent.ctx
    let tools = actx && actx.tools
    if (!tools && actx && typeof actx.get === 'function') {
      try {
        tools = actx.get('tools')
      } catch {
        tools = null
      }
    }
    const slim = config.slim || loadSlim()
    const presetName = resolvePresetOf(agent)
    const hit = resolveSlim(agent, slim)
    const why = hit ? `命中 keep=${hit.keep.size}` : `放行（${explainSlimMiss(agent, slim)}）`
    log(`[slim/agent] 首次见到 agent tools=${tools ? 'ok' : 'missing'} preset=${presetName || '(空)'} ${why}`)
    // 没命中也要 patch：命中与否由 wrapper 内部按 scope 判定，这样后续同一 agent 换 preset 也能收回
    if (tools) patchSlimView(tools, { log, slim: config.slim })
  }
  try {
    ctx.effect(
      () =>
        prompt.context({
          name: 'dsh:step-saver-slim',
          order: 61,
          text: (context) => {
            try {
              patchFor(context && context.agent)
            } catch (error) {
              log('[slim/agent] 钩子抛错: ' + String((error && error.message) || error))
            }
            return ''
          },
        }),
      'step-saver.slimAgentHook()',
    )
    log('[slim/agent] agent 级钩子已安装')
    return true
  } catch (error) {
    log('[slim/agent] 安装失败: ' + String((error && error.message) || error))
    return false
  }
}

/** 装配入口：view + guard + agent 钩子。任一失败不影响另一个。 */
export function installSlim(ctx, tools, config = {}) {
  ctx.effect(() => bindCurrentPresetContext(ctx), 'slim.currentPreset')
  const log = (line) => slimLog(line, config)
  let view = false
  let guard = false
  try {
    view = patchSlimView(tools, { log })
  } catch (error) {
    log('[slim] 装载抛错: ' + String((error && error.message) || error))
  }
  try {
    guard = installSlimGuard(tools, { log })
  } catch (error) {
    log('[slim] 兜底抛错: ' + String((error && error.message) || error))
  }
  let agentHook = false
  try {
    agentHook = installSlimAgentHook(ctx, config)
  } catch (error) {
    log('[slim] agent 钩子装载抛错: ' + String((error && error.message) || error))
  }
  const slim = loadSlim()
  log(`[slim/install] view=${view ? 'ok' : 'no'} guard=${guard ? 'ok' : 'no'} agentHook=${agentHook ? 'ok' : 'no'} enabled=${slim && slim.enabled === true} keep=${slim && Array.isArray(slim.keep) ? slim.keep.length : 0}`)
  return { view, guard, agentHook }
}

export function describeSlim(slim = loadSlim()) {
  if (!slim) return 'none'
  const groups = slim.groups && typeof slim.groups === 'object' ? Object.entries(slim.groups) : []
  const exclude = [...resolveExcludePresets(slim)]
  return `enabled=${slim.enabled === true} keep=${Array.isArray(slim.keep) ? slim.keep.length : 0} 放行preset=${exclude.join('/') || '无'} 组=${groups.map(([k, v]) => `${k}(${Array.isArray(v) ? v.length : 0})`).join('|') || '无'}`
}
