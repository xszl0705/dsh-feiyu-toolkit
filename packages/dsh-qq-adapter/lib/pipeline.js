/**
 * 事件主链路：OneBot 帧 → 入队 → 处理（图片 / 知识 / 记忆 / 策略）→ 回复 → 落盘。
 *
 * 2026-11-04 从 index.js 抽出（方案 v3 / 阶段 2.1）：index 只留配置、apply、连接与工具注册。
 * runtime / st / ctx / note 全部走参数，辅助函数随本模块一起搬，避免状态分家。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { note as kitNote } from 'dsh-plugin-kit/note'
import fs from 'node:fs'
import os from 'node:os'
import { parseEvent, shouldAnswer, RateLimiter } from './onebot.js'
import { recordTrigger } from './trigger.js'
import { generateReply, askLLM } from './reply.js'
import { judgeSticker, heuristicJudge } from './image-judge.js'
import { parseStickerIntent } from './sticker-intent.js'
import { publicDownload } from './public-download.js'
import { sendOneBot, setGroupAddRequest } from './send.js'
import { normalizePolicy, createPolicyState, decideCandidate, markMessage, markSilence, wakeOnAddress, isWake } from './group-policy.js'
import { loadPolicyState, savePolicyState } from './group-policy-store.js'
import { appendGroupMessage, groupContextVersion, recentGroupMessages } from './group-context.js'
import { runGateLocal } from './gate-local.js'
import { createPlan, recheckPlan, markPlan } from './planned.js'
import { KnowledgeStore, extractUrls } from './knowledge.js'
import { recordGroupMessage } from './subscribe-shadow.js'

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
function note(message) {
  try {
    kitNote(HERE, message)
  } catch {
    // 落盘失败不影响主链路
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


export async function handleEvent(event, { config, identity, llm, local, vision = null, send, log, limiter, history = [], memory = [], recent = [], groupRecent = [], knowledge = [], contextPlan = null, forceBig = false, contextMs = 0, onResult = null, validate = null, signal, now = Date.now() }) {
  // 阶段 1.2 影子模式：只记录 fast path 与现网判断的差异，不影响下面的行为
  recordTrigger(event, config, { now })
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
    memoryScope: scopeOf(event, config?.ownerId || ''),
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


export function memoryAllowed(event, ownerId) {
  return event?.kind === 'private' && String(event.userId) === String(ownerId)
}

/**
 * 记忆档位（2026-11-02）：owner 私聊给全量；群聊与陌生人只给 visibility=public 的条目。
 * 公开档只该放关系、称呼、公开形象这类能对外讲的事，隐私仍由写入侧把关。
 */
export function memoryVisibility(event, ownerId) {
  if (event?.kind === 'private' && String(event.userId) === String(ownerId)) return ''
  return 'public'
}

function memoryHits(runtime, event) {
  if (!runtime.memory) return []
  try {
    return runtime.memory.search(event.text, {
      limit: 5,
      visibility: memoryVisibility(event, runtime.config.ownerId || ''),
    }) || []
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

/** 收到的图片先落库（recent 档），并带上 bytes 给视觉用，避免同一张图下载两遍。 */
async function prepareEventImages(runtime, event, st) {
  const lib = runtime.imageLibrary
  const list = Array.isArray(event.images) ? event.images : []
  if (!lib || !list.length) return []
  const cfg = runtime.config.imageLibrary || {}
  const maxBytes = Number(cfg.maxFileBytes) || lib.maxFileBytes
  const timeoutMs = Number(cfg.downloadTimeoutMs) || 20000
  const out = []
  for (const image of list.slice(0, 4)) {
    try {
      let bytes = Buffer.isBuffer(image?.bytes) && image.bytes.length ? image.bytes : null
      if (!bytes) {
        const url = String(image?.url || image?.file || '').trim()
        if (!url) continue
        const res = await publicDownload(url, { maxBytes, timeoutMs })
        bytes = Buffer.from(res.bytes)
      }
      if (bytes.length > maxBytes) {
        note(`图片过大跳过入库：${bytes.length}B`)
        continue
      }
      const source = {
        channel: 'qq',
        kind: event.kind,
        userId: event.userId,
        groupId: event.groupId,
        messageId: event.messageId,
        name: event.senderName,
      }
      const exec = runtime.exec
      if (exec) {
        const ingested = await exec.ingestImage({ bytes, source })
        if (!ingested.ok) {
          // 入队失败/还在排队：图仍交给视觉，只是这次没有库内 id
          note(`图片入库未完成：${ingested.reason || ingested.status}`)
          out.push({ ...image, bytes })
          continue
        }
        out.push({ ...image, id: ingested.id, bytes, mediaType: ingested.mediaType, animated: ingested.animated })
        continue
      }
      const saved = lib.remember({ bytes, source })
      if (!saved.ok) {
        note(`图片未入库：${saved.reason}`)
        continue
      }
      out.push({ ...image, id: saved.record.id, bytes, mediaType: saved.record.mediaType, animated: saved.record.animated })
    } catch (error) {
      note('图片下载/入库失败：' + String((error && error.message) || error))
    }
  }
  if (out.length) {
    st.lastImage = {
      ids: out.map((x) => x.id),
      at: Date.now(),
      conversation: event.kind === 'private' ? `private:${event.userId}` : `group:${event.groupId}`,
    }
  }
  return out
}

/** 主人说「存这个 / 别存」：改收藏档，返回要写进回复上下文的一句话。只有主人私聊能触发。 */
function applyStickerIntent(runtime, event, st, prepared, ownerId = '') {
  const lib = runtime.imageLibrary
  if (!lib || event.kind !== 'private') return ''
  if (!ownerId || String(event.userId) !== String(ownerId)) return ''
  const intent = parseStickerIntent(event.text)
  if (!intent) return ''
  const recent = st.lastImage
  const fresh = Date.now() - Number(recent?.at || 0) < 30 * 60 * 1000
  const sameConversation = fresh && recent?.conversation === `private:${event.userId}`
  const ids = prepared?.length ? prepared.map((x) => x.id) : sameConversation ? [...recent.ids] : []
  if (!ids.length) return '没找到最近的图片：对方这次没发图，上一张也超过 30 分钟了，让他重发一张。'
  const touched = []
  for (const id of ids) {
    try {
      lib.update(id, intent.action === 'save' ? { saved: true } : { saved: false })
      touched.push(id)
    } catch {
      // 单张失败不影响其他
    }
  }
  if (!touched.length) return '图片不在库里（可能超过大小上限或格式不支持）。'
  if (intent.action !== 'save') return `已取消收藏（id=${touched[0]}）。`
  return `已把这张图收进表情包库（id=${touched[0]}${touched.length > 1 ? `，共 ${touched.length} 张` : ''}）。要用就用库里的文件路径发出去。`
}

/** 看完图之后：把描述写回库里；只有主人自己的图才会被自动收藏（autoSave）。 */
async function judgeAndSaveImages(runtime, prepared, caption, { autoSave = true } = {}) {
  const lib = runtime.imageLibrary
  if (!lib || !prepared?.length) return
  const cfg = runtime.config.imageLibrary?.judge || {}
  for (const image of prepared) {
    try {
      if (caption) lib.update(image.id, { caption })
      if (!autoSave || !caption) continue
      const verdict = await judgeSticker({ caption, animated: Boolean(image.animated), config: cfg })
      if (verdict?.save) {
        lib.update(image.id, { saved: true, tags: verdict.tags })
        note(`图片已收藏：id=${image.id} tags=${(verdict.tags || []).join(',')}（${verdict.reason}）`)
      }
    } catch (error) {
      note('图片判断失败：' + String((error && error.message) || error))
    }
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
      const queued = enqueueGroupMessage(runtime, event)
      if (queued) {
        st.queued += 1
        note(`群消息交给微心跳：group=${event.groupId} from=${event.senderName}`)
      } else {
        st.ignored += 1
      }
      // 2.2 影子（方案 v3）：config.subscribeShadow.enabled=true 才记，只写 JSONL，不改行为
      recordGroupMessage(runtime, st, event, { queued })
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
    // 优先用带 local-triage 分诊的异步版本；老版本 brain 没有它时退回同步 decideRoute。
    // conversation 传 hkey，给灰度 flag 做 sticky 分桶：同一个会话不会来回切。
    const route = (await runtime.brain?.decideRouteAsync?.(event.text, { conversation: hkey })) ||
      runtime.brain?.decideRoute?.(event.text) || { route: 'big', reason: 'no-brain' }
    const forceBig = route.route !== 'local'
    const intentInfo = runtime.brain?.classifyIntent?.(event.text) || { intent: 'chat', confidence: 0 }
    const contextStartedAt = Date.now()
    const bits = brainContext(runtime, event, ownerId, intentInfo.intent)
    const contextMsFor = Date.now() - contextStartedAt
    // 图片先入库（recent 档）：主人说「存这个」在这里生效；判断收藏不阻塞回复
    const preparedImages = await prepareEventImages(runtime, event, st)
    if (preparedImages.length) {
      event.images = preparedImages
      const stickerNote = applyStickerIntent(runtime, event, st, preparedImages, ownerId)
      if (stickerNote) event.stickerNote = stickerNote
    }
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
    if (preparedImages.length) {
      // 存图权限归主人：自动收藏是「我自己判断值得就存」，任何来源的图都可以；
      // 只有「存这个」这种手动指令才限定主人私聊。
      const autoSave = runtime.config.imageLibrary?.autoSave !== false
      // 看图回复本身就能当描述用，不需要再调一次视觉
      void judgeAndSaveImages(runtime, preparedImages, meta?.route === 'vision' ? String(reply || '') : '', { autoSave })
    }
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

export function scheduleReconnect(ctx, runtime, st) {
  if (st.disposed) return
  st.attempts += 1
  const delay = Math.min(60_000, 5_000 * st.attempts)
  st.later(() => {
    if (st.disposed || !st.config?.enabled) return
    // QQ 桥由用户 / SnowLuma 自己维护；这里只重连，不再尝试拉起桥。
    connect(ctx, runtime, st)
  }, delay)
}

/**
 * 往 st.history 记一轮对话（最多保留 10 条）。
 * 2026-11-04 修复：2.1 拆 index 时漏了搬它，pipeline 里两处调用报 `pushHistory is not defined`。
 */
export function pushHistory(st, key, userText, replyText) {
  const list = st.history.get(key) || []
  list.push({ role: 'user', text: String(userText || '').slice(0, 300) })
  list.push({ role: 'assistant', text: String(replyText || '').slice(0, 300) })
  while (list.length > 10) list.shift()
  st.history.set(key, list)
}

/**
 * 连 OneBot 桥：建 ws、绑事件、断线走 scheduleReconnect。
 * 2026-11-04 从 index.js 移入：scheduleReconnect 在 pipeline 里调它，放回 index 会形成反向 import。
 */
export function connect(ctx, runtime, st) {
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
    note('已连接 OneBot 桥：' + url)
    safeLog(ctx, 'info', 'dsh-qq-adapter 已连接 ' + url)
  })

  socket.addEventListener('message', (message) => {
    void onFrame(message?.data, runtime, st)
  })

  socket.addEventListener('close', () => {
    st.connected = false
    note('OneBot 桥连接断开')
    scheduleReconnect(ctx, runtime, st)
  })

  socket.addEventListener('error', () => {
    st.connected = false
    st.lastError = 'websocket error'
  })
}