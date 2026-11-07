/**
 * 订阅直通的影子记录器（方案 v3 · 2.2 阶段 1）。
 *
 * 只做一件事：非 @ 群消息本来要交给微心跳时，记一行 JSONL，用来回答
 * 「本来有多少条、多长、改成工单卡片能省多少 token」。
 *
 * 默认关闭（`config.subscribeShadow.enabled=false`），关闭时零副作用；
 * 开启后也只写文件，不改变任何发送/回复行为。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 中文为主的文本约 1.6 字符/token（DSH 自己按 4 字符/token 估，对中文偏低）。 */
export function estimateTokens(chars) {
  return Math.ceil(Math.max(0, Number(chars) || 0) / 1.6)
}

export function shadowFile(dir, date = new Date()) {
  const day = date.toISOString().slice(0, 10)
  return path.join(dir, `subscribe-shadow-${day}.jsonl`)
}

function defaultDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'dafeiyu', 'qq-shadow')
}

/**
 * 建一个记录器。enabled 为假的实例 act 直接返回 null，调用方不必自己判空。
 */
export function createShadowRecorder({ dir = '', enabled = false } = {}) {
  const target = dir || defaultDir()
  const on = enabled !== false
  return {
    enabled: on,
    dir: target,
    record(entry = {}) {
      if (!on) return null
      const chars = Number(entry.chars) || 0
      const row = {
        at: new Date().toISOString(),
        ...entry,
        chars,
        estTokens: entry.estTokens ?? estimateTokens(chars),
        wouldCard: true,
      }
      try {
        fs.mkdirSync(target, { recursive: true })
        fs.appendFileSync(shadowFile(target), JSON.stringify(row) + '\n')
        return row
      } catch {
        // 影子记录失败绝不能影响群消息处理
        return null
      }
    },
  }
}

/** 从 event 里抽影子记录需要的字段（不读 runtime，方便单测）。 */
export function shadowEntryOf(event = {}, extra = {}) {
  const text = String(event?.text || '')
  return {
    groupId: String(event?.groupId || ''),
    userId: String(event?.userId || ''),
    senderName: String(event?.senderName || ''),
    threadKey: event?.groupId ? `group:${event.groupId}` : '',
    chars: text.length,
    ...extra,
  }
}

/** 每条群消息懒建一个记录器，存在 st 上，跨调用复用。默认关：只有显式 `enabled: true` 才记。 */
export function recordGroupMessage(runtime, st, event, extra = {}) {
  const cfg = runtime?.config?.subscribeShadow || {}
  if (cfg.enabled !== true) return null
  st.shadowRecorder ||= createShadowRecorder({ dir: cfg.dir || '', enabled: true })
  return st.shadowRecorder.record(shadowEntryOf(event, extra))
}
