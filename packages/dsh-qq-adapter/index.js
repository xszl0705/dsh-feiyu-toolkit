import { lifecycle } from 'dsh-plugin-kit/lifecycle'
import { note as kitNote } from 'dsh-plugin-kit/note'
/**
 * dsh-qq-adapter — QQ 渠道适配器（OneBot 11：SnowLuma / NapCat）
 *
 * 群白名单配置变更后需要重新 apply 才生效（这里没有文件监听）；改完会动一下本文件触发宿主热重载。
 *
 * 链路：
 *   OneBot 11 反向 WS 事件 → 过滤（私聊/@/白名单/限速）
 *   → 主体内核身份（compiled/identity.qq.txt）+ 当前这句
 *   → 宿主 llm 生成 → OneBot HTTP 发送 → 写 chats（channel:"qq"）
 *
 * 不改人格、不另存记忆；换协议只换这一层。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEvent, shouldAnswer, RateLimiter } from './lib/onebot.js'
import { recordTrigger } from './lib/trigger.js'
import { loadIdentity } from './lib/prompt.js'
import { generateReply, askLLM } from './lib/reply.js'
import { askVision } from './lib/vision.js'
import { createExecLayer } from './lib/exec-layer.js'
import { installClientVisionContext } from './lib/client-vision-context.js'
import { createImageLibrary, defaultImageLibraryDir } from './lib/image-library.js'
import { judgeSticker, heuristicJudge } from './lib/image-judge.js'
import { parseStickerIntent } from './lib/sticker-intent.js'
import { installClientImageLibrary, installAttachmentWatcher } from './lib/client-image-library.js'
import { publicDownload } from './lib/public-download.js'
import { ApprovalStore } from './lib/approval.js'
import { sendOneBot, setGroupAddRequest } from './lib/send.js'
import { registerQqTools } from './lib/tools.js'
import { normalizePolicy, createPolicyState, decideCandidate, markMessage, markSilence, wakeOnAddress, isWake } from './lib/group-policy.js'
import { loadPolicyState, savePolicyState } from './lib/group-policy-store.js'
import { appendGroupMessage, groupContextVersion, recentGroupMessages } from './lib/group-context.js'
import { runGateLocal } from './lib/gate-local.js'
import { createPlan, recheckPlan, markPlan } from './lib/planned.js'
import { KnowledgeStore, extractUrls } from './lib/knowledge.js'
import { appendChat } from './lib/chatlog.js'
import { startOllamaWatch } from './lib/ollama.js'
import { ensureServices } from './lib/autostart.js'
import { connect } from './lib/pipeline.js'
export { handleEvent, memoryAllowed, memoryVisibility, onFrame } from './lib/pipeline.js'

export { askLLM }

export const name = 'dsh-qq-adapter'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  enabled: true,
  wsUrl: 'ws://127.0.0.1:3001',
  httpUrl: 'http://127.0.0.1:3000',
  accessToken: '',
  allowPrivate: true,
  groups: [],
  requireAtInGroup: true,
  maxReplyChars: 120,
  ratePerMinute: 6,
  ownerId: '',
  approveTtlMinutes: 10,
  approvedHours: 24,
  maxTokens: 1000,
  local: {
    enabled: true,
    endpoint: 'http://127.0.0.1:11434',
    model: 'qwen3:4b',
    numPredict: 200,
    timeoutMs: 20000,
  },
  identityFile: '',
  // 2.2 订阅直通影子：只记录非 @ 群消息的体量，不改行为（方案 v3）
  subscribeShadow: {
    enabled: false,
    dir: '',
  },
  imageLibrary: {
    enabled: true,
    dir: '',
    maxFileBytes: 8388608,
    maxRecentFiles: 300,
    maxRecentBytes: 157286400,
    downloadTimeoutMs: 20000,
    autoSave: true,
    judge: { enabled: true, endpoint: 'http://127.0.0.1:11434', model: 'qwen3:4b', timeoutMs: 8000 },
  },
  tts: {
    enabled: true,
    url: 'http://127.0.0.1:9882',
    scene: 'daily',
    deadlineMs: 12000,
    timeoutMs: 20000,
    pollMs: 600,
    apiKey: '',
    fallbackToSapi: true,
    ollama: {
      enabled: true,
      url: 'http://127.0.0.1:11434',
      model: 'qwen3:4b',
      keepAlive: '30m',
      unloadWaitMs: 8000,
    },
  },
}

const CONFIG_BASE = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

// 真实配置（QQ 号 / 群号 / 本机路径）只放用户目录，不进仓库与发布包。
// 读取顺序：config.example.json（模板）→ config.json（旧版遗留）→ ~/.dsh/dafeiyu/qq.json（本地覆盖，最后赢）。
export function configPaths(base = CONFIG_BASE) {
  return {
    example: path.join(HERE, 'config.example.json'),
    legacy: path.join(HERE, 'config.json'),
    local: path.join(base, 'dafeiyu', 'qq.json'),
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function mergeConfig(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch || {})) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeConfig(out[key], value) : value
  }
  return out
}

function readConfigFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isPlainObject(data) ? data : null
  } catch {
    return null
  }
}

export function loadConfig(base = CONFIG_BASE) {
  let config = { ...DEFAULTS }
  for (const file of Object.values(configPaths(base))) {
    const data = readConfigFile(file)
    if (data) config = mergeConfig(config, data)
  }
  return config
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

export function defaultIdentityFile() {
  const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(base, 'dafeiyu', 'compiled', 'identity.qq.txt')
}

function loadPromptExtra(file = '') {
  const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const target = file || path.join(base, 'dafeiyu', 'prompt-patches', 'group-prompt-extra.txt')
  try {
    return fs.readFileSync(target, 'utf8').trim().slice(0, 2000)
  } catch {
    return ''
  }
}

/** 兜底身份：主体内核没编译时，至少用 persona.md，别乱编人格。 */
function fallbackIdentity() {
  const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    const persona = fs.readFileSync(path.join(base, 'dafeiyu', 'core', 'persona.md'), 'utf8').trim()
    return `${persona}\n\n【这个渠道怎么说】\n渠道：QQ；短句口语，不用表情；不超过 120 字。`
  } catch {
    return '你是大肥鱼：外向、温柔、简短说话；不知道就说不知道。'
  }
}

/**
 * 取宿主的 vision 服务（dsh-vision 注册为 `vision`）；没装返回 null。
 * 2026-11-04 修复：2.1 拆 index 时这个辅助随旧代码被删，apply 走到这里报
 * `visionService is not defined`（被外层 try/catch 吞成「客户端图片上下文注入安装失败」）。
 */
function visionService(ctx) {
  try {
    return ctx.get?.('vision') || globalThis[Symbol.for('dsh-vision.service')] || null
  } catch {
    return null
  }
}

/**
 * 取宿主的服务自愈（dsh-service-autostart 注册为 `autostart`）；没装返回 null。
 * 没定义时 apply 直接抛错，整个 QQ 适配器起不来（2026-11-04 重启实测）。
 */
function autostartService(ctx) {
  try {
    return ctx.get?.('autostart') || globalThis[Symbol.for('dsh-service-autostart.service')] || null
  } catch {
    return null
  }
}

const STATE_KEY = Symbol.for('dsh-qq-adapter.state')

function state(ctx) { return lifecycle(ctx, () => ({
      started: false,
      socket: null,
      connected: false,
      attempts: 0,
      lastError: '',
      lastEventAt: 0,
      replied: 0,
      ignored: 0,
      asked: 0,
      config: null,
      limiter: null,
      approvals: null,
      history: new Map(),
      seen: new Set(),
      groupLastReply: new Map(),
      queued: 0,
      toolsWaiting: false,
      toolsSince: 0,
      toolsRegistry: null,
      ollamaWatcher: null,
    })) }

export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const message = String((error && error.message) || error)
    safeLog(ctx, 'warn', 'dsh-qq-adapter 加载失败：' + message)
    note('apply 抛错：' + message)
    return undefined
  }
}

function applyInner(ctx) {
  const st = state(ctx)
  if (st.ready) return
  const config = st.config ||= loadConfig()
  st.limiter ||= new RateLimiter(config.ratePerMinute)

  const baseIdentity = loadIdentity(config.identityFile || defaultIdentityFile()) || fallbackIdentity()
  const identity = [baseIdentity, loadPromptExtra(config.groupPromptFile)].filter(Boolean).join('\n\n')
  st.approvals ||= new ApprovalStore({
    ttlMs: Math.max(1, Number(config.approveTtlMinutes) || 10) * 60 * 1000,
    approvedMs: Math.max(1, Number(config.approvedHours) || 24) * 60 * 60 * 1000,
  })

  // 本地模型自启：宿主重启后 Ollama 不会自己回来，这里负责隐藏拉起。
  if (config.local?.autoStart !== false && !st.ollamaWatcher) {
    try {
      st.ollamaWatcher = startOllamaWatch(config.local, note)
    } catch (error) {
      note('Ollama 自启挂载失败：' + String((error && error.message) || error))
    }
  }

  const runtime = st.runtime ||= {
    signal: st.signal,
    config,
    identity,
    approvals: st.approvals,
    history: st.history,
    get memory() {
      try {
        return ctx.get?.('memory') || globalThis[Symbol.for('dsh-memory-unified.service')] || null
      } catch {
        return globalThis[Symbol.for('dsh-memory-unified.service')] || null
      }
    },
    get dialog() {
      try {
        return ctx.get?.('dialog') || globalThis[Symbol.for('dsh-dafeiyu-dialog.service')] || null
      } catch {
        return globalThis[Symbol.for('dsh-dafeiyu-dialog.service')] || null
      }
    },
    get brain() {
      try {
        return ctx.get?.('brain') || globalThis[Symbol.for('dsh-feiyu-brain.service')] || null
      } catch {
        return globalThis[Symbol.for('dsh-feiyu-brain.service')] || null
      }
    },
    llm: () => ctx.get?.('llm'),
    vision: {
      config: config.vision || {},
      account: () => {
        try {
          return ctx.get?.('deepseekAccount') || null
        } catch {
          return null
        }
      },
      // 看图走 dsh-vision 服务；没装就回退本地实现
      ask: (options) => {
        const svc = visionService(ctx)
        return svc?.askVision ? svc.askVision(options) : askVision(options)
      },
    },
    // 知识库优先用独立的 dsh-group-knowledge 服务；没装就回退自己开库，功能不丢。
    get knowledge() {
      try {
        const shared = ctx.get?.('knowledge')
        if (shared) return shared
      } catch {
        // 宿主没这个服务就继续往下
      }
      if (st.localKnowledge !== undefined) return st.localKnowledge
      if (config.knowledge?.enabled === false) {
        st.localKnowledge = null
        return null
      }
      try {
        st.localKnowledge = new KnowledgeStore(config.knowledge?.dbFile)
      } catch (error) {
        note('知识库初始化失败：' + String((error && error.message) || error))
        st.localKnowledge = null
      }
      return st.localKnowledge
    },
    // 图片 / 表情包 / GIF 库（渠道无关）：收到的图先进 recent 档，值得的进 saved 档
    get imageLibrary() {
      const cfg = config.imageLibrary || {}
      if (cfg.enabled === false) return null
      if (st.imageLibrary !== undefined) return st.imageLibrary
      try {
        st.imageLibrary = createImageLibrary({
          dir: cfg.dir || defaultImageLibraryDir(),
          maxFileBytes: Number(cfg.maxFileBytes) || undefined,
          maxRecentFiles: Number(cfg.maxRecentFiles) || undefined,
          maxRecentBytes: Number(cfg.maxRecentBytes) || undefined,
        })
        note(`图片库就绪：${st.imageLibrary.root}`)
      } catch (error) {
        note('图片库初始化失败：' + String((error && error.message) || error))
        st.imageLibrary = null
      }
      return st.imageLibrary
    },
    // 执行层：图片入库这种幂等副作用先落 SQLite 再执行，崩溃后下次启动能续上
    get exec() {
      const cfg = config.execLayer || {}
      if (cfg.enabled === false) return null
      if (st.execLayer !== undefined) return st.execLayer
      const lib = runtime.imageLibrary
      if (!lib) return null
      try {
        const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
        st.execLayer = createExecLayer({
          dir: cfg.dir || path.join(base, 'dafeiyu', 'exec'),
          imageLibrary: lib,
          tickMs: Number(cfg.tickMs) || 5000,
          maxAttempts: Number(cfg.maxAttempts) || 3,
          sendText: (payload) =>
            sendOneBot({
              httpUrl: config.httpUrl,
              token: config.accessToken,
              kind: payload.kind,
              targetId: payload.targetId,
              text: payload.text,
              timeoutMs: 30000,
            }),
          note,
        })
        if (st.execLayer) {
          note('执行层就绪：' + st.execLayer.file)
          st.own?.(() => st.execLayer?.close())
        }
      } catch (error) {
        note('执行层初始化失败（回退直写）：' + String((error && error.message) || error))
        st.execLayer = null
      }
      return st.execLayer
    },
    send: (payload) =>
      sendOneBot({ httpUrl: config.httpUrl, token: config.accessToken, ...payload }),
    log: (payload) => {
      try {
        appendChat({ channel: 'qq', ...payload })
      } catch (error) {
        note('chatlog 写入失败：' + String((error && error.message) || error))
      }
    },
    limiter: st.limiter,
  }

  // 图片库以服务形式对外：vision_describe 已迁到 dsh-vision，看图后的入库要跨插件取
  if (!st.imageLibraryService) {
    const imageLibraryService = {
      get current() {
        return runtime.imageLibrary
      },
      remember: (payload) => {
        const lib = runtime.imageLibrary
        return lib ? lib.remember(payload) : { ok: false }
      },
    }
    try {
      ctx.provide?.('imageLibrary', imageLibraryService)
    } catch (error) {
      note('图片库服务注册失败：' + String((error && error.message) || error))
    }
    globalThis[Symbol.for('dsh-image-library.service')] = imageLibraryService
    st.imageLibraryService = imageLibraryService
    st.own(() => {
      if (globalThis[Symbol.for('dsh-image-library.service')] === imageLibraryService) {
        delete globalThis[Symbol.for('dsh-image-library.service')]
      }
    })
  }

  if (!st.resourcesOwned) {
    st.resourcesOwned = true
    st.own(() => {
      st.socket?.close?.()
      st.ollamaWatcher?.()
      // 只关自己开的库；共享给 dsh-group-knowledge 的不归 qq 管
      st.localKnowledge?.close?.()
      st.localKnowledge = undefined
    })
  }

  if (!st.clientVisionInstalled) {
    st.clientVisionInstalled = true
    try {
      // 客户端图片上下文注入属于感知层：优先让 dsh-vision 装，没装自己装
      const visionSvc = visionService(ctx)
      if (visionSvc?.installClientVisionContext) visionSvc.installClientVisionContext(ctx, { note })
      else installClientVisionContext(ctx, { note })
    } catch (error) {
      note('客户端图片上下文注入安装失败：' + String((error && error.message) || error))
    }
  }

  // 客户端拖图也要能进库：拖进来的图只带 attachment id，靠 llm/stream 观察器 + 附件目录监视读出来
  if (!st.clientImageInstalled) {
    st.clientImageInstalled = true
    st.clientImageSeen ||= new Set()
    const rememberClientImage = (image) => {
      const lib = runtime.imageLibrary
      if (!lib || !image?.bytes?.length) return null
      try {
        const saved = lib.remember({
          bytes: image.bytes,
          mediaType: image.mediaType,
          source: { channel: 'client', kind: 'attachment', messageId: image.attachmentId || '' },
        })
        if (!saved.ok) return null
        st.lastImage = { ids: [saved.record.id], at: Date.now(), conversation: 'client' }
        note(`客户端图片已入库：${saved.record.id}`)
        return saved.record.id
      } catch (error) {
        note('客户端图片入库失败：' + String((error && error.message) || error))
        return null
      }
    }
    try {
      installClientImageLibrary(ctx, {
        note,
        seen: st.clientImageSeen,
        onImages: (images) => {
          const ids = images.map(rememberClientImage).filter(Boolean)
          if (ids.length) st.lastImage = { ids, at: Date.now(), conversation: 'client' }
        },
      })
    } catch (error) {
      note('客户端图片入库安装失败：' + String((error && error.message) || error))
    }
    try {
      st.attachmentWatcher = installAttachmentWatcher({
        note,
        onImage: (image) => {
          const key = image.attachmentId || ''
          if (key && st.clientImageSeen.has('a:' + key)) return
          if (key) {
            st.clientImageSeen.add('a:' + key)
            if (st.clientImageSeen.size > 64) st.clientImageSeen.delete(st.clientImageSeen.values().next().value)
          }
          rememberClientImage(image)
        },
      })
      st.own(() => st.attachmentWatcher?.())
    } catch (error) {
      note('附件目录监视安装失败：' + String((error && error.message) || error))
    }
  }
  // 工具注册已抽到 lib/tools.js（2026-11-04，阶段 2.1）
  registerQqTools({ ctx, st, config, runtime, note })

  if (config.enabled && !st.started) {
    st.started = true
    // 客户端启动先看 QQ 桥在不在：只探测状态（不再自动拉起），微心跳没跑也顺手拉起。
    // 自愈优先走 dsh-service-autostart 服务；它没装就回退自己这份，功能不丢。
    const auto = autostartService(ctx)
    if (auto?.ensureServices) void auto.ensureServices({ config: runtime.config, state: st, note })
    else void ensureServices({ config: runtime.config, state: st, note })
    connect(ctx, runtime, st)
  }

  declareSelf(ctx, runtime, st)
  st.ready = true
  note(`dsh-qq-adapter 就绪（ws=${config.wsUrl}，http=${config.httpUrl}，enabled=${config.enabled}）`)
}

/** 把连接与收发计数报给 self，让「qq 现在怎么样」可查。 */
function declareSelf(ctx, runtime, st) {
  try {
    const self = ctx.get?.('self') || globalThis[Symbol.for('dsh-feiyu-self.service')]
    if (typeof self?.declare !== 'function') return
    self.declare({
      id: 'qq',
      package: 'dsh-qq-adapter',
      intent: '收发 QQ 消息：群内 @ 接话、非 @ 交微心跳、陌生人私聊先问主人',
      limits: ['不能主动加好友或拉群', '不自动拉起 QQ 桥，只探测状态', '群知识按群隔离，不跨群召回', '同一条消息最多发送一次'],
      failureModes: [
        { code: 'NAPCAT_DOWN', meaning: 'ws 3001 不可达', retry: '退避重连，冷却后尝试拉起' },
        { code: 'ACCOUNT_RESTRICTED', meaning: '账号被平台限制功能', retry: '停止自动拉起，等人工处理' },
      ],
      scope: ['group', 'private', 'owner'],
      state: () => ({
        enabled: runtime.config?.enabled !== false,
        connected: Boolean(st.connected),
        replied: Number(st.replied) || 0,
        ignored: Number(st.ignored) || 0,
        queued: Number(st.queued) || 0,
        lastError: String(st.lastError || ''),
      }),
    })
  } catch {
    // self 没装也不影响收发
  }
}


