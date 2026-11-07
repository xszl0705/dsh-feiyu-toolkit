/**
 * 延迟探针：量清楚 qwen3:4b 在本机的真实分类耗时，用来定 timeout。
 * 结论落 reports/probe-latency.json —— stdout 在 Electron 下会丢。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatJSON, resetCircuit } from '../lib/ollama.mjs'
import { toFeatures } from '../lib/features.mjs'
import { GOLDEN } from '../tests/golden.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
const OUT = path.join(ROOT, 'reports', 'probe-latency.json')

const SYSTEM = `你是请求分诊器。判断这条请求该由哪一档模型处理。
- local：一句话确认即可
- cheap：一点推理、单步
- frontier：多步、跨文件、要可靠
只输出 JSON：{"tier":"local|cheap|frontier","conf":0.0,"why":"不超过6字"}`

async function ps() {
  try {
    const r = await fetch(`${cfg.endpoint}/api/ps`, { signal: AbortSignal.timeout(5000) })
    const d = await r.json()
    return (d.models || []).map((m) => ({ name: m.name, size_vram: m.size_vram, context: m.context_length }))
  } catch (e) {
    return [{ error: String(e?.message || e) }]
  }
}

async function call(label, req, overrides = {}) {
  resetCircuit()
  const startedAt = Date.now()
  try {
    const r = await chatJSON({
      endpoint: cfg.endpoint,
      model: cfg.model,
      timeoutMs: 60000,
      numCtx: cfg.numCtx,
      numPredict: cfg.numPredict,
      keepAlive: cfg.keepAlive,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: toFeatures(req) },
      ],
      ...overrides,
    })
    return { label, ok: true, wallMs: Date.now() - startedAt, totalMs: Math.round(r.totalMs), usage: r.usage, parsed: r.parsed }
  } catch (error) {
    return { label, ok: false, wallMs: Date.now() - startedAt, error: String(error?.message || error) }
  }
}

async function main() {
  resetCircuit()
  const before = await ps()
  const results = []

  // 1) 冷启动（不对齐参数，看第一次真实调用要多久）
  results.push(await call('cold-first', GOLDEN[39]))          // g40 这个函数是干什么的
  results.push(await call('warm-2', GOLDEN[38]))              // g39 改个名字
  results.push(await call('warm-3', GOLDEN[19]))              // g20 行吧那就这样

  // 2) 参数对齐后的连续调用（真实使用形态）
  for (const id of ['g19', 'g20', 'g40']) {
    const item = GOLDEN.find((g) => g.id === id)
    results.push(await call(`aligned-${id}`, item))
  }

  const after = await ps()
  const ok = results.filter((r) => r.ok)
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        config: { model: cfg.model, numCtx: cfg.numCtx, numPredict: cfg.numPredict, keepAlive: cfg.keepAlive },
        psBefore: before,
        psAfter: after,
        results,
        summary: {
          okCount: ok.length,
          failCount: results.length - ok.length,
          wall: ok.map((r) => r.wallMs),
          avgWall: ok.length ? Math.round(ok.reduce((s, r) => s + r.wallMs, 0) / ok.length) : 0,
          avgPromptTokens: ok.length ? Math.round(ok.reduce((s, r) => s + (r.usage?.prompt || 0), 0) / ok.length) : 0,
          avgOutTokens: ok.length ? Math.round(ok.reduce((s, r) => s + (r.usage?.out || 0), 0) / ok.length) : 0,
        },
      },
      null,
      2,
    ),
    'utf8',
  )
  process.exit(0)
}

main().catch((error) => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify({ error: String(error?.stack || error) }, null, 2), 'utf8')
  process.exit(1)
})
