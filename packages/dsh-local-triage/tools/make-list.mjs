/**
 * 把候选语料排成可读清单：id | 长度 | 渠道 | 文本
 * 输出 reports/corpus-list.txt（一行为一条，便于人工标注）
 */

import fs from 'node:fs'
import path from 'node:path'

const IN = path.join(process.cwd(), 'reports', 'corpus-candidates.json')
const OUT = path.join(process.cwd(), 'reports', 'corpus-list.txt')

const data = JSON.parse(fs.readFileSync(IN, 'utf8'))
const lines = data.rows.map((r, i) => {
  const id = String(i + 1).padStart(3, '0')
  const text = r.text.replace(/\r?\n/g, ' ')
  return `${id} | ${String(r.len).padStart(5)} | ${r.channel.padEnd(6)} | ${text}`
})

fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
process.exit(0)
