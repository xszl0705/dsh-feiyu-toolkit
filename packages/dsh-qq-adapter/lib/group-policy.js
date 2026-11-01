/**
 * 群聊参与策略：概率门 + 能量 + 密度 + 静默状态机。
 * 纯函数，便于单测；状态由 group-policy-store.js 持久化。
 */

export const DEFAULT_POLICY = Object.freeze({
  enabled: true,
  mode: 'shadow', // shadow | live
  baseProbability: 0.05,
  afterReplyProbability: 0.5,
  afterReplyWindowSec: 120,
  minMessageChars: 4,
  maxPerHour: 4,
  minIntervalSec: 180,
  botCooldownSec: 180,
  densityWindowSec: 300,
  densityMax: 3,
  densitySoftRatio: 0.6,
  silenceAfter: 3,
  silenceMaxSec: 600,
  silenceMaxMessages: 8,
  minEnergyToReply: 0.15,
  energy: {
    initial: 0.7,
    costBase: 0.1,
    costPerChar: 0.0005,
    recoveryPerMin: 0.02,
    atRecovery: 0.3,
  },
  quality: {
    questionBoost: 0.15,
    waterReduce: 0.1,
    questionWords: ['吗', '呢', '怎么', '为什么', '啥', '如何', '是不是', '能不能', '有没有', '多少', '谁', '哪'],
    waterWords: ['哈', '哈哈', '哈哈哈', '嗯', '嗯嗯', '哦', '哦哦', '好', '好的', '行', '对', '是的', '6', '66', '666', '草', '笑死', '确实', '离谱', '无语', '233'],
  },
  interestKeywords: [],
  wakeWords: ['大肥鱼', '虚的鱼', '小鱼', '肥鱼'],
  internalStateWords: ['刚醒', '状态模糊', '别乱动', '需要确认群状态'],
})

export function normalizePolicy(input = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  return {
    ...DEFAULT_POLICY,
    ...raw,
    energy: { ...DEFAULT_POLICY.energy, ...(raw.energy || {}) },
    quality: { ...DEFAULT_POLICY.quality, ...(raw.quality || {}) },
    interestKeywords: Array.isArray(raw.interestKeywords) ? raw.interestKeywords.map(String) : [],
    wakeWords: Array.isArray(raw.wakeWords) ? raw.wakeWords.map(String) : DEFAULT_POLICY.wakeWords,
  }
}

export function createPolicyState(now = Date.now(), cfg = DEFAULT_POLICY) {
  return {
    groupId: '',
    energy: cfg.energy?.initial ?? 0.7,
    lastMessageAt: 0,
    lastReplyAt: 0,
    lastProactiveAt: 0,
    replyTimes: [],
    silenceStreak: 0,
    silentUntil: 0,
    silentMessages: 0,
    score: 50,
    updatedAt: now,
  }
}

export function refillEnergy(state, now = Date.now(), cfg = DEFAULT_POLICY) {
  const last = Number(state.lastMessageAt) || now
  const minutes = Math.max(0, (now - last) / 60000)
  const rate = Number(cfg.energy?.recoveryPerMin) || 0
  return Math.min(1, Math.max(0, Number(state.energy) || 0) + minutes * rate)
}

export function isQuestion(text, cfg = DEFAULT_POLICY) {
  const value = String(text || '')
  if (/[?？]/.test(value)) return true
  return (cfg.quality?.questionWords || []).some((word) => word && value.includes(word))
}

export function isWater(text, cfg = DEFAULT_POLICY) {
  const value = String(text || '').trim()
  if (!value) return true
  if (value.length <= 2 && !isQuestion(value)) return true
  return (cfg.quality?.waterWords || []).includes(value)
}

export function hasInterest(text, cfg = DEFAULT_POLICY) {
  const value = String(text || '')
  return (cfg.interestKeywords || []).some((word) => word && value.includes(word))
}

export function isWake(text, cfg = DEFAULT_POLICY) {
  const value = String(text || '')
  return (cfg.wakeWords || []).some((word) => word && value.includes(word))
}

export function densityFactor(state, now = Date.now(), cfg = DEFAULT_POLICY) {
  const windowMs = Math.max(1, Number(cfg.densityWindowSec) || 300) * 1000
  const max = Math.max(1, Number(cfg.densityMax) || 3)
  const soft = Math.min(1, Math.max(0, Number(cfg.densitySoftRatio) || 0.6))
  const times = (Array.isArray(state.replyTimes) ? state.replyTimes : []).filter((t) => now - Number(t) < windowMs)
  if (times.length >= max) return 0
  const start = max * soft
  if (times.length < start) return 1
  const span = Math.max(0.001, max - start)
  return Math.max(0.1, 1 - ((times.length - start) / span) * 0.9)
}

export function qualityFactor(text, cfg = DEFAULT_POLICY) {
  let f = 1
  if (isQuestion(text, cfg)) f += Number(cfg.quality?.questionBoost) || 0
  if (isWater(text, cfg)) f -= Number(cfg.quality?.waterReduce) || 0
  if (hasInterest(text, cfg)) f += 0.3
  return Math.max(0.05, f)
}

export function computeProbability({ text, state, cfg = DEFAULT_POLICY, now = Date.now() } = {}) {
  const base = Math.max(0, Number(cfg.baseProbability) || 0)
  const energy = refillEnergy(state, now, cfg)
  const energyFactor = energy < Number(cfg.minEnergyToReply) ? 0 : 0.5 + energy * 0.5
  const density = densityFactor(state, now, cfg)
  const quality = qualityFactor(text, cfg)
  let p = base * energyFactor * density * quality

  const lastReply = Number(state.lastReplyAt) || 0
  if (lastReply && now - lastReply <= (Number(cfg.afterReplyWindowSec) || 120) * 1000) {
    p = Math.max(p, Number(cfg.afterReplyProbability) || 0)
  }

  // 冷却与最小间隔：@ 不走这里
  const lastProactive = Number(state.lastProactiveAt) || 0
  if (lastProactive && now - lastProactive < (Number(cfg.minIntervalSec) || 180) * 1000) p = 0

  return { probability: Math.max(0, Math.min(1, p)), energy, density, quality }
}

export function decideCandidate({ text, state, cfg = DEFAULT_POLICY, now = Date.now(), random = Math.random } = {}) {
  const value = String(text || '').trim()
  if (value.length < (Number(cfg.minMessageChars) || 4)) {
    return { candidate: false, reason: 'too-short', probability: 0 }
  }
  if (Number(state.silentUntil) > now) {
    return { candidate: false, reason: 'silent', probability: 0 }
  }
  const { probability, energy, density, quality } = computeProbability({ text: value, state, cfg, now })
  const roll = Math.min(0.999999, Math.max(0, Number(random) || 0))
  return {
    candidate: roll < probability,
    reason: probability <= 0 ? 'probability-zero' : roll < probability ? 'probability-hit' : 'probability-miss',
    probability,
    roll,
    energy,
    density,
    quality,
  }
}

export function markMessage(state, now = Date.now(), cfg = DEFAULT_POLICY) {
  return {
    ...state,
    energy: refillEnergy(state, now, cfg),
    lastMessageAt: now,
    silentMessages: (Number(state.silentMessages) || 0) + 1,
    updatedAt: now,
  }
}

export function markReply(state, text = '', now = Date.now(), cfg = DEFAULT_POLICY) {
  const chars = String(text || '').length
  const cost = (Number(cfg.energy?.costBase) || 0.1) + chars * (Number(cfg.energy?.costPerChar) || 0.0005)
  const times = [...(Array.isArray(state.replyTimes) ? state.replyTimes : []), now].slice(-30)
  return {
    ...state,
    energy: Math.max(0, Math.min(1, (Number(state.energy) || 0.7) - cost)),
    lastReplyAt: now,
    lastProactiveAt: now,
    replyTimes: times,
    silenceStreak: 0,
    silentUntil: 0,
    silentMessages: 0,
    score: Math.min(100, (Number(state.score) || 50) + 5),
    updatedAt: now,
  }
}

export function markSilence(state, now = Date.now(), cfg = DEFAULT_POLICY) {
  const streak = (Number(state.silenceStreak) || 0) + 1
  const threshold = Math.max(1, Number(cfg.silenceAfter) || 3)
  const out = { ...state, silenceStreak: streak, updatedAt: now }
  if (streak >= threshold) {
    out.silentUntil = now + (Number(cfg.silenceMaxSec) || 600) * 1000
    out.silentMessages = 0
    out.silenceStreak = 0
  }
  return out
}

export function wakeOnAddress(state, now = Date.now()) {
  return { ...state, silentUntil: 0, silentMessages: 0, silenceStreak: 0, updatedAt: now }
}

export function addScore(state, delta, now = Date.now()) {
  return {
    ...state,
    score: Math.max(10, Math.min(100, (Number(state.score) || 50) + Number(delta || 0))),
    updatedAt: now,
  }
}
