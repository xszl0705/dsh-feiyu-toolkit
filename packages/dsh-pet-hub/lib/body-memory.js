/**
 * 本体记忆摘录（桌宠气泡用）：取当前工作区当天工作日志的最后一条，
 * 让 `/line` 生成的台词能接上「你最近在忙什么」。
 *
 * ⚠ 这是 `dsh-pet-diary/lib/body-memory.js` 的**同规则副本**，不是共享包：
 *   两个插件要独立发行到 dsh-feiyu-toolkit，跨包相对 import 在发布后必断。
 *   沿用项目里 pet.js 的既有做法——各存一份，用 `dsh-plugins/tests/contracts.mjs`
 *   钉住三处（含 mind-loop/lib/memory-digest.mjs）行为一致。改一个必须同步另一个。
 *
 * 工作区选择：先找名字含「工作区 / work」的目录，找不到才退到 mtime 最新的；
 * 只读一个，不跨区拼接。读不到一律返回空，调用方降级。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 选「本体当前工作区」目录；规则见文件头。 */
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

/** `- HH:MM [kind:xxx] 正文` 这类条目行。 */
export function entryLines(markdown) {
  return String(markdown || '')
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s*\d{1,2}:\d{2}\s/.test(line))
}

/**
 * 读本体当天记忆。
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

/** 当天最近一条本体记录（一行，给气泡当背景）。 */
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
