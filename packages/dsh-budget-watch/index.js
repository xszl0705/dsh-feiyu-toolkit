/**
 * dsh-budget-watch — DSH 宿主插件入口。
 *
 * 纯只读：解析 ~/.dsh/sessions 里的 usage，算出会话花了多少、该不该交接。
 * 不改配置、不起子进程、不联网、不切会话——切会话是开关，归人。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTools } from './lib/tools.js'

export const name = 'dsh-budget-watch'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return {}
  }
}

function note(message) {
  try {
    fs.appendFileSync(path.join(HERE, 'load.log'), new Date().toISOString() + '  ' + message + '\n', 'utf8')
  } catch {
    // 日志写不了也不能影响加载
  }
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
 * 自己轮询等，但同一进程只许注册一次——cordis 会对同一插件多次调用 apply()，
 * 两路注册会撞同名工具。
 */
const STATE_KEY = Symbol.for('dsh-budget-watch.state')

function getState(ctx) {
  const owner = (ctx && ctx.root) || ctx || globalThis
  if (!owner[STATE_KEY]) owner[STATE_KEY] = { registered: false, waiting: false }
  return owner[STATE_KEY]
}

function registerWhenToolsReady(ctx, callback) {
  const st = getState(ctx)
  if (st.registered || st.waiting) return
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
      note('60s 内没等到 tools 服务，工具未注册')
      return
    }
    setTimeout(tick, 250)
  }
  tick()
}

/** 加载入口：任何异常都在这里吃掉，绝不让 apply 抛错把宿主带崩。 */
export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const message = String((error && error.message) || error)
    safeLog(ctx, 'warn', 'dsh-budget-watch 加载失败：' + message)
    note('apply 抛错：' + message)
    return undefined
  }
}

function applyInner(ctx) {
  registerWhenToolsReady(ctx, (tools) => {
    const config = loadConfig()
    const definitions = createTools(config)
    const registerAll = () => {
      const handles = []
      for (const definition of definitions) {
        try {
          handles.push(tools.register(definition))
        } catch (error) {
          note('注册工具失败 ' + String(definition?.name || '?') + '：' + String((error && error.message) || error))
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
    safeLog(ctx, 'info', `dsh-budget-watch ready（1 个工具）`)
    note(`dsh-budget-watch: 1 个工具已注册（pid ${process.pid}）`)
  })
}
