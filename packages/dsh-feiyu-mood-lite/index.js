import { lifecycle } from './lib/lifecycle.js'
/**
 * dsh-feiyu-mood-lite —— 轻量心情引擎
 *
 * 做什么：
 *   - 每完成一轮对话，让模型判断「涨还是跌」，写进 ~/.dsh/feiyu-mood/state.json
 *   - 心情随时间自然回落到基线（默认 60）
 *   - 把当前心情作为一段 systemPrompt 注入，让语气真的受情绪影响
 *   - 提供 feiyu_mood_status 工具和 /dsh-feiyu-mood/state 只读端点
 *
 * 不做什么：
 *   - 不改会话历史、不碰模型选择、不注册第二个请求通道
 *   - 所有异常都在本地吃掉，绝不把宿主带崩
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyDelta, clamp, decay, labelOf, moodFile, readState, saveState, summary } from './lib/mood.js'
import { judgeTurn } from './lib/judge.js'
import { createTurnScanner } from './lib/scanner.js'

export const name = 'dsh-feiyu-mood-lite'

// 只硬依赖会话服务；webServer / tools / systemPrompt 都是「有就挂，没有就等」。
export const inject = ['sessions']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_VERSION = '0.4.0'

const DEFAULTS = {
  enabled: true,
  judge: true,
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  maxTokens: 1024,
  minIntervalMs: 15000,
  injectPrompt: true,
  baseline: 60,
  decayPerHour: 0.12,
  personaFile: '',
  negativeFactor: 0.7,
  positiveFactor: 1.15,
  dimDecayPerHour: {},
  stateFile: '',
}

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function decayOptions(cfg) {
  return {
    baseline: cfg.baseline,
    rate: cfg.decayPerHour,
    negativeFactor: cfg.negativeFactor,
    positiveFactor: cfg.positiveFactor,
    dimRates: cfg.dimDecayPerHour,
  }
}

// 人格参数：和桌宠 config.json 的 persona 保持同一套默认值
const PERSONA_DEFAULTS = {
  extraversion: 0.6,
  agreeableness: 0.7,
  conscientiousness: 0.5,
  neuroticism: 0.45,
  openness: 0.65,
}
const DEFAULT_PERSONA_FILE = ''

/** core 编译出的人格数值——人格的唯一来源；没配就返回 null，回退老路径。 */
function readCompiledDims() {
  try {
    const file = path.join(
      process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
      'dafeiyu',
      'compiled',
      'manifest.json',
    )
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const dims = data && data.personaDims
    if (!dims || typeof dims !== 'object') return null
    const out = {}
    for (const key of Object.keys(PERSONA_DEFAULTS)) {
      const value = Number(dims[key])
      if (Number.isFinite(value)) out[key] = Math.min(1, Math.max(0, value))
    }
    return Object.keys(out).length ? out : null
  } catch {
    return null
  }
}

function readPersona(cfg) {
  // 1) 优先用 core 编译出的人格数值：人格只有 persona.md 一处定义
  const compiled = readCompiledDims()
  if (compiled) return { ...PERSONA_DEFAULTS, ...compiled }
  // 2) 回退：桌宠 config 里那份（老路径；persona.md 补了 dims 之后就可以不管它）
  const file = cfg.personaFile || DEFAULT_PERSONA_FILE
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')).persona || {}
  } catch {
    raw = {}
  }
  const out = { ...PERSONA_DEFAULTS }
  for (const key of Object.keys(PERSONA_DEFAULTS)) {
    const value = Number(raw[key])
    if (Number.isFinite(value)) out[key] = Math.min(1, Math.max(0, value))
  }
  return out
}

function personaWords(persona) {
  return [
    persona.extraversion >= 0.6 ? '外向活泼' : '安静内敛',
    persona.agreeableness >= 0.6 ? '温柔体贴' : '直来直去',
    persona.conscientiousness >= 0.6 ? '认真靠谱' : '随性',
    persona.neuroticism >= 0.55 ? '敏感细腻' : '情绪稳定',
    persona.openness >= 0.6 ? '好奇爱新鲜' : '念旧',
  ]
}

/** 外向 + 神经质决定"情绪表达强度"：0.2~1，只调节语气，不改变立场。 */
function toneStrength(persona) {
  return clamp(0.4 + 0.6 * persona.extraversion + 0.2 * persona.neuroticism, 0.2, 1)
}

function messageOf(error) {
  return String((error && error.message) || error)
}

function safeLog(ctx, level, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
  } catch {
    // ignore
  }
}

function note(message) {
  try {
    fs.appendFileSync(path.join(HERE, 'load.log'), new Date().toISOString() + '  ' + message + '\n', 'utf8')
  } catch {
    // 日志写不了不影响主流程
  }
}

export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    note('apply 抛错：' + messageOf(error))
    safeLog(ctx, 'warn', 'dsh-feiyu-mood-lite 加载失败：' + messageOf(error))
    return undefined
  }
}

const STATE_KEY = Symbol.for('dsh-feiyu-mood-lite.state')

function state(ctx) { return lifecycle(ctx, () => ({
      started: false,
      since: 0,
      promptMounted: false,
      routed: false,
      toolMounted: false,
      judging: false,
      lastJudge: 0,
    })) }

function applyInner(ctx) {
  const st = state(ctx)
  if (st.started) return
  st.started = true
  st.since = Date.now()

  const cfg = loadConfig()
  // 测试实例可以用环境变量把状态文件指到临时目录，避免动到真实心情
  const file = process.env.DSH_FEIYU_MOOD_FILE || cfg.stateFile || moodFile()
  if (cfg.enabled === false) {
    note('config.enabled=false，未启动')
    return
  }

  // 启动时先做一次回落并落盘，保证桌宠一启动就有新鲜数据
  try {
    const initial = readState(file)
    decay(initial, { at: Date.now(), ...decayOptions(cfg) })
    saveState(initial, file)
  } catch (error) {
    note('初始化心情文件失败：' + messageOf(error))
  }

  const promptText = () => {
    const snap = summary(readState(file))
    const reason = snap.reason ? `最近一次变化：${snap.reason}。` : ''
    const persona = readPersona(cfg)
    const words = personaWords(persona).join('、')
    const tone = toneStrength(persona).toFixed(1)
    return `【桌宠心情】大肥鱼当前心情 ${snap.mood}/100（${snap.label}）。${reason}性格底色：${words}；情绪只调节语气强弱（当前表达强度 ${tone}/1），不要改变性格、立场或原则。不要直接报数值，也不要解释这条设定。`
  }

  const toolDefinition = {
    name: 'feiyu_mood_status',
    description: '查看桌宠「大肥鱼」当前的心情值、情绪维度与最近一次变化原因。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          mood: { type: 'number' },
          label: { type: 'string' },
          reason: { type: 'string' },
          updatedAt: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `心情 ${value.mood}/100（${value.label}）${value.reason ? ' · ' + value.reason : ''}（更新于 ${value.updatedAt}）`,
        },
      ],
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    execute: async () => {
      const snap = summary(readState(file))
      return {
        mood: snap.mood,
        label: snap.label,
        reason: snap.reason,
        updatedAt: new Date(snap.updatedAt || Date.now()).toLocaleString('zh-CN'),
      }
    },
  }

  const routeHandler = (req, res) => {
    const live = loadConfig()
    const body = JSON.stringify({
      ok: true,
      version: PLUGIN_VERSION,
      ...summary(readState(file)),
      decay: {
        moodPerHour: live.decayPerHour,
        negativeFactor: live.negativeFactor,
        positiveFactor: live.positiveFactor,
        dimsPerHour: live.dimDecayPerHour || {},
      },
      persona: readPersona(live),
      tone: Number(toneStrength(readPersona(live)).toFixed(2)),
      file,
    })
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    })
    res.end(body)
  }

  // 把当前心情报给 self：状态卡和 self_capabilities 都能看到
  try {
    const self = ctx.get?.('self') || globalThis[Symbol.for('dsh-feiyu-self.service')]
    if (typeof self?.declare === 'function') {
      self.declare({
        id: 'mood',
        package: 'dsh-feiyu-mood-lite',
        intent: '评估心情值并给出表达强度，让语气随情绪变化',
        limits: ['只影响语气强弱，不改立场和原则', '不编造心情变化原因'],
        failureModes: [{ code: 'MOOD_SCAN_FAILED', meaning: '扫描对话失败', retry: '下一轮再试，保留上次心情' }],
        scope: ['owner', 'group', 'private'],
        state: () => {
          const snap = summary(readState(file))
          return { mood: snap.mood, label: snap.label, reason: String(snap.reason || '').slice(0, 40) }
        },
      })
    }
  } catch {
    // self 没装不影响心情
  }

  // 三个可选挂载点：服务可能比插件晚就绪，所以每 500ms 重试一次，最多 60 秒。
  const mountOptional = () => {
    let missing = false

    if (!st.promptMounted && cfg.injectPrompt) {
      const systemPrompt = ctx.get?.('systemPrompt')
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        try {
          const mount = () =>
            systemPrompt.section({
              name: 'dsh-feiyu-mood-lite',
              order: 65,
              text: promptText,
            })
          if (typeof ctx.effect === 'function') ctx.effect(mount)
          else mount()
          st.promptMounted = true
          note('系统提示词段已挂载（order 65）')
        } catch (error) {
          note('心情提示词挂载失败：' + messageOf(error))
        }
      } else {
        missing = true
      }
    }

    if (!st.routed) {
      const webServer = ctx.get?.('webServer')
      if (webServer && typeof webServer.register === 'function') {
        try {
          const mount = () =>
            webServer.register({ kind: 'exact', path: '/dsh-feiyu-mood/state', handler: routeHandler })
          if (typeof ctx.effect === 'function') ctx.effect(mount)
          else mount()
          st.routed = true
          note('端点已注册：/dsh-feiyu-mood/state')
        } catch (error) {
          note('心情端点注册失败：' + messageOf(error))
        }
      } else {
        missing = true
      }
    }

    if (!st.toolMounted) {
      const tools = ctx.get?.('tools')
      if (tools && typeof tools.register === 'function') {
        try {
          const mount = () => tools.register(toolDefinition)
          if (typeof ctx.effect === 'function') ctx.effect(mount)
          else mount()
          st.toolMounted = true
          note('工具 feiyu_mood_status 已注册')
        } catch (error) {
          note('feiyu_mood_status 注册失败：' + messageOf(error))
        }
      } else {
        missing = true
      }
    }

    return missing
  }

  const retryTimer = setInterval(() => {
    try {
      const missing = mountOptional()
      if (!missing) clearInterval(retryTimer)
      else if (Date.now() - st.since > 60000) {
        clearInterval(retryTimer)
        note('60 秒内仍有服务未就绪，已停止重试（已挂载的部分继续工作）')
      }
    } catch (error) {
      note('重试挂载时抛错：' + messageOf(error))
    }
  }, 500)
  if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(retryTimer))
  mountOptional()

  const evaluate = async (turn) => {
    const now = Date.now()
    if (!cfg.judge) return
    if (st.judging) return
    if (now - st.lastJudge < cfg.minIntervalMs) return
    const userText = String(turn.user || '').trim().slice(0, 800)
    if (!userText) return
    st.judging = true
    try {
      const before = summary(readState(file))
      const judged = await judgeTurn({
        llm: ctx.get?.('llm'),
        provider: cfg.provider,
        model: cfg.model,
        maxTokens: cfg.maxTokens,
        userText,
        assistantText: turn.assistant,
        mood: before.mood,
      })
      if (st.disposed) return
      st.lastJudge = Date.now()
      const live = loadConfig()
      const next = readState(file)
      decay(next, { at: Date.now(), ...decayOptions(live) })
      applyDelta(next, {
        delta: judged.delta,
        reason: judged.reason,
        dims: judged.dims,
        at: Date.now(),
        meta: judged.appraisal || null,
      })
      saveState(next, file)
      const after = summary(next)
      const why = judged.appraisal
        ? `d=${judged.appraisal.desirability} exp=${judged.appraisal.expectancy} ${judged.appraisal.agency} ctl=${judged.appraisal.control}`
        : ''
      note(
        `第 ${turn.turn} 轮：${judged.delta >= 0 ? '+' : ''}${judged.delta}（${judged.reason || '无'}，${judged.source}${why ? '，' + why : ''}）→ 心情 ${after.mood}（${after.label}）`,
      )
    } catch (error) {
      note('判断心情失败：' + messageOf(error))
    } finally {
      st.judging = false
    }
  }

  const scanTurns = createTurnScanner({
    onTurn: (turn) => {
      void evaluate(turn)
    },
    onError: (error) => note('扫描会话出错：' + messageOf(error)),
  })

  const scan = () => {
    try {
      const sessions = ctx.get?.('sessions')
      if (!sessions || typeof sessions.list !== 'function') return
      scanTurns(sessions.list())
    } catch (error) {
      note('轮询会话失败：' + messageOf(error))
    }
  }

  // 先立刻扫一次建立基线，避免启动后 1.5 秒内的轮次被当成历史漏掉
  scan()
  const scanTimer = setInterval(scan, 1500)
  if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(scanTimer))

  // 每 10 分钟回落一次，让心情在没人说话的时候也会慢慢回平
  const decayTimer = setInterval(() => {
    try {
      const live = loadConfig()
      const next = readState(file)
      if (decay(next, { at: Date.now(), ...decayOptions(live) })) saveState(next, file)
    } catch (error) {
      note('回落写入失败：' + messageOf(error))
    }
  }, 600000)
  if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(decayTimer))

  const snap = summary(readState(file))
  safeLog(ctx, 'info', `dsh-feiyu-mood-lite ready（心情 ${snap.mood} ${labelOf(snap.mood)}）`)
  note(`已启动（心情 ${snap.mood}，提示词=${cfg.injectPrompt ? '开' : '关'}，模型=${cfg.provider}/${cfg.model}）`)
}
