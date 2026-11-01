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
    input += u.inputTokens || 0
    cache += u.cacheReadTokens || 0
    output += u.outputTokens || 0
    const stepTotal = (u.inputTokens || 0) + (u.cacheReadTokens || 0)
    if (stepTotal > maxStep) maxStep = stepTotal
  }
  if (!steps) return null
  const stat = fs.statSync(file)
  return {
    session: path.basename(path.dirname(file)),
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
