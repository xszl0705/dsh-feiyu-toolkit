/**
 * SM-2 曲线测试：间隔序列必须是可预期的，否则复习队列会越用越乱。
 */
import { schedule } from '../lib/srs.js'

export function run() {
  const cases = []
  const add = (name, ok, actual, expected) => cases.push({ name, ok: Boolean(ok), actual, expected })

  const base = new Date('2026-11-01T12:00:00Z')

  // 连续 Good：1 → 6 → 15 → 38（EF 2.5 不变）
  let s = {}
  const seq = []
  for (let i = 0; i < 4; i++) {
    s = schedule(s, 3, base)
    seq.push(s.interval)
  }
  add('连续 Good 间隔序列', JSON.stringify(seq) === JSON.stringify([1, 6, 15, 38]), seq, [1, 6, 15, 38])
  add('连续 Good 后 reps=4', s.reps === 4, s.reps, 4)
  add('Good 不改变 EF', s.ef === 2.5, s.ef, 2.5)

  // 忘了 → 重置间隔、lapses+1、EF 不降
  const forgot = schedule({ ef: 2.5, reps: 4, interval: 38, lapses: 0 }, 1, base)
  add('Again 重置间隔=1', forgot.interval === 1, forgot.interval, 1)
  add('Again 重置 reps=0', forgot.reps === 0, forgot.reps, 0)
  add('Again lapses+1', forgot.lapses === 1, forgot.lapses, 1)
  add('Again 不降 EF', forgot.ef === 2.5, forgot.ef, 2.5)

  // Easy 升 EF（2.5 → 2.6）
  const easy = schedule({ ef: 2.5, reps: 3, interval: 15, lapses: 0 }, 4, base)
  add('Easy 提升 EF', easy.ef > 2.5, easy.ef, '>2.5')
  add('Easy 间隔变长', easy.interval > 15, easy.interval, '>15')

  // EF 下限：连续 Hard 不应跌破 1.3
  let floor = { ef: 2.5, reps: 3, interval: 10, lapses: 0 }
  for (let i = 0; i < 12; i++) floor = schedule(floor, 2, base)
  add('EF 不低于 1.3', floor.ef >= 1.3, floor.ef, '>=1.3')

  // EF 上限 3.0
  let ceil = { ef: 2.5, reps: 3, interval: 10, lapses: 0 }
  for (let i = 0; i < 12; i++) ceil = schedule(ceil, 4, base)
  add('EF 不超过 3.0', ceil.ef <= 3.0, ceil.ef, '<=3.0')

  // dueAt 必须晚于当前时间，且间隔与 interval 一致（允许 1 小时取整误差）
  const due = schedule({}, 3, base)
  const days = (Date.parse(due.dueAt) - base.getTime()) / 86400000
  add('dueAt 与 interval 一致', Math.abs(days - due.interval) < 0.05, Number(days.toFixed(3)), due.interval)

  // 非法评分要抛错，而不是静默给个默认值
  let threw = false
  try {
    schedule({}, 9, base)
  } catch {
    threw = true
  }
  add('非法评分抛错', threw, threw, true)

  const failed = cases.filter((c) => !c.ok)
  return { ok: failed.length === 0, total: cases.length, failed: failed.length, cases }
}
