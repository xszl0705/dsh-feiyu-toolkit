/**
 * OneBot 11 事件解析（NapCat 上报格式）。
 * 只关心：有人跟我说了一句话，要不要回。
 */

export function extractText(message) {
  if (typeof message === 'string') return message.trim()
  if (!Array.isArray(message)) return ''
  const parts = []
  for (const segment of message) {
    if (!segment || !segment.type) continue
    if (segment.type === 'text') parts.push(String(segment.data?.text ?? ''))
    else if (segment.type === 'at') parts.push(String(segment.data?.name ? `@${segment.data.name} ` : ''))
    else if (segment.type === 'face') parts.push('')
    else if (segment.type === 'image') parts.push('[图片]')
    else if (segment.type === 'record') parts.push('[语音]')
  }
  return parts.join('').replace(/\s+/g, ' ').trim()
}

export function isAtSelf(message, selfId) {
  if (!Array.isArray(message)) return false
  const me = String(selfId ?? '')
  if (!me) return false
  return message.some((seg) => {
    if (seg?.type !== 'at') return false
    const target = String(seg.data?.qq ?? seg.data?.uin ?? '')
    return target === me
  })
}

export function extractImages(message) {
  if (!Array.isArray(message)) return []
  const out = []
  for (const segment of message) {
    if (segment?.type !== 'image') continue
    const data = segment.data || {}
    const url = String(data.url || data.file_url || '').trim()
    const file = String(data.file || '').trim()
    if (!url && !file) continue
    out.push({
      url,
      file,
      fileId: String(data.file_id || '').trim(),
      summary: String(data.summary || '').trim(),
    })
  }
  return out
}

/** 解析一条上报事件。
 * @returns {{kind:'private'|'group', userId:string, groupId:string, messageId:string,
 *            text:string, images:Array<{url:string,file:string,fileId:string,summary:string}>,
 *            atSelf:boolean, senderName:string} | null}
 */
export function parseEvent(raw, selfId) {
  if (!raw || raw.post_type !== 'message') return null
  const type = raw.message_type
  if (type !== 'private' && type !== 'group') return null
  if (String(raw.user_id) === String(selfId)) return null // 自己发的
  const text = extractText(raw.message) || String(raw.raw_message || '').trim()
  if (!text) return null
  return {
    kind: type,
    userId: String(raw.user_id ?? ''),
    groupId: String(raw.group_id ?? ''),
    messageId: String(raw.message_id ?? ''),
    text,
    images: extractImages(raw.message),
    atSelf: isAtSelf(raw.message, selfId) || raw.at_me === true,
    senderName: String(raw.sender?.card || raw.sender?.nickname || raw.user_id || '对方'),
    selfId: String(selfId ?? raw.self_id ?? ''),
  }
}

/** 群聊过滤：白名单为空表示不接群；白名单里的群按触发方式决定。 */
export function shouldAnswer(event, config) {
  if (!event) return false
  if (event.kind === 'private') return config.allowPrivate !== false
  const groups = (config.groups || []).map(String).filter(Boolean)
  if (groups.length === 0) return false
  if (!groups.includes(String(event.groupId))) return false
  if (event.atSelf) return true
  if (config.requireAtInGroup === false) return true
  const trigger = String(config.groupTrigger || 'at')
  if (trigger === 'auto') return true
  if (trigger === 'wake') {
    const words = (config.wakeWords || []).map(String).filter(Boolean)
    return words.some((word) => String(event.text || '').includes(word))
  }
  return false
}

/** 简单限速：每个会话每分钟最多 N 条。 */
export class RateLimiter {
  constructor(limitPerMinute = 6) {
    this.limit = Math.max(1, Number(limitPerMinute) || 6)
    this.buckets = new Map()
  }

  allow(key, now = Date.now()) {
    const windowStart = now - 60_000
    const list = (this.buckets.get(key) || []).filter((time) => time > windowStart)
    if (list.length >= this.limit) {
      this.buckets.set(key, list)
      return false
    }
    list.push(now)
    this.buckets.set(key, list)
    return true
  }
}
