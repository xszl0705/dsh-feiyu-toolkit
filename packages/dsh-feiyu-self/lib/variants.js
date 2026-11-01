/**
 * Variant Runner：让策略改动可以小步放量、随时回滚，不用重启宿主。
 *
 * 语义照 OpenFeature 的思路简化：
 *  - flag 是配置，不是代码，改文件即生效（带 mtime 缓存）
 *  - 分桶用 sticky key（默认 conversation），保证同一个人不会收到两个版本
 *  - 关掉一个 flag 就是回滚，不需要重启
 *
 * 只做「取值」，不自动改文件——改权重仍然要人或 M5 的审批流程来写。
 */

import fs from 'node:fs'
import { createHash } from 'node:crypto'

export const DEFAULT_FLAGS = {
  'route.modelHint': {
    enabled: false,
    variants: { control: 100 },
    stickyKey: 'conversation',
    audience: { channel: ['qq'] },
    owner: 'self-evolution',
  },
}

export function bucketOf(key, name) {
  const hash = createHash('sha256').update(`${name}:${key}`).digest()
  return hash.readUInt32BE(0) % 100
}

export function validateFlag(name, flag) {
  const problems = []
  if (!flag || typeof flag !== 'object') return { ok: false, problems: ['flag 不是对象'] }
  const variants = flag.variants || {}
  const entries = Object.entries(variants)
  if (!entries.length) problems.push('variants 为空')
  let total = 0
  for (const [variant, weight] of entries) {
    if (!Number.isFinite(weight) || weight < 0) problems.push(`variant ${variant} 权重非法`)
    else total += weight
  }
  if (entries.length && Math.abs(total - 100) > 1e-6) problems.push(`权重合计应为 100，当前 ${total}`)
  if (flag.stickyKey && typeof flag.stickyKey !== 'string') problems.push('stickyKey 必须是字符串')
  return { ok: problems.length === 0, problems: problems.map((item) => `${name}: ${item}`) }
}

function matchesAudience(audience, context) {
  if (!audience || typeof audience !== 'object') return true
  for (const [field, allowed] of Object.entries(audience)) {
    if (!Array.isArray(allowed) || !allowed.length) continue
    const value = String(context[field] ?? '')
    if (!allowed.map(String).includes(value)) return false
  }
  return true
}

/**
 * 取一个 flag 在当前上下文下的变体。
 * 返回的 reason 说明为什么是这个结果，便于排查「为什么他没进实验」。
 */
export function evaluateFlag({ name, flag, context = {} } = {}) {
  if (!name) return { variant: 'control', bucket: null, reason: 'no-name' }
  if (!flag || flag.enabled === false) return { variant: 'control', bucket: null, reason: 'disabled' }
  const check = validateFlag(name, flag)
  if (!check.ok) return { variant: 'control', bucket: null, reason: 'invalid-config', problems: check.problems }
  if (!matchesAudience(flag.audience, context)) return { variant: 'control', bucket: null, reason: 'audience-miss' }

  const stickyKey = String(flag.stickyKey || 'conversation')
  const key = String(context[stickyKey] ?? '')
  if (!key) return { variant: 'control', bucket: null, reason: `missing-${stickyKey}` }

  const bucket = bucketOf(key, name)
  const variants = Object.entries(flag.variants)
  const total = variants.reduce((sum, [, weight]) => sum + weight, 0)
  const point = total === 100 ? bucket : Math.floor((bucket * total) / 100)
  let acc = 0
  for (const [variant, weight] of variants) {
    acc += weight
    if (point < acc) return { variant, bucket, reason: 'assigned' }
  }
  return { variant: 'control', bucket, reason: 'fallback' }
}

/**
 * flag 存储：按 mtime 缓存，文件一改立即生效。
 * 文件坏了就退回上一次成功解析的内容，并标记 broken——不阻塞调用方。
 */
export function createFlagStore({ file, fallback = {} } = {}) {
  let cache = { mtime: -1, flags: fallback, broken: false }

  function read() {
    if (!file) return cache.flags
    try {
      const stat = fs.statSync(file)
      if (stat.mtimeMs !== cache.mtime) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        cache = { mtime: stat.mtimeMs, flags: parsed && typeof parsed === 'object' ? parsed : {}, broken: false }
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        cache = { mtime: -1, flags: fallback, broken: false }
      } else {
        cache.broken = true
      }
    }
    return cache.flags
  }

  return {
    get(name) {
      return read()[name]
    },
    list() {
      const flags = read()
      return Object.entries(flags).map(([name, flag]) => ({
        name,
        enabled: flag?.enabled !== false,
        variants: flag?.variants || {},
        stickyKey: flag?.stickyKey || 'conversation',
        audience: flag?.audience || {},
        owner: flag?.owner || '',
        valid: validateFlag(name, flag).ok,
      }))
    },
    evaluate(name, context) {
      return evaluateFlag({ name, flag: read()[name], context })
    },
    state() {
      return { broken: cache.broken, count: Object.keys(cache.flags || {}).length }
    },
  }
}
