/**
 * 渠道渲染器（阶段 4.3）：把正文转成 QQ 能安全发送的形式。
 *
 * 原则：
 * - 代码块 / 表格 / 引用原样保留，不删内容；
 * - 超长按行拆分，不把一行切成半句（单行超长才硬切）；
 * - 拆成太多条时调用方转文件（这里只给信号，不写盘）。
 * 2026-11-04：配合 4.1 的保真清洗，替代「删代码块 + 压空白」的老做法。
 */

/** 按行拆成 ≤limit 的若干条；返回 { parts, truncated, hardCut }。 */
export function splitForChannel(text, { limit = 4000, maxParts = 4 } = {}) {
  const value = String(text || '')
  if (!value.trim()) return { parts: [], truncated: false, hardCut: false }
  if (value.length <= limit) return { parts: [value], truncated: false, hardCut: false }

  const lines = value.split('\n')
  const parts = []
  let cur = ''
  let hardCut = false
  let truncated = false

  const flush = () => {
    if (cur) {
      parts.push(cur)
      cur = ''
    }
  }

  for (const line of lines) {
    if (parts.length >= maxParts) {
      truncated = true
      break
    }
    const candidate = cur ? `${cur}\n${line}` : line
    if (candidate.length <= limit) {
      cur = candidate
      continue
    }
    flush()
    if (line.length > limit) {
      // 单行超长：只能硬切，但记录信号，调用方可以转文件
      hardCut = true
      cur = line.slice(0, limit)
    } else {
      cur = line
    }
  }
  flush()
  if (parts.length > maxParts) {
    parts.length = maxParts
    truncated = true
  }
  return { parts, truncated, hardCut }
}

/** 是否应该转文件（拆不下或含超长单行）。 */
export function shouldSendAsFile({ parts = [], truncated = false, hardCut = false } = {}) {
  return truncated || hardCut || parts.length > 1
}
