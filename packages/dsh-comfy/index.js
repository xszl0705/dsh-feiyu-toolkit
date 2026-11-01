/**
 * dsh-comfy —— 接本地 ComfyUI。
 *
 * 一个工具 comfy(action=…)：
 *   status      服务在不在、显存、有哪些底模与 ControlNet
 *   generate    文生图
 *   controlnet  用参考图锁构图重绘（表情差分、换装、姿势微调）
 *
 * 重要边界：**不负责启动 ComfyUI**。它是常驻推理服务，占 GPU、会和 Ollama 抢显存，
 * 什么时候开什么时候关归用户决定。服务没起时工具只报错并给出启动命令位置。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lifecycle } from './lib/lifecycle.js'
import { createTools } from './lib/tools.js'

export const name = 'dsh-comfy'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVICE_KEY = Symbol.for('dsh-comfy.state')

const DEFAULTS = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:8188',
  outputDir: '',
  comfyOutputDir: '',
  comfyInputDir: '',
  defaultCheckpoint: 'anything-v5-PrtRE.safetensors',
  defaultControlnet: 'control_v11p_sd15_canny_fp16.safetensors',
}

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function note(message) {
  try {
    fs.appendFileSync(path.join(HERE, 'load.log'), new Date().toISOString() + '  ' + message + '\n', 'utf8')
  } catch {
    // 日志写不了不影响功能
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

function state(ctx) {
  return lifecycle(ctx, () => ({ config: null, registered: false, waiting: false, lastError: '' }))
}

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
    safeLog(ctx, 'warn', 'dsh-comfy 加载失败：' + st.lastError)
    return undefined
  }
}

function applyInner(ctx) {
  const st = state(ctx)
  const config = loadConfig()
  st.config = config
  if (config.enabled === false) {
    note('已禁用（config.enabled=false），不注册工具')
    return { id: 'comfy', enabled: false }
  }

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
    note(`dsh-comfy: ${definitions.length} 个工具已注册（pid ${process.pid}）`)
    safeLog(ctx, 'info', `dsh-comfy ready（${definitions.length} 个工具）`)
  })

  const api = {
    id: 'comfy',
    baseUrl: config.baseUrl,
    config: () => ({ ...config }),
  }
  try {
    if (typeof ctx.provide === 'function') ctx.provide('comfy', api)
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
      id: 'comfy',
      package: 'dsh-comfy',
      intent: '用本地 ComfyUI 文生图与 ControlNet 重绘',
      inputs: ['prompt', 'imagePath', 'strength', 'seed'],
      outputs: ['png-path'],
      limits: [
        '不负责启动 ComfyUI，服务没起就报错',
        '需要 ComfyUI 的 --output-directory / --input-directory 与本插件配置一致',
        '输出只回路径，不回 base64',
        '8GB 显存同时跑 Ollama 会 OOM',
      ],
      failureModes: [
        { code: 'OFFLINE', meaning: '连不上 ComfyUI', retry: '用户手动启动服务后再调' },
        { code: 'NO_FILE', meaning: 'history 说有图但磁盘没有', retry: '检查 comfyOutputDir 是否与 --output-directory 一致' },
        { code: 'EXEC_ERROR', meaning: 'ComfyUI 执行节点报错', retry: '看 error 里的 exception_message' },
        { code: 'TIMEOUT', meaning: '超时没出图', retry: '冷启动首次较慢，稍后重试' },
      ],
      scope: ['owner'],
      state: () => ({ baseUrl: config.baseUrl }),
    })
  } catch {
    // self 没装不影响工具
  }

  note('dsh-comfy 就绪（' + config.baseUrl + '）')
  return api
}
