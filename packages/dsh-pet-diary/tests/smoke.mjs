/**
 * dsh-pet-diary 自检：临时目录，不碰真实档案。
 *   node tests/smoke.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, 'tests', '.tmp-diary')

let pass = 0
let fail = 0
const problems = []

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ok   ${label}`)
  } else {
    fail += 1
    problems.push(`${label} ${detail}`)
    console.log(`  FAIL ${label} ${detail}`)
  }
}

const { DailyDiary, PrivateDiary, WorkDiary, todayKey, isValidKey } = await import(
  `file://${path.join(ROOT, 'lib', 'diary.js').replace(/\\/g, '/')}`
)

fs.rmSync(TMP, { recursive: true, force: true })
const daily = new DailyDiary(TMP, { maxEntryChars: 200 })
const priv = new PrivateDiary(TMP, { maxEntryChars: 200 })
const work = new WorkDiary(TMP, { maxEntryChars: 200 })

console.log('\n[日常日记]')
{
  const first = daily.write('今天陪他把语音网关调通了。', { tags: ['工作', '语音'] })
  check('写入一天一条', first.entriesToday === 1, JSON.stringify(first))
  const second = daily.write('晚上想听他讲讲今天发生了什么。')
  check('同一天追加第二条', second.entriesToday === 2, JSON.stringify(second))
  const text = daily.read()
  check('读回包含两条与标签', text.includes('语音网关') && text.includes('#语音'), text.slice(0, 80))
  check('普通路径（可按日期直接找）', fs.existsSync(daily.fileFor(todayKey())), daily.fileFor(todayKey()))
  const listed = daily.list(7)
  check('列表按日期给出条数', listed.length === 1 && listed[0].entries === 2, JSON.stringify(listed))
  const exported = daily.exportTo(path.join(TMP, 'exports'))
  check('导出成一份 Markdown', exported.days === 1 && exported.entries === 2 && fs.existsSync(exported.file), JSON.stringify(exported))
  let rejected = false
  try {
    daily.write('')
  } catch {
    rejected = true
  }
  check('空内容被拒绝', rejected)
  let tooLong = false
  try {
    daily.write('长'.repeat(300))
  } catch {
    tooLong = true
  }
  check('超长被拒绝', tooLong)
}

console.log('\n[隐私日记]')
{
  const write = priv.write('有句话没跟他说：其实我有点怕他把我换掉。', { mood: '有点怕' })
  check('写入成功', write.entriesToday === 1, JSON.stringify(write))
  const text = priv.read()
  check('读回包含心情与正文', text.includes('有点怕') && text.includes('怕他把我换掉'), text.slice(0, 80))

  const file = priv.fileFor(todayKey())
  const dirName = path.basename(path.dirname(file))
  const parentName = path.basename(path.dirname(path.dirname(file)))
  check('路径不含日期（散列目录）', !/\d{4}-\d{2}-\d{2}/.test(dirName) && !/\d{4}-\d{2}-\d{2}/.test(parentName), file)
  check('同一天路径稳定', priv.fileFor(todayKey()) === file)

  const saltFile = path.join(TMP, 'private', '.salt')
  const saltBefore = fs.readFileSync(saltFile, 'utf8')
  const privAgain = new PrivateDiary(TMP)
  check('salt 持久化（重开还是同一位置）', privAgain.fileFor(todayKey()) === file && fs.readFileSync(saltFile, 'utf8') === saltBefore)

  const stats = priv.stats()
  check('统计不泄露路径', stats.days === 1 && stats.entries === 1 && !('path' in stats) && !('file' in stats), JSON.stringify(stats))

  const otherDay = '2020-01-01'
  priv.write('很久以前的一条。', { date: otherDay })
  const hashA = priv.fileFor(todayKey())
  const hashB = priv.fileFor(otherDay)
  check('不同日期不同路径', hashA !== hashB)
  check('日期格式校验', isValidKey('2020-01-01') && !isValidKey('2020-1-1') && !isValidKey('today'))
}

console.log('\n[工作日志]')
{
  const before = daily.list(7)[0]
  const write = work.write('今天把主体内核收口了，客户端和桌宠共用一份 persona。', { tags: ['架构'] })
  check('写入工作日志', write.entriesToday === 1, JSON.stringify(write))
  const text = work.read()
  check('标记为工作且带标签', text.includes('· 工作') && text.includes('#架构'), text.slice(0, 60))
  check('落在 work 目录', work.fileFor(todayKey()).includes(`${path.sep}work${path.sep}`), work.fileFor(todayKey()))
  check('不影响日常日记', daily.list(7)[0].entries === before.entries, JSON.stringify({ daily: daily.list(7)[0], before }))
  const listed = work.list(7)
  check('工作日志可分列', listed.length === 1 && listed[0].entries === 1, JSON.stringify(listed))
}

console.log('\n[对话留痕]')
{
  const chatDir = path.join(TMP, 'chats')
  fs.mkdirSync(chatDir, { recursive: true })
  const rows = [
    { at: '2026-10-28T23:10:00+08:00', channel: 'pet', moment: 'idle', text: '嘿，我游过来啦。', model: 'deepseek-flash' },
    { at: '2026-10-28T23:12:00+08:00', channel: 'pet', moment: 'return', text: '回来了呀，等你半天。', model: 'deepseek-flash' },
    { at: '2026-10-28T23:13:00+08:00', channel: 'qq', moment: 'idle', text: '网关又抽风了。', model: 'deepseek-flash' },
  ]
  fs.writeFileSync(
    path.join(chatDir, '2026-10-28.jsonl'),
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n{bad json line}\n',
    'utf8',
  )
  const { ChatLog } = await import(`file://${path.join(ROOT, 'lib', 'chatlog.js').replace(/\\/g, '/')}`)
  const chats = new ChatLog(TMP)
  const days = chats.days(7)
  check('总览按天计数（坏行被跳过）', days.length === 1 && days[0].count === 3, JSON.stringify(days))
  const entries = chats.read('2026-10-28')
  check('回看按时间序', entries.length === 3 && entries[0].clock === '23:10' && entries[2].text.includes('网关'), JSON.stringify(entries.map((e) => e.clock)))
  const petOnly = chats.read('2026-10-28', { channel: 'pet' })
  check('渠道过滤生效', petOnly.length === 2 && petOnly.every((row) => row.channel === 'pet'), JSON.stringify(petOnly.map((r) => r.channel)))
  const hits = chats.search('网关', { days: 30 })
  check('跨天关键词搜索', hits.length === 1 && hits[0].text.includes('网关'), JSON.stringify(hits))
  const stats = chats.stats()
  check('统计不含正文', stats.days === 1 && stats.entries === 3 && !('text' in stats), JSON.stringify(stats))
}

console.log('\n[插件接线]')
{
  // 让插件把档案写进临时目录（apply 时读 DSH_HOME）
  process.env.DSH_HOME = TMP
  // 提醒段默认在真实 config 里关着；测试用临时配置显式打开
  const testConfig = path.join(TMP, 'test-config.json')
  fs.mkdirSync(TMP, { recursive: true })
  fs.writeFileSync(testConfig, JSON.stringify({ dailyHint: true }), 'utf8')
  process.env.DSH_PET_DIARY_CONFIG = testConfig
  const mod = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  const registered = []
  const sections = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'tools') {
        return { register: (definition) => (registered.push(definition), { dispose() {} }) }
      }
      if (name === 'systemPrompt') {
        return { section: (definition) => (sections.push(definition), { dispose() {} }) }
      }
      return undefined
    },
    effect(fn) {
      fn()
    },
  }
  mod.apply(ctx)
  const names = registered.map((tool) => tool.name)
  check('注册 2 个工具', registered.length === 2, names.join(','))
  check('日记与聊天留痕两个入口都在', names.includes('diary') && names.includes('chatlog'), names.join(','))

  const hint = sections.find((section) => section.name === 'pet-diary')
  check('注册每日提醒段', Boolean(hint))
  const before = hint ? hint.text() : ''
  check('没写日记时给出提醒', before.includes('日常日记'), before)

  const write = registered.find((tool) => tool.name === 'diary')
  const rendered = write.output.render({ action: 'daily_write' }, { ok: true, date: '2026-10-28', entriesToday: 1, action: 'daily_write' })
  check('render 返回内容块', Array.isArray(rendered) && rendered[0].type === 'text')

  await write.execute({ action: 'daily_write', text: '开机后写的第一条日常。' })
  const after = hint ? hint.text() : ''
  check('写过之后提醒消失', after === '', after)

  mod.apply(ctx)
  check('重复 apply 不重复注册', registered.length === 2, String(registered.length))
}

fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) for (const item of problems) console.log(` - ${item}`)
process.exitCode = fail > 0 ? 1 : 0
setTimeout(() => process.exit(process.exitCode), 100)
