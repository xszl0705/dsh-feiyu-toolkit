import { lifecycle } from 'dsh-plugin-kit/lifecycle'
import { note as kitNote } from 'dsh-plugin-kit/note'

/**
 * dsh-fyrunner — DSH host plugin entry.
 *
 * FyRunner 原本是「双击 bat 起 pywebview 窗口」的独立桌面应用。
 * 本插件把它降级成被托管的本地服务（headless Python），由 DSH 工具起停 + 浏览器打开，
 * 好处：不依赖 pywebview、数据落在插件目录、DSH 里能直接看状态和日志。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFyrunnerTools } from './lib/fyrunner.js'

export const name = 'dsh-fyrunner'

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

/**
 * 冷启动时 apply() 可能跑在 tools 服务就绪之前。
 * 自己轮询等服务，但同一进程只注册一次（cordis 会对同一插件多次调用 apply）。
 */
const STATE_KEY = Symbol.for('dsh-fyrunner.state')

function state(ctx) {
  return lifecycle(ctx, () => ({ registered: false, waiting: false }))
}

function registerWhenToolsReady(ctx, pluginName, callback) {
  const st = state(ctx)
  if (st.registered) return
  if (st.waiting) return

  const started = Date.now()
  st.waiting = true
  const tick = () => {
    let tools
    try {
      tools = ctx.get?.('tools')
    } catch {
      tools = undefined
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

/** 加载入口：任何异常都在这里吃掉，绝不让 apply 抛错把宿主带崩。 */
export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const message = String((error && error.message) || error)
    safeLog(ctx, 'warn', 'dsh-fyrunner 加载失败：' + message)
    note('apply 抛错：' + message)
    return undefined
  }
}

function applyInner(ctx) {
  registerWhenToolsReady(ctx, 'dsh-fyrunner', (tools) => {
    try {
      const definitions = createFyrunnerTools()
      const registerAll = () => {
        const handles = []
        for (const definition of definitions) {
          try {
            handles.push(tools.register(definition))
          } catch (error) {
            note(
              '注册工具失败 ' +
                String((definition && definition.name) || '?') +
                '：' +
                String((error && error.message) || error),
            )
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
      safeLog(ctx, 'info', 'dsh-fyrunner ready（1 个工具）')
      note('dsh-fyrunner: 1 个工具已注册（pid ' + process.pid + '）')
    } catch (error) {
      const message = String((error && error.message) || error)
      safeLog(ctx, 'warn', 'dsh-fyrunner 注册工具失败：' + message)
      note('注册工具失败：' + message)
    }
  })
}
