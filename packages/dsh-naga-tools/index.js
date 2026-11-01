import { lifecycle } from './lib/lifecycle.js'
/**
 * dsh-naga-tools — DSH host plugin entry.
 *
 * 参照 NagaAgent 的 `agent-manifest.json` 契约，把它的三类 agent 能力
 * 改写成 DSH 原生工具（纯 Node、无 Python、无 MCP 子进程）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNagaTools } from './lib/naga.js'

export const name = 'dsh-naga-tools'

const HERE = path.dirname(fileURLToPath(import.meta.url))

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
 * 冷启动时 apply() 可能跑在 tools 服务就绪之前（实测：重启后本插件工具全没注册，
 * 而用 inject 等 webServer 的 pet-hub 一切正常）。这里不赌 cordis 的 inject 语义，
 * 自己轮询等服务，但**同一进程只许注册一次**：cordis 会对同一插件多次调用 apply()，
 * 08:14 那次崩溃就是两路注册撞了同名工具。
 */
const STATE_KEY = Symbol.for('dsh-naga-tools.state')

function state(ctx) { return lifecycle(ctx, () => ({ registered: false, waiting: false })) }

function registerWhenToolsReady(ctx, pluginName, callback) {
  const st = state(ctx)
  if (st.registered) return
  if (st.waiting) return // 已经有一条等待链，别开第二条

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
      if (st.registered) return // 双保险
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
    safeLog(ctx, 'warn', 'dsh-naga-tools 加载失败：' + message)
    note('apply 抛错：' + message)
    return undefined
  }
}

function applyInner(ctx) {
  registerWhenToolsReady(ctx, 'dsh-naga-tools', (tools) => {
    try {
      const definitions = createNagaTools()
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
      safeLog(ctx, 'info', 'dsh-naga-tools ready（1 个工具）')
      note('dsh-naga-tools: 1 个工具已注册（pid ' + process.pid + '）')
    } catch (error) {
      const message = String((error && error.message) || error)
      safeLog(ctx, 'warn', 'dsh-naga-tools 注册工具失败：' + message)
      note('注册工具失败：' + message)
    }
  })
}
