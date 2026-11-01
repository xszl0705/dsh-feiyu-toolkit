/**
 * 群上下文环形缓冲区：给 gate 和回复提示词提供最近群消息。
 * 只存群内公开消息，不进私有记忆。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DIR = path.join(BASE, 'dafeiyu', 'group-context')
const MAX = 40

function fileFor(groupId) {
  return path.join(DIR, String(groupId || 'unknown').replace(/[^\w-]/g, '_') + '.json')
}

function readState(groupId) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(groupId), 'utf8'))
    return {
      version: Number(raw.version) || 0,
      messages: Array.isArray(raw.messages) ? raw.messages : [],
    }
  } catch {
    return { version: 0, messages: [] }
  }
}

function writeState(groupId, state) {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(fileFor(groupId), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // 上下文写入失败不阻断消息处理
  }
}

export function appendGroupMessage(event, now = Date.now()) {
  if (!event?.groupId || event.kind !== 'group') return null
  const state = readState(event.groupId)
  const text = String(event.text || '').trim().slice(0, 200)
  if (!text) return state
  const last = state.messages[state.messages.length - 1]
  if (last && last.id === event.messageId) return state
  state.version += 1
  state.messages.push({
    id: String(event.messageId || ''),
    speaker: String(event.senderName || '某人'),
    uid: String(event.userId || ''),
    text,
    at: now,
    images: Array.isArray(event.images) ? event.images.length : 0,
  })
  state.messages = state.messages.slice(-MAX)
  writeState(event.groupId, state)
  return state
}

export function groupContextVersion(groupId) {
  return readState(groupId).version
}

export function recentGroupMessages(groupId, { limit = 20, excludeId = '' } = {}) {
  const state = readState(groupId)
  return state.messages.filter((m) => String(m.id) !== String(excludeId || '')).slice(-Math.max(1, limit))
}

export function buildGroupContextBlock(groupId, { limit = 20, excludeId = '' } = {}) {
  const rows = recentGroupMessages(groupId, { limit, excludeId })
  if (!rows.length) return ''
  return [
    '【最近群聊（只作语境，不要逐条复述）】',
    ...rows.map((m) => `- ${m.speaker}：${String(m.text || '').slice(0, 120)}`),
  ].join('\n')
}
