/**
 * 行情解析契约测试：字段索引靠实测，必须用 fixture 锁住。
 * 任何一个字段错位，测试先红，而不是给用户一个错误价格。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseQuoteText, normalizeSymbol } from '../lib/sources.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function fixture(name) {
  return fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8')
}

export function run() {
  const cases = []
  const add = (name, ok, actual, expected) => cases.push({ name, ok: Boolean(ok), actual, expected })

  // ---- A 股
  const a = parseQuoteText(fixture('tencent-quote-a.txt'))[0]
  add('A股 名称', a?.name === '贵州茅台', a?.name, '贵州茅台')
  add('A股 现价', a?.price === 1392.05, a?.price, 1392.05)
  add('A股 涨跌幅', a?.changePct === 2.81, a?.changePct, 2.81)
  add('A股 涨跌额', a?.change === 38.05, a?.change, 38.05)
  add('A股 最高', a?.high === 1393.37, a?.high, 1393.37)
  add('A股 最低', a?.low === 1352.98, a?.low, 1352.98)
  add('A股 PE', a?.pe === 21.18, a?.pe, 21.18)
  add('A股 总市值(亿)', a?.mcapYi === 17401.76, a?.mcapYi, 17401.76)
  // 成交额：A 股原始单位是万元，解析层统一换成元
  add('A股 成交额(元)', Math.round(a?.amountYuan) === 8257380000, Math.round(a?.amountYuan), 8257380000)
  add('A股 币种', a?.currency === 'CNY', a?.currency, 'CNY')

  // ---- 港股
  const hk = parseQuoteText(fixture('tencent-quote-hk.txt'))[0]
  add('港股 名称', hk?.name === '腾讯控股', hk?.name, '腾讯控股')
  add('港股 现价', hk?.price === 383.6, hk?.price, 383.6)
  add('港股 涨跌幅', hk?.changePct === 1.59, hk?.changePct, 1.59)
  add('港股 PE', hk?.pe === 14.01, hk?.pe, 14.01)
  add('港股 成交额(元)', Math.round(hk?.amountYuan) === 8540915574, Math.round(hk?.amountYuan), 8540915574)
  add('港股 总市值(亿)', hk?.mcapYi === 34879.3856, hk?.mcapYi, 34879.3856)
  add('港股 币种', hk?.currency === 'HKD', hk?.currency, 'HKD')

  // ---- 美股
  const us = parseQuoteText(fixture('tencent-quote-us.txt'))[0]
  add('美股 名称', us?.name === '苹果', us?.name, '苹果')
  add('美股 现价', us?.price === 344.63, us?.price, 344.63)
  add('美股 涨跌幅', us?.changePct === -1.23, us?.changePct, -1.23)
  add('美股 PE', us?.pe === 39.52, us?.pe, 39.52)
  add('美股 市值(亿)', us?.mcapYi === 50295.92253, us?.mcapYi, 50295.92253)
  add('美股 币种', us?.currency === 'USD', us?.currency, 'USD')

  // ---- 符号归一化
  add('600519 → sh600519', normalizeSymbol('600519') === 'sh600519', normalizeSymbol('600519'), 'sh600519')
  add('000858 → sz000858', normalizeSymbol('000858') === 'sz000858', normalizeSymbol('000858'), 'sz000858')
  add('700 → hk00700', normalizeSymbol('700') === 'hk00700', normalizeSymbol('700'), 'hk00700')
  add('aapl → usAAPL', normalizeSymbol('aapl') === 'usAAPL', normalizeSymbol('aapl'), 'usAAPL')
  add('sh600519 原样', normalizeSymbol('sh600519') === 'sh600519', normalizeSymbol('sh600519'), 'sh600519')

  let threw = false
  try {
    normalizeSymbol('????????')
  } catch {
    threw = true
  }
  add('非法代码抛错', threw, threw, true)

  const failed = cases.filter((c) => !c.ok)
  return { ok: failed.length === 0, total: cases.length, failed: failed.length, cases }
}
