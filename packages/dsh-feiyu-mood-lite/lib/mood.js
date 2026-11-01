/**
 * 心情状态：读写 ~/.dsh/feiyu-mood/state.json（feiyu-mood v2 格式）
 *
 * 只依赖这一份文件，所以：
 *   - 桌宠状态卡（pet_card.py）能直接读
 *   - pet-hub 每 3 秒的快照也能直接读
 *   - 卸载本插件后数据仍在，换回原版 dsh-feiyu-mood 也能接上
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DIMS = ['happy', 'calm', 'sweet', 'heartache', 'worry', 'sad', 'jealous']

/**
 * 每个情绪维度的衰减率（每小时，e 指数）。
 * 参考“负面更黏”的普遍结论：sad/worry/heartache 留得久，happy/calm 散得快。
 * 99% 回平所需时间 ≈ 4.6 / k：happy 约 13h、sad 约 38h、heartache 约 46h。
 */
export const DIM_DECAY_PER_HOUR = {
  happy: 0.35,
  calm: 0.2,
  sweet: 0.3,
  heartache: 0.1,
  worry: 0.16,
  sad: 0.12,
  jealous: 0.25,
}

export function moodFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'feiyu-mood', 'state.json')
}

export function clamp(n, min = 0, max = 100) {
  const value = Number(n)
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function labelOf(value) {
  const v = Number(value)
  if (!Number.isFinite(v)) return '未知'
  if (v >= 80) return '开心'
  if (v >= 60) return '平稳'
  if (v >= 40) return '一般'
  if (v >= 20) return '低落'
  return '很难过'
}

function emptyDims() {
  const dims = {}
  for (const key of DIMS) dims[key] = 0
  return dims
}

export function emptyState(now = Date.now()) {
  return {
    version: 2,
    moods: {
      __default__: {
        mood: 60,
        dims: emptyDims(),
        lastReason: '',
        lastConfidence: 0,
        injectedFor: 0,
        lastInjectedText: '',
        lastInjectedAt: 0,
        saidAt: [],
        lastNotedMood: 60,
        minor: false,
        kind: '',
        updatedAt: now,
        lastDecayAt: now,
        timeline: [],
      },
    },
    lastActive: '__default__',
  }
}

/** 把任意旧文件补齐成 v2 结构，未知字段原样保留。 */
export function normalize(raw, now = Date.now()) {
  const base = raw && typeof raw === 'object' ? raw : {}
  const state = {
    ...emptyState(now),
    ...base,
    version: 2,
    moods: base.moods && typeof base.moods === 'object' ? base.moods : {},
  }
  if (!state.moods.__default__ || typeof state.moods.__default__ !== 'object') {
    state.moods.__default__ = emptyState(now).moods.__default__
  }
  const room = state.moods.__default__
  room.mood = clamp(room.mood ?? 60)
  room.dims = { ...emptyDims(), ...(room.dims && typeof room.dims === 'object' ? room.dims : {}) }
  for (const key of DIMS) room.dims[key] = clamp(room.dims[key] ?? 0)
  room.lastReason = typeof room.lastReason === 'string' ? room.lastReason : ''
  room.timeline = Array.isArray(room.timeline) ? room.timeline : []
  room.updatedAt = Number(room.updatedAt) || now
  room.lastDecayAt = Number(room.lastDecayAt) || room.updatedAt
  state.lastActive = '__default__'
  return state
}

export function readState(file = moodFile()) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return emptyState()
  }
}

export function saveState(state, file = moodFile()) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const text = JSON.stringify(state, null, 2)
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch {
    // 极少数情况下 rename 被占用：直接覆盖，别把心情写丢
    fs.writeFileSync(file, text, 'utf8')
    try {
      fs.unlinkSync(tmp)
    } catch {
      // ignore
    }
  }
}

/** 随时间回落到基线：默认每小时回 12%，不会一夜之间归零。 */
export function decay(state, {
  at = Date.now(),
  baseline = 60,
  rate = 0.12,
  // 负面情绪更黏：低于基线时恢复更慢，高于基线时回落稍快
  negativeFactor = 0.7,
  positiveFactor = 1.15,
  // 每个情绪维度自己的衰减率（每小时 e 指数），负向整体比正向慢
  dimRates = null,
} = {}) {
  const room = state.moods.__default__
  const last = Number(room.lastDecayAt) || Number(room.updatedAt) || at
  const hours = (at - last) / 3600000
  if (!(hours > 0.05)) return false

  const mood = Number(room.mood ?? 60)
  const bias = mood < baseline ? negativeFactor : positiveFactor
  const pull = 1 - Math.exp(-Math.max(0, rate) * Math.max(0, bias) * hours)
  room.mood = clamp(mood + (Number(baseline) - mood) * Math.min(0.95, pull))

  const table = { ...DIM_DECAY_PER_HOUR, ...(dimRates && typeof dimRates === 'object' ? dimRates : {}) }
  for (const key of DIMS) {
    const k = Number(table[key])
    if (!(k > 0)) continue
    room.dims[key] = clamp(room.dims[key] * Math.exp(-k * hours))
    if (room.dims[key] < 0.5) room.dims[key] = 0
  }

  room.lastDecayAt = at
  room.updatedAt = Math.max(Number(room.updatedAt) || 0, at)
  return true
}

/** 应用一轮判断结果；delta 先夹到 ±12，防止一句话把心情打穿。 */
export function applyDelta(state, { delta = 0, reason = '', dims = null, at = Date.now(), meta = null } = {}) {
  const room = state.moods.__default__
  const step = clamp(Math.round(Number(delta) || 0), -12, 12)
  room.mood = clamp(Number(room.mood ?? 60) + step)
  if (dims && typeof dims === 'object') {
    for (const key of DIMS) {
      if (dims[key] === undefined || dims[key] === null) continue
      room.dims[key] = clamp(dims[key])
    }
  }
  room.lastReason = String(reason || '').slice(0, 24)
  room.lastNotedMood = room.mood
  room.updatedAt = at
  room.timeline = [
    ...(Array.isArray(room.timeline) ? room.timeline : []),
    { at, mood: room.mood, delta: step, reason: room.lastReason, ...(meta ? { appraisal: meta } : {}) },
  ].slice(-60)
  return room
}

export function summary(state) {
  const room = state.moods.__default__
  return {
    mood: Math.round(room.mood),
    label: labelOf(room.mood),
    reason: room.lastReason || '',
    updatedAt: Number(room.updatedAt) || 0,
    dims: { ...room.dims },
    timeline: (room.timeline || []).slice(-5),
  }
}
