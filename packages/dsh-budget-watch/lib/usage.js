/**
 * 会话日志解析：把 DSH 的 session.v4.jsonl.zstd 读成用量统计。
 *
 * 日志是多帧 zstd 拼接，Node 的流式解压会在某些帧上报 `Unknown frame descriptor`，
 * 所以按魔数 28 B5 2F FD 切帧、逐帧解压。
 *
 * 只读，不写任何东西。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

/** 保留最近多少步的输入明细，用于识别「连续多次非缓存输入偏高」的突发。 */
export const RECENT_KEEP = 8

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

export function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.name.endsWith('.jsonl.zstd') || e.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

export function readSession(file) {
  const buf = fs.readFileSync(file)
  if (!file.endsWith('.zstd')) return buf.toString('utf8')
  const pos = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) pos.push(i)
  }
  const texts = []
  for (let k = 0; k < pos.length; k++) {
    try {
      texts.push(zlib.zstdDecompressSync(buf.subarray(pos[k], pos[k + 1] ?? buf.length)).toString('utf8'))
    } catch {
      // 坏帧跳过，不影响其它帧
    }
  }
  return texts.join('\n')
}

/**
 * 会话目录名就是会话 id（`~/.dsh/sessions/<工作区>/<uuid>/session.v4.jsonl.zstd`）。
 * 按 id 找文件，比「谁最后被改」可靠：子代理会话、后台会话都会改 mtime。
 */
export function sessionDirOf(file) {
  return path.basename(path.dirname(file))
}

export function resolveSessionFile(sessionId) {
  const raw = String(sessionId || '').trim()
  if (!raw) return null
  const id = raw.replace(/^session-/, '')
  const files = walk(sessionsRoot())
  for (const f of files) {
    const dir = sessionDirOf(f)
    if (dir === id || dir === 'session-' + id) return f
  }
  // 兜底：路径里含这个 id（目录名可能带前后缀）
  return files.find((f) => f.split(/[\\/]/).includes(id)) || null
}

/** 解析一个会话文件，返回用量统计。 */
export function summarizeFile(file) {
  let text
  try {
    text = readSession(file)
  } catch {
    return null
  }
  let input = 0
  let cache = 0
  let output = 0
  let steps = 0
  let maxStep = 0
  /** 最近一步的输入明细：context = 这一步实际送进模型的全部输入（含缓存）。 */
  let context = 0
  let lastInput = 0
  let lastCache = 0
  const recent = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      continue
    }
    if (frame.type !== 'assistant/message') continue
    const u = frame.data?.usage
    if (!u) continue
    steps++
    const inTok = u.inputTokens || 0
    const cacheTok = u.cacheReadTokens || 0
    input += inTok
    cache += cacheTok
    output += u.outputTokens || 0
    const stepTotal = inTok + cacheTok
    if (stepTotal > maxStep) maxStep = stepTotal
    lastInput = inTok
    lastCache = cacheTok
    context = stepTotal
    recent.push({ input: inTok, cache: cacheTok })
    if (recent.length > RECENT_KEEP) recent.shift()
  }
  if (!steps) return null
  const stat = fs.statSync(file)
  return {
    session: sessionDirOf(file),
    workspace: path.basename(path.dirname(path.dirname(file))),
    file,
    mtime: stat.mtimeMs,
    steps,
    input,
    cache,
    output,
    total: input + cache + output,
    perStep: Math.round((input + cache) / steps),
    maxStep,
    /** 最近一步的上下文规模（输入 + 缓存读）——真正的「现在有多重」。 */
    context,
    lastInput,
    lastCacheRate: context ? lastCache / context : 0,
    recent,
    cacheRate: input + cache ? cache / (input + cache) : 0,
  }
}

/** 收集最近 days 天的所有会话，按 mtime 倒序。 */
export function collectSessions({ days = 1 } = {}) {
  const since = Date.now() - Math.max(1, Number(days) || 1) * 86400000
  return walk(sessionsRoot())
    .map((f) => {
      try {
        return { f, mtime: fs.statSync(f).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((x) => x && x.mtime >= since)
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => summarizeFile(x.f))
    .filter(Boolean)
}

/** 取一段消息内容的字符长度（不返回正文）。 */
function lenOf(value) {
  if (value == null) return 0
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce((a, x) => a + lenOf(x), 0)
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.length
    return JSON.stringify(value).length
  }
  return 0
}

function lengthOfFrame(frame) {
  if (frame.type === 'system/message') return lenOf(frame.data?.message)
  if (frame.type === 'user/message') return lenOf(frame.data?.content)
  if (frame.type === 'assistant/message') return lenOf(frame.data?.message)
  if (frame.type === 'tool/result') return lenOf(frame.data?.message)
  if (frame.type === 'tool/call') return lenOf(frame.data?.arguments)
  return 0
}

function kindOfFrame(frame) {
  if (frame.type === 'user/message') return 'user/' + String(frame.data?.source?.kind || '?')
  if (frame.type === 'system/message') return 'system'
  if (frame.type === 'assistant/message') return 'assistant'
  if (frame.type === 'tool/call') return 'tool-call'
  if (frame.type === 'tool/result') return 'tool-result'
  return frame.type || '?'
}

/**
 * 请求块结构：把会话事件流按顺序累加字符，还原「每轮请求大致由哪些块拼成」。
 *
 * 只算长度与类型，不返回任何正文。用途是回答「缓存前缀断在哪一块」：
 * 轮首缓存命中数（token）≈ 当时的累计字符数（本机实测 1:1），所以冻结值能反查到具体块。
 */
export function shapeOfSession(file) {
  let text
  try {
    text = readSession(file)
  } catch {
    return null
  }
  const frames = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      frames.push(JSON.parse(line))
    } catch {
      // 坏行跳过
    }
  }
  frames.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))

  const blocks = []
  const firstByTurn = new Map()
  let cum = 0
  for (const f of frames) {
    const len = lengthOfFrame(f)
    if (len > 0) {
      blocks.push({
        i: blocks.length,
        kind: kindOfFrame(f),
        len,
        start: cum,
        end: cum + len,
        turn: f.data?.turn ?? null,
      })
      cum += len
    }
    if (f.type === 'assistant/message' && f.data?.usage) {
      const turn = f.data?.turn
      if (turn != null && !firstByTurn.has(turn)) {
        const u = f.data.usage
        const input = u.inputTokens || 0
        const cache = u.cacheReadTokens || 0
        firstByTurn.set(turn, { turn, input, cache, ctx: input + cache })
      }
    }
  }

  const turns = [...firstByTurn.values()].sort((a, b) => a.turn - b.turn)
  const tail = turns.slice(-8)
  const cs = tail.map((t) => t.cache)
  const hi = cs.length ? Math.max(...cs) : 0
  const lo = cs.length ? Math.min(...cs) : 0
  const frozen = tail.length >= 3 && hi > 0 && (hi - lo) / hi < 0.02 && tail[tail.length - 1].ctx > 1.3 * Math.max(1, lo)

  let breakAt = null
  let freezeValue = 0
  if (frozen) {
    freezeValue = Math.round((lo + hi) / 2)
    const hit = blocks.find((b) => b.start < freezeValue && b.end >= freezeValue)
    if (hit) breakAt = { ...hit }
  }

  return { blocks, turns, frozen, freezeValue, breakAt, totalChars: cum }
}

