/**
 * 实网冒烟：验证插件进程内的真实请求路径（不是宿主 web_fetch 通道）。
 * 结果落文件，因为 Electron node 模式 stdout 会丢。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fetchQuote, fetchKline, fetchIndex, fetchMacro } from '../lib/sources.js'

const out = { at: new Date().toISOString() }

try {
  const q = await fetchQuote(['600519', 'hk00700', 'usAAPL'])
  out.quote = { ok: q.ok, error: q.error, count: q.items?.length, sample: q.items?.[0] }
} catch (e) {
  out.quote = { ok: false, error: String(e?.message || e) }
}

try {
  const k = await fetchKline('600519', { count: 5 })
  out.klineA = { ok: k.ok, error: k.error, bars: k.bars?.length, last: k.bars?.[k.bars.length - 1] }
} catch (e) {
  out.klineA = { ok: false, error: String(e?.message || e) }
}

try {
  const k = await fetchKline('usAAPL', { count: 5 })
  out.klineUS = { ok: k.ok, error: k.error, bars: k.bars?.length, last: k.bars?.[k.bars.length - 1] }
} catch (e) {
  out.klineUS = { ok: false, error: String(e?.message || e) }
}

try {
  const k = await fetchKline('hk00700', { count: 5 })
  out.klineHK = { ok: k.ok, error: k.error, bars: k.bars?.length, last: k.bars?.[k.bars.length - 1] }
} catch (e) {
  out.klineHK = { ok: false, error: String(e?.message || e) }
}

try {
  const idx = await fetchIndex()
  out.index = { ok: idx.ok, error: idx.error, items: idx.items }
} catch (e) {
  out.index = { ok: false, error: String(e?.message || e) }
}

try {
  const m = await fetchMacro({ countries: ['CN'], indicator: 'NY.GDP.MKTP.CD', years: 3 })
  out.macro = { ok: m.ok, error: m.error, lastUpdated: m.lastUpdated, rows: m.rows?.slice(0, 3) }
} catch (e) {
  out.macro = { ok: false, error: String(e?.message || e) }
}

fs.writeFileSync(path.join(os.tmpdir(), 'finance-learn-live.json'), JSON.stringify(out, null, 2), 'utf8')
