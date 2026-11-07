/**
 * 谷时调度：判断某个时刻是否落在优惠时段，以及下一次谷时是什么时候。
 *
 * DeepSeek 的定价分峰谷（谷时约为峰时的一半）。北京时间没有夏令时，
 * 所以直接用固定 +08:00 偏移换算，不引时区库。
 *
 * 注意：这里只提供判断能力，不负责排队。要不要把任务挪到谷时，取决于
 * 「延后执行是否可接受」——实时对话不可延后，批量任务可以。
 */

export const SHANGHAI_OFFSET_MIN = 480

// 默认谷时：00:30 – 08:30（含起点，不含终点）
export const DEFAULT_WINDOW = { startMin: 30, endMin: 510 }

/** 把 Date 换算成东八区的「当天第几分钟」 */
export function minutesOfDayShanghai(date = new Date()) {
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes()
  return (utcMin + SHANGHAI_OFFSET_MIN) % 1440
}

/**
 * 是否处于谷时。
 * @param {Date|string|number} at
 * @param {{startMin:number,endMin:number}} [win]
 */
export function isOffPeak(at = new Date(), win = DEFAULT_WINDOW) {
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) return false
  const m = minutesOfDayShanghai(d)
  const { startMin, endMin } = win
  // 允许跨零点表达（start > end 表示窗口跨天）
  if (startMin <= endMin) return m >= startMin && m < endMin
  return m >= startMin || m < endMin
}

/**
 * 下一次谷时开始时间；若当前已在谷时，原样返回。
 * @param {Date} [from]
 * @param {{startMin:number,endMin:number}} [win]
 * @returns {Date}
 */
export function nextOffPeakStart(from = new Date(), win = DEFAULT_WINDOW) {
  const d = new Date(from.getTime())
  if (isOffPeak(d, win)) return d

  const m = minutesOfDayShanghai(d)
  let delta = win.startMin - m
  if (delta <= 0) delta += 1440
  return new Date(d.getTime() + delta * 60_000)
}

/** 人类可读的窗口描述，用于日志 */
export function describeWindow(win = DEFAULT_WINDOW) {
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  return `${fmt(win.startMin)}–${fmt(win.endMin)}（北京时间）`
}
