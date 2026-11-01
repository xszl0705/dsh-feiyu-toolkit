/**
 * 工具定义：P0 五个（3 个金融 + 2 个学习）。
 * 硬约定：任何金融输出都带「数据仅供参考，不构成投资建议」，且标明数据时间。
 */
import { fetchQuote, fetchKline, fetchIndex, normalizeSymbol } from './sources.js'

const DISCLAIMER = '数据仅供参考，不构成投资建议。'
const SOURCE = '腾讯财经'

function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—'
  return Number(n).toFixed(digits).replace(/\.?0+$/, (m) => (m.includes('.') ? '' : m))
}

function fmtPct(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%'
}

function fmtAmount(yuan) {
  const n = Number(yuan)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿'
  if (n >= 1e4) return (n / 1e4).toFixed(2) + ' 万'
  return n.toFixed(0)
}

function fmtPrice(n, currency) {
  const v = fmtNum(n)
  if (v === '—') return v
  const sign = currency === 'USD' ? '$' : currency === 'HKD' ? 'HK$' : ''
  return sign ? sign + v : v
}

/** 行情缓存 TTL：盘中 60s，盘后拿到的是收盘价，缓存长一点也不影响。 */
const QUOTE_TTL = 60_000
const KLINE_TTL = 30 * 60_000

export function createTools(store) {
  /** ---------- fin_quote ---------- */
  const finQuote = {
    name: 'fin_quote',
    description:
      '查 A股/港股/美股的实时行情（腾讯财经）。A股用 600519 或 sh600519，港股用 00700 或 hk00700，美股用 AAPL 或 usAAPL。一次最多 20 只。只返回数据，不预测、不推荐。',
    parameters: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: '代码列表，如 ["600519","hk00700","usAAPL"]',
        },
      },
      required: ['symbols'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          asOf: { type: 'string' },
          items: { type: 'array' },
          error: { type: 'string' },
          stale: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const lines = []
        for (const it of value?.items || []) {
          lines.push(
            [
              it.name,
              fmtPrice(it.price, it.currency),
              fmtPct(it.changePct),
              `涨跌 ${fmtNum(it.change)}`,
              `成交 ${fmtAmount(it.amountYuan)}`,
              it.pe != null ? `PE ${fmtNum(it.pe)}` : '',
              it.mcapYi != null ? `市值 ${fmtNum(it.mcapYi)} 亿` : '',
            ]
              .filter(Boolean)
              .join(' · '),
          )
        }
        if (value?.error) lines.push(`（没取到：${value.error}${value.stale ? '，下面是上次缓存' : ''}）`)
        if (!lines.length) lines.push('没有返回数据')
        lines.push(`数据时间 ${value?.asOf || '未知'} ｜ ${SOURCE} ｜ ${DISCLAIMER}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const symbols = Array.isArray(args?.symbols) ? args.symbols : []
      if (!symbols.length) return { items: [], error: '请给至少一个代码' }
      let normalized = []
      try {
        normalized = [...new Set(symbols.map(normalizeSymbol))]
      } catch (error) {
        return { items: [], error: String(error?.message || error) }
      }
      const key = 'quote:' + normalized.sort().join(',')
      const cached = store.cacheGet(key, QUOTE_TTL)
      if (cached) return { ...cached, cached: true }

      const res = await fetchQuote(normalized)
      if (res.ok) {
        const payload = { asOf: res.items[0]?.asOf || '', items: res.items }
        store.cachePut(key, payload)
        return payload
      }
      const stale = store.cacheGetStale(key)
      if (stale) return { ...stale.value, error: res.error, stale: true }
      return { items: [], error: res.error || '行情获取失败' }
    },
  }

  /** ---------- fin_kline ---------- */
  const finKline = {
    name: 'fin_kline',
    description:
      '查 A股/港股/美股 的日/周/月 K 线（腾讯财经）。返回 OHLC 序列和区间涨跌幅。只描述已经发生的价格，不预测。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '代码，如 600519 / hk00700 / usAAPL' },
        period: { type: 'string', enum: ['day', 'week', 'month'], description: '周期，默认 day' },
        count: { type: 'number', description: '条数，默认 60，最多 240' },
      },
      required: ['symbol'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          bars: { type: 'array' },
          changePct: { type: 'number' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: `K 线没取到：${value.error}` }]
        const bars = value?.bars || []
        if (!bars.length) return [{ type: 'text', text: '没有 K 线数据' }]
        const first = bars[0]
        const last = bars[bars.length - 1]
        const head = `${value.symbol} ${bars.length} 根 ${value.period === 'day' ? '日' : value.period === 'week' ? '周' : '月'}K：${first.date} → ${last.date}，收盘 ${fmtNum(first.close)} → ${fmtNum(last.close)}（${fmtPct(value.changePct)}）`
        const tail = bars.slice(-5).map((b) => `${b.date} 开${fmtNum(b.open)} 高${fmtNum(b.high)} 低${fmtNum(b.low)} 收${fmtNum(b.close)}`)
        return [{ type: 'text', text: [head, ...tail, `${SOURCE} ｜ ${DISCLAIMER}`].join('\n') }]
      },
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      let symbol
      try {
        symbol = normalizeSymbol(args?.symbol)
      } catch (error) {
        return { error: String(error?.message || error) }
      }
      const period = ['day', 'week', 'month'].includes(args?.period) ? args.period : 'day'
      const count = Math.min(Math.max(Number(args?.count) || 60, 2), 240)
      const key = `kline:${symbol}:${period}:${count}`
      const cached = store.cacheGet(key, KLINE_TTL)
      if (cached) return { ...cached, cached: true }

      const res = await fetchKline(symbol, { period, count })
      if (!res.ok) {
        const stale = store.cacheGetStale(key)
        return stale ? { ...stale.value, error: res.error, stale: true } : { error: res.error, symbol }
      }
      const changePct = ((res.bars[res.bars.length - 1].close - res.bars[0].close) / res.bars[0].close) * 100
      const payload = { symbol: res.symbol, period, bars: res.bars, changePct: Number(changePct.toFixed(2)) }
      store.cachePut(key, payload)
      return payload
    },
  }

  /** ---------- fin_index ---------- */
  const finIndex = {
    name: 'fin_index',
    description: '查大盘指数快照：默认上证、深证成指、恒生、纳斯达克。只报数，不判断牛熊。',
    parameters: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: '指数代码，可省略；支持 sh000001 / sz399001 / hkHSI / usIXIC',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { items: { type: 'array' }, error: { type: 'string' } },
      },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: `指数没取到：${value.error}` }]
        const lines = (value?.items || []).map(
          (it) => `${it.name} ${fmtNum(it.price)} ${fmtPct(it.changePct)}`,
        )
        return [{ type: 'text', text: [lines.join('\n') || '没有数据', `${SOURCE} ｜ ${DISCLAIMER}`].join('\n') }]
      },
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const symbols = Array.isArray(args?.symbols) ? args.symbols : []
      const key = 'index:' + (symbols.join(',') || 'default')
      const cached = store.cacheGet(key, QUOTE_TTL)
      if (cached) return { ...cached, cached: true }
      const res = await fetchIndex(symbols)
      if (!res.ok) {
        const stale = store.cacheGetStale(key)
        return stale ? { ...stale.value, error: res.error, stale: true } : { error: res.error }
      }
      const payload = { asOf: res.fetchedAt, items: res.items }
      store.cachePut(key, payload)
      return payload
    },
  }

  /** ---------- learn_card ---------- */
  const learnCard = {
    name: 'learn_card',
    description:
      '学习卡管理：新增/查询/搜索/修改/删除概念卡。卡片是「要记住的知识」，与记忆库（事件流）分开存放。action=add 需要 title，body 写定义/要点/一个真实数据案例。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'get', 'list', 'search', 'update', 'del'], description: '操作' },
        id: { type: 'string', description: '卡片 id（get/update/del 用）' },
        title: { type: 'string', description: '标题，如「财政赤字货币化」' },
        body: { type: 'string', description: '正文：定义 + 要点 + 案例' },
        tags: { type: 'string', description: '标签，逗号分隔，如「宏观,货币」' },
        source: { type: 'string', description: '来源（书/文/课程）' },
        query: { type: 'string', description: 'search 的关键词' },
        limit: { type: 'number', description: 'list/search 条数，默认 20' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { action: { type: 'string' }, card: { type: 'object' }, cards: { type: 'array' }, error: { type: 'string' } },
      },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: '卡片操作失败：' + value.error }]
        if (value?.card) {
          const c = value.card
          return [{ type: 'text', text: `【${c.title}】(${c.id})\n${c.body || '（空）'}${c.tags ? '\n标签：' + c.tags : ''}` }]
        }
        const cards = value?.cards || []
        if (!cards.length) return [{ type: 'text', text: '没有匹配的卡片' }]
        return [{ type: 'text', text: cards.map((c) => `- ${c.title} (${c.id})${c.tags ? ' [' + c.tags + ']' : ''}`).join('\n') }]
      },
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const action = String(args?.action || '')
      try {
        if (action === 'add') {
          return { action, card: store.addCard({ title: args?.title, body: args?.body, tags: args?.tags, source: args?.source }) }
        }
        if (action === 'get') {
          const card = store.getCard(args?.id)
          return card ? { action, card } : { action, error: '找不到这张卡' }
        }
        if (action === 'list') {
          return { action, cards: store.listCards({ limit: args?.limit, tag: args?.tag }) }
        }
        if (action === 'search') {
          return { action, cards: store.searchCards(args?.query, args?.limit) }
        }
        if (action === 'update') {
          const card = store.updateCard(args?.id, { title: args?.title, body: args?.body, tags: args?.tags, source: args?.source })
          return card ? { action, card } : { action, error: '找不到这张卡' }
        }
        if (action === 'del') {
          return { action, deleted: store.removeCard(args?.id) }
        }
        return { action, error: '不支持的 action' }
      } catch (error) {
        return { action, error: String(error?.message || error) }
      }
    },
  }

  /** ---------- learn_review ---------- */
  const learnReview = {
    name: 'learn_review',
    description:
      '间隔重复：action=due 取今天该复习的卡；action=grade 给一张卡打分（1=忘了 2=勉强 3=记得 4=太简单），自动算下次复习时间；action=stats 看总卡片数/到期数/已学数。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['due', 'grade', 'stats'] },
        cardId: { type: 'string', description: 'grade 时的卡片 id' },
        rating: { type: 'number', description: '1-4' },
        limit: { type: 'number', description: 'due 条数，默认 30' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { action: { type: 'string' }, cards: { type: 'array' }, result: { type: 'object' }, stats: { type: 'object' }, error: { type: 'string' } },
      },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: '复习操作失败：' + value.error }]
        if (value?.action === 'stats') {
          const s = value.stats || {}
          return [{ type: 'text', text: `卡片 ${s.total} 张 · 今天该复习 ${s.due} 张 · 已学过 ${s.learned} 张` }]
        }
        if (value?.action === 'grade') {
          const r = value.result || {}
          return [{ type: 'text', text: `已记录：下次复习在 ${String(r.dueAt || '').slice(0, 10)}（间隔 ${r.interval} 天，第 ${r.reps} 次）` }]
        }
        const cards = value?.cards || []
        if (!cards.length) return [{ type: 'text', text: '今天没有到期的卡，休息一下也行。' }]
        const lines = cards.map((c) => `- ${c.title} (${c.id})`)
        return [{ type: 'text', text: `今天该复习 ${cards.length} 张：\n${lines.join('\n')}\n\n答完用 learn_review(action=grade, cardId=..., rating=1-4) 记一下。` }]
      },
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const action = String(args?.action || '')
      try {
        if (action === 'due') return { action, cards: store.dueCards(args?.limit) }
        if (action === 'stats') return { action, stats: store.reviewStats() }
        if (action === 'grade') {
          const rating = Number(args?.rating)
          if (![1, 2, 3, 4].includes(rating)) return { action, error: 'rating 只能是 1-4' }
          return { action, result: store.gradeCard(String(args?.cardId || ''), rating) }
        }
        return { action, error: '不支持的 action' }
      } catch (error) {
        return { action, error: String(error?.message || error) }
      }
    },
  }

  return [finQuote, finKline, finIndex, learnCard, learnReview]
}
