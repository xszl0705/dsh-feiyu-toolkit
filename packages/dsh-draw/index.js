/**
 * dsh-draw —— 让大肥鱼会画图。
 *
 * 两个工具：
 *   draw_chart  matplotlib 数据图（折线/柱/饼/散点/双轴）
 *   draw_card   Pillow 排版卡片（段落卡片 / 键值列表）
 *
 * 为什么走 Python：本机没有可靠的 Node 绘图栈，而 Pillow + matplotlib 已经在
 * 沙箱里验证过可用（见 docs/绘图落地实施方案-2026-11-01.md）。
 * 依赖不接受 pip 安装，以 wheel 解压目录固化在 pylibs/，运行时注入 PYTHONPATH。
 */
import fs from 'node:fs'
import { note as kitNote } from 'dsh-plugin-kit/note'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lifecycle } from 'dsh-plugin-kit/lifecycle'
import { createTools } from './lib/tools.js'
import { findPython } from './lib/bridge.js'

export const name = 'dsh-draw'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SERVICE_KEY = Symbol.for('dsh-draw.state')

const DEFAULTS = {
  enabled: true,
  outputDir: '',
  pythonPath: '',
}

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

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
  return lifecycle(ctx, () => ({ config: null, registered: false, waiting: false, lastError: '' }))
}

/** 冷启动时 tools 服务可能还没就绪；同一进程只注册一次，避免同名工具撞车。 */
function registerWhenToolsReady(ctx, st, callback) {
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
    st.later(tick, 250)
  }
  tick()
}

export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const st = state(ctx)
    st.lastError = String((error && error.message) || error)
    note('apply 抛错：' + st.lastError)
    safeLog(ctx, 'warn', 'dsh-draw 加载失败：' + st.lastError)
    return undefined
  }
}

function applyInner(ctx) {
  const st = state(ctx)
  const config = loadConfig()
  st.config = config
  if (config.enabled === false) {
    note('已禁用（config.enabled=false），不注册工具')
    return { id: 'draw', enabled: false }
  }

  const py = findPython(config.pythonPath)
  note(`python: ${py.path || '(未找到)'} 来源=${py.from}`)

  registerWhenToolsReady(ctx, st, (tools) => {
    const definitions = createTools(config)
    const registerAll = () => {
      const handles = []
      for (const definition of definitions) {
        try {
          handles.push(tools.register(definition))
        } catch (error) {
          note('注册工具失败 ' + definition.name + '：' + String((error && error.message) || error))
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
    note(`dsh-draw: ${definitions.length} 个工具已注册（pid ${process.pid}）`)
    safeLog(ctx, 'info', `dsh-draw ready（${definitions.length} 个工具）`)
  })

  const api = {
    id: 'draw',
    python: () => py,
    outputDir: () => config.outputDir || path.join(process.cwd(), 'out', 'draw'),
  }
  try {
    if (typeof ctx.provide === 'function') ctx.provide('draw', api)
  } catch {
    // 宿主可能不认这个服务名
  }
  globalThis[SERVICE_KEY] = api
  st.own(() => {
    if (globalThis[SERVICE_KEY] === api) delete globalThis[SERVICE_KEY]
  })

  try {
    const self = ctx.get?.('self') || globalThis[Symbol.for('dsh-feiyu-self.service')]
    self?.declare?.({
      id: 'draw',
      package: 'dsh-draw',
      intent: '画数据图与排版卡片：需要准确数字/文字的图走这里',
      inputs: ['series', 'labels', 'title', 'rows', 'body'],
      outputs: ['png-path'],
      limits: [
        '只画图表和排版卡片，不画插画/写实图（那要走 ComfyUI 或云 API）',
        '需要本机有可用的 Python 与插件自带 pylibs',
        '输出只回路径，不回 base64',
      ],
      failureModes: [
        { code: 'PYTHON_NOT_FOUND', meaning: '找不到 Python 解释器', retry: '配置 pythonPath 或设 DSH_PYTHON 后重启' },
        { code: 'NO_DATA', meaning: 'series/rows 为空', retry: '补齐数据再调' },
        { code: 'TIMEOUT', meaning: '渲染超时', retry: '减小数据量或降低 dpi' },
        { code: 'RENDER_FAILED', meaning: 'matplotlib/Pillow 渲染异常', retry: '检查数据维度是否与 labels 一致' },
      ],
      scope: ['owner'],
      state: () => ({ python: py.path, source: py.from }),
    })
  } catch {
    // self 没装不影响工具
  }

  note('dsh-draw 就绪')
  return api
}
