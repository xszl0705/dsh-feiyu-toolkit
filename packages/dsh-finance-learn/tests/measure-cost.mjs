/**
 * 消耗测量：工具定义体积（每轮固定注入）+ 单次调用的输出体积。
 * 结果落文件，stdout 会丢。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTools } from '../lib/tools.js'

const tools = createTools(null) // execute 才会用到 store，这里只量定义

function sizeOf(value) {
  return JSON.stringify(value).length
}

const rows = tools.map((t) => {
  const def = { name: t.name, description: t.description, parameters: t.parameters, output: { schema: t.output?.schema } }
  return { name: t.name, chars: sizeOf(def), descChars: sizeOf(t.description), paramChars: sizeOf(t.parameters) }
})

const total = rows.reduce((a, r) => a + r.chars, 0)
const toolCount = tools.length

// 单次输出的真实大小（用实测样例，不臆造）
const sampleQuote3 = {
  asOf: '20261030161455',
  items: [
    { symbol: 'sh600519', name: '贵州茅台', code: '600519', price: 1392.05, prevClose: 1354, open: 1363, high: 1393.37, low: 1352.98, change: 38.05, changePct: 2.81, volume: 59927, amountYuan: 8257380000, pe: 21.18, mcapYi: 17401.76, asOf: '20261030161455', currency: 'CNY' },
    { symbol: 'hk00700', name: '腾讯控股', code: '00700', price: 383.6, prevClose: 377.6, open: 376.4, high: 387.6, low: 375.2, change: 6, changePct: 1.59, volume: 22269954, amountYuan: 8540915574.008, pe: 14.01, mcapYi: 34879.3856, asOf: '2026/10/30 16:08:14', currency: 'HKD' },
    { symbol: 'usAAPL', name: '苹果', code: 'AAPL.OQ', price: 344.63, prevClose: 348.91, open: 346.72, high: 349.19, low: 334.35, change: -4.28, changePct: -1.23, volume: 67841555, amountYuan: 23432601677, pe: 39.52, mcapYi: 50295.92253, asOf: '2026-10-30 16:00:02', currency: 'USD' },
  ],
}

const sampleKline5 = {
  symbol: 'sh600519',
  period: 'day',
  bars: Array.from({ length: 5 }, (_, i) => ({ date: `2026-10-2${4 + i}`, open: 1354.98, close: 1330.75, high: 1354.98, low: 1322.6, volume: 38805 })),
  changePct: 2.81,
}

const out = {
  at: new Date().toISOString(),
  toolCount,
  toolDefChars: total,
  toolDefRows: rows,
  outputSamples: {
    quote3Chars: sizeOf(sampleQuote3),
    kline5Chars: sizeOf(sampleKline5),
  },
}

// 粗略 token 估算：JSON 里英文/符号多，约 3.6 字符/token；中文约 1 字/token。
// 这里给一个区间：保守（2.5 字符/token）与乐观（4 字符/token）。
out.estimates = {
  defTokens: { conservative: Math.round(total / 2.5), likely: Math.round(total / 3.6), optimistic: Math.round(total / 4) },
  quote3Tokens: { conservative: Math.round(out.outputSamples.quote3Chars / 2.5), likely: Math.round(out.outputSamples.quote3Chars / 3.6) },
}

fs.writeFileSync(path.join(os.tmpdir(), 'finance-learn-cost.json'), JSON.stringify(out, null, 2), 'utf8')
