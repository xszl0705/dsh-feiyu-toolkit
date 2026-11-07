/**
 * dsh-local-triage —— 本地小模型分诊 + 确定性压缩。
 *
 * 两个独立能力，可以分开用：
 *   analyze(req)            三档路由判断（规则 → 本地 4B → fail-open 到 frontier）
 *   compressToolResult(...) 确定性压缩（不花模型，纯代码）
 *
 * 默认不启用（config.enabled = false）：接入宿主前先在离线回归集上跑通。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyze as analyzeRaw } from './lib/router.mjs'
import { record, summarize } from './lib/stats.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export { ruleTier, ruleCoverage, TIERS } from './lib/rules.mjs'
export { toFeatures, hitKeywords, approxTokens } from './lib/features.mjs'
export { circuitState, resetCircuit } from './lib/ollama.mjs'
export { summarize } from './lib/stats.mjs'
export {
  capText,
  projectFields,
  paginate,
  spillToFile,
  trimError,
  extractHunks,
  dedupeBlocks,
  compressToolResult,
} from './lib/compress.mjs'

export function loadConfig(file = path.join(HERE, 'config.json')) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 带埋点的分诊入口。
 * @param {{text:string, turns?:number, tools?:string[], attachments?:number}} req
 * @param {object} [opts] 合并进 config，并透传给 analyze
 */
export async function analyzeAndRecord(req, opts = {}) {
  const cfg = { ...loadConfig(), ...opts }
  const result = await analyzeRaw(req, cfg)
  record(
    {
      tier: result.tier,
      source: result.source,
      conf: result.conf,
      why: result.why,
      ms: result.ms,
      chars: String(req?.text ?? '').length,
      turns: Number(req?.turns ?? 0) || 0,
    },
    { file: cfg.statsFile },
  )
  return result
}

export { analyzeRaw as analyze }
