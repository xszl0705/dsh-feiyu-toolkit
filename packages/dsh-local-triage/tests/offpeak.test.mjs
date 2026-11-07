import assert from 'node:assert/strict'
import { createHarness } from './_harness.mjs'
import { isOffPeak, nextOffPeakStart, minutesOfDayShanghai, describeWindow, DEFAULT_WINDOW } from '../lib/offpeak.mjs'

const h = createHarness('offpeak.test')

// 北京时间 = UTC+8。用 UTC 构造再检查。
const utc = (h, m) => new Date(Date.UTC(2026, 9, 31, h, m))

h.check('北京时间 03:00 属于谷时', () => {
  // UTC 19:00 前一天 = 北京 03:00
  assert.equal(isOffPeak(utc(19, 0)), true)
})

h.check('北京时间 12:00 不属于谷时', () => {
  assert.equal(isOffPeak(utc(4, 0)), false)
})

h.check('谷时边界：00:30 含、08:30 不含', () => {
  // 北京 00:30 = UTC 16:30 前一天
  assert.equal(isOffPeak(utc(16, 30)), true)
  // 北京 08:30 = UTC 00:30
  assert.equal(isOffPeak(utc(0, 30)), false)
})

h.check('minutesOfDayShanghai 换算正确', () => {
  // 北京 12:00 = UTC 04:00 → 720 分钟
  assert.equal(minutesOfDayShanghai(utc(4, 0)), 720)
})

h.check('nextOffPeakStart 在谷时内原样返回', () => {
  const at = utc(19, 0) // 北京 03:00
  assert.equal(nextOffPeakStart(at).getTime(), at.getTime())
})

h.check('nextOffPeakStart 从峰时指向次日 00:30', () => {
  const at = utc(4, 0) // 北京 12:00
  const next = nextOffPeakStart(at)
  assert.equal(minutesOfDayShanghai(next), 30)
  assert.ok(next.getTime() > at.getTime())
})

h.check('nextOffPeakStart 在 00:30 之后当晚仍要等到次日', () => {
  const at = utc(17, 0) // 北京 01:00 —— 其实在谷时内，应原样返回
  assert.equal(nextOffPeakStart(at).getTime(), at.getTime())
})

h.check('非法日期不判为谷时', () => {
  assert.equal(isOffPeak('not-a-date'), false)
})

h.check('describeWindow 输出可读', () => {
  assert.equal(describeWindow(DEFAULT_WINDOW), '00:30–08:30（北京时间）')
})

h.finish()
