/**
 * 文本解码：腾讯行情同一接口在不同通道下会返回 UTF-8 或 GBK。
 * 策略：先按 Content-Type 的 charset；没有就 UTF-8 解，出现替换字符 U+FFFD 再退 GBK。
 */

const GBK_HINTS = ['gbk', 'gb2312', 'gb18030']

export function charsetOf(contentType = '') {
  const m = /charset=([\w-]+)/i.exec(String(contentType || ''))
  return m ? m[1].toLowerCase() : ''
}

export function decodeBody(buffer, contentType = '') {
  // 实测：腾讯响应头有时声明 GBK，实际字节却是 UTF-8（随 UA 变）。
  // 所以先按 UTF-8 解，只有出现替换字符才退 GBK——声明只当提示，不当判据。
  const utf8 = decodeWith('utf-8', buffer)
  if (utf8 !== null && !utf8.includes('\uFFFD')) return utf8
  const declared = charsetOf(contentType)
  if (declared && GBK_HINTS.some((h) => declared.includes(h))) {
    return decodeWith('gbk', buffer) ?? utf8 ?? ''
  }
  return decodeWith('gbk', buffer) ?? utf8 ?? ''
}

/** 返回 null 表示该编码解不出来（Node 没编译对应 ICU 表）。 */
function decodeWith(label, buffer) {
  try {
    return new TextDecoder(label).decode(buffer)
  } catch {
    return null
  }
}
