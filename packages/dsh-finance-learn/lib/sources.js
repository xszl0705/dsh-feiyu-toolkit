/**
 * 数据源：只走实测可用、且插件进程（Electron Node）能直连的通道。
 *
 *   A股/港股/美股行情   qt.gtimg.cn           200 ✅   `~` 分隔
 *   A股/港股/美股 K线   web.ifzq.gtimg.cn     200 ✅   A: qfqday / HK: qfqday / US: day
 *   指数快照            qt.gtimg.cn (s_ 前缀) 200 ✅
 *   宏观（年频）        api.worldbank.org     200 ✅
 *
 * 东财 push2 系列在插件进程里 socket hang up（TLS 指纹被风控），本文件不碰。
 */
import https from 'node:https'
import { decodeBody } from './decode.js'

const TIMEOUT_MS = 8000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
const REFERER = 'https://gu.qq.com/'

const KLINE_HOST = {
  A: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
  HK: 'https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get',
  US: 'https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get',
}

/** 统一符号：sh600519 / sz000858 / hk00700 / usAAPL。 */
export function normalizeSymbol(raw) {
  const s = String(raw || '').trim()
  if (!s) throw new Error('空代码')
  const lower = s.toLowerCase()
  if (/^(sh|sz|bj)\d{6}$/.test(lower)) return lower
  if (/^hk\d{1,5}$/.test(lower)) return 'hk' + lower.slice(2).padStart(5, '0')
  if (/^us[a-z][a-z.\-]{0,9}$/.test(lower)) return 'us' + s.slice(2).toUpperCase()
  if (/^\d{6}$/.test(s)) {
    if (/^(6|9)/.test(s)) return 'sh' + s
    if (/^(0|3)/.test(s)) return 'sz' + s
    if (/^(4|8)/.test(s)) return 'bj' + s
    return 'sh' + s
  }
  if (/^\d{1,5}$/.test(s)) return 'hk' + s.padStart(5, '0')
  if (/^[a-z][a-z.\-]{0,9}$/i.test(s)) return 'us' + s.toUpperCase()
  throw new Error('认不出的代码：' + s)
}

export function marketOf(symbol) {
  if (symbol.startsWith('hk')) return 'HK'
  if (symbol.startsWith('us')) return 'US'
  return 'A'
}

export function displayCode(symbol) {
  const m = marketOf(symbol)
  if (m === 'A') return symbol.slice(2)
  if (m === 'HK') return symbol.slice(2)
  return symbol.slice(2)
}

/** 单次 https GET，返回 {ok, text, contentType, ms}。不抛错，交给调用方决定降级。 */
function httpText(url) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    try {
      const req = https.get(url, { headers: { 'user-agent': UA, referer: REFERER, accept: '*/*' }, timeout: TIMEOUT_MS }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buffer = Buffer.concat(chunks)
          finish({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: decodeBody(buffer, res.headers['content-type']),
            contentType: res.headers['content-type'] || '',
            ms: Date.now() - t0,
          })
        })
      })
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', (error) => finish({ ok: false, status: 0, error: String(error.message || error), ms: Date.now() - t0 }))
    } catch (error) {
      finish({ ok: false, status: 0, error: String(error.message || error), ms: Date.now() - t0 })
    }
  })
}

/**
 * 行情：一次最多 20 只。
 * 返回结构化字段，只取三市场位置一致的列；A 股独有的（成交额万元）在这里统一换算成元。
 */
export async function fetchQuote(symbols) {
  const list = [...new Set((symbols || []).map(normalizeSymbol))].slice(0, 20)
  if (!list.length) return { ok: false, error: 'EMPTY_SYMBOLS' }
  const res = await httpText('https://qt.gtimg.cn/q=' + list.join(','))
  if (!res.ok) return { ok: false, error: res.error || `HTTP ${res.status}`, symbols: list }
  const rows = parseQuoteText(res.text)
  if (!rows.length) return { ok: false, error: 'PARSE_EMPTY', raw: String(res.text || '').slice(0, 120) }
  return { ok: true, source: '腾讯财经', fetchedAt: new Date().toISOString(), ms: res.ms, items: rows }
}

/**
 * 字段索引（实测，无官方文档）。
 * 美股在五档区少一个字段，整段左移 1：时间在 29 而不是 30。
 * 成交额：A 股是万元（需 ×1e4），港美是元。
 */
const QUOTE_INDEX = {
  A: { time: 30, change: 31, pct: 32, high: 33, low: 34, amount: 37, pe: 39, mcap: 45 },
  HK: { time: 30, change: 31, pct: 32, high: 33, low: 34, amount: 37, pe: 39, mcap: 45 },
  US: { time: 29, change: 30, pct: 31, high: 32, low: 33, amount: 36, pe: 38, mcap: 44 },
}

/** 纯函数：解析 `v_sh600519="..."` 多行文本。 */
export function parseQuoteText(text) {
  const out = []
  const re = /v_([a-zA-Z0-9_]+)="([^"]*)"/g
  let m
  while ((m = re.exec(String(text || ''))) !== null) {
    const symbol = m[1]
    const f = m[2].split('~')
    if (f.length < 40 || !f[3]) continue
    const market = f[0]
    const kind = symbol.startsWith('us') ? 'US' : symbol.startsWith('hk') ? 'HK' : market === '1' || market === '51' ? 'A' : symbol.startsWith('sh') || symbol.startsWith('sz') || symbol.startsWith('bj') ? 'A' : 'UNKNOWN'
    const idx = QUOTE_INDEX[kind] || QUOTE_INDEX.A
    const isA = kind === 'A'
    const amountRaw = num(f[idx.amount])
    out.push({
      symbol,
      name: f[1],
      code: f[2],
      price: num(f[3]),
      prevClose: num(f[4]),
      open: num(f[5]),
      high: num(f[idx.high]),
      low: num(f[idx.low]),
      change: num(f[idx.change]),
      changePct: num(f[idx.pct]),
      volume: num(f[6]),
      // A 股成交额单位是万元，港美是元；统一成元
      amountYuan: isA ? amountRaw * 1e4 : amountRaw,
      pe: num(f[idx.pe]),
      mcapYi: num(f[idx.mcap]),
      asOf: f[idx.time] || '',
      currency: isA ? 'CNY' : kind === 'HK' ? 'HKD' : 'USD',
    })
  }
  return out
}

/** 指数快照：s_ 前缀是简版，字段位置与个股不同（4=涨跌、5=涨跌幅）。 */
export async function fetchIndex(symbols) {
  const list = (symbols && symbols.length ? symbols : ['sh000001', 'sz399001', 'hkHSI', 'usIXIC'])
    .map((s) => String(s).trim())
    .map((s) => (s.startsWith('s_') ? s : 's_' + s))
  const res = await httpText('https://qt.gtimg.cn/q=' + list.join(','))
  if (!res.ok) return { ok: false, error: res.error || `HTTP ${res.status}` }
  const items = []
  const re = /v_s_([a-zA-Z0-9]+)="([^"]*)"/g
  let m
  while ((m = re.exec(String(res.text || ''))) !== null) {
    const f = m[2].split('~')
    if (f.length < 6) continue
    items.push({
      symbol: m[1],
      name: f[1],
      code: f[2],
      price: num(f[3]),
      change: num(f[4]),
      changePct: num(f[5]),
      volume: num(f[6]),
      amountWan: num(f[7]),
    })
  }
  if (!items.length) return { ok: false, error: 'PARSE_EMPTY' }
  return { ok: true, source: '腾讯财经', fetchedAt: new Date().toISOString(), items }
}

/** 美股 K 线要交易所后缀；行情接口的 code 字段会给（AAPL.OQ）。拿不到就退回原样。 */
async function withUsSuffix(symbol) {
  if (symbol.includes('.')) return symbol
  try {
    const res = await fetchQuote([symbol])
    const code = res.ok ? res.items?.[0]?.code : ''
    return code && code.includes('.') ? 'us' + String(code).toUpperCase() : symbol
  } catch {
    return symbol
  }
}

/**
 * K 线。period：day / week / month。
 * A 股与港股返回 qfqday，美股返回 day（前复权不可用，且历史里有脏数据，按日期排序后取尾部）。
 */
export async function fetchKline(rawSymbol, { period = 'day', count = 60, adjust = true } = {}) {
  const symbol = normalizeSymbol(rawSymbol)
  const market = marketOf(symbol)
  const p = ['day', 'week', 'month'].includes(period) ? period : 'day'
  const n = Math.min(Math.max(Number(count) || 60, 2), 240)
  // 实测：param 末尾多一个空段（`,,5,`）美股接口会回 bad params，所以空复权标志时不带逗号。
  const adjustFlag = adjust ? 'qfq' : ''
  // 实测：美股 K 线的代码必须带交易所后缀（usAAPL.OQ）。不带后缀只会回一条 2011 年的脏数据。
  const querySymbol = market === 'US' ? await withUsSuffix(symbol) : symbol
  const param = `${querySymbol},${p},,,${n}${adjustFlag ? ',' + adjustFlag : ''}`
  const url = `${KLINE_HOST[market]}?param=${param}`
  const res = await httpText(url)
  if (!res.ok) return { ok: false, error: res.error || `HTTP ${res.status}`, symbol }
  let json
  try {
    json = JSON.parse(res.text)
  } catch {
    return { ok: false, error: 'BAD_JSON', symbol }
  }
  if (json.code !== 0) return { ok: false, error: json.msg || `code=${json.code}`, symbol }
  const node = json?.data?.[querySymbol] || json?.data?.[symbol] || {}
  const raw = node.qfqday || node.day || node[p] || []
  const bars = raw
    .map((row) => ({
      date: row[0],
      open: num(row[1]),
      close: num(row[2]),
      high: num(row[3]),
      low: num(row[4]),
      volume: num(row[5]),
    }))
    .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-n)
  if (!bars.length) return { ok: false, error: 'NO_BARS', symbol }
  return {
    ok: true,
    symbol,
    market,
    period: p,
    adjust,
    source: '腾讯财经',
    fetchedAt: new Date().toISOString(),
    bars,
  }
}

/** 世界银行年频指标。indicator 用世界银行码，如 NY.GDP.MKTP.CD。 */
export async function fetchMacro({ countries = ['CN'], indicator = 'NY.GDP.MKTP.CD', years = 10 } = {}) {
  const list = (countries.length ? countries : ['CN']).map((c) => encodeURIComponent(String(c).toUpperCase()))
  const span = Math.min(Math.max(Number(years) || 10, 2), 60)
  const end = new Date().getFullYear()
  const url = `https://api.worldbank.org/v2/country/${list.join(';')}/indicator/${encodeURIComponent(indicator)}?format=json&per_page=500&date=${end - span}:${end}`
  const res = await httpText(url)
  if (!res.ok) return { ok: false, error: res.error || `HTTP ${res.status}` }
  let json
  try {
    json = JSON.parse(res.text)
  } catch {
    return { ok: false, error: 'BAD_JSON' }
  }
  if (!Array.isArray(json) || json.length < 2) return { ok: false, error: 'NO_DATA', hint: '指标码可能写错' }
  const meta = json[0] || {}
  const rows = (json[1] || [])
    .filter((r) => r && r.value !== null && r.value !== undefined)
    .map((r) => ({
      country: r.country?.value || r.countryiso3code || '',
      iso3: r.countryiso3code,
      year: r.date,
      value: r.value,
    }))
  if (!rows.length) return { ok: false, error: 'NO_ROWS', indicator }
  return {
    ok: true,
    indicator,
    indicatorName: rows.length ? json[1].find((r) => r.indicator)?.indicator?.value || '' : '',
    lastUpdated: meta.lastupdated || '',
    source: '世界银行',
    fetchedAt: new Date().toISOString(),
    rows,
  }
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
