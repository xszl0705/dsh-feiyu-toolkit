/**
 * 用本地 qwen3:4b 跑 turn-taking gate（只输出 JSON，不写最终回复）。
 */
import { buildGatePrompt, parseGateResult } from './gate.js'

const BOT_IDS = ['1370218236', '2799812774']
const SELF_NAMES = ['虚的鱼', '大肥鱼']

/** 小模型会读错 @ 对象/自回，这里用确定性规则兜底。 */
function applyHardRules(result, candidate) {
  const text = String(candidate?.text || '')
  const speaker = String(candidate?.speaker || '')
  if (SELF_NAMES.some((name) => speaker.includes(name))) {
    return { ...result, action: 'silence', relevance: 0, reason: 'hard-rule:self-message' }
  }
  const ats = [...text.matchAll(/@(\d{5,})/g)].map((m) => m[1])
  if (ats.length && !ats.some((id) => BOT_IDS.includes(id))) {
    return { ...result, action: 'silence', relevance: 0, reason: 'hard-rule:at-other' }
  }
  if (ats.some((id) => BOT_IDS.includes(id))) {
    return {
      ...result,
      ok: true,
      action: 'reply',
      relevance: Math.max(0.8, Number(result?.relevance) || 0),
      evidence: result?.evidence?.length ? result.evidence : [String(candidate?.id || '')],
      reason: 'hard-rule:at-bot',
    }
  }
  return result
}

export async function runGateLocal({ identity = '', recent = [], candidate = {}, knowledge = [], groupName = '', config = {} } = {}) {
  const endpoint = String(config.endpoint || 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const model = String(config.model || 'qwen3:4b')
  const prompt = buildGatePrompt({ identity, recent, candidate, knowledge, groupName })
  const res = await fetch(`${endpoint}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: 'json',
      keep_alive: '30m',
      options: {
        temperature: 0.1,
        num_ctx: 4096,
        num_predict: 320,
      },
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(Number(config.timeoutMs) || 25000),
  })
  if (!res.ok) throw new Error(`gate local ${res.status}`)
  const data = await res.json()
  return applyHardRules(parseGateResult(String(data?.message?.content || '')), candidate)
}
