/**
 * rp_card 未覆盖分支的单测：list 过滤 / book / background / switch 幂等 / current 锁显示。
 * 跑法：node tests/rp-card-actions.test.mjs
 */
import path from 'node:path'
import { createTools } from '../lib/tools.js'
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

const ROOT = path.join(process.cwd(), '_tmp', 'rp-actions-test')
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

const S = 'sess-actions'

console.log('[1] list 过滤')
const l1 = await card.execute({ action: 'list', l1: 'system', limit: 5 }, exec(S))
ok('l1=system 有结果', l1.ok && l1.count > 0, `count=${l1.count}`)
ok('l1 输出只含系统卡', /通用APP|模拟器|系统/.test(l1.lines.join(' ')), l1.lines.slice(1, 3).join(' | '))

const tagged = await card.execute({ action: 'list', l2: 'school', tags: '巨乳', limit: 3 }, exec(S))
ok('l2+tags 过滤有结果', tagged.ok && tagged.count > 0, `count=${tagged.count}`)

const none = await card.execute({ action: 'list', l1: 'scenario', tags: '不存在的标签zzz', limit: 3 }, exec(S))
ok('无匹配时 count=0', none.ok && none.count === 0, `count=${none.count}`)

console.log('[2] book 世界书')
const withBook = await card.execute({ action: 'list', l1: 'system', limit: 1 }, exec(S))
const nameLine = (withBook.lines || []).find((l) => l.startsWith('- ')) || ''
const firstName = nameLine.replace(/^- /, '').replace(/（.*$/, '').trim()
const bk = await card.execute({ action: 'book', name: firstName, limit: 3 }, exec(S))
ok('book 返回条目或明确没有', bk.ok && /世界书|没有匹配/.test(bk.lines.join(' ')), bk.lines[0])

console.log('[3] background 换背景')
const bg = await card.execute({ action: 'background', query: '一座下雨的海边小镇，夜里只有灯塔亮着。' }, exec(S))
ok('background 写入成功', bg.ok && /背景已换成/.test(bg.lines[0]), bg.lines[0])
const cur1 = JSON.parse(fs.readFileSync(ROOT + '\\current.json', 'utf8'))
ok('current.json 记下背景', String(cur1.scenario || '').includes('灯塔'), String(cur1.scenario || '').slice(0, 40))

console.log('[4] 卡组 / 群聊 / leave')
const sw1 = await card.execute({ action: 'switch', name: '病娇妹妹' }, exec(S))
ok('第一张进卡组', sw1.ok && /加进本局卡组|已经在本局卡组/.test(sw1.lines[0]), sw1.lines[0])
const sw2 = await card.execute({ action: 'switch', name: '病娇妹妹' }, exec(S))
ok('重复加同一张幂等', sw2.ok && /已经在本局卡组/.test(sw2.lines[0]), sw2.lines[0])
const sw3 = await card.execute({ action: 'pick', name: '病娇萝莉女友' }, exec(S))
ok('第二张可以加进来（群聊）', sw3.ok && /现在 2 位/.test(sw3.lines[0]), sw3.lines[0])

const extra = ['黄金船', '巨根症', '女骑士']
let last = null
for (const n of extra) {
  last = await card.execute({ action: 'cast', name: n }, exec(S))
  if (last.ok === false) break
}
const cur0 = await card.execute({ action: 'current' }, exec(S))
ok('最多 4 张（第 5 张被拒）', last === null || last.ok === false || /卡组已满/.test(String(last.lines?.[0])), String(last && last.lines && last.lines[0]))
ok('current 显示卡组人数', /群聊|卡组/.test(cur0.lines.join(' ')), cur0.lines[0])

const lv = await card.execute({ action: 'leave', name: '病娇萝莉女友' }, exec(S))
ok('leave 能移出一张', lv.ok && /已移出/.test(lv.lines[0]), lv.lines[0])
const lv2 = await card.execute({ action: 'leave', name: '不存在的卡' }, exec(S))
ok('leave 不存在的卡报错', lv2.ok === false, String(lv2.lines?.[0]))

console.log('[5] current 显示')
const cur = await card.execute({ action: 'current' }, exec(S))
ok('current 带当前角色', /当前角色：|本局角色/.test(cur.lines.join(' ')), cur.lines[0])

console.log('[6] 其它会话互不影响')
const other = await card.execute({ action: 'current' }, exec('sess-other'))
ok('新会话无锁提示', !/本会话已锁定/.test(other.lines.join(' ')), other.lines[0])

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(' - ' + f)
  process.exit(1)
}
