/**
 * 按文件缓存对话 JSONL：文件没变就复用解析结果，并按 conversation 提前分组。
 *
 * 为什么这样做：
 *  - 同一条消息里 recent() 会被调用 2–3 次，每次都 readFileSync + split + 解析 300+ 行
 *  - 实测一天 325KB / 334 行，读一次 1–3ms，重复读才是真正的浪费
 *  - 用 (mtimeMs, size) 双条件判断：append 一定改变 size，同毫秒写入也不会漏
 */

import fs from 'node:fs'
import path from 'node:path'

export function createDayReader({ dir, maxFiles = 8 } = {}) {
  if (!dir) throw new Error('reader dir is required')
  const cache = new Map()
  const counters = { hits: 0, misses: 0, bytesRead: 0, rowsParsed: 0 }

  function load(file) {
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      return null
    }
    const hit = cache.get(file)
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      counters.hits += 1
      return hit.byConversation
    }
    let raw = ''
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
    counters.misses += 1
    counters.bytesRead += raw.length
    const byConversation = new Map()
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        const key = String(row.conversation || '')
        const list = byConversation.get(key) || []
        list.push(row)
        byConversation.set(key, list)
        counters.rowsParsed += 1
      } catch {
        // 坏行跳过
      }
    }
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, byConversation })
    if (cache.size > maxFiles) {
      // 最久没被更新的那个先淘汰
      let oldestKey = ''
      let oldestAt = Infinity
      for (const [key, value] of cache) {
        if (value.mtimeMs < oldestAt) {
          oldestAt = value.mtimeMs
          oldestKey = key
        }
      }
      if (oldestKey) cache.delete(oldestKey)
    }
    return byConversation
  }

  return {
    /** 取某天某会话的行；文件不存在返回空数组。 */
    rowsFor({ day, conversation }) {
      if (!day) return []
      const map = load(path.join(dir, `${day}.jsonl`))
      if (!map) return []
      return map.get(String(conversation || '')) || []
    },
    stats() {
      return { ...counters, files: cache.size, dir }
    },
    invalidate() {
      cache.clear()
    },
  }
}
