/**
 * 世界书省步数（0.5.4）：目录化 + 一次问多话题。
 *
 * 起因（2026-11-08 实测会话 session-6bc5ebe1）：第一轮 rp_card 被调 6 次——
 * search → read → pick → book(场景) → book(同一场景换措辞) → book(性格)。
 * 改法：pick/cast 直接回世界书目录（不含正文）；book 的 query 支持多词合并、另加 queries 数组。
 *
 * 跑法：node tests/rp-book-batch.test.mjs
 */
import path from 'node:path'
import { createTools } from '../lib/tools.js'
import { bookIndex, renderBookIndex } from '../lib/card.js'
import fs from 'node:fs'

// 卡库是机器相关资源（自建库 + 下载库）。发布仓里没有卡时跳过依赖真实卡库的用例，避免误报失败。
const __libRoots = [process.env.DSH_RP_CARD_ROOT, process.env.DSH_RP_DOWNLOAD_ROOT].filter(Boolean)
const __hasLib = __libRoots.some((dir) => {
  try { return fs.readdirSync(dir).length > 0 } catch { return false }
})
if (!__hasLib) {
  console.log('SKIP: 没有可用的角色卡库（设 DSH_RP_CARD_ROOT / DSH_RP_DOWNLOAD_ROOT 后重跑）')
  process.exit(0)
}

const ROOT = path.join(process.cwd(), '_tmp', 'rp-book-batch-test')
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(ROOT, { recursive: true })

const tools = createTools({
  root: ROOT,
  currentFile: ROOT + '\\current.json',
  indexFile: ROOT + '\\card-index.json',
  tagIndexFile: process.env.DSH_RP_TAG_INDEX || path.join(process.cwd(), '_tmp', 'rp-cardindex', 'cards.jsonl'),
})
const card = tools.find((t) => t.name === 'rp_card')
const exec = (sid) => ({ agent: { session: { id: sid } } })

let pass = 0
const fails = []
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1
    console.log('  ok  ' + name)
  } else {
    fails.push(name + (extra ? ' :: ' + extra : ''))
    console.log('  FAIL ' + name + (extra ? ' :: ' + extra : ''))
  }
}

console.log('[1] bookIndex 只给目录不给正文')
const fake = {
  name: '测试卡',
  book: Array.from({ length: 30 }, (_, i) => ({
    keys: [`词${i}`, `别名${i}`],
    content: `第${i}条正文。` + '填充'.repeat(200),
    enabled: true,
    insertion_order: i,
  })),
}
const idx = bookIndex(fake, 20)
ok('total 记全量', idx.total === 30, `total=${idx.total}`)
ok('items 受 limit 约束', idx.items.length === 20, `len=${idx.items.length}`)
ok('目录项不含正文全文', idx.items.every((it) => it.head.length <= 40), 'head 超长')
ok('条目带关键词与字数', idx.items[0].keys.length === 2 && idx.items[0].chars > 400, JSON.stringify(idx.items[0]).slice(0, 80))
const rendered = renderBookIndex(idx, 20)
ok('渲染每行 ≤ 100 字', rendered.every((l) => l.length <= 100), String(Math.max(...rendered.map((l) => l.length))))
ok('超出部分给提示', rendered.some((l) => /另有 10 条/.test(l)), rendered[rendered.length - 1])
ok('空卡不报错', bookIndex({ book: [] }, 20).total === 0 && renderBookIndex({ total: 0, items: [] }).length === 0)

console.log('[2] pick 返回世界书目录')
const S = 'sess-book'
const pk = await card.execute({ action: 'pick', name: '病娇妹妹' }, exec(S))
const text = (pk.lines || []).join('\n')
const hasBook = /世界书 \d+ 条，目录/.test(text)
ok('pick 输出含目录段', pk.ok && (hasBook || /没有匹配|世界书 0 条/.test(text)), (pk.lines || [])[0])
if (hasBook) {
  ok('目录行格式 条目名｜关键词｜开头', (pk.lines || []).some((l) => /^\s+\d+\. .+｜.+｜/.test(l)), '')
  const dirLines = (pk.lines || []).filter((l) => /^\s+\d+\. .+｜.+｜/.test(l))
  ok('目录行不含条目正文全量', dirLines.length > 0 && dirLines.every((l) => l.length <= 120), `max=${Math.max(...dirLines.map((l) => l.length))}`)
  ok('提示一次写多个词', (pk.lines || []).some((l) => /同一个 query/.test(l)), '')
}

console.log('[3] book 一次问多话题')
const listed = await card.execute({ action: 'list', l1: 'system', limit: 3 }, exec(S))
const first = (listed.lines || []).find((l) => l.startsWith('- ')) || ''
const nm = first.replace(/^- /, '').replace(/（.*$/, '').trim()
const one = await card.execute({ action: 'book', name: nm, limit: 4 }, exec(S))
const keysLine = (one.lines || []).find((l) => l.startsWith('- [')) || ''
const keys = (keysLine.match(/\[([^\]]+)\]/) || [, ''])[1].split('/').filter(Boolean)
console.log('   抽到关键词：', keys.join(' / '))

const multi = await card.execute({ action: 'book', name: nm, query: keys.slice(0, 2).join(' '), limit: 8 }, exec(S))
ok('多词 query 被拆开', Array.isArray(multi.words) && multi.words.length === (keys.length >= 2 ? 2 : 1), JSON.stringify(multi.words))
ok('多词时标题标注关键词', multi.words.length < 2 || /关键词：/.test(multi.lines[0]), multi.lines[0])
ok('多词返回条数不超 limit', multi.count <= 8, `count=${multi.count}`)
ok('条目不重复', new Set((multi.lines || []).filter((l) => l.startsWith('- ['))).size === multi.count, `uniq/count=${new Set((multi.lines || []).filter((l) => l.startsWith('- ['))).size}/${multi.count}`)

const arr = await card.execute({ action: 'book', name: nm, queries: keys.slice(0, 2) }, exec(S))
ok('queries 数组等价', Array.isArray(arr.words) && arr.words.length === multi.words.length, JSON.stringify(arr.words))

const blank = await card.execute({ action: 'book', name: nm, query: '这个词一定查不到zzz' }, exec(S))
ok('无命中给出明确提示', blank.ok && /没有匹配/.test(blank.lines[0]), blank.lines[0])

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(' - ' + f)
  process.exit(1)
}
