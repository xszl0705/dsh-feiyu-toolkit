/**
 * 请求 → 特征摘要。
 *
 * 为什么要这一步：qwen3:4b 在 4060 上 prefill 3K token 要 300~600ms，
 * 而且注意力分散会让分类更差。所以给本地模型的不是全文，是"我们能算出来的信号"。
 * 硬上限约 600 token（中文 ≈900 字），超出直接截断。
 */

const KEYWORD_BANK = [
  '重构', '排查', '定位', '报错', '异常', '崩溃', '迁移', '升级', '设计', '架构',
  '翻译', '摘要', '总结', '改名', '重命名', '替换', '格式', '统计', '对比',
  '为什么', '怎么', '是什么', '区别', '推荐', '优化', '性能', '安全',
]

const MAX_TEXT_CHARS = 400

export function truncate(text, max = MAX_TEXT_CHARS) {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max) + '…' : s
}

export function hitKeywords(text) {
  const s = String(text ?? '')
  return KEYWORD_BANK.filter((k) => s.includes(k))
}

/**
 * @param {{text:string, turns?:number, tools?:string[], attachments?:number}} req
 * @returns {string} 喂给本地模型的特征块
 */
export function toFeatures(req) {
  const tools = Array.isArray(req?.tools) ? req.tools : []
  const lines = [
    `[最近用户消息] ${truncate(req?.text)}`,
    `[历史轮数] ${Number(req?.turns ?? 0) || 0}`,
    `[可用工具数] ${tools.length}`,
    `[是否带附件] ${Number(req?.attachments ?? 0) > 0 ? '是' : '否'}`,
    `[命中关键词] ${hitKeywords(req?.text).join('、') || '无'}`,
  ]
  if (tools.length) lines.push(`[工具样例] ${tools.slice(0, 6).join(',')}`)
  return lines.join('\n')
}

/** 估算 token 数（中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token 粗算） */
export function approxTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length
  const rest = s.length - cjk
  return Math.round(cjk + rest / 4)
}
