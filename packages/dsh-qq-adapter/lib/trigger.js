/**
 * Trigger：入口层统一产出的「事件单」（阶段 1.2 · 影子模式）。
 *
 * 现在只做两件事：
 *   1. 把一条 QQ 事件压成与渠道无关的 Trigger 结构；
 *   2. 用纯函数 fast path 判一次，把「快判结论」和「现网实际结论」一起落盘。
 *
 * 影子模式 = 只记录、不改行为。一周后 `summarizeDispositions()` 能回答：
 * 本来会接多少单（fast=accept）、和现网判断差多少（mismatch）。
 *
 * 稳定后再抽独立包 dsh-trigger；在此之前留在 qq-adapter 里，不新增必装插件。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shouldAnswer } from './onebot.js'

const SHADOW_FILE = 'trigger-shadow.jsonl'

export function triggerId(source, nativeId) {
  return crypto.createHash('sha256').update(`${source}:${nativeId}`).digest('hex').slice(0, 16)
}

export function buildTrigger(event, { source = 'qq', now = Date.now() } = {}) {
  const thread = `${event.kind}:${event.kind === 'group' ? event.groupId : event.userId}`
  return {
    id: triggerId(source, `${thread}:${event.messageId}`),
    source,
    actor: String(event.userId || ''),
    human: true,
    addressed: Boolean(event.atSelf),
    thread,
    at: now,
    text: String(event.text || ''),
    meta: {
      kind: event.kind,
      groupId: String(event.groupId || ''),
      messageId: String(event.messageId || ''),
      senderName: String(event.senderName || ''),
    },
  }
}

/** 纯函数快判：不调模型、不碰 IO。规则顺序与现网 shouldAnswer 对齐，便于比对。 */
export function fastPath(trigger, config = {}) {
  if (!trigger) return { decision: 'ignore', rule: 'no_trigger' }
  if (trigger.meta.kind === 'private') {
    return config.allowPrivate === false
      ? { decision: 'ignore', rule: 'private_disabled' }
      : { decision: 'accept', rule: 'private_allow' }
  }
  const groups = (config.groups || []).map(String).filter(Boolean)
  if (groups.length === 0) return { decision: 'ignore', rule: 'no_group_whitelist' }
  if (!groups.includes(String(trigger.meta.groupId))) return { decision: 'ignore', rule: 'group_not_whitelisted' }
  if (trigger.addressed) return { decision: 'accept', rule: 'at_self' }
  if (config.requireAtInGroup === false) return { decision: 'accept', rule: 'group_no_at_required' }
  const mode = String(config.groupTrigger || 'at')
  if (mode === 'auto') return { decision: 'accept', rule: 'group_auto' }
  if (mode === 'wake') {
    const words = (config.wakeWords || []).map(String).filter(Boolean)
    const hit = words.some((word) => trigger.text.includes(word))
    return hit ? { decision: 'accept', rule: 'wake_word' } : { decision: 'ignore', rule: 'no_wake_word' }
  }
  return { decision: 'ignore', rule: 'not_addressed' }
}

export function shadowDir() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dafeiyu')
}

/**
 * 落一条影子记录。任何异常都吞掉——影子模式绝不能影响正常回复。
 * config.triggerShadow === false 时整体关闭。
 */
export function recordTrigger(event, config = {}, { now = Date.now(), dir } = {}) {
  if (config?.triggerShadow === false) return null
  if (!event) return null
  try {
    const trigger = buildTrigger(event, { now })
    const fast = fastPath(trigger, config)
    const actual = shouldAnswer(event, config) ? 'accept' : 'ignore'
    const line = {
      at: new Date(now).toISOString(),
      id: trigger.id,
      source: trigger.source,
      thread: trigger.thread,
      actor: trigger.actor,
      addressed: trigger.addressed,
      fast: fast.decision,
      rule: fast.rule,
      actual,
      agree: fast.decision === actual,
      shadow: true,
    }
    const file = path.join(dir || shadowDir(), SHADOW_FILE)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8')
    return line
  } catch {
    return null
  }
}

/** 汇总影子数据：一周后用它回答「本来会接多少单、错判多少」。 */
export function summarizeDispositions(dir = shadowDir()) {
  const file = path.join(dir, SHADOW_FILE)
  const empty = { total: 0, fastAccept: 0, actualAccept: 0, agree: 0, mismatch: 0, byRule: {} }
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return empty
  }
  const out = { ...empty, byRule: {} }
  for (const text of raw.split('\n')) {
    if (!text.trim()) continue
    let row
    try {
      row = JSON.parse(text)
    } catch {
      continue
    }
    out.total += 1
    if (row.fast === 'accept') out.fastAccept += 1
    if (row.actual === 'accept') out.actualAccept += 1
    if (row.agree) out.agree += 1
    else out.mismatch += 1
    out.byRule[row.rule] = (out.byRule[row.rule] || 0) + 1
  }
  return out
}
