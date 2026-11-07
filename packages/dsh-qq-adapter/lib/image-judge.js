/**
 * 判断一张图值不值得进「收藏档」。
 *
 * 用本地 qwen3:4b 只看文字描述，不再看图——描述来自刚生成的看图回复，
 * 所以不额外产生视觉费用；判断失败一律「不收藏」，不阻塞回复。
 */

const SAVE_HINTS = /(表情包|表情|梗图|搞笑|好笑|可爱|萌|沙雕|emoji|sticker|meme|动图|gif|头像|插画|二次元|手绘|自绘|无厘头)/
const SKIP_HINTS = /(聊天记录|聊天截图|二维码|身份证|银行卡|手机号|地址|订单号|工牌|会议|ppt|表格|发票|密码|账号|验证码)/

export function buildJudgePrompt({ caption = '', animated = false } = {}) {
  return [
    '你是图片收藏助手。只输出 JSON，不要解释。',
    '下面这段是 AI 看完图后的描述/回复，请判断这张图是否值得长期收藏。',
    animated ? '（已知：这是一张动图/GIF）' : '',
    '',
    '值得收藏：表情包、梗图、搞笑或可爱的图、二次元头像/插画、自制图、有梗的文字图。',
    '不值得：聊天记录/屏幕截图、含隐私（手机号、地址、证件、二维码、订单号）、表格/文档图、普通风景照、食物照、模糊看不清。',
    '',
    'tags 只能从这个词表里选 1~3 个：表情包, 动图, 梗图, 可爱, 搞笑, 二次元, 插画, 头像, 截图, 知识图',
    '输出格式：{"save":true,"tags":["表情包"],"reason":"一句话"}',
    '',
    '描述：',
    String(caption || '').slice(0, 500),
  ]
    .filter(Boolean)
    .join('\n')
}

export function parseJudge(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let data = null
  try {
    data = JSON.parse(raw)
  } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        data = JSON.parse(raw.slice(start, end + 1))
      } catch {
        data = null
      }
    }
  }
  if (!data || typeof data !== 'object') return { save: false, tags: [], reason: 'judge-unparsed' }
  const tags = Array.isArray(data.tags)
    ? data.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 3)
    : []
  return { save: data.save === true, tags, reason: String(data.reason || '').slice(0, 80) }
}

/** 规则兜底：模型没起来时，至少别把隐私/截图收进去。 */
export function heuristicJudge({ caption = '', animated = false } = {}) {
  const text = String(caption || '')
  if (!text || text.length < 4) return { save: false, tags: [], reason: 'no-caption' }
  if (SKIP_HINTS.test(text)) return { save: false, tags: [], reason: 'rule:privacy-or-doc' }
  if (SAVE_HINTS.test(text)) {
    const tags = []
    if (animated) tags.push('动图')
    if (/表情|sticker|emoji/i.test(text)) tags.push('表情包')
    else if (/梗|meme|沙雕|搞笑/i.test(text)) tags.push('梗图')
    if (/可爱|萌/i.test(text)) tags.push('可爱')
    if (/二次元|插画|手绘/i.test(text)) tags.push('二次元')
    return { save: true, tags: [...new Set(tags)].slice(0, 3), reason: 'rule:save-hint' }
  }
  return { save: false, tags: [], reason: 'rule:no-hint' }
}

export async function judgeSticker({ caption = '', animated = false, config = {}, fetchImpl = globalThis.fetch } = {}) {
  if (config.enabled === false) return heuristicJudge({ caption, animated })
  const endpoint = String(config.endpoint || 'http://127.0.0.1:11434').replace(/\/+$/, '')
  try {
    const res = await fetchImpl(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: String(config.model || 'qwen3:4b'),
        stream: false,
        think: false,
        format: 'json',
        keep_alive: '30m',
        options: { temperature: 0.1, num_ctx: 2048, num_predict: 120 },
        messages: [{ role: 'user', content: buildJudgePrompt({ caption, animated }) }],
      }),
      signal: AbortSignal.timeout(Number(config.timeoutMs) || 8000),
    })
    if (!res.ok) throw new Error('judge local ' + res.status)
    const data = await res.json()
    const verdict = parseJudge(data?.message?.content)
    if (verdict.reason === 'judge-unparsed') return heuristicJudge({ caption, animated })
    return verdict
  } catch {
    return heuristicJudge({ caption, animated })
  }
}
