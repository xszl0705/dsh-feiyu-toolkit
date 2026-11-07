/**
 * 诊断 stats 的 token 缺口：区分「字段没落」和「落了 0」。
 * 前者是代码路径没传 onUsage，后者是 usage 事件没收到——修法完全不同。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(os.homedir(), '.dsh', 'dafeiyu', 'stats')
const OUT = path.join(HERE, '..', 'reports', 'stats-gap.json')

const rows = []
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.jsonl'))) {
  for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
  }
}

const absent = rows.filter((r) => !('promptTokens' in r))
const zero = rows.filter((r) => 'promptTokens' in r && !Number(r.promptTokens))
const positive = rows.filter((r) => Number(r.promptTokens) > 0)

const tally = (list) => {
  const m = {}
  for (const r of list) {
    const k = `${r.route || '?'}/${r.model || '-'}`
    m[k] = (m[k] || 0) + 1
  }
  return m
}

const out = {
  total: rows.length,
  absentField: absent.length,
  fieldZero: zero.length,
  positive: positive.length,
  zeroByRoute: tally(zero),
  absentByRoute: tally(absent),
  timeRange: {
    absent: [absent[0]?.at || null, absent[absent.length - 1]?.at || null],
    positive: [positive[0]?.at || null, positive[positive.length - 1]?.at || null],
  },
  absentTimes: absent.map((r) => `${r.at} ${r.channel}/${r.route}/${r.model}`),
  sampleZero: zero.slice(0, 5),
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8')
process.exit(0)
