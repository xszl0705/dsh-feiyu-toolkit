/**
 * 本体记忆摘录：把 DSH 客户端（本体）当天的可用记忆摘出来，
 * 喂给桌宠例行日记，避免日记只由桌宠自己的气泡自言自语拼成。
 *
 * 数据源：$DSH_HOME/memory/workspaces/<工作区>/<date>.md（每日日志，append-only）
 * 工作区选择：与 mind-loop/lib/memory-digest.mjs 保持同一规则——
 *   先找名字含「工作区 / work」的目录（本机就是 `--E--工作区--`），
 *   找不到才退到 mtime 最新的那个。**只取一个工作区**，不跨工作区拼接，
 *   否则多个工作区当天都有日志时，日记会把别的项目的活混进来。
 * 失败一律返回空串——日记照常写，只是没有本体上下文（软降级）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 选「本体当前工作区」目录；与 mind-loop 的 workspaceDir() 同规则。 */
export function pickWorkspace(root = path.join(dshHome(), 'memory', 'workspaces')) {
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return ''
  }
  const guess = names.find((name) => /工作区|work/i.test(name))
  if (guess) return path.join(root, guess)
  let best = ''
  let bestTime = 0
  for (const name of names) {
    try {
      const time = fs.statSync(path.join(root, name)).mtimeMs
      if (time > bestTime) {
        bestTime = time
        best = name
      }
    } catch {
      // 跳过读不到的目录
    }
  }
  return best ? path.join(root, best) : ''
}

/** 从一段日志正文里裁出「条目行」：`- HH:MM [kind:xxx] 正文`。 */
export function entryLines(markdown, { limit = 0 } = {}) {
  const rows = String(markdown || '')
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s*\d{1,2}:\d{2}\s/.test(line))
  return limit > 0 ? rows.slice(-limit) : rows
}

/**
 * 读本体当天记忆（单个工作区）。
 * @param {string} date YYYY-MM-DD
 * @param {{ maxChars?: number, workspace?: string }} [opts]
 * @returns {{ text: string, file: string, entries: number, workspace: string }}
 */
export function readBodyMemory(date, { maxChars = 1800, workspace = '' } = {}) {
  const out = { text: '', file: '', entries: 0, workspace: '' }
  try {
    const dir = workspace || pickWorkspace()
    if (!dir) return out
    out.workspace = path.basename(dir)
    const file = path.join(dir, `${date}.md`)
    let raw = ''
    try {
      if (fs.statSync(file).size === 0) return out
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      return out
    }
    const lines = entryLines(raw)
    out.entries = lines.length
    let text = lines.length ? lines.join('\n') : raw
    if (text.length > maxChars) {
      // 尾部更新，保留最近内容；从换行处切开，避免半行
      text = text.slice(-maxChars)
      const cut = text.indexOf('\n')
      if (cut > 0) text = text.slice(cut + 1)
    }
    if (text.trim()) {
      out.text = text.trim()
      out.file = file
    }
  } catch {
    // 目录不存在 / 无权限：静默降级
  }
  return out
}

/** 当天最近一条本体记录（一行，给桌宠气泡当背景用）。 */
export function readRecentWork(date, { maxChars = 60, workspace = '' } = {}) {
  const { text } = readBodyMemory(date, { maxChars: 4000, workspace })
  const lines = entryLines(text)
  const last = lines.length ? lines[lines.length - 1] : text.split(/\r?\n/).filter(Boolean).pop() || ''
  const body = last
    .replace(/^\s*-\s*\d{1,2}:\d{2}\s*/, '')
    .replace(/^\[kind:\w+\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!body) return ''
  return body.length > maxChars ? body.slice(0, maxChars) + '…' : body
}
