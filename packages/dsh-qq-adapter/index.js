import { lifecycle } from './lib/lifecycle.js'
/**
 * dsh-qq-adapter — QQ 渠道适配器（NapCat / OneBot 11）
 *
 * 群白名单配置变更后需要重新 apply 才生效（这里没有文件监听）；改完会动一下本文件触发宿主热重载。
 *
 * 链路：
 *   NapCat 反向 WS 事件 → 过滤（私聊/@/白名单/限速）
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
import { cleanReply, loadIdentity } from './lib/prompt.js'
import { generateReply, askLLM } from './lib/reply.js'
import { askVision, askVisionBytes } from './lib/vision.js'
import { buildVisionContextPrompt } from './lib/vision-context.js'
import { installClientVisionContext } from './lib/client-vision-context.js'
import { ApprovalStore } from './lib/approval.js'
import { sendOneBot, setGroupAddRequest } from './lib/send.js'
import { normalizePolicy, createPolicyState, decideCandidate, markMessage, markSilence, wakeOnAddress, isWake } from './lib/group-policy.js'
import { loadPolicyState, savePolicyState } from './lib/group-policy-store.js'
import { appendGroupMessage, groupContextVersion, recentGroupMessages } from './lib/group-context.js'
import { runGateLocal } from './lib/gate-local.js'
import { createPlan, recheckPlan, markPlan } from './lib/planned.js'
import { KnowledgeStore, extractUrls } from './lib/knowledge.js'
import { appendChat } from './lib/chatlog.js'
import { startOllamaWatch } from './lib/ollama.js'
import { ensureNapCat, ensureServices } from './lib/autostart.js'

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
    // 日志失败不影响加载
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
 * 处理一条已解析事件（纯编排，便于测试）。
 * @returns {Promise<string|null>} 发出的回复；不回复返回 null
 */
export async function handleEvent(event, { config, identity, llm, local, vision = null, send, log, limiter, history = [], memory = [], recent = [], groupRecent = [], knowledge = [], contextPlan = null, forceBig = false, contextMs = 0, onResult = null, validate = null, signal, now = Date.now() }) {
  if (!shouldAnswer(event, config)) return null
  const key = `${event.kind}:${event.kind === 'group' ? event.groupId : event.userId}`
  if (limiter && !limiter.allow(key, now)) return null
  let result
  const totalUsage = { promptTokens: 0, outTokens: 0, cacheReadTokens: 0, totalTokens: 0 }
  const modelStartedAt = Date.now()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal?.throwIfAborted()
    result = await generateReply({
    identity,
    event,
    history,
    memory,
    recent,
    llm,
    local: config.local,
    vision,
    groupRecent,
    knowledge,
    contextPlan,
    maxChars: config.maxReplyChars || 120,
    maxTokens: config.maxTokens || 1000,
    forceBig: forceBig || attempt > 0,
    signal,
    samples: config.bestOfNSamples || 1,
    })
    for (const key of Object.keys(totalUsage)) totalUsage[key] += Number(result.usage?.[key]) || 0
    const invalid = typeof validate === 'function' && validate(result)
    if (invalid && attempt === 0) continue
    result = { ...result, usage: totalUsage, escalated: attempt > 0 }
    break
  }
  const modelMs = Date.now() - modelStartedAt
  signal?.throwIfAborted()
  const reply = result.text
  if (!reply) return null
  const sendStartedAt = Date.now()
  const sent = await send({
    kind: event.kind,
    targetId: event.kind === 'group' ? event.groupId : event.userId,
    text: reply,
  })
  const sendMs = Date.now() - sendStartedAt
  // 三段计时随结果回传，调用方塞进 stats，性能验证才有数据
  result = { ...result, contextMs: Number(contextMs) || 0, modelMs, sendMs }
  if (!sent || !sent.ok) return null
  logDecision({
    kind: 'reply',
    choice: 'sent',
    scope: event.kind === 'group' ? 'group' : event.userId === String(config?.ownerId || '') ? 'owner' : 'stranger',
    conversation: key,
    messageId: event.messageId,
    outcome: `${String(reply).length} chars`,
    cost: { tokens: Number(result.usage?.totalTokens) || 0 },
  })
  if (log) log({ moment: event.kind, text: reply, target: key, model: result.model })
  if (typeof onResult === 'function') onResult(result)
  return reply
}

function pushHistory(st, key, userText, replyText) {
  const list = st.history.get(key) || []
  list.push({ role: 'user', text: String(userText || '').slice(0, 300) })
  list.push({ role: 'assistant', text: String(replyText || '').slice(0, 300) })
  while (list.length > 10) list.shift()
  st.history.set(key, list)
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

  const tools = ctx.get?.('tools')
  if (!tools || typeof tools.register !== 'function') {
    // 宿主工具服务可能比插件晚就绪：250ms 重试，最多 60 秒（和 memory/diary 插件一致）
    if (!st.toolsSince) st.toolsSince = Date.now()
    if (!st.toolsWaiting && Date.now() - st.toolsSince < 60000) {
      st.toolsWaiting = true
      st.later(() => {
        st.toolsWaiting = false
        try {
          applyInner(ctx)
        } catch (error) {
          note('重试注册工具失败：' + String((error && error.message) || error))
        }
      }, 250)
    } else if (!st.toolsWaiting) {
      note('60s 内没等到 tools 服务，qq 未注册')
    }
    return
  }
  if (st.toolsRegistry !== tools) {
    st.toolsRegistry = tools
    ctx.effect(() => {
      const handles = []
      handles.push(
        tools.register({
          name: 'qq',
          description: 'QQ：action=status 看连接与收发计数 / send 手动发一条（kind=private|group，targetId 是 QQ 号/群号，text 是内容）。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['status', 'send'], description: '要做的事' },
              kind: { type: 'string', description: 'send 用：private 或 group' },
              targetId: { type: 'string', description: 'send 用：QQ 号 / 群号' },
              text: { type: 'string', description: 'send 用：要发的内容' },
            },
            required: ['action'],
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                action: { type: 'string' }, enabled: { type: 'boolean' }, connected: { type: 'boolean' },
                wsUrl: { type: 'string' }, replied: { type: 'number' }, ignored: { type: 'number' },
                queued: { type: 'number' }, lastError: { type: 'string' }, ok: { type: 'boolean' },
                detail: { type: 'string' }, error: { type: 'string' },
              },
            },
            render: (_args, v) => [{
              type: 'text',
              text: v.action === 'send'
                ? (v.ok ? '已发送' : '发送失败：' + v.detail)
                : (v.enabled
                  ? `QQ：${v.connected ? '已连接' : '未连接'}（${v.wsUrl}），已回复 ${v.replied} 条，忽略 ${v.ignored} 条，交微心跳 ${v.queued} 条${v.lastError ? '，最近错误：' + v.lastError : ''}`
                  : 'QQ 适配器已停用（config.enabled=false）'),
            }],
          },
          timeoutMs: 15000,
          isConcurrencySafe: () => false,
          execute: async (args) => {
            const action = String(args?.action || 'status')
            if (action === 'status') {
              return { action, enabled: Boolean(st.config?.enabled), connected: st.connected, wsUrl: st.config?.wsUrl || '', replied: st.replied, ignored: st.ignored, queued: st.queued, lastError: st.lastError }
            }
            if (action === 'send') {
              const kind = args?.kind === 'group' ? 'group' : 'private'
              try {
                const result = await sendOneBot({ httpUrl: config.httpUrl, token: config.accessToken, kind, targetId: String(args?.targetId || ''), text: cleanReply(args?.text, config.maxReplyChars) })
                return { action, ok: result.ok, detail: `${result.status} retcode=${result.retcode}` }
              } catch (error) {
                return { action, ok: false, detail: String((error && error.message) || error) }
              }
            }
            return { ok: false, action, error: '未知 action：' + action }
          },
        }),
      )
      handles.push(
        tools.register({
          name: 'vision_describe',
          description: '读取本地图片并用 DeepSeek 视觉模型描述；客户端拖图显示占位时，用这个兜底。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '图片绝对路径，或工作区相对路径' },
              question: { type: 'string', description: '想问图片什么；省略时描述内容' },
              useContext: { type: 'boolean', description: '是否检索相关记忆和最近对话，默认 true' },
            },
            required: ['path'],
          },
          output: {
            schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' }, detail: { type: 'string' } } },
            render: (_args, value) => [{ type: 'text', text: value.ok ? value.text : '看图失败：' + value.detail }],
          },
          timeoutMs: 60000,
          isConcurrencySafe: () => true,
          execute: async (args) => {
            try {
              const file = path.resolve(String(args?.path || ''))
              const stat = fs.statSync(file)
              if (!stat.isFile()) throw new Error('不是文件')
              if (stat.size > 8 * 1024 * 1024) throw new Error('图片超过 8MB')
              const ext = path.extname(file).toLowerCase()
              const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
              const question = String(args?.question || '先逐字读出图中的文字/数字，再描述布局、对象、异常和结论；不要泛泛而谈；看不清就说看不清。')
              let memory = []
              let recent = []
              if (args?.useContext !== false) {
                try {
                  memory = runtime.memory?.search?.(question, { limit: 5 }) || []
                } catch {
                  memory = []
                }
                try {
                  recent = runtime.dialog?.recent?.({ conversation: 'owner', limit: 6 }) || []
                } catch {
                  recent = []
                }
              }
              // 优先用 dsh-vision 服务；拿不到就回退本地实现
              const visionSvc = visionService(ctx)
              const prompt = (visionSvc?.buildVisionContextPrompt || buildVisionContextPrompt)({ question, memory, recent })
              const images = [{ mediaType: type, bytes: fs.readFileSync(file) }]
              const result = visionSvc?.askVisionBytes
                ? await visionSvc.askVisionBytes({ prompt, images, maxTokens: 800 })
                : await askVisionBytes({
                    account: runtime.vision.account(),
                    config: runtime.vision.config,
                    prompt,
                    images,
                    maxTokens: 800,
                  })
              return { ok: true, text: result.text, detail: '' }
            } catch (error) {
              return { ok: false, text: '', detail: String((error && error.message) || error) }
            }
          },
        }),
      )
      return () => {
        for (const handle of handles) {
          try {
            handle?.dispose?.()
          } catch {
            // ignore
          }
        }
      }
    })
  }

  if (config.enabled && !st.started) {
    st.started = true
    // 客户端启动先看 QQ 在不在：没连上就静默拉起 NapCat，微心跳没跑也顺手拉起。
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
      limits: ['不能主动加好友或拉群', '账号风控期不自动拉起 NapCat', '群知识按群隔离，不跨群召回', '同一条消息最多发送一次'],
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

function connect(ctx, runtime, st) {
  if (st.disposed) return
  const url = runtime.config.wsUrl
  let socket
  try {
    socket = new WebSocket(url)
  } catch (error) {
    st.lastError = String((error && error.message) || error)
    note('WebSocket 创建失败：' + st.lastError)
    scheduleReconnect(ctx, runtime, st)
    return
  }
  st.socket = socket

  socket.addEventListener('open', () => {
    st.connected = true
    st.attempts = 0
    st.lastError = ''
    note('已连接 NapCat：' + url)
    safeLog(ctx, 'info', 'dsh-qq-adapter 已连接 ' + url)
  })

  socket.addEventListener('message', (message) => {
    void onFrame(message?.data, runtime, st)
  })

  socket.addEventListener('close', () => {
    st.connected = false
    note('NapCat 连接断开')
    scheduleReconnect(ctx, runtime, st)
  })

  socket.addEventListener('error', () => {
    st.connected = false
    st.lastError = 'websocket error'
  })
}

export function memoryAllowed(event, ownerId) {
  return event?.kind === 'private' && String(event.userId) === String(ownerId)
}

function memoryHits(runtime, event) {
  if (!runtime.memory || !memoryAllowed(event, runtime.config.ownerId || '')) return []
  try {
    return runtime.memory.search(event.text, { limit: 5 }) || []
  } catch (error) {
    note('记忆检索失败：' + String((error && error.message) || error))
    return []
  }
}

function knowledgeHits(runtime, event) {
  if (!runtime.knowledge || event?.kind !== 'group') return []
  try {
    return runtime.knowledge.search(event.text, {
      limit: Math.max(1, Number(runtime.config.knowledge?.maxPerQuery) || 3),
      channel: 'qq-group',
      groupId: event.groupId,
    }) || []
  } catch (error) {
    note('知识库检索失败：' + String((error && error.message) || error))
    return []
  }
}

function ingestEventKnowledge(runtime, event) {
  if (!runtime.knowledge || event?.kind !== 'group') return
  if (runtime.config.knowledge?.ingestLinks !== false) {
    for (const url of extractUrls(event.text)) {
      runtime.knowledge
        .ingestLink(url, { groupId: event.groupId, sourceChannel: 'qq-group' })
        .catch(() => {})
    }
  }
}

function ingestVisionKnowledge(runtime, event, result) {
  if (!runtime.knowledge || event?.kind !== 'group' || !event.images?.length || result?.route !== 'vision') return
  try {
    runtime.knowledge.ingestImage({
      url: event.images[0].url,
      caption: result.text,
      groupId: event.groupId,
      sourceChannel: 'qq-group',
    })
  } catch {
    // 知识入库失败不影响回复
  }
}

function conversationKey(event, ownerId) {
  if (event.kind === 'private') {
    return String(event.userId) === String(ownerId) ? 'owner' : `private:${event.userId}`
  }
  return `group:${event.groupId}`
}

function scopeOf(event, ownerId) {
  if (event.kind === 'private') return String(event.userId) === String(ownerId) ? 'owner' : 'stranger'
  return 'group'
}

function brainContext(runtime, event, ownerId, intent = '') {
  if (!runtime.brain || typeof runtime.brain.buildContext !== 'function') return null
  try {
    return runtime.brain.buildContext({
      conversation: conversationKey(event, ownerId),
      text: event.text,
      scope: scopeOf(event, ownerId),
      intent,
    })
  } catch {
    return null
  }
}

function brainStat(runtime, event, ownerId, row) {
  if (!runtime.brain || typeof runtime.brain.recordStats !== 'function') return
  try {
    runtime.brain.recordStats({
      channel: 'qq',
      conversation: conversationKey(event, ownerId),
      // traceId：同一条入站消息触发的所有调用共享同一个值。
      // 没有它就只能算「每请求成本」，算不出「每任务成本」——
      // 而省 token 但多跑步数是净亏，必须按任务聚合才看得出来。
      traceId: event.messageId || '',
      eventKind: event.kind || '',
      ...row,
    })
  } catch {
    // ignore
  }
}

/** 群消息不直接回，交给微心跳判断。 */
function enqueueGroupMessage(runtime, event) {
  const text = String(event.text || '').trim()
  if (!text || /^\[(图片|语音|表情)\]$/.test(text)) return false
  const file = runtime.config.microGroupInbox || path.join(os.homedir(), '.dsh', 'dafeiyu', 'group-inbox.jsonl')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(
      file,
      JSON.stringify({
        at: new Date().toISOString(),
        groupId: event.groupId,
        userId: event.userId,
        senderName: event.senderName,
        text: text.slice(0, 200),
        messageId: event.messageId,
      }) + '\n',
      'utf8',
    )
    return true
  } catch {
    return false
  }
}

function dialogRecent(runtime, event) {
  if (!runtime.dialog) return []
  try {
    const rows = runtime.dialog.recent({ conversation: conversationKey(event, runtime.config.ownerId), limit: 6 })
    return Array.isArray(rows)
      ? rows.filter(
          (row) =>
            !/^(Current runtime context\.|Time sampled while preparing|Browser time zone|You are an AI agent powered)/.test(
              String(row?.text || '').trim(),
            ),
        )
      : []
  } catch {
    return []
  }
}

function logDialog(runtime, event, userText, reply, model = '') {
  if (!runtime.dialog) return
  const conversation = conversationKey(event, runtime.config.ownerId)
  try {
    runtime.dialog.append({ channel: 'qq', conversation, role: 'user', text: userText })
    runtime.dialog.append({ channel: 'qq', conversation, role: 'assistant', text: reply, model })
  } catch {
    // 对话总线写不了不影响回复
  }
}

/** 自愈服务：优先用独立插件，拿不到返回 null 由调用方回退。 */
function autostartService(ctx) {
  try {
    return ctx.get?.('autostart') || globalThis[Symbol.for('dsh-service-autostart.service')] || null
  } catch {
    return null
  }
}

/** 视觉服务：优先用独立插件，拿不到返回 null 由调用方回退。 */
function visionService(ctx) {
  try {
    return ctx.get?.('vision') || globalThis[Symbol.for('dsh-vision.service')] || null
  } catch {
    return null
  }
}

/** 记一条决策到 self 的日志；self 不在就跳过，绝不影响消息处理。 */
function logDecision(entry) {
  try {
    const self = globalThis[Symbol.for('dsh-feiyu-self.service')]
    self?.record?.({ channel: 'qq', ...entry })
  } catch {
    // 决策日志不可用不影响收发
  }
}

export function onFrame(data, runtime, st) {
  if (st.disposed) return Promise.resolve()
  let raw
  try { raw = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')) } catch { return Promise.resolve() }
  if (!raw || !['message', 'request'].includes(raw.post_type)) return Promise.resolve()
  if ((st.pendingFrames || 0) >= 100) { st.lastError = 'MESSAGE_QUEUE_FULL'; return Promise.resolve() }
  const key = `${raw.message_type || raw.request_type}:${raw.group_id || raw.user_id || ''}`
  const queues = st.frameQueues ||= new Map()
  st.pendingFrames = (st.pendingFrames || 0) + 1
  const promise = (queues.get(key) || Promise.resolve()).then(() => {
    if (!st.disposed) return processFrame(data, runtime, st)
  }).catch(error => { st.lastError = String(error?.message || error) }).finally(() => {
    st.pendingFrames -= 1
    if (queues.get(key) === promise) queues.delete(key)
  })
  queues.set(key, promise)
  return promise
}

async function processFrame(data, runtime, st) {
  let raw
  try {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
    raw = JSON.parse(text)
  } catch {
    return
  }
  if (!raw) return
  if (raw.post_type === 'request') {
    await onRequest(raw, runtime, st)
    return
  }
  if (raw.post_type !== 'message') return
  const event = parseEvent(raw, raw.self_id)
  if (!event) {
    st.ignored += 1
    return
  }
  // 风控/安全暂停：看门狗发现账号风险会创建该文件，所有自动回复停止
  const pauseFile = runtime.config.pauseFile || path.join(os.homedir(), '.dsh', 'dafeiyu', 'qq-paused.flag')
  try {
    if (fs.existsSync(pauseFile)) {
      note('QQ 已暂停（账号安全/风控），忽略消息')
      st.ignored += 1
      return
    }
  } catch {
    // 读不到暂停文件就继续
  }
  st.lastEventAt = Date.now()
  if (st.seen.has(event.messageId)) return
  st.seen.add(event.messageId)
  if (st.seen.size > 500) st.seen.delete(st.seen.values().next().value)

  if (event.kind === 'group' && !(runtime.config.groups || []).map(String).includes(String(event.groupId))) {
    st.ignored += 1
    logDecision({ kind: 'policy', choice: 'ignored', reason: 'group-not-allowlisted', scope: 'group', conversation: `group:${event.groupId}` })
    return
  }
  if (event.kind === 'group') {
    try {
      appendGroupMessage(event)
      ingestEventKnowledge(runtime, event)
    } catch {
      // 上下文写入失败不阻断
    }
  }

  // 不该回的消息不进模型、不记 stats，只留一行诊断日志
  if (!shouldAnswer(event, runtime.config)) {
    if (event.kind === 'group') {
      note(`群消息跳过：group=${event.groupId} atSelf=${event.atSelf} self=${event.selfId} text=${String(event.text).slice(0, 24)}`)
    }
    st.ignored += 1
    return
  }
  // 非 @ 的群唤醒限频，避免一句“鱼”就刷屏
  if (event.kind === 'group' && !event.atSelf) {
    const cooldown = Number(runtime.config.groupCooldownSeconds) || 0
    const last = st.groupLastReply.get(event.groupId) || 0
    if (cooldown > 0 && Date.now() - last < cooldown * 1000) {
      note(`群唤醒冷却中：group=${event.groupId} 剩余=${Math.ceil((cooldown * 1000 - (Date.now() - last)) / 1000)}s`)
      st.ignored += 1
      return
    }
  }

  const ownerId = String(runtime.config.ownerId || '')
  try {
    // 注入/危险请求：先拦，不调模型
    const guarded = runtime.brain?.guard?.(event.text)
    if (guarded?.blocked) {
      logDecision({ kind: 'guard', choice: 'blocked', reason: 'injection', scope: scopeOf(event, ownerId), messageId: event.messageId })
      const isStranger = event.kind === 'private' && ownerId && event.userId !== ownerId
      if (!isStranger) {
        await runtime.send({
          kind: event.kind,
          targetId: event.kind === 'group' ? event.groupId : event.userId,
          text: guarded.reply,
        })
      }
      brainStat(runtime, event, ownerId, { route: 'guard', model: '', ms: 0, blocked: true, reason: 'injection' })
      st.ignored += 1
      return
    }

    // 群消息里只有「没 @ 的」交给微心跳；@ 必须直接回
    if (event.kind === 'group' && !event.atSelf && runtime.config.microDecideGroup !== false) {
      const policy = normalizePolicy(runtime.config.policy)
      let decision = { candidate: true, probability: 1, reason: 'policy-disabled' }
      let state = null
      if (policy.enabled) {
        state = loadPolicyState(event.groupId, () => createPolicyState(Date.now(), policy))
        state = markMessage(state, Date.now(), policy)
        if (isWake(event.text, policy)) state = wakeOnAddress(state, Date.now())
        if (Number(state.silentUntil) > Date.now()) {
          savePolicyState(event.groupId, state)
          note(`群策略静默中：group=${event.groupId}`)
          st.ignored += 1
          return
        }
        decision = decideCandidate({ text: event.text, state, cfg: policy, now: Date.now() })
        savePolicyState(event.groupId, state)
      }
      if (!decision.candidate) {
        if (state) savePolicyState(event.groupId, markSilence(state, Date.now(), policy))
        note(`群策略移过：group=${event.groupId} p=${Number(decision.probability || 0).toFixed(3)} reason=${decision.reason}`)
        st.ignored += 1
        return
      }

      const recent = recentGroupMessages(event.groupId, { limit: 20, excludeId: event.messageId })
      const knowledge = knowledgeHits(runtime, event)
      let gate = null
      if (runtime.config.gate?.enabled !== false && String(event.text).trim().length >= 2) {
        try {
          gate = await runGateLocal({
            identity: runtime.identity,
            recent,
            candidate: { id: event.messageId, speaker: event.senderName, text: event.text },
            groupName: event.groupId,
            knowledge,
            config: runtime.config.gate || {},
          })
        } catch (error) {
          gate = { ok: false, action: 'silence', reason: 'gate-error:' + String(error?.message || error).slice(0, 80) }
          note(`gate 失败：${String(error?.message || error).slice(0, 120)}`)
        }
      }

      if (policy.mode === 'shadow') {
        let planInfo = null
        if (gate?.action === 'reply' || gate?.action === 'ask') {
          // shadow 要记下"本来会说什么"，否则切 live 前没法审。
          // 这里记的是 gate 给出的回复意图（reply_intent），不是完整回复——
          // 生成完整回复要再调一次云模型，shadow 不该为此花钱。
          const candidateText = gate.action === 'ask'
            ? String(gate.question || '')
            : String(gate.reply_intent || '')
          const plan = createPlan({
            groupId: event.groupId,
            sourceMessageId: event.messageId,
            action: gate.action,
            text: candidateText.slice(0, 200),
            contextVersion: groupContextVersion(event.groupId),
          })
          const check = recheckPlan({
            plan,
            contextVersion: groupContextVersion(event.groupId),
            newGate: gate,
          })
          planInfo = { id: plan.id, action: plan.action, wouldSay: plan.text, cancel: check.cancel, reason: check.reason }
          markPlan(plan, check.cancel ? 'cancelled' : 'shadow-only')
        }
        note(
          `shadow gate：group=${event.groupId} policy=${decision.candidate ? 'candidate' : 'skip'}${decision.probability != null ? ` p=${Number(decision.probability).toFixed(3)}` : ''} gate=${gate?.action || 'disabled'} rel=${gate?.relevance ?? '-'} plan=${planInfo ? JSON.stringify(planInfo) : 'none'} text=${String(event.text).slice(0, 24)}`,
        )
        st.ignored += 1
        return
      }

      if (gate && gate.action === 'silence') {
        if (state) savePolicyState(event.groupId, markSilence(state, Date.now(), policy))
        note(`gate 沉默：group=${event.groupId} reason=${gate.reason || 'silence'}`)
        st.ignored += 1
        return
      }
      if (gate && (gate.action === 'reply' || gate.action === 'ask')) {
        const plan = createPlan({
          groupId: event.groupId,
          sourceMessageId: event.messageId,
          action: gate.action,
          text: gate.action === 'ask' ? gate.question : '',
          contextVersion: groupContextVersion(event.groupId),
        })
        const check = recheckPlan({
          plan,
          contextVersion: groupContextVersion(event.groupId),
          newGate: gate,
        })
        if (check.cancel) {
          note(`发送前复检取消：group=${event.groupId} plan=${plan.id} reason=${check.reason}`)
          st.ignored += 1
          return
        }
        markPlan(plan, 'rechecked')
      }
      if (enqueueGroupMessage(runtime, event)) {
        st.queued += 1
        note(`群消息交给微心跳：group=${event.groupId} from=${event.senderName}`)
      } else {
        st.ignored += 1
      }
      return
    }

    // 主人私聊：先看是不是在回复审批
    if (event.kind === 'private' && ownerId && event.userId === ownerId) {
      const resolution = runtime.approvals.resolve(event.text)
      if (resolution?.status === 'approved') {
        const p = resolution.pending
        const ev = {
          kind: 'private',
          userId: p.userId,
          senderName: p.name,
          text: p.text,
          groupId: '',
          messageId: `approved-${p.userId}-${Date.now()}`,
          atSelf: false,
        }
        const hkey = `private:${p.userId}`
        const started = Date.now()
        let meta = null
        const reply = await handleEvent(ev, {
          config: runtime.config,
          identity: runtime.identity,
          llm: runtime.llm(),
          vision: runtime.vision,
          send: runtime.send,
          log: runtime.log,
          limiter: runtime.limiter,
          history: st.history.get(hkey) || [],
          groupRecent: event.kind === 'group' ? recentGroupMessages(event.groupId, { limit: 20, excludeId: event.messageId }) : [],
          knowledge: knowledgeHits(runtime, event),
          forceBig: true,
          onResult: (result) => {
            meta = result
          },
        })
        brainStat(runtime, ev, ownerId, {
          route: meta?.route || 'big',
          model: meta?.model || 'deepseek-flash',
          ms: Date.now() - started,
          escalated: false,
          blocked: false,
          promptTokens: meta?.usage?.promptTokens || 0,
          outTokens: meta?.usage?.outTokens || 0,
          cacheReadTokens: meta?.usage?.cacheReadTokens || 0,
          totalTokens: meta?.usage?.totalTokens || 0,
        })
        if (reply) {
          st.replied += 1
          pushHistory(st, hkey, p.text, reply)
          logDialog(runtime, ev, p.text, reply)
          runtime
            .send({ kind: 'private', targetId: ownerId, text: `已回复 ${p.name}：${reply}` })
            .catch(() => {})
        } else {
          st.ignored += 1
          runtime
            .send({ kind: 'private', targetId: ownerId, text: `回复 ${p.name} 失败（限频或模型出错），这次没发出去。` })
            .catch(() => {})
        }
        return
      }
      if (resolution?.status === 'denied') {
        runtime
          .send({ kind: 'private', targetId: ownerId, text: `已拒绝 ${resolution.pending.name}。` })
          .catch(() => {})
        return
      }
      // 不是审批指令：按普通主人消息继续
    }

    // 陌生人私聊：不生成回复，先问主人
    if (event.kind === 'private' && ownerId && event.userId !== ownerId && !runtime.approvals.isApproved(event.userId)) {
      runtime.approvals.ask({
        userId: event.userId,
        name: event.senderName,
        text: event.text,
        ownerId,
        send: runtime.send,
      })
      st.asked += 1
      return
    }

    const hkey = `${event.kind}:${event.kind === 'group' ? event.groupId : event.userId}`
    const route = runtime.brain?.decideRoute?.(event.text) || { route: 'big', reason: 'no-brain' }
    const forceBig = route.route !== 'local'
    const intentInfo = runtime.brain?.classifyIntent?.(event.text) || { intent: 'chat', confidence: 0 }
    const contextStartedAt = Date.now()
    const bits = brainContext(runtime, event, ownerId, intentInfo.intent)
    const contextMsFor = Date.now() - contextStartedAt
    const started = Date.now()
    let meta = null
    let escalated = false
    let reply = await handleEvent(event, {
      config: runtime.config,
      identity: runtime.identity,
      llm: runtime.llm(),
          vision: runtime.vision,
      send: runtime.send,
      log: runtime.log,
      limiter: runtime.limiter,
      history: st.history.get(hkey) || [],
      signal: runtime.signal,
      contextMs: contextMsFor,
      validate: result => (result.route === 'local' && runtime.brain?.shouldEscalate?.(result.text, event.text)) ||
        (intentInfo.intent === 'memory' && /记不清|不知道|忘了|没记/.test(result.text) && ((bits?.memory?.length || 0) > 0 || (bits?.recent?.length || 0) > 0)),
      memory: bits?.memory || memoryHits(runtime, event),
      recent: bits?.recent || dialogRecent(runtime, event),
      contextPlan: bits?.plan || null,
      groupRecent: event.kind === 'group' ? recentGroupMessages(event.groupId, { limit: 20, excludeId: event.messageId }) : [],
      knowledge: knowledgeHits(runtime, event),
      forceBig,
      onResult: (result) => {
        meta = result
        ingestVisionKnowledge(runtime, event, result)
      },
    })
    escalated = Boolean(meta?.escalated)
    if (reply) {
      brainStat(runtime, event, ownerId, {
        route: meta?.route || route.route,
        model: meta?.model || (forceBig ? 'deepseek-flash' : 'qwen3:4b'),
        ms: Date.now() - started,
        // 三段拆分：性能验证要知道慢在哪一段
        contextMs: Number(meta?.contextMs) || Number(contextMsFor) || 0,
        modelMs: Number(meta?.modelMs) || 0,
        sendMs: Number(meta?.sendMs) || 0,
        escalated,
        blocked: false,
        intent: intentInfo.intent,
        confidence: intentInfo.confidence,
        promptTokens: meta?.usage?.promptTokens || 0,
        outTokens: meta?.usage?.outTokens || 0,
        cacheReadTokens: meta?.usage?.cacheReadTokens || 0,
        totalTokens: meta?.usage?.totalTokens || 0,
      })
      st.replied += 1
      if (event.kind === 'group' && !event.atSelf) st.groupLastReply.set(event.groupId, Date.now())
      pushHistory(st, hkey, event.text, reply)
      logDialog(runtime, event, event.text, reply)
    } else {
      st.ignored += 1
    }
  } catch (error) {
    st.lastError = String((error && error.message) || error)
    note('处理消息失败：' + st.lastError)
  }
}

/** 处理群邀请/加群请求：只接受白名单群，避免被随便拉群。 */
async function onRequest(raw, runtime, st) {
  if (raw.request_type !== 'group') return
  const groupId = String(raw.group_id || '')
  const allowed = (runtime.config.groups || []).map(String).includes(groupId)
  if (!raw.flag || !allowed) {
    note(`忽略群请求：group=${groupId} sub=${raw.sub_type || ''}（不在白名单）`)
    return
  }
  try {
    const result = await setGroupAddRequest({
      httpUrl: runtime.config.httpUrl,
      token: runtime.config.accessToken,
      flag: raw.flag,
      subType: raw.sub_type || 'invite',
      approve: true,
    })
    note(`群邀请已同意：group=${groupId} ok=${result.ok} retcode=${result.retcode}`)
  } catch (error) {
    note('处理群邀请失败：' + String((error && error.message) || error))
  }
}

function scheduleReconnect(ctx, runtime, st) {
  if (st.disposed) return
  st.attempts += 1
  const delay = Math.min(60_000, 5_000 * st.attempts)
  st.later(() => {
    if (st.disposed || !st.config?.enabled) return
    // 每次重连前都确认一遍 NapCat 还活着；内部有冷却，不会造成启动风暴。
    const auto = autostartService(ctx)
    if (auto?.ensureNapCat) void auto.ensureNapCat({ config: st.config, state: st, note }).catch(() => {})
    else void ensureNapCat({ config: st.config, state: st, note }).catch(() => {})
    connect(ctx, runtime, st)
  }, delay)
}
