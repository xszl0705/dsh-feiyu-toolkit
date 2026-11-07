/**
 * 分诊桥：把 local-triage 的三档判断接进 decideRoute。
 *
 * 三条护栏（按 README「接入状态」的计划落地）：
 *  1. **默认关**：flags.json 里 `route.tier.enabled !== true` 时完全不碰，走原逻辑。
 *  2. **可缺席**：local-triage 目录不在（发布包里没带、目录改名）→ 静默降级，不抛。
 *  3. **只降不升**：只有 tier === 'local' 才把 route 改成 local；cheap / frontier 一律 big。
 *     local-triage 的规则层本身只认极窄的确认类短语，模型判 local 会被 cap 成 cheap，
 *     所以这里不会把「这个函数是干什么的」误判成本地。
 *
 * 灰度：改 `~/.dsh/dafeiyu/flags.json` 即时生效（mtime 缓存），不用重启宿主。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const FLAGS_FILE = path.join(DSH_HOME, 'dafeiyu', 'flags.json')

// 工作区布局下 dsh-local-triage 与 brain 同级；发布包里没有它就是「缺席」。
// 旧目录名 local-triage 保留为兼容候选：改名前的部署仍能命中。
const CANDIDATES = [
  path.resolve(HERE, '../../dsh-local-triage/index.mjs'),
  path.resolve(HERE, '../../../dsh-plugins/dsh-local-triage/index.mjs'),
  path.resolve(HERE, '../../local-triage/index.mjs'),
  path.resolve(HERE, '../../../dsh-plugins/local-triage/index.mjs'),
]

let moduleCache = { tried: false, mod: null }
let flagCache = { mtime: -1, value: null }

/** 读灰度开关；文件不存在/坏了都返回 null（= 未启用），不抛。 */
export function readFlag(name = 'route.tier') {
  try {
    const st = fs.statSync(FLAGS_FILE)
    if (st.mtimeMs !== flagCache.mtime) {
      const parsed = JSON.parse(fs.readFileSync(FLAGS_FILE, 'utf8'))
      flagCache = { mtime: st.mtimeMs, value: parsed?.[name] || null }
    }
    return flagCache.value
  } catch {
    return null
  }
}

async function loadTriage() {
  if (moduleCache.tried) return moduleCache.mod
  moduleCache.tried = true
  for (const file of CANDIDATES) {
    try {
      moduleCache.mod = await import(pathToFileURL(file).href)
      return moduleCache.mod
    } catch {
      // 试下一个候选路径
    }
  }
  return null
}

/**
 * 灰度命中判断：flag.enabled 是总开关，variants.triage 是放量比例（0–100）。
 * 按 sticky key（conversation）哈希分桶，同一个会话永远落在同一档，不会一会儿本地一会儿云端。
 * variants 只写 control:100（默认）时比例是 0，等于没开。
 */
export function isEnabledFor(flag, conversation = '') {
  if (!flag || flag.enabled !== true) return false
  const variants = flag.variants || {}
  const hasVariants = Object.keys(variants).length > 0
  const hasTriage = hasVariants && Object.prototype.hasOwnProperty.call(variants, 'triage')
  // 没写 variants → 全量；写了 variants 但没有 triage 键 → 0（默认 control:100 的语义就是没放量）。
  const raw = hasTriage ? Number(variants.triage) : (hasVariants ? 0 : 100)
  const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 100
  if (pct >= 100) return true
  if (pct <= 0) return false
  const bucket = createHash('sha256').update(`route.tier:${conversation}`).digest().readUInt32BE(0) % 100
  return bucket < pct
}

/**
 * @param {string} text 用户原话
 * @param {object} [opts] flagName / conversation（分桶 key）/ triage（透传给 local-triage.analyze 的配置）
 * @returns {Promise<{route:'local'|'big', reason:string, tier?:string} | null>} null = 未启用或不可用
 */
export async function triageRoute(text, opts = {}) {
  const flag = readFlag(opts.flagName || 'route.tier')
  if (!isEnabledFor(flag, opts.conversation)) return null
  const mod = await loadTriage()
  if (typeof mod?.analyze !== 'function') return null
  try {
    const result = await mod.analyze({ text: String(text || '') }, { ...(opts.triage || {}) })
    return {
      route: result?.tier === 'local' ? 'local' : 'big',
      reason: `tier:${result?.tier || 'unknown'}/${result?.source || '?'}`,
      tier: result?.tier,
    }
  } catch {
    // analyze 本身承诺不抛，这里再兜一层：分诊坏了不能影响回复
    return null
  }
}

/** 仅给测试用：清掉模块与 flag 缓存，模拟进程重启。 */
export function resetTriageCache() {
  moduleCache = { tried: false, mod: null }
  flagCache = { mtime: -1, value: null }
}
