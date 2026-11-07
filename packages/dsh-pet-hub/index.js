import { lifecycle } from 'dsh-plugin-kit/lifecycle'
/**
 * dsh-pet-hub —— 把「心情挂件」「朗读桥卡片」「大肥鱼桌宠」合成一个浮层
 *
 * 分工：
 *   - 本插件：页面里只留一张卡片（心情 / 朗读 / 桌宠），并把原来的两块浮层隐藏。
 *   - dsh-pet-sync：继续负责桌宠进程的开停与随 DSH 退出（本插件通过它的 pet lib 控制）。
 *   - 心情：读 /dsh-feiyu-mood/state；朗读：读 /dsh-tts-bridge/state。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PET_DIR,
  defaultPythonw,
  petStatus,
  startPet,
  stopPet,
  switchForm,
} from 'dsh-plugin-kit/pet'
import { dshHome, readRecentWork } from './lib/body-memory.js'

export const name = 'dsh-pet-hub'

// 必须显式声明：cordis 里直接访问 ctx.webServer 而不 inject，会在 apply 时抛
// `cannot get property "webServer" without inject` —— 昨晚就是这个错。
export const inject = ['webServer']

const DEFAULTS = { petDir: DEFAULT_PET_DIR, pythonw: '' }

function loadConfig() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.json')
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function reply(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(body)
}

async function readJson(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (chunk) => {
      buf += chunk
      if (buf.length > 64 * 1024) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function safeLog(ctx, level, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
  } catch {
    // ignore
  }
}

/** 加载入口：任何异常都在这里吃掉并落到 hub-error.log，绝不让 apply 抛错。 */
export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const text = String((error && error.stack) || error)
    safeLog(ctx, 'warn', 'dsh-pet-hub 加载失败：' + text)
    try {
      fs.appendFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'hub-error.log'),
        new Date().toISOString() + '  ' + text + '\n',
        'utf8',
      )
    } catch {
      // ignore
    }
    return undefined
  }
}

const STATE_KEY = Symbol.for('dsh-pet-hub.state')

function state(ctx) { return lifecycle(ctx, () => ({ routed: false })) }

function applyInner(ctx) {
  // 同一进程只注册一次路由：cordis 会对同一插件多次调用 apply()，
  // 重复 register 同一路径会抛错，08:14 那次崩溃就是这么来的。
  const st = state(ctx)
  if (st.routed) return
  // 双保险：即使宿主没注入 webServer（或 cordis 异步化让 inject 失效），也只是不注册路由，不抛错。
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    safeLog(ctx, 'warn', 'dsh-pet-hub: 拿不到 webServer 服务，本次跳过路由注册')
    return
  }
  st.routed = true
  const cfg = loadConfig()
  const petDir = cfg.petDir || DEFAULT_PET_DIR
  const pythonw = cfg.pythonw || defaultPythonw()

  const route = (routePath, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: routePath,
        handler: async (req, res) => {
          // 浏览器来的请求一律拒：本地脚本/桌宠不会带 Origin。
          // 这样"随便一个网页发个 text/plain POST"就够不着 /pet 了（免预检 CSRF 的入口）。
          // 注意：req.headers 可能不存在（测试桩 / 非常规调用），空值也要安全。
          if (req.headers?.origin) {
            reply(res, 403, { ok: false, error: '拒绝浏览器来源（带 Origin 的请求）' })
            return
          }
          if (req.method === 'OPTIONS') {
            res.writeHead(204)
            res.end()
            return
          }
          try {
            await handler(req, res)
          } catch (error) {
            reply(res, 500, { ok: false, error: String((error && error.message) || error) })
          }
        },
      }),
    )

  // ── 写操作的令牌（2026-11-01）：/pet 与 /line 必须带 x-pet-token ──
  // 令牌落在 ~/.dsh/pet/hub-token，本地客户端读取后放进请求头。
  const TOKEN_FILE = path.join(
    dshHome(), 'pet', 'hub-token')
  const ensureToken = () => {
    try {
      if (!fs.existsSync(TOKEN_FILE)) {
        fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true })
        fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('hex'), 'utf8')
      }
      return fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    } catch {
      return ''
    }
  }
  const guard = (req, res) => {    const token = ensureToken()
    const got = String(req.headers['x-pet-token'] || '')
    if (!token || got !== token) {
      reply(res, 401, { ok: false, error: '需要 x-pet-token（令牌见 ~/.dsh/pet/hub-token）' })
      return false
    }
    return true
  }

  // 桌宠在跑时，改配置走指令队列（config.json 只归桌宠写）
  const pushPetCommand = (type, payload) => {
    try {
      const dir = path.dirname(TOKEN_FILE)
      fs.mkdirSync(dir, { recursive: true })
      const now = Date.now()
      const item = {
        id: 'c_' + Math.random().toString(16).slice(2, 14),
        type,
        from: 'pet-hub',
        ts: now,
        exp: now + 60000,
        payload: payload || {},
      }
      const line = JSON.stringify(item)
      if (Buffer.byteLength(line, 'utf8') > 8 * 1024) return null
      fs.appendFileSync(path.join(dir, 'inbox.jsonl'), line + '\n', 'utf8')
      return item.id
    } catch {
      return null
    }
  }

  // /line 会真的花钱：限到 6 次/分钟，别让本机某个循环把额度刷掉
  const lineWindow = { start: 0, count: 0 }
  const lineAllowed = () => {
    const now = Date.now()
    if (now - lineWindow.start > 60000) {
      lineWindow.start = now
      lineWindow.count = 0
    }
    if (lineWindow.count >= 6) return false
    lineWindow.count += 1
    return true
  }

  const status = async () => {
    const pet = await petStatus({ petDir, pythonw })
    let mood = null
    try {
      const file = path.join(dshHome(), 'feiyu-mood', 'state.json')
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const moods = raw && typeof raw === 'object' ? raw.moods : null
      const key = raw && typeof raw === 'object' ? raw.lastActive : null
      let entry = moods && key && moods[key] ? moods[key] : null
      if (!entry && moods && typeof moods === 'object') {
        entry = Object.values(moods).find((m) => m && typeof m.mood === 'number') || null
      }
      if (entry && typeof entry.mood === 'number') {
        mood = { value: Math.round(entry.mood), reason: String(entry.lastReason || '').slice(0, 40) }
      }
    } catch {
      mood = null
    }
    return { ok: true, pet, mood, at: Date.now() }
  }

  // 桌宠那张卡片不联网也能拿到「直播」数据：这里每 3 秒写一份快照文件。
  const homeDir = dshHome()
  const snapshotFile = path.join(homeDir, 'pet-hub-status.json')

  const readMemory = () => {
    // 真源是 memory-unified 的 SQLite 库（实测 25 主题 / 57 条）。
    // index.json 是 2026-10-27 的旧 JSON 后端遗留（3 主题 / 15 条），只当兜底，
    // 否则状态卡上的「记忆条数」会比实际低好几倍。
    try {
      const api = ctx.get?.('memory') || globalThis[Symbol.for('dsh-memory-unified.service')]
      const stats = api && typeof api.stats === 'function' ? api.stats() : null
      if (stats && Number.isFinite(Number(stats.items))) {
        return { folders: Number(stats.folders) || 0, items: Number(stats.items) || 0, source: 'service' }
      }
    } catch {
      // 服务没就绪：退回旧索引
    }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(homeDir, 'dsh-memory-unified', 'index.json'), 'utf8'))
      const folders = Array.isArray(raw && raw.folders) ? raw.folders : []
      const items = folders.reduce((sum, f) => sum + (Number(f && f.count) || 0), 0)
      return { folders: folders.length, items, source: 'index.json' }
    } catch {
      return { folders: 0, items: 0, source: 'none' }
    }
  }

  // 「任务完成」判定：看活跃会话的事件序号是否停止增长。
  // 一轮任务里 seq 会持续变大；连续 45 秒不动 = 这一轮结束了。
  const taskState = { seq: 0, growthAt: 0, startedAt: 0, settledAt: 0, lastTurnMs: 0, settled: true }

  const readTask = () => {
    let seq = 0
    try {
      const sessions = ctx.get?.('sessions')
      const list = sessions && typeof sessions.list === 'function' ? sessions.list() : []
      for (const session of list) seq += Number(session && session.seq) || 0
    } catch {
      seq = 0
    }
    const now = Date.now()
    if (seq > taskState.seq) {
      if (taskState.settled) taskState.startedAt = taskState.settled ? now : taskState.startedAt
      taskState.settled = false
      taskState.seq = seq
      taskState.growthAt = now
    } else if (!taskState.settled && taskState.growthAt && now - taskState.growthAt > 45000) {
      taskState.settled = true
      taskState.settledAt = now
      taskState.lastTurnMs = Math.max(0, taskState.growthAt - (taskState.startedAt || taskState.growthAt))
    }
    return {
      busy: !taskState.settled,
      settledAt: taskState.settledAt,
      lastTurnMs: taskState.lastTurnMs,
      seq: taskState.seq,
    }
  }

  const writeSnapshot = async () => {
    const base = await status()
    const port = ctx.webServer?.listenedPort || ctx.webServer?.port || 0
    let tts = null
    if (port) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/dsh-tts-bridge/state`)
        if (res.ok) {
          const data = await res.json()
          tts = { auto: !!data.auto, waiting: Number(data.waiting) || 0, playing: !!data.playing, next: data.next || null }
        }
      } catch {
        tts = null
      }
    }
    const snapshot = { at: Date.now(), port, pet: base.pet, mood: base.mood, memory: readMemory(), tts, task: readTask() }
    try {
      fs.mkdirSync(homeDir, { recursive: true })
      fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2), 'utf8')
    } catch (error) {
      safeLog(ctx, 'warn', 'dsh-pet-hub: 快照写入失败：' + String((error && error.message) || error))
    }
  }

  writeSnapshot()
  const snapshotTimer = setInterval(writeSnapshot, 3000)
  if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(snapshotTimer))

  // ---- 小剂量生成：特殊时刻向模型要一句话（凭据在 DSH 里，桌宠那侧不需要 key）----
  const collectText = async (stream) => {
    let out = ''
    let failure = ''
    for await (const chunk of stream) {
      const type = chunk && chunk.type
      if (type === 'text-delta') out += String(chunk.text ?? chunk.delta ?? '')
      else if (type === 'text') out += String(chunk.text ?? '')
      else if (type === 'finish') {
        const reason = (chunk && chunk.reason) || {}
        if (reason.kind === 'error') {
          const fail = reason.failure || {}
          failure = String(fail.message || fail.code || '模型调用失败')
        } else if (reason.kind === 'max-tokens') {
          failure = '输出上限太小（只有思考没有正文）'
        }
      }
    }
    return { text: out, failure }
  }

  const withTimeout = (promise, ms) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ])

  const tidyLine = (text) =>
    String(text || '')
      .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 40)

  // 主体内核（dsh-dafeiyu-core）编译出的桌宠模板；没有就退回内置提示词。
  // 身份只有一份，模板由 core 插件生成，这里只负责填场景变量。
  const readPetTemplate = () => {
    try {
      const file = path.join(
        dshHome(),
        'dafeiyu',
        'compiled',
        'pet.template.txt',
      )
      const text = fs.readFileSync(file, 'utf8')
      return text.trim() ? text : ''
    } catch {
      return ''
    }
  }

  const fillTemplate = (template, values) =>
    template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
      const value = values[key]
      return value === undefined || value === null || value === '' ? '' : String(value)
    })

  // 本体记忆读取挪到 lib/body-memory.js（与 dsh-pet-diary 同规则副本，contracts.mjs 钉一致性）

  const todayKey = () => {
    const d = new Date()
    const pad2 = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  }

  const buildPrompt = (moment, state) => {
    const mood = state && state.mood != null ? `此刻心情值 ${state.mood}` : ''
    const work = readRecentWork(todayKey(), { maxChars: 50 })
    const memory = work
      ? `你最近在忙：${work}`
      : state && state.memory
        ? `记忆库里有 ${state.memory} 条`
        : ''
    const away = state && state.awayMinutes ? `用户刚离开了约 ${state.awayMinutes} 分钟` : ''
    const scene = {
      return: '用户隔了很久刚回到电脑前',
      neglect: '用户已经很久没理你了',
      finish: '用户刚完成一件正事',
      morning: '一天刚开始',
    }[moment] || '普通时刻'

    const template = readPetTemplate()
    if (template) {
      return fillTemplate(template, { scene, away, mood, memory }).trim()
    }
    // 兜底：主体内核没装/没编译时用旧提示词
    return [
      '你是一只名叫「大肥鱼」的桌面宠物：性格俏皮机灵、有点小得意也爱撒娇。',
      '规则：只说一句话；不超过 18 个字；口语短句；可以用「呀/嘛/啦/诶」；',
      '不要解释、不要排比、不要说教、不要用表情符号、不要加引号。',
      `场景：${scene}。${away}。${mood}。`,
      memory ? `${memory}（只当背景，别复述、别报进度）` : '',
      '直接输出这句话本身。',
    ].join('\n')
  }

  // 日常对话留痕：只写「真实说出口的那句」，供事后翻看；不进 DSH 会话、不进工作记录。
  const logChat = (moment, text, model) => {
    try {
      const base = dshHome()
      const dir = path.join(base, 'pet-diary', 'chats')
      fs.mkdirSync(dir, { recursive: true })
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const key = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      const line = JSON.stringify({
        at: now.toISOString(),
        channel: 'pet',
        moment,
        text,
        model,
      })
      fs.appendFileSync(path.join(dir, `${key}.jsonl`), line + '\n', 'utf8')
    } catch (error) {
      safeLog(ctx, 'warn', 'dsh-pet-hub: chatlog 写入失败：' + String((error && error.message) || error))
    }
  }

  route('/dsh-pet-hub/line', async (req, res) => {
    if (!guard(req, res)) return
    if (!lineAllowed()) {
      reply(res, 429, { ok: false, error: '太频繁了（每分钟最多 6 次）' })
      return
    }
    const body = await readJson(req)
    const moment = String(body.moment || 'idle')
    const state = body.state || {}
    const llm = ctx.get?.('llm')
    if (!llm || typeof llm.stream !== 'function') {
      reply(res, 200, { ok: false, error: '宿主没有 llm 服务' })
      return
    }
    const prompt = buildPrompt(moment, state)
    const candidates = [
      { provider: 'deepseek-account', model: 'deepseek-flash' },
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    ]
    let lastError = ''
    for (const candidate of candidates) {
      try {
        const stream = llm.stream({
          ...candidate,
          maxTokens: 300,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        })
        const result = await withTimeout(collectText(stream), 20000)
        const text = tidyLine(result.text)
        if (text) {
          logChat(moment, text, candidate.model)
          reply(res, 200, { ok: true, text, provider: candidate.provider, model: candidate.model })
          return
        }
        if (result.failure) lastError = result.failure
      } catch (error) {
        lastError = String((error && error.message) || error)
      }
    }
    reply(res, 200, { ok: false, error: lastError || '模型没有返回内容' })
  })

  route('/dsh-pet-hub/status', async (req, res) => reply(res, 200, await status()))

  route('/dsh-pet-hub/pet', async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJson(req)
    const action = String(body.action || '')
    if (action === 'start') {
      reply(res, 200, await startPet({ petDir, pythonw, form: body.form }))
      return
    }
    if (action === 'stop') {
      const st = await petStatus({ petDir, pythonw })
      reply(res, 200, await stopPet(st.pids))
      return
    }
    if (action === 'form') {
      const form = body.form === 'widget' ? 'widget' : 'pet'
      // 配置归桌宠写：它在跑就发指令，别直接改 config.json（会被 autosave 覆盖）
      const st = await petStatus({ petDir, pythonw })
      if (st.running) {
        const id = pushPetCommand('set', { skin: form === 'widget' ? '小鲸鱼挂件' : '大肥鱼' })
        reply(res, 200, id ? { ok: true, queued: id } : { ok: false, error: '指令队列写不进去' })
        return
      }
      reply(res, 200, await switchForm({ petDir, pythonw, form }))
      return
    }
    reply(res, 400, { ok: false, error: 'action 只支持 start / stop / form' })
  })

  route('/dsh-pet-hub/client.js', async (req, res) => {
    try {
      const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'client.js')
      const text = fs.readFileSync(file, 'utf8')
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      })
      res.end(text)
    } catch (error) {
      reply(res, 500, { ok: false, error: String((error && error.message) || error) })
    }
  })

  // 客户端一启动就让桌宠弹一次状态卡：写一个请求文件，桌宠那边每 1.5 秒轮询一次。
  const requestPetCard = () => {
    try {
      const home = dshHome()
      const file = path.join(home, 'pet-card-request.json')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ at: Date.now(), from: 'dsh-startup' }), 'utf8')
    } catch (error) {
      safeLog(ctx, 'warn', 'dsh-pet-hub: 状态卡请求写入失败：' + String((error && error.message) || error))
    }
  }
  // 桌宠可能还在启动，延后一点再写
  setTimeout(requestPetCard, 3000)

  safeLog(ctx, 'info', 'dsh-pet-hub ready')
}
