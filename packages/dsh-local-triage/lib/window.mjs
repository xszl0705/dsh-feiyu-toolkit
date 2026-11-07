/**
 * 上下文窗口化：把「保留最近 N 组 + 其余按优先级让位」做成可复用纯函数。
 *
 * 为什么不用模型做摘要：改写式摘要会跨会话累积漂移（见 CliffCompaction 的教训）。
 * 这里只做「保留 / 丢弃」两种动作，绝不生成新文本。
 */

/**
 * 保留最近 n 条，其余丢弃。
 * @param {any[]} items
 * @param {number} n
 * @returns {{kept:any[], dropped:number}}
 */
export function keepRecent(items, n) {
  const list = Array.isArray(items) ? items : []
  const keep = Math.max(0, Math.floor(Number(n) || 0))
  if (keep === 0) return { kept: [], dropped: list.length }
  if (list.length <= keep) return { kept: list.slice(), dropped: 0 }
  return { kept: list.slice(list.length - keep), dropped: list.length - keep }
}

/**
 * 按优先级让位，直到总量落进预算。
 *
 * @param {Record<string,string>} blocks  块名 → 文本
 * @param {{budget:number, order:string[], sizeOf?:(s:string)=>number}} opts
 *        order 是「先被丢掉」的顺序（越靠前越先让位）
 * @returns {{blocks:Record<string,string>, dropped:string[], size:number}}
 */
export function dropToBudget(blocks = {}, { budget = 0, order = [], sizeOf = (s) => String(s || '').length } = {}) {
  const working = { ...blocks }
  const dropped = []
  const total = () => Object.values(working).reduce((sum, v) => sum + sizeOf(v), 0)

  if (!(Number(budget) > 0)) return { blocks: working, dropped, size: total() }
  if (total() <= budget) return { blocks: working, dropped, size: total() }

  // 先按给定顺序丢；给定顺序丢完还不够，再按剩余块的体积从大到小丢
  const plan = [...order.filter((k) => k in working)]
  for (const key of plan) {
    if (total() <= budget) break
    if (!working[key]) continue
    working[key] = ''
    dropped.push(key)
  }
  if (total() > budget) {
    const rest = Object.keys(working)
      .filter((k) => working[k])
      .sort((a, b) => sizeOf(working[b]) - sizeOf(working[a]))
    for (const key of rest) {
      if (total() <= budget) break
      working[key] = ''
      dropped.push(key)
    }
  }
  return { blocks: working, dropped, size: total() }
}

/**
 * 估算 token：中文按 1 字 1 token、其他按 4 字符 1 token。
 * 粗算够用——它只用来决定"丢不丢"，不用于计费。
 */
export function approxTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length
  return Math.round(cjk + (s.length - cjk) / 4)
}
