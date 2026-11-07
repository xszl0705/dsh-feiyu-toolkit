/**
 * 离线评测：跑回归集，出混淆矩阵。
 *
 * 用法（Electron 当 node 用，stdout 会丢，所以结果落文件）：
 *   E:\dsh\DeepSeek Harness.exe tools\eval-triage.mjs --rules   只测规则层
 *   E:\dsh\DeepSeek Harness.exe tools\eval-triage.mjs --full    规则 + 本地 4B
 *
 * 关键看的不是总准确率，是「真 frontier → 预测 local」这一格：
 * 它必须是 0，否则方案不能上。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ruleTier } from '../lib/rules.mjs'
import { analyze } from '../lib/router.mjs'
import { chatJSON, resetCircuit, circuitState } from '../lib/ollama.mjs'
import { GOLDEN } from '../tests/golden.mjs'
import { GOLDEN_REAL } from '../tests/golden-real.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const REPORT_DIR = path.join(ROOT, 'reports')

const args = new Set(process.argv.slice(2))
const mode = args.has('--rules') ? 'rules' : args.has('--full') ? 'full' : 'both'
const useReal = args.has('--real')
const DATASET = useReal ? 'real' : 'synthetic'
const DATA = useReal ? GOLDEN_REAL : GOLDEN

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
if (args.has('--ternary')) cfg.decisionStyle = 'ternary'
if (args.has('--binary')) cfg.decisionStyle = 'binary'

async function warmup() {
  if (mode === 'rules') return { tried: false }
  const startedAt = Date.now()
  try {
    // 关键：参数必须与正式调用完全一致（尤其 numCtx）。
    // 只要 ctx 变了，Ollama 会重载模型；而重载期间请求被超时掐断就会无限重来。
    await chatJSON({
      endpoint: cfg.endpoint,
      model: cfg.model,
      timeoutMs: 60000,
      numCtx: cfg.numCtx,
      numPredict: cfg.numPredict,
      keepAlive: cfg.keepAlive,
      messages: [
        { role: 'system', content: '只输出 JSON：{"tier":"cheap","conf":0.9,"why":"预热"}' },
        { role: 'user', content: '预热' },
      ],
    })
    return { tried: true, ok: true, ms: Date.now() - startedAt }
  } catch (error) {
    return { tried: true, ok: false, ms: Date.now() - startedAt, error: String(error?.message || error) }
  }
}

function emptyMatrix() {
  return {
    local: { local: 0, cheap: 0, frontier: 0 },
    cheap: { local: 0, cheap: 0, frontier: 0 },
    frontier: { local: 0, cheap: 0, frontier: 0 },
  }
}

async function run(modeName) {
  resetCircuit()
  const matrix = emptyMatrix()
  const latencies = []
  const bySource = { rule: 0, model: 0, fallback: 0 }
  const wrong = []
  let decided = 0
  let undecided = 0

  for (const item of DATA) {
    const rule = ruleTier(item, { maxTurns: cfg.rules?.maxTurns, maxChars: cfg.rules?.maxChars })
    let pred = rule.tier
    let source = rule.tier ? 'rule' : 'undecided'
    let detail = rule.why

    if (!pred && modeName === 'full') {
      const r = await analyze(item, {
        endpoint: cfg.endpoint,
        model: cfg.model,
        confidence: cfg.confidence,
        timeoutMs: cfg.timeoutMs,
        keepAlive: cfg.keepAlive,
        numCtx: cfg.numCtx,
        numPredict: cfg.numPredict,
        circuit: cfg.circuit,
        rules: cfg.rules,
        decisionStyle: cfg.decisionStyle,
        capModelLocal: cfg.capModelLocal,
      })
      pred = r.tier
      source = r.source
      detail = r.why
      if (r.source === 'model' || r.source === 'fallback') latencies.push(r.ms)
    }

    if (!pred) { undecided += 1; continue }

    decided += 1
    if (bySource[source] !== undefined) bySource[source] += 1
    matrix[item.expect][pred] += 1
    if (pred !== item.expect) wrong.push({ id: item.id, text: item.text.slice(0, 30), expect: item.expect, pred, source, detail })
  }

  return { matrix, latencies, bySource, wrong, decided, undecided }
}

function summarizeRun(label, data) {
  const { matrix, latencies, bySource, wrong, decided, undecided } = data
  const total = DATA.length

  let right = 0
  for (const t of ['local', 'cheap', 'frontier']) right += matrix[t][t]
  const falseLocal = matrix.cheap.local + matrix.frontier.local
  const falseFrontier = matrix.local.frontier + matrix.cheap.frontier

  const sorted = [...latencies].sort((a, b) => a - b)
  const p = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0)

  const lines = []
  lines.push(`# 评测报告 · ${label}`)
  lines.push(`时间：${new Date().toISOString()}`)
  lines.push(`样本：${total} 条；已判：${decided}；未判：${undecided}`)
  lines.push('')
  lines.push('## 混淆矩阵（行=真实，列=预测）')
  lines.push('| 真实\\预测 | local | cheap | frontier |')
  lines.push('|---|---|---|---|')
  for (const t of ['local', 'cheap', 'frontier']) {
    lines.push(`| ${t} | ${matrix[t].local} | ${matrix[t].cheap} | ${matrix[t].frontier} |`)
  }
  lines.push('')
  lines.push(`- 准确率：${((right / (decided || 1)) * 100).toFixed(1)}%（${right}/${decided}）`)
  lines.push(`- **false-local（复杂被判成 local）：${falseLocal}**  ← 这一格必须是 0`)
  lines.push(`- 过度升级（简单被判成 frontier）：${falseFrontier}`)
  lines.push(`- 来源分布：规则 ${bySource.rule} / 模型 ${bySource.model} / 兜底 ${bySource.fallback}`)
  if (latencies.length) {
    lines.push(`- 本地模型延迟：p50 ${p(0.5)}ms，p95 ${p(0.95)}ms，max ${Math.max(...latencies)}ms`)
  }
  lines.push('')
  if (wrong.length) {
    lines.push('## 判错的样本')
    lines.push('| id | 文本 | 期望 | 实际 | 来源 | 说明 |')
    lines.push('|---|---|---|---|---|---|')
    for (const w of wrong) lines.push(`| ${w.id} | ${w.text} | ${w.expect} | ${w.pred} | ${w.source} | ${w.detail} |`)
  } else {
    lines.push('## 全部判对')
  }
  return { text: lines.join('\n'), stats: { right, falseLocal, falseFrontier, decided, undecided, p50: p(0.5), p95: p(0.95) } }
}

async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true })
  const warm = await warmup()
  const out = { at: new Date().toISOString(), dataset: DATASET, sampleSize: DATA.length, warmup: warm, mode, runs: {} }

  const reportParts = []
  const modes = mode === 'both' ? ['rules', 'full'] : [mode]
  for (const m of modes) {
    const data = await run(m)
    const style = m === 'rules' ? '' : ` [${cfg.decisionStyle}]`
    const label = `${m === 'rules' ? '仅规则层' : '规则 + 本地 qwen3:4b'}${style}（${DATASET} / ${DATA.length} 条）`
    const s = summarizeRun(label, data)
    out.runs[m] = { ...s.stats, wrong: data.wrong, bySource: data.bySource }
    reportParts.push(s.text)
  }
  out.circuit = circuitState()

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const suffix = cfg.decisionStyle === 'binary' ? '-binary' : ''
  const prefix = `triage-eval-${DATASET}${suffix}`
  fs.writeFileSync(path.join(REPORT_DIR, `${prefix}-${stamp}.md`), reportParts.join('\n\n---\n\n'), 'utf8')
  fs.writeFileSync(path.join(REPORT_DIR, `${prefix}-latest.md`), reportParts.join('\n\n---\n\n'), 'utf8')
  fs.writeFileSync(path.join(REPORT_DIR, `${prefix}-latest.json`), JSON.stringify(out, null, 2), 'utf8')
  process.exit(0)
}

main().catch((error) => {
  fs.mkdirSync(REPORT_DIR, { recursive: true })
  fs.writeFileSync(path.join(REPORT_DIR, 'triage-eval-error.txt'), `${new Date().toISOString()}\n${error?.stack || error}`, 'utf8')
  process.exit(1)
})
