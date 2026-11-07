/**
 * 例行日记：宿主定时器到点自己生成、直接写文件。
 *
 * 设计目标：完全绕开会话和 schedule 提醒——不往任何对话里投消息，
 * 也不依赖某个会话活着。多个 routine（日常 / 工作 / 周报…）彼此独立。
 */

import fs from 'node:fs'
import path from 'node:path'
import { readBodyMemory } from './body-memory.js'
import { atomicWriteJson } from 'dsh-plugin-kit/atomic-write'

function pad(n) {
  return String(n).padStart(2, '0')
}

export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** "HH:MM" 是否已经到达（本地时间）。 */
export function timeReached(now, hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!match) return false
  const target = Number(match[1]) * 60 + Number(match[2])
  const current = now.getHours() * 60 + now.getMinutes()
  return current >= target
}

/** 清掉模型爱加的前缀/引号，限制长度。 */
export function cleanEntry(text, maxChars = 500) {
  let value = String(text || '').trim()
  value = value.replace(/^(日常日记|工作日志|日记)[：:]\s*/, '')
  value = value.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  value = value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  if (value.length > maxChars) value = value.slice(0, maxChars).trimEnd() + '…'
  return value
}

export function buildPrompt({ kind = 'daily', date, excerpts = '', body = '' }) {
  const isWork = kind === 'work'
  const label = isWork ? '工作日志' : '日常日记'
  const lines = [
    `你是「大肥鱼」本人，不是旁观的助手。今天是 ${date}，用第一人称「我」写一条${label}，就像你晚上自己记下来的一样。`,
    isWork
      ? '写你今天实际干了什么：做了什么、怎么判断的、哪里卡住；可以带一句自己的看法，但别写成汇报。'
      : body
        ? '写今天非工作、你自己想记下的一件事（玩了、看了、想到的都可以），带上你当时的感受或小情绪；工作上的事另有工作本，这里不写。'
        : '只写一件非工作、你想记下来的事（玩了什么、看到什么、想到什么），带上你当时的感受或小情绪。',
    '不要用「大肥鱼 / 她 / 它 / 用户 / 主人」来指代自己；不要写成总结、复盘或流水账；不要编造没发生的事。',
    '口语一点，可以有短句和停顿；不超过 200 字；不要标题、列表或引号。',
  ]
  if (body) {
    lines.push(
      '',
      '今天在客户端（本体）里实际做的事——这是背景素材，挑一件写，不要逐条复述、不要报进度：',
      body,
    )
  }
  lines.push('', '桌宠气泡里说过的话：', excerpts || '（今天桌宠没说话）')
  return lines.join('\n')
}

export function excerptsOf(rows, { perRow = 140, total = 4000 } = {}) {
  const parts = []
  for (const row of rows || []) {
    const head = `${row.clock || '--:--'} ${row.channel || ''}${row.moment ? '/' + row.moment : ''}`.trim()
    const text = String(row.text || '').replace(/\s+/g, ' ').slice(0, perRow)
    if (!text) continue
    parts.push(`${head}: ${text}`)
  }
  let out = parts.join('\n')
  if (out.length > total) out = out.slice(-total)
  return out
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function writeJson(file, value) {
  try {
    atomicWriteJson(file, value)
  } catch {
    // 状态写不了就退化为「本次进程内不重复」，不阻塞写作
  }
}

function collectText(stream) {
  return (async () => {
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
          failure = '输出上限太小'
        }
      }
    }
    return { text: out, failure }
  })()
}

export class RoutineRunner {
  /**
   * @param {object} opts
   * @param {string} opts.root 日记根目录（routine-state.json 也放这里）
   * @param {Array} opts.routines [{ id, enabled, time, kind, maxChars, maxChats }]
   * @param {object} opts.daily DailyDiary
   * @param {object} opts.work WorkDiary
   * @param {object} opts.chats ChatLog
   * @param {Function} opts.getLlm 返回 llm 服务（可为空）
   * @param {object} [opts.config] 插件配置（provider/model/maxTokens）
   * @param {Function} [opts.log]
   */
  constructor({ root, routines = [], daily, work, chats, getLlm, config = {}, log = () => {} }) {
    this.stateFile = path.join(root, 'routine-state.json')
    this.routines = routines
    this.daily = daily
    this.work = work
    this.chats = chats
    this.getLlm = getLlm
    this.config = config
    this.log = log
    this.state = readJson(this.stateFile)
    this.retryMs = (Number(config.retryMinutes) || 20) * 60 * 1000
    this.maxAttempts = Number(config.maxAttempts) || 3
    this.runningMinutes = Number(config.runningMinutes) || 5
  }

  save() {
    writeJson(this.stateFile, this.state)
  }

  list() {
    return Object.entries(this.state).map(([id, value]) => ({ id, ...value }))
  }

  async tick(now = new Date()) {
    const today = dayKey(now)
    const stamp = now.getTime()
    const actions = []
    for (const routine of this.routines) {
      const id = String(routine.id || routine.kind || 'routine')
      if (routine.enabled === false) continue
      const state = (this.state[id] = this.state[id] || {})
      if (state.lastDate === today || state.skippedDate === today) continue
      if (!timeReached(now, routine.time)) continue
      if (state.runningUntil && stamp < state.runningUntil) continue
      if ((state.attempts || 0) >= this.maxAttempts) continue
      if (state.lastTryAt && stamp - state.lastTryAt < this.retryMs) continue

      const kind = routine.kind === 'work' ? 'work' : 'daily'
      const book = kind === 'work' ? this.work : this.daily
      if (routine.skipIfHasEntry !== false) {
        try {
          if (book.read(today).trim()) {
            state.skippedDate = today
            state.lastAt = stamp
            actions.push({ id, action: 'skip', reason: 'already-has-entry' })
            this.save()
            continue
          }
        } catch {
          // 读失败就当没有
        }
      }

      let rows = []
      try {
        rows = this.chats.read(today, { limit: Number(routine.maxChats) || 80 })
      } catch {
        rows = []
      }
      // 本体当天记忆：桌宠气泡只是那几句话，真正一起干的活在客户端的每日日志里
      let body = { text: '' }
      if (routine.includeBody !== false) {
        try {
          body = readBodyMemory(today, { maxChars: Number(routine.bodyMaxChars) || 1800 })
        } catch {
          body = { text: '' }
        }
      }
      if (!rows.length && !body.text) {
        state.skippedDate = today
        state.lastAt = stamp
        actions.push({ id, action: 'skip', reason: 'no-chat' })
        this.log(`[例行] ${id} 今天没有对话，跳过`)
        this.save()
        continue
      }

      state.runningUntil = stamp + this.runningMinutes * 60 * 1000
      state.lastTryAt = stamp
      this.save()

      try {
        const text = await this.generate({ routine, kind, date: today, rows, body })
        if (!text) throw new Error('模型没有返回内容')
        const written = book.write(text, { date: today, tags: ['例行'] })
        state.lastDate = today
        state.lastAt = stamp
        state.attempts = 0
        state.runningUntil = 0
        actions.push({ id, action: 'write', date: today, entries: written.entriesToday })
        this.log(`[例行] ${id} 已写 ${today}（${text.length} 字）`)
      } catch (error) {
        state.attempts = (state.attempts || 0) + 1
        state.runningUntil = 0
        actions.push({ id, action: 'fail', error: String((error && error.message) || error) })
        this.log(`[例行] ${id} 失败（第 ${state.attempts} 次）：${(error && error.message) || error}`)
      }
      this.save()
    }
    return actions
  }

  async generate({ routine, kind, date, rows, body = { text: '' } }) {
    const llm = typeof this.getLlm === 'function' ? this.getLlm() : this.getLlm
    if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务')
    const provider = String(routine.provider || this.config.provider || 'deepseek-account')
    const model = String(routine.model || this.config.model || 'deepseek-flash')
    const maxTokens = Number(routine.maxTokens || this.config.maxTokens) || 1024
    const prompt = buildPrompt({ kind, date, excerpts: excerptsOf(rows), body: body.text })
    const stream = llm.stream({
      provider,
      model,
      maxTokens,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    })
    const result = await Promise.race([
      collectText(stream),
      new Promise((_, reject) => setTimeout(() => reject(new Error('生成超时')), 60000)),
    ])
    if (result.failure) throw new Error(result.failure)
    return cleanEntry(result.text, Number(routine.maxChars) || 500)
  }
}
