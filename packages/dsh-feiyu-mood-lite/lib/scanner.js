/**
 * 增量轮次扫描：会话事件 → 完整一轮的「用户说了什么 / 它回了什么」
 *
 * 和 tts-bridge 的扫描器同源，但额外抓用户消息，并在同一轮里并起来。
 * 只认 turn/end 且 reason.kind === 'completed' 的轮次。
 */

const SKIP_USER_SOURCES = new Set([
  'injection',
  'system',
  'developer',
  'goal',
  'time',
  'context',
  'memory',
  'reminder',
  'schedule',
])

function textOf(data) {
  const message = data && data.message ? data.message : data
  if (!message) return ''
  let out = ''
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') out += block.text + '\n'
    }
  } else if (typeof message.text === 'string') {
    out = message.text
  }
  return out.trim()
}

function sourceKind(data) {
  const message = data && data.message ? data.message : data
  return message && message.source && message.source.kind ? String(message.source.kind) : ''
}

export function createTurnScanner({ onTurn = () => {}, onError = () => {} } = {}) {
  const sessions = new Map()

  return (targets) => {
    const active = new Set()
    for (const session of targets || []) {
      const id = String(session.id)
      const seq = Number(session.seq)
      active.add(id)
      let tracked = sessions.get(id)
      // 会话重载/回退：从头开始，不补历史
      if (!tracked || seq < tracked.seq) {
        sessions.set(id, { seq, turns: new Map(), current: null })
        continue
      }
      if (seq <= tracked.seq) continue

      let events
      try {
        events = session.snapshotEvents(tracked.seq)
      } catch (error) {
        onError(error, id)
        continue
      }
      tracked.seq = seq

      for (const event of events) {
        if (!event) continue
        const data = event.data || {}
        const type = event.type
        const hasTurn = data.turn !== undefined && data.turn !== null && Number.isFinite(Number(data.turn))
        const turn = hasTurn ? Number(data.turn) : tracked.current
        const key = turn === null || turn === undefined ? 'unknown' : String(turn)

        if (type === 'turn/start') {
          if (hasTurn) tracked.current = turn
          continue
        }
        if (type === 'user/message') {
          if (SKIP_USER_SOURCES.has(sourceKind(data))) continue
          const text = textOf(data)
          if (!text) continue
          const bucket = tracked.turns.get(key) || { user: [], assistant: [] }
          bucket.user.push(text.slice(0, 1200))
          tracked.turns.set(key, bucket)
          continue
        }
        if (type === 'assistant/message') {
          const text = textOf(data)
          if (!text) continue
          const bucket = tracked.turns.get(key) || { user: [], assistant: [] }
          bucket.assistant.push(text.slice(0, 1200))
          tracked.turns.set(key, bucket)
          continue
        }
        if (type === 'turn/end') {
          const reason = data.reason || {}
          const bucket = tracked.turns.get(key)
          tracked.turns.delete(key)
          if (reason.kind === 'completed' && bucket && (bucket.user.length || bucket.assistant.length)) {
            onTurn({ sessionId: id, turn, user: bucket.user.join('\n'), assistant: bucket.assistant.join('\n') })
          }
        }
      }
    }
    for (const id of [...sessions.keys()]) {
      if (!active.has(id)) sessions.delete(id)
    }
  }
}
