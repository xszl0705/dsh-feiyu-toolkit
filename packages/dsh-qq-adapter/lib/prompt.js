/**
 * 提示词与回复清洗：身份来自主体内核的编译产物，这里只拼「当前这句」。
 */

import fs from 'node:fs'

export function loadIdentity(explicitFile) {
  const file = String(explicitFile || '').trim()
  if (file) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim()
      if (text) return text
    } catch {
      // 落到默认
    }
  }
  return ''
}

export function buildPrompt({ identity, event, channelLabel = 'QQ' }) {
  const who = event.kind === 'group' ? `QQ 群里 ${event.senderName} @ 你说` : `${event.senderName} 私聊你说`
  return [
    identity,
    '',
    `【当前对话 · ${channelLabel}】`,
    `${who}：`,
    event.text,
    '',
    '用你自己的话回一句（一到三句都行），不要以「作为一个 AI」开头；不确定的事就说记不清，不要编。',
  ].join('\n')
}

export function cleanReply(text, maxChars = 120) {
  const value = String(text || '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim()
  const limit = Math.max(20, Number(maxChars) || 120)
  if (value.length <= limit) return value
  // 2026-11-04 保真：超限按行截断，保留代码/表格/列表结构；单行超长才硬切。
  const lines = value.split('\n')
  const kept = []
  let size = 0
  for (const line of lines) {
    if (size + line.length + 1 > limit) break
    kept.push(line)
    size += line.length + 1
  }
  if (kept.length) return kept.join('\n').trimEnd() + '\n…'
  return value.slice(0, limit - 1) + '…'
}
