/**
 * 术语候选抽取。只做"可疑清单"，判断仍然交给模型。
 * 抽取四类：书名号作品名、引号术语、专名后缀词、英文缩写。
 */
const SUFFIX = /([\u4e00-\u9fa5]{2,5})(之力|法则|秘境|副本|系统|空间|值|术|法|诀|境|塔|殿|城|门|阶|品|星)/g
const BOOK = /《([^》]{2,24})》/g
const QUOTE = /[「“]([^」”]{2,16})[」”]/g
const ABBR = /\b([A-Z]{2,6})\b/g

function bump(map, term, text, index) {
  if (!map.has(term)) map.set(term, { term, count: 0, contexts: [] })
  const entry = map.get(term)
  entry.count += 1
  if (entry.contexts.length < 3) {
    const from = Math.max(0, index - 20)
    entry.contexts.push(text.slice(from, index + term.length + 20).replace(/\n/g, ' ').trim())
  }
}

export function extractTerms(texts, limit = 60) {
  const map = new Map()
  for (const text of texts) {
    for (const re of [BOOK, QUOTE, SUFFIX, ABBR]) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(text))) {
        const term = (re === SUFFIX ? m[1] + m[2] : m[1] || '').trim()
        if (term.length >= 2) bump(map, term, text, m.index)
      }
    }
  }
  const all = [...map.values()]
  const repeated = all.filter((t) => t.count >= 2).sort((a, b) => b.count - a.count)
  const once = all.filter((t) => t.count < 2).slice(0, 20)
  return [...repeated, ...once].slice(0, limit)
}
