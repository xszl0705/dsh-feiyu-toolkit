/**
 * 用量画像：从现有日志里算出"调用花在哪"，并如实报告缺哪些字段。
 *
 * 数据源：
 *   ~/.dsh/dafeiyu/stats/*.jsonl        （route / model / ms）
 *   ~/.dsh/dafeiyu/dialogues/*.jsonl    （消息量、渠道、长度分布）
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 "E:\dsh\DeepSeek Harness.exe" tools\analyze-usage.mjs
 * 输出：reports/usage-profile.md + reports/usage-profile.json
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE = path.join(os.homedir(), '.dsh', 'dafeiyu')
const OUT_DIR = path.join(HERE, '..', 'reports')

function readJSONL(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

function filesIn(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(dir, f))
  } catch {
    return []
  }
}

function pct(values, p) {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

function tidy(map) {
  return Object.entries(map).sort((a, b) => b[1] - a[1])
}

function main() {
  const statsRows = filesIn(path.join(BASE, 'stats')).flatMap(readJSONL)
  const dialogueRows = filesIn(path.join(BASE, 'dialogues')).flatMap(readJSONL)

  // ---- 调用画像 ----
  const byChannel = {}
  const byRoute = {}
  const byModel = {}
  const latencies = []
  const fields = new Set()

  for (const r of statsRows) {
    Object.keys(r).forEach((k) => fields.add(k))
    byChannel[r.channel || 'unknown'] = (byChannel[r.channel || 'unknown'] || 0) + 1
    byRoute[r.route || 'unknown'] = (byRoute[r.route || 'unknown'] || 0) + 1
    byModel[r.model || 'unknown'] = (byModel[r.model || 'unknown'] || 0) + 1
    if (Number.isFinite(r.ms)) latencies.push(r.ms)
  }

  // ---- 消息画像 ----
  const msgByChannel = {}
  const msgByRole = {}
  const userLens = []
  for (const d of dialogueRows) {
    msgByChannel[d.channel || 'unknown'] = (msgByChannel[d.channel || 'unknown'] || 0) + 1
    msgByRole[d.role || 'unknown'] = (msgByRole[d.role || 'unknown'] || 0) + 1
    if (d.role === 'user' && typeof d.text === 'string') userLens.push(d.text.length)
  }

  // ---- 缺口判定 ----
  // 注意：日志里是 camelCase（promptTokens），别按 snake_case 找——会误判成"没有观测"
  const FIELD_ALIASES = {
    prompt: ['promptTokens', 'prompt_tokens', 'inputTokens', 'input_tokens'],
    completion: ['outTokens', 'completionTokens', 'completion_tokens', 'outputTokens'],
    cached: ['cacheReadTokens', 'cachedTokens', 'cached_tokens', 'prompt_cache_hit_tokens'],
    total: ['totalTokens', 'total_tokens'],
  }
  const picked = {}
  const missing = []
  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
    const hit = aliases.find((a) => fields.has(a))
    if (hit) picked[key] = hit
    else missing.push(`${key}(${aliases[0]})`)
  }
  const hasTokens = missing.length === 0

  // ---- token 统计（有字段才算）----
  let sumPrompt = 0
  let sumOut = 0
  let sumCached = 0
  let callsWithTokens = 0
  const promptPerCall = []
  const outPerCall = []
  for (const r of statsRows) {
    const p = Number(r[picked.prompt] ?? NaN)
    const o = Number(r[picked.completion] ?? NaN)
    if (!Number.isFinite(p) && !Number.isFinite(o)) continue
    callsWithTokens += 1
    if (Number.isFinite(p)) { sumPrompt += p; promptPerCall.push(p) }
    if (Number.isFinite(o)) { sumOut += o; outPerCall.push(o) }
    const c = Number(r[picked.cached] ?? 0)
    if (Number.isFinite(c)) sumCached += c
  }
  const tokenKnown = callsWithTokens > 0
  const ioRatio = sumOut > 0 ? +(sumPrompt / sumOut).toFixed(2) : null
  const cacheHitRatio = sumPrompt > 0 ? +(sumCached / sumPrompt).toFixed(4) : null

  // 「字段缺失」与「字段为 0」是两件事：前者是埋点上线前的历史行，后者是真没收到 usage。
  // 混在一起会误判成"观测坏了"。
  const absentField = statsRows.filter((r) => !(picked.prompt in r)).length
  const fieldZero = statsRows.filter((r) => picked.prompt in r && !Number(r[picked.prompt])).length

  // 每任务聚合：同一条入站消息触发的所有调用共享 traceId
  const byTrace = new Map()
  for (const r of statsRows) {
    const t = r.traceId
    if (!t) continue
    if (!byTrace.has(t)) byTrace.set(t, { calls: 0, prompt: 0, out: 0, cached: 0 })
    const b = byTrace.get(t)
    b.calls += 1
    b.prompt += Number(r[picked.prompt] ?? 0) || 0
    b.out += Number(r[picked.completion] ?? 0) || 0
    b.cached += Number(r[picked.cached] ?? 0) || 0
  }
  const taskStats = [...byTrace.values()]
  const multiCallTasks = taskStats.filter((t) => t.calls > 1).length

  const md = []
  md.push('# 用量画像')
  md.push('')
  md.push(`生成时间：${new Date().toISOString()}`)
  md.push(`数据：${statsRows.length} 条调用记录、${dialogueRows.length} 条消息`)
  md.push('')
  md.push('## 调用分布')
  md.push('')
  md.push('| 维度 | 分布 |')
  md.push('|---|---|')
  md.push(`| 渠道 | ${tidy(byChannel).map(([k, v]) => `${k} ${v}`).join('，') || '无'} |`)
  md.push(`| 路由 | ${tidy(byRoute).map(([k, v]) => `${k} ${v}`).join('，') || '无'} |`)
  md.push(`| 模型 | ${tidy(byModel).map(([k, v]) => `${k} ${v}`).join('，') || '无'} |`)
  md.push(`| 延迟 p50/p95 | ${pct(latencies, 50)}ms / ${pct(latencies, 95)}ms |`)
  md.push('')
  md.push('## 消息分布')
  md.push('')
  md.push('| 维度 | 分布 |')
  md.push('|---|---|')
  md.push(`| 按渠道 | ${tidy(msgByChannel).map(([k, v]) => `${k} ${v}`).join('，') || '无'} |`)
  md.push(`| 按角色 | ${tidy(msgByRole).map(([k, v]) => `${k} ${v}`).join('，') || '无'} |`)
  md.push(`| 用户消息长度 p50/p95 | ${pct(userLens, 50)} / ${pct(userLens, 95)} 字 |`)
  md.push('')
  md.push('## Token 结构')
  md.push('')
  if (tokenKnown) {
    md.push('| 指标 | 值 |')
    md.push('|---|---|')
    md.push(`| 有 token 记录的调用 | ${callsWithTokens} / ${statsRows.length} |`)
    md.push(`| 累计输入 token | ${sumPrompt.toLocaleString()} |`)
    md.push(`| 累计输出 token | ${sumOut.toLocaleString()} |`)
    md.push(`| **输入:输出** | **${ioRatio ?? 'n/a'} : 1** |`)
    md.push(`| 缓存命中 token | ${sumCached.toLocaleString()} |`)
    md.push(`| **缓存命中率** | **${cacheHitRatio === null ? 'n/a' : (cacheHitRatio * 100).toFixed(1) + '%'}** |`)
    md.push(`| 单次输入 p50/p95 | ${pct(promptPerCall, 50)} / ${pct(promptPerCall, 95)} |`)
    md.push(`| 单次输出 p50/p95 | ${pct(outPerCall, 50)} / ${pct(outPerCall, 95)} |`)
    md.push('')
    if (ioRatio !== null) {
      md.push(ioRatio > 5
        ? `输入是输出的 ${ioRatio} 倍 —— 优化重点在**输入**（缓存、裁剪、压缩），不是让模型少说话。`
        : `输入:输出 = ${ioRatio}，输入不是绝对大头，输出控制也值得做。`)
    }
    if (cacheHitRatio !== null) {
      md.push(cacheHitRatio < 0.3
        ? `缓存命中率 ${(cacheHitRatio * 100).toFixed(1)}% 偏低 —— 前缀结构大概率有问题，优先查 prefix-audit。`
        : `缓存命中率 ${(cacheHitRatio * 100).toFixed(1)}%，处于合理区间。`)
    }
  } else {
    md.push('没有可用的 token 记录。')
  }
  md.push('')
  md.push('## 每任务成本')
  md.push('')
  if (taskStats.length) {
    md.push('| 指标 | 值 |')
    md.push('|---|---|')
    md.push(`| 可聚合任务数（有 traceId） | ${taskStats.length} |`)
    md.push(`| 多调用任务 | ${multiCallTasks} |`)
    md.push(`| 每任务调用次数 p50 | ${pct(taskStats.map((t) => t.calls), 50)} |`)
    md.push(`| 每任务输入 token p50 | ${pct(taskStats.map((t) => t.prompt), 50)} |`)
    md.push('')
    if (!multiCallTasks) md.push('目前每个任务只调一次模型，还没有"多跑步数"的问题。')
  } else {
    md.push('还没有 traceId，算不了每任务成本。下一次 QQ 消息落盘后这里会有数据。')
  }
  md.push('')
  md.push('## 观测缺口')
  md.push('')
  md.push(`- 字段缺失 **${absentField}** 条 / 字段为 0 的 **${fieldZero}** 条。`)
  md.push('- 这两件事修法不同：**缺失**是埋点上线前的历史行（不用管）；**为 0** 是真没收到 usage（要查流式事件）。')
  md.push('')
  if (hasTokens) {
    md.push('- token 字段齐全，可以算成本。')
  } else {
    md.push(`- **缺字段：${missing.join('、')}**`)
    md.push('- 缺了它就无法回答"一次任务花多少 token、缓存命中多少"，也就无法证明改完变好。')
    md.push('')
    md.push('### 需要补的字段')
    md.push('')
    md.push('| 字段 | 来源 | 用途 |')
    md.push('|---|---|---|')
    md.push('| `promptTokens` | 云端 `usage.prompt_tokens` | 算输入成本 |')
    md.push('| `outTokens` | `usage.completion_tokens` | 算输出成本 |')
    md.push('| `cacheReadTokens` | DeepSeek `prompt_cache_hit_tokens` / OpenAI `cached_tokens` | 算缓存命中率 |')
    md.push('| `traceId` | 入站消息 ID | 算"每任务成本"而不是"每请求成本" |')
    md.push('| `attempts` | 本地计数 | 算重试浪费 |')
    md.push('')
  }
  md.push('## 现有字段')
  md.push('')
  md.push([...fields].sort().map((f) => `\`${f}\``).join('、') || '无')

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'usage-profile.md'), md.join('\n') + '\n', 'utf8')
  fs.writeFileSync(
    path.join(OUT_DIR, 'usage-profile.json'),
    JSON.stringify({
      statsRows: statsRows.length,
      dialogueRows: dialogueRows.length,
      byChannel,
      byRoute,
      byModel,
      latency: { p50: pct(latencies, 50), p95: pct(latencies, 95) },
      fields: [...fields].sort(),
      token: {
        callsWithTokens,
        prompt: sumPrompt,
        out: sumOut,
        cached: sumCached,
        ioRatio,
        cacheHitRatio,
        promptP50: pct(promptPerCall, 50),
        outP50: pct(outPerCall, 50),
      },
      missing,
    }, null, 2),
    'utf8',
  )
  process.exit(0)
}

main()
