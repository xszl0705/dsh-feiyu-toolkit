/** 工具层 suite：直接 import tools.js，验证参数校验、默认路径、错误码。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTools } from '../lib/tools.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.dirname(HERE)
const OUT = path.join(HERE, '_out')

export async function run() {
  fs.mkdirSync(OUT, { recursive: true })
  const cases = []
  const check = (name, ok, extra) => cases.push({ name, ok: !!ok, extra: extra ? String(extra).slice(0, 240) : '' })

  const tools = createTools({ outputDir: OUT })
  check('创建了两个工具', tools.length === 2, `实际 ${tools.length}`)
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  check('有 draw_chart', Boolean(byName.draw_chart))
  check('有 draw_card', Boolean(byName.draw_card))

  const chart = byName.draw_chart
  const card = byName.draw_card

  // 元信息完整性
  check('draw_chart 有 description', typeof chart.description === 'string' && chart.description.length > 10)
  check('draw_chart 参数 schema 合法', chart.parameters?.type === 'object' && chart.parameters?.properties?.series)
  check('draw_chart 有 render', typeof chart.output?.render === 'function')
  check('draw_card 参数 schema 合法', card.parameters?.type === 'object')

  // render 在失败时不抛错
  try {
    const out = chart.output.render({}, { ok: false, reason: 'NO_DATA', error: '空' })
    check('render 在失败时可调用', Array.isArray(out) && out[0]?.text?.includes('NO_DATA'), JSON.stringify(out))
  } catch (error) {
    check('render 在失败时可调用', false, String(error?.message || error))
  }

  // 正常：显式 outPath
  const explicit = path.join(OUT, 'tool-chart.png')
  const r1 = await chart.execute({
    kind: 'line',
    labels: ['1', '2', '3'],
    series: [{ name: 'A', data: [1, 4, 9] }],
    title: '平方',
    outPath: explicit,
  })
  check('draw_chart 显式路径出图', r1.ok === true && fs.existsSync(explicit), r1.error)

  // 正常：不传 outPath，应落到 outputDir 且命名带 chart- 前缀
  const r2 = await chart.execute({ kind: 'pie', labels: ['甲', '乙'], series: [{ name: '占比', data: [60, 40] }], title: '占比测试' })
  check('draw_chart 默认路径出图', r2.ok === true, r2.error)
  check('默认路径落在 outputDir', r2.ok && path.dirname(path.resolve(r2.path)) === path.resolve(OUT), r2.path)
  check('默认文件名带 chart- 前缀', r2.ok && path.basename(r2.path).startsWith('chart-'), r2.path)

  // 错误：空 series
  const e1 = await chart.execute({ series: [] })
  check('空 series 返回 NO_DATA', e1.ok === false && e1.reason === 'NO_DATA', JSON.stringify(e1))

  // 错误：kind 非法时降级到 line 而不是报错
  const r3 = await chart.execute({ kind: '不存在的类型', labels: ['a', 'b'], series: [{ data: [1, 2] }], outPath: path.join(OUT, 'fallback.png') })
  check('非法 kind 降级为 line', r3.ok === true, JSON.stringify(r3).slice(0, 120))

  // 卡片：card 模式
  const r4 = await card.execute({ kind: 'card', title: '标题', body: '正文' })
  check('draw_card card 模式 ok', r4.ok === true, r4.error)

  // 卡片：rows 模式
  const r5 = await card.execute({ kind: 'rows', title: '列表', rows: [['k1', 'v1'], ['k2', 'v2']] })
  check('draw_card rows 模式 ok', r5.ok === true, r5.error)

  // 卡片：空 rows
  const e2 = await card.execute({ kind: 'rows', rows: [] })
  check('空 rows 返回 NO_DATA', e2.ok === false && e2.reason === 'NO_DATA', JSON.stringify(e2))

  // 卡片：全空
  const e3 = await card.execute({ kind: 'card' })
  check('空卡片返回 NO_DATA', e3.ok === false && e3.reason === 'NO_DATA', JSON.stringify(e3))

  // 宽度会被夹紧
  const r6 = await card.execute({ kind: 'card', title: '窄', width: 10 })
  check('宽度下限被夹紧到 480', r6.ok === true && r6.width === 480, `实际 ${r6.width}`)

  const failed = cases.filter((c) => !c.ok).length
  return { suite: 'tools', total: cases.length, failed, cases }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await run()
  for (const c of r.cases) console.log(`${c.ok ? '✔' : '✘'} ${c.name}${c.ok ? '' : ' — ' + c.extra}`)
  console.log(`${r.total - r.failed}/${r.total} 通过`)
  process.exit(r.failed === 0 ? 0 : 1)
}
