/**
 * dsh-step-saver — 一般模式的步数与上下文治理（宿主插件入口）。
 *
 * 三条出口：
 *   1. 工具：run_node / ls_tree / file_outline / smart_grep / toolbox
 *   2. 工具面：slim 通道（包装 ToolsService.view + 执行兜底），把 72 个收到 ~38 个
 *   3. 提示词：步数纪律（system prompt 静态段，装不上就只记日志，不影响前两条）
 *
 * 设计纪律（照 dsh-naga-tools / dsh-rp-mode 踩过的坑）：
 *   · 冷启动时 tools 服务可能还没就绪 ⇒ 自己轮询，同一进程只注册一次
 *   · 任何异常都在 apply 里吃掉，绝不让宿主崩
 *   · fail-open：slim 配置缺失 / 白名单为空 / 拿不到 agent ⇒ 一律放行原工具面
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeSlim, installSlim, loadSlim, resolveSlim, slimLog, slimLogPath } from './lib/slim.js'
import { createStepSaverTools } from './lib/tools.js'

export const name = 'dsh-step-saver'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE_KEY = Symbol.for('dsh-step-saver.state')

function note(message) {
  try {
    const file = slimLogPath({})
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, new Date().toISOString() + ' [plugin] ' + message + '\n', 'utf8')
  } catch {
    // 日志失败不影响功能
  }
}

function state(ctx) {
  try {
    const shared = ctx && ctx[STATE_KEY]
    if (shared) return shared
  } catch {
    // ignore
  }
  const st = { registered: false, waiting: false, slim: null }
  try {
    if (ctx) ctx[STATE_KEY] = st
  } catch {
    // ignore
  }
  return st
}

function safeLog(ctx, level, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
  } catch {
    // ignore
  }
}

const STEP_DISCIPLINE = [
  '【步数纪律 · dsh-step-saver】',
  '1. 互不依赖的调用放同一条消息并发（目标 次/步 ≥ 1.40）。发出前问一句：这个结果会影响下一个调用的参数吗？不会就并行。',
  '2. 读文件先 file_outline 拿骨架，再用 read 带 offset/limit 一次读全窗口；同一会话不要重复读同一段。',
  '3. 同一文件的多处改动合并成一次 write；edit 只用于真正的单点小改。',
  '4. 跑脚本用 run_node（环境变量已注入），列目录用 ls_tree；不要再手拼 powershell 前缀。',
  '5. 单条工具结果 >10,000 字符视为失败，下一轮必须换做法（先落盘再读尾）。',
  '6. 真要用的低频工具被收起时，用 toolbox(show="组名") 挂回，不要改用 pwsh 硬凑。',
].join('\n')

/** 提示词出口：装得上就装，装不上只记日志。 */
function installPrompt(scoped) {
  const slim = loadSlim()
  const noteText = slim && typeof slim.prompt === 'string' && slim.prompt.trim() ? slim.prompt.trim() : STEP_DISCIPLINE
  let mounted = false
  try {
    // 宿主 dsh-system-prompt 的服务挂在 ctx.systemPrompt 属性上（照 dsh-auto-memory 的用法）。
    // 静态段是 DeepSeek 前缀缓存的锚，不会击穿缓存；动态内容才走 context()。
    const sp = scoped && scoped.systemPrompt
    if (sp && typeof sp.section === 'function') {
      sp.section({ name: 'dsh:step-saver-discipline', order: 60, text: context => resolveSlim(context.agent)?.strict ? '' : noteText })
      mounted = true
    } else if (sp && typeof sp.register === 'function') {
      sp.register({ id: 'dsh-step-saver.discipline', text: noteText })
      mounted = true
    } else if (sp && typeof sp.add === 'function') {
      sp.add(noteText)
      mounted = true
    }
  } catch (error) {
    note('提示词段装载失败：' + String((error && error.message) || error))
  }
  note(`提示词出口 ${mounted ? 'ok' : '未找到 systemPrompt 服务（纪律未注入，其余出口不受影响）'}`)
  return mounted
}

export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const message = String((error && error.message) || error)
    safeLog(ctx, 'warn', 'dsh-step-saver 加载失败：' + message)
    note('apply 抛错：' + message)
    return undefined
  }
}

function registerWhenToolsReady(ctx, pluginName, callback) {
  const st = state(ctx)
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
        note('注册时抛错：' + String((error && error.message) || error))
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
  st.later = (fn, ms) => setTimeout(fn, ms)
  tick()
}

function applyInner(ctx) {
  registerWhenToolsReady(ctx, 'dsh-step-saver', (tools) => {
    const definitions = createStepSaverTools()
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
            if (typeof handle === 'function') handle()
          } catch {
            // 卸载失败不影响禁用
          }
        }
      }
    }
    try {
      if (typeof ctx.effect === 'function') ctx.effect(registerAll)
      else registerAll()
    } catch (error) {
      note('工具注册抛错：' + String((error && error.message) || error))
    }

    const slimState = state(ctx)
    if (!slimState.slim) {
      slimState.slim = installSlim(ctx, tools)
    }
    // cordis 的服务访问必须在 inject 声明的 scope 里；不能直接把 systemPrompt 写进
    // 插件的硬 inject（rp-mode 踩过：硬依赖会让插件整体等待、工具全不注册）。
    // ctx.inject 是动态作用域注入：服务不在时这块静默跳过，工具与 slim 照常工作。
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['systemPrompt'], (sctx) => installPrompt(sctx))
      }
    } catch (error) {
      note('systemPrompt 注入声明失败：' + String((error && error.message) || error))
    }
    safeLog(ctx, 'info', `dsh-step-saver ready（${definitions.length} 个工具）slim=${describeSlim()}`)
    note(`就绪 pid=${process.pid} 工具=${definitions.length} slim=${describeSlim()} 包=${HERE}`)
  })
}
