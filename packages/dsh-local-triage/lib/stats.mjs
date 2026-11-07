/**
 * 埋点：把每次分诊与压缩记一行 JSONL，用于算命中率、误判率、每任务成本。
 * 写失败不影响主流程 —— 观测永远不能拖垮业务。
 */

import fs from 'node:fs'
import path from 'node:path'

export function record(entry, { file } = {}) {
  const row = { at: new Date().toISOString(), ...entry }
  if (!file) return row
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8')
  } catch {
    // 统计写不了不影响分诊
  }
  return row
}

export function readAll({ file } = {}) {
  if (!file) return []
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

export function summarize(rows) {
  const byTier = { local: 0, cheap: 0, frontier: 0 }
  const bySource = { rule: 0, model: 0, fallback: 0 }
  const modelMs = []
  let fallbacks = 0

  for (const row of rows) {
    if (byTier[row.tier] !== undefined) byTier[row.tier] += 1
    if (bySource[row.source] !== undefined) bySource[row.source] += 1
    if (row.source === 'model' && Number.isFinite(row.ms)) modelMs.push(row.ms)
    if (row.source === 'fallback') fallbacks += 1
  }

  const total = rows.length || 1
  return {
    total: rows.length,
    byTier,
    bySource,
    ruleCoverage: +(bySource.rule / total).toFixed(3),
    fallbackRate: +(fallbacks / total).toFixed(3),
    localMs: {
      p50: percentile(modelMs, 50),
      p95: percentile(modelMs, 95),
      max: modelMs.length ? Math.max(...modelMs) : 0,
    },
  }
}
