/** 桥接冒烟 suite：确认真实 spawn + PYTHONPATH + 文件 IPC 协议都通。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPython, findPython, PYLIB_DIR } from '../lib/bridge.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '_out')

export async function run() {
  fs.mkdirSync(OUT, { recursive: true })
  const cases = []
  const check = (name, ok, extra) => cases.push({ name, ok: !!ok, extra: extra ? String(extra).slice(0, 200) : '' })

  const py = findPython(process.env.DSH_PYTHON)
  check('找到 Python 解释器', Boolean(py.path), py.path || '未找到')
  check('pylibs 目录存在', fs.existsSync(PYLIB_DIR), PYLIB_DIR)

  // 1. 图表
  const chart = await runPython('chart.py', {
    kind: 'bar',
    labels: ['一月', '二月', '三月', '四月'],
    series: [{ name: '调用次数', data: [40, 31, 52, 18] }],
    title: '月度调用量',
    ylabel: '次',
    outPath: path.join(OUT, 'bar.png'),
  })
  check('chart.py 返回 ok', chart.ok === true, chart.error)
  check('chart.py 真的落了文件', chart.ok && fs.existsSync(chart.path))
  check('chart.py 返回尺寸', chart.ok && chart.width > 0 && chart.height > 0)

  // 2. 卡片
  const card = await runPython('card.py', {
    kind: 'card',
    title: '插件冒烟',
    body: '中文换行、渐变底、圆角卡片都在这个文件里。',
    footer: 'dsh-draw',
    outPath: path.join(OUT, 'card.png'),
  })
  check('card.py 返回 ok', card.ok === true, card.error)
  check('card.py 真的落了文件', card.ok && fs.existsSync(card.path))

  // 3. 键值列表
  const rows = await runPython('card.py', {
    kind: 'rows',
    title: '体检结果',
    rows: [['底模', 'anything-v5'], ['ControlNet', '14 个'], ['显存', '8187MB']],
    outPath: path.join(OUT, 'rows.png'),
  })
  check('card.py rows 模式 ok', rows.ok === true, rows.error)

  // 4. 错误路径：空数据必须报 NO_DATA，且不留下空图
  const empty = await runPython('chart.py', {
    kind: 'line', labels: [], series: [], outPath: path.join(OUT, 'empty.png'),
  })
  check('空数据返回 NO_DATA', empty.ok === false && empty.reason === 'NO_DATA', JSON.stringify(empty))
  check('空数据不留文件', !fs.existsSync(path.join(OUT, 'empty.png')))

  // 5. 错误路径：非数字
  const bad = await runPython('chart.py', {
    kind: 'line', labels: ['a'], series: [{ name: 'x', data: ['abc'] }], outPath: path.join(OUT, 'bad.png'),
  })
  check('非数字返回 BAD_INPUT', bad.ok === false && bad.reason === 'BAD_INPUT', JSON.stringify(bad))

  const failed = cases.filter((c) => !c.ok).length
  return { suite: 'bridge', total: cases.length, failed, cases }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await run()
  for (const c of r.cases) console.log(`${c.ok ? '✔' : '✘'} ${c.name}${c.ok ? '' : ' — ' + c.extra}`)
  console.log(`${r.total - r.failed}/${r.total} 通过`)
  process.exit(r.failed === 0 ? 0 : 1)
}
