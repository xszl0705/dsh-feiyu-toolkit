/**
 * 每轮情绪评价（OCC 风格）：
 *   模型只输出「评价变量」—— desirability / expectancy / agency / control，
 *   由本地规则把它们映射成 delta 和情绪维度。
 *
 * 为什么不让模型直接给 delta：
 *   直接给分不可复现，且容易受措辞影响（夸一句就 +8、报个 bug 就 -8）。
 *   先评价「这事对目标有利吗 / 意外吗 / 谁造成的 / 能不能控制」，
 *   再按固定公式算分，行为稳定，也能写回归测试。
 */

import { clamp, DIMS } from './mood.js'

const POSITIVE = ['谢谢', '感谢', '厉害', '好棒', '棒', '可爱', '喜欢', '辛苦', '爱你', '乖', '牛', '赞', '聪明', '靠谱', '不错']
const NEGATIVE = ['笨', '傻', '滚', '烦', '垃圾', '太慢', '错', '讨厌', '气死', '失望', '不行', '闭嘴', '废物', '敷衍']

const AGENCIES = new Set(['user', 'pet', 'world'])

export function heuristicMood({ userText = '' } = {}) {
  const text = String(userText)
  let score = 0
  let hit = ''
  for (const word of POSITIVE) {
    if (text.includes(word)) {
      score += 1
      if (!hit) hit = '被夸了'
    }
  }
  for (const word of NEGATIVE) {
    if (text.includes(word)) {
      score -= 1
      if (!hit) hit = '被凶了'
    }
  }
  score = clamp(score, -6, 6)
  return {
    delta: score,
    reason: hit || (text.trim() ? '普通聊天' : '安静待着'),
    dims: score > 0 ? { happy: 60, sweet: 40 } : score < 0 ? { sad: 50, worry: 40 } : {},
    source: 'heuristic',
  }
}

export function buildPrompt({ userText = '', assistantText = '', mood = 60 } = {}) {
  return [
    '你在给一只名叫「大肥鱼」的桌面宠物做一次情绪评价。',
    `它现在的心情是 ${mood}（0~100，60 为平常），但你不要直接给分数，只评价这件事。`,
    '',
    '用户说：',
    String(userText).slice(0, 800) || '（无）',
    '',
    '它自己回：',
    String(assistantText).slice(0, 400) || '（无）',
    '',
    '按 OCC 的评价维度回答：',
    '1. desirability：-1（很糟）~ 1（很好）。对它的目标（被喜欢、帮上忙、不惹麻烦）有利还是有害。',
    '2. expectancy：0（完全没想到）~ 1（意料之中）。',
    '3. agency：谁造成的 —— "user"（用户）、"pet"（它自己）、"world"（外部原因/任务/工具）。',
    '4. control：0（完全控制不了）~ 1（完全可控）。',
    '5. reason：不超过 12 个字的中文原因。',
    '',
    '普通干活、没有明显情绪色彩时，desirability 取 0 附近即可（允许不变）。',
    '只输出一行 JSON，不要代码块、不要解释：',
    '{"desirability":0,"expectancy":0.5,"agency":"world","control":0.5,"reason":""}',
  ].join('\n')
}

/**
 * 评价变量 → delta / dims。
 * - 意外的事更重（novelty）
 * - 负面的事更重（negativity bias 1.2）
 * - 归因与可控性决定落到哪个维度
 */
export function appraisalToDelta(input = {}) {
  const desirability = clamp(Number(input.desirability) || 0, -1, 1)
  const expectancy = clamp(Number(input.expectancy ?? 0.5), 0, 1)
  const control = clamp(Number(input.control ?? 0.5), 0, 1)
  const agency = AGENCIES.has(input.agency) ? input.agency : 'world'
  const reason = String(input.reason || '').replace(/[\r\n]+/g, ' ').slice(0, 24)

  // 没有明显倾向：明确允许「不变」，避免模型硬凑涨跌
  if (Math.abs(desirability) < 0.15) {
    return {
      delta: 0,
      reason: reason || '普通聊天',
      dims: {},
      source: 'appraisal',
      appraisal: { desirability, expectancy, agency, control },
    }
  }

  const novelty = 0.7 + 0.3 * (1 - expectancy)
  const bias = desirability < 0 ? 1.2 : 1
  const magnitude = Math.abs(desirability) * 10 * novelty * bias
  const delta = clamp(Math.round(Math.sign(desirability) * magnitude), -8, 8)

  const dims = {}
  if (desirability > 0) {
    dims.happy = Math.round(100 * desirability * (agency === 'pet' ? 1 : 0.8))
    dims.sweet = Math.round((agency === 'user' ? 60 : 25) * desirability)
  } else {
    const d = Math.abs(desirability)
    dims.sad = Math.round((agency === 'world' ? 70 : 30) * d)
    dims.worry = Math.round((control < 0.4 ? 60 : 25) * d)
    if (agency === 'user' && control < 0.3) dims.heartache = Math.round(50 * d)
  }
  for (const key of Object.keys(dims)) {
    if (!DIMS.includes(key) || dims[key] < 5) delete dims[key]
  }

  const appraisal = { desirability, expectancy, agency, control }
  return {
    delta,
    reason: reason || (desirability > 0 ? '心情变好' : '心情变差'),
    dims,
    source: 'appraisal',
    appraisal,
  }
}

export function parseReply(text) {
  const raw = String(text || '')
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    let value = JSON.parse(match[0])
    if (!value || typeof value !== 'object') return null
    if (value.appraisal && typeof value.appraisal === 'object') value = value.appraisal

    // 新格式：评价变量
    if (value.desirability !== undefined && value.desirability !== null) {
      return appraisalToDelta(value)
    }

    // 兼容旧格式：模型直接给 delta
    if (value.delta !== undefined && value.delta !== null) {
      const delta = clamp(Math.round(Number(value.delta) || 0), -8, 8)
      const reason = String(value.reason || '').replace(/[\r\n]+/g, ' ').slice(0, 24)
      const dims = {}
      if (value.dims && typeof value.dims === 'object') {
        for (const key of DIMS) {
          if (value.dims[key] === undefined || value.dims[key] === null) continue
          dims[key] = clamp(value.dims[key])
        }
      }
      return { delta, reason, dims, source: 'llm' }
    }
    return null
  } catch {
    return null
  }
}

function collectText(stream) {
  return (async () => {
    let out = ''
    let failure = ''
    for await (const chunk of stream) {
      const type = chunk && chunk.type
      if (type === 'text-delta') out += String(chunk.text ?? chunk.delta ?? '')
      else if (type === 'text') out += String(chunk.text ?? '')
      else if (type === 'finish') {
        const reason = (chunk && chunk.reason) || {}
        if (reason.kind === 'error') {
          const fail = reason.failure || {}
          failure = String(fail.message || fail.code || '模型调用失败')
        } else if (reason.kind === 'max-tokens') {
          failure = '输出上限太小'
        }
      }
    }
    return { text: out, failure }
  })()
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

/**
 * 调模型做评价。任何异常都退回启发式，绝不把插件带崩。
 */
export async function judgeTurn({
  llm,
  provider = 'deepseek-account',
  model = 'deepseek-flash',
  maxTokens = 1024,
  timeoutMs = 20000,
  userText = '',
  assistantText = '',
  mood = 60,
} = {}) {
  if (!llm || typeof llm.stream !== 'function') return heuristicMood({ userText })
  try {
    const stream = llm.stream({
      provider,
      model,
      maxTokens,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt({ userText, assistantText, mood }) }] }],
    })
    const result = await withTimeout(collectText(stream), timeoutMs)
    const parsed = parseReply(result.text)
    if (parsed) return parsed
  } catch {
    // 网络/额度/超时：走启发式
  }
  return heuristicMood({ userText })
}
