/**
 * 从真实对话日志里抽用户消息，作为回归集候选。
 *
 * 数据源：~/.dsh/dafeiyu/dialogues/*.jsonl
 * 过滤：去掉 system-reminder / 技能目录 / 超长粘贴，去重。
 * 输出：reports/corpus-candidates.json
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DIR = process.argv[2] || path.join(os.homedir(), '.dsh', 'dafeiyu', 'dialogues')
const OUT = path.join(process.cwd(), 'reports', 'corpus-candidates.json')

// 明显的系统注入块，不是真人说的话
const NOISE = [
  '<system-reminder>',
  '<available_skills>',
  'Tokens prefixed with @',
  'A skill is a reusable set',
  'Instructions from:',
]

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function isNoise(text) {
  if (!text) return true
  if (text.startsWith('<')) return true
  return NOISE.some((n) => text.includes(n))
}

function main() {
  if (!fs.existsSync(DIR)) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify({ error: `目录不存在: ${DIR}` }, null, 2), 'utf8')
    process.exit(1)
  }

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort()
  const seen = new Set()
  const rows = []
  let raw = 0
  let dropped = 0

  for (const file of files) {
    const lines = fs.readFileSync(path.join(DIR, file), 'utf8').split(/\r?\n/).filter(Boolean)
    for (const line of lines) {
      let obj
      try { obj = JSON.parse(line) } catch { continue }
      if (obj.role !== 'user') continue
      raw += 1
      const text = clean(obj.text)
      if (isNoise(text)) { dropped += 1; continue }
      if (seen.has(text)) { dropped += 1; continue }
      seen.add(text)
      rows.push({
        text: text.length > 160 ? text.slice(0, 160) + '…' : text,
        len: text.length,
        channel: obj.channel || '',
        conversation: obj.conversation || '',
        at: obj.at || '',
        file,
      })
    }
  }

  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)))

  const byChannel = {}
  const byBucket = { lt24: 0, '24-120': 0, '120-1200': 0, gt1200: 0 }
  for (const r of rows) {
    byChannel[r.channel] = (byChannel[r.channel] || 0) + 1
    if (r.len < 24) byBucket.lt24 += 1
    else if (r.len <= 120) byBucket['24-120'] += 1
    else if (r.len <= 1200) byBucket['120-1200'] += 1
    else byBucket.gt1200 += 1
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify({ dir: DIR, files, rawUserRows: raw, dropped, kept: rows.length, byChannel, byBucket, rows }, null, 2), 'utf8')
  process.exit(0)
}

main()
