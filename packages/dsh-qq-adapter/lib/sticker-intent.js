/**
 * 识别「把这张图存起来」这类明确指令。
 *
 * 只在主人私聊里用；返回值决定要不要动图片库，不负责回复文案。
 */

const SAVE_PATTERNS = [
  /^(存|收藏|保存|收下|留着)(一下|下|起来)?(这|那)?(一)?(张|个)?(图|图片|表情|表情包|动图|gif|照片)?[吧呀啊哈呢。！!~～]*$/i,
  /(把|将)(这|那)(张|个)?(图|图片|表情|表情包|动图|gif)(存|收藏|保存|收下|留)(一下|下|起来)?/,
  /(存|收藏|保存)(一下|起来)?(这|那)(张|个)?(图|表情|表情包|动图|gif)/,
  /(这|那)(个|张)?(图|图片|表情|表情包|动图|gif)?(存|收藏|保存|收下|留着)(一下|起来)?$/,
  /^(存|收藏)(图|表情包|表情)$/i,
]

const UNSAVE_PATTERNS = [
  /(别|不要|不用|取消)(存|收藏|保存)/,
  /^(删|去掉)(这|那)?(张|个)?(图|表情|表情包|动图|gif)$/,
]

/** @returns {{action:'save'|'unsave'} | null} */
export function parseStickerIntent(text) {
  const value = String(text || '').trim()
  if (!value || value.length > 30) return null
  if (UNSAVE_PATTERNS.some((re) => re.test(value))) return { action: 'unsave' }
  if (SAVE_PATTERNS.some((re) => re.test(value))) return { action: 'save' }
  return null
}
