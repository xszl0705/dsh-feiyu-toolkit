/**
 * preset 准入层：把本插件的工具限制在指定 agent preset 里（P0 of 模式架构）。
 *
 * 机制（读宿主源码得出，不是猜）：
 *   `ctx.tools.register(definition, { when })` 的 `when` 是 **per-step 准入条件**，
 *   宿主在每步装配工具前逐个 await（`@deepseek-ai/dsh-tools/lib/index.js:434-446, 543-559`）。
 *   返回 false 的工具这一步不出现；抛错会触发 `ToolActivationError` 让该步失败——所以这里全 try/catch。
 *
 * preset 从哪读（实测过的唯一可靠链，来源 `dsh-auto-memory/lib/rp-channel.js:67-166`）：
 *   1. `agentPresets.presetForSession(agent.session)` —— 权威，跟随 `agent-preset/selected` 事件；
 *      创建时快照 `session.header.agentPreset` 在用户切模式后仍是旧值，不能当唯一来源。
 *   2. `ctx.get('sessions').list.getSnapshot()` 里该会话行的 `projectionValues.agentPreset`。
 *   3. agent 上零散的旧字段（不同宿主版本挂的位置不同）。
 *   agent 对象本身没有稳定的 preset 字段，只读它会在真实宿主里静默落空。
 */

let presetRegistry = null
let sessionSource = null
let boundCtx = null
const announced = new Set()

/** 沿路径取属性，任何一层抛错或缺失都返回 undefined。 */
function safeGet(target, path) {
  let cursor = target
  for (const key of path) {
    if (cursor === null || cursor === undefined) return undefined
    try {
      cursor = cursor[key]
    } catch {
      return undefined
    }
  }
  return cursor
}

/**
 * 绑定时序：apply 里调一次。两个来源都拿不到也不致命——判定会走 fail 策略。
 * @param {object} ctx 插件 ctx（不是 agent.ctx）。
 * @returns {{ registry: boolean, sessions: boolean }} 各来源是否可用。
 */
export function bindPresetSources(ctx) {
  boundCtx = ctx || null
  return bindPresetSourcesOnce(ctx);
}

/** 真正去取服务；apply 时可能还没就绪，所以单独抽出来给惰性重试复用。 */
function bindPresetSourcesOnce(ctx) {
  presetRegistry = null
  sessionSource = null
  try {
    const reg = ctx && typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
    if (reg && typeof reg.presetForSession === 'function') presetRegistry = reg
  } catch {
    presetRegistry = null
  }
  try {
    const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
    if (sessions && sessions.list && typeof sessions.list.getSnapshot === 'function') {
      sessionSource = () => sessions.list.getSnapshot()
    }
  } catch {
    sessionSource = null
  }
  return { registry: presetRegistry !== null, sessions: sessionSource !== null }
}

/** registry 记录的会话 preset（权威）。 */
function presetFromRegistry(agent) {
  if (!presetRegistry) return ''
  try {
    const session = safeGet(agent, ['session'])
    if (!session) return ''
    const value = presetRegistry.presetForSession(session)
    return typeof value === 'string' && value.trim() ? value.trim() : ''
  } catch {
    return ''
  }
}

/** 会话快照里该 agent 的 preset（按 session id 精确匹配，不用 current 兜底——会串会话）。 */
function presetFromSessions(agent) {
  if (typeof sessionSource !== 'function') return ''
  try {
    const snap = sessionSource()
    if (!snap || typeof snap !== 'object' || !snap.byId) return ''
    const sid = String(safeGet(agent, ['session', 'id']) || safeGet(agent, ['session', 'sessionId']) || '')
    if (!sid || !snap.byId[sid]) return ''
    const row = snap.byId[sid]
    const direct = safeGet(row, ['projectionValues', 'agentPreset'])
    if (typeof direct === 'string' && direct.trim()) return direct.trim()
    const alt = safeGet(row, ['agentPreset']) || safeGet(row, ['preset'])
    return typeof alt === 'string' ? alt.trim() : ''
  } catch {
    return ''
  }
}

/**
 * 从 agent 解析 preset id；拿不到返回 `''`。
 * @param {object} agent 宿主传给 when 的 `context.agent`。
 * @returns {string} preset id。
 */
export function resolveAgentPreset(agent) {
  if (!agent || typeof agent !== 'object') return ''
  // Read the live composition first; the creation header is immutable.
  for (const ctx of [safeGet(agent, ['ctx']), boundCtx]) {
    try {
      const registry = ctx?.get?.('agentPresets');
      const live = registry?.composedPreset?.(safeGet(agent, ['ctx']));
      if (typeof live === 'string' && live.trim()) return live.trim();
      const projected = registry?.presetForSession?.(safeGet(agent, ['session']));
      if (typeof projected === 'string' && projected.trim()) return projected.trim();
    } catch {}
  }
  // 惰性重绑：apply 时服务常未就绪，首次真正判定时再取一次
  if (presetRegistry === null && sessionSource === null && boundCtx !== null) {
    bindPresetSourcesOnce(boundCtx)
  }
  const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')
  const fromRegistry = presetFromRegistry(agent)
  if (fromRegistry) return fromRegistry
  const candidates = [
    safeGet(agent, ['session', 'projectionValues', 'agentPreset']),
    safeGet(agent, ['projectionValues', 'agentPreset']),
    presetFromSessions(agent),
    safeGet(agent, ['session', 'header', 'agentPreset']),
    safeGet(agent, ['session', 'header', 'preset']),
    safeGet(agent, ['session', 'preset']),
    safeGet(agent, ['session', 'agentPreset']),
    safeGet(agent, ['agentPreset']),
    safeGet(agent, ['preset']),
  ]
  for (const candidate of candidates) {
    const hit = pick(candidate)
    if (hit) return hit
  }
  return ''
}

/**
 * 造一个 `when` 条件：只有 `presets` 里的模式能看到这些工具。
 *
 * `onUnknown` 决定判不出 preset 时怎么办：
 *   · `hide`（默认）—— 判不出就不暴露。工具面宁缺勿滥，且日志会留 `unknown`。
 *   · `show` —— 判不出就暴露（fail-open，等价于没装准入层）。
 *
 * 永不抛错：宿主会把 `when` 的异常当 `ToolActivationError`，那一步直接失败。
 * @param {string[]} presets 允许看到工具的模式 id。
 * @param {object} [options] `{ onUnknown, log }`。
 * @returns {(context: object) => boolean} when 条件。
 */
export function makePresetGate(presets, options = {}) {
  const allow = new Set(
    (Array.isArray(presets) ? presets : [])
      .map((value) => String(value == null ? '' : value).trim())
      .filter(Boolean),
  )
  const onUnknown = options.onUnknown === 'show' ? 'show' : 'hide'
  const log = typeof options.log === 'function' ? options.log : () => {}

  return function presetGate(context) {
    try {
      if (allow.size === 0) return true
      const preset = resolveAgentPreset(context && context.agent)
      const verdict = !preset ? onUnknown === 'show' : allow.has(preset)
      const line = `gate preset=${preset || '?'} allow=${[...allow].join('|')} → ${verdict ? 'show' : 'hide'}`
      if (!announced.has(line)) {
        announced.add(line)
        if (announced.size > 64) announced.clear()
        log(line)
      }
      return verdict
    } catch (error) {
      // 诊断日志本身也可能抛（外部把 log 换成写文件失败等）：吞掉，when 绝不能冒泡
      try {
        const line = 'gate throw: ' + String((error && error.message) || error)
        if (!announced.has(line)) {
          announced.add(line)
          log(line)
        }
      } catch {
        /* 诊断失败不影响判定 */
      }
      return onUnknown === 'show'
    }
  }
}

/** 测试用：清空已绑定的来源与日志去重表。 */
export function resetPresetSources() {
  presetRegistry = null
  sessionSource = null
  boundCtx = null
  announced.clear()
}
