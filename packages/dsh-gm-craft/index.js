import { lifecycle } from 'dsh-plugin-kit/lifecycle'
import { note as kitNote } from 'dsh-plugin-kit/note'
/**
 * dsh-gm-craft — GM 工坊 host plugin.
 *
 * 世界—故事—操作—反馈四层，六个工具。判断归模型，这里只做结构化、召回、确定性校验。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGmTools } from './lib/tools.js'

export const name = 'dsh-gm-craft'

/**
 * tools 依赖显式声明：`ctx.get('tools')` 在 preset 隔离域里解析到宿主根实例，
 * 注册的工具进不了 agent 每步的函数表。声明后 `ctx.tools` 是 realm 绑定实例。
 * 宿主根层也注册了 tools，所以数组式（必需）依赖在两种挂载位置都满足。
 */
export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))

function note(message) {
  kitNote(HERE, message)
}

function safeLog(ctx, level, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
  } catch {
    // ignore
  }
}

function state(ctx) {
  return lifecycle(ctx, () => ({ registered: false, waiting: false }))
}

/**
 * 取 tools 服务。
 *
 * preset 的 isolate realm 里 `ctx.get('tools')` 可能解析到宿主根服务，注册进宿主层后
 * preset 会话的 view 看不见（实测 roleplay 会话只剩 tool-web 工具）。属性访问沿用当前
 * ctx 的 realm 绑定，优先它；来源一并落盘。
 */
function pickTools(ctx) {
  try {
    const t = ctx && ctx.tools
    if (t && typeof t.register === 'function') return { tools: t, source: 'ctx.tools' }
  } catch {
    // 服务未就绪时属性访问会抛，正常
  }
  try {
    const t = ctx && typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    if (t && typeof t.register === 'function') return { tools: t, source: 'ctx.get' }
  } catch {
    // 同上
  }
  return { tools: undefined, source: 'none' }
}

function registerWhenToolsReady(ctx, pluginName, callback) {
  const st = state(ctx)
  if (st.registered || st.waiting) return
  const started = Date.now()
  st.waiting = true
  const tick = () => {
    const picked = pickTools(ctx)
    const tools = picked.tools
    if (tools) {
      st.toolSource = picked.source
      note(pluginName + ': tools 来源=' + picked.source)
    }
    if (tools && typeof tools.register === 'function') {
      if (st.registered) return
      st.registered = true
      st.waiting = false
      try {
        callback(tools)
      } catch (error) {
        note('注册工具时抛错：' + String((error && error.message) || error))
      }
      return
    }
    if (Date.now() - started > 60000) {
      st.waiting = false
      note(pluginName + ': 60s 内没等到 tools 服务，工具未注册')
      return
    }
    st.later(tick, 250)
  }
  tick()
}

export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const message = String((error && error.message) || error)
    safeLog(ctx, 'warn', 'dsh-gm-craft 加载失败：' + message)
    note('apply 抛错：' + message)
    return undefined
  }
}

function applyInner(ctx) {
  registerWhenToolsReady(ctx, 'dsh-gm-craft', (tools) => {
    try {
      const definitions = createGmTools()
      const registerAll = () => {
        const handles = []
        for (const definition of definitions) {
          try {
            handles.push(tools.register(definition))
          } catch (error) {
            note('注册工具失败 ' + String((definition && definition.name) || '?') + '：' + String((error && error.message) || error))
          }
        }
        return () => {
          for (const handle of handles) {
            try {
              handle?.dispose?.()
            } catch {
              // 卸载失败不影响禁用
            }
          }
        }
      }
      if (typeof ctx.effect === 'function') ctx.effect(registerAll)
      else registerAll()
      safeLog(ctx, 'info', 'dsh-gm-craft ready（' + definitions.length + ' 个工具）')
      note('dsh-gm-craft: ' + definitions.length + ' 个工具已注册（pid ' + process.pid + '）')
    } catch (error) {
      const message = String((error && error.message) || error)
      safeLog(ctx, 'warn', 'dsh-gm-craft 注册工具失败：' + message)
      note('注册工具失败：' + message)
    }
  })
}
