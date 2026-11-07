/**
 * 三档路由：L0 规则 → L1 本地 4B → L2 云端。
 *
 * 融合逻辑就是安全阀：
 *   规则命中          → 直接用
 *   模型 conf ≥ 阈值  → 用模型结论
 *   模型 conf < 阈值  → frontier（保守兜底）
 *   模型超时/失败      → frontier（fail-open）
 *
 * 这套顺序保证了一件事：analyze() 永远返回一个可用的 tier，永远不抛。
 */

import { ruleTier } from './rules.mjs'
import { toFeatures } from './features.mjs'
import { chatJSON } from './ollama.mjs'

export const DEFAULTS = {
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen3:4b',
  confidence: 0.75,
  timeoutMs: 1500,
  keepAlive: '30m',
  numCtx: 1024,
  numPredict: 64,
  capModelLocal: true,
  // binary = 只判"要不要主力模型"（实测更准）；ternary = 三分类（留作对照）
  decisionStyle: 'binary',
}

const SYSTEM_PROMPT = `你是请求分诊器。只做一件事：判断这条请求该由哪一档模型处理。

判定标准：
- local：整条消息是对上一条的确认、状态回执或社交回应，不含问题、不含指令
- cheap：需要一次查询或一步操作（看状态、改配置、解释概念），不跨文件、不需要规划
- frontier：需要调研检索、多步规划、跨文件修改、定位故障，或产出方案/文档

注意：如果请求里有"这个/这段/上面/刚才"这类指代，说明必须看代码或上文才能回答，至少判 cheap。
拿不准就选 frontier。

示例：
"好的谢谢" → {"tier":"local","conf":0.95,"why":"确认"}
"隔壁在做什么" → {"tier":"cheap","conf":0.8,"why":"查状态"}
"微心跳方案是什么" → {"tier":"cheap","conf":0.8,"why":"查历史"}
"检索网上其他方案" → {"tier":"frontier","conf":0.9,"why":"要调研"}
"重启后qq没反应" → {"tier":"frontier","conf":0.9,"why":"要排障"}

只输出 JSON，不要解释：{"tier":"local|cheap|frontier","conf":0.0,"why":"不超过6字"}`

// 二分类版本：只回答"要不要主力模型"。
// 实测 4B 分不清 cheap 和 frontier，但分得清"这活要不要动大模型"。
const BINARY_PROMPT = `你是请求分诊器。只判断一件事：这条请求需不需要主力大模型。

需要（frontier=true）：调研检索、多步规划、跨文件修改、定位故障、产出方案或文档、涉及系统配置变更
不需要（frontier=false）：查状态、看日志、改配置、解释概念、确认或社交回应、单步操作

拿不准就判 true（宁可多花钱，也别让弱模型误事）。

示例：
"好的谢谢" → {"frontier":false,"conf":0.95,"why":"确认"}
"隔壁在做什么" → {"frontier":false,"conf":0.85,"why":"查状态"}
"微心跳方案是什么" → {"frontier":false,"conf":0.8,"why":"查历史"}
"重启后qq没反应" → {"frontier":true,"conf":0.9,"why":"要排障"}
"检索网上其他方案" → {"frontier":true,"conf":0.9,"why":"要调研"}
"把 look 删了吧" → {"frontier":true,"conf":0.8,"why":"改系统"}

只输出 JSON，不要解释：{"frontier":true|false,"conf":0.0,"why":"不超过6字"}`

function clamp01(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

function normalizeTier(value) {
  const s = String(value ?? '').toLowerCase().trim()
  if (s === 'local' || s === 'cheap' || s === 'frontier') return s
  return null
}

/**
 * @param {{text:string, turns?:number, tools?:string[], attachments?:number}} req
 * @param {object} [opts] 覆盖 DEFAULTS 的任意字段
 * @returns {Promise<{tier:'local'|'cheap'|'frontier', source:'rule'|'model'|'fallback',
 *                    conf:number, why:string, ms:number}>}
 */
export async function analyze(req, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const startedAt = Date.now()

  // ---- L0 规则 ----
  const rule = ruleTier(req, cfg.rules || {})
  if (rule.tier) {
    return { tier: rule.tier, source: 'rule', conf: 1, why: rule.why, ms: Date.now() - startedAt }
  }

  // ---- L1 本地模型 ----
  const style = cfg.decisionStyle === 'ternary' ? 'ternary' : 'binary'
  try {
    const { parsed, totalMs } = await chatJSON({
      endpoint: cfg.endpoint,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
      numCtx: cfg.numCtx,
      numPredict: cfg.numPredict,
      keepAlive: cfg.keepAlive,
      circuitOpts: cfg.circuit || {},
      messages: [
        { role: 'system', content: style === 'binary' ? BINARY_PROMPT : SYSTEM_PROMPT },
        { role: 'user', content: toFeatures(req) },
      ],
    })

    const conf = clamp01(parsed?.conf)
    const why = String(parsed?.why ?? '').slice(0, 12)
    const ms = Math.round(totalMs || Date.now() - startedAt)

    // 置信度不足一律升级：保守方向永远是 frontier。
    if (conf < cfg.confidence) {
      return { tier: 'frontier', source: 'fallback', conf, why: `low-conf:${why}`, ms }
    }

    if (style === 'binary') {
      const raw = parsed?.frontier
      const asked = raw === true || String(raw).toLowerCase() === 'true'
      const answered = raw !== undefined && raw !== null
      if (!answered) {
        return { tier: 'frontier', source: 'fallback', conf, why: 'bad-shape', ms }
      }
      return { tier: asked ? 'frontier' : 'cheap', source: 'model', conf, why, ms }
    }

    // ternary（保留旧路径做对照）
    const tier = normalizeTier(parsed?.tier)
    if (!tier) return { tier: 'frontier', source: 'fallback', conf: 0, why: 'bad-tier', ms }

    // 模型只有"往上调"的权限，没有"往下压到 local"的权限。
    // 实测 4B 会把「这个函数是干什么的」「隔壁在做什么」都判成 local，
    // 且恒给 conf≈0.95，阈值拦不住。local 只能由规则白名单产生。
    const safeTier = tier === 'local' && cfg.capModelLocal !== false ? 'cheap' : tier
    const cappedWhy = safeTier === tier ? why : `capped:${why}`
    return { tier: safeTier, source: 'model', conf, why: cappedWhy, ms }
  } catch (error) {
    return {
      tier: 'frontier',
      source: 'fallback',
      conf: 0,
      why: `local-fail:${error?.code || error?.message || 'unknown'}`,
      ms: Date.now() - startedAt,
    }
  }
}
