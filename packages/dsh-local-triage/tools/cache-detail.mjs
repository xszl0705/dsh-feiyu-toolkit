/**
 * 逐调用核对缓存命中：把每条有 token 的调用按时间排开，看 cacheReadTokens 的真实分布。
 *
 * 目的：区分两种可能
 *   A. 结构问题 —— 命中率一直低，说明前缀每次都变
 *   B. 流量形态 —— 大量一次性调用，本来就没有可复用的前缀
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 "E:\dsh\DeepSeek Harness.exe" tools\cache-detail.mjs
 * 输出：reports/cache-detail.md
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATS = path.join(os.homedir(), '.dsh', 'dafeiyu', 'stats')
const OUT = path.join(HERE, '..', 'reports', 'cache-detail.md')

function rows() {
  const dir = STATS
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort() } catch { return [] }
  const all = []
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try { all.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
    }
  }
  return all.filter((r) => Number(r.promptTokens) > 0).sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

function main() {
  const list = rows()
  const md = []
  md.push('# 缓存命中逐调用核对')
  md.push('')
  md.push(`有 token 的调用：${list.length} 条`)
  md.push('')

  if (!list.length) {
    md.push('没有可用数据。')
    fs.writeFileSync(OUT, md.join('\n') + '\n', 'utf8')
    process.exit(0)
  }

  md.push('| # | 时间 | 渠道 | 模型 | 输入 | 命中 | 命中率 |')
  md.push('|---|---|---|---|---:|---:|---:|')
  let totalIn = 0
  let totalHit = 0
  let zero = 0
  list.forEach((r, i) => {
    const p = Number(r.promptTokens) || 0
    const c = Number(r.cacheReadTokens) || 0
    totalIn += p
    totalHit += c
    if (c === 0) zero += 1
    const rate = p > 0 ? ((c / p) * 100).toFixed(0) + '%' : '—'
    md.push(`| ${i + 1} | ${String(r.at).slice(5, 16).replace('T', ' ')} | ${r.channel || '?'} | ${r.model || '?'} | ${p} | ${c} | ${rate} |`)
  })

  const overall = totalIn > 0 ? (totalHit / totalIn) * 100 : 0
  md.push('')
  md.push('## 汇总')
  md.push('')
  md.push(`- 总输入 ${totalIn}，总命中 ${totalHit}，整体命中率 **${overall.toFixed(1)}%**`)
  md.push(`- 完全没命中的调用：**${zero} / ${list.length}**（${((zero / list.length) * 100).toFixed(0)}%）`)
  md.push('')

  // 判断：如果"零命中"占比高，说明大量调用是一次性的，命中率低是流量形态而非结构问题
  if (zero / list.length > 0.6) {
    md.push('**判读**：多数调用完全没命中。可能是一次性调用多（流量形态），也可能是前缀每次都变（结构问题）。看下面「同会话连续调用」是否命中。')
  } else {
    md.push('**判读**：大部分调用有命中，说明缓存机制在工作；提升空间在"稳定段更长"。')
  }
  md.push('')

  // 同会话连续调用：如果同一 conversation 相邻两条都没命中，说明前缀在变
  const byConv = new Map()
  for (const r of list) {
    const k = r.conversation || 'unknown'
    if (!byConv.has(k)) byConv.set(k, [])
    byConv.get(k).push(r)
  }
  md.push('## 同会话连续调用')
  md.push('')
  for (const [conv, arr] of byConv) {
    if (arr.length < 2) continue
    const rates = arr.map((r) => ((Number(r.cacheReadTokens) || 0) / (Number(r.promptTokens) || 1) * 100).toFixed(0) + '%')
    md.push(`- \`${conv}\`（${arr.length} 次）：${rates.join(' → ')}`)
  }
  md.push('')
  md.push('同一会话里第二次调用仍然 0% 命中，就是结构问题（前缀变了），不是流量问题。')

  fs.writeFileSync(OUT, md.join('\n') + '\n', 'utf8')
  process.exit(0)
}

main()
