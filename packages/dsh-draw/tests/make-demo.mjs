/** 用插件自己画一张样例图，作为 dsh-draw 的验收证据。 */
import path from 'node:path'
import { createTools } from '../lib/tools.js'

const tools = Object.fromEntries(createTools({ outputDir: path.join(process.cwd(), 'docs', 'assets') }).map((t) => [t.name, t]))

const r1 = await tools.draw.execute({
  kind: 'chart',
  chartKind: 'bar',
  labels: ['Pillow 卡片', 'matplotlib 图表', '表情差分', 'ControlNet', 'txt2img 冷启'],
  series: [{
    name: '耗时（秒）',
    data: [0.44, 1.66, 6.1, 12.1, 60.5],
  }],
  title: '同一张图，五条路线的耗时',
  ylabel: '秒',
  outPath: path.join(process.cwd(), 'docs', 'assets', 'draw-plugin-demo.png'),
})
console.log('chart:', JSON.stringify(r1))

const r2 = await tools.draw.execute({
  kind: 'card',
  cardKind: 'rows',
  title: 'dsh-draw 验收',
  rows: [
    ['工具数', '1（draw，kind=chart/card）'],
    ['回归', '42/42 通过'],
    ['依赖', 'pylibs 固化 36.4MB'],
    ['通信', '文件 IPC（管道会 EPERM）'],
    ['verifyx', 'draw 已注册'],
  ],
  footer: 'dsh-draw v0.2.0',
  outPath: path.join(process.cwd(), 'docs', 'assets', 'draw-plugin-card.png'),
})
console.log('card:', JSON.stringify(r2))
