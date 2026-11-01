/** 用插件自己画一张样例图，作为 dsh-draw 的验收证据。 */
import { createTools } from '../lib/tools.js'

const tools = Object.fromEntries(createTools({ outputDir: 'docs/assets' }).map((t) => [t.name, t]))

const r1 = await tools.draw_chart.execute({
  kind: 'bar',
  labels: ['Pillow 卡片', 'matplotlib 图表', '表情差分', 'ControlNet', 'txt2img 冷启'],
  series: [{
    name: '耗时（秒）',
    data: [0.44, 1.66, 6.1, 12.1, 60.5],
  }],
  title: '同一张图，五条路线的耗时',
  ylabel: '秒',
  outPath: 'docs/assets/draw-plugin-demo.png',
})
console.log('chart:', JSON.stringify(r1))

const r2 = await tools.draw_card.execute({
  kind: 'rows',
  title: 'dsh-draw 验收',
  rows: [
    ['工具数', '2（draw_chart / draw_card）'],
    ['回归', '42/42 通过'],
    ['依赖', 'pylibs 固化 36.4MB'],
    ['通信', '文件 IPC（管道会 EPERM）'],
    ['verifyx', '2 个工具已注册，pid 18840'],
  ],
  footer: 'dsh-draw v0.1.0',
  outPath: 'docs/assets/draw-plugin-card.png',
})
console.log('card:', JSON.stringify(r2))
