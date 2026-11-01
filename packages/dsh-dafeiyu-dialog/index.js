import { lifecycle } from './lib/lifecycle.js'
import { createDayReader } from './lib/reader.js'
/**
 * dsh-dafeiyu-dialog — 跨渠道对话总线
 *
 * 客户端（DSH 会话事件）、QQ、桌宠都把一轮对话写进同一份 JSONL；
 * 其它插件按 conversation 取最近几条，拼进 prompt。
 *
 * 隐私：只按 conversation 取；QQ 群/陌生人用各自的 key，绝不读 owner。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-dafeiyu-dialog'

const SERVICE_KEY = Symbol.for('dsh-dafeiyu-dialog.service')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DIR = path.join(DSH_HOME, 'dafeiyu', 'dialogues')

function pad(n) {
  return String(n).padStart(2, '0')
}

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function append(row) {
  fs.mkdirSync(DIR, { recursive: true })
  const at = row.at ? new Date(row.at) : new Date()
  const file = path.join(DIR, `${dayKey(at)}.jsonl`)
  fs.appendFileSync(file, JSON.stringify({ ...row, at: at.toISOString() }) + '\n', 'utf8')
}

const reader = createDayReader({ dir: DIR })

function recent({ conversation = 'owner', limit = 8, days = 2, opposite = '' } = {}) {
  const out = []
  const now = new Date()
  for (let i = 0; i < Math.max(1, days); i += 1) {
    const day = new Date(now.getTime() - i * 86400000)
    // 走缓存 + conversation 预分组：同一份文件一条消息里读多次只解析一次
    const rows = reader.rowsFor({ day: dayKey(day), conversation })
    for (const row of rows) {
      if (opposite && String(row.opposite || '') !== String(opposite)) continue
      out.push(row)
    }
  }
  out.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  return out.slice(-Math.max(1, limit))
}

function textOf(data) {
  const raw = data?.message?.content ?? data?.content
  if (typeof raw === 'string') return raw.trim()
  if (!Array.isArray(raw)) return ''
  return raw
    .filter((block) => block && block.type === 'text')
    .map((block) => String(block.text || ''))
    .join('')
    .trim()
}

function note(message) {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.appendFileSync(path.join(DIR, 'load.log'), new Date().toISOString() + '  ' + message + '\n', 'utf8')
  } catch {
    // ignore
  }
}

function install(ctx) {
  const api = {
    append,
    recent,
    recentOwner: (limit = 6) => recent({ conversation: 'owner', limit }),
    source: 'dsh-dafeiyu-dialog',
    stats: () => reader.stats(),
  }
  globalThis[SERVICE_KEY] = api
  for (const serviceName of ['dialog', 'dialogues']) {
    try {
      if (typeof ctx?.provide === 'function') ctx.provide(serviceName, api)
    } catch {
      // ignore
    }
    try {
      if (typeof ctx?.set === 'function') ctx.set(serviceName, api)
    } catch {
      // ignore
    }
  }
  return api
}

/** 把运行时状态报给 self：缓存命中率、已缓存的整天文件数。 */
function declareSelf(ctx, api) {
  try {
    const self = ctx.get?.('self') || globalThis[Symbol.for('dsh-feiyu-self.service')]
    if (typeof self?.declare !== 'function') return
    self.declare({
      id: 'dialog',
      package: 'dsh-dafeiyu-dialog',
      intent: '跨渠道对话记录：追加消息、按会话读取最近若干条',
      limits: ['只存对话文本与角色，不存推理过程', '按会话隔离，不跨会话泄漏'],
      failureModes: [{ code: 'DIALOG_WRITE_FAILED', meaning: '落盘失败，当前回复照常进行', retry: '下次写入重试' }],
      scope: ['owner', 'group', 'private'],
      state: () => api.stats(),
    })
  } catch {
    // self 没装也不影响对话总线
  }
}

function isRuntimeNoise(role, text) {
  if (role !== 'user') return false
  return /^(Current runtime context\.|Time sampled while preparing|Browser time zone|You are an AI agent powered)/.test(
    String(text || '').trim(),
  )
}

export function apply(ctx) {
  const st = lifecycle(ctx)
  if (st.started) return
  st.started = true
  note('apply start')
  const api = install(ctx)
  st.own(() => { if (globalThis[SERVICE_KEY] === api) delete globalThis[SERVICE_KEY] })
  note('service installed')
  declareSelf(ctx, api)

  // 客户端每轮对话：只记主会话，跳过子代理
  try {
    if (typeof ctx.on === 'function') {
      ctx.on(
        'session/event',
        (session, event) => {
          try {
            if (!event || (event.type !== 'user/message' && event.type !== 'assistant/message')) return
            if (session?.parentId) return
            const text = textOf(event.data)
            if (!text) return
            const role = event.type === 'user/message' ? 'user' : 'assistant'
            if (isRuntimeNoise(role, text)) return
            append({
              channel: 'client',
              conversation: 'owner',
              role,
              text: text.slice(0, 2000),
              model: String(event.data?.message?.model || ''),
              sessionId: String(session?.id || ''),
            })
          } catch {
            // 记录失败不影响对话
          }
        },
        { global: true },
      )
    }
  } catch {
    // 宿主没有会话事件就只发挥 QQ/桌宠的写入能力
  }

  // 给 Python 桌宠用的只读口
  const routeHandler = (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const conversation = url.searchParams.get('conversation') || 'owner'
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 8))
      const rows = recent({ conversation, limit })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, rows }))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
    }
  }
  let attempts = 0
  const mount = () => {
    try {
      const webServer = ctx.get?.('webServer')
      if (!webServer || typeof webServer.register !== 'function') {
        attempts += 1
        if (attempts === 1) note('webServer not ready, retrying')
        if (attempts <= 240) st.later(mount, 250)
        return
      }
      st.own(webServer.register({ kind: 'exact', path: '/dsh-dafeiyu-dialog/recent', handler: routeHandler }))
      note('route mounted')
    } catch (error) {
      note('route mount failed: ' + String((error && error.message) || error))
    }
  }
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(mount)
    } catch {
      mount()
    }
  } else {
    mount()
  }
}
