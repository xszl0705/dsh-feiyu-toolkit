/**
 * 间隔重复调度：P0 用 SM-2（够用、可解释、无依赖）。
 * P1 计划换 FSRS-6（ts-fsrs），届时 reviews 表里的 stability/difficulty 字段才启用。
 *
 * 评分沿用 Anki 的 4 档，内部折算成 SM-2 的 0-5 质量分：
 *   1 Again → 1（失败，重新学）
 *   2 Hard  → 3
 *   3 Good  → 4
 *   4 Easy  → 5
 */

export const RATINGS = {
  1: { label: 'Again', quality: 1 },
  2: { label: 'Hard', quality: 3 },
  3: { label: 'Good', quality: 4 },
  4: { label: 'Easy', quality: 5 },
}

const DAY = 24 * 60 * 60 * 1000
const DEFAULT_EF = 2.5
const MIN_EF = 1.3
const MAX_INTERVAL = 365 * 2

/** 纯函数：给定当前状态和评分，算出下一次状态。不碰时钟以外的外部状态。 */
export function schedule(state = {}, rating = 3, now = new Date()) {
  const r = RATINGS[Number(rating)]
  if (!r) throw new Error('rating 必须是 1-4')

  let ef = Number.isFinite(state.ef) ? state.ef : DEFAULT_EF
  let reps = Number.isFinite(state.reps) ? state.reps : 0
  let interval = Number.isFinite(state.interval) ? state.interval : 0
  let lapses = Number.isFinite(state.lapses) ? state.lapses : 0

  const q = r.quality
  const passed = q >= 3

  if (passed) {
    reps += 1
    if (reps === 1) interval = 1
    else if (reps === 2) interval = 6
    else interval = Math.round(interval * ef)
    // SM-2 的 EF 更新公式
    ef = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  } else {
    reps = 0
    interval = 1
    lapses += 1
    // 失败不降 EF：SM-2 原文只在通过时更新，降 EF 会让第二天的卡永远排在后面
  }

  ef = Math.min(Math.max(ef, MIN_EF), 3.0)
  interval = Math.min(Math.max(interval, 1), MAX_INTERVAL)

  const due = new Date(now.getTime() + interval * DAY)
  return {
    ef: Number(ef.toFixed(3)),
    reps,
    interval,
    lapses,
    dueAt: due.toISOString(),
    lastReviewAt: now.toISOString(),
  }
}
